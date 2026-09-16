'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// intellisense.js — .vscode/c_cpp_properties.json generator (cpptools):
//   avr-gcc projects: compilerPath = avr-gcc, compilerArgs = [-mmcu=<board>]
//   XC8 projects:     compilerPath = xc8-cc, compilerArgs = [-mcpu=<MPLAB name>]
//   → cpptools derives
//   __AVR_ATmega328P__, the built-in macros and the system include paths from
//   the REAL compiler. F_CPU and project defines ride along as defines; the
//   avr-libc include dir is added as a fallback includePath. Add-if-missing:
//   an existing "AVR" configuration is only patched when fields are absent.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Toolchain = require('./toolchain');
const Boards = require('./boards');
const Validator = require('./validator');
const { collectIncludes } = require('./sources');

const CONFIG_NAME = 'AVR';

function _cppFileFor(root) {
    const vsDir = path.join(root, '.vscode');
    return { vsDir, file: path.join(vsDir, 'c_cpp_properties.json') };
}
function _writeAtomic(file, text) {
    const tmp = file + '.avr-tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

async function cmdConfigureIntelliSense() {
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const isXc8 = proj.toolchain === 'xc8';
    const tc = isXc8 ? Toolchain.requireXc8() : Toolchain.requireGcc();
    if (!tc) return;
    const done = mergeConfig(root, proj, tc);
    if (done) vscode.window.showInformationMessage('AVR: IntelliSense configuration written (.vscode/c_cpp_properties.json).');
}

// the silent twin: add-if-missing, log-only failures
async function syncAfterProjectChange() {
    const root = H.getActiveRoot();
    if (!root) return;
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') return;
    if (!H.cfg('intellisense.autoConfig')) return;
    const tc = Toolchain.detect();
    const isXc8 = proj.toolchain === 'xc8';
    if (isXc8 ? !tc.xc8 : !tc.gcc) return;   // nothing to derive from — stay silent
    try { mergeConfig(root, proj, tc); } catch (e) { H.log(`[intellisense] sync failed: ${e.message}`); }
}

function mergeConfig(root, proj, tc) {
    const { vsDir, file } = _cppFileFor(root);
    try { fs.mkdirSync(vsDir, { recursive: true }); } catch {}

    let doc = null;
    if (fs.existsSync(file)) {
        // never write underneath unsaved edits
        for (const d of vscode.window.visibleTextEditors) {
            if (d.document.uri.fsPath === file && d.document.isDirty) {
                H.log('[intellisense] c_cpp_properties.json has unsaved edits — skipped');
                return false;
            }
        }
        const { ok, data, error } = H.readJsonFile(file);
        if (!ok) {
            H.log(`[intellisense] ${path.basename(file)} is not valid JSON (${error}) — left alone`);
            return false;
        }
        doc = data;
    }
    if (!doc || typeof doc !== 'object') doc = {};
    if (!Array.isArray(doc.configurations)) doc.configurations = [];

    const board = Boards.getBoard(proj.board);
    const mcu = board ? board.build.mcu : String(proj.board || '').toLowerCase();
    const isXc8 = proj.toolchain === 'xc8';
    // F_CPU on BOTH toolchains: <util/delay.h> reads it on avr-gcc AND on
    // XC8-for-AVR (User Guide §8.4.1 — same avr-libc mechanism).
    // v0.3.16: a fallback for boards without f_cpu (the old code wrote
    // F_CPU=undefined into c_cpp_properties.json)
    const fcpuGcc = board ? (board.build.f_cpu || '1000000UL') : '1000000UL';
    const defines = [`F_CPU=${board ? (isXc8 ? (board.build.f_cpu_hz || 1000000) : fcpuGcc) : (isXc8 ? 1000000 : '1000000UL')}${isXc8 ? 'UL' : ''}`];
    for (const d of (proj.defines || [])) {
        defines.push(String(typeof d === 'string' ? d : (d && d.name) || ''));
    }

    const includePath = [...collectIncludes(root, proj).map(p => _fwd(p))];
    if (isXc8) {
        for (const inc of (tc.xc8IncludeDirs || [])) includePath.push(_fwd(inc));
    } else if (tc.includeDir) {
        includePath.push(_fwd(tc.includeDir));
    }
    includePath.push('${workspaceFolder}/**');

    const entry = {
        name: CONFIG_NAME,
        compilerPath: _fwd(isXc8 ? tc.xc8 : tc.gcc),
        compilerArgs: isXc8 ? [`-mcpu=${Toolchain.xc8McuName(mcu)}`] : [`-mmcu=${mcu}`],
        defines: defines.filter(Boolean),
        includePath,
        cStandard: 'c11',
        cppStandard: 'c++17',
        intelliSenseMode: 'gcc-x86',
    };

    const existing = doc.configurations.find(c => c && c.name === CONFIG_NAME);
    if (existing) {
        // patch only absent fields — the user's own edits win
        let touched = false;
        for (const k of ['compilerPath', 'compilerArgs', 'defines', 'includePath', 'cStandard', 'cppStandard', 'intelliSenseMode']) {
            if (existing[k] === undefined) { existing[k] = entry[k]; touched = true; }
        }
        if (!touched) { H.log('[intellisense] AVR configuration already present'); return false; }
    } else {
        doc.configurations.push(entry);
    }
    doc.version = 4;

    _writeAtomic(file, JSON.stringify(doc, null, 2) + '\n');
    H.log(`[intellisense] ${path.basename(file)} written (compilerPath: ${entry.compilerPath}, ${isXc8 ? '-mcpu=' + Toolchain.xc8McuName(mcu) : '-mmcu=' + mcu})`);
    return true;
}
function _fwd(p) { return String(p).replace(/\\/g, '/'); }

module.exports = { cmdConfigureIntelliSense, syncAfterProjectChange };
