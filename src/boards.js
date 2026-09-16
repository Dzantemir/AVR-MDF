'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// boards.js — the MCU database (Arduino/PlatformIO-style board JSON files).
// Priority: project .avr/boards/ → avr.boardsDir → ~/.avr-mdf/boards →
// the built-in boards/ shipped with the extension. Also: the board picker,
// the per-family main.c templates and the build-flag resolution.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const H      = require('./helpers');

const BUILTIN_DIR = path.join(path.dirname(__dirname), 'boards');
const GLOBAL_DIR  = path.join(os.homedir(), '.avr-mdf', 'boards');

// v0.3.3 rename migration: the extension changed its id avr-gcc-mdf → avr-mdf,
// so the global boards home moves ~/.avr-gcc-mdf/boards → ~/.avr-mdf/boards.
// The old folder is COPIED once (never deleted) so nothing is ever lost.
function migrateRenamedGlobalBoards() {
    try {
        const oldDir = path.join(os.homedir(), '.avr-gcc-mdf', 'boards');
        if (!fs.existsSync(oldDir) || fs.existsSync(GLOBAL_DIR)) return;
        fs.mkdirSync(GLOBAL_DIR, { recursive: true });
        for (const entry of fs.readdirSync(oldDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
            const dst = path.join(GLOBAL_DIR, entry.name);
            if (!fs.existsSync(dst)) fs.copyFileSync(path.join(oldDir, entry.name), dst);
        }
        H.log(`[boards] migrated ~/.avr-gcc-mdf/boards → ${GLOBAL_DIR} (rename)`);
    } catch (e) {
        H.log(`[boards] rename migration skipped: ${e.message}`);
    }
}

// One-time migration: user boards used to live in VS Code globalStorage which
// is wiped on every VSIX update — ~/.avr-gcc-mdf/boards survives everything.
function migrateLegacyBoards() {
    migrateRenamedGlobalBoards();   // v0.3.3: ~/.avr-gcc-mdf/boards → ~/.avr-mdf/boards first
    try {
        const legacy = path.join(H.getCtx().globalStorageUri.fsPath, 'boards');
        if (!fs.existsSync(legacy)) return;
        fs.mkdirSync(GLOBAL_DIR, { recursive: true });
        for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            const src = path.join(legacy, entry.name);
            const dst = path.join(GLOBAL_DIR, entry.name);
            if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
        }
        H.log(`[boards] migrated legacy user boards → ${GLOBAL_DIR}`);
    } catch (e) {
        H.log(`[boards] legacy migration skipped: ${e.message}`);
    }
}

// ─── Loading ─────────────────────────────────────────────────────────────────
function _scanDir(dir, out, origin) {
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) { _scanDir(path.join(dir, entry.name), out, origin); continue; }
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
            if (entry.name === 'boards-index.json') continue;
            const id = entry.name.replace(/\.json$/i, '');
            const full = path.join(dir, entry.name);
            const { ok, data, error } = H.readJsonFile(full);
            if (!ok || !data || !data.build || !data.build.mcu) {
                H.log(`[boards] skipped ${full}: ${error || 'no build.mcu'}`);
                continue;
            }
            // board id = filename; vendor subfolder is kept for grouping only
            out.set(id, Object.assign({}, data, { id, _path: full, _origin: origin }));
        }
    } catch {}
}

function loadBoards() {
    const cached = H.getBoardCache();
    if (cached && cached.stamp === _stamp()) return cached.map;

    const map = new Map();
    // priority: LOWEST first → later overwrite
    _scanDir(BUILTIN_DIR, map, 'builtin');
    try { fs.mkdirSync(GLOBAL_DIR, { recursive: true }); _scanDir(GLOBAL_DIR, map, 'global'); } catch {}
    const extra = String(H.cfg('boardsDir') || '');
    if (extra && fs.existsSync(extra)) _scanDir(extra, map, 'dir');
    const root = H.getActiveRoot();
    if (root) _scanDir(path.join(root, '.avr', 'boards'), map, 'project');

    H.setBoardCache({ stamp: _stamp(), map });
    return map;
}
function invalidate() { H.setBoardCache(null); }
let _stampCache = null;
function _stamp() {
    if (_stampCache) return _stampCache;
    _stampCache = JSON.stringify([H.cfg('boardsDir'), H.getActiveRoot()]);
    setTimeout(() => { _stampCache = null; }, 0).unref?.();
    return _stampCache;
}

function getBoard(id) {
    if (!id) return null;
    const map = loadBoards();
    if (map.has(id)) return map.get(id);
    // fallback: id may be a raw mcu name
    for (const b of map.values()) if (b.build.mcu === String(id).toLowerCase()) return b;
    return null;
}
function allBoards() { return [...loadBoards().values()]; }

// ─── Build flags ─────────────────────────────────────────────────────────────
// Everything the compiler/linker needs for the target comes from the board:
//   -mmcu=<mcu> -DF_CPU=<f_cpu> [-D<extra_flags>]
function buildFlags(board) {
    const out = [`-mmcu=${board.build.mcu}`];
    const fcpu = board.build.f_cpu || '1000000UL';
    out.push(`-DF_CPU=${fcpu}`);
    for (const f of (board.build.extra_flags || [])) out.push(f);
    return out;
}

// ─── The board picker (grouped by vendor, searchable) ────────────────────────
async function selectBoard(currentId, { placeHolder } = {}) {
    const map = loadBoards();
    const groups = new Map();
    for (const b of map.values()) {
        const g = b.vendor || 'Other';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(b);
    }
    const items = [];
    for (const [vendor, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        items.push({ label: vendor, kind: vscode.QuickPickItemKind.Separator });
        for (const b of list.sort((a, b) => a.name.localeCompare(b.name))) {
            const fam = b.build.family || 'classic';
            const famLabel = fam === 'modern' ? 'UPDI' : fam === 'xmega' ? 'xmega' : '';
            // v0.3.16: defensive — a minimal/hand-written board JSON without
            // build.memory/f_cpu_hz used to crash the whole picker
            const mem = b.build.memory || {};
            const flash = mem.flash || 0, ram = mem.ram || 0, eeprom = mem.eeprom || 0;
            const fcpuHz = b.build.f_cpu_hz || 0;
            items.push({
                label: (b.id === currentId ? '$(check) ' : '') + b.name,
                description: `${b.id}${famLabel ? ' · ' + famLabel : ''}`,
                detail: `${b.build.mcu} · flash ${(flash / 1024).toFixed(flash % 1024 ? 1 : 0)}K` +
                    ` · RAM ${ram}B · EEPROM ${eeprom}B` +
                    (fcpuHz ? ` · ${(fcpuHz / 1e6).toFixed(fcpuHz % 1e6 ? 1 : 0)} MHz` : '') +
                    (b.upload && b.upload.protocol ? ` · avrdude -c ${b.upload.protocol}` : ''),
                board: b,
            });
        }
    }
    const pick = await vscode.window.showQuickPick(items, {
        matchOnDescription: true, matchOnDetail: true,
        placeHolder: placeHolder || 'Select the target board / MCU',
    });
    return pick && pick.board ? pick.board.id : null;
}

// ─── main.c templates (family-aware: classic vs modern vs xmega registers;
//     toolchain-aware: avr-gcc/avr-libc vs Microchip XC8 dialects) ──────────
function mainTemplate(board, toolchain) {
    if (toolchain === 'xc8') return mainTemplateXc8(board);
    return mainTemplateGcc(board);
}

function mainTemplateGcc(board) {
    const fam = board.build.family || 'classic';
    const fcpu = board.build.f_cpu || '1000000UL';
    const name = board.name || board.build.mcu;
    if (fam === 'modern') {
        // tinyAVR-0/1/2, megaAVR-0/1: PORTx.DIRSET / PORTx.OUT
        return `/*
 * ${name} — bare-metal blink (modern UPDI family)
 * Edit avr-project.json for build options.
 * F_CPU is defined by the build (-DF_CPU=${fcpu}); _delay_ms needs it.
 */
#include <avr/io.h>
#include <util/delay.h>

/* On the 0/1-series the port direction is set through the PORT structure. */
#define LED_PORT   PORTA
#define LED_bm     PIN5_bm      /* adjust the pin to your wiring */

int main(void)
{
    LED_PORT.DIRSET = LED_bm;   /* output */

    for (;;)
    {
        LED_PORT.OUTTGL = LED_bm;   /* toggle */
        _delay_ms(500);
    }
}
`;
    }
    if (fam === 'xmega') {
        return `/*
 * ${name} — bare-metal blink (ATxmega)
 * F_CPU is defined by the build (-DF_CPU=${fcpu}).
 */
#include <avr/io.h>
#include <util/delay.h>

#define LED_PORT   PORTA
#define LED_PIN    PIN0_bm

int main(void)
{
    LED_PORT.DIRSET = LED_PIN;      /* output */

    for (;;)
    {
        LED_PORT.OUTTGL = LED_PIN;  /* toggle */
        _delay_ms(500);
    }
}
`;
    }
    // classic: PORTx / DDRx / PINx
    const led = board.led || null;
    const port = led ? `PORT${led.port}` : 'PORTB';
    const ddr  = led ? `DDR${led.port}` : 'DDRB';
    const bit  = led ? led.bit : 5;
    return `/*
 * ${name} — bare-metal blink (classic AVR)
 * F_CPU is defined by the build (-DF_CPU=${fcpu}); _delay_ms needs it.
 */
#include <avr/io.h>
#include <util/delay.h>

#define LED      ${port}            /* onboard LED port (adjust freely)  */
#define LED_DDR  ${ddr}             /* its data-direction register      */
#define LED_BIT  _BV(${bit})         /* ${led ? 'board LED pin' : 'pick any pin'}                 */

int main(void)
{
    LED_DDR |= LED_BIT;          /* output */

    for (;;)
    {
        LED |= LED_BIT;          /* on  */
        _delay_ms(500);
        LED &= ~LED_BIT;         /* off */
        _delay_ms(500);
    }
}
`;
}

// ─── XC8 blink templates (xc.h + F_CPU + util/delay.h) ───────────────────
// v0.3.10, per the XC8-for-AVR User Guide: <xc.h> is the recommended
// top-level header (it includes <avr/io.h>, Migration Guide §4.1); delays
// are _delay_ms()/_delay_us() from <util/delay.h> driven by F_CPU (§8.4.1 —
// "The macro F_CPU should be defined…"). _XTAL_FREQ/__delay_ms are PIC-only
// XC8 constructs that DO NOT exist on the AVR target.
function mainTemplateXc8(board) {
    const fam = board.build.family || 'classic';
    const fcpuHz = board.build.f_cpu_hz || 1000000;
    const name = board.name || board.build.mcu;
    if (fam === 'modern' || fam === 'xmega') {
        return `/*
 * ${name} — bare-metal blink (modern UPDI family, Microchip XC8)
 * XC8: <xc.h> selects the device headers (it includes <avr/io.h>);
 * F_CPU feeds _delay_ms (the build also passes -DF_CPU; the ifndef
 * keeps the file standalone). See XC8 User Guide §8.4.1.
 */
#include <xc.h>
#include <stdint.h>
#include <util/delay.h>

#ifndef F_CPU
#define F_CPU ${fcpuHz}UL
#endif

/* On the 0/1-series the port direction is set through the PORT structure. */
#define LED_PORT   PORTA
#define LED_bm     PIN5_bm      /* adjust the pin to your wiring */

int main(void)
{
    LED_PORT.DIRSET = LED_bm;   /* output */

    for (;;)
    {
        LED_PORT.OUTTGL = LED_bm;   /* toggle */
        _delay_ms(500);             /* util/delay.h — needs optimization enabled */
    }
}
`;
    }
    const led = board.led || null;
    const port = led ? `PORT${led.port}` : 'PORTB';
    const ddr  = led ? `DDR${led.port}` : 'DDRB';
    const bit  = led ? led.bit : 5;
    return `/*
 * ${name} — bare-metal blink (classic AVR, Microchip XC8)
 * XC8: <xc.h> selects the device headers (it includes <avr/io.h>);
 * F_CPU feeds _delay_ms (the build also passes -DF_CPU; the ifndef
 * keeps the file standalone). See XC8 User Guide §8.4.1.
 */
#include <xc.h>
#include <stdint.h>
#include <util/delay.h>

#ifndef F_CPU
#define F_CPU ${fcpuHz}UL
#endif

#define LED      ${port}            /* onboard LED port (adjust freely)  */
#define LED_DDR  ${ddr}             /* its data-direction register      */
#define LED_BIT  (1u << ${bit})     /* ${led ? 'board LED pin' : 'pick any pin'}                 */

int main(void)
{
    LED_DDR |= LED_BIT;          /* output */

    for (;;)
    {
        LED |= LED_BIT;          /* on  */
        _delay_ms(500);          /* util/delay.h — needs optimization enabled */
        LED &= ~(uint8_t)LED_BIT; /* off */
        _delay_ms(500);
    }
}
`;
}

module.exports = {
    migrateLegacyBoards, loadBoards, invalidate, getBoard, allBoards,
    buildFlags, selectBoard, mainTemplate,
};
