'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// memory.js — the memory report engine (pure node, no vscode).
//   .text + .data (+ .bootloader…) → flash   | .data + .bss (+ .noinit) → RAM
//   .eeprom → EEPROM                       | avr-nm --size-sort → symbols
// History is persisted per project in build/.avr-memory-history.json
// (survives restarts, dies with `clean` — exactly as it should).
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const cp   = require('child_process');

const HIST_FILE = '.avr-memory-history.json';

// sections: {'.text': n, …} from avr-size -A
function computeUsage(sections, board) {
    const flashSections = ['.text', '.data', '.bootloader', '.init', '.fini', '.init_array', '.fini_array'];
    const ramSections   = ['.data', '.bss', '.noinit'];
    let flash = 0, ram = 0, eeprom = 0;
    for (const [name, size] of Object.entries(sections || {})) {
        if (flashSections.includes(name)) flash += size;
        if (ramSections.includes(name)) ram += size;
        if (name === '.eeprom') eeprom += size;
        if (name.startsWith('.text.')) flash += size;   // -ffunction-sections
        if (name.startsWith('.data.')) { flash += size; ram += size; }
        if (name.startsWith('.bss.')) ram += size;
    }
    const limits = board && board.build && board.build.memory
        ? board.build.memory
        : { flash: 0, ram: 0, eeprom: 0 };
    return {
        flash: { used: flash, total: limits.flash || 0 },
        ram:   { used: ram,   total: limits.ram || 0 },
        eeprom:{ used: eeprom, total: limits.eeprom || 0 },
        sections,
    };
}

function usageText(usage) {
    const parts = [];
    const pct = (u, t) => t > 0 ? `${Math.round(u / t * 100)}%` : '?';
    if (usage.flash.total) parts.push(`Flash ${usage.flash.used}/${usage.flash.total}B (${pct(usage.flash.used, usage.flash.total)})`);
    if (usage.ram.total) parts.push(`RAM ${usage.ram.used}/${usage.ram.total}B (${pct(usage.ram.used, usage.ram.total)})`);
    return parts.join(' · ');
}

// Human units for the after-build toast (the ESP-IDF look: "RAM 96B/2K (5%)
// · Flash 1.2K/32K (4%)" — compact K/M values instead of raw byte counts).
// 96 → '96B', 1234 → '1.2K', 2048 → '2K', 32256 → '31.5K' (a fractional
// value keeps its tenth at ANY magnitude — "32K/32K (98%)" would look wrong).
function _fmtHuman(n) {
    if (n >= 1024 * 1024) { const r = Math.round(n / (1024 * 1024) * 10) / 10; return (r % 1 ? r.toFixed(1) : String(r)) + 'M'; }
    if (n >= 1024) { const r = Math.round(n / 1024 * 10) / 10; return (r % 1 ? r.toFixed(1) : String(r)) + 'K'; }
    return `${n}B`;
}

// The notification variant: RAM first, Flash last (ESP-IDF order), EEPROM
// only when something actually lives in it — a "EEPROM 0B/1K (0%)" on every
// toast would be noise for the 99% of projects that never touch it.
function usageHuman(usage) {
    const u = usage || {};
    const parts = [];
    const pct = (used, total) => total > 0 ? `${Math.round(used / total * 100)}%` : '?';
    if (u.ram && u.ram.total) parts.push(`RAM ${_fmtHuman(u.ram.used)}/${_fmtHuman(u.ram.total)} (${pct(u.ram.used, u.ram.total)})`);
    if (u.eeprom && u.eeprom.used > 0 && u.eeprom.total) parts.push(`EEPROM ${_fmtHuman(u.eeprom.used)}/${_fmtHuman(u.eeprom.total)} (${pct(u.eeprom.used, u.eeprom.total)})`);
    if (u.flash && u.flash.total) parts.push(`Flash ${_fmtHuman(u.flash.used)}/${_fmtHuman(u.flash.total)} (${pct(u.flash.used, u.flash.total)})`);
    return parts.join(' · ');
}

// Symbol sizes via avr-nm --size-sort (hidden execFile, best-effort).
// v0.3.10: the binutils come from EITHER toolchain — XC8 ships its own
// avr-nm (<xc8>/avr/bin, resolved into xc8Modules), so XC8-only installs
// get symbols too; the avr-gcc toolchain's nm (next to toolchain.gcc) is the
// other source. When neither exists: empty list, no crash.
function _binutil(tc, name) {
    if (tc && tc.xc8Modules && tc.xc8Modules[name]) return tc.xc8Modules[name];
    if (tc && tc.gcc) return path.join(path.dirname(tc.gcc), name) + (os.platform() === 'win32' ? '.exe' : '');
    return null;
}
function symbolSizes(toolchain, elfPath, limit = 40) {
    return new Promise((resolve) => {
        try {
            const nm = _binutil(toolchain, 'avr-nm');
            if (!nm) { resolve([]); return; }
            const r = cp.spawnSync(nm, ['--size-sort', '--radix=d', '-S', elfPath], {
                timeout: 10000, encoding: 'utf8', windowHide: true,
            });
            const out = [];
            for (const line of String(r.stdout || '').split('\n')) {
                // 00000004 00000002 T timer0_overflow
                const m = /^\s*(\d+)\s+(\d+)\s+([TtDdBbRrCcWwVv])\s+(\S+)$/.exec(line);
                if (!m) continue;
                const size = parseInt(m[1], 10);
                const type = m[3];
                const where = {
                    T: 'flash(text)', t: 'flash(text)', R: 'flash(rodata)', r: 'flash(rodata)',
                    C: 'flash(compat)', D: 'RAM(data)', d: 'RAM(data)', B: 'RAM(bss)', b: 'RAM(bss)',
                    W: 'weak', V: 'weak', w: 'weak', v: 'weak',
                }[type] || type;
                out.push({ size, name: m[4], where, type });
            }
            out.sort((a, b) => b.size - a.size);
            resolve(out.slice(0, limit));
        } catch { resolve([]); }
    });
}

// ─── Report persistence (the memory view reads this) ─────────────────────────
let _last = null;

// ─── after-build notification (the memory view live-updates, sdcc-mdf style) ──
// generate()/generateXc8() fire after every build, reset() fires on clean /
// project clear — the view re-posts its payload without a manual Refresh.
const _collectCbs = [];
function onCollect(cb) { if (typeof cb === 'function') _collectCbs.push(cb); }
function _notify() {
    for (const cb of _collectCbs.slice()) { try { cb(); } catch (e) { /* listener's own trouble */ } }
}

function histPath(root, outDirAbs) {
    // v0.3.21: the vscode side passes the EXPANDED output dir (expandOutPaths)
    // — a raw build.output_dir with ${…} put the history into a literal junk
    // folder that never matched where builds actually land. Direct callers
    // without the param keep the old raw-dir behaviour.
    if (outDirAbs) return path.join(outDirAbs, HIST_FILE);
    const proj = safeReadProject(root);
    const outDirRel = (proj && proj.build && proj.build.output_dir) || 'build';
    return path.isAbsolute(outDirRel) ? path.join(outDirRel, HIST_FILE) : path.join(root, outDirRel, HIST_FILE);
}
function safeReadProject(root) {
    try {
        const p = path.join(root, 'avr-project.json');
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    } catch { return null; }
}

function readHistory(root, outDirAbs) {
    try {
        const p = histPath(root, outDirAbs);
        if (!fs.existsSync(p)) return [];
        return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    } catch { return []; }
}
function writeHistory(root, list, outDirAbs) {
    try {
        const p = histPath(root, outDirAbs);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(list.slice(-200), null, 2));
    } catch {}
}

// generate() — called by build.js after a successful build
async function generate(root, proj, board, { elfPath, hexPath, eepPath, sections, mapPath, toolchain, outDir }) {
    const usage = computeUsage(sections, board);
    const symbols = await symbolSizes(toolchain, elfPath);
    const entry = {
        ts: new Date().toISOString(),
        board: proj.board,
        usage: {
            flash: usage.flash, ram: usage.ram, eeprom: usage.eeprom,
        },
    };
    const hist = readHistory(root, outDir);
    hist.push(entry);
    writeHistory(root, hist, outDir);

    _last = {
        root,
        board,
        elfPath, hexPath, eepPath, mapPath,
        usage,
        symbols,
        history: hist.slice(-50),
        ts: entry.ts,
    };
    _notify();
    return _last;
}

// XC8 builds: the usage comes from avr-size on the ELF (build.js); the
// symbols from avr-nm — XC8's own (xc8Modules) or avr-gcc's, whichever is
// installed (v0.3.10 — no avr-gcc requirement anymore).
async function generateXc8(root, proj, board, { elfPath, hexPath, eepPath, usage, toolchain, outDir }) {
    const symbols = elfPath
        ? await symbolSizes(toolchain, elfPath)
        : [];
    const entry = {
        ts: new Date().toISOString(),
        board: proj.board,
        usage: {
            flash: usage.flash, ram: usage.ram, eeprom: usage.eeprom,
        },
    };
    const hist = readHistory(root, outDir);
    hist.push(entry);
    writeHistory(root, hist, outDir);

    _last = {
        root,
        board,
        elfPath, hexPath, eepPath,
        mapPath: null,
        usage: {
            flash: usage.flash, ram: usage.ram, eeprom: usage.eeprom,
            sections: {},
        },
        symbols,
        history: hist.slice(-50),
        ts: entry.ts,
        toolchain: 'xc8',
    };
    _notify();
    return _last;
}

function lastReport() { return _last; }
function lastUsageText() { return _last ? usageText(_last.usage) : ''; }
function lastUsageHuman() { return _last ? usageHuman(_last.usage) : ''; }
function reset() { _last = null; _notify(); }   // clean / project clear → the view empties

// Reload the LATEST build's numbers from disk (view startup after restart)
// v0.3.21: outDirAbs comes from the vscode side (expandOutPaths) — the raw
// build.output_dir with ${…} made the elf existence check fail after every
// restart and the view stayed empty until the next build.
async function reloadFromDisk(toolchain, outDirAbs) {
    const root = _activeRootOrNull();
    if (!root) { reset(); return null; }
    const proj = safeReadProject(root);
    if (!proj) { reset(); return null; }
    const outName = (proj.build && proj.build.output_name) || 'firmware';
    let outDir = outDirAbs;
    if (!outDir) {
        const outDirRel = (proj.build && proj.build.output_dir) || 'build';
        outDir = path.isAbsolute(outDirRel) ? outDirRel : path.join(root, outDirRel);
    }
    const elfPath = path.join(outDir, outName + '.elf');
    if (!fs.existsSync(elfPath)) { reset(); return null; }
    const board = resolveBoard(proj.board);
    const sections = await sectionsFromElf(toolchain, elfPath);
    const usage = computeUsage(sections, board);
    const symbols = await symbolSizes(toolchain, elfPath);
    _last = {
        root, board,
        elfPath,
        hexPath: path.join(outDir, outName + '.hex'),
        eepPath: path.join(outDir, outName + '.eep'),
        mapPath: path.join(outDir, outName + '.map'),
        usage, symbols,
        history: readHistory(root, outDir),
        ts: fs.existsSync(elfPath) ? fs.statSync(elfPath).mtime.toISOString() : null,
    };
    return _last;
}
function _activeRootOrNull() {
    // helpers is vscode-bound; memory.js is pure — take the root from the env var bridge
    const r = process.env.AVR_MDF_ACTIVE_ROOT || null;
    return r && fs.existsSync(r) ? r : null;
}
function setActiveRootBridge(root) { process.env.AVR_MDF_ACTIVE_ROOT = root || ''; }

function resolveBoard(boardId) {
    // pure-node board lookup (builtin dir only — enough for memory limits)
    try {
        const dir = path.join(__dirname, '..', 'boards');
        const walk = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const full = path.join(d, e.name);
                if (e.isDirectory()) { const r = walk(full); if (r) return r; }
                else if (e.name === boardId + '.json') return JSON.parse(fs.readFileSync(full, 'utf8'));
            }
            return null;
        };
        return walk(dir);
    } catch { return null; }
}
async function sectionsFromElf(toolchain, elfPath) {
    return new Promise((resolve) => {
        const sizeExe = _binutil(toolchain, 'avr-size');
        if (!sizeExe) { resolve(null); return; }
        try {
            const r = cp.spawnSync(sizeExe, ['-A', elfPath], { timeout: 10000, encoding: 'utf8', windowHide: true });
            const sections = {};
            for (const line of String(r.stdout || '').split('\n')) {
                const m = /^\s*(\.[\w.]+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
                if (m) sections[m[1]] = parseInt(m[2], 10);
            }
            resolve(Object.keys(sections).length ? sections : null);
        } catch { resolve(null); }
    });
}

module.exports = {
    computeUsage, usageHuman,
    generate, generateXc8, lastReport, lastUsageText, lastUsageHuman, reset, reloadFromDisk,
    setActiveRootBridge, onCollect,
};
