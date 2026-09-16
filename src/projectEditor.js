'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// projectEditor.js — the visual avr-project.json editor (webview panel).
//
// Redesigned after the sdcc-mdf Project Editor (task 2-d): a centered 920px
// column of two-tone cards with colored left accents, per-field ⓘ popovers
// (pure CSS, hover or keyboard focus), a searchable in-webview MCU dropdown
// (varpicker-style, grouped by AVR series with sticky headers), a segmented
// avr-gcc/XC8 toolchain control and a sticky save bar.
//
// Message protocol (webview ⇄ host):
//   webview → host : {type:'ready'}                       → host replies 'state'
//                    {type:'save', proj}                  → validated, then written
//                    {type:'pickBoard', current?}         → host QuickPick → 'board-picked'
//   host → webview : {type:'state', proj, boards, file,   → (re)initializes everything
//                     recipes, comPort}                     (boards carry vendor)
//                    {type:'board-picked', id}            → sets the MCU field + hint
//
// Save is REFUSED when Validator.validateProjectConfig reports errors — a
// broken avr-project.json is never written. Field initialization is guarded:
// on failure Save is disabled ("initialization failed" hint) so a half-empty
// form can never overwrite the real config.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Boards = require('./boards');
const Validator = require('./validator');
const { RECIPES } = require('./flash');

let _panel = null;
// The project root the CURRENT panel is bound to. Reopening the editor with a
// different active project rebuilds the panel (the sdcc-mdf audit #4.4 lesson:
// reusing a stale panel silently wrote project B's settings into project A's
// avr-project.json).
let _panelRoot = null;

function openProjectEditor() {
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const cfgPath = path.join(root, 'avr-project.json');
    const rc = Validator.readProjectConfig(root);
    if (rc.status === 'missing') { H.warnNoProject(); return; }
    if (rc.status === 'broken') {
        // a broken JSON used to exit silently — tell the user and offer the file
        vscode.window.showErrorMessage(
            `AVR: avr-project.json is not valid JSON: ${rc.parseError || 'parse error'}`, 'Open File'
        ).then(a => {
            if (a === 'Open File') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(cfgPath));
        });
        return;
    }

    if (_panel) {
        if (_panelRoot === root) {
            // v0.3.21: reveal ONLY (the sdcc-mdf behaviour) — the old
            // _sendAll() re-pushed the disk state and silently discarded the
            // user's unsaved edits every time the command was re-invoked
            _panel.reveal(vscode.ViewColumn.One);
            return;
        }
        // active project changed while the editor was open → rebuild for it
        try { _panel.dispose(); } catch {}   // onDidDispose clears both slots
    }
    _panelRoot = root;

    _panel = vscode.window.createWebviewPanel(
        'avr.projectEditor', `AVR — Project Editor (${path.basename(root)})`, vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    _panel.webview.html = _render();
    _panel.webview.onDidReceiveMessage(onMessage);
    _panel.onDidDispose(() => { _panel = null; _panelRoot = null; });
}

function onMessage(m) {
    if (!m || !m.type) return;
    switch (m.type) {
        case 'ready':    _sendAll(); break;
        case 'save':     _save(m.proj); break;
        case 'pickBoard': _pickBoard(m.current); break;
        // v0.3.20: the Build card's Release/Debug segmented control — the
        // SAME avr.buildMode setting the status bar flips; applied
        // immediately (no Save) and confirmed back to the webview
        case 'setBuildMode': _setBuildMode(m.mode); break;
    }
}

async function _setBuildMode(mode) {
    const next = (mode === 'debug') ? 'debug' : 'release';
    try {
        await H.setCfg('buildMode', next);
        H.log(`Build mode set from Project Editor: ${next}`);
    } catch (e) {
        H.log(`[projectEditor] build mode write failed: ${e.message}`);
    }
    // confirm with the LIVE value — a failed write reports what actually is
    const live = String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug' ? 'debug' : 'release';
    try { _panel?.webview.postMessage({ type: 'buildModeSet', mode: live }); } catch { /* disposed mid-send */ }
}

// v0.3.20: the status bar (or the palette) switched avr.buildMode while the
// editor was open — push the new value into the open panel (sdcc-mdf's
// notifyBuildModeChanged pattern; called from extension.js's config hook).
function notifyBuildModeChanged() {
    if (!_panel) return;
    const live = String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug' ? 'debug' : 'release';
    try { _panel.webview.postMessage({ type: 'buildModeSet', mode: live }); } catch { /* disposed mid-send */ }
}

// Full state push: the config (re-read from disk), the whole MCU database
// (with vendor, for the grouped dropdown), the avrdude recipes and the
// current comPort setting (for the port-override hint).
// v0.3.16: reads _panelRoot — the panel is BOUND to its own project; the
// live active root could have switched underneath (Select Project) and the
// old code pushed project B's config into project A's editor.
function _sendAll() {
    if (!_panel) return;
    const root = _panelRoot;
    const rc = Validator.readProjectConfig(root);
    const proj = rc.status === 'ok' ? rc.proj : null;
    const boards = Boards.allBoards().map(b => ({
        id: b.id, name: b.name, vendor: b.vendor || 'Other',
        mcu: b.build.mcu, family: b.build.family || 'classic',
        flash: b.build.memory.flash, ram: b.build.memory.ram, eeprom: b.build.memory.eeprom,
        f_cpu_hz: b.build.f_cpu_hz, protocol: (b.upload && b.upload.protocol) || '',
    }));
    try {
        _panel.webview.postMessage({
            type: 'state', proj, boards,
            file: path.join(root || '', 'avr-project.json'),
            recipes: RECIPES.map(rcp => ({
                id: rcp.id, label: rcp.label, port: rcp.port, baud: rcp.baud, desc: rcp.desc,
            })),
            comPort: String(H.cfg('comPort') || ''),
            buildMode: String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug' ? 'debug' : 'release',
        });
    } catch { /* disposed mid-send */ }
}

// Host-side QuickPick (Boards.selectBoard) — fuzzy over id / MCU / memory /
// protocol. Optional `current` is the webview's field value (may be newer
// than the file on disk).
function _pickBoard(current) {
    const root = _panelRoot;   // v0.3.16: bound root, not the live active root
    let disk = null;
    if (root) {
        const rc = Validator.readProjectConfig(root);
        if (rc.status === 'ok') disk = rc.proj.board;
    }
    const cur = (typeof current === 'string' && current) ? current : disk;
    Boards.selectBoard(cur, { placeHolder: 'Select the target board / MCU — the editor field follows' })
        .then(id => {
            if (!id || !_panel) return;
            try { _panel.webview.postMessage({ type: 'board-picked', id }); } catch {}
        });
}

// Validated save: errors refuse the write, success refreshes the tree, pushes
// the state back and re-syncs IntelliSense / tasks / launch configs.
// v0.3.16: saves into _panelRoot — the panel's OWN project. The old
// getActiveRoot() call meant that switching the active project while the
// editor was open wrote panel A's form into project B's avr-project.json.
// v0.3.21 (the sdcc-mdf merge lesson): the form does NOT have a field for
// every stored key — build.extra_flags, upload.extra_args, the fuse0…8
// values of modern tinyAVR/AVR-Dx parts (this editor only manages
// lfuse/hfuse/efuse), and anything a newer version adds. The old wholesale
// JSON.stringify(form) silently ERASED them on every Save. The disk config
// is re-read and the form OVERLAYS its managed keys — absent optional keys
// are removed, unmanaged keys survive.
function _save(proj) {
    const root = _panelRoot;
    if (!root) return;
    if (!proj || typeof proj !== 'object' || Array.isArray(proj)) {
        vscode.window.showErrorMessage('AVR: invalid project structure.');
        return;
    }
    // v0.3.20: canonicalize hook arrays — trim lines, drop blanks, drop the
    // key when nothing survives (matches the webview's collect())
    const pb = (proj.build && typeof proj.build === 'object' && !Array.isArray(proj.build)) ? proj.build : {};
    if (pb.hooks && typeof pb.hooks === 'object' && !Array.isArray(pb.hooks)) {
        for (const k of Object.keys(pb.hooks)) {
            const v = pb.hooks[k];
            if (Array.isArray(v)) {
                const items = v.map(x => String(x || '').trim()).filter(Boolean);
                if (items.length === 1) pb.hooks[k] = items[0];
                else if (items.length > 1) pb.hooks[k] = items;
                else delete pb.hooks[k];
            }
        }
        if (!Object.keys(pb.hooks).length) delete pb.hooks;
    }
    // ── the fresh-disk merge ──
    const diskRc = Validator.readProjectConfig(root);
    const disk = diskRc.status === 'ok' ? diskRc.proj : {};
    const merged = { ...disk };
    // fully managed top-level keys (the form always sends them)
    for (const k of ['name', 'board', 'toolchain', 'sources', 'includes', 'libraries', 'components', 'defines']) {
        merged[k] = proj[k];
    }
    // build: per-key overlay — absent OPTIONAL keys are removed, unmanaged
    // keys (extra_flags, …) survive from disk
    const db = (disk.build && typeof disk.build === 'object' && !Array.isArray(disk.build)) ? disk.build : {};
    const mb = { ...db };
    for (const k of ['output_dir', 'output_name', 'optimization', 'gc_sections', 'relax', 'lto',
                     'c_flags', 'cxx_flags', 'asm_flags', 'link_flags']) {
        if (pb[k] !== undefined) mb[k] = pb[k]; else delete mb[k];
    }
    // hooks: the five managed stages; an unknown stage written by hand (or a
    // future version) survives untouched
    const ph = (pb.hooks && typeof pb.hooks === 'object' && !Array.isArray(pb.hooks)) ? pb.hooks : {};
    const dh = (db.hooks && typeof db.hooks === 'object' && !Array.isArray(db.hooks)) ? db.hooks : {};
    const mh = { ...dh };
    for (const stage of ['pre_build', 'post_link', 'post_build', 'pre_upload', 'post_upload']) {
        if (ph[stage] !== undefined) mh[stage] = ph[stage]; else delete mh[stage];
    }
    if (Object.keys(mh).length) mb.hooks = mh; else delete mb.hooks;
    merged.build = mb;
    // upload: same overlay (extra_args and friends survive)
    const pu = (proj.upload && typeof proj.upload === 'object' && !Array.isArray(proj.upload)) ? proj.upload : {};
    const du = (disk.upload && typeof disk.upload === 'object' && !Array.isArray(disk.upload)) ? disk.upload : {};
    const mu = { ...du };
    for (const k of ['programmer', 'port', 'baud', 'tool', 'args', 'eeprom']) {
        if (pu[k] !== undefined) mu[k] = pu[k]; else delete mu[k];
    }
    // fuses: the editor manages lfuse/hfuse/efuse ONLY — the fuse0…8 of
    // modern parts (tinyAVR / AVR Dx) come from the Fuse Editor and survive
    const pf = (pu.fuses && typeof pu.fuses === 'object' && !Array.isArray(pu.fuses)) ? pu.fuses : {};
    const df = (du.fuses && typeof du.fuses === 'object' && !Array.isArray(du.fuses)) ? du.fuses : {};
    const mf = { ...df };
    for (const k of ['lfuse', 'hfuse', 'efuse']) {
        if (pf[k] !== undefined) mf[k] = pf[k]; else delete mf[k];
    }
    if (Object.keys(mf).length) mu.fuses = mf; else delete mu.fuses;
    merged.upload = mu;
    const report = Validator.validateProjectConfig(merged, root, { countSources: false });
    if (report.errors.length) {
        vscode.window.showErrorMessage(
            `AVR: refused to save — ${report.errors[0]}${report.errors.length > 1 ? ` (+${report.errors.length - 1} more)` : ''}`);
        return;
    }
    const file = path.join(root, 'avr-project.json');
    try {
        fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
        H.log(`[projectEditor] saved ${file}`);
        if (H.getProvider()) H.getProvider().refresh();
        vscode.window.showInformationMessage('✅ avr-project.json saved.');
        _sendAll();
        // IntelliSense / tasks / launch follow the new board & toolchain
        try { require('./intellisense').syncAfterProjectChange(); } catch {}
        try { require('./tasks').syncAfterProjectChange(); } catch {}
        try { require('./launchJson').syncAfterProjectChange(); } catch {}
    } catch (e) {
        vscode.window.showErrorMessage(`AVR: could not save — ${e.message}`);
    }
}

// ─── the webview ─────────────────────────────────────────────────────────────
// The whole page is one template literal: NO backticks and no unescaped ${…
// may appear inside it (they would terminate / interpolate the host literal).
// Webview-string newline escapes are written \\n, regex backslashes doubled,
// literal ${ tokens escaped as \${ .
function _render() {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>AVR Project Editor</title>
<style>
:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --fg2: var(--vscode-descriptionForeground);
    --fg3: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, var(--vscode-panel-border, #3e3e42));
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn2-bg: var(--vscode-button-secondaryBackground, #3a3d41);
    --btn2-fg: var(--vscode-button-secondaryForeground, #ffffff);
    --border: var(--vscode-widget-border, var(--vscode-panel-border, #3e3e42));
    --border2: var(--vscode-panel-border, #3e3e42);
    --section-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --card-bg: var(--vscode-editorWidget-background, rgba(128,128,128,0.04));
    --code-bg: var(--vscode-textCodeBlock-background, rgba(110,118,129,0.12));
    --accent: var(--vscode-charts-blue, #4daafc);
    --amber: #d9a03c;   /* no --vscode-charts-amber exists — fixed tone */
    --focus-bd: var(--vscode-focusBorder, #007fd4);
    --tip-bg: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, #252526));
    --tip-fg: var(--vscode-editorHoverWidget-foreground, var(--vscode-editorWidget-foreground, #cccccc));
    --tip-bd: var(--vscode-editorHoverWidget-border, var(--border));
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--fg); }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    padding: 18px 20px 80px;          /* bottom room for the sticky save bar */
    max-width: 920px;
    margin: 0 auto;
}

/* ─── Page header ─── */
.page-hd { margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--border2); }
.page-hd h1 {
    font-size: 18px; font-weight: 600; margin: 0 0 4px;
    display: flex; align-items: center; gap: 8px;
}
.page-hd .page-sub { font-size: 12px; color: var(--fg2); line-height: 1.5; }
.page-hd .page-sub code { background: var(--code-bg); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); }
.page-actions { margin-top: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.page-actions .pa-note { font-size: 11px; color: var(--fg3); margin-left: auto; }
.page-actions kbd {
    background: var(--input-bg); border: 1px solid var(--border); border-bottom-width: 2px;
    border-radius: 3px; padding: 0 5px; font-size: 10px; font-family: var(--vscode-editor-font-family);
}

/* ─── Cards (sections) ─── */
.card {
    border: 1px solid var(--border); border-radius: 8px;
    margin-bottom: 14px; background: var(--card-bg);
    overflow: visible;
}
.card-hd {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; border-bottom: 1px solid var(--border2);
    background: var(--section-bg);
    border-radius: 8px 8px 0 0;
}
.card-hd .c-icon {
    width: 22px; height: 22px; border-radius: 5px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 12px; flex: 0 0 auto;
    background: var(--code-bg);
}
.card-hd h3 { font-size: 13px; font-weight: 600; color: var(--fg); flex: 0 1 auto; }
.card-hd .c-sub { font-size: 11px; color: var(--fg2); margin-left: 4px; }
.card-hd .c-tip { margin-left: auto; }
.card-bd { padding: 12px 14px; }

/* ─── Field rows ─── */
.row {
    display: flex; gap: 8px; margin-bottom: 10px;
    align-items: center; flex-wrap: wrap;
}
.row:last-child { margin-bottom: 0; }
label {
    min-width: 120px; font-size: 12px; flex: 0 0 auto;
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--fg);
}
input, textarea, select {
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border);
    padding: 5px 8px; border-radius: 4px;
    font-size: 12px; width: 100%;
    font-family: var(--vscode-editor-font-family);
    transition: border-color .12s, box-shadow .12s;
}
input:focus, textarea:focus, select:focus {
    outline: none; border-color: var(--focus-bd);
    box-shadow: 0 0 0 1px var(--focus-bd);
}
input[readonly] { opacity: .85; cursor: default; }
.row > input, .row > select { flex: 1; min-width: 120px; width: auto; }
textarea { min-height: 56px; resize: vertical; line-height: 1.5; }
textarea.short { min-height: 40px; }

button {
    background: var(--btn-bg); color: var(--btn-fg); border: none;
    padding: 6px 14px; border-radius: 4px; cursor: pointer;
    font-size: 12px; font-family: inherit;
    transition: opacity .12s, background .12s;
}
button:hover { opacity: .9; }
button:active { transform: translateY(1px); }
button.sec { background: var(--btn2-bg); color: var(--btn2-fg); white-space: nowrap; }
button:disabled { opacity: .45; cursor: not-allowed; }

/* ─── Hints / live validation ─── */
.hint { font-size: 11px; color: var(--fg2); margin-top: 4px; line-height: 1.5; }
.flderr { font-size: 11px; color: #e5534b; margin-top: 3px; line-height: 1.5; }
.flderr:empty { display: none; }
.hint code, .tip-pop code, .page-sub code, .save-hint code {
    background: var(--code-bg); padding: 1px 4px; border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
}

/* ─── Checkboxes ─── */
input[type="checkbox"] { width: 14px; height: 14px; min-width: 0; flex: 0 0 auto; padding: 0; }
label.chk { display: inline-flex; align-items: center; gap: 6px; margin: 4px 16px 4px 0; cursor: pointer; min-width: 0; }

/* ─── Two-column flag grid + field blocks ─── */
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.fld { display: flex; flex-direction: column; min-width: 0; margin-bottom: 8px; }
.fld > label { display: flex; min-width: 0; margin-bottom: 4px; }
@media (max-width: 720px) { .grid2 { grid-template-columns: 1fr; } body { padding: 14px 12px 90px; } }

/* ─── Fuses ─── */
.fusebox { display: flex; gap: 8px; flex: 1; min-width: 280px; align-items: center; flex-wrap: wrap; }
.fusebox input { flex: 1; min-width: 84px; width: auto; }
.fusebox .flab { min-width: 0; font-family: var(--vscode-editor-font-family); color: var(--fg2); }
.fusewarn { color: var(--vscode-charts-yellow, #d1b02a); }

/* ─── Hook rows (label + textarea + variable button) — the sdcc-mdf design ─── */
.hookrow { display: flex; gap: 8px; margin-bottom: 8px; align-items: flex-start; }
.hookrow label { min-width: 90px; margin-top: 5px; }
.hookrow textarea { flex: 1; width: auto; }
/* ─── variable button (\${…}) + the picker's detail pane ─── */
.varbtn { align-self: flex-start; font-family: var(--vscode-editor-font-family); }
.vardetail { border-top: 1px solid var(--border); padding: 6px 10px 10px; font-size: 11px; color: var(--fg2);
    min-height: 42px; background: var(--section-bg); flex: 0 0 auto; }
.vardetail .vd-name { color: var(--fg); font-size: 12px; margin-bottom: 2px;
    font-family: var(--vscode-editor-font-family); }
#varPicker .varitem .vn { color: var(--accent); font-family: var(--vscode-editor-font-family); }

/* ─── Info tooltips (ⓘ) — pure CSS, hover OR keyboard focus ─── */
.tip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 13px; height: 13px; margin-left: 3px;
    border-radius: 50%;
    background: var(--vscode-badge-background, rgba(128,128,128,.35));
    color: var(--vscode-badge-foreground, var(--fg2));
    font-size: 9px; font-weight: bold; font-family: sans-serif;
    cursor: help; vertical-align: middle;
    position: relative; border: none; padding: 0;
    flex: 0 0 auto;
}
.tip::before { content: 'i'; display: block; line-height: 1; transform: translateY(0.02em); }
.tip-pop {
    display: none; position: absolute;
    left: 20px; top: -10px;
    width: 300px; max-width: 60vw;
    padding: 9px 11px; text-align: left;
    background: var(--tip-bg); color: var(--tip-fg);
    border: 1px solid var(--tip-bd); border-radius: 5px;
    box-shadow: 0 4px 14px rgba(0,0,0,.4);
    font-size: 11px; font-weight: normal; line-height: 1.5;
    z-index: 500; white-space: normal;
    overflow-wrap: break-word;
}
.tip-pop .tp-t { display: block; color: var(--fg); font-weight: 600; margin-bottom: 3px; font-size: 11px; }
.tip-pop .tp-x { display: block; color: var(--fg2); font-size: 11px; }
.tip-pop b { color: var(--fg); font-weight: 600; }
.tip:hover .tip-pop, .tip:focus .tip-pop { display: block; }
.tip.tip-end .tip-pop { left: auto; right: 20px; }

/* ─── Segmented control (toolchain) ─── */
.seg { display: inline-flex; border: 1px solid var(--input-border); border-radius: 4px; overflow: hidden; vertical-align: middle; }
.seg-btn { background: transparent; color: var(--fg2); border: none; border-right: 1px solid var(--input-border); border-radius: 0; padding: 5px 18px; font-size: 12px; white-space: nowrap; }
.seg-btn:last-child { border-right: none; }
.seg-btn:hover:not(.active) { opacity: 1; background: rgba(128,128,128,0.12); }
.seg-btn.active { background: var(--btn-bg); color: var(--btn-fg); cursor: default; }

/* ─── MCU dropdown (varpicker-style overlay) ─── */
.varpicker {
    position: fixed; z-index: 1000; width: 380px;
    min-width: 280px; min-height: 180px;
    max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);
    display: none; flex-direction: column;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--border); border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0,0,0,.45); overflow: hidden;
}
.varpicker .vp-search { margin: 8px; width: calc(100% - 16px); flex: 0 0 auto; }
.varlist { flex: 1 1 auto; overflow-y: auto; min-height: 40px; max-height: 240px; padding: 0 4px 4px; }
.vargroup {
    font-size: 10px; color: var(--fg2); text-transform: uppercase; letter-spacing: .6px;
    padding: 7px 8px 3px; margin-bottom: 2px;
    position: sticky; top: 0; z-index: 2;
    background: var(--section-bg); border-bottom: 1px solid var(--border2);
}
.varitem { display: flex; justify-content: space-between; gap: 12px; align-items: baseline;
    padding: 3px 8px; cursor: pointer; border-radius: 3px; }
.varitem:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.14)); }
.varitem .vn { color: var(--fg); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.varitem.cur .vn { font-weight: 700; }
.varitem .vd { color: var(--fg2); font-size: 11px; text-align: right; white-space: nowrap; }
.varitem.cur .vd { color: var(--accent); font-weight: 600; }
.vp-detail {
    border-top: 1px solid var(--border); padding: 6px 10px 8px; font-size: 11px; color: var(--fg2);
    min-height: 34px; background: var(--section-bg); flex: 0 0 auto;
    display: flex; align-items: center; gap: 10px; line-height: 1.4;
}
.vp-detail .vd-txt { flex: 1; overflow-wrap: break-word; }
.vp-detail button { padding: 3px 10px; font-size: 11px; }

/* ─── Sticky save bar ─── */
.save-bar {
    position: fixed; left: 0; right: 0; bottom: 0;
    padding: 10px 20px;
    background: var(--vscode-editorWidget-background, var(--bg));
    border-top: 1px solid var(--border2);
    display: flex; align-items: center; gap: 12px;
    z-index: 100;
}
.save-bar .save-hint { font-size: 11px; color: var(--fg2); }
.save-bar button { padding: 7px 18px; font-size: 13px; }
.save-bar .save-spacer { flex: 1; }

/* ─── Section accents (left border) ─── */
.card.accent-general    { border-left: 3px solid var(--accent); }
.card.accent-toolchain  { border-left: 3px solid var(--amber); }
.card.accent-sources    { border-left: 3px solid var(--vscode-charts-orange, #d28f1c); }
.card.accent-includes   { border-left: 3px solid var(--vscode-charts-yellow, #d1b02a); }
.card.accent-defines    { border-left: 3px solid var(--vscode-charts-purple, #a374e8); }
.card.accent-libraries  { border-left: 3px solid var(--vscode-charts-blue, #4daafc); }
.card.accent-components { border-left: 3px solid var(--vscode-charts-cyan, #37b3d2); }
.card.accent-build      { border-left: 3px solid var(--vscode-charts-orange, #d28f1c); }
.card.accent-hooks      { border-left: 3px solid var(--vscode-charts-red, #f14c4c); }
.card.accent-upload     { border-left: 3px solid var(--vscode-charts-blue, #4daafc); }
</style>
</head>
<body>

<div class="page-hd">
    <h1>⚙️ AVR Project Editor</h1>
    <div class="page-sub">
        Configure how this project <b>builds</b>, <b>links</b> and <b>flashes</b> onto the AVR.
        Values are saved to <code>avr-project.json</code> at the project root (<code id="pFile"></code>).
        Hover any <b>ⓘ</b> for an explanation of the field and why it matters.
    </div>
    <div class="page-actions">
        <span class="pa-note"><kbd>Ctrl</kbd>+<kbd>S</kbd> won't work in a webview — click <b>💾 Save</b> at the bottom.</span>
    </div>
</div>

<!-- ─── General ─── -->
<section class="card accent-general">
    <header class="card-hd">
        <span class="c-icon">⚙️</span>
        <h3>General</h3>
        <span class="c-sub">project identity</span>
        <span class="tip c-tip" tabindex="0" title="General">
            <span class="tip-pop"><span class="tp-t">General — project identity</span>
            <span class="tp-x">The <b>Name</b> shows in the AVR sidebar and build messages (an empty name is refused at Save). The <b>MCU</b> is the single most important setting: it fixes the <code>-mmcu=</code> flag (<code>-mcpu=</code> under XC8), the flash/RAM/EEPROM budget checked after every build, <code>F_CPU</code> (passed as <code>-D</code>) and the avrdude <code>-p</code> part number.</span>
            </span>
        </span>
    </header>
    <div class="card-bd">
        <div class="row">
            <label>Project name <span class="tip" tabindex="0" title="Project name">
                <span class="tip-pop"><span class="tp-t">Project name</span>
                <span class="tp-x">Free-form display name — shown in the AVR sidebar tree and in build/flash messages. Required: validation refuses to save when it is empty. <b>Example:</b> <code>blink-328p</code>.</span>
                </span>
            </span></label>
            <input id="f_name" placeholder="blink-328p">
        </div>
        <div class="row">
            <label>MCU <span class="tip" tabindex="0" title="Target MCU">
                <span class="tip-pop"><span class="tp-t">MCU — the target chip</span>
                <span class="tp-x">Pick-only: click <b>▾</b> for the searchable list (grouped by AVR series, current one in <b>bold</b>), or use the VS Code QuickPick from the dropdown footer. The MCU fixes avr-gcc <code>-mmcu=&lt;mcu&gt;</code> (XC8: <code>-mcpu=</code> MPLAB name), the device header <code>&lt;avr/io.h&gt;</code> pulls in, <code>F_CPU</code> as a <code>-D</code> define, the flash/RAM/EEPROM limits of the Memory Summary, and the avrdude <code>-p</code> part. An id that is not in the database still works — the raw <code>-mmcu=&lt;id&gt;</code> is passed through.</span>
                </span>
            </span></label>
            <input id="f_board" readonly tabindex="-1" placeholder="pick an MCU via ▾">
            <button type="button" class="sec" id="boardBtn" title="Open the searchable MCU list (grouped by AVR series, current one in bold)">▾</button>
        </div>
        <div class="hint" id="boardInfo"></div>
    </div>
</section>

<!-- ─── Toolchain ─── -->
<section class="card accent-toolchain">
    <header class="card-hd">
        <span class="c-icon">🔀</span>
        <h3>Toolchain</h3>
        <span class="c-sub">avr-gcc or XC8 · saved with the project</span>
        <span class="tip c-tip" tabindex="0" title="Toolchain">
            <span class="tip-pop"><span class="tp-t">Toolchain — avr-gcc ⇄ XC8</span>
            <span class="tp-x">Both compilers build the same source tree into <code>build/&lt;name&gt;.hex</code>, and avrdude flashes either. <b>GNU avr-gcc</b> is the free classic (<code>apt install gcc-avr avr-libc</code>); <b>Microchip XC8</b> (<code>xc8-cc</code>) is the MPLAB 8-bit compiler. The choice is stored as <code>toolchain</code> in avr-project.json and applied on the next build — also switchable from the status-bar chip or <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd>.</span>
            </span>
        </span>
    </header>
    <div class="card-bd">
        <div class="row">
            <label>Compiler <span class="tip" tabindex="0" title="Compiler choice">
                <span class="tip-pop"><span class="tp-t">Compiler choice</span>
                <span class="tp-x"><b>avr-gcc:</b> <code>&lt;avr/io.h&gt;</code> device headers, <code>F_CPU</code> define, compile → link → avr-objcopy pipeline, <code>.elf/.hex/.bin/.eep</code> artifacts, avr-gdb debugging. <b>XC8:</b> <code>&lt;xc.h&gt;</code> universal include, <code>F_CPU</code> + <code>&lt;util/delay.h&gt;</code> (<code>_delay_ms</code>), one <code>xc8-cc</code> step compiles, assembles and links the ELF, then avr-objcopy emits the <code>.hex</code>, <code>#pragma config</code> embeds fuses.</span>
                </span>
            </span></label>
            <div class="seg" role="group" aria-label="Toolchain: GNU avr-gcc or Microchip XC8">
                <button type="button" class="seg-btn" id="segGcc" title="GNU avr-gcc + avr-libc — the free classic toolchain">GNU avr-gcc</button>
                <button type="button" class="seg-btn" id="segXc8" title="Microchip XC8 (xc8-cc) — the MPLAB 8-bit compiler">Microchip XC8</button>
            </div>
        </div>
        <div class="hint" id="tcHint"></div>
    </div>
</section>

<!-- ─── Sources ─── -->
<section class="card accent-sources">
    <header class="card-hd">
        <span class="c-icon">📄</span>
        <h3>Sources</h3>
        <span class="c-sub">application code · default folder: src</span>
        <span class="tip c-tip" tabindex="0" title="Sources">
            <span class="tip-pop"><span class="tp-t">Sources — application code</span>
            <span class="tp-x">What gets compiled into the firmware. A folder (e.g. <code>src</code>) is scanned <b>recursively</b> for <code>.c/.cpp/.cc/.cxx/.S/.s</code>; a single file path compiles just that file; a JSON rule like <code>{"path":"src","pattern":"**/*.c"}</code> pins exact glob semantics. <b>Why:</b> an explicit list keeps stray scratch files out of the binary.</span>
            </span>
        </span>
    </header>
    <div class="card-bd">
        <textarea id="f_sources" placeholder="src&#10;lib/extra/fixed.c&#10;{&quot;path&quot;:&quot;src&quot;,&quot;pattern&quot;:&quot;**/*.c&quot;}"></textarea>
        <div class="hint">One per line: folder, file, or JSON rule like <code>{"path":"src","pattern":"**/*.c"}</code>. Default: <code>src</code> — scanned recursively for .c/.cpp/.S/.s.</div>
    </div>
</section>

<!-- ─── Includes ─── -->
<section class="card accent-includes">
    <header class="card-hd">
        <span class="c-icon">📁</span>
        <h3>Includes</h3>
        <span class="c-sub">header search paths (-I)</span>
        <span class="tip c-tip" tabindex="0" title="Includes">
            <span class="tip-pop"><span class="tp-t">Includes — header search paths</span>
            <span class="tp-x">Extra <code>-I</code> directories, one per line, relative to the project root. avr-libc headers (<code>&lt;avr/io.h&gt;</code>, <code>&lt;util/delay.h&gt;</code>, <code>&lt;avr/sleep.h&gt;</code>) are always on the path — list only <b>your own</b> folders here (e.g. <code>include</code>, <code>lib/MyLib/inc</code>). Component include dirs are added automatically.</span>
            </span>
        </span>
    </header>
    <div class="card-bd">
        <textarea id="f_includes" placeholder="include&#10;lib/MyLib/inc"></textarea>
        <div class="hint">One include dir per line (relative to the project root) — passed to the compiler as <code>-I</code>.</div>
    </div>
</section>

<!-- ─── Defines ─── -->
<section class="card accent-defines">
    <header class="card-hd">
        <span class="c-icon">#</span>
        <h3>Defines</h3>
        <span class="c-sub">preprocessor symbols (-D)</span>
        <span class="tip c-tip" tabindex="0" title="Defines">
            <span class="tip-pop"><span class="tp-t">Defines — preprocessor macros</span>
            <span class="tp-x">Passed to the compiler as <code>-D</code>. Use them to configure library code at compile time (<code>USE_UART</code>, <code>MY_FLAG=1</code>) or constants read with <code>#ifdef</code>. <b>F_CPU already arrives from the MCU definition</b> — don't duplicate it: the later <code>-D</code> wins, and a stale <code>F_CPU</code> is the classic invisible <code>_delay_ms</code> bug.</span>
            </span>
        </span>
    </header>
    <div class="card-bd">
        <textarea id="f_defines" placeholder="MY_FLAG=1&#10;USE_UART"></textarea>
        <div class="hint">One per line (comma also works). <code>F_CPU</code> arrives from the MCU definition — don't duplicate it.</div>
    </div>
</section>

<!-- ─── Libraries ─── -->
<section class="card accent-libraries">
    <header class="card-hd">
        <span class="c-icon">📚</span>
        <h3>Libraries</h3>
        <span class="c-sub">prebuilt .a archives</span>
        <span class="tip c-tip" tabindex="0" title="Libraries">
            <span class="tip-pop"><span class="tp-t">Libraries — prebuilt .a archives</span>
            <span class="tp-x">A folder is <b>scanned for <code>*.a</code></b> files and every archive is linked after your objects; a single <code>.a</code> path links just that one. AVR GCC link order matters — archives satisfy symbols from code <b>compiled before them</b>; circular dependencies may need the archive twice or <code>-Wl,--start-group</code> in Link flags. For <code>-lm</code> and friends use the Link flags field of the Build card.</span>
            </span>
        </span>
    </header>
    <div class="card-bd">
        <textarea id="f_libraries" placeholder="lib&#10;vendor/prebuilt.a"></textarea>
        <div class="hint">One per line: a folder scanned for <code>*.a</code>, or a single <code>.a</code> path. For <code>-lm</code> use Link flags (Build card).</div>
    </div>
</section>

<!-- ─── Components ─── -->
<section class="card accent-components">
    <header class="card-hd">
        <span class="c-icon">🧩</span>
        <h3>Components</h3>
        <span class="c-sub">source libraries · default folder: components</span>
        <span class="tip c-tip" tabindex="0" title="Components">
            <span class="tip-pop"><span class="tp-t">Components — source libraries</span>
            <span class="tp-x">A folder's <b>subfolders</b> are each one source library: compiled with the board flags, archived with <code>avr-ar</code> into <code>build/comp/&lt;name&gt;.a</code>, then linked — rebuilt from C on every build, unlike the prebuilt <code>.a</code> archives above. A component's <code>inc/</code> or <code>include/</code> folder is added to the include path automatically. For a library outside <code>components/</code> use the JSON form: <code>{"name":"mylib","path":"vendor/mylib","pattern":"**/*.c"}</code>.</span>
            </span>
        </span>
    </header>
    <div class="card-bd">
        <textarea id="f_components" placeholder="components&#10;{&quot;name&quot;:&quot;mylib&quot;,&quot;path&quot;:&quot;vendor/mylib&quot;,&quot;pattern&quot;:&quot;**/*.c&quot;}"></textarea>
        <div class="hint">Folder → each subfolder is one source lib (→ <code>build/comp/&lt;name&gt;.a</code>). JSON → explicit component outside <code>components/</code>.</div>
    </div>
</section>

<!-- ─── Build ─── -->
<section class="card accent-build">
    <header class="card-hd">
        <span class="c-icon">🔨</span>
        <h3>Build</h3>
        <span class="c-sub">output · optimization · flags</span>
        <span class="tip c-tip" tabindex="0" title="Build">
            <span class="tip-pop"><span class="tp-t">Build — output · optimization · flags</span>
            <span class="tp-x"><b>Output dir/name</b> decide the artifact paths (<code>&lt;dir&gt;/&lt;name&gt;.elf/.hex/.bin/.eep/.map</code>). <b>Optimization</b> overrides the board default for every file. The three checkboxes are the classic AVR size savers — gc-sections and relax are on by default, LTO off. The four flag fields take one flag per line and are appended after the generated ones.</span>
            </span>
        </span>
    </header>
    <div class="card-bd">
        <div class="row">
            <label>Build mode <span class="tip" tabindex="0" title="Build mode">
                <span class="tip-pop"><span class="tp-t">Build mode (Release / Debug)</span>
                <span class="tp-x">The same switch as the <b>status-bar</b> item — setting <code>avr.buildMode</code>, kept in sync both ways (the status bar refreshes the moment you click here, and this control follows when the mode is switched elsewhere). <b>Debug</b> compiles with <code>-Og -g</code> and defines <code>DEBUG</code> (DWARF for simavr/avr-gdb); <b>Release</b> is the size-optimized build. Tip: point <b>Output dir</b> at <code>build/\${config:buildMode}</code> to keep the two modes' artefacts apart. Applied <b>immediately</b> — it is a VS Code setting, not part of avr-project.json, so Save is not needed.</span>
                </span>
            </span></label>
            <div class="seg" id="buildModeSeg" role="group" aria-label="Build mode: Release or Debug">
                <button type="button" class="seg-btn" id="modeRelease" title="-Os — size-optimized firmware">Release</button>
                <button type="button" class="seg-btn" id="modeDebug" title="-Og -g + DEBUG — DWARF for simavr/avr-gdb">Debug</button>
            </div>
        </div>
        <div class="hint" id="buildModeHint"></div>
        <div class="row">
            <label>Output dir <span class="tip" tabindex="0" title="Output dir">
                <span class="tip-pop"><span class="tp-t">Output dir</span>
                <span class="tp-x">Where the artifacts land, relative to the project root: <code>&lt;dir&gt;/&lt;name&gt;.elf</code>, <code>.hex</code>, <code>.bin</code>, <code>.eep</code>, <code>.map</code> and the <code>obj/</code> mirror tree. Default: <code>build</code>. <b>Variables</b> (click <code>\${…}</code> next to the field) work — e.g. <code>build/\${config:buildMode}</code> keeps debug and release apart.</span>
                </span>
            </span></label>
            <input id="f_outdir" placeholder="build  (variables: build/\${config:buildMode})">
            <button type="button" class="sec varbtn" data-target="f_outdir" onclick="openVarPicker(this)" title="Insert variable at cursor">\${…}</button>
        </div>
        <div class="row">
            <label>Output name <span class="tip" tabindex="0" title="Output name">
                <span class="tip-pop"><span class="tp-t">Output name</span>
                <span class="tp-x">Base name without extension — <code>firmware</code> → <code>firmware.elf/.hex/.bin/.eep/.map</code>. Variables work — e.g. <code>fw_\${buildMode}</code> or <code>\${board.mcu}</code> (board variables resolve at build time; unresolved ones stay literal). Default: <code>firmware</code>.</span>
                </span>
            </span></label>
            <input id="f_outname" placeholder="firmware  (variables: fw_\${buildMode})">
            <button type="button" class="sec varbtn" data-target="f_outname" onclick="openVarPicker(this)" title="Insert variable at cursor">\${…}</button>
        </div>
        <div class="row">
            <label>Optimization <span class="tip" tabindex="0" title="Optimization">
                <span class="tip-pop"><span class="tp-t">Optimization (-O)</span>
                <span class="tp-x"><b>Board default</b> is <code>-Os</code> unless the MCU entry says otherwise. <code>-Os</code> optimizes for size — flash is the scarce resource on AVR; <code>-O0</code> keeps variables in RAM and single-steps cleanly under avr-gdb; <code>-Og</code> is the debug-friendly middle; <code>-O2/-O3</code> trade flash for speed. This overrides the board default for <b>every</b> file.</span>
                </span>
            </span></label>
            <select id="f_opt">
                <option value="">board default (-Os)</option>
                <option value="s">-Os — optimize for size</option>
                <option value="0">-O0 — no optimization (debug)</option>
                <option value="1">-O1 — light optimization</option>
                <option value="2">-O2 — speed/size balance</option>
                <option value="3">-O3 — aggressive speed (biggest code)</option>
                <option value="g">-Og — optimize for debugging</option>
            </select>
        </div>
        <div class="row">
            <label class="chk"><input type="checkbox" id="f_gc"> -ffunction/-data-sections + --gc-sections
                <span class="tip" tabindex="0" title="gc-sections">
                    <span class="tip-pop"><span class="tp-t">Garbage-collect sections</span>
                    <span class="tp-x">Adds <code>-ffunction-sections -fdata-sections</code> when compiling and <code>-Wl,--gc-sections</code> when linking: unreferenced functions and variables are dropped — typically <b>30-60% smaller</b> AVR binaries. Safe: ISRs survive (the vector table references them); sections referenced only from hand-written asm need <code>KEEP()</code> or a <code>USED</code> symbol. Default on.</span>
                    </span>
                </span>
            </label>
            <label class="chk"><input type="checkbox" id="f_relax"> -mrelax
                <span class="tip" tabindex="0" title="relax">
                    <span class="tip-pop"><span class="tp-t">Linker relaxation</span>
                    <span class="tp-x"><code>-mrelax</code> arms the documented AVR relaxation — the assembler (<code>--mlink-relax</code>) and the linker (<code>--relax</code>) together — shortening <code>call/jmp</code> to <code>rcall/rjmp</code> where the target is within ±4K words: a few hundred bytes saved per project, free. Turn it off only for hand-written relocation-sensitive assembly. Default on.</span>
                    </span>
                </span>
            </label>
            <label class="chk"><input type="checkbox" id="f_lto"> -flto
                <span class="tip" tabindex="0" title="LTO">
                    <span class="tip-pop"><span class="tp-t">Link-time optimization</span>
                    <span class="tp-x"><code>-flto</code> optimizes <b>across</b> translation units (whole-program): smaller and often faster firmware, at the price of slower builds and occasional asm/C boundary quirks. Pairs well with gc-sections. Off by default.</span>
                    </span>
                </span>
            </label>
        </div>
        <div class="grid2">
            <div class="fld">
                <label>C flags <span class="tip" tabindex="0" title="C flags">
                    <span class="tip-pop"><span class="tp-t">C flags — .c files only</span>
                    <span class="tp-x">One flag per line, appended after the generated ones. <b>Useful:</b> <code>-Wall -Wextra</code>, <code>-funsigned-char</code>, <code>-Wl…</code> belongs in Link flags instead. <code>-mmcu</code>, <code>-DF_CPU</code> and the optimization come from the MCU/Optimization fields — don't repeat them.</span>
                    </span>
                </span></label>
                <textarea id="f_cflags" class="short" placeholder="-Wall&#10;-funsigned-char"></textarea>
                <div class="hint">One per line — C sources only.</div>
            </div>
            <div class="fld">
                <label>C++ flags <span class="tip" tabindex="0" title="C++ flags">
                    <span class="tip-pop"><span class="tp-t">C++ flags — .cpp/.cc/.cxx only</span>
                    <span class="tp-x">One flag per line, appended after the C flags. On AVR you almost always want <code>-fno-exceptions</code> and <code>-fno-rtti</code> — both pull in heavy runtime support that flash can rarely afford.</span>
                    </span>
                </span></label>
                <textarea id="f_cxxflags" class="short" placeholder="-fno-exceptions&#10;-fno-rtti"></textarea>
                <div class="hint">One per line — C++ sources only.</div>
            </div>
            <div class="fld">
                <label>Asm flags <span class="tip" tabindex="0" title="Asm flags">
                    <span class="tip-pop"><span class="tp-t">Asm flags — .S/.s only</span>
                    <span class="tp-x">One flag per line, passed when assembling <code>.S</code> (with cpp) and <code>.s</code> (plain) files. <b>Useful:</b> <code>-x assembler-with-cpp</code>, listing options like <code>-Wa,-adhln=&lt;file&gt;</code>. There is no preprocessor for bare <code>.s</code> files — use <code>.S</code> when you need <code>#include</code>/<code>#define</code>.</span>
                    </span>
                </span></label>
                <textarea id="f_asmflags" class="short" placeholder="-x assembler-with-cpp"></textarea>
                <div class="hint">One per line — assembly sources only (.S/.s).</div>
            </div>
            <div class="fld">
                <label>Link flags <span class="tip" tabindex="0" title="Link flags">
                    <span class="tip-pop"><span class="tp-t">Link flags</span>
                    <span class="tp-x">One flag per line, appended to the link step. <b>Useful:</b> <code>-lm</code> (float printf/atan — link order: here is fine), <code>-Wl,-u,vfprintf</code> + <code>-lprintf_flt</code> (floats in printf), <code>-Wl,-Map=…</code> (the build already passes the map path). <code>--gc-sections/--relax</code> come from the checkboxes above.</span>
                    </span>
                </span></label>
                <textarea id="f_linkflags" class="short" placeholder="-lm&#10;-Wl,-u,vfprintf"></textarea>
                <div class="hint">One per line — the link step (<code>-lm</code> & friends live here).</div>
            </div>
        </div>
    </div>
</section>

<!-- ─── Hooks ─── -->
<section class="card accent-hooks">
    <header class="card-hd">
        <span class="c-icon">🪝</span>
        <h3>Hooks</h3>
        <span class="c-sub">shell commands around build & flash</span>
        <span class="tip c-tip" tabindex="0" title="Hooks">
            <span class="tip-pop"><span class="tp-t">Hooks — commands around build &amp; flash</span>
            <span class="tp-x">Run shell commands at a specific stage of the build/flash pipeline, in the AVR terminal — each stage has its own field, one command <b>per line</b> (they run in order; a non-zero exit <b>stops the pipeline</b>). Click <b>\${…}</b> next to a field to insert one of the <b>variables</b> — grouped, searchable, with tooltips: <code>\${workspaceFolder}</code>, <code>\${board.mcu}</code>, <code>\${outputHex}</code>, <code>\${outputElf}</code>, <code>\${config:…}</code>, <code>\${env:…}</code>; unresolved ones stay literal. <b>Stages:</b> pre_build → compile → post_link → post_build → pre_upload → (avrdude) → post_upload.</span>
            </span>
        </span>
    </header>
    <div class="card-bd">
        <div class="hint" style="margin-bottom:8px">One command <b>per line</b> (they run in order); a non-zero exit stops the pipeline. Click <b>\${…}</b> next to a field to insert a variable at the cursor (grouped &amp; searchable).</div>
        <div class="hookrow">
            <label>pre_build <span class="tip tip-end" tabindex="0" title="pre_build hook">
                <span class="tip-pop"><span class="tp-t">pre_build</span>
                <span class="tp-x">Runs <b>before</b> compilation. Use for: code generation (e.g. <code>python gen_pins.py</code>), fetching a submodule, bumping a version file.</span></span>
            </span></label>
            <textarea id="hook_pre_build" style="min-height:34px" placeholder="python \${workspaceFolder}/tools/gen_version.py"></textarea>
            <button type="button" class="sec varbtn" data-target="hook_pre_build" onclick="openVarPicker(this)" title="Insert variable at cursor">\${…}</button>
        </div>
        <div class="hookrow">
            <label>post_link <span class="tip tip-end" tabindex="0" title="post_link hook">
                <span class="tip-pop"><span class="tp-t">post_link</span>
                <span class="tp-x">Runs <b>right after</b> the linker produces the <code>.elf</code> and <b>before</b> objcopy makes <code>.hex</code>/<code>.bin</code>. Use for: patching the ELF, computing a checksum, signing.</span></span>
            </span></label>
            <textarea id="hook_post_link" style="min-height:34px"></textarea>
            <button type="button" class="sec varbtn" data-target="hook_post_link" onclick="openVarPicker(this)" title="Insert variable at cursor">\${…}</button>
        </div>
        <div class="hookrow">
            <label>post_build <span class="tip tip-end" tabindex="0" title="post_build hook">
                <span class="tip-pop"><span class="tp-t">post_build</span>
                <span class="tp-x">Runs <b>after</b> the full build (<code>.hex</code>/<code>.bin</code>/<code>.eep</code> produced). Use for: CRC, signing, packaging into a .zip for an OTA update. <b>Example:</b> <code>python crc.py \${outputBin}</code>.</span></span>
            </span></label>
            <textarea id="hook_post_build" style="min-height:34px" placeholder="python crc.py \${outputBin}"></textarea>
            <button type="button" class="sec varbtn" data-target="hook_post_build" onclick="openVarPicker(this)" title="Insert variable at cursor">\${…}</button>
        </div>
        <div class="hookrow">
            <label>pre_upload <span class="tip tip-end" tabindex="0" title="pre_upload hook">
                <span class="tip-pop"><span class="tp-t">pre_upload</span>
                <span class="tp-x">Runs <b>before</b> avrdude. Use for: asserting the right serial port, toggling a reset line, opening the Serial Monitor.</span></span>
            </span></label>
            <textarea id="hook_pre_upload" style="min-height:34px"></textarea>
            <button type="button" class="sec varbtn" data-target="hook_pre_upload" onclick="openVarPicker(this)" title="Insert variable at cursor">\${…}</button>
        </div>
        <div class="hookrow">
            <label>post_upload <span class="tip tip-end" tabindex="0" title="post_upload hook">
                <span class="tip-pop"><span class="tp-t">post_upload</span>
                <span class="tp-x">Runs <b>after</b> avrdude succeeds. Use for: logging, restarting the target, launching a test script.</span></span>
            </span></label>
            <textarea id="hook_post_upload" style="min-height:34px"></textarea>
            <button type="button" class="sec varbtn" data-target="hook_post_upload" onclick="openVarPicker(this)" title="Insert variable at cursor">\${…}</button>
        </div>
    </div>
</section>

<!-- ─── Upload ─── -->
<section class="card accent-upload">
    <header class="card-hd">
        <span class="c-icon">📡</span>
        <h3>Upload</h3>
        <span class="c-sub">avrdude programmer · port · fuses</span>
        <span class="tip c-tip" tabindex="0" title="Upload">
            <span class="tip-pop"><span class="tp-t">Upload — flashing the chip</span>
            <span class="tp-x">The programmer recipe becomes <code>avrdude -c &lt;id&gt;</code>; the part number <code>-p</code> comes from the MCU. USB programmers (usbasp, Atmel-ICE, SNAP…) need no port; serial ones (bootloaders, STK500, SerialUPDI) use the Port field. The custom tool override replaces avrdude entirely. Fuses are written only by the explicit Write Fuses command.</span>
            </span>
        </span>
    </header>
    <div class="card-bd">
        <div class="row">
            <label>Programmer (-c) <span class="tip" tabindex="0" title="Programmer">
                <span class="tip-pop"><span class="tp-t">Programmer — avrdude -c</span>
                <span class="tp-x">Stored as <code>upload.programmer</code>. <b>usbasp</b> = the classic open ISP programmer (add <code>-B 32</code> to rescue fresh slow chips); <b>arduino</b> = Optiboot bootloader over the serial port with DTR auto-reset; <b>serialupdi</b> = UPDI through a plain USB-serial adapter + resistor (avrdude 7+); <b>atmelice_updi / pickit4_updi / snap_updi</b> = real debuggers for modern AVR parts; <b>dragon_pp</b> = high-voltage parallel rescue. USB ones need no port; serial ones use the Port field.</span>
                </span>
            </span></label>
            <select id="f_protocol"></select>
        </div>
        <div class="hint" id="progHint" style="margin-bottom:10px"></div>
        <div class="row">
            <label>Port override <span class="tip" tabindex="0" title="Port override">
                <span class="tip-pop"><span class="tp-t">Port override</span>
                <span class="tp-x">Overrides the <code>avr.comPort</code> setting for <b>this project only</b> — becomes <code>avrdude -P &lt;port&gt;</code>. Only serial programmers and bootloaders use a port (COM3, /dev/ttyUSB0…); usbasp / usbtiny / Atmel-ICE / SNAP ignore it. Empty = follow the setting (AVR: Select Port).</span>
                </span>
            </span></label>
            <input id="f_port" placeholder="COM3 / /dev/ttyUSB0  (empty = avr.comPort)">
        </div>
        <div class="hint" id="portHint" style="margin-bottom:10px"></div>
        <div class="row">
            <label>Baud <span class="tip" tabindex="0" title="Baud">
                <span class="tip-pop"><span class="tp-t">Baud — avrdude -b</span>
                <span class="tp-x">Serial speed for bootloaders and serial-protocol programmers: Optiboot 115200, Caterina 57600, old Nano bootloaders 57600/19200, STK500v1 clones 19200, Bus Pirate 115200. USB programmers ignore it. Empty = the recipe's default, then the board's speed.</span>
                </span>
            </span></label>
            <input id="f_baud" placeholder="115200  (serial programmers / bootloaders)">
        </div>
        <div class="row">
            <label class="chk"><input type="checkbox" id="f_eeprom"> also upload firmware.eep after flash
                <span class="tip" tabindex="0" title="EEPROM upload">
                    <span class="tip-pop"><span class="tp-t">EEPROM upload</span>
                    <span class="tp-x">After flashing <code>&lt;name&gt;.hex</code>, also run <code>avrdude -U eeprom:w:&lt;name&gt;.eep</code>. The <code>.eep</code> file exists only when the build found a non-empty <code>.eeprom</code> section — data placed there with <code>EEMEM</code> or <code>__attribute__((section(".eeprom")))</code>.</span>
                    </span>
                </span>
            </label>
        </div>
        <div class="row">
            <label>Custom tool <span class="tip" tabindex="0" title="Custom tool">
                <span class="tip-pop"><span class="tp-t">Custom tool override (advanced)</span>
                <span class="tp-x">Replaces avrdude entirely: the flash command becomes <code>&lt;tool&gt; &lt;args…&gt;</code> with full <code>\${…}</code> variable expansion (<code>\${outputHex}</code>, <code>\${board.mcu}</code>, <code>\${config:comPort}</code>…). Empty = the normal avrdude path. Use it for a custom avrdude build, pyupdi-style tools, or a <code>make flash</code> wrapper.</span>
                    </span>
            </span></label>
            <input id="f_tool" placeholder="empty = avrdude">
            <button type="button" class="sec varbtn" data-target="f_tool" onclick="openVarPicker(this)" title="Insert variable at cursor">\${…}</button>
        </div>
        <div class="row" style="align-items:flex-start">
            <label style="margin-top:5px">Custom args <span class="tip" tabindex="0" title="Custom args">
                <span class="tip-pop"><span class="tp-t">Custom args</span>
                <span class="tp-x">One argument per line, passed to the custom tool after <code>\${…}</code> variable expansion. Only used when the Custom tool field is filled (a non-empty args list alone is still saved, but ignored by the avrdude path).</span>
                    </span>
            </span></label>
            <div style="flex:1;min-width:200px;display:flex;gap:8px;align-items:flex-start">
                <textarea id="f_args" style="flex:1" placeholder="-c usbasp&#10;-p \${board.mcu}&#10;-U flash:w:\${outputHex}:a"></textarea>
                <button type="button" class="sec varbtn" data-target="f_args" onclick="openVarPicker(this)" title="Insert variable at cursor">\${…}</button>
            </div>
            <div class="hint" style="width:100%">One per line — <code>\${…}</code> variables expand (outputHex, board.mcu, config:comPort, env:…).</div>
        </div>
        <div class="row">
            <label>Fuses <span class="tip tip-end" tabindex="0" title="Fuses">
                <span class="tip-pop"><span class="tp-t">Fuses — lfuse / hfuse / efuse</span>
                <span class="tp-x">Hex values (<code>0x62</code>) stored as numbers in <code>upload.fuses</code>. Which bytes exist depends on the part — classic AVR: lfuse/hfuse/efuse; modern tinyAVR / AVR Dx use fuse0-5 via the Fuse Editor. Written <b>only</b> by the explicit AVR: Write Fuses command — never by Build or Flash. Wrong fuse values can brick the chip (clock source, SPIEN, RSTDISBL) — open the Fuse Editor for bit-by-bit help.</span>
                    </span>
            </span></label>
            <div class="fusebox">
                <label class="flab" for="f_lfuse">lfuse</label><input id="f_lfuse" placeholder="0x..">
                <label class="flab" for="f_hfuse">hfuse</label><input id="f_hfuse" placeholder="0x..">
                <label class="flab" for="f_efuse">efuse</label><input id="f_efuse" placeholder="0x..">
            </div>
        </div>
        <div class="hint fusewarn">⚠ fuses are written only by the explicit AVR: Write Fuses command — never automatically.</div>
    </div>
</section>

<!-- ─── Sticky save bar ─── -->
<div class="save-bar">
    <span class="save-hint">writes <code>avr-project.json</code> at the project root (Build mode goes to the <code>avr.buildMode</code> VS Code setting)</span>
    <span class="save-spacer"></span>
    <button type="button" id="btnSave">💾 Save</button>
</div>

<!-- ─── \${…} variable picker (the sdcc-mdf design: opens LEFT of the button,
     grouped, searchable, detail pane below) ─── -->
<div id="varPicker" class="varpicker">
    <input class="vp-search" id="varSearch" placeholder="Filter variables…  (Enter inserts the first match · Esc closes)">
    <div id="varList" class="varlist"></div>
    <div class="vardetail" id="varDetail"><div class="vd-name" id="varDetailName">\${…}</div><div id="varDetailText">Pick a variable to insert at the cursor.</div></div>
</div>

<script>
(function () {
    const vscode = acquireVsCodeApi();
    let proj = null, boards = [], recipes = [], comPort = '';
    let initOk = true;
    let toolchain = 'avr-gcc';

    const $ = id => document.getElementById(id);
    const val = id => $(id).value.trim();
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const arr = v => Array.isArray(v) ? v : [];
    const lineOf = v => typeof v === 'string' ? v : JSON.stringify(v);

    // one string per line (trimmed, empties dropped)
    function parseLines(id) {
        const t = val(id);
        return t ? t.split('\\n').map(s => s.trim()).filter(Boolean) : [];
    }
    // like parseLines, but a line that LOOKS like JSON ({ or [) is parsed —
    // failures stay strings (a folder named "2024" must not become a number)
    function parseLinesJson(id) {
        return parseLines(id).map(s => {
            const c = s.charAt(0);
            if (c === '{' || c === '[') { try { return JSON.parse(s); } catch (e) { return s; } }
            return s;
        });
    }
    // comma-tolerant list (Defines field — legacy "a, b" input still works)
    function lineList(id) {
        const t = val(id);
        return t ? t.split(/[\\n,]+/).map(s => s.trim()).filter(Boolean) : [];
    }
    function flagList(id) {
        const t = val(id);
        return t ? t.split('\\n').map(s => s.trim()).filter(Boolean) : [];
    }

    function fmtKb(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return '?';
        if (v >= 1024 && v % 1024 === 0) return String(v / 1024) + 'K';
        return String(v);
    }
    function fmtMhz(hz) {
        const v = Number(hz);
        if (!Number.isFinite(v) || v <= 0) return '';
        return String(Math.round(v / 1e4) / 100) + ' MHz';
    }

    // ── init-failure / unreadable-config guard ──────────────────────────────
    function setSaveDisabled(msg) {
        initOk = false;
        const btn = $('btnSave');
        if (btn) btn.disabled = true;
        const hint = document.querySelector('.save-hint');
        if (hint) hint.textContent = msg;
    }
    // init runs again on every state push (save round-trip), so a panel that
    // was disabled by an earlier failure/unreadable config must RECOVER
    function setSaveEnabled() {
        initOk = true;
        const btn = $('btnSave');
        if (btn) btn.disabled = false;
        const hint = document.querySelector('.save-hint');
        if (hint) hint.innerHTML = 'writes <code>avr-project.json</code> at the project root';
    }

    // ── MCU summary line under the field ───────────────────────────────────
    function updateBoardInfo() {
        const id = val('f_board');
        const el = $('boardInfo');
        const b = boards.find(x => x.id === id);
        if (b) {
            el.innerHTML = '<b>' + esc(b.name) + '</b> · <code>-mmcu=' + esc(b.mcu) + '</code> · ' +
                esc(b.family || 'classic') + ' · flash ' + fmtKb(b.flash) + 'B · RAM ' + fmtKb(b.ram) + 'B · ' +
                fmtMhz(b.f_cpu_hz) + (b.protocol ? ' · avrdude -c ' + esc(b.protocol) : '');
        } else if (id) {
            el.innerHTML = esc(id) + ' — not in the MCU database; the raw <code>-mmcu=' + esc(id) + '</code> will be used';
        } else {
            el.textContent = 'click ▾ to pick the MCU (searchable, grouped by AVR series)';
        }
    }

    // ── Toolchain segmented control (local state — saved with everything) ──
    function setToolchainUI(tc) {
        toolchain = tc === 'xc8' ? 'xc8' : 'avr-gcc';
        $('segGcc').classList.toggle('active', toolchain === 'avr-gcc');
        $('segXc8').classList.toggle('active', toolchain === 'xc8');
        $('tcHint').innerHTML = toolchain === 'xc8'
            ? 'Microchip XC8 (<b>xc8-cc</b>) — <code>&lt;xc.h&gt;</code> pulls the device headers, <code>F_CPU</code> feeds <code>_delay_ms</code>() from <code>&lt;util/delay.h&gt;</code> (passed as <code>-D</code> by the build), and compile + assemble + link run in ONE <code>xc8-cc</code> step with <code>-mcpu=&lt;MPLAB name&gt;</code> — the ELF out, then XC8\\'s own avr-objcopy emits the <code>.hex</code>. avrdude flashes it as usual.'
            : 'GNU avr-gcc + avr-libc — <code>&lt;avr/io.h&gt;</code> per-MCU headers, <code>F_CPU</code> arrives as a <code>-D</code> define from the MCU definition, artifacts <code>.elf/.hex/.bin/.eep</code> via compile → link → avr-objcopy.';
    }
    $('segGcc').addEventListener('click', () => setToolchainUI('avr-gcc'));
    $('segXc8').addEventListener('click', () => setToolchainUI('xc8'));

    // ── Programmer recipes select + hint ───────────────────────────────────
    function buildProgrammerSelect() {
        const sel = $('f_protocol');
        let opts = '<option value="">— avrdude programmer (recipes) —</option>';
        for (const r of recipes) {
            opts += '<option value="' + esc(r.id) + '">' + esc(r.label) +
                (r.port === 'serial' ? ' · serial' : ' · USB') + '</option>';
        }
        sel.innerHTML = opts;
        // v0.3.21: onchange, not addEventListener — initAll() runs on EVERY
        // state push (each Save round-trip, every ready) and the listener
        // count grew without bound, firing updateProgHint N times per change
        sel.onchange = updateProgHint;
    }
    function updateProgHint() {
        const id = val('f_protocol');
        const h = $('progHint');
        if (!id) {
            h.innerHTML = 'Empty = the <code>avr.programmer</code> setting, then the MCU\\'s default protocol. USB programmers need no port; serial ones use the Port field below.';
            return;
        }
        if (id === 'custom') {
            h.innerHTML = '<b>Custom</b> — fill the <b>Custom tool override</b> fields below (<code>upload.tool</code> + <code>upload.args</code> with \${…} variables); <code>upload.programmer</code> stays unset.';
            return;
        }
        const r = recipes.find(x => x.id === id);
        if (!r) {
            h.innerHTML = '<b>' + esc(id) + '</b> — not a built-in recipe; passed to avrdude as <code>-c ' + esc(id) + '</code> verbatim.';
            return;
        }
        h.innerHTML = '<b>' + esc(r.label) + '</b> — <code>avrdude -c ' + esc(id) + '</code> · ' +
            (r.port === 'serial' ? 'serial programmer (uses the Port field / avr.comPort)' : 'USB programmer (no serial port needed)') +
            (r.baud ? ' · default baud ' + esc(r.baud) + ' when Baud is empty' : '') +
            '<br>' + esc(r.desc);
    }
    function updatePortHint() {
        $('portHint').innerHTML = comPort
            ? 'empty = the <code>avr.comPort</code> setting (currently <code>' + esc(comPort) + '</code>)'
            : 'empty = the <code>avr.comPort</code> setting (not set — pick one with AVR: Select Port)';
    }

    // ── MCU dropdown overlay (varpicker-style, grouped by vendor) ──────────
    const boardMenu = document.createElement('div');
    boardMenu.className = 'varpicker';
    boardMenu.innerHTML =
        '<input class="vp-search" id="boardSearch" placeholder="Filter MCUs…  (Enter selects the first match · Esc closes)">' +
        '<div id="boardList" class="varlist"></div>' +
        '<div class="vp-detail"><span class="vd-txt" id="boardDetail">Click an MCU to select it as the project target.</span>' +
        '<button type="button" class="sec" id="vpQuick" title="Open the VS Code QuickPick — fuzzy over id, MCU, memory and protocol">QuickPick…</button></div>';
    document.body.appendChild(boardMenu);

    function showBoardDetail(b) {
        $('boardDetail').innerHTML = '<b>' + esc(b.name) + '</b> — <code>-mmcu=' + esc(b.mcu) + '</code> · ' +
            esc(b.vendor) + ' · flash ' + fmtKb(b.flash) + 'B · RAM ' + fmtKb(b.ram) + 'B · EEPROM ' + fmtKb(b.eeprom) +
            'B · ' + fmtMhz(b.f_cpu_hz) + (b.protocol ? ' · avrdude -c ' + esc(b.protocol) : '');
    }

    function buildBoardList(filter) {
        const list = $('boardList');
        list.innerHTML = '';
        const q = (filter || '').trim().toLowerCase();
        const cur = val('f_board').toLowerCase();
        const groups = new Map();
        for (const b of boards) {
            if (q && !(
                String(b.id).toLowerCase().includes(q) ||
                String(b.name).toLowerCase().includes(q) ||
                String(b.mcu).toLowerCase().includes(q) ||
                String(b.vendor || '').toLowerCase().includes(q))) continue;
            const g = b.vendor || 'Other';
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(b);
        }
        let first = null;
        for (const gname of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
            const gh = document.createElement('div');
            gh.className = 'vargroup';
            gh.textContent = gname + ' (' + groups.get(gname).length + ')';
            list.appendChild(gh);
            for (const b of groups.get(gname).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
                const row = document.createElement('div');
                row.className = 'varitem' + (String(b.id).toLowerCase() === cur ? ' cur' : '');
                const n = document.createElement('span');
                n.className = 'vn';
                n.textContent = b.name;
                const d = document.createElement('span');
                d.className = 'vd';
                d.textContent = String(b.id).toLowerCase() === cur
                    ? 'current'
                    : (b.id !== b.mcu ? b.id + ' · ' + b.mcu : b.mcu);
                row.appendChild(n);
                row.appendChild(d);
                row.addEventListener('click', () => pickBoardId(b.id));
                row.addEventListener('mouseover', () => showBoardDetail(b));
                list.appendChild(row);
                if (!first) first = row;
            }
        }
        if (!list.children.length) {
            const none = document.createElement('div');
            none.className = 'vargroup';
            none.textContent = 'No MCU matches "' + q + '" — clear the filter to see all ' + boards.length + '.';
            list.appendChild(none);
        }
        return first;
    }

    function pickBoardId(id) {
        $('f_board').value = id;
        updateBoardInfo();
        closeBoardMenu();
        $('f_board').focus();
    }

    function placeMenuUnder(menu, anchorEl) {
        const M = 12, GAP = 4;
        menu.style.maxHeight = '';   // v0.3.21: a stale cap from the last open skewed offsetHeight
        const anchor = anchorEl.getBoundingClientRect();
        const w = menu.offsetWidth || 380;
        const h = menu.offsetHeight || 300;
        let left = anchor.left;
        if (left + w > window.innerWidth - M) left = Math.max(M, window.innerWidth - M - w);
        const belowTop = anchor.bottom + GAP;
        let top = belowTop, cap = h;
        if (h > window.innerHeight - M - belowTop) {
            const spaceAbove = anchor.top - GAP - M;
            if (spaceAbove > window.innerHeight - M - belowTop) {
                top = Math.max(M, anchor.top - GAP - h);
                cap = spaceAbove;
            } else {
                cap = window.innerHeight - M - belowTop;
            }
        }
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        menu.style.maxHeight = cap + 'px';
    }

    function openBoardMenu() {
        buildBoardList('');
        boardMenu.style.display = 'flex';
        placeMenuUnder(boardMenu, $('f_board'));
        const inp = $('boardSearch');
        inp.value = '';
        inp.placeholder = 'Filter ' + boards.length + ' MCUs…  (Enter selects the first match · Esc closes)';
        inp.focus();
    }
    function closeBoardMenu() { boardMenu.style.display = 'none'; }

    $('boardBtn').addEventListener('click', e => {
        e.stopPropagation();
        if (boardMenu.style.display === 'flex') closeBoardMenu(); else openBoardMenu();
    });
    // the field is readonly, but keep the summary in sync with any value change
    $('f_board').addEventListener('input', updateBoardInfo);
    // clicking the readonly field itself toggles too
    $('f_board').addEventListener('click', () => {
        if (boardMenu.style.display === 'flex') closeBoardMenu(); else openBoardMenu();
    });
    $('boardSearch').addEventListener('input', e => buildBoardList(e.target.value));
    $('boardSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            const first = buildBoardList(e.target.value);
            if (first) first.click();
        } else if (e.key === 'Escape') {
            closeBoardMenu();
            $('f_board').focus();
        }
    });
    $('vpQuick').addEventListener('click', e => {
        e.stopPropagation();
        closeBoardMenu();
        vscode.postMessage({ type: 'pickBoard', current: val('f_board') });
    });
    document.addEventListener('click', e => {
        if (boardMenu.style.display !== 'flex') return;
        if (boardMenu.contains(e.target)) return;
        if (e.target === $('boardBtn') || e.target === $('f_board')) return;
        closeBoardMenu();
    }, true);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && boardMenu.style.display === 'flex') closeBoardMenu();
    });
    document.addEventListener('scroll', e => {
        if (boardMenu.style.display !== 'flex') return;
        if (e.target && boardMenu.contains(e.target)) return;   // scrolling the list itself
        closeBoardMenu();
    }, true);
    window.addEventListener('resize', () => closeBoardMenu());

    // ── \${…} variable picker (the sdcc-mdf design) ─────────────────────────
    // Only REAL avr-mdf variables are listed — everything here is expanded by
    // buildVars / expandOutPaths / the config & env resolvers at build, flash
    // and clean time; anything else stays literal.
    const VARS = [
    ['Project', [
     ['workspaceFolder','project root','Absolute path of the project folder.'],
     ['project.name','from config','The "name" field of avr-project.json; falls back to the folder name.'],
     ['project.root','project root','Same as workspaceFolder.'],
    ]],
    ['Outputs', [
     ['outputDir','build/ path','Absolute path of the output directory (after \${…} expansion).'],
     ['outputName','firmware name','Output name without extension (default: firmware).'],
     ['outputElf','.elf','Linked ELF — the debugger wants this one.'],
     ['outputHex','.hex','Intel HEX — what avrdude flashes.'],
     ['outputBin','.bin','Raw binary (avr-objcopy -O binary).'],
     ['outputEep','.eep','EEPROM image — non-empty only with EEMEM data.'],
     ['outputMap','.map','Linker map file.'],
    ]],
    ['Board', [
     ['board.id','board id','The board / MCU id from avr-project.json — e.g. uno, atmega328p.'],
     ['board.mcu','MCU id','build.mcu from the board definition — e.g. atmega328p.'],
     ['board.name','display name','Human-readable board name — e.g. Arduino Uno.'],
     ['board.fcpu','frequency','build.f_cpu from the board definition — e.g. 16000000UL.'],
     ['board.family','family','classic / tiny / mega0 / xmega / dx — dispatches fuse layouts.'],
     ['board.flash','flash bytes','Flash size of the selected MCU.'],
     ['board.ram','RAM bytes','SRAM size of the selected MCU.'],
     ['board.eeprom','EEPROM bytes','EEPROM size of the selected MCU.'],
     ['board.protocol','avrdude -c','Default programmer protocol of the board — e.g. arduino.'],
    ]],
    ['Build', [
     ['buildMode','release / debug','The avr.buildMode setting — debug compiles -Og -g + DEBUG.'],
     ['toolchain','avr-gcc / xc8','The project compiler — avr-gcc or xc8 (proj.toolchain).'],
    ]],
    ['Config & environment', [
     ['config:comPort','avr.comPort','Serial port selected via AVR: Select Port.'],
     ['config:buildMode','avr.buildMode','release / debug — pairs with build/\${config:buildMode} output dirs.'],
     ['config:SETTING','any setting','Any VS Code setting — short keys resolve in the avr.* namespace, full dotted ids work too. SETTING is selected after insert.',9,16],
     ['env:NAME','environment var','Any environment variable. NAME is selected after insert — just type over it. Unset variables stay literal.',6,10],
    ]],
    ];
    const VAR_TARGETS = ['f_outdir','f_outname','hook_pre_build','hook_post_link','hook_post_build','hook_pre_upload','hook_post_upload','f_tool','f_args'];
    let varTarget = null;
    const varCursor = {};
    for (const id of VAR_TARGETS) {
        const el = $(id);
        if (!el) continue;
        const upd = () => { varCursor[id] = [el.selectionStart, el.selectionEnd]; };
        el.addEventListener('keyup', upd);
        el.addEventListener('click', upd);
        el.addEventListener('select', upd);
        el.addEventListener('input', upd);
    }
    function buildVarList(filter) {
        const list = $('varList');
        list.innerHTML = '';
        const q = (filter || '').trim().toLowerCase();
        let first = null;
        for (const entry of VARS) {
            const items = entry[1].filter(it =>
                !q || it[0].toLowerCase().includes(q) || (it[1] || '').toLowerCase().includes(q));
            if (!items.length) continue;
            const g = document.createElement('div');
            g.className = 'vargroup';
            g.textContent = entry[0];
            list.appendChild(g);
            for (const it of items) {
                const row = document.createElement('div');
                row.className = 'varitem';
                const n = document.createElement('span');
                n.className = 'vn';
                n.textContent = '\${' + it[0] + '}';
                const d = document.createElement('span');
                d.className = 'vd';
                d.textContent = it[1] || '';
                row.appendChild(n); row.appendChild(d);
                row.addEventListener('click', () => insertVar(it[0], it[3], it[4]));
                row.addEventListener('mouseover', () => showVarDetail(it));
                list.appendChild(row);
                if (!first) first = row;
            }
        }
        if (!list.children.length) {
            const none = document.createElement('div');
            none.className = 'vargroup';
            none.textContent = 'No variables match the filter';
            list.appendChild(none);
        }
        return first;
    }
    function showVarDetail(it) {
        $('varDetailName').textContent = '\${' + it[0] + '}';
        $('varDetailText').textContent = it[2] || '';
    }
    // the \${…} menu opens to the LEFT of its button (the sdcc-mdf placement):
    // top-right of the menu aligns with the button's top-left, 8px gap; it
    // flips up / clamps into the viewport the same way the board menu does
    function placeMenuLeft(menu, anchorEl) {
        const M = 12, GAP_H = 8;
        menu.style.maxHeight = '';   // v0.3.21: a stale cap from the last open skewed offsetHeight
        const anchor = anchorEl.getBoundingClientRect();
        const w = menu.offsetWidth || 380;
        const h = menu.offsetHeight || 300;
        let left = anchor.left - w - GAP_H;
        if (left < M) left = Math.max(M, window.innerWidth - M - w);
        let top = anchor.top, cap;
        if (top + h > window.innerHeight - M) {
            top = Math.max(M, anchor.bottom - h);
            cap = window.innerHeight - M - top;
        } else {
            cap = window.innerHeight - M - top;
        }
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        menu.style.maxHeight = Math.max(180, cap) + 'px';
    }
    function openVarPicker(btn) {
        const p = $('varPicker');
        const target = btn.getAttribute('data-target');
        const wasOpen = getComputedStyle(p).display !== 'none';
        if (wasOpen && varTarget === target) { closeVarPicker(); return; }
        varTarget = target;
        buildVarList('');
        p.style.display = 'flex';
        placeMenuLeft(p, btn);
        const inp = $('varSearch');
        inp.value = '';
        inp.focus();
    }
    function closeVarPicker(refocus) {
        const p = $('varPicker');
        const wasOpen = getComputedStyle(p).display !== 'none';
        p.style.display = 'none';
        if (wasOpen && refocus !== false && varTarget) {
            const el = $(varTarget);
            if (el) el.focus();
        }
    }
    function insertVar(name, selA, selB) {
        const el = varTarget ? $(varTarget) : null;
        closeVarPicker(false);
        if (!el) return;
        const token = '\${' + name + '}';
        const pos = varCursor[varTarget];
        const s = pos ? pos[0] : el.value.length;
        const e = pos ? pos[1] : s;
        const st = el.scrollTop;
        el.value = el.value.slice(0, s) + token + el.value.slice(e);
        el.focus();
        let ns, ne;
        if (typeof selA === 'number' && typeof selB === 'number') {
            ns = s + selA; ne = s + selB;
        } else {
            ns = ne = s + token.length;
        }
        el.setSelectionRange(ns, ne);
        varCursor[varTarget] = [ns, ne];
        el.scrollTop = st;
        if (el.classList.contains('short') || VAR_TARGETS.includes(el.id)) el.dispatchEvent(new Event('input'));
    }
    $('varSearch').addEventListener('input', e => buildVarList(e.target.value));
    $('varSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            const first = buildVarList(e.target.value);
            if (first) first.click();
        }
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && getComputedStyle($('varPicker')).display !== 'none') closeVarPicker();
    });
    document.addEventListener('click', e => {
        const p = $('varPicker');
        if (getComputedStyle(p).display === 'none') return;
        if (p.contains(e.target)) return;
        if (e.target.closest && e.target.closest('.varbtn')) return;
        closeVarPicker(false);   // v0.3.21: no refocus — the user clicked elsewhere on purpose (the yank-back stole the click's focus)
    }, true);
    document.addEventListener('scroll', e => {
        const p = $('varPicker');
        if (getComputedStyle(p).display === 'none') return;
        if (e.target && e.target.contains && p.contains(e.target)) return;
        closeVarPicker(false);   // v0.3.21: no refocus on scroll-dismiss either
    }, true);
    window.addEventListener('resize', () => closeVarPicker(false));

    // ── Build mode segmented control (mirrors avr.buildMode both ways) ─────
    let buildMode = 'release';
    function setModeUI(m) {
        buildMode = (m === 'debug') ? 'debug' : 'release';
        $('modeRelease').classList.toggle('active', buildMode === 'release');
        $('modeDebug').classList.toggle('active', buildMode === 'debug');
        $('buildModeHint').innerHTML = (buildMode === 'debug')
            ? '<b>Debug</b> — <code>-Og -g</code> + <code>DEBUG</code> define (DWARF for simavr / avr-gdb). Applied immediately.'
            : '<b>Release</b> — size-optimized (<code>-Os</code> unless the Optimization field says otherwise). Applied immediately.';
    }
    $('modeRelease').addEventListener('click', () => { if (buildMode !== 'release') vscode.postMessage({ type: 'setBuildMode', mode: 'release' }); });
    $('modeDebug').addEventListener('click', () => { if (buildMode !== 'debug') vscode.postMessage({ type: 'setBuildMode', mode: 'debug' }); });


    // ── live validation under path-ish fields ───────────────────────────────
    function _fieldIssues(v, isName) {
        const s = String(v || '').trim();
        if (!s) return [];
        const out = [];
        let nonAscii = false;
        for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) > 127) { nonAscii = true; break; } }
        if (nonAscii) out.push('non-ASCII — build paths want ASCII');
        if (isName && /\\s/.test(s)) out.push('spaces — fine on disk, but quote them in hooks and custom tool args');
        const scan = s.replace(/^[A-Za-z]:[\\\\/]/, '');
        const bad = [];
        for (const ch of scan) { if ('<>:"|?*'.indexOf(ch) >= 0 || ch.charCodeAt(0) < 32) bad.push('"' + ch + '"'); }
        if (bad.length) out.push('invalid in Windows file names: ' + bad.join(' '));
        if (isName && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\.[^.]*)?$/i.test(scan)) out.push('reserved Windows device name');
        return out;
    }
    const _LIVE_FIELDS = [['f_name', true], ['f_outdir', false], ['f_outname', true]];
    function liveCheck(id, isName) {
        const el = $(id);
        if (!el) return;
        let box = el.nextElementSibling;
        if (!box || !box.classList || !box.classList.contains('flderr')) {
            box = document.createElement('div');
            box.className = 'flderr';
            el.insertAdjacentElement('afterend', box);
        }
        const issues = _fieldIssues(el.value, isName);
        box.textContent = issues.length ? '⚠ ' + issues.join(' · ') : '';
    }
    function liveCheckAll() { for (const p of _LIVE_FIELDS) liveCheck(p[0], p[1]); }
    for (const p of _LIVE_FIELDS) {
        const el = $(p[0]);
        if (el) el.addEventListener('input', () => liveCheck(p[0], p[1]));
    }

    // ── load: config → fields (defensive; failures disable Save) ───────────
    function loadProj() {
        if (!proj) return;
        $('f_name').value = typeof proj.name === 'string' ? proj.name : '';
        $('f_board').value = typeof proj.board === 'string' ? proj.board : '';
        setToolchainUI(proj.toolchain === 'xc8' ? 'xc8' : 'avr-gcc');
        $('f_sources').value = arr(proj.sources).map(lineOf).join('\\n');
        $('f_includes').value = arr(proj.includes).map(lineOf).join('\\n');
        $('f_libraries').value = arr(proj.libraries).map(lineOf).join('\\n');
        $('f_components').value = arr(proj.components).map(lineOf).join('\\n');
        $('f_defines').value = arr(proj.defines).map(lineOf).join('\\n');
        const b = (proj.build && typeof proj.build === 'object' && !Array.isArray(proj.build)) ? proj.build : {};
        $('f_outdir').value = typeof b.output_dir === 'string' ? b.output_dir : 'build';
        $('f_outname').value = typeof b.output_name === 'string' ? b.output_name : 'firmware';
        $('f_opt').value = typeof b.optimization === 'string' ? b.optimization.replace(/^-O/, '') : '';
        // v0.3.21: a non-canonical hand-edited value ('Os', 'O2', 'fast')
        // matched no <option> — the select went blank and a no-op Save
        // silently DELETED the key. A raw option keeps it visible and intact.
        {
            const opt = $('f_opt').value;
            if (opt && !['', 's', '0', '1', '2', '3', 'g'].includes(opt)) {
                const o = document.createElement('option');
                o.value = opt;
                o.textContent = 'raw: -O' + opt + ' (kept as-is)';
                $('f_opt').appendChild(o);
                $('f_opt').value = opt;
            }
        }
        $('f_gc').checked = b.gc_sections !== false;
        $('f_relax').checked = b.relax !== false;
        $('f_lto').checked = b.lto === true;
        $('f_cflags').value = arr(b.c_flags).map(lineOf).join('\\n');
        $('f_cxxflags').value = arr(b.cxx_flags).map(lineOf).join('\\n');
        $('f_asmflags').value = arr(b.asm_flags).map(lineOf).join('\\n');
        $('f_linkflags').value = arr(b.link_flags).map(lineOf).join('\\n');
        const hooks = (b.hooks && typeof b.hooks === 'object' && !Array.isArray(b.hooks)) ? b.hooks : {};
        // v0.3.20: five separate fields — a string is one command (the
        // pre-0.3.20 form), an array is one command per line
        for (const h of ['pre_build', 'post_link', 'post_build', 'pre_upload', 'post_upload']) {
            const hv = hooks[h];
            const lines = typeof hv === 'string' ? [hv]
                : (Array.isArray(hv) ? hv.filter(c => typeof c === 'string') : []);
            $('hook_' + h).value = lines.join('\\n');
        }
        const up = (proj.upload && typeof proj.upload === 'object' && !Array.isArray(proj.upload)) ? proj.upload : {};
        const prog = typeof up.programmer === 'string' ? up.programmer : '';
        const sel = $('f_protocol');
        sel.value = prog || '';
        if (prog && sel.value !== prog) {
            // a hand-written avrdude -c id that is not one of the recipes
            const o = document.createElement('option');
            o.value = prog;
            o.textContent = 'raw: ' + prog + ' (not a built-in recipe)';
            sel.appendChild(o);
            sel.value = prog;
        }
        $('f_port').value = typeof up.port === 'string' ? up.port : '';
        $('f_baud').value = (up.baud === undefined || up.baud === null) ? '' : String(up.baud);
        $('f_eeprom').checked = up.eeprom === true;
        $('f_tool').value = typeof up.tool === 'string' ? up.tool : '';
        $('f_args').value = arr(up.args).map(lineOf).join('\\n');
        const fu = (up.fuses && typeof up.fuses === 'object' && !Array.isArray(up.fuses)) ? up.fuses : {};
        for (const p of [['f_lfuse', 'lfuse'], ['f_hfuse', 'hfuse'], ['f_efuse', 'efuse']]) {
            const n = Number(fu[p[1]]);
            $(p[0]).value = (fu[p[1]] !== undefined && fu[p[1]] !== null && Number.isFinite(n))
                ? '0x' + n.toString(16).toUpperCase().padStart(2, '0') : '';
        }
        updateBoardInfo();
        updateProgHint();
        liveCheckAll();
    }

    // ── collect: the EXACT avr-project.json schema (build/flash/validator
    //    consumers depend on every key and conditional below) ───────────────
    function collect() {
        // v0.3.20: five separate hook fields — one line per command. A single
        // command keeps the historical STRING form (old configs stay
        // byte-identical); two or more commands save as an ARRAY.
        const hooks = {};
        for (const h of ['pre_build', 'post_link', 'post_build', 'pre_upload', 'post_upload']) {
            const items = $('hook_' + h).value.split('\\n').map(x => x.trim()).filter(Boolean);
            if (items.length === 1) hooks[h] = items[0];
            else if (items.length > 1) hooks[h] = items;
        }
        const fuses = {};
        for (const p of [['f_lfuse', 'lfuse'], ['f_hfuse', 'hfuse'], ['f_efuse', 'efuse']]) {
            const v = val(p[0]);
            if (v) {
                const n = parseInt(v.replace(/^0x/i, ''), 16);
                if (Number.isFinite(n)) fuses[p[1]] = n;
            }
        }
        const prog = val('f_protocol');
        const tool = val('f_tool');
        const args = flagList('f_args');
        return {
            name: val('f_name'),
            board: val('f_board'),
            toolchain: toolchain === 'xc8' ? 'xc8' : 'avr-gcc',
            sources: parseLinesJson('f_sources'),
            includes: parseLines('f_includes'),
            libraries: parseLinesJson('f_libraries'),
            components: parseLinesJson('f_components'),
            defines: lineList('f_defines'),
            build: {
                output_dir: val('f_outdir') || 'build',
                output_name: val('f_outname') || 'firmware',
                ...(val('f_opt') ? { optimization: val('f_opt') } : {}),
                gc_sections: $('f_gc').checked,
                relax: $('f_relax').checked,
                lto: $('f_lto').checked,
                ...(flagList('f_cflags').length ? { c_flags: flagList('f_cflags') } : {}),
                ...(flagList('f_cxxflags').length ? { cxx_flags: flagList('f_cxxflags') } : {}),
                ...(flagList('f_asmflags').length ? { asm_flags: flagList('f_asmflags') } : {}),
                ...(flagList('f_linkflags').length ? { link_flags: flagList('f_linkflags') } : {}),
                hooks: hooks,
            },
            upload: {
                ...(prog && prog !== 'custom' ? { programmer: prog } : {}),
                ...(val('f_port') ? { port: val('f_port') } : {}),
                ...(val('f_baud') ? { baud: parseInt(val('f_baud'), 10) || val('f_baud') } : {}),
                ...(tool ? { tool: tool, args: args } : (args.length ? { args: args } : {})),
                eeprom: $('f_eeprom').checked,
                ...(Object.keys(fuses).length ? { fuses: fuses } : {}),
            },
        };
    }

    function initAll() {
        buildProgrammerSelect();
        loadProj();
        updatePortHint();
    }

    // ── buttons ──────────────────────────────────────────────────────────────
    $('btnSave').addEventListener('click', () => {
        if (!initOk) return;      // never write a half-initialized form
        vscode.postMessage({ type: 'save', proj: collect() });
    });

    // ── host messages ───────────────────────────────────────────────────────
    window.addEventListener('message', e => {
        const m = e.data;
        if (!m || !m.type) return;
        if (m.type === 'state') {
            proj = (m.proj && typeof m.proj === 'object' && !Array.isArray(m.proj)) ? m.proj : null;
            boards = Array.isArray(m.boards) ? m.boards : [];
            recipes = Array.isArray(m.recipes) ? m.recipes : [];
            comPort = String(m.comPort || '');
            if (m.buildMode) setModeUI(m.buildMode);
            $('pFile').textContent = m.file || '';
            try {
                initAll();
                setSaveEnabled();
            } catch (err) {
                console.error('AVR project editor: init failed', err);
                setSaveDisabled('Initialization failed — saving is disabled to protect avr-project.json (see the console).');
                return;
            }
            if (!proj) setSaveDisabled('avr-project.json could not be read — saving is disabled to protect it.');
        } else if (m.type === 'board-picked') {
            if (m.id) {
                $('f_board').value = String(m.id);
                updateBoardInfo();
            }
        } else if (m.type === 'buildModeSet') {
            // the host confirms the setting write (or reports the live value
            // back when the status bar switched it elsewhere)
            setModeUI(m.mode);
        }
    });

    // ── tooltip edge clamping: pick the roomy side of the ⓘ badge, then
    //    keep the popover inside the viewport (inline left/top override both
    //    CSS anchors; reset on leave so CSS re-anchors next time) ──────────
    (function () {
        const M = 8, GAP = 7;   // GAP matches CSS left:20px on the 13px badge
        const clamp = tip => {
            const pop = tip.querySelector('.tip-pop');
            if (!pop) return;
            pop.style.left = '';
            pop.style.right = '';
            pop.style.top = '';
            const b = tip.getBoundingClientRect();
            const r = pop.getBoundingClientRect();
            const vw = document.documentElement.clientWidth;
            const vh = document.documentElement.clientHeight;
            const w = r.width, h = r.height;
            const onRight = r.left >= b.left;
            const roomR = vw - M - (b.right + GAP);
            const roomL = b.left - GAP - M;
            let left;
            if (onRight) {
                if (w <= roomR) left = b.right + GAP;
                else if (w <= roomL) left = b.left - GAP - w;
                else left = roomR >= roomL ? vw - M - w : M;
            } else {
                if (w <= roomL) left = b.left - GAP - w;
                else if (w <= roomR) left = b.right + GAP;
                else left = roomL >= roomR ? M : vw - M - w;
            }
            let top = r.top;
            if (top + h > vh - M) top = vh - M - h;
            if (top < M) top = M;
            pop.style.right = 'auto';
            pop.style.left = Math.round(left - b.left) + 'px';
            pop.style.top = Math.round(top - b.top) + 'px';
        };
        const release = tip => {
            const pop = tip.querySelector('.tip-pop');
            if (pop) { pop.style.left = ''; pop.style.right = ''; pop.style.top = ''; }
        };
        document.querySelectorAll('.tip').forEach(tip => {
            tip.addEventListener('mouseenter', () => clamp(tip));
            tip.addEventListener('focus', () => clamp(tip));
            tip.addEventListener('mouseleave', () => release(tip));
            tip.addEventListener('blur', () => release(tip));
        });
        window.addEventListener('resize', () => {
            document.querySelectorAll('.tip').forEach(tip => {
                const pop = tip.querySelector('.tip-pop');
                if (pop && getComputedStyle(pop).display !== 'none') clamp(tip);
            });
        });
    })();

    // the variable-insert buttons use inline onclick attributes — expose
    // the picker opener to the window scope (the script itself is an IIFE)
    window.openVarPicker = openVarPicker;

    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

module.exports = { openProjectEditor, notifyBuildModeChanged };
