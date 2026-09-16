'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// statusBar.js — the bar follows the panel (sdcc-mdf v0.27 pattern):
// Build / Flash / Clean / Monitor / port / mode are persistent COMMAND ENTRY
// POINTS and stay hidden until one of the container's views has been opened
// (markUiVisible latches on the first visible===true — never back: a two-way
// gate would flicker the items out on every Explorer glance).
// The busy indicator is NEVER gated — it is transient feedback for a command
// the user explicitly started.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const H      = require('./helpers');

let _uiVisible = false;

function markUiVisible() {
    if (_uiVisible) return;
    _uiVisible = true;
    applyUiVisibility();
}

function applyUiVisibility() {
    for (const n of ['build', 'flash', 'clean', 'monitor']) {
        const bar = H.getStatusBarItem(n);
        if (bar) { if (_uiVisible) bar.show(); else bar.hide(); }
    }
    refreshStatusBar();
}

function createStatusBar(ctx) {
    // Busy indicator — leftmost, hidden while idle
    const busy = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 106);
    busy.command = 'workbench.action.terminal.focus';
    ctx.subscriptions.push(busy);
    H.setStatusBarItem('busy', busy);

    const build = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 105);
    build.text    = '$(tools) Build';
    build.tooltip = 'AVR: Build project (Ctrl+Alt+B)';
    build.command = 'avr.build';
    ctx.subscriptions.push(build);
    H.setStatusBarItem('build', build);

    const flash = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 104);
    flash.text    = '$(zap) Flash';
    flash.tooltip = 'AVR: Flash firmware (Ctrl+Alt+F)';
    flash.command = 'avr.flash';
    ctx.subscriptions.push(flash);
    H.setStatusBarItem('flash', flash);

    const clean = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 103);
    clean.text    = '$(trash) Clean';
    clean.tooltip = 'AVR: Clean build output (Ctrl+Alt+C)';
    clean.command = 'avr.clean';
    ctx.subscriptions.push(clean);
    H.setStatusBarItem('clean', clean);

    // Monitor ⇄ Stop Monitor toggle
    const monitor = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
    ctx.subscriptions.push(monitor);
    H.setStatusBarItem('monitor', monitor);
    refreshMonitorButton();

    // Port
    const port = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    port.command = 'avr.selectPort';
    ctx.subscriptions.push(port);
    H.setStatusBarItem('port', port);

    // Build mode toggle
    const mode = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    mode.command = 'avr.toggleBuildMode';
    ctx.subscriptions.push(mode);
    H.setStatusBarItem('mode', mode);

    // Toolchain chip (GNU avr-gcc ⇄ Microchip XC8) — click to switch
    const tchain = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    tchain.command = 'avr.switchToolchain';
    ctx.subscriptions.push(tchain);
    H.setStatusBarItem('toolchain', tchain);

    applyUiVisibility();
}

async function cmdToggleBuildMode() {
    if (H.checkBusy()) return;
    const cur = String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug' ? 'debug' : 'release';
    const next = cur === 'debug' ? 'release' : 'debug';
    await H.setCfg('buildMode', next);
    refreshStatusBar();
    vscode.window.showInformationMessage(
        `AVR: build mode → ${next}${next === 'debug' ? ' (-Og -g + DEBUG — DWARF for simavr/GDB)' : ' (-Os)'}`);
    H.log(`Build mode toggled: ${cur} → ${next}`);
    if (H.getProvider()) H.getProvider().refresh();
}

function refreshStatusBar() {
    if (!_uiVisible) return;
    const portBar = H.getStatusBarItem('port');
    if (portBar) {
        const port = H.cfg('comPort');
        if (port) {
            portBar.text = `$(plug) ${port}`;
            portBar.tooltip = `AVR port: ${port}\nClick to change`;
        } else {
            portBar.text = '$(plug) No port';
            portBar.tooltip = 'AVR: No port selected\nClick to select port';
        }
        portBar.show();
    }
    const tcBar = H.getStatusBarItem('toolchain');
    if (tcBar) {
        const root = H.getActiveRoot();
        if (root) {
            const isXc8 = H.getProjectToolchain(root) === 'xc8';
            let detail = '';
            let compilerFound = false;
            try {
                const tc = require('./toolchain').detect();
                if (isXc8 && tc.xc8) { detail = tc.xc8 + (tc.xc8Version ? ` (v${tc.xc8Version})` : ''); compilerFound = true; }
                else if (!isXc8 && tc.gcc) { detail = tc.gcc + (tc.gccVersion ? ` (v${tc.gccVersion})` : ''); compilerFound = true; }
                else detail = 'compiler not found';
            } catch {}
            // v0.3.2 (111.jpg): the SAME state glyphs as the Developer Tools
            // tree — $(chip) when the project's compiler is resolved,
            // $(warning) when it is not. One state, one icon, everywhere.
            tcBar.text = compilerFound
                ? (isXc8 ? '$(chip) XC8' : '$(chip) GCC')
                : (isXc8 ? '$(warning) XC8' : '$(warning) GCC');
            tcBar.tooltip = `AVR toolchain: ${isXc8 ? 'Microchip XC8 (xc8-cc)' : 'GNU avr-gcc'}\n${detail}\nClick to switch (Ctrl+Alt+T)`;
            tcBar.show();
        } else {
            tcBar.hide();
        }
    }
    const modeBar = H.getStatusBarItem('mode');
    if (modeBar) {
        const isDebug = String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug';
        modeBar.text = isDebug ? '$(bug) Debug' : '$(circuit-board) Release';
        modeBar.tooltip = isDebug
            ? 'AVR build mode: debug\n-Og -g + DEBUG (DWARF info for simavr / avr-gdb)\nClick to switch to release'
            : 'AVR build mode: release\n-Os (size-optimized)\nClick to switch to debug';
        modeBar.show();
    }
}

// Monitor ⇄ Stop Monitor — called at every connect/disconnect edge
function refreshMonitorButton() {
    const bar = H.getStatusBarItem('monitor');
    if (!bar) return;
    const M = require('./monitor');
    const running = !!(M && M.isConnected && M.isConnected());
    if (running) {
        bar.text            = '$(debug-stop) Monitor';
        bar.tooltip         = 'Stop Monitor';
        bar.command         = 'avr.monitor.stop';
        bar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
        bar.text            = '$(terminal) Monitor';
        bar.tooltip         = 'Start Monitor\nOpens the Serial Monitor view and connects to the selected port';
        bar.command         = 'avr.monitor.start';
        bar.backgroundColor = undefined;
    }
    if (_uiVisible) bar.show();
    try { vscode.commands.executeCommand('setContext', 'avr.monitorConnected', running); } catch {}
}

module.exports = { createStatusBar, refreshStatusBar, refreshMonitorButton, cmdToggleBuildMode, markUiVisible };
