'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// helpers.js — shared infrastructure for AVR-MDF (the sdcc-mdf pattern):
// module state, configuration access, the AVR terminal with a PINNED shell,
// exit-code marker files (build/flash/clean run in the terminal, their exit
// code comes back through a marker file the shell writes), the busy gate,
// variable expansion and small fs utilities.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const cp     = require('child_process');

const IS_WIN = os.platform() === 'win32';
const IS_MAC = os.platform() === 'darwin';

// ─── Module state ────────────────────────────────────────────────────────────
let _ctx              = null;
let _provider        = null;
let _devtoolsProvider = null;
let _libcProvider    = null;
let _outputChannel   = null;
let _activeRoot      = null;
let _globalBusy      = false;
let _globalBusyName  = '';
let _lastCmdStart    = 0;
let _busyTimer       = null;
let _terms           = {};
let _termCloseHook   = null;
const _activeWaits   = new Map();   // Terminal → { resolve, marker, timer, termName }
let _statusBar       = {};
let _toolchain       = null;
let _boardCache      = null;

// ─── Getters / Setters ───────────────────────────────────────────────────────
const getCtx              = () => _ctx;
const setCtx              = (v) => { _ctx = v; };
const getProvider         = () => _provider;
const setProvider         = (v) => { _provider = v; };
const getDevtoolsProvider = () => _devtoolsProvider;
const setDevtoolsProvider = (v) => { _devtoolsProvider = v; };
const getLibcProvider     = () => _libcProvider;
const setLibcProvider     = (v) => { _libcProvider = v; };
const getOutputChannel    = () => {
    if (!_outputChannel) _outputChannel = vscode.window.createOutputChannel('AVR-MDF');
    return _outputChannel;
};
const getActiveRoot   = () => _activeRoot;
const setActiveRoot   = (v) => { _activeRoot = v; };
const getGlobalBusyName = () => _globalBusyName;
const getTerms        = () => _terms;
const setTerms        = (v) => { _terms = v; };
const getToolchainCache = () => _toolchain;
const setToolchainCache = (v) => {
    _toolchain = v;
    try { vscode.commands.executeCommand('setContext', 'avr.toolchainFound', !!(v && v.gcc)); } catch {}
};
const getBoardCache   = () => _boardCache;
const setBoardCache   = (v) => { _boardCache = v; };
const getStatusBarItem = (k) => _statusBar[k];
const setStatusBarItem = (k, v) => { _statusBar[k] = v; };

// ─── Busy gate (one build/flash/clean at a time) ─────────────────────────────
function _busyTimeStr() { return ((Date.now() - _lastCmdStart) / 1000).toFixed(0) + 's'; }
function _startBusyTimer() {
    _stopBusyTimer();
    const bar = getStatusBarItem('busy');
    _busyTimer = setInterval(() => {
        const b = getStatusBarItem('busy');
        if (b) b.text = `$(sync~spin) AVR: ${_globalBusyName} (${_busyTimeStr()})`;
    }, 1000);
    if (bar) bar.text = `$(sync~spin) AVR: ${_globalBusyName}`;
}
function _stopBusyTimer() {
    if (_busyTimer) { clearInterval(_busyTimer); _busyTimer = null; }
}
function setBusy(name) {
    _globalBusy = true;
    _globalBusyName = name;
    _lastCmdStart = Date.now();
    try { vscode.commands.executeCommand('setContext', 'avr.busy', true); } catch {}
    const bar = getStatusBarItem('busy');
    if (bar) {
        bar.text = `$(sync~spin) AVR: ${name}`;
        bar.tooltip = `AVR ${name} is running — commands are locked.\nClick to focus the terminal.`;
        bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        bar.show();
    }
    _startBusyTimer();
    log(`▶ ${name} started`);
}
function clearBusy() {
    _globalBusy = false;
    _globalBusyName = '';
    _stopBusyTimer();
    try { vscode.commands.executeCommand('setContext', 'avr.busy', false); } catch {}
    const bar = getStatusBarItem('busy');
    if (bar) { bar.hide(); bar.backgroundColor = undefined; }
}
function checkBusy() {
    if (!_globalBusy) return false;
    vscode.window.showWarningMessage(
        `AVR: ${_globalBusyName} is still running (${_busyTimeStr()}) — wait for it to finish.`,
        'Focus terminal'
    ).then(a => { if (a === 'Focus terminal') vscode.commands.executeCommand('workbench.action.terminal.focus'); });
    return true;
}

// ─── Configuration ───────────────────────────────────────────────────────────
function cfg(key) { return vscode.workspace.getConfiguration('avr').get(key); }
async function setCfg(key, val) {
    // v0.3.2 (111.jpg): the sdcc-mdf pattern — WORKSPACE-level writes.
    // The previous WorkspaceFolder target threw VS Code's
    // "Unable to write to Folder Settings because no resource is provided."
    // the moment saveSettingsToWorkspace was on: a folder-scoped update
    // requires the configuration object to be created WITH a resource
    // (getConfiguration('avr', uri)) — ours never was. The Workspace target
    // needs no resource and lands in .vscode/settings.json exactly like
    // sdcc-mdf's setCfg.
    const config = vscode.workspace.getConfiguration('avr');
    if (cfg('saveSettingsToWorkspace') && vscode.workspace.workspaceFolders?.length) {
        await config.update(key, val, vscode.ConfigurationTarget.Workspace);
    } else {
        await config.update(key, val, vscode.ConfigurationTarget.Global);
    }
}

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toISOString().slice(11, 23);
    getOutputChannel().appendLine(`[${ts}] ${msg}`);
}

// ─── Shell detection / classification ────────────────────────────────────────
const SHELL_POWERSHELL = 'powershell';
const SHELL_CMD        = 'cmd';
const SHELL_POSIX      = 'posix';
const SHELL_FISH       = 'fish';

function _classifyShell(p) {
    const s = String(p || '').toLowerCase();
    const base = path.posix.basename(s.replace(/\\/g, '/'));
    if (base.includes('powershell') || base.includes('pwsh')) return SHELL_POWERSHELL;
    if (base === 'cmd.exe' || base === 'cmd') return SHELL_CMD;
    if (base === 'fish') return SHELL_FISH;
    if (['bash', 'sh', 'zsh', 'ksh', 'dash', 'csh', 'tcsh', 'ash', 'busybox'].some(n => base.startsWith(n))) return SHELL_POSIX;
    if (s.includes('powershell') || s.includes('pwsh')) return SHELL_POWERSHELL;
    if (s.includes('cmd')) return SHELL_CMD;
    return null;
}
function _resolveAutoShell() {
    if (!IS_WIN) return process.env.SHELL || '/bin/sh';
    const termCfg = vscode.workspace.getConfiguration('terminal').get('integrated.defaultProfile.windows');
    if (termCfg) {
        const profiles = vscode.workspace.getConfiguration('terminal').get('integrated.profiles.windows') || {};
        const p = profiles[termCfg];
        if (p && p.path) return p.path;
        if (typeof p === 'string') return p;
        return termCfg;   // a bare name — classified below if possible
    }
    const comspec = process.env.COMSPEC;
    if (comspec) return comspec;
    return 'powershell.exe';
}
function getUserShell() {
    return String(cfg('shellPath') || _resolveAutoShell());
}
function shellKind() {
    const kind = _classifyShell(getUserShell());
    if (kind) return kind;
    return IS_WIN ? SHELL_POWERSHELL : SHELL_POSIX;
}
function _which(bareName) {
    try {
        const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
        const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
        for (const d of dirs) for (const e of exts) {
            const c = path.join(d, bareName + e);
            try { if (fs.statSync(c).isFile()) return c; } catch {}
        }
    } catch {}
    return null;
}
function _pinnableShellPath(shell) {
    const s = String(shell || '').trim();
    if (!s) return null;
    if (s.includes('\\') || s.includes('/')) {
        try { return fs.existsSync(s) ? s : null; } catch { return null; }
    }
    return _which(s);
}

// ─── Terminal management ─────────────────────────────────────────────────────
function _resolveTermCwd() {
    if (_activeRoot && fs.existsSync(_activeRoot)) return vscode.Uri.file(_activeRoot);
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
        for (const f of folders) {
            try { if (fs.existsSync(f.uri.fsPath)) return f.uri; } catch {}
        }
    }
    return vscode.Uri.file(os.homedir());
}
function getTerm(name) {
    if (cfg('reuseTerminal') && _terms[name] && _terms[name].exitStatus === undefined) {
        return _terms[name];
    }
    if (_terms[name]) {
        try { _terms[name].dispose(); } catch {}
        delete _terms[name];
    }
    const opts = { name, cwd: _resolveTermCwd() };
    if (IS_WIN) {
        const shell = _pinnableShellPath(getUserShell());
        if (shell) opts.shellPath = shell;
    } else {
        const shell = _pinnableShellPath(getUserShell() || process.env.SHELL || '/bin/sh');
        if (shell) opts.shellPath = shell;
    }
    const t = vscode.window.createTerminal(opts);
    _terms[name] = t;
    return t;
}

// ─── Killed-terminal watch ───────────────────────────────────────────────────
// v0.3.19 (111.jpg): killing the AVR terminal mid-command used to leave the
// busy indicator spinning for the full 30-minute MAX_WAIT — the shell died
// before ever writing the exit-code marker, so the poller had nothing to
// read and nothing resolved until the timeout. Two detectors now cover every
// kill mode: (a) window.onDidCloseTerminal — the trash can / the tab's X;
// (b) the marker poll itself checks terminal.exitStatus — "Kill Terminal"
// without a close, or a shell that died on its own. Both funnel into
// _finishWait, which takes ONE last look at the marker (the shell may have
// written it a tick before dying — a finished command still reports its real
// exit code) and otherwise resolves -1 "interrupted" — the callers already
// toast + clearBusy() on -1, so the indicator dies with the terminal.
function _readMarker(marker) {
    try { return parseInt(fs.readFileSync(marker, 'utf8').trim(), 10); } catch { return NaN; }
}
function _finishWait(term, reason) {
    const w = _activeWaits.get(term);
    if (!w) return;
    _activeWaits.delete(term);
    clearInterval(w.timer);
    const ec = _readMarker(w.marker);
    try { fs.unlinkSync(w.marker); } catch {}
    if (!isNaN(ec)) { w.resolve(ec); return; }   // finished right before dying
    log(`[term] ${w.termName} ${reason} — no exit code seen, treating as interrupted`);
    w.resolve(-1);
}
function _ensureTermCloseHook() {
    if (_termCloseHook) return;
    try {
        _termCloseHook = vscode.window.onDidCloseTerminal((closed) => {
            // drop the dead handle from the cache — getTerm() must never hand
            // out a killed terminal again (the exitStatus check covers this
            // too; belt and braces, the event fires FIRST)
            for (const k of Object.keys(_terms)) {
                if (_terms[k] === closed) delete _terms[k];
            }
            if (_activeWaits.has(closed)) _finishWait(closed, 'was closed/killed');
        });
        const ctx = getCtx();
        if (ctx && ctx.subscriptions) ctx.subscriptions.push(_termCloseHook);
    } catch { _termCloseHook = null; }
}

// ─── Exit-code markers ───────────────────────────────────────────────────────
// The command runs IN THE TERMINAL (the user sees everything); the shell also
// writes the exit code to a marker file the extension polls for.
function markerDir() {
    const dir = path.join(os.tmpdir(), 'avr-mdf');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
}
function q(p) {   // shell-quote a path for the ACTIVE shell kind
    const s = String(p);
    const kind = shellKind();
    if (kind === SHELL_POWERSHELL) return `'${s.replace(/'/g, "''")}'`;
    // 0.3.4: parens added — an unquoted ( or ) in a path breaks `if (...)`
    // blocks and marker redirections in cmd.exe ("C:\Users\foo (2)\...").
    if (kind === SHELL_CMD) return /[\s"^&|<>()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
function buildMarkerCmd(markerFile) {
    const kind = shellKind();
    if (kind === SHELL_CMD) {
        // cmd.exe: runtime errorlevel check (not parse-time %var% expansion).
        // 0.3.4: a digit GLUED to `>` is parsed by cmd.exe as a HANDLE NUMBER,
        // not as echo text — `echo 0>file` redirects handle 0 (stdin), runs a
        // bare `echo` (prints "ECHO is on." into the terminal, seen in
        // 111.jpg) and leaves the marker EMPTY, so the poller never sees a
        // valid exit code and the busy indicator spins forever. The
        // redirection goes FIRST (`(>file echo 0)`), where the digit is a
        // plain echo argument and the marker gets a real "0"/"1".
        return `if errorlevel 1 (>${q(markerFile)} echo 1) else (>${q(markerFile)} echo 0)`;
    }
    if (kind === SHELL_POWERSHELL) {
        return `Write-Output $LASTEXITCODE | Out-File -Encoding ascii -NoNewline -FilePath ${q(markerFile)}`;
    }
    if (kind === SHELL_FISH) {
        return `begin; set ec $status; echo -n $ec > ${q(markerFile)}; end`;
    }
    return `echo -n $? > ${q(markerFile)}`;
}
// ─── Long-command splitter ───────────────────────────────────────────────────
// v0.3.17: cmd.exe truncates a terminal line at 8191 chars. With absolute
// paths the avr-gcc link line grows by len(root) × N(objects), and a large
// build was silently fed to the compiler cut mid-path — the same latent
// defect sdcc-mdf fixed twice (link line v0.13.17, flash line v0.28.9).
// Every runInTerminal line now goes through _sendTerminalLine: short lines
// are sent as ONE sendText, byte-for-byte as before; an overlong line is
// split at TOKEN boundaries — quote-aware, a cut inside a quoted path would
// corrupt it — and continued with the active shell's line-continuation
// syntax (cmd `^`, PowerShell backtick, POSIX/fish `\`). The exit-code
// marker is part of the same token stream, so it always lands on the LAST
// physical line and still captures the WHOLE logical command's exit code.
const TERM_LINE_LIMIT = 7000;   // headroom under cmd.exe's 8191
// Split a command string into tokens at whitespace OUTSIDE quotes. Quotes
// (and everything inside them, including spaces) stay attached to their
// token, so re-joining tokens with single spaces can never cut a quoted
// path in half. Handles cmd's "…""…", POSIX `'\''` and PowerShell's ''…''
// quoting equally: only the OPEN/CLOSE pairs matter, segments without
// whitespace between them stay glued into one token.
function tokenizeCommandLine(s) {
    const toks = [];
    let cur = '';
    let quote = null;   // '"' or "'" while inside a quoted segment
    for (const ch of String(s)) {
        if (quote) {
            cur += ch;
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            cur += ch;
        } else if (ch === ' ' || ch === '\t') {
            if (cur) { toks.push(cur); cur = ''; }
        } else {
            cur += ch;
        }
    }
    if (cur) toks.push(cur);
    return toks;
}
function _sendTerminalLine(term, full, kind) {
    if (full.length <= TERM_LINE_LIMIT) { term.sendText(full, true); return; }
    const cont = (kind === SHELL_CMD) ? ' ^' : (kind === SHELL_POWERSHELL ? ' `' : ' \\');
    const toks = tokenizeCommandLine(full);
    const lines = [];
    let cur = '';
    for (const tok of toks) {
        if (cur && cur.length + 1 + tok.length > TERM_LINE_LIMIT) { lines.push(cur); cur = tok; }
        else cur = cur ? cur + ' ' + tok : tok;
    }
    if (cur) lines.push(cur);
    for (let i = 0; i < lines.length - 1; i++) term.sendText(lines[i] + cont, true);
    term.sendText(lines[lines.length - 1], true);
    if (lines.length > 1) {
        log(`[term] command exceeds ${TERM_LINE_LIMIT} chars — split into ${lines.length} lines (shell line limit)`);
    } else {
        // pathological: one token longer than the limit (no whitespace at
        // all) — nothing can be split safely, send as-is and say so
        log(`[term] command exceeds ${TERM_LINE_LIMIT} chars but has no safe split point — sending as-is`);
    }
}
// Run a command in the terminal and resolve with its exit code.
// cmds: array of shell command strings; label: busy-indicator name.
// v0.3.14 (the user's console log): NO header echo at all. 0.3.13 turned the
// raw header text into a proper `echo` command — technically correct, but the
// user called the result "echo garbage": every flash / eeprom / erase / clean /
// hook / fuse-write op printed BOTH the command line (`echo ── Chip erase ──`)
// AND its output (`── Chip erase ──`) into the terminal before doing any real
// work. The headers are now gone completely — the terminal shows only the
// actual operation. The operation itself is fully identified by its own
// command line (avrdude … / rmdir … / rm -rf …), and the status/exit code is
// reported by the extension's toasts, not by terminal decoration.
function runInTerminal(termName, cmds, { reveal = true } = {}) {
    return new Promise((resolve) => {
        const marker = path.join(markerDir(), `avr_${Date.now()}_${Math.floor(Math.random() * 1e6)}.tmp`);
        const term = getTerm(termName);
        if (reveal) term.show();
        _ensureTermCloseHook();
        const kind = shellKind();
        const sep = (kind === SHELL_CMD) ? ' & ' : ' ; ';
        const full = `${cmds.join(sep)}${sep}${buildMarkerCmd(marker)}`;
        _sendTerminalLine(term, full, kind);
        const w = { resolve, marker, timer: null, termName };
        _activeWaits.set(term, w);
        // Poll for the marker (up to 30 min — the last-resort backstop; the
        // kill detectors below normally resolve long before it)
        const started = Date.now();
        const MAX_WAIT = 30 * 60 * 1000;
        w.timer = setInterval(() => {
            let ec = _readMarker(marker);
            if (!isNaN(ec)) {
                _activeWaits.delete(term);
                clearInterval(w.timer);
                try { fs.unlinkSync(marker); } catch {}
                resolve(ec);
            } else if (term.exitStatus !== undefined) {
                // the shell process is GONE (killed / crashed) — the marker
                // will never appear; _finishWait re-reads the marker once,
                // then resolves -1 "interrupted"
                _finishWait(term, 'shell exited');
            } else if (Date.now() - started > MAX_WAIT) {
                _activeWaits.delete(term);
                clearInterval(w.timer);
                try { fs.unlinkSync(marker); } catch {}
                resolve(-1);   // interrupted / marker never appeared
            }
        }, 250);
    });
}
// ─── Status bar feedback helpers ─────────────────────────────────────────────
function flashBarFeedback(itemKey, feedbackText, idleText, ms = 3500) {
    const bar = getStatusBarItem(itemKey);
    if (!bar) return;
    const oldText = bar.text;
    bar.text = feedbackText;
    setTimeout(() => { bar.text = idleText || oldText; }, ms);
}

// ─── Diagnostics helpers (Problems panel) ────────────────────────────────────
let _diagCollection = null;
function getDiagCollection() {
    if (!_diagCollection) _diagCollection = vscode.languages.createDiagnosticCollection('avr');
    return _diagCollection;
}
function clearDiagnostics() { getDiagCollection().clear(); }

// gcc diagnostic line → vscode.Diagnostic (file:line:col: severity: message)
function parseGccDiagLine(line, rootDir) {
    // main.c:12:5: error: unknown type name 'Foo'
    // main.c:12:5: warning: unused variable
    // main.c:12: fatal error: foo.h: No such file
    // ./src/main.c:34:2: error: …
    const m = /^(.+?):(\d+):(?:(\d+):\s*)?(fatal error|error|warning)\s*:\s*(.*)$/.exec(line);
    if (!m) return null;
    let file = m[1].replace(/\\ /g, ' ');
    if (/^[A-Za-z]:[\\\/]/.test(file) || file.startsWith('/')) {
        // absolute
    } else {
        file = path.join(rootDir, file);
    }
    const lineNo = parseInt(m[2], 10);
    const colNo = m[3] ? parseInt(m[3], 10) : 1;
    const sev = m[4] === 'error' || m[4] === 'fatal error'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;
    return {
        file, line: lineNo, col: colNo, severity: sev, message: m[5],
    };
}
// ld diagnostic: path/file.o: in function `main': file.c:(.text+0x0): undefined reference to `foo'
function parseLdDiagLines(stdout, stderr, rootDir) {
    const out = [];
    const lines = String(stderr || '') + '\n' + String(stdout || '');
    let currentFile = null, currentLine = null;
    for (const raw of lines.split('\n')) {
        const line = raw.trim();
        let m = /^In function\s+`(.+)':\s*$/.exec(line);
        if (m) continue;
        m = /^(.+?):(\d+):\s*(?:undefined reference|relocation truncated|cannot find|multiple definition|first defined here)/.exec(line) ||
            /^(.+?:(?:\.[^:]+)?):\s*(undefined reference|relocation truncated|multiple definition)/.exec(line);
        if (m) {
            const file = /[/\\]/.test(m[1]) ? m[1] : path.join(rootDir, m[1]);
            currentFile = file; currentLine = m[2] ? parseInt(m[2], 10) : 1;
            out.push({
                file: currentFile.replace(/\((\.[^)]+)\)$/, ''), line: currentLine, col: 1,
                severity: vscode.DiagnosticSeverity.Error, message: line,
            });
            continue;
        }
        m = /^(.+?\.(?:o|a|elf)):\s+in function\s+`(.+)':/.exec(line);
        if (m) { currentFile = m[1]; continue; }
        m = /^(.*?\.(?:c|cpp|cc|cxx|S|s)):\((\.[^)]+)\):\s*(.*)$/.exec(line);
        if (m && currentFile) {
            out.push({
                file: /[/\\]/.test(m[1]) ? m[1] : path.join(rootDir, m[1]),
                line: 1, col: 1, severity: vscode.DiagnosticSeverity.Error, message: m[3] || line,
            });
            continue;
        }
    }
    return out;
}
function reportDiagnostics(items, rootDir) {
    const coll = getDiagCollection();
    const byFile = new Map();
    for (const it of items) {
        const uri = vscode.Uri.file(it.file);
        if (!byFile.has(uri)) byFile.set(uri, []);
        const diag = new vscode.Diagnostic(
            new vscode.Range(Math.max(0, (it.line || 1) - 1), Math.max(0, (it.col || 1) - 1),
                             Math.max(0, (it.line || 1) - 1), Math.max(0, (it.col || 1) - 1) + 200),
            it.message, it.severity);
        diag.source = 'avr-gcc';
        byFile.get(uri).push(diag);
    }
    coll.clear();
    for (const [uri, diags] of byFile) coll.set(uri, diags);
    return byFile.size;
}

// ─── Small fs utilities ──────────────────────────────────────────────────────
function readJsonFile(filePath) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        // tolerate UTF-8 BOM
        const json = raw.replace(/^\uFEFF/, '');
        return { ok: true, data: JSON.parse(json) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}
function isAscii(str) { return /^[\x00-\x7F]*$/.test(str); }
function warnNoProject() {
    vscode.window.showInformationMessage(
        'AVR: no active project. Select or create one first.',
        'Select Project', 'Create Project'
    ).then(a => {
        if (a === 'Select Project') vscode.commands.executeCommand('avr.selectProject');
        if (a === 'Create Project') vscode.commands.executeCommand('avr.createProject');
    });
}

// ─── Variable expansion (${workspaceFolder}, ${board.mcu}, …) ────────────────
// Unresolved variables stay LITERAL (never silently empty).
function expandVars(str, vars) {
    if (typeof str !== 'string') return str;
    return str.replace(/\$\{([^}]+)\}/g, (whole, name) => {
        if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
        return whole;   // unresolved stays literal
    });
}
function configVarResolver() {
    // ${config:avr.comPort} etc. — v0.3.21: a key WITHOUT a dot resolves in
    // the avr.* namespace FIRST (${config:comPort} ≡ avr.comPort — the
    // sdcc-mdf convention the Project Editor's variable menu and every
    // "build/${config:buildMode}" tip document); full dotted ids work as-is
    // (${config:avr.buildMode}, ${config:editor.fontFamily}, …). Without the
    // namespace fallback getConfiguration().get('buildMode') looks up a
    // TOP-LEVEL setting that does not exist — the whole ${…} stayed literal
    // and builds landed in a directory named "${config:buildMode}".
    // Unresolved keys stay literal.
    return (str) => str.replace(/\$\{config:([^}]+)\}/g, (whole, key) => {
        try {
            const conf = vscode.workspace.getConfiguration();
            const tryKeys = key.includes('.') ? [key] : ['avr.' + key, key];
            for (const k of tryKeys) {
                const v = conf.get(k);
                if (v !== undefined && v !== null) return String(v);
            }
        } catch {}
        return whole;
    });
}
function envVarResolver() {
    return (str) => str.replace(/\$\{env:([^}]+)\}/g, (whole, key) => {
        const v = process.env[key];
        return v === undefined ? whole : v;
    });
}

// The ACTIVE project's compiler: 'avr-gcc' (default) or 'xc8'.
// Reads avr-project.json of the given (or active) root; anything unknown
// falls back to avr-gcc so a hand-edited project never breaks the UI.
function getProjectToolchain(root) {
    const r = root || _activeRoot;
    if (!r) return 'avr-gcc';
    try {
        const Validator = require('./validator');
        const { status, proj } = Validator.readProjectConfig(r);
        if (status === 'ok' && proj && proj.toolchain === 'xc8') return 'xc8';
    } catch {}
    return 'avr-gcc';
}

// v0.3.20: expand ${…} in build.output_dir / build.output_name. The base
// variable set is root-only (workspaceFolder, project.name, buildMode,
// toolchain + ${config:…}/${env:…}) so EVERY reader — gcc build, XC8 build,
// flash, clean, the debug provider — can resolve the paths without a board
// in hand; buildVars layers the board/output variables on top for hooks.
// `build/${config:buildMode}` (the sdcc-mdf tip) is the primary use.
function expandOutPaths(root, proj) {
    const base = {
        'workspaceFolder': root || '',
        'project.name': (proj && proj.name) || (root ? path.basename(root) : ''),
        'buildMode': String(cfg('buildMode') || 'release').toLowerCase(),
        'toolchain': getProjectToolchain(root),
    };
    const expand = (s) => envVarResolver()(configVarResolver()(expandVars(String(s || ''), base)));
    const rawDir = (proj && proj.build && typeof proj.build.output_dir === 'string' && proj.build.output_dir.trim())
        ? proj.build.output_dir.trim() : 'build';
    const rawName = (proj && proj.build && typeof proj.build.output_name === 'string' && proj.build.output_name.trim())
        ? proj.build.output_name.trim() : 'firmware';
    // v0.3.21 hardening: a variable that expands to EMPTY (env var set to '')
    // or a bare '.' used to make outDirAbs the project ROOT itself — clean()
    // would then have removed the sources. Fall back to the default dir.
    let outDirRel = expand(rawDir).trim();
    if (!outDirRel || outDirRel === '.') outDirRel = 'build';
    // v0.3.21: a hand-edited output_name with separators smuggles a
    // subdirectory into every join — the validator blocks it on editor save,
    // but debugSession and friends read the raw file without validating.
    let outName = expand(rawName).trim().replace(/[/\\]+/g, '');
    if (!outName) outName = 'firmware';
    // an expanded ${workspaceFolder}/... can be ABSOLUTE — resolve it once
    // here so no caller has to guess how to join it
    const outDirAbs = path.isAbsolute(outDirRel) ? outDirRel : path.join(root || '', outDirRel);
    return { outDirRel, outName, outDirAbs };
}

module.exports = {
    IS_WIN, IS_MAC,
    SHELL_POWERSHELL, SHELL_CMD, SHELL_POSIX, SHELL_FISH,
    getCtx, setCtx,
    getProvider, setProvider,
    getDevtoolsProvider, setDevtoolsProvider,
    getLibcProvider, setLibcProvider,
    getOutputChannel, getActiveRoot, setActiveRoot,
    getGlobalBusyName, getTerms, setTerms,
    getToolchainCache, setToolchainCache,
    getBoardCache, setBoardCache,
    getStatusBarItem, setStatusBarItem,
    setBusy, clearBusy, checkBusy,
    cfg, setCfg, log,
    shellKind, getUserShell, q, buildMarkerCmd, runInTerminal, getTerm,
    flashBarFeedback,
    getDiagCollection, clearDiagnostics, parseGccDiagLine, parseLdDiagLines, reportDiagnostics,
    readJsonFile, isAscii, warnNoProject,
    getProjectToolchain,
    expandVars, configVarResolver, envVarResolver,
    expandOutPaths,
    markerDir,
};
