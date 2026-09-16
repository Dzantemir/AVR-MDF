'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// monitor.js — the Serial Monitor webview view (no native modules):
//   Windows: a PowerShell pump (Add-Type C# SerialPort bridge — one process,
//            reader thread for stdin, main thread for the port)
//   POSIX:   stty setup + node fs streams on the device node
// Toolbar (esp8266-idf layout): `● state · port · baud` left; timestamps &
// autoscroll checkboxes + ▶ Start/■ Stop pinned right. The status-bar Monitor
// item mirrors the session state; sends land with the selected line ending.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const cp     = require('child_process');
const H      = require('./helpers');

let _view = null;
let _proc = null;          // the PowerShell pump (win)
let _rs = null, _ws = null; // POSIX streams
let _connected = false;
let _connPort = '', _connBaud = 115200;
// v0.3.20 (the sdcc-mdf design): the toolbar's port/baud SELECTS drive the
// session — the webview reports its dropdown selection (uiport), the status
// line carries rx/tx byte counters
let _lastPortSel = '';      // the toolbar's port selection (status-bar Start connects to it first)
let _rxB = 0, _txB = 0;     // byte counters for the status line
let _statsAt = 0;           // stats-post throttle
let _statsTrail = null;     // v0.3.21: trailing flush timer — the last <250ms of a burst was never posted
let _connecting = false;    // v0.3.21: connect mutex — a double-click during the READY window must not spawn a second pump
const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

// v0.3.16: every outgoing postMessage rides this — a disposed webview
// rejects postMessage and each serial line became an unhandled rejection.
function _post(msg) {
    try {
        if (_view && _view.webview) Promise.resolve(_view.webview.postMessage(msg)).catch(() => {});
    } catch {}
}

// ─── Registration ────────────────────────────────────────────────────────────
function register(ctx) {
    const provider = {
        resolveWebviewView(webviewView) {
            _view = webviewView;
            webviewView.webview.options = { enableScripts: true };
            webviewView.webview.onDidReceiveMessage(onMessage);
            // v0.3.21: the status-bar items (Build/Flash/Clean/Monitor) used to
            // latch visible only from the TREE view — opening the Serial Monitor
            // first left them hidden for the whole session
            try { require('./statusBar').markUiVisible(); } catch {}
            // the VIEW going away does NOT kill the session (the view is dockable);
            // the status-bar toggle / stop command / deactivate own the lifecycle.
            // v0.3.16: the slot IS cleared though — posting into a disposed
            // webview rejected once per serial line.
            webviewView.onDidDispose(() => { if (_view === webviewView) _view = null; });
            render();
        },
    };
    ctx.subscriptions.push(
        vscode.window.registerWebviewViewProvider('avr.monitorView', provider, {
            webviewOptions: { enableScripts: true },
        })
    );
}

function reveal() {
    try { vscode.commands.executeCommand('avr.monitorView.focus'); } catch {}
}
function isConnected() { return _connected; }

// ─── Webview messages ────────────────────────────────────────────────────────
function onMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
        case 'ready': postState(); sendPorts(); break;
        case 'uiport':
            if (typeof msg.port === 'string' && msg.port && msg.port !== _lastPortSel) {
                _lastPortSel = msg.port;
                H.log(`[monitor] toolbar port selection: ${msg.port}`);
            }
            break;
        case 'start':
            // v0.3.20: the toolbar's selects are the source of truth — the
            // webview sends port+baud explicitly; the settings are fallbacks
            connect(msg.port || _lastPortSel || String(H.cfg('comPort') || ''),
                    Number(msg.baud) || Number(H.cfg('monitorBaud')) || 115200);
            break;
        case 'stop': disconnect('user stop'); break;
        case 'send': sendLine(String(msg.text || ''), msg.eol); break;
        case 'refreshPorts': sendPorts(); break;
        case 'cfg':
            if (typeof msg.timestamps === 'boolean') _setCfgBool('monitorTimestamps', msg.timestamps);
            if (typeof msg.autoscroll === 'boolean') _setCfgBoolState('monitorAutoscroll', msg.autoscroll);
            // v0.3.16: the EOL choice PERSISTS (same as timestamps) — the old
            // code only echoed a cfg-ack nobody consumed, and every state push
            // reset the dropdown back to the config default
            if (typeof msg.eol === 'string') _setCfgEol('monitorEol', msg.eol);
            // v0.3.20: the toolbar's baud dropdown persists the same way
            if (typeof msg.baud === 'number' && msg.baud > 0) _setCfgNum('monitorBaud', msg.baud);
            break;
    }
}
async function _setCfgBool(key, val) {
    try { await vscode.workspace.getConfiguration('avr').update(key, val, vscode.ConfigurationTarget.Global); } catch {}
}
async function _setCfgEol(key, val) {
    try { await vscode.workspace.getConfiguration('avr').update(key, val, vscode.ConfigurationTarget.Global); } catch {}
}
async function _setCfgNum(key, val) {
    try { await vscode.workspace.getConfiguration('avr').update(key, val, vscode.ConfigurationTarget.Global); } catch {}
}
function _setCfgBoolState(key, val) {
    // autoscroll is view-local state (persisted in globalState)
    try { H.getCtx().globalState.update('avr.' + key, val); } catch {}
}
function getAutoscroll() {
    try { return H.getCtx().globalState.get('avr.monitorAutoscroll') !== false; } catch { return true; }
}

// ─── Connect / disconnect ────────────────────────────────────────────────────
async function connectDefault() {
    // v0.3.20: the toolbar's selection first (what the user SEES), the
    // setting second — the sdcc-mdf v0.28.12 lesson
    const port = _lastPortSel || String(H.cfg('comPort') || '');
    const baud = Number(H.cfg('monitorBaud')) || 115200;
    if (!port) {
        reveal();
        vscode.commands.executeCommand('avr.selectPort');
        return;
    }
    await connect(port, baud);
}

async function connect(port, baud) {
    // v0.3.21: connect re-entrancy guard — the PowerShell READY handshake takes
    // 1-3 s, and a double-click (or the status-bar item) used to spawn a SECOND
    // pump on the same port: the loser OPENFAILed with a misleading toast, and
    // the overwritten _proc handle orphaned the winner (unkillable, sends dead)
    if (_connecting) return;
    if (_connected) { disconnect('reconnect'); await _wait(300); }
    if (!port) { reveal(); vscode.commands.executeCommand('avr.selectPort'); return; }
    _connecting = true;
    try {
        H.log(`[monitor] connecting ${port} @ ${baud}`);
        // v0.3.21: fresh counters BEFORE the open — bytes arriving during the
        // handshake (the READY tail) are part of THIS session; resetting after
        // the resolve wiped them (the tail was counted, then zeroed)
        _rxB = 0; _txB = 0;
        _carry = '';        // a truncated last line must not prefix the new session
        try {
            if (H.IS_WIN) await _connectWin(port, baud);
            else await _connectPosix(port, baud);
        } catch (e) {
            vscode.window.showErrorMessage(`AVR: could not open ${port} — ${e.message}`);
            H.log(`[monitor] connect failed: ${e.message}`);
            return;
        }
        _connected = true;
        _connPort = port; _connBaud = baud;
        postState();
        _refreshMonitorButton();
        H.log(`[monitor] connected ${port} @ ${baud}`);
    } finally {
        _connecting = false;
    }
}

// Windows pump: powershell -File <script> port baud, with a tiny embedded .NET
// SerialPort bridge. "READY" on stdout = the port is open.
const PS_PUMP = String.raw`
param([string]$p, [int]$b)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.IO.Ports;
using System.Threading;
public class AvrPump {
    public static int Run(string port, int baud) {
        var sp = new SerialPort(port, baud, Parity.None, 8, StopBits.One);
        sp.ReadTimeout = 50;
        sp.DtrEnable = true;
        sp.RtsEnable = true;
        try { sp.Open(); }
        catch (Exception ex) { Console.Error.WriteLine("OPENFAIL: " + ex.Message); return 2; }
        Console.Out.Write("READY\n");
        Console.Out.Flush();
        var stdinThread = new Thread(() => {
            try {
                int ch;
                while ((ch = Console.In.Read()) >= 0) {
                    lock (sp) {
                        try { sp.Write(new[] { (char)ch }, 0, 1); } catch {}
                    }
                }
            } catch {}
        });
        stdinThread.IsBackground = true;
        stdinThread.Start();
        var buf = new char[4096];
        try {
            while (sp.IsOpen) {
                int n;
                try { n = sp.Read(buf, 0, buf.Length); }
                catch (TimeoutException) { continue; }
                catch (Exception) { break; }
                if (n > 0) { Console.Out.Write(buf, 0, n); Console.Out.Flush(); }
            }
        } catch {}
        try { sp.Close(); } catch {}
        return 0;
    }
}
"@
exit [AvrPump]::Run($p, $b)
`;

function _connectWin(port, baud) {
    return new Promise((resolve, reject) => {
        const script = path.join(H.markerDir(), 'avr-monitor-pump.ps1');
        try {
            fs.writeFileSync(script, PS_PUMP, 'utf8');
        } catch (e) { reject(new Error('pump script: ' + e.message)); return; }
        const exe = 'powershell.exe';   // always present on Windows; pwsh fallback not needed for Add-Type
        const proc = cp.spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, port, String(baud)], {
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        _proc = proc;   // v0.3.21: keep the LOCAL handle too — every callback below identity-checks it
        let ready = false;
        let pre = '';   // v0.3.21: 'READY' may split across stdout chunks — buffer until the marker completes
        const failTimer = setTimeout(() => {
            if (!ready) {
                try { proc.kill(); } catch {}
                if (_proc === proc) _proc = null;
                reject(new Error('timeout waiting for the port'));
            }
        }, 6000);
        let errText = '';
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (chunk) => {
            if (!ready) {
                pre += String(chunk);
                const i = pre.indexOf('READY');
                if (i < 0) return;            // marker not complete yet — buffer on
                ready = true;
                clearTimeout(failTimer);
                resolve();
                const rest = pre.slice(i + 5).replace(/^[\r\n]+/, '');
                pre = '';
                if (rest) pushChunk(rest);   // counts rx + splits lines (was pushLine — uncounted, unsplit)
                return;
            }
            pushChunk(chunk);
        });
        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', (c) => { errText += String(c); });
        // v0.3.21: an unspawnable exe raised an uncaught 'error' event (an
        // extension-host crash) instead of rejecting the connect promise
        proc.on('error', (e) => {
            if (ready) return;
            clearTimeout(failTimer);
            if (_proc === proc) _proc = null;
            reject(new Error('could not start PowerShell — ' + e.message));
        });
        proc.on('exit', (code) => {
            // v0.3.21 identity guard: a STALE pump exiting (replaced by a newer
            // session, or disconnect() already nulled the slot) must not clobber
            // the live session's state
            if (_proc !== proc) return;
            if (!ready) {
                clearTimeout(failTimer);
                _proc = null;
                reject(new Error(errText.replace(/^OPENFAIL:\s*/, '').trim() || `pump exited (${code})`));
            } else {
                _proc = null;
                _connected = false;
                _carry = '';   // a truncated last line must not prefix the next session
                postState();
                _refreshMonitorButton();
                H.log(`[monitor] pump exited (${code})`);
            }
        });
    });
}

function _connectPosix(port, baud) {
    return new Promise((resolve, reject) => {
        // v0.3.21: settle exactly once — an 'error' BEFORE 'open' used to
        // leave the promise pending forever (connect hung, no toast on POSIX,
        // while Windows got one)
        let settled = false;
        const done = (err) => { if (settled) return; settled = true; if (err) reject(err); else resolve(); };
        try {
            // 1) configure the line
            const sttyFlag = H.IS_MAC ? '-f' : '-F';
            const r = cp.spawnSync('stty', [sttyFlag, port, String(baud), 'raw', '-echo', '-ixon', '-hupcl', 'clocal', '-echoe', '-echok'], { timeout: 3000 });
            if (r.status !== 0) {
                done(new Error(`stty failed: ${String(r.stderr || '').trim() || 'exit ' + r.status}`));
                return;
            }
            // 2) streams
            _rs = fs.createReadStream(port, { encoding: 'utf8', autoClose: false });
            _rs.on('data', (chunk) => pushChunk(chunk));
            _rs.on('error', (e) => {
                H.log(`[monitor] read error: ${e.message}`);
                if (!settled) { done(e); return; }   // failed before open — settle the connect
                disconnect('read error');
            });
            _ws = fs.createWriteStream(port, { flags: 'r+', autoClose: false });
            _ws.on('error', (e) => { H.log(`[monitor] write error: ${e.message}`); });
            _rs.on('open', () => done());
            _rs.on('close', () => { if (_connected) { _connected = false; _carry = ''; postState(); _refreshMonitorButton(); } });
        } catch (e) { done(e); }
    });
}

function disconnect(reason) {
    if (!_connected && !_proc && !_rs) return;
    H.log(`[monitor] disconnect (${reason || 'unknown'})`);
    if (_statsTrail) { clearTimeout(_statsTrail); _statsTrail = null; }
    try {
        if (_proc) {
            _proc.stdin?.end();
            // give the pump a graceful moment, then hard kill
            const p = _proc;
            setTimeout(() => { try { p.kill(); } catch {} }, 250);
            _proc = null;
        }
    } catch {}
    try { if (_rs) { _rs.destroy(); _rs = null; } } catch {}
    try { if (_ws) { _ws.destroy(); _ws = null; } } catch {}
    _connected = false;
    _carry = '';   // v0.3.16: a truncated last line must not prefix the next session
    postState();
    _refreshMonitorButton();
}
function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Data flow ───────────────────────────────────────────────────────────────
let _carry = '';
function pushChunk(chunk) {
    _rxB += String(chunk).length;
    _maybePostStats();
    // split into lines; keep the trailing partial in _carry
    const s = _carry + String(chunk);
    const lines = s.split('\n');
    _carry = lines.pop() || '';
    for (const l of lines) pushLine(l.replace(/\r$/, ''));
    if (_carry.length > 8192) { pushLine(_carry); _carry = ''; }   // flood guard
}
function pushLine(text) {
    _post({ type: 'line', text: String(text), ts: Date.now() });
}

function sendLine(text, eol) {
    if (!_connected) return;
    const term = { lf: '\n', cr: '\r', crlf: '\r\n', none: '' }[eol || H.cfg('monitorEol') || 'lf'] ?? '\n';
    if (!text && !term) return;   // v0.3.21: empty input + 'no ending' writes nothing — no phantom ⇢ echo
    _txB += String(text).length + term.length;
    _maybePostStats();
    try {
        if (H.IS_WIN && _proc) _proc.stdin?.write(text + term);
        else if (_ws) _ws.write(text + term);
        // local echo of what was sent
        pushLine(text + ' ⇢');
    } catch (e) {
        H.log(`[monitor] send failed: ${e.message}`);
    }
}

function postState() {
    _post({
        type: 'state',
        connected: _connected, port: _connPort, baud: _connBaud,
        cfgPort: String(H.cfg('comPort') || ''),
        timestamps: !!H.cfg('monitorTimestamps'),
        autoscroll: getAutoscroll(),
        eol: String(H.cfg('monitorEol') || 'lf'),
        rx: _rxB, tx: _txB,
        baudRates: BAUD_RATES,
    });
    _refreshMonitorButton();
}
// throttle: data bursts would post a stats message per line; 250 ms is
// plenty for a human-readable "N B rx" counter
function _maybePostStats() {
    const now = Date.now();
    if (now - _statsAt >= 250) {
        _statsAt = now;
        if (_statsTrail) { clearTimeout(_statsTrail); _statsTrail = null; }
        _post({ type: 'stats', rx: _rxB, tx: _txB });
        return;
    }
    // v0.3.21 trailing flush: the LAST <250 ms of a burst used to be lost —
    // the counter stalled at a stale value while connected-idle until the
    // next send/receive woke it up
    if (!_statsTrail) {
        _statsTrail = setTimeout(() => {
            _statsTrail = null;
            _statsAt = Date.now();
            _post({ type: 'stats', rx: _rxB, tx: _txB });
        }, 250);
    }
}
// the port list push (init, the view-title refresh button, a port event)
async function sendPorts() {
    let list = [];
    try { list = (await require('./ports').list()).map(p => p.id); } catch {}
    const current = _lastPortSel || String(H.cfg('comPort') || '');
    _post({ type: 'ports', list, current });
}
function _refreshMonitorButton() {
    try { require('./statusBar').refreshMonitorButton(); } catch {}
}

// ─── Commands ────────────────────────────────────────────────────────────────
async function cmdStart() {
    reveal();
    try { require('./statusBar').markUiVisible(); } catch {}   // v0.3.21: the bar follows the monitor too
    if (!_connected) await connectDefault();
}
function cmdStop() { disconnect('command'); }
function cmdOpen() {
    reveal();
    postState();
}
// v0.3.16: the "AVR: Clear Monitor Output" palette / view-title button used
// to only focus the view — it clears the output now.
function clearOutput() {
    _post({ type: 'clear' });
}
// v0.3.20: the view-title refresh button (the sdcc-mdf design) — re-scan the
// serial ports and push the fresh list into the toolbar's select
function cmdRefreshPorts() {
    sendPorts();
}
// v0.3.21: the user picked a DIFFERENT port via the status bar / palette —
// the toolbar's stale _lastPortSel selection used to shadow the new setting
// on the next Start (the config hook in extension.js calls this)
function onComPortChanged() {
    _lastPortSel = String(H.cfg('comPort') || '');
    sendPorts();
}

// ─── The webview ─────────────────────────────────────────────────────────────
function render() {
    if (!_view || !_view.webview) return;
    const baud0 = parseInt(H.cfg('monitorBaud'), 10) || 115200;
    // v0.3.21: a configured baud that is NOT one of the presets (250000 for
    // MegaCore-class setups) used to leave the select with NO matching option
    // — the browser showed the FIRST entry (300) and Start connected at 300.
    // A non-preset value joins the list instead of silently replacing it.
    const rates = BAUD_RATES.includes(baud0) ? BAUD_RATES : [...BAUD_RATES, baud0].sort((a, b) => a - b);
    const eol0  = ['lf', 'cr', 'crlf', 'none'].includes(String(H.cfg('monitorEol'))) ? String(H.cfg('monitorEol')) : 'lf';
    const ts0   = !!H.cfg('monitorTimestamps');
    const tsChecked = ts0 ? ' checked' : '';
    const baudOptions = rates.map(b =>
        `<option value="${b}"${b === baud0 ? ' selected' : ''}>${b}</option>`).join('');
    // webview template-literal rules: literal newlines only; every literal
    // ${...} meant as UI TEXT is written by the inner script itself
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>AVR Serial Monitor</title>
<style>
:root {
    --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground);
    --fg2: var(--vscode-descriptionForeground);
    --input-bg: var(--vscode-input-background); --input-fg: var(--vscode-input-foreground);
    --border: var(--vscode-panel-border, #3e3e42);
    --btn-bg: var(--vscode-button-background); --btn-fg: var(--vscode-button-foreground);
    --btn2-bg: var(--vscode-button-secondaryBackground, #3a3d41);
    --btn2-fg: var(--vscode-button-secondaryForeground, #fff);
    --focus-bd: var(--vscode-focusBorder, #007fd4);
    --err: var(--vscode-errorForeground, #f14c4c);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--fg); height: 100%; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    display: flex; flex-direction: column; overflow: hidden; }
.bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    padding: 8px 10px; border-bottom: 1px solid var(--border); }
select, input[type=text] {
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px;
    font-size: 12px; font-family: inherit; transition: border-color .12s;
}
select:focus, input:focus { outline: none; border-color: var(--focus-bd); }
#port { min-width: 170px; max-width: 260px; }
button { background: var(--btn-bg); color: var(--btn-fg); border: none;
    padding: 5px 14px; border-radius: 4px; cursor: pointer; font-size: 12px;
    font-family: inherit; transition: opacity .12s; }
button:hover { opacity: .9; } button:active { transform: translateY(1px); }
button.sec { background: var(--btn2-bg); color: var(--btn2-fg); }
button.stop { background: var(--err); }
button:disabled { opacity: .45; cursor: default; }
label.chk { display: inline-flex; align-items: center; gap: 4px; font-size: 11px;
    color: var(--fg2); cursor: pointer; user-select: none; }
label.chk input { accent-color: var(--btn-bg); }
.tail { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    justify-content: flex-end; margin-left: auto; }
#out { flex: 1; overflow-y: auto; padding: 8px 12px;
    font-family: var(--vscode-editor-font-family), Consolas, monospace;
    font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-all; }
#out .ts { color: var(--fg2); opacity: .8; margin-right: 6px; }
#status { padding: 3px 12px; font-size: 11px; color: var(--fg2);
    border-top: 1px solid var(--border); min-height: 20px; }
#status.err { color: var(--err); }
.inrow { display: flex; gap: 8px; align-items: center; padding: 8px 10px;
    border-top: 1px solid var(--border); }
#in { flex: 1; min-width: 120px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6e6e6e; flex: 0 0 auto; }
.dot.on { background: #3fb950; }
</style></head><body>

<div class="bar">
    <span class="dot" id="dot" title="connection state"></span>
    <select id="port" title="Serial port"></select>
    <select id="baud" title="Baud rate">${baudOptions}</select>
    <span class="tail">
        <label class="chk" title="Prefix received lines with [HH:MM:SS.mmm]"><input type="checkbox" id="ts"${tsChecked}> timestamps</label>
        <label class="chk" title="Follow the output; uncheck to freeze the pane"><input type="checkbox" id="scroll" checked> autoscroll</label>
        <button id="btnConn" title="Start the monitor">▶ Start</button>
    </span>
</div>
<div id="out" tabindex="0"></div>
<div class="inrow">
    <input type="text" id="in" placeholder="Type a line and press Enter to send" autocomplete="off" spellcheck="false">
    <select id="eol" title="Line ending appended on send">
        <option value="lf"${eol0 === 'lf' ? ' selected' : ''}>LF \\n</option>
        <option value="cr"${eol0 === 'cr' ? ' selected' : ''}>CR \\r</option>
        <option value="crlf"${eol0 === 'crlf' ? ' selected' : ''}>CRLF \\r\\n</option>
        <option value="none"${eol0 === 'none' ? ' selected' : ''}>no ending</option>
    </select>
    <button id="btnSend">Send</button>
</div>
<div id="status">disconnected</div>

<script>
(function () {
    const vscode = acquireVsCodeApi();
    const out = document.getElementById('out');
    const dot = document.getElementById('dot');
    const portSel = document.getElementById('port');
    const baudSel = document.getElementById('baud');
    const btnConn = document.getElementById('btnConn');
    const statusEl = document.getElementById('status');
    const EOLS = { lf: '\\n', cr: '\\r', crlf: '\\r\\n', none: '' };
    let connected = false;
    let connPort = '', connBaud = 0;   // v0.3.21: the stats line keeps the sdcc format 'connected: PORT @ BAUD · …'
    let timestamps = true;
    let autoscroll = true;
    let rx = 0, tx = 0;
    const MAXLINES = 5000;

    function esc(t) {
        return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function stamp(d) {
        const p = (n, l) => String(n).padStart(l || 2, '0');
        return '[' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3) + ']';
    }
    function addLine(text, tstamp) {
        const div = document.createElement('div');
        if (timestamps && tstamp) {
            const t = document.createElement('span');
            t.className = 'ts';
            t.textContent = stamp(new Date(tstamp));
            div.appendChild(t);
        }
        div.appendChild(document.createTextNode(text));
        out.appendChild(div);
        while (out.childNodes.length > MAXLINES) out.removeChild(out.firstChild);
        if (autoscroll) out.scrollTop = out.scrollHeight;
    }
    function setStatus(msg, isErr) {
        statusEl.textContent = msg;
        statusEl.className = isErr ? 'err' : '';
    }
    function setConnected(m) {
        connected = !!m.connected;
        dot.className = connected ? 'dot on' : 'dot';
        // ONE toggle button (the esp8266-idf pattern, the sdcc-mdf labels):
        // ▶ Start while idle, ■ Stop (error colour) while the session runs
        btnConn.textContent = connected ? '■ Stop' : '▶ Start';
        btnConn.className = connected ? 'stop' : '';
        btnConn.title = connected ? 'Stop the monitor' : 'Start the monitor';
        // the selects lock while a session runs; the dropdown must SHOW the
        // live connection (the sdcc-mdf v0.28.10 lesson)
        portSel.disabled = connected;
        baudSel.disabled = connected;
        if (connected) {
            connPort = String(m.port || '');
            connBaud = m.baud || 0;
            if (connPort) {
                let has = false;
                for (let i = 0; i < portSel.options.length; i++) {
                    if (portSel.options[i].value === connPort) { has = true; break; }
                }
                if (!has) {
                    // the live port vanished from the scan — keep showing it
                    // instead of silently switching the locked display
                    const o = document.createElement('option');
                    o.value = connPort; o.textContent = connPort;
                    portSel.appendChild(o);
                }
                portSel.value = connPort;
            }
            if (m.baud) { ensureBaudOption(m.baud); baudSel.value = String(m.baud); }
        }
        rx = m.rx || 0; tx = m.tx || 0;
        setStatus(connected
            ? ('connected: ' + connPort + (connBaud ? ' @ ' + connBaud : '') + ' · ' + rx + ' B rx · ' + tx + ' B tx')
            : 'disconnected');
        if (connected) document.getElementById('in').focus();
    }
    function ensureBaudOption(v) {
        const s = String(v);
        for (let i = 0; i < baudSel.options.length; i++) {
            if (baudSel.options[i].value === s) return;
        }
        const o = document.createElement('option');
        o.value = s; o.textContent = s;
        baudSel.appendChild(o);
    }
    btnConn.addEventListener('click', () => {
        if (connected) vscode.postMessage({ type: 'stop' });
        else vscode.postMessage({
            type: 'start',
            port: portSel.value,
            baud: parseInt(baudSel.value, 10),
        });
    });
    portSel.addEventListener('change', () => {
        if (portSel.value) vscode.postMessage({ type: 'uiport', port: portSel.value });
    });
    baudSel.addEventListener('change', () => {
        vscode.postMessage({ type: 'cfg', baud: parseInt(baudSel.value, 10) });
    });
    document.getElementById('ts').addEventListener('change', e => {
        timestamps = e.target.checked;
        vscode.postMessage({ type: 'cfg', timestamps: timestamps });
    });
    document.getElementById('scroll').addEventListener('change', e => {
        autoscroll = e.target.checked;
        vscode.postMessage({ type: 'cfg', autoscroll: autoscroll });
    });
    function send() {
        const inp = document.getElementById('in');
        const text = inp.value;
        if (!text && !connected) return;
        const eol = document.getElementById('eol').value;
        vscode.postMessage({ type: 'send', text: text, eol: eol });
        vscode.postMessage({ type: 'cfg', eol: eol });
        inp.value = '';
    }
    document.getElementById('btnSend').addEventListener('click', send);
    document.getElementById('in').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
    // Ctrl+L clears the output from the keyboard (the view-title broom does
    // the same via avr.monitor.clear)
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
            e.preventDefault();
            while (out.firstChild) out.removeChild(out.firstChild);
        }
    });
    function rebuildPorts(list, current) {
        // v0.3.21: while CONNECTED the select is locked — a re-scan (view-title
        // ↻) may refresh the options, but the live session's port stays on
        // screen even when the scan no longer lists it, and no uiport is posted
        if (connected) {
            const keep = portSel.value;
            const opts = (list || []).map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>');
            if (keep && !(list || []).includes(keep)) opts.push('<option value="' + esc(keep) + '">' + esc(keep) + ' (live)</option>');
            portSel.innerHTML = opts.join('');
            portSel.value = keep;
            return;
        }
        const cur = portSel.value || current || '';
        const opts = (list || []).map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>');
        if (!(list || []).length) {
            // v0.3.21: an empty scan still offers the CONFIGURED port — Start
            // stays honest about what it will connect to (the sdcc-mdf lesson)
            if (cur) opts.push('<option value="' + esc(cur) + '">' + esc(cur) + ' (configured)</option>');
            else opts.push('<option value="">(no ports — AVR: Select Port)</option>');
        }
        portSel.innerHTML = opts.join('');
        if (cur && (list || []).includes(cur)) portSel.value = cur;
        else if ((list || []).length) portSel.value = list[0];
        else if (cur) portSel.value = cur;
        if (portSel.value) vscode.postMessage({ type: 'uiport', port: portSel.value });
    }
    window.addEventListener('message', e => {
        const m = e.data;
        if (!m || !m.type) return;
        if (m.type === 'state') {
            if (typeof m.timestamps === 'boolean') {
                timestamps = m.timestamps;
                document.getElementById('ts').checked = timestamps;
            }
            if (typeof m.autoscroll === 'boolean') {
                autoscroll = m.autoscroll;
                document.getElementById('scroll').checked = autoscroll;
            }
            if (m.eol) document.getElementById('eol').value = m.eol;
            setConnected(m);
        } else if (m.type === 'stats') {
            rx = m.rx || 0; tx = m.tx || 0;
            // v0.3.21: keep the sdcc-mdf format — the '@ baud' part used to
            // vanish on every stats update
            if (connected) setStatus('connected: ' + connPort + (connBaud ? ' @ ' + connBaud : '') + ' · ' + rx + ' B rx · ' + tx + ' B tx');
        } else if (m.type === 'line') {
            addLine(m.text, m.ts);
        } else if (m.type === 'ports') {
            rebuildPorts(m.list, m.current);
        } else if (m.type === 'clear') {
            while (out.firstChild) out.removeChild(out.firstChild);
        }
    });
    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    try { _view.webview.html = html; } catch {}
}

module.exports = {
    register, reveal, isConnected, connectDefault, disconnect,
    cmdStart, cmdStop, cmdOpen, clearOutput, postState,
    cmdRefreshPorts, sendPorts, onComPortChanged, BAUD_RATES,      // v0.3.20 — the toolbar selects + the view-title refresh
};
