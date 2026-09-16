'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// importProject.js — "AVR: Import Project from Other IDE…" — one command,
// five sources:
//   • Arduino sketch           (.ino)
//   • PlatformIO               (platformio.ini)
//   • Makefile                 (classic AVR — WinAVR / avr-gcc templates)
//   • Code::Blocks             (*.cbp)
//   • Eclipse CDT + AVR plugin (.project / .cproject)
//
// Design rules (each one is a deliberate decision, not an accident):
//
// 1. IMPORT IN PLACE — avr-project.json is written into the SAME folder the
//    other IDE's project file lives in. Nothing moves, no sources are copied,
//    nothing is deleted: the old IDE keeps working, and the extension starts
//    building the same tree.
//
// 2. BEST-EFFORT + HONEST — the other IDEs have no "board" concept and only
//    partial flash settings, so the MCU is a heuristic (matched by id/name/
//    mcu, else the atmega328p default) and EVERY skipped or rewritten piece
//    is listed in the review summary shown before anything is written.
//
// 3. NEVER A SILENT OVERWRITE — an existing avr-project.json in the target
//    folder must be explicitly confirmed, and the draft is shown for review
//    (the full summary rides on the QuickPick detail) before it is written.
//
// 4. MCU-LEVEL FLAGS ARE STRIPPED — -mmcu=<mcu> and -DF_CPU=<hz> belong to
//    the BOARD in this framework (boards.js emits -mmcu/-DF_CPU from the
//    board JSON). Importing them into defines or build flags would fight the
//    board definition, so they are dropped and reported — with the board's
//    own f_cpu for comparison when they disagree.
//
// 5. THE RESULT OPENS IN THE PROJECT EDITOR — an import is a DRAFT for
//    review (MCU first of all), not a claim of perfection.
//
// The parse* helpers are pure string→object functions and the import*
// mappers touch only the boards DB (no vscode API), so they stay testable
// without a running extension host; only the command shell below touches
// the vscode API. They remain unexported — module.exports is the command.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Boards = require('./boards');
const Validator = require('./validator');

const DEFAULT_MCU = 'atmega328p';
// sources[] file extensions this framework actually compiles (sources.js)
const SOURCE_FILE_RE = /\.(c|cc|cpp|cxx|s|S|asm|a51|a90)$/;

// ─── Design rule 4: MCU-level flags never survive into the draft ────────────
// -mmcu=<mcu> (also the two-token "-mmcu x" form) and -DF_CPU=<hz> (also the
// bare "F_CPU=…" define Eclipse CDT / Arduino-style lists carry) belong to
// the board definition; classifyFlags() splits a foreign flag list into
// defines / includes / free flags and harvests the MCU + F_CPU hints.
function classifyFlags(tokens) {
    const defines = [], includes = [], rest = [], moved = [];
    let mcuHint = null, fcpu = null;
    const toks = tokens || [];
    for (let i = 0; i < toks.length; i++) {
        const t = String(toks[i]);
        if (/^-mmcu=/i.test(t)) {
            moved.push(t);
            mcuHint = t.slice(6).trim();
            continue;
        }
        if (/^-mmcu$/i.test(t) && i + 1 < toks.length) {
            moved.push(t, toks[i + 1]);
            mcuHint = String(toks[++i]).trim();
            continue;
        }
        if (/^-DF_CPU=/i.test(t)) {
            moved.push(t);
            const hz = /^(\d+)(?:UL|L)?$/i.exec(t.slice(8).trim());
            if (hz) fcpu = parseInt(hz[1], 10);
            continue;
        }
        if (/^-DF_CPU$/i.test(t) && i + 1 < toks.length) {
            moved.push(t, toks[i + 1]);
            const hz = /^(\d+)(?:UL|L)?$/i.exec(String(toks[i + 1]).trim());
            if (hz) fcpu = parseInt(hz[1], 10);
            i++;
            continue;
        }
        if (/^-D./.test(t)) { defines.push(t.slice(2)); continue; }
        if (/^-I./.test(t)) { includes.push(t.slice(2)); continue; }
        rest.push(t);
    }
    return { defines, includes, rest, moved, mcuHint, fcpu };
}

// bare defines ("F_CPU=16000000UL" without the -D) — Eclipse definedSymbols
function stripFcpuDefines(defines) {
    const kept = [], moved = [];
    let fcpu = null;
    for (const d of (defines || [])) {
        if (/^F_CPU\s*=/i.test(d)) {
            moved.push(d);
            const hz = /^(\d+)(?:UL|L)?$/i.exec(String(d).split('=')[1] || '');
            if (hz) fcpu = parseInt(hz[1], 10);
        } else kept.push(d);
    }
    return { kept, moved, fcpu };
}

// the rule-4 note for a dropped F_CPU, with the board's own clock compared
function fcpuNote(fcpu, board) {
    if (fcpu === null || fcpu === undefined || !board) return null;
    const bf = board.build && board.build.f_cpu_hz;
    if (typeof bf === 'number' && bf !== fcpu) {
        return `F_CPU=${fcpu} dropped — the board owns F_CPU here, and "${board.id}" defaults to ${bf} Hz; pick a board definition with the right clock`;
    }
    return `F_CPU=${fcpu} dropped — the board owns F_CPU here ("${board.id}" matches)`;
}

// ─── project-name sanitizer (mirrors validateProjectNameValue in
// extension.js: ASCII, starts with a Latin letter, [A-Za-z0-9_-], ≤64 — the
// name can flow into build paths via ${project.name}) ────────────────────────
function sanitizeName(raw, fallback) {
    let s = String(raw || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
    if (!s) s = String(fallback || 'imported-project').replace(/[^A-Za-z0-9_-]+/g, '-');
    if (!/^[A-Za-z]/.test(s)) s = 'avr-' + s;
    if (s.length > 64) s = s.slice(0, 64);
    const orig = String(raw || '').trim();
    return { name: s, changed: s !== orig };
}

// ─── MCU matching ladder: exact id → normalized id → normalized name →
// normalized mcu → substring (≥4 chars, both directions) → default ──────────
// With 311 MCU definitions (ATmega/ATtiny/ATxmega/AVR-DX/automotive/Arduino)
// a raw part number from a Makefile or a PlatformIO board id almost always
// lands on one of the first four rungs; everything else falls to
// atmega328p with an explicit "verify it" note (design rule 2).
function pickMcu(hint) {
    const boards = Boards.allBoards();
    const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (hint) {
        const h = norm(hint);
        if (h) {
            let hit = boards.find(b => b.id === hint) ||
                      boards.find(b => norm(b.id) === h) ||
                      boards.find(b => norm(b.name) === h) ||
                      boards.find(b => b.build && norm(b.build.mcu) === h);
            // substring pass only for meaningful hints (≥4 chars) and in BOTH
            // directions — e.g. PlatformIO "nanoatmega328" contains our "nano",
            // and our "atmega328pb" contains the hint "atmega328p"… the reverse
            // containment catches the PIO-style prefixed board ids.
            if (!hit && h.length >= 4) hit = boards.find(b =>
                norm(b.id).includes(h) || norm(b.name).includes(h) ||
                (norm(b.id).length >= 4 && h.includes(norm(b.id))));
            if (hit) {
                const exact = hit.id === hint;
                return { boardId: hit.id, board: hit, note: exact ? null :
                    `MCU "${hint}" matched definition "${hit.id}" by name — verify it in the Project Editor` };
            }
        }
    }
    const fallback = boards.find(b => b.id === DEFAULT_MCU) || null;
    return { boardId: DEFAULT_MCU, board: fallback,
        note: `MCU "${hint || '?'}" has no matching definition — using ${DEFAULT_MCU}; pick the right one in the Project Editor` };
}

// ─── small shared helpers ─────────────────────────────────────────────────────
function decodeXml(s) {
    return String(s || '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&amp;/g, '&');
}
// Split an ini-style value into tokens (whitespace/comma separated, quotes
// respected) — build_flags / src_filter / SRCS lists and friends.
function splitTokens(v) {
    const out = []; let cur = ''; let q = null;
    for (const ch of String(v || '')) {
        if (q) { if (ch === q) q = null; else cur += ch; }
        else if (ch === '"' || ch === "'") q = ch;
        else if (/\s/.test(ch) || ch === ',') { if (cur) { out.push(cur); cur = ''; } }
        else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}
function dedupe(arr) {
    return [...new Set((arr || []).map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean))];
}

// avrdude-style flag harvesting (-c/-P/-b/-p, glued and split forms) for
// AVRDUDE_FLAGS and PlatformIO upload_flags — only the fields our upload
// section understands are taken, the rest is reported (design rule 2).
function parseAvrdudeFlags(tokens) {
    const out = { programmer: '', port: '', baud: '', part: '', rest: [] };
    const toks = tokens || [];
    for (let i = 0; i < toks.length; i++) {
        const t = String(toks[i]);
        const glue = /^-([cPpb])(.+)$/.exec(t);
        if (glue) { _avrdudeField(out, glue[1], glue[2]); continue; }
        const split = /^-([cPpb])$/.exec(t);
        if (split && i + 1 < toks.length) { _avrdudeField(out, split[1], String(toks[++i])); continue; }
        out.rest.push(t);
    }
    return out;
}
function _avrdudeField(out, key, val) {
    val = String(val).trim();
    if (key === 'c') out.programmer = out.programmer || val;
    else if (key === 'P') out.port = out.port || val;
    else if (key === 'b') out.baud = out.baud || val;
    else if (key === 'p') out.part = out.part || val;
}

// ═════════════════════════════════════════════════════════════════════════════
// Parser 1: Arduino sketch (.ino)
// ═════════════════════════════════════════════════════════════════════════════
// A sketch carries NO board metadata — the .ino is plain C++ with Arduino
// core calls. The board is guessed from the sketch/folder NAME (classic
// patterns), and the honesty rules do the rest: the build scans .c/.cpp/.S
// only, so the .ino itself is NOT compiled until it is renamed.
const ARDUINO_GUESS = [
    ['uno', 'uno'], ['nano', 'nano'], ['leonardo', 'leonardo'], ['promicro', 'promicro-16m'],
    ['micro', 'micro'], ['mega2560', 'mega2560'], ['mega', 'mega2560'], ['1280', 'atmega1280'],
    ['promini', 'promini-5v-16m'], ['attiny85', 'attiny85'], ['attiny84', 'attiny84'],
    ['attiny13', 'attiny13a'], ['attiny167', 'attiny167'], ['168', 'atmega168p'], ['328', 'atmega328p'],
];
// Non-AVR Arduino boards (ARM/ESP) — avr-gcc cannot build them at all, so
// the import is REFUSED with a clear message instead of a lying draft.
// Tokens are split on separators AND camelCase humps ("DueBlink" → due,
// blink). Plain "zero" is deliberately NOT on the list: zero-crossing
// dimmer sketches are a classic AVR project and a false refusal is worse
// than the honest default-MCU note a real Zero gets instead.
function arduinoSketchIsNotAvr(file) {
    const words = (path.basename(file) + ' ' + path.basename(path.dirname(file)))
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')          // camelCase humps
        .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return words.some(w =>
        w === 'due' || w === 'samd' || w === 'giga' || w === 'opta' ||
        w.startsWith('mkr') || w.startsWith('portenta') || w.startsWith('nano33') ||
        w.startsWith('esp32') || w.startsWith('esp8266') || w.startsWith('unor4'));
}

function importArduinoSketch(file, root) {
    const notes = [];
    const sketch = path.basename(file, '.ino');
    // board guess from the sketch name / typical folder patterns
    const lower = (sketch + ' ' + path.basename(root)).toLowerCase();
    let guess = null;
    for (const [pat, id] of ARDUINO_GUESS) {
        if (lower.indexOf(pat) !== -1) { guess = id; break; }
    }
    const picked = pickMcu(guess);
    if (guess) notes.push(`board guessed from the sketch/folder name → "${picked.boardId}" — sketches carry no board metadata, verify the MCU AND the clock (F_CPU comes from the board definition)`);
    if (picked.note) notes.push(picked.note);
    notes.push(`the .ino itself is NOT compiled — the build scans .c/.cpp/.S only; rename "${path.basename(file)}" → "${sketch}.ino.cpp" (or main.cpp) so avr-g++ picks it up as C++`);
    notes.push('Arduino core API (pinMode/digitalWrite/Serial…) needs an Arduino core component (components/arduino-core) or a rewrite — bare-metal C/C++ builds out of the box');
    notes.push('define ARDUINO=100 added — the API-level macro most #ifdef ARDUINO guards check');
    notes.push('avrdude settings come from the board definition (protocol/speed) — check them in the Project Editor');
    const sn = sanitizeName(sketch, 'arduino-sketch');
    if (sn.changed) notes.push(`project name "${sketch}" → "${sn.name}" (ASCII, Windows-safe — it can flow into build paths)`);
    return {
        name: sn.name, boardId: picked.boardId, sources: ['.'], includes: [],
        defines: ['ARDUINO=100'], flags: [],
        cxxFlags: ['-fno-exceptions', '-fno-threadsafe-statics'],   // the classic Arduino avr-g++ pair
        linkFlags: [], libraries: [], components: [],
        upload: { tool: 'avrdude' },
        outputName: sn.name || 'firmware', notes,
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// Parser 2: platformio.ini
// ═════════════════════════════════════════════════════════════════════════════
// Line-based ini: [section] headers, key = value, ";" / "#" comments and
// MULTILINE values (an indented list under a key — PlatformIO's documented
// multiline form for build_flags & co).
function parsePlatformioIni(text) {
    const sections = {};          // lowercased section name → { key: value }
    const envs = [];              // [{ name, kv }] in file order
    let cur = sections[''] = {};
    let curKey = null;
    const cutComment = v => {
        let out = '', q = null;
        for (const ch of v) {
            if (q) { out += ch; if (ch === q) q = null; }
            else if (ch === '"' || ch === "'") { q = ch; out += ch; }
            else if (ch === ';' || ch === '#') break;
            else out += ch;
        }
        return out.trim();
    };
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const t = rawLine.trim();
        if (!t || t.startsWith(';') || t.startsWith('#')) { curKey = null; continue; }
        const sec = t.match(/^\[([^\]]*)\]$/);
        if (sec) {
            const nm = sec[1].trim();
            const key = nm.toLowerCase();
            cur = sections[key] = sections[key] || {};
            if (/^env:/i.test(nm)) envs.push({ name: nm.slice(4).trim(), kv: cur });
            curKey = null;
            continue;
        }
        // MULTILINE VALUE (PlatformIO's documented form): an INDENTED line
        // while a key is pending is a continuation — checked BEFORE the
        // key=value split, because a continuation line may itself contain
        // "=" (-DF_CPU=11059200 must NOT become a new key!).
        if (curKey !== null && /^\s/.test(rawLine)) {
            const v = cutComment(t);
            cur[curKey] = cur[curKey] ? cur[curKey] + ' ' + v : v;
            continue;
        }
        const eq = t.indexOf('=');
        if (eq > 0) {
            const k = t.slice(0, eq).trim().toLowerCase();
            const v = cutComment(t.slice(eq + 1));
            cur[k] = (cur[k] !== undefined ? cur[k] + ' ' : '') + v;
            curKey = k;
        }
        // a non-indented line without "=" while no key is pending → garbage; skip
    }
    return { sections, envs };
}

// PlatformIO board ids the MCU ladder cannot resolve on its own (everything
// else — uno, nanoatmega328, megaatmega2560, atmega328pb… — matches a
// definition through pickMcu directly).
const PIO_BOARD_ALIAS = {
    'promini8': 'promini-3v3-8m',
    'promini5': 'promini-5v-16m',
    'at32u4': 'leonardo',
    'btatmega328': 'nano',
    'yun': 'leonardo',
    'gemma': 'attiny85',
    'trinket3': 'attiny85',
    'trinket5': 'attiny85',
};
function pioBoardToMcu(pioBoard) {
    const raw = String(pioBoard || '').trim();
    const key = raw.toLowerCase();
    let hint = null, aliasedFrom = null;
    if (PIO_BOARD_ALIAS[key]) {
        hint = PIO_BOARD_ALIAS[key];
        aliasedFrom = raw || key;
    } else if (key) {
        // prefix pass (documented legacy behavior): "unowifiR2" starts with "uno"…
        for (const [k, v] of Object.entries(PIO_BOARD_ALIAS)) {
            if (key.startsWith(k)) { hint = v; aliasedFrom = raw; break; }
        }
    }
    const picked = pickMcu(hint || raw);
    return { boardId: picked.boardId, board: picked.board, note: picked.note,
        aliasedFrom: hint ? aliasedFrom : null };
}

function importPlatformIO(ini, envName, root) {
    const notes = [];
    const global = ini.sections['platformio'] || {};
    const env = ini.envs.find(e => e.name === envName) || { kv: {} };
    const kv = Object.assign({}, global, env.kv);
    if (ini.envs.length > 1) notes.push(`PlatformIO env "${envName}" imported — ${ini.envs.length - 1} other [env:…] section(s) skipped`);

    const platform = String(kv.platform || '').toLowerCase().trim();
    if (platform && platform.indexOf('avr') === -1) {
        notes.push(`platform "${kv.platform}" is not an AVR PlatformIO platform (atmelavr / atmelmegaavr) — verify that this project really targets AVR`);
    }

    const pio = pioBoardToMcu(kv.board);
    if (pio.aliasedFrom) notes.push(`PlatformIO board "${pio.aliasedFrom}" → MCU definition "${pio.boardId}"`);
    if (pio.note) notes.push(pio.note);
    if (!String(kv.board || '').trim()) notes.push('no board = line in the [env:…] section — the MCU is a blind default, set it in the Project Editor');

    // build_flags → defines (-D) / includes (-I) / the rest
    const cl = classifyFlags(splitTokens(kv.build_flags || ''));
    if (cl.moved.length) notes.push(`MCU-level flags dropped (the board owns them here): ${cl.moved.join(' ')}`);
    const fn = fcpuNote(cl.fcpu, pio.board);
    if (fn) notes.push(fn);

    // sources: src_dir (default src) + build_src_filter / src_filter.
    // PlatformIO ≥6 moved the filters to build_src_filter (the legacy
    // src_filter is deprecated) — read the new key with fallback; which key
    // was used is reported. "-" patterns CANNOT be migrated: this framework
    // scans whole folders (no per-folder excludes), so every exclude is
    // REPORTED as "those files will be compiled" instead of silently lost.
    let srcDir = String(kv.src_dir || 'src').trim() || 'src';
    srcDir = srcDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const sources = [srcDir];
    const sfRaw = kv.build_src_filter || kv.src_filter || '';
    if (sfRaw) {
        let sfPatterns = 0;
        for (const tok of splitTokens(sfRaw)) {
            const m = tok.match(/^([+-])<(.*)>$/);
            if (!m) continue;
            sfPatterns++;
            const p = m[2].replace(/\/+$/, '');
            if (m[1] === '-') {
                notes.push(`src_filter "-<${p}>" NOT migrated — this framework scans whole folders, so those files WILL be compiled; move them out of "${srcDir}/" or split the tree`);
            } else if (p && p !== '*' && p !== srcDir && p !== 'src' && !/^\*\*\/\*$/.test(p)) {
                notes.push(`src_filter "+<${p}>" — the whole "${srcDir}/" tree is scanned; extra "+" patterns only matter if they exclude something elsewhere`);
            }
        }
        if (sfPatterns) notes.push(`src_filter read from "${kv.build_src_filter ? 'build_src_filter' : 'src_filter'}"`);
    }

    // includes: -I flags + the conventional include/ folder
    const includes = dedupe([...cl.includes, 'include']);

    // upload: upload_protocol is the avrdude -c programmer for the AVR
    // platform (anything except "custom"); port/speed map 1:1; upload_flags
    // are harvested for -c/-P/-b only — the rest would fight the argv this
    // framework constructs itself.
    const upload = { tool: 'avrdude' };
    const proto = String(kv.upload_protocol || '').toLowerCase().trim();
    if (proto && proto !== 'custom') {
        upload.programmer = proto;
        notes.push(`upload_protocol "${proto}" → upload.programmer (passed to avrdude -c — must be a programmer id avrdude knows)`);
    } else if (proto === 'custom') {
        notes.push('upload_protocol "custom" — the upload_command is NOT migrated; configure upload.tool/args in the Project Editor');
    }
    const port = String(kv.upload_port || '').trim();
    const speed = String(kv.upload_speed || '').trim();
    if (port) upload.port = port;
    if (speed) upload.baud = speed;
    if (port || speed) notes.push(`upload_port "${port || '—'}" / upload_speed "${speed || '—'}" copied to upload.port / upload.baud`);
    const uf = splitTokens(kv.upload_flags || '');
    if (uf.length) {
        const av = parseAvrdudeFlags(uf);
        if (!upload.programmer && av.programmer) upload.programmer = av.programmer;
        if (!upload.port && av.port) upload.port = av.port;
        if (!upload.baud && av.baud) upload.baud = av.baud;
        notes.push(`upload_flags: -c/-P/-b harvested into upload.*; the rest NOT migrated: ${av.rest.join(' ') || '—'} (PlatformIO $VARS are not expanded)`);
    }

    // the PlatformIO "lib" folder holds SOURCE libraries — that is exactly
    // this framework's components model (each subfolder builds, inc/include
    // auto-added), NOT the prebuilt-.a "libraries" list.
    const components = ['lib'];
    notes.push('PlatformIO "lib" folder → components (source libraries: each subfolder is compiled, inc/include is auto-added; lib/<name>/src works because the subfolder is scanned recursively)');
    const libDeps = splitTokens(kv.lib_deps || '');
    if (libDeps.length) notes.push(`lib_deps (${libDeps.join(', ')}) NOT migrated — PlatformIO fetches them at build time; copy the libraries into lib/ yourself`);

    const rawName = envName || path.basename(root || '') || 'platformio-project';
    const sn = sanitizeName(rawName, 'platformio-project');
    if (sn.changed) notes.push(`project name "${rawName}" → "${sn.name}" (ASCII, Windows-safe — it can flow into build paths)`);

    return {
        name: sn.name, boardId: pio.boardId, sources, includes, defines: dedupe(cl.defines),
        flags: cl.rest, cxxFlags: cl.rest.slice(),   // PlatformIO applies build_flags to C AND C++
        linkFlags: [], libraries: [], components, upload, outputName: 'firmware', notes,
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// Parser 3: classic AVR Makefile (WinAVR / avr-gcc template)
// ═════════════════════════════════════════════════════════════════════════════
// Tab-indented lines are recipes (never variables); comments are stripped;
// "export/override VAR = x" prefixes are tolerated; "+=" appends. Makefile
// macros ($(CDEFS), $(CINCS)…) are NOT expanded — tokens containing them are
// skipped and reported instead of silently dropped.
function parseMakefileVars(text) {
    const vars = {};
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        if (/^\t/.test(rawLine)) continue;                  // recipe line
        let line = rawLine;
        const hash = line.indexOf('#');
        if (hash >= 0) line = line.slice(0, hash);           // strip comments (best-effort)
        const m = /^(?:export|override|unexport)\s+([A-Za-z0-9_]+)[ \t]*(:=|\?=|\+=|=)[ \t]*(.*)$/.exec(line.trim()) ||
                   /^([A-Za-z0-9_]+)[ \t]*(:=|\?=|\+=|=)[ \t]*(.*)$/.exec(line.trim());
        if (!m) continue;
        const key = m[1].toUpperCase();
        if (m[2] === '+=') vars[key] = vars[key] ? vars[key] + ' ' + m[3].trim() : m[3].trim();
        else vars[key] = m[3].trim();
    }
    return vars;
}

function importMakefile(text, root) {
    const notes = [];
    const vars = parseMakefileVars(text);

    // CFLAGS/CDEFS — macros first (skipped + reported), then the classifier
    const flagTokens = splitTokens((vars['CFLAGS'] || '') + ' ' + (vars['CDEFS'] || ''));
    const macroTokens = flagTokens.filter(t => t.indexOf('$(') !== -1 || t.indexOf('${') !== -1);
    const cl = classifyFlags(flagTokens.filter(t => t.indexOf('$(') === -1 && t.indexOf('${') === -1));
    if (macroTokens.length) notes.push(`${macroTokens.length} Makefile macro token(s) ($(CDEFS), $(CINCS)…) are not expanded — those tokens were skipped`);

    // MCU hint: MMCU/MCU variable, then -mmcu in CFLAGS, then the avrdude part
    const av = parseAvrdudeFlags(splitTokens(vars['AVRDUDE_FLAGS'] || ''));
    const mcuHint = String(vars['MMCU'] || vars['MCU'] || cl.mcuHint || av.part || '').trim();
    const fcpuVar = /^(\d+)(?:UL|L)?$/i.exec(String(vars['F_CPU'] || vars['FOSC'] || '').trim());
    const fcpu = cl.fcpu !== null ? cl.fcpu : (fcpuVar ? parseInt(fcpuVar[1], 10) : null);

    const picked = pickMcu(mcuHint);
    if (mcuHint) notes.push(`Makefile ${vars['MMCU'] ? 'MMCU' : vars['MCU'] ? 'MCU' : 'flags'}="${mcuHint}" → MCU "${picked.boardId}"`);
    else notes.push('no MMCU/MCU variable found — the MCU defaulted, set it in the Project Editor');
    if (picked.note) notes.push(picked.note);
    const fn = fcpuNote(fcpu, picked.board);
    if (fn) notes.push(fn);
    if (cl.moved.length) notes.push(`MCU-level flags dropped (the board owns them here): ${cl.moved.join(' ')}`);

    // avrdude: explicit variables first, then the AVRDUDE_FLAGS tokens
    const programmer = String(vars['AVRDUDE_PROGRAMMER'] || vars['PROGRAMMER'] || av.programmer || '').toLowerCase().trim();
    const port = String(vars['AVRDUDE_PORT'] || av.port || '').trim();
    const baud = String(vars['AVRDUDE_BAUDRATE'] || vars['BAUD'] || av.baud || '').trim();
    const upload = { tool: 'avrdude' };
    if (programmer) upload.programmer = programmer;
    if (port) upload.port = port;
    if (baud) upload.baud = baud;
    if (programmer || port || baud) notes.push(`avrdude: programmer=${programmer || '—'}, port=${port || '—'}, baud=${baud || '—'} copied to upload`);
    if (av.part) notes.push(`AVRDUDE part "${av.part}" ignored — the board definition owns the part`);
    if (av.rest.length) notes.push(`AVRDUDE_FLAGS not migrated: ${av.rest.join(' ')}`);

    // sources: SRCS/SRC/SOURCES file list when it names real files, else the
    // classic defaults (many Makefile projects keep sources next to the file)
    const srcRaw = String(vars['SRCS'] || vars['SRC'] || vars['SOURCES'] || '');
    const sources = [];
    let skippedMacroSrc = 0;
    for (const tok of splitTokens(srcRaw)) {
        if (tok.indexOf('$(') !== -1 || tok.indexOf('${') !== -1) { skippedMacroSrc++; continue; }
        if (SOURCE_FILE_RE.test(tok)) sources.push(tok);
    }
    if (skippedMacroSrc) notes.push(`${skippedMacroSrc} SRCS entr${skippedMacroSrc === 1 ? 'y' : 'ies'} use Makefile macros — skipped, add the files in the Project Editor`);
    if (!sources.length) {
        sources.push('src', '.');
        notes.push(`${srcRaw ? 'no compilable files in SRCS/SRC' : 'no SRCS/SRC file list found'} — sources defaulted to "src" + the project root (classic Makefile projects keep sources next to the Makefile)`);
    }

    // TARGET → output_name (the directory stays build/ — our convention)
    const target = String(vars['TARGET'] || '').trim();
    const outputName = target.replace(/[/\\]/g, '') || 'firmware';
    if (target) notes.push(`TARGET "${target}" → output_name "${outputName}" (the directory stays build/ — our convention)`);

    const rawName = path.basename(root || '') || 'makefile-project';
    const sn = sanitizeName(rawName, 'makefile-project');
    if (sn.changed) notes.push(`project name "${rawName}" → "${sn.name}" (ASCII, Windows-safe — it can flow into build paths)`);

    return {
        name: sn.name, boardId: picked.boardId, sources, includes: dedupe(cl.includes),
        defines: dedupe(cl.defines), flags: cl.rest, cxxFlags: [], linkFlags: [],
        libraries: [], components: [], upload, outputName, notes,
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// Parser 4: Code::Blocks *.cbp (XML, best-effort regex extraction)
// ═════════════════════════════════════════════════════════════════════════════
function parseCodeblocksCbp(text) {
    const t = String(text || '');
    const res = { title: '', compiler: '', targets: [], units: [], globalOptions: [], globalDirs: [], globalLibs: [] };
    const tm = t.match(/<Option\s+title="([^"]*)"/);
    if (tm) res.title = decodeXml(tm[1]);

    const targetRe = /<Target\s+title="([^"]*)"\s*>([\s\S]*?)<\/Target>/g;
    let m;
    while ((m = targetRe.exec(t)) !== null) {
        const body = m[2];
        const tgt = {
            name: decodeXml(m[1]), output: '',
            options: [], dirs: [], linkerOptions: [], libs: [],
        };
        const om = body.match(/<Option\s+output="([^"]*)"/);
        if (om) tgt.output = decodeXml(om[1]);
        const compBody = (body.match(/<Compiler>([\s\S]*?)<\/Compiler>/) || [])[1] || '';
        for (const am of compBody.matchAll(/<Add\s+option="([^"]*)"/g)) tgt.options.push(decodeXml(am[1]));
        for (const am of compBody.matchAll(/<Add\s+directory="([^"]*)"/g)) tgt.dirs.push(decodeXml(am[1]));
        const linkBody = (body.match(/<Linker>([\s\S]*?)<\/Linker>/) || [])[1] || '';
        for (const am of linkBody.matchAll(/<Add\s+option="([^"]*)"/g)) tgt.linkerOptions.push(decodeXml(am[1]));
        for (const am of linkBody.matchAll(/<Add\s+library="([^"]*)"/g)) tgt.libs.push(decodeXml(am[1]));
        res.targets.push(tgt);
    }

    // project-level <Compiler>/<Linker> blocks (outside every <Target>) —
    // Code::Blocks puts shared options there; the compiler attribute too
    const outside = t.replace(/<Target\s+title="[^"]*"\s*>[\s\S]*?<\/Target>/g, '');
    const cm = outside.match(/<Option\s+compiler="([^"]*)"/);
    if (cm) res.compiler = decodeXml(cm[1]);
    const gComp = (outside.match(/<Compiler>([\s\S]*?)<\/Compiler>/) || [])[1] || '';
    for (const am of gComp.matchAll(/<Add\s+option="([^"]*)"/g)) res.globalOptions.push(decodeXml(am[1]));
    for (const am of gComp.matchAll(/<Add\s+directory="([^"]*)"/g)) res.globalDirs.push(decodeXml(am[1]));
    const gLink = (outside.match(/<Linker>([\s\S]*?)<\/Linker>/) || [])[1] || '';
    for (const am of gLink.matchAll(/<Add\s+library="([^"]*)"/g)) res.globalLibs.push(decodeXml(am[1]));

    for (const um of t.matchAll(/<Unit\s+filename="([^"]*)"/g)) res.units.push(decodeXml(um[1]).replace(/\\/g, '/'));
    return res;
}

function importCodeBlocks(cbp, root) {
    const notes = [];
    // target pick: Release preferred, else the first
    let tgt = cbp.targets.find(x => /release/i.test(x.name)) || cbp.targets[0] || null;
    if (!tgt && (cbp.globalOptions.length || cbp.globalDirs.length)) {
        tgt = { name: '', options: cbp.globalOptions, dirs: cbp.globalDirs, linkerOptions: [], libs: cbp.globalLibs, output: '' };
    }
    if (!tgt) notes.push('no <Target> and no project-level <Compiler> options found — the draft is a skeleton, fill it in the Project Editor');
    if (cbp.targets.length > 1) notes.push(`the project has ${cbp.targets.length} targets — imported "${tgt ? tgt.name : '?'}" (Release preferred), the others were skipped`);
    if (cbp.compiler && !/avr/i.test(cbp.compiler)) notes.push(`Code::Blocks compiler "${cbp.compiler}" is not avrgcc — verify that this is really an AVR project`);

    const cl = classifyFlags([...(tgt ? tgt.options : []), ...cbp.globalOptions]);
    const picked = pickMcu(cl.mcuHint);
    if (cl.mcuHint) notes.push(`-mmcu=${cl.mcuHint} → MCU "${picked.boardId}"`);
    else notes.push('no -mmcu=… option found — the MCU is the default, set it in the Project Editor');
    if (picked.note) notes.push(picked.note);
    const fn = fcpuNote(cl.fcpu, picked.board);
    if (fn) notes.push(fn);
    if (cl.moved.length) notes.push(`MCU-level flags dropped (the board owns them here): ${cl.moved.join(' ')}`);

    // linker options: -mmcu stripped (rule 4), the rest → build.link_flags
    const link = classifyFlags((tgt ? tgt.linkerOptions : []));
    if (link.moved.length) notes.push(`MCU-level linker flags dropped (the board owns them here): ${link.moved.join(' ')}`);
    const libs = [...(tgt ? tgt.libs : []), ...cbp.globalLibs];
    if (libs.length) notes.push(`linked libraries (${libs.join(', ')}) NOT migrated — avr-libc is preinstalled with the toolchain; add prebuilt .a files under lib/ only if you really have some`);

    // sources: the <Unit> list maps to an EXPLICIT source file list (in
    // place — they live in the same tree); sources[] supports file entries,
    // so nothing is invented. The consequence is honest: files added later
    // must be added in the Project Editor.
    const units = cbp.units || [];   // parser already normalized the backslashes
    const files = units.filter(u => SOURCE_FILE_RE.test(u));
    const skipped = units.length - files.length;
    if (skipped > 0) notes.push(`${skipped} <Unit> entries are not .c/.cpp/.S/.asm (headers, resources) — not added to sources`);
    let sources;
    if (files.length) {
        sources = dedupe(files);
        notes.push(`${files.length} <Unit> files imported as an EXPLICIT source list — files added later must be added in the Project Editor`);
    } else {
        sources = ['src'];
        notes.push('no compilable <Unit> entries — sources defaulted to "src", check them in the Project Editor');
    }

    // output name: the basename of the target output, if present
    let outputName = 'firmware';
    if (tgt && tgt.output) {
        const base = path.posix.basename(tgt.output.replace(/\\/g, '/')).replace(/\.[a-z]+$/i, '');
        if (base && base !== '.') {
            outputName = base.replace(/[/\\]/g, '') || 'firmware';
            notes.push(`target output "${tgt.output}" → output_name "${outputName}" (the directory stays build/ — our convention)`);
        }
    }

    const rawName = cbp.title || path.basename(root || '') || 'codeblocks-project';
    const sn = sanitizeName(rawName, 'codeblocks-project');
    if (sn.changed) notes.push(`project name "${rawName}" → "${sn.name}" (ASCII, Windows-safe)`);

    return {
        name: sn.name, boardId: picked.boardId, sources,
        includes: dedupe([...cl.includes, ...(tgt ? tgt.dirs : []), ...cbp.globalDirs]),
        defines: dedupe(cl.defines), flags: cl.rest, cxxFlags: [], linkFlags: link.rest,
        libraries: [], components: [], upload: { tool: 'avrdude' }, outputName, notes,
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// Parser 5: Eclipse CDT (.project + .cproject)
// ═════════════════════════════════════════════════════════════════════════════
function parseEclipseProjectFile(text) {
    const m = String(text || '').match(/<name>([^<]*)<\/name>/);
    return { name: m ? m[1].trim() : '' };
}

function parseEclipseCproject(text) {
    const t = String(text || '');
    const configs = [];
    const cfgRe = /<cconfiguration\b[^>]*>([\s\S]*?)<\/cconfiguration>/g;
    let m;
    while ((m = cfgRe.exec(t)) !== null) {
        const body = m[1];
        let name = '';
        const sm = body.match(/<storageModule[^>]*moduleId="org\.eclipse\.cdt\.core\.settings"[^>]*name="([^"]*)"/) ||
                   body.match(/<storageModule[^>]*name="([^"]*)"[^>]*moduleId="org\.eclipse\.cdt\.core\.settings"/);
        if (sm) name = decodeXml(sm[1]);
        const includes = [], defines = [];
        const incRe = /<option\b[^>]*valueType="includePath"[^>]*>([\s\S]*?)<\/option>/g;
        let om;
        while ((om = incRe.exec(body)) !== null)
            for (const lv of om[1].matchAll(/<listOptionValue\b[^>]*value="([^"]*)"/g)) includes.push(decodeXml(lv[1]).replace(/^"|"$/g, ''));
        const defRe = /<option\b[^>]*valueType="definedSymbols"[^>]*>([\s\S]*?)<\/option>/g;
        while ((om = defRe.exec(body)) !== null)
            for (const lv of om[1].matchAll(/<listOptionValue\b[^>]*value="([^"]*)"/g)) defines.push(decodeXml(lv[1]).replace(/^"|"$/g, ''));
        const sourcePaths = [];
        for (const e of body.matchAll(/<entry\b[^>]*kind="sourcePath"[^>]*name="([^"]*)"/g))
            sourcePaths.push(decodeXml(e[1]));
        // free-form option values ("-mmcu=…", "-DF_CPU=…", misc flags) — the
        // AVR plugin puts the MCU selection there
        const flagsSeen = [];
        for (const ov of body.matchAll(/<option\b[^>]*value="(-[^"]*)"/g)) flagsSeen.push(decodeXml(ov[1]));
        configs.push({ name, includes, defines, sourcePaths, flagsSeen });
    }
    return { configs };
}

function importEclipseCdt(cproj, projName, root) {
    const notes = [];
    let cfg = cproj.configs.find(c => /release/i.test(c.name || '')) || cproj.configs[0] || null;
    if (!cfg) {
        cfg = { name: '', includes: [], defines: [], sourcePaths: [], flagsSeen: [] };
        notes.push('.cproject has no readable <cconfiguration> — the draft is a skeleton, fill it in the Project Editor');
    } else if (cproj.configs.length > 1) {
        notes.push(`the .cproject has ${cproj.configs.length} configurations — imported "${cfg.name}" (Release preferred), the others were skipped`);
    }

    // -mmcu / -DF_CPU hide among the free-form option values
    const cl = classifyFlags(splitTokens((cfg.flagsSeen || []).join(' ')));
    const picked = pickMcu(cl.mcuHint);
    if (cl.mcuHint) notes.push(`-mmcu=${cl.mcuHint} → MCU "${picked.boardId}"`);
    else notes.push('no -mmcu=… option value found — the MCU is the default, set it in the Project Editor');
    if (picked.note) notes.push(picked.note);
    const bare = stripFcpuDefines(cfg.defines || []);
    const fcpu = cl.fcpu !== null ? cl.fcpu : bare.fcpu;
    const fn = fcpuNote(fcpu, picked.board);
    if (fn) notes.push(fn);
    if (cl.moved.length) notes.push(`MCU-level flags dropped (the board owns them here): ${cl.moved.join(' ')}`);

    // sources: CDT sourcePath entries (name "" = the project root itself).
    // NOTE: checked BEFORE dedupe — dedupe() filters empty strings, and ""
    // here is the legitimate "whole project root" marker.
    const sources = [];
    for (const sp of (cfg.sourcePaths || [])) {
        if (sp === '' || sp === '.') { if (sources.indexOf('.') === -1) sources.push('.'); }
        else sources.push(sp);
    }
    if (!sources.length) {
        sources.push('src');
        notes.push('no CDT sourcePath entries found — defaulted to "src", check it in the Project Editor');
    }

    // CDT managed-build option values beyond -mmcu/-DF_CPU are enum-ish
    // junk in this extraction — kept OUT of the draft and reported.
    if (cl.rest.length) notes.push(`${cl.rest.length} compiler option value(s) not migrated (${cl.rest.join(' ')}) — review the build flags in the Project Editor`);

    const rawName = projName || path.basename(root || '') || 'eclipse-project';
    const sn = sanitizeName(rawName, 'eclipse-project');
    if (sn.changed) notes.push(`project name "${rawName}" → "${sn.name}" (ASCII, Windows-safe)`);

    return {
        name: sn.name, boardId: picked.boardId, sources, includes: dedupe(cfg.includes || []),
        defines: dedupe([...bare.kept, ...cl.defines]), flags: [], cxxFlags: [], linkFlags: [],
        libraries: [], components: [], upload: { tool: 'avrdude' }, outputName: 'firmware', notes,
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// Draft assembly
// ═════════════════════════════════════════════════════════════════════════════
// parts → avr-project.json (the exact schema the create wizard writes —
// only the public fields; the import notes NEVER reach the file).
function assembleDraft(parts) {
    const proj = {
        name: parts.name,
        board: parts.boardId,
        toolchain: 'avr-gcc',
        sources: parts.sources,
        includes: parts.includes,
        defines: parts.defines,
    };
    if (parts.libraries && parts.libraries.length) proj.libraries = parts.libraries;
    if (parts.components && parts.components.length) proj.components = parts.components;
    proj.build = { output_dir: 'build', output_name: parts.outputName || 'firmware', hooks: {} };
    if (parts.flags && parts.flags.length) proj.build.c_flags = parts.flags;
    if (parts.cxxFlags && parts.cxxFlags.length) proj.build.cxx_flags = parts.cxxFlags;
    if (parts.linkFlags && parts.linkFlags.length) proj.build.link_flags = parts.linkFlags;
    proj.upload = parts.upload;
    return proj;
}

// The review summary riding on the QuickPick detail (design rule 3):
// aligned 10-column labels, MCU flagged as heuristic, everything skipped
// listed under Notes.
function buildSummary(proj, parts) {
    const lines = [
        `name:     ${proj.name}`,
        `mcu:      ${proj.board}  ← VERIFY (heuristic)`,
        `toolchain:${proj.toolchain}`,
        `sources:  ${JSON.stringify(proj.sources)}`,
        `includes: ${proj.includes.length ? proj.includes.join(', ') : '—'}`,
        `defines:  ${proj.defines.length ? proj.defines.join(', ') : '—'}`,
    ];
    const cxxSame = parts.cxxFlags && parts.cxxFlags.length &&
        JSON.stringify(parts.cxxFlags) === JSON.stringify(parts.flags);
    if (parts.flags && parts.flags.length) {
        lines.push(`flags:    ${parts.flags.join(' ')}` + (cxxSame ? ' (C and C++)' : ''));
    } else if (parts.cxxFlags && parts.cxxFlags.length) {
        lines.push(`flags:    ${parts.cxxFlags.join(' ')} (C++ only)`);
    }
    if (parts.linkFlags && parts.linkFlags.length) lines.push(`link:     ${parts.linkFlags.join(' ')}`);
    if (proj.libraries && proj.libraries.length) lines.push(`libs:     ${proj.libraries.join(', ')}`);
    if (proj.components && proj.components.length) lines.push(`comps:    ${proj.components.join(', ')}`);
    lines.push(`output:   ${proj.build.output_dir}/${proj.build.output_name}`);
    lines.push(`upload:   avrdude -c ${proj.upload.programmer || '?'}`);
    return lines.join('\n') + (parts.notes.length ? '\n\nNotes:\n• ' + parts.notes.join('\n• ') : '');
}

// ═════════════════════════════════════════════════════════════════════════════
// The interactive command
// ═════════════════════════════════════════════════════════════════════════════
async function cmdImportProject() {
    if (H.checkBusy()) return;
    // the multi-dialog import flow holds the busy latch — a second import's
    // final write (or any concurrent config write) resolving inside this
    // window would be a silent last-writer-wins on avr-project.json. The
    // flow releases the latch itself right after the draft is written; every
    // cancel/error return lands in the finally below.
    H.setBusy('Import');
    try {
        await importProjectFlow();
    } finally {
        if (H.getGlobalBusyName() === 'Import') H.clearBusy();
    }
}

// the import flow body — cmdImportProject above owns the busy latch
async function importProjectFlow() {

    // Step 1 — which IDE?
    const FORMATS = [
        { id: 'arduino',    label: '$(chip)  Arduino sketch — .ino', detail: 'board guess, sketch folder as sources (.ino compiles as C++), defines' },
        { id: 'platformio', label: '$(package)  PlatformIO — platformio.ini', detail: 'board → MCU, build_flags (-D/-I/…), src_filter, upload_protocol → programmer' },
        { id: 'makefile',   label: '$(settings-gear)  Makefile (classic AVR)', detail: 'MMCU/MCU, F_CPU, CFLAGS -D, AVRDUDE_PROGRAMMER/PORT/BAUDRATE, TARGET' },
        { id: 'codeblocks', label: '$(library)  Code::Blocks — *.cbp', detail: '-mmcu, include dirs, -D defines, sources' },
        { id: 'eclipse',    label: '$(feedback)  Eclipse CDT — .cproject', detail: '-mmcu, include paths, defined symbols' },
    ];
    const fmt = await vscode.window.showQuickPick(FORMATS, {
        title: 'AVR: Import Project — where does it come from?',
        placeHolder: 'Choose the source IDE (the project is imported IN PLACE — nothing moves)',
    });
    if (!fmt) return;

    // Step 2 — pick the project file (one dialog per format; the Makefile
    // dialog stays extension-less because filter extensions match lowercase
    // and "Makefile" HAS no extension — the title says what to pick)
    const DIALOGS = {
        arduino:    { title: 'AVR: Import — pick the .ino sketch', filters: { 'Arduino sketch': ['ino'], 'All files': ['*'] } },
        platformio: { title: 'AVR: Import — pick the platformio.ini', filters: { 'PlatformIO config': ['ini'], 'All files': ['*'] } },
        makefile:   { title: 'AVR: Import — pick the Makefile', filters: { 'All files': ['*'] } },
        codeblocks: { title: 'AVR: Import — pick the .cbp project file', filters: { 'Code::Blocks project': ['cbp'], 'All files': ['*'] } },
        eclipse:    { title: 'AVR: Import — pick the .cproject / .project file', filters: { 'Eclipse CDT project': ['cproject', 'project'], 'All files': ['*'] } },
    };
    const dialog = DIALOGS[fmt.id];
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        openLabel: 'Import This Project',
        title: dialog.title,
        filters: dialog.filters,
    });
    if (!picked || picked.length === 0) return;
    const file = picked[0].fsPath;
    const root = path.dirname(file);

    // Step 3 — parse (all failures land in a clear message, never a dead end)
    let parts;
    try {
        const text = fs.readFileSync(file, 'utf8');
        if (fmt.id === 'arduino') {
            if (path.extname(file).toLowerCase() !== '.ino') {
                vscode.window.showErrorMessage('AVR: pick an Arduino sketch (.ino).');
                return;
            }
            if (arduinoSketchIsNotAvr(file)) {
                vscode.window.showErrorMessage('AVR: this sketch looks like a non-AVR Arduino board (Due / MKR / Giga / Nano 33 / Uno R4 / ESP…) — avr-gcc cannot build it. Only AVR boards (Uno, Nano, Mega, Leonardo, ATtiny…) can be imported.');
                return;
            }
            parts = importArduinoSketch(file, root);
        } else if (fmt.id === 'platformio') {
            if (path.basename(file).toLowerCase() !== 'platformio.ini') {
                vscode.window.showErrorMessage(`AVR: "${path.basename(file)}" does not look like platformio.ini — pick the PlatformIO project file.`);
                return;
            }
            const ini = parsePlatformioIni(text);
            if (!ini.envs.length) {
                vscode.window.showErrorMessage('AVR: no [env:…] sections found in platformio.ini — nothing to import.');
                return;
            }
            // environment pick: a single default_envs entry is used silently;
            // otherwise the user chooses (defaults listed first)
            let envName = null;
            const defaults = splitTokens((ini.sections['platformio'] || {}).default_envs || '')
                .map(s => s.replace(/^env:/, ''));
            if (defaults.length === 1 && ini.envs.some(e => e.name === defaults[0])) {
                envName = defaults[0];
            } else if (ini.envs.length === 1) {
                envName = ini.envs[0].name;
            } else {
                const ordered = [...ini.envs].sort((a, b) => {
                    const da = defaults.indexOf(a.name), db = defaults.indexOf(b.name);
                    return (da === -1 ? 999 : da) - (db === -1 ? 999 : db);
                });
                const chosen = await vscode.window.showQuickPick(
                    ordered.map(e => ({ label: e.name, detail: `platform=${e.kv.platform || (ini.sections['platformio'] || {}).platform || '—'}  board=${e.kv.board || '—'}`, env: e.name })),
                    { title: 'AVR: Import — which environment?', placeHolder: `platformio.ini has ${ini.envs.length} [env:…] sections` });
                if (!chosen) return;
                envName = chosen.env;
            }
            parts = importPlatformIO(ini, envName, root);
        } else if (fmt.id === 'makefile') {
            const base = path.basename(file);
            if (!/makefile/i.test(base) && !/\.mk$/i.test(base)) {
                vscode.window.showErrorMessage(`AVR: "${base}" does not look like a Makefile — pick the classic AVR Makefile.`);
                return;
            }
            parts = importMakefile(text, root);
        } else if (fmt.id === 'codeblocks') {
            if (path.extname(file).toLowerCase() !== '.cbp') {
                vscode.window.showErrorMessage('AVR: pick a Code::Blocks project file (.cbp).');
                return;
            }
            const cbp = parseCodeblocksCbp(text);
            if (!cbp.targets.length && !cbp.globalOptions.length && !cbp.units.length) {
                vscode.window.showErrorMessage('AVR: this .cbp has no <Target>, no Compiler options and no <Unit> entries — nothing to import.');
                return;
            }
            parts = importCodeBlocks(cbp, root);
        } else {
            let cproj = null, projName = '';
            if (/\.cproject$/i.test(file)) {
                cproj = parseEclipseCproject(text);
                const pPath = path.join(root, '.project');
                if (fs.existsSync(pPath)) projName = parseEclipseProjectFile(fs.readFileSync(pPath, 'utf8')).name;
            } else if (/\.project$/i.test(file)) {
                projName = parseEclipseProjectFile(text).name;
                const cPath = path.join(root, '.cproject');
                if (fs.existsSync(cPath)) cproj = parseEclipseCproject(fs.readFileSync(cPath, 'utf8'));
                else {
                    vscode.window.showWarningMessage('AVR: no .cproject next to .project — include paths / defines cannot be migrated.');
                }
            } else {
                vscode.window.showErrorMessage('AVR: pick the Eclipse .cproject or .project file.');
                return;
            }
            parts = importEclipseCdt(cproj || { configs: [] }, projName, root);
        }
    } catch (e) {
        vscode.window.showErrorMessage(`AVR: import failed while reading "${path.basename(file)}": ${e.message}`);
        H.log(`[import] parse failed: ${e && e.stack || e}`);
        return;
    }

    const proj = assembleDraft(parts);

    // Step 4 — refuse silent overwrites
    const cfgPath = path.join(root, Validator.PROJECT_FILE);
    if (fs.existsSync(cfgPath)) {
        const ans = await vscode.window.showWarningMessage(
            `AVR: "${path.basename(root)}" already contains ${Validator.PROJECT_FILE} — import would REPLACE it.`,
            { modal: true }, 'Overwrite');
        if (ans !== 'Overwrite') return;
    }

    // Step 5 — summary → the user confirms with eyes open
    const summary = buildSummary(proj, parts);
    const go = await vscode.window.showQuickPick(
        // `detail` is the property VS Code actually renders — the summary
        // rides there so the whole "review with eyes open" step is visible
        [{ label: '$(check) Import', description: `→ ${cfgPath}`, detail: summary },
         { label: '$(x) Cancel' }],
        { title: 'AVR: Import — review the draft', placeHolder: 'MCU mapping and skipped pieces are listed in the detail below' });
    if (!go || go.label.includes('Cancel')) return;

    // Step 6 — write (guarded, exactly like the create wizard)
    try {
        fs.writeFileSync(cfgPath, JSON.stringify(proj, null, 2) + '\n');
    } catch (e) {
        vscode.window.showErrorMessage(`AVR: failed to write ${Validator.PROJECT_FILE} into "${root}": ${e.message}`);
        H.log(`[import] write failed: ${e.message}`);
        return;
    }
    H.log(`[import] draft ${Validator.PROJECT_FILE} written → ${cfgPath}`);
    for (const n of parts.notes) H.log(`[import] ${n}`);
    // draft written — release the busy latch NOW so every command works
    // again while the Project Editor below is open
    H.clearBusy();

    // Step 7 — adopt the folder (mirror the create-wizard post-steps)
    const rootUri = vscode.Uri.file(root);
    const alreadyOpen = !!(vscode.workspace.workspaceFolders || []).some(f => {
        const rel = path.relative(f.uri.fsPath, root);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    let added = false;
    if (!alreadyOpen) {
        const startIdx = vscode.workspace.workspaceFolders?.length || 0;
        try {
            added = vscode.workspace.updateWorkspaceFolders
                ? vscode.workspace.updateWorkspaceFolders(startIdx, 0,
                    { uri: rootUri, name: path.basename(root) })
                : false;
        } catch (e) { H.log(`[import] updateWorkspaceFolders threw: ${e.message}`); }
        if (!added) H.log('[import] updateWorkspaceFolders did not accept the folder — continuing anyway');
    }

    H.setActiveRoot(root);
    try { H.getCtx()?.workspaceState?.update('avrActiveRoot', root); } catch {}
    Boards.invalidate();
    if (H.getProvider()) H.getProvider().refresh();
    try { require('./memoryView').reloadFromDisk(); } catch (e) { H.log(`[import] memory view reload failed: ${e.message}`); }

    // updateWorkspaceFolders registers the folder ASYNCHRONOUSLY — the
    // tasks.json / launch.json syncs on the next microtask race it (their
    // owning-folder lookup walks workspace.workspaceFolders → null → a
    // silent no-op). Wait for onDidChangeWorkspaceFolders to surface the
    // folder (bounded 2.5 s), with one delayed retry if the event never
    // fires, then run the remaining syncs.
    const folderVisible = () => {
        try { return !!(vscode.workspace.getWorkspaceFolder && vscode.workspace.getWorkspaceFolder(rootUri)); }
        catch { return false; }
    };
    const waitFolder = (ms) => new Promise(res => {
        if (folderVisible()) return res(true);
        let sub = null;
        const done = () => { clearTimeout(timer); if (sub) { try { sub.dispose(); } catch {} } res(folderVisible()); };
        const timer = setTimeout(done, ms);
        try { sub = vscode.workspace.onDidChangeWorkspaceFolders(() => { if (folderVisible()) done(); }); } catch {}
    });
    (async () => {
        if (!folderVisible() && !await waitFolder(2500)) {
            await new Promise(r => setTimeout(r, 1000));   // event never fired — one delayed retry
        }
        if (!folderVisible()) H.log('[import] the imported folder did not surface in workspace.workspaceFolders — tasks/launch.json sync deferred to the next project reselect');
        try { await require('./intellisense').syncAfterProjectChange(); } catch (e) { H.log(`[import] intellisense sync failed: ${e.message}`); }
        try { require('./tasks').syncAfterProjectChange(); } catch (e) { H.log(`[import] tasks sync failed: ${e.message}`); }
        try { require('./launchJson').syncAfterProjectChange(); } catch (e) { H.log(`[import] launch.json sync failed: ${e.message}`); }
    })().catch(e => H.log('[import] post-import sync failed: ' + (e && e.message || e)));

    // the import is a DRAFT — open it in the Project Editor for review
    try { require('./projectEditor').openProjectEditor(); } catch (e) { H.log(`[import] opening the Project Editor failed: ${e.message}`); }

    vscode.window.showInformationMessage(
        `✅ Imported "${proj.name}" from ${fmt.id} (MCU: ${proj.board})` +
        (alreadyOpen ? ' — the folder was already open in the workspace.' : ' and added to the workspace.') +
        ' Review it in the Project Editor.'
    );
    H.log(`[import] project imported from ${fmt.id}: ${root} (MCU: ${proj.board}, already open: ${alreadyOpen}, added: ${added})`);
}

module.exports = { cmdImportProject };
