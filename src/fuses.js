'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// fuses.js — the Fuse Editor (webview panel): bit-level lfuse/hfuse/efuse
// editing from fusesData.js (17 verified classic MCUs), presets, hex mode for
// everything else (modern UPDI fuse0..8, xmega), read & write via avrdude.
// SAFETY: a big red banner, SPIEN/RSTDISBL/DWEN descriptions that warn, and a
// modal confirmation listing the exact bytes before anything is written.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const cp     = require('child_process');
const H      = require('./helpers');
const Toolchain = require('./toolchain');
const Boards = require('./boards');
const Validator = require('./validator');
const FUSES  = require('./fusesData');
const { avrdudeArgv } = require('./flash');

let _panel = null;
// v0.3.16: the CURRENT {mcu, family, proj} — the old code closed over the
// FIRST open's values, so after a re-open with a different board every
// read/write message dispatched with the STALE family (UI showed fuse0…5,
// avrdude still read lfuse/hfuse/efuse) and a stale project snapshot.
let _state = null;

// ─── Open the editor ─────────────────────────────────────────────────────────
async function openEditor() {
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const board = Boards.getBoard(proj.board);
    const mcu = board ? board.build.mcu : String(proj.board || '').toLowerCase();
    const family = board ? (board.build.family || 'classic') : 'classic';

    if (_panel) { _panel.reveal(); _pushState(mcu, family, proj); return; }
    _panel = vscode.window.createWebviewPanel(
        'avr.fusesEditor', `Fuses — ${mcu}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    _panel.onDidDispose(() => { _panel = null; _state = null; });
    _panel.webview.onDidReceiveMessage(onMessage);
    _pushState(mcu, family, proj);
}
function _pushState(mcu, family, proj) {
    _state = { mcu, family, proj };
    if (_panel) { _render(mcu, family, proj); }
}

function onMessage(m) {
    if (!m || !m.type || !_state) return;
    const { family, proj } = _state;
    switch (m.type) {
        case 'write': cmdWrite(family, m.values, proj); break;
        case 'read': cmdRead(family, proj); break;
        case 'copy': vscode.env.clipboard.writeText(String(m.cmd || '')); break;
    }
}

// ─── Render ──────────────────────────────────────────────────────────────────
function _esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function _render(mcu, family, proj) {
    const classic = FUSES.CLASSIC[mcu] || null;
    const modern = family === 'modern';
    const xmega = family === 'xmega';
    const lock = FUSES.LOCK;

    const projFuses = (proj.upload && proj.upload.fuses) || {};

    let body = '';
    if (classic) {
        body = classicEditorHtml(classic, mcu, projFuses);
    } else if (modern) {
        body = modernEditorHtml(projFuses);
    } else if (xmega) {
        body = xmegaEditorHtml();
    } else {
        body = genericHexEditorHtml(mcu);
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           padding: 14px 18px; margin: 0; font-size: var(--vscode-font-size); }
    h1 { font-size: 16px; margin: 0 0 2px; }
    h2 { font-size: 13px; margin: 20px 0 6px; opacity: .85; }
    .sub { opacity: .65; margin-bottom: 10px; }
    .warn { background: rgba(248,81,73,.12); border: 1px solid rgba(248,81,73,.5);
            border-radius: 4px; padding: 8px 10px; margin: 10px 0; font-size: 12px; }
    .byte { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3));
            border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
    .bytehead { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
    .bytenname { font-weight: 600; }
    input.hexpad { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4)); border-radius: 4px;
            padding: 2px 6px; width: 84px; font-family: var(--vscode-editor-font-family, monospace);
            font-size: 13px; }
    .bits { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 6px; }
    .bit { display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
    .bit input { margin: 0; }
    .bit .bname { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    .bit .desc { opacity: .6; font-size: 11px; max-width: 300px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
             border: none; border-radius: 4px; padding: 5px 14px; cursor: pointer; font: inherit; }
    button.sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.danger { background: #b8232a; color: #fff; }
    button:hover { filter: brightness(1.12); }
    .actions { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; }
    .preset { display: inline-block; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3));
              border-radius: 4px; padding: 3px 10px; margin: 2px 6px 2px 0; cursor: pointer; }
    .preset:hover { background: var(--vscode-list-hoverBackground); }
    .cmd { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
           opacity: .8; word-break: break-all; margin-top: 8px; }
    .muted { opacity: .6; }
    table { border-collapse: collapse; }
    td { padding: 2px 10px 2px 0; }
</style>
</head>
<body>
<h1>Fuse bits — ${_esc(mcu)}</h1>
<div class="sub">${_esc(mcu)} · ${family === 'modern' ? 'UPDI (fuse0…fuse8)' : family === 'xmega' ? 'ATxmega (PDI)' : 'classic ISP (lfuse/hfuse/efuse/lock)'}</div>
<div class="warn">⚠ <b>Fuse errors can lock you out of the chip.</b> SPIEN=1, RSTDISBL=0 or DWEN=0 on an ISP-only setup bricks normal programming (HV/parallel or debugWIRE recovery needed). Values are ACTIVE-LOW: most bits are ON when <b>0</b>; the factory state is 1 (0xFF). Verify against the datasheet before writing.</div>
${body}
<div class="actions">
    <button class="sec" id="btnRead">⟳ Read from chip</button>
    <button class="danger" id="btnWrite">⇧ Write to chip…</button>
    <button class="sec" id="btnCopy">⧉ Copy avrdude command</button>
</div>
<div class="muted" style="font-size:12px">${_esc(lock.note)}</div>
<div id="status" class="cmd"></div>
<script>
(function () {
    const vscode = acquireVsCodeApi();
    function byteVal(elId) {
        const el = document.getElementById(elId);
        if (!el) return null;
        const v = parseInt(el.value.replace(/^0x/i, ''), 16);
        return isNaN(v) ? null : (v & 0xFF);
    }
    function bitSet(byteId, bit) {
        const el = document.getElementById(byteId + '_b' + bit);
        return el ? el.checked : false;
    }
    function recompute(byteId) {
        // checkbox → hex field
        let v = 0;
        for (let b = 0; b < 8; b++) if (bitSet(byteId, b)) v |= (1 << b);
        const hexEl = document.getElementById(byteId);
        if (hexEl) hexEl.value = '0x' + v.toString(16).toUpperCase().padStart(2, '0');
        syncCmd();
    }
    function applyHex(byteId) {
        const v = byteVal(byteId);
        if (v === null) return;
        for (let b = 0; b < 8; b++) {
            const el = document.getElementById(byteId + '_b' + b);
            if (el) el.checked = !!((v >> b) & 1);
        }
        syncCmd();
    }
    document.addEventListener('input', (e) => {
        if (e.target.classList && e.target.classList.contains('hexpad')) applyHex(e.target.id);
    });
    document.addEventListener('change', (e) => {
        if (e.target.dataset && e.target.dataset.byte) recompute(e.target.dataset.byte);
    });
    // presets
    document.querySelectorAll('.preset').forEach(p => p.addEventListener('click', () => {
        const data = JSON.parse(p.dataset.values || '{}');
        for (const [k, v] of Object.entries(data)) {
            if (v === null || v === undefined) continue;
            const el = document.getElementById(k);
            if (el) {
                el.value = '0x' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
                applyHex(k);
            }
        }
    }));
    function collectValues() {
        const out = {};
        document.querySelectorAll('input.hexpad').forEach(el => { out[el.id] = byteVal(el.id); });
        return out;
    }
    let lastCmd = '';
    function syncCmd() {
        const vals = collectValues();
        const parts = [];
        for (const [k, v] of Object.entries(vals)) {
            if (v === null || v === undefined) continue;
            parts.push('-U ' + k + ':w:0x' + v.toString(16).toUpperCase().padStart(2, '0') + ':m');
        }
        lastCmd = 'avrdude … ' + parts.join(' ');
        const cmdEl = document.getElementById('cmdpreview');
        if (cmdEl) cmdEl.textContent = lastCmd;
    }
    document.getElementById('btnRead').addEventListener('click', () => vscode.postMessage({ type: 'read' }));
    document.getElementById('btnWrite').addEventListener('click', () => vscode.postMessage({ type: 'write', values: collectValues() }));
    document.getElementById('btnCopy').addEventListener('click', () => vscode.postMessage({ type: 'copy', cmd: lastCmd }));
    syncCmd();
    window.addEventListener('message', (e) => {
        const m = e.data;
        if (!m || !m.type) return;
        if (m.type === 'read-result') {
            const st = document.getElementById('status');
            for (const [k, v] of Object.entries(m.values || {})) {
                const el = document.getElementById(k);
                if (el && v !== null && v !== undefined) {
                    el.value = '0x' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
                    applyHex(k);
                }
            }
            if (st) st.textContent = m.text || '';
        } else if (m.type === 'status') {
            const st = document.getElementById('status');
            if (st) st.textContent = m.text || '';
        }
    });
})();
</script>
</body>
</html>`;
    try { _panel.webview.html = html; } catch {}
}

// ─── Editors per family ──────────────────────────────────────────────────────
function _byteBlock(id, label, def, bits, note) {
    const hex = def === null || def === undefined ? '' : '0x' + (def & 0xFF).toString(16).toUpperCase().padStart(2, '0');
    const bitBoxes = (bits || []).map(b => `
        <label class="bit" title="${_esc(b.desc || '')}">
            <input type="checkbox" id="${id}_b${b.bit}" data-byte="${id}" ${((def >> b.bit) & 1) ? 'checked' : ''}>
            <span><span class="bname">${_esc(b.name)}</span><span class="muted">:${b.bit}</span>
            <div class="desc">${_esc(b.desc || '')}</div></span>
        </label>`).join('\n');
    return `
    <div class="byte" id="blk_${id}">
        <div class="bytehead">
            <span class="bytenname">${_esc(label)}</span>
            <input class="hexpad" id="${id}" value="${hex}" placeholder="0x–">
            ${note ? `<span class="muted" style="font-size:12px">${_esc(note)}</span>` : ''}
        </div>
        <div class="bits">${bitBoxes}</div>
    </div>`;
}

function classicEditorHtml(c, mcu, projFuses) {
    const defs = c.defaults || {};
    const lf = projFuses.lfuse !== undefined ? projFuses.lfuse : defs.lfuse;
    const hf = projFuses.hfuse !== undefined ? projFuses.hfuse : defs.hfuse;
    const ef = projFuses.efuse !== undefined ? projFuses.efuse : defs.efuse;
    let out = '';
    out += _byteBlock('lfuse', 'lfuse (low)', lf, c.lfuse && c.lfuse.bits);
    out += _byteBlock('hfuse', 'hfuse (high)', hf, c.hfuse && c.hfuse.bits, c.hfuse ? '' : 'bit layout not verified — hex mode');
    if (c.efuse || ef !== null && ef !== undefined) {
        out += _byteBlock('efuse', 'efuse (extended)', ef, c.efuse && c.efuse.bits, c.efuse ? '' : 'no efuse on this device');
    }
    out += _byteBlock('lock', 'lock bits', defs.lock !== undefined ? defs.lock : 0x3F, c.lock && c.lock.bits, 'writing lock bits can be PERMANENT');
    if (c.presets && c.presets.length) {
        out += `<h2>Presets</h2>`;
        for (const p of c.presets) {
            const vals = JSON.stringify({ lfuse: p.lfuse, hfuse: p.hfuse, efuse: p.efuse });
            out += `<span class="preset" data-values="${_esc(vals)}" title="${_esc(vals)}">${_esc(p.name)}</span>`;
        }
    }
    if (c.cksel && c.cksel.length) {
        out += `<h2>CKSEL clock table</h2><table>`;
        for (const row of c.cksel) {
            out += `<tr><td><code>0b${row.value.toString(2).padStart(4, '0')}</code></td><td>${_esc(row.desc)}</td></tr>`;
        }
        out += `</table>`;
    }
    if (c.note) out += `<p class="muted" style="font-size:12px">${_esc(c.note)}</p>`;
    out += `<div class="cmd" id="cmdpreview"></div>`;
    return out;
}

function modernEditorHtml(projFuses) {
    const M = FUSES.MODERN;
    let out = `<div class="sub">${_esc(M.note)}</div>`;
    const defs = Object.assign({}, M.defaults, projFuses);
    for (const [k, f] of Object.entries(M.fuses)) {
        const def = defs[k];
        out += `
        <div class="byte">
            <div class="bytehead">
                <span class="bytenname">${_esc(k)} — ${_esc(f.name)}</span>
                <input class="hexpad" id="${_esc(k)}" value="${def === null || def === undefined ? '' : '0x' + (def & 0xFF).toString(16).toUpperCase().padStart(2, '0')}" placeholder="0x–">
            </div>
            <div class="muted" style="font-size:12px">${_esc(f.desc)}</div>
        </div>`;
    }
    out += `<div class="cmd" id="cmdpreview"></div>`;
    return out;
}
function xmegaEditorHtml() {
    return `<div class="sub">${_esc(FUSES.XMEGA.note)}</div>
    ${_byteBlock('fuse0', 'fuse0', null, [])}
    ${_byteBlock('fuse1', 'fuse1', null, [])}
    ${_byteBlock('fuse2', 'fuse2', null, [])}
    ${_byteBlock('fuse4', 'fuse4', null, [])}
    ${_byteBlock('fuse5', 'fuse5', null, [])}
    <div class="cmd" id="cmdpreview"></div>`;
}
function genericHexEditorHtml(mcu) {
    return `<div class="sub">The bit layout for ${_esc(mcu)} is not in the verified database — edit raw hex values and double-check them against the datasheet.</div>
    ${_byteBlock('lfuse', 'lfuse', null, [])}
    ${_byteBlock('hfuse', 'hfuse', null, [])}
    ${_byteBlock('efuse', 'efuse', null, [])}
    ${_byteBlock('lock', 'lock', null, [], 'writing lock bits can be PERMANENT')}
    <div class="cmd" id="cmdpreview"></div>`;
}

// ─── Read / write via avrdude ────────────────────────────────────────────────
function _post(text, values) {
    if (_panel) {
        _panel.webview.postMessage({ type: 'read-result', text, values: values || {} });
    }
}
function _status(text) {
    if (_panel) _panel.webview.postMessage({ type: 'status', text });
}

async function cmdRead(family, proj) {
    const tc = Toolchain.requireAvrdude();
    if (!tc) return;
    const board = Boards.getBoard(proj.board);
    // v0.3.16: xmega rides the fuse0…fuse5 memories too (the old code dropped
    // it into the classic lfuse/hfuse/efuse branch — reads queried
    // non-existent memories)
    const mems = (family === 'modern' || family === 'xmega')
        ? ['fuse0', 'fuse1', 'fuse2', 'fuse4', 'fuse5']
        : ['lfuse', 'hfuse', 'efuse'];
    // read one by one hidden (execFile), format h → "0xNN"
    const values = {};
    for (const mem of mems) {
        const built = avrdudeArgv({ proj, board, tc, op: { us: [`${mem}:r:-:h`] } });
        if (built.error) { _status(`✖ ${built.error}`); return; }
        const r = cp.spawnSync(built.exe, built.argv, { timeout: 20000, encoding: 'utf8', windowHide: true, cwd: H.getActiveRoot() || undefined });
        const out = String(r.stdout || '');
        const m = /0x([0-9A-Fa-f]{2})/.exec(out);
        if (m) values[mem] = parseInt(m[1], 16);
    }
    if (!Object.keys(values).length) {
        _status('✖ read failed — avrdude reported nothing (check the programmer/port; avrdude output went to the AVR terminal)');
        // also show what happened in the terminal for the user
        const built = avrdudeArgv({ proj, board, tc, op: { us: [`${mems[0]}:r:-:h`] } });
        if (!built.error) H.getTerm('AVR').sendText([H.q(built.exe), ...built.argv.map(a => (/[^\w:,=+.\-\/\\]/.test(a) ? H.q(a) : a))].join(' '), true);
        return;
    }
    _post(`✔ read: ${Object.entries(values).map(([k, v]) => `${k}=0x${v.toString(16).toUpperCase().padStart(2, '0')}`).join(' ')}`, values);
}

async function cmdWrite(family, values, proj) {
    const tc = Toolchain.requireAvrdude();
    if (!tc) return;
    const us = [];
    const list = [];
    // v0.3.16: xmega = UPDI-like fuse0…fuse5 (the old `family !== 'modern'`
    // filter rejected every xmega memory the editor renders — "no fuse values
    // to write" every time)
    const updiLike = (family === 'modern' || family === 'xmega');
    for (const [mem, v] of Object.entries(values || {})) {
        if (v === null || v === undefined) continue;
        if (updiLike && !/^fuse\d+$/.test(mem)) continue;
        if (!updiLike && !['lfuse', 'hfuse', 'efuse', 'lock'].includes(mem)) continue;
        us.push(`${mem}:w:0x${(v & 0xFF).toString(16).padStart(2, '0')}:m`);
        list.push(`${mem} = 0x${(v & 0xFF).toString(16).toUpperCase().padStart(2, '0')}`);
    }
    if (!us.length) { vscode.window.showWarningMessage('AVR: no fuse values to write.'); return; }
    const danger = /lock/.test(us.join(' ')) || 'hfuse' in values;
    const ok = await vscode.window.showWarningMessage(
        `Write fuses to the chip? ${list.join(', ')}${danger ? '\n\n⚠ High-fuse / lock mistakes can PERMANENTLY lock the device. Triple-check SPIEN/RSTDISBL/DWEN.' : ''}`,
        { modal: true }, 'Write fuses'
    );
    if (ok !== 'Write fuses') return;

    const board = Boards.getBoard(proj.board);
    const built = avrdudeArgv({ proj, board, tc, op: { us } });
    if (built.error) { vscode.window.showErrorMessage(`AVR: ${built.error}`); return; }
    H.setBusy('Write fuses');
    try {
        const line = [H.q(built.exe), ...built.argv.map(a => (/[^\w:,=+.\-\/\\]/.test(a) ? H.q(a) : a))].join(' ');
        const ec = await H.runInTerminal('AVR', [line]);
        if (ec === 0) {
            _status(`✔ written: ${list.join(' ')}`);
            vscode.window.showInformationMessage(`AVR: fuses written (${list.join(', ')}).`);
        } else if (ec === -1) {
            // v0.3.12: the flash.js distinction — no exit code seen at all
            // (terminal closed / 30-min marker timeout), not a tool failure
            _status('✖ write interrupted (no exit code seen) — see the AVR terminal');
            vscode.window.showWarningMessage('AVR: fuse write interrupted (no exit code seen — terminal closed or timed out).');
        } else {
            _status(`✖ avrdude failed (exit ${ec}) — see the AVR terminal`);
            vscode.window.showErrorMessage(`AVR: fuse write failed (exit ${ec}).`);
        }
    } finally {
        H.clearBusy();
    }
}

async function cmdOpen() { await openEditor(); }

// v0.3.12 (222.jpg): the palette commands cmdReadPalette / cmdWritePalette
// are REMOVED together with their avr.fuses.read / avr.fuses.write palette
// entries — duplicates of this very page's ⟳ Read / ⇧ Write buttons. The
// webview path (onMessage → cmdRead / cmdWrite below) is the single way.

module.exports = { cmdOpen };
