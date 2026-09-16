'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// toolchain.js — detection & health of the AVR toolchain.
//   avr.toolchainPath setting → PATH → common install locations
//   (Arduino IDE bundled avr-gcc, Microchip Studio, WinAVR, Atmel AVR Toolchain
//   for Linux, CrossPack/macOS, homebrew). Every utility from utilsData.js is
//   resolved to a concrete path (or marked missing) and cached for the views.
//   v0.2.1: user-set/picked folders are probed for NESTED layouts too.
//   v0.3.1: verified against the REAL distributions (downloaded & inspected):
//     • ZakKemble avr-gcc-build 16.1.0 x64 Windows zip → the extracted
//       avr-gcc-16.1.0-x64-windows/ has bin/avr-gcc.exe at the ROOT of the
//       pick (plus avrdude.exe, make.exe, avr-gdb.exe in the same bin/ and
//       avr-libc at avr/include) — covered by the plain bin/ probe;
//     • Microchip XC8 v4.00 Windows tar.xz → the extracted xc8-v4.00/ has
//       bin/xc8-cc.exe at the ROOT of the pick (plus a full GCC-based AVR
//       backend at avr/bin/avr-gcc.exe and PIC backend at pic/);
//   plus a bounded DEEP scan (BFS ≤ 4 levels) so ANY nesting is captured.
// ─────────────────────────────────────────────────────────────────────────────
const vscode   = require('vscode');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const cp       = require('child_process');
const H        = require('./helpers');
const U        = require('./utilsData');

const IS_WIN = H.IS_WIN;
const EXE = IS_WIN ? '.exe' : '';

function _stat(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function _isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function _which(bareName) {
    try {
        const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
        const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
        for (const d of dirs) for (const e of exts) {
            const c = path.join(d, bareName + e);
            if (_stat(c)) return c;
        }
    } catch {}
    return null;
}

// ─── Common install locations (best-effort candidates) ───────────────────────
function _xc8VersionDirs() {
    // XC8 installs under <root>/xc8/v<version>/bin — probe every v* folder
    const out = [];
    const roots = IS_WIN
        ? ['C:\\Program Files\\Microchip\\xc8', 'C:\\Program Files (x86)\\Microchip\\xc8']
        : (process.platform === 'darwin'
            ? ['/Applications/microchip/xc8']
            : ['/opt/microchip/xc8']);
    for (const r of roots) {
        try {
            const vers = fs.readdirSync(r).filter(n => /^v/i.test(n))
                .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
            for (const v of vers) {
                const b = path.join(r, v, 'bin');
                if (_isDir(b)) out.push(b);
            }
        } catch {}
    }
    return out;
}

function _candidateDirs() {
    const out = [];
    const home = os.homedir();
    if (IS_WIN) {
        out.push(
            'C:\\avr8-gnu-toolchain-win32_x86_64\\bin',
            'C:\\avr8-gnu-toolchain-win32_x86_64\\avr\\bin',
            'C:\\Program Files\\avr8-gnu-toolchain-win32_x86_64\\bin',
            path.join(home, 'AppData\\Local\\avr8-gnu-toolchain-win32_x86_64\\bin'),
            'C:\\WinAVR-20100110\\bin',
            'C:\\Program Files (x86)\\WinAVR-20100110\\bin',
            'C:\\Program Files (x86)\\Arduino\\hardware\\tools\\avr\\bin',
            path.join(home, 'AppData\\Local\\Arduino15\\packages\\arduino\\tools\\avr-gcc\\7.3.0-atmel3.6.1-arduino5\\bin'),
            'C:\\Program Files (x86)\\Microchip Studio\\7.0\\toolchain\\avr8\\avr8-gnu-toolchain\\bin',
            'C:\\Program Files\\Microchip Studio\\7.0\\toolchain\\avr8\\avr8-gnu-toolchain\\bin'
        );
        // Arduino15 — any avr-gcc version folder
        const pkgRoot = path.join(home, 'AppData\\Local\\Arduino15\\packages\\arduino\\tools\\avr-gcc');
        try {
            for (const v of fs.readdirSync(pkgRoot)) {
                const b = path.join(pkgRoot, v, 'bin');
                if (_isDir(b)) out.push(b);
            }
        } catch {}
    } else {
        out.push(
            '/usr/bin', '/usr/local/bin', '/opt/avr/bin',
            '/usr/lib/avr/bin',
            path.join(home, '.local/bin'),
            '/opt/homebrew/bin',                       // macOS Apple Silicon
            '/usr/local/bin', '/opt/local/bin',        // macOS Intel / macports
            '/usr/local/CrossPack-AVR/bin',
            path.join(home, '.arduino15/packages/arduino/tools/avr-gcc')  // probed recursively below
        );
        try {
            const pkgRoot = path.join(home, '.arduino15/packages/arduino/tools/avr-gcc');
            for (const v of fs.readdirSync(pkgRoot)) {
                const b = path.join(pkgRoot, v, 'bin');
                if (_isDir(b)) out.push(b);
            }
        } catch {}
    }
    return out.filter(_isDir);
}

// Resolve the toolchain base: the setting can be the compiler executable,
// the bin dir, the prefix dir, or a distribution root with a NESTED bin
// (Zak-Kemble root/avr-gcc/bin, …/avr/bin, any subdir with bin/avr-gcc).
function _resolveSettingBase() {
    const raw = String(H.cfg('toolchainPath') || '').trim();
    if (!raw) return null;
    if (_stat(raw)) {
        // executable (…/bin/avr-gcc) or a file — its dir
        return path.dirname(raw);
    }
    if (!_isDir(raw)) return null;
    for (const d of _gccProbeDirs(raw)) {
        if (_probeGcc(d)) return d;   // the bin dir where avr-gcc actually sits
    }
    return raw;   // nothing verified — legacy fallback so companions are still
                  // searched in the folder ("Use anyway" picks, odd prefixes)
}

function _probeGcc(dir) {
    if (!dir) return null;
    // Windows: probe avr-gcc.exe AND the bare name (some distributions ship
    // extension-less launchers); elsewhere EXE === '' so 'avr-gcc' is it.
    for (const n of _gccExeNames()) {
        const c = path.join(dir, n);
        if (_stat(c)) return c;
    }
    // legacy evidence: a lone avr-g++ still marks a bin dir
    for (const n of (IS_WIN ? ['avr-g++.exe', 'avr-g++'] : ['avr-g++'])) {
        if (_stat(path.join(dir, n))) return path.join(dir, _gccExeNames()[0]);
    }
    return null;
}

// ─── Version helpers ─────────────────────────────────────────────────────────
function _runCapture(exe, args, timeoutMs = 8000) {
    try {
        const r = cp.spawnSync(exe, args, { timeout: timeoutMs, encoding: 'utf8', windowHide: true });
        if (r.error) return null;
        return { stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), status: r.status };
    } catch { return null; }
}
// Resolve the XC8 base: the xc8-cc executable, the bin dir, the install
// dir, or a distribution root with a NESTED bin (root/v*/bin, root/xc8/bin,
// root/xc8/v*/bin — the Microchip XC8 v4 layouts).
function _resolveXc8Base() {
    const raw = String(H.cfg('xc8.path') || '').trim();
    if (!raw) return null;
    if (_stat(raw)) return path.dirname(raw);      // the executable itself
    if (!_isDir(raw)) return null;
    for (const d of _xc8ProbeDirs(raw)) {
        if (_probeXc8(d)) return d;                // the bin dir where xc8-cc sits
    }
    return raw;   // legacy fallback — keep companions searchable in the folder
}

function _probeXc8(dir) {
    if (!dir) return null;
    for (const n of _xc8ExeNames()) {
        const c = path.join(dir, n);
        if (_stat(c)) return c;
    }
    return null;
}

// ─── v0.2.1: nested-layout folder probing ────────────────────────────────────
// User-reported picks the old one-level probe missed. Layouts verified
// against the REAL archives in v0.3.1:
//   • avr-gcc-16.1.0-x64-windows (ZakKemble zip) — bin/avr-gcc.exe sits
//     directly in the picked root, with avrdude/make/avr-gdb next to it;
//   • xc8-v4.00 (Microchip XC8 v4 tar.xz) — bin/xc8-cc.exe directly in the
//     picked root; older XC8 2.x installs use root/v2.xx/bin instead.
// _gccProbeDirs/_xc8ProbeDirs return ordered bin-dir candidates for a
// user-picked (or user-set) root; every entry is verified by the caller with
// _probeGcc/_probeXc8 — the first hit wins; when NOTHING fast matches, the
// bounded deep scan (_deepScan) appends any hit from deeper levels.

const SCAN_MAX = 40;   // cap for one-level subfolder scans (40×40 two-level)

// ─── v0.3.1: bounded deep scan ───────────────────────────────────────────────
// BFS over the directory tree of a picked/set root, looking for the probe's
// executable in ANY subdirectory (depth ≤ DEEP_MAX_DEPTH, ≤ DEEP_MAX_DIRS
// directories visited, noisy folders skipped). Handles every nesting users
// produce — extracted archives inside subfolders, tools/<dist>/bin, etc.
const DEEP_MAX_DEPTH = 4;
const DEEP_MAX_DIRS  = 300;
const DEEP_SKIP = new Set([
    'lib', 'libexec', 'share', 'doc', 'docs', 'info', 'man', 'include',
    'manifest', 'node_modules', 'examples', 'samples', 'windows',
    'program files', 'program files (x86)', 'programdata', 'appdata',
    '$recycle.bin', 'system volume information', 'recycler', 'temp', 'tmp',
    'cache', 'caches', '.git', '.vscode', '.vs', 'test', 'tests',
]);

// Returns { dir, exe } for the first directory whose direct content matches
// probeFn (probeFn returns the executable path or null), or null.
function _deepScan(rootDir, probeFn) {
    if (!rootDir || !_isDir(rootDir)) return null;
    let visited = 0;
    const queue = [{ d: rootDir, depth: 0 }];
    while (queue.length && visited < DEEP_MAX_DIRS) {
        const { d, depth } = queue.shift();
        visited++;
        if (depth >= DEEP_MAX_DEPTH) continue;
        let names;
        try { names = fs.readdirSync(d); } catch { continue; }
        const subs = [];
        for (const n of names) {
            if (n.startsWith('.')) continue;
            if (DEEP_SKIP.has(n.toLowerCase())) continue;
            const full = path.join(d, n);
            if (!_isDir(full)) continue;
            subs.push(full);
        }
        subs.sort((a, b) => a.localeCompare(b, 'en'));
        for (const sub of subs.slice(0, 60)) {
            const exe = probeFn(sub);
            if (exe) {
                H.log(`[toolchain] deep scan: found ${path.basename(exe)} in ${sub}`);
                return { dir: sub, exe };
            }
            queue.push({ d: sub, depth: depth + 1 });
        }
    }
    return null;
}

function _samePath(a, b) {
    return IS_WIN ? String(a).toLowerCase() === String(b).toLowerCase()
                  : String(a) === String(b);
}
function _gccExeNames() { return IS_WIN ? ['avr-gcc.exe', 'avr-gcc'] : ['avr-gcc']; }
function _xc8ExeNames() { return IS_WIN ? ['xc8-cc.exe', 'xc8-cc'] : ['xc8-cc']; }

// Direct subdirectory names of dir (alphabetical, capped) — best-effort.
function _subDirs(dir, max = SCAN_MAX) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const n of names.sort((a, b) => a.localeCompare(b, 'en'))) {
        if (_isDir(path.join(dir, n))) out.push(n);
        if (out.length >= max) break;
    }
    return out;
}

// Ordered candidate bin-dirs for an avr-gcc root: the folder itself, bin/,
// the known nested layouts, then every subdir whose bin/ holds avr-gcc.
function _gccProbeDirs(dir) {
    const out = [];
    const push = (d) => { if (d && !out.some(x => _samePath(x, d))) out.push(d); };
    push(dir);
    push(path.join(dir, 'bin'));
    push(path.join(dir, 'avr-gcc', 'bin'));            // Zak-Kemble layout
    push(path.join(dir, 'avr', 'bin'));
    push(path.join(dir, 'avr8-gnu-toolchain', 'bin'));
    for (const sub of _subDirs(dir)) {                 // one-level scan
        const b = path.join(dir, sub, 'bin');
        if (_probeGcc(b)) push(b);
    }
    // v0.3.1: nothing fast matched → bounded deep scan of the whole tree
    if (!out.some(d => _probeGcc(d))) {
        H.log(`[toolchain] fast probes missed in "${dir}" — running deep scan…`);
        const hit = _deepScan(dir, _probeGcc);
        if (hit) push(hit.dir);
    }
    return out.filter(_isDir);
}

// Ordered candidate bin-dirs for an XC8 root: the folder itself, bin/,
// v*/bin (version dirs, newest first), xc8/bin/, then one- and two-level
// subfolder scans — covers root/bin, root/v4.00/bin, root/xc8/v4.00/bin and
// root/xc8-v4.00/bin shapes.
function _xc8ProbeDirs(dir) {
    const out = [];
    const push = (d) => { if (d && !out.some(x => _samePath(x, d))) out.push(d); };
    push(dir);
    push(path.join(dir, 'bin'));
    for (const v of _subDirs(dir).filter(n => /^v/i.test(n))
            .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))) {
        push(path.join(dir, v, 'bin'));                // version dirs first
    }
    push(path.join(dir, 'xc8', 'bin'));
    const subs = _subDirs(dir);
    for (const sub of subs) {                          // one-level scan
        const b = path.join(dir, sub, 'bin');
        if (_probeXc8(b)) push(b);
    }
    for (const s1 of subs) {                           // two-level scan (≤40×40)
        for (const s2 of _subDirs(path.join(dir, s1))) {
            const b = path.join(dir, s1, s2, 'bin');
            if (_probeXc8(b)) push(b);
        }
    }
    // v0.3.1: nothing fast matched → bounded deep scan of the whole tree
    if (!out.some(d => _probeXc8(d))) {
        H.log(`[toolchain] fast probes missed in "${dir}" — running deep scan…`);
        const hit = _deepScan(dir, _probeXc8);
        if (hit) push(hit.dir);
    }
    return out.filter(_isDir);
}

// ─── v0.2.1: candidate listing (sdcc-mdf findAllCandidates style) ────────────
// Every detected location with its source — feeds the Select Toolchain /
// Select XC8 Compiler QuickPicks. detect() itself keeps the first hit of its
// own priority chain (setting → PATH → standard locations), unchanged.
function findAllGccCandidates() {
    const candidates = [];
    const seen = new Set();
    const push = (p, source) => {
        if (!p) return;
        const key = IS_WIN ? String(p).toLowerCase() : String(p);
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ path: p, source });
    };

    // 1. manual setting — the executable itself, or avr-gcc anywhere in the
    //    probed folder tree (nested Zak-Kemble layouts included)
    const manual = String(H.cfg('toolchainPath') || '').trim();
    if (manual && _stat(manual)) {
        push(manual, 'manual setting');
    } else if (manual && _isDir(manual)) {
        for (const d of _gccProbeDirs(manual)) {
            const g = _probeGcc(d);
            if (g) push(g, 'manual setting');
        }
    }

    // 2. PATH scan
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        for (const n of _gccExeNames()) {
            if (_stat(path.join(dir, n))) push(path.join(dir, n), 'PATH');
        }
    }

    // 3. standard install locations
    for (const dir of _candidateDirs()) {
        const g = _probeGcc(dir);
        if (g) push(g, 'standard location');
    }
    return candidates;
}

function findAllXc8Candidates() {
    const candidates = [];
    const seen = new Set();
    const push = (p, source) => {
        if (!p) return;
        const key = IS_WIN ? String(p).toLowerCase() : String(p);
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ path: p, source });
    };

    // 1. manual xc8.path — the executable itself, or xc8-cc anywhere in the
    //    probed folder tree (nested XC8 v4 layouts included)
    const manual = String(H.cfg('xc8.path') || '').trim();
    if (manual && _stat(manual)) {
        push(manual, 'manual setting');
    } else if (manual && _isDir(manual)) {
        for (const d of _xc8ProbeDirs(manual)) {
            const x = _probeXc8(d);
            if (x) push(x, 'manual setting');
        }
    }

    // 2. PATH scan
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        for (const n of _xc8ExeNames()) {
            if (_stat(path.join(dir, n))) push(path.join(dir, n), 'PATH');
        }
    }

    // 3. standard install locations (versioned XC8 dirs)
    for (const dir of _xc8VersionDirs()) {
        const x = _probeXc8(dir);
        if (x) push(x, 'standard location');
    }
    return candidates;
}

function _gccVersion(exe) {
    const r = _runCapture(exe, ['--version']);
    if (!r) return '';
    const m = /avr-gcc[^(]*\((?:GNU|Microchip)?[^)]*\)\s*([\d.]+)/.exec(r.stdout) || /(\d+\.\d+\.\d+)/.exec(r.stdout);
    return m ? m[1] : '';
}
function _avrdudeVersion(exe) {
    // avrdude -? exits non-zero but prints the version banner
    const r = _runCapture(exe, ['-?']) || _runCapture(exe, ['-v']);
    if (!r) return '';
    const m = /avrdude[^0-9]*version\s+([\d.]+)/i.exec(r.stderr || r.stdout);
    return m ? m[1] : '';
}
function _gdbVersion(exe) {
    const r = _runCapture(exe, ['--version']);
    if (!r) return '';
    const m = /GNU gdb[^(]*\(([^)]*)\)\s*([\d.]+)/.exec(r.stdout) || /(\d+\.\d+)/.exec(r.stdout);
    return m ? (m[2] || m[1]) : '';
}
function _simavrVersion(exe) {
    const r = _runCapture(exe, ['--help']);
    if (!r) return '';
    const m = /simavr\s+([\d.]+)/i.exec(r.stdout + r.stderr);
    return m ? m[1] : '';
}

function _xc8Version(exe) {
    // xc8-cc can be slow to cold-start (device DB init) — allow 15s
    const r = _runCapture(exe, ['--version'], 15000) || _runCapture(exe, ['-V'], 15000);
    if (!r) return '';
    const m = /(?:xc8-cc[^\d]*|MPLAB XC8[^\d]*|version[^\d]*)(v?\d+\.\d+(?:\.\d+)?)/i.exec(r.stdout + r.stderr);
    return m ? m[1].replace(/^v/i, '') : '';
}

// XC8 include dirs for IntelliSense: probe the install layout.
// xc8-cc finds them itself, but cpptools wants explicit paths.
// v0.3.3: avr/avr/include FIRST — in the real xc8-v4.00 layout that is the
// GCC AVR backend's avr-libc (avr/io.h, util/delay.h…); avr/include only
// holds host-side gdb/libiberty headers.
function _xc8IncludeDirs(binDir) {
    if (!binDir) return [];
    const root = path.dirname(binDir);   // <…>/xc8/v2.46/bin → v2.46
    const cands = [
        path.join(root, 'avr', 'avr', 'include'),   // v4 GCC AVR backend avr-libc
        path.join(root, 'include'),
        path.join(root, 'avr', 'include'),
        path.join(root, 'pic', 'include'),
        path.join(path.dirname(root), 'include'),
    ];
    return cands.filter(c => { try { return fs.statSync(c).isDirectory(); } catch { return false; } });
}

// XC8 companion modules (utilsData XC8_GROUPS) resolved against the REAL
// xc8-v4.00 layout: root/bin (xc8-* drivers + avr-/pic-objcopy front ends),
// root/avr/bin (the GCC AVR backend), root/avr/avr/bin (its binutils),
// root/pic/bin (the PIC backend). Each group probes its own dir first, then
// falls back to root/bin — so the Development Tools view shows the same
// live found/total stats for XC8 as it does for avr-gcc.
function _xc8Modules(xc8BinDir) {
    const mods = {};
    if (!xc8BinDir) return mods;
    const root = path.dirname(xc8BinDir);
    const U = require('./utilsData');
    for (const g of U.XC8_GROUPS) {
        const dirs = [path.join(root, ...String(g.dir).split('/')), xc8BinDir];
        for (const it of g.items) {
            for (const d of dirs) {
                const c = path.join(d, it.name + EXE);
                if (_stat(c)) { mods[it.name] = c; break; }
            }
        }
    }
    return mods;
}

// avr-libc include dir: <prefix>/avr/include, or `avr-gcc -print-file-name=include`
function _resolveAvrInclude(gccExe, binDir) {
    const prefix = path.dirname(binDir);   // <prefix>/bin → <prefix>
    const candidates = [
        path.join(prefix, 'avr', 'include'),
        // Debian/Ubuntu style split packaging
        '/usr/lib/avr/include',
        '/usr/avr/include',
        path.join(prefix, 'include'),   // some self-built trees
    ];
    for (const c of candidates) {
        try {
            if (fs.statSync(c).isDirectory() && _stat(path.join(c, 'avr', 'io.h'))) return c;
        } catch {}
    }
    const r = _runCapture(gccExe, ['-print-file-name=include']);
    if (r && r.stdout) {
        const p = r.stdout.trim();
        if (p && p !== 'include' && _stat(path.join(p, 'avr', 'io.h'))) return p;
    }
    return null;
}
// avr libc lib dir (for -L / knowledge): <prefix>/avr/lib
function _resolveAvrLib(binDir) {
    const prefix = path.dirname(binDir);
    for (const c of [path.join(prefix, 'avr', 'lib'), '/usr/lib/avr/lib', '/usr/avr/lib']) {
        if (_isDir(c)) return c;
    }
    return null;
}

// ─── detect() — the whole cache ──────────────────────────────────────────────
function detect() {
    const cached = H.getToolchainCache();
    if (cached && cached.stamp === _stamp()) return cached;

    const tc = {
        stamp: _stamp(),
        gcc: null, gccVersion: '',
        binDir: null,
        includeDir: null,   // avr-libc headers
        libDir: null,
        avrdude: null, avrdudeVersion: '',
        simavr: null, simavrVersion: '',
        avrgdb: null, gdbVersion: '',
        avarice: null,
        make: null,
        modules: {},        // name → path (from utilsData)
        // Microchip XC8 (the alternative toolchain — the switch target)
        xc8: null, xc8Version: '', xc8BinDir: null, xc8IncludeDirs: [],
        xc8Modules: {},    // XC8 catalogue name → path (utilsData XC8_GROUPS)
    };

    // 1) locate avr-gcc
    const settingBase = _resolveSettingBase();
    if (settingBase) {
        const g = _probeGcc(settingBase);
        if (g) { tc.gcc = g; tc.binDir = path.dirname(g); }
    }
    if (!tc.gcc) {
        const w = _which('avr-gcc');
        if (w) { tc.gcc = w; tc.binDir = path.dirname(w); }
    }
    if (!tc.gcc) {
        for (const dir of _candidateDirs()) {
            const g = _probeGcc(dir);
            if (g) { tc.gcc = g; tc.binDir = path.dirname(g); break; }
        }
    }

    // 2) companions in the toolchain bin dir
    const searchDirs = tc.binDir ? [tc.binDir] : [];
    if (settingBase) searchDirs.push(settingBase);
    const resolveIn = (name) => {
        for (const d of searchDirs) {
            const c = path.join(d, name + EXE);
            if (_stat(c)) return c;
        }
        return _which(name);
    };
    for (const name of U.ALL) {
        let override = null;
        if (name === 'avrdude') override = H.cfg('avrdudePath');
        if (name === 'simavr')  override = H.cfg('simavrPath');
        if (name === 'avr-gdb') override = H.cfg('gdbPath') || H.cfg('debug.gdbPath');
        if (override && _stat(String(override))) {
            tc.modules[name] = String(override);
            continue;
        }
        if (name === 'simavr') {
            const dbg = H.cfg('debug.simPath');
            if (dbg && _stat(String(dbg))) { tc.modules[name] = String(dbg); continue; }
        }
        const p = resolveIn(name);
        if (p) tc.modules[name] = p;
    }

    // 3) metadata
    if (tc.gcc) {
        tc.gccVersion = _gccVersion(tc.gcc);
        tc.includeDir = _resolveAvrInclude(tc.gcc, tc.binDir);
        tc.libDir = _resolveAvrLib(tc.binDir);
    }

    // 2b) Microchip XC8 (xc8-cc) — the alternative toolchain
    const xc8Base = _resolveXc8Base();
    if (xc8Base) {
        const x = _probeXc8(xc8Base);
        if (x) { tc.xc8 = x; tc.xc8BinDir = path.dirname(x); }
    }
    if (!tc.xc8) {
        const w = _which('xc8-cc');
        if (w) { tc.xc8 = w; tc.xc8BinDir = path.dirname(w); }
    }
    if (!tc.xc8) {
        for (const dir of _xc8VersionDirs()) {
            const x = _probeXc8(dir);
            if (x) { tc.xc8 = x; tc.xc8BinDir = dir; break; }
        }
    }
    if (tc.xc8) {
        tc.xc8Version = _xc8Version(tc.xc8);
        tc.xc8IncludeDirs = _xc8IncludeDirs(tc.xc8BinDir);
        tc.xc8Modules = _xc8Modules(tc.xc8BinDir);
    }
    if (tc.modules['avrdude']) tc.avrdude = tc.modules['avrdude'];
    if (tc.avrdude) tc.avrdudeVersion = _avrdudeVersion(tc.avrdude);
    if (tc.modules['simavr']) { tc.simavr = tc.modules['simavr']; tc.simavrVersion = _simavrVersion(tc.simavr); }
    if (tc.modules['avr-gdb']) { tc.avrgdb = tc.modules['avr-gdb']; tc.gdbVersion = _gdbVersion(tc.avrgdb); }
    if (tc.modules['avarice']) tc.avarice = tc.modules['avarice'];
    if (tc.modules['make']) tc.make = tc.modules['make'];

    H.setToolchainCache(tc);
    H.log(`[toolchain] avr-gcc: ${tc.gcc || 'NOT FOUND'}${tc.gccVersion ? ' v' + tc.gccVersion : ''}` +
        (tc.includeDir ? `, libc include: ${tc.includeDir}` : ', libc include: not found'));
    H.log(`[toolchain] XC8: ${tc.xc8 || 'not found'}${tc.xc8Version ? ' v' + tc.xc8Version : ''}` +
        (tc.xc8 ? `, modules: ${Object.keys(tc.xc8Modules).length}/${require('./utilsData').XC8_ALL.length}` : ''));
    if (tc.avrdude) H.log(`[toolchain] avrdude: ${tc.avrdude}${tc.avrdudeVersion ? ' v' + tc.avrdudeVersion : ''}`);
    if (tc.simavr)  H.log(`[toolchain] simavr: ${tc.simavr}`);
    if (tc.avrgdb)  H.log(`[toolchain] avr-gdb: ${tc.avrgdb}`);
    return tc;
}
function invalidate() { H.setToolchainCache(null); }

let _stampCache = null;
function _stamp() {
    if (_stampCache) return _stampCache;
    _stampCache = JSON.stringify([
        H.cfg('toolchainPath'), H.cfg('avrdudePath'), H.cfg('simavrPath'),
        H.cfg('gdbPath'), H.cfg('debug.gdbPath'), H.cfg('debug.simPath'),
        H.cfg('xc8.path'),
    ]);
    // allow later invalidation on settings change
    setTimeout(() => { _stampCache = null; }, 0).unref?.();
    return _stampCache;
}

// ─── Actionable "not found" helpers ──────────────────────────────────────────
function requireGcc() {
    const tc = detect();
    if (tc.gcc) return tc;
    vscode.window.showErrorMessage(
        'AVR: avr-gcc not found. Install the AVR toolchain (or point AVR-MDF to it).',
        'Select Toolchain', 'Open Docs'
    ).then(a => {
        if (a === 'Select Toolchain') vscode.commands.executeCommand('avr.selectToolchain');
    });
    return null;
}
function requireXc8() {
    const tc = detect();
    if (tc.xc8) return tc;
    vscode.window.showErrorMessage(
        'AVR: Microchip XC8 (xc8-cc) not found. Install MPLAB XC8 (it compiles AVR and PIC 8-bit devices) or select its install folder.',
        'Select XC8 Path', 'Stay on avr-gcc'
    ).then(a => {
        if (a === 'Select XC8 Path') vscode.commands.executeCommand('avr.selectXc8Path');
    });
    return null;
}
function requireAvrdude() {
    const tc = detect();
    if (tc.avrdude) return tc;
    vscode.window.showErrorMessage(
        'AVR: avrdude not found. Install avrdude (the toolchain folder and PATH are auto-checked).',
        'Select Toolchain'
    ).then(a => {
        if (a === 'Select Toolchain') vscode.commands.executeCommand('avr.selectToolchain');
    });
    return null;
}

// ─── Select toolchain command (sdcc-mdf cmdSelectToolchain pattern) ──────────
// 1. QuickPick lists every detected avr-gcc location (manual setting, PATH,
//    standard install dirs) with its source;
// 2. "Browse for the avr-gcc executable…" — native open-file dialog;
// 3. "Browse for the toolchain folder…" — native open-folder dialog; the
//    folder is validated via _gccProbeDirs (nested Zak-Kemble layouts
//    included) and the RESOLVED EXE is persisted — not the folder — so the
//    next detect() is unambiguous; an unmatched folder can still be stored
//    via the "Use anyway" fallback;
// 4. "Clear manual path" — back to auto-detection.
// v0.3.2 (111.jpg, red annotation «ВОТ ЭТИ КОМАНДЫ ИЗЛИШНЕ ИХ МОЖНО УБРАТЬ»):
// the extra "Detect BOTH compilers…" deep-scan entry is GONE from the pick —
// the deep scan itself stays inside _resolveGccFromFolder, so picking the
// dist folder still captures nested layouts; the flow is now the exact
// sdcc-mdf shape: candidates → browse file → browse folder → clear.
async function cmdSelectToolchain() {
    const candidates = findAllGccCandidates();
    const tc = detect();
    const items = candidates.map(c => ({
        label: `$(folder-opened) ${c.path}`,
        description: c.source,
        picked: !!tc.gcc && _samePath(c.path, tc.gcc),
        pick: c.path,
    }));
    items.push({ label: '$(file) Browse for the avr-gcc executable…', browse: 'file' });
    items.push({ label: '$(folder-opened) Browse for the toolchain folder…', browse: 'folder' });
    const manual = String(H.cfg('toolchainPath') || '').trim();
    if (manual) items.push({ label: '$(close) Clear manual path (use auto-detect)', browse: 'clear' });

    const picked = await vscode.window.showQuickPick(items, {
        title: 'AVR-MDF › Select avr-gcc Toolchain',
        placeHolder: candidates.length
            ? `Detected ${candidates.length} avr-gcc location(s) — or browse`
            : 'avr-gcc not detected — browse for the executable or folder',
        matchOnDescription: true,
    });
    if (!picked) return null;

    let chosen = null;
    if (picked.browse === 'file') {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
            openLabel: 'Select avr-gcc executable',
            title: 'AVR-MDF: select the avr-gcc executable (e.g. …\\avr-gcc-16.1.0-x64-windows\\bin\\avr-gcc.exe)',
            filters: IS_WIN
                ? { 'avr-gcc executable': ['exe'], 'All files': ['*'] }
                : { 'All files': ['*'] },
        });
        if (!uris || !uris.length) return null;
        chosen = uris[0].fsPath;
    } else if (picked.browse === 'folder') {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            openLabel: 'Select toolchain folder',
            title: 'AVR-MDF: select the toolchain folder — the extracted avr-gcc-16.1.0-x64-windows (bin\\avr-gcc.exe inside) or any parent of it',
        });
        if (!uris || !uris.length) return null;
        chosen = await _resolveGccFromFolder(uris[0].fsPath);
        if (!chosen) return null;
    } else if (picked.browse === 'clear') {
        await H.setCfg('toolchainPath', '');
        H.log('[toolchain] toolchainPath cleared');
        return _finishToolchainChange(null);
    } else {
        chosen = picked.pick;   // a detected candidate executable
    }
    return _finishToolchainChange(chosen);
}

// Validate a picked folder: fast probes first (bin/, avr-gcc/bin/, one
// level of subfolders), then the bounded deep scan (≤ 4 levels, ANY nesting).
// Returns the RESOLVED EXE path so the persisted setting is unambiguous;
// when nothing is found the user may still store the raw folder ("Use anyway").
async function _resolveGccFromFolder(dir) {
    for (const d of _gccProbeDirs(dir)) {
        const g = _probeGcc(d);
        if (g) return g;
    }
    const use = await vscode.window.showWarningMessage(
        `avr-gcc (avr-gcc.exe) was not found in "${dir}" — the folder itself, bin/, known nested layouts and a deep scan (up to 4 levels) were all checked. See the AVR output channel for details. Use this folder anyway?`,
        'Use anyway', 'Cancel'
    );
    return use === 'Use anyway' ? dir : null;
}

// Persist the choice, re-detect (detect() is sync — the toast below is the
// non-silent feedback) and refresh every view that shows toolchain state.
async function _finishToolchainChange(chosen) {
    if (chosen) {
        await H.setCfg('toolchainPath', chosen);
        H.log(`[toolchain] toolchainPath set to: ${chosen}`);
    }
    invalidate();
    const fresh = detect();
    _refreshToolchainUi();
    if (fresh.gcc) {
        vscode.window.showInformationMessage(
            `AVR: avr-gcc ${fresh.gccVersion ? fresh.gccVersion + ' — ' : ''}${fresh.gcc}`);
    } else {
        vscode.window.showWarningMessage('AVR: avr-gcc still not found');
    }
    return fresh;
}

// Re-detect happened — refresh the devtools view, the project tree and the
// status bar (lazy require: statusBar is only pulled in when needed).
function _refreshToolchainUi() {
    if (H.getDevtoolsProvider()) H.getDevtoolsProvider().refresh();
    if (H.getProvider()) H.getProvider().refresh();
    try { require('./statusBar').refreshStatusBar(); } catch {}
}

// ─── Select XC8 path command (same pattern as cmdSelectToolchain) ───────────
// v0.3.2: the "Detect BOTH compilers…" entry removed here too (111.jpg) —
// the folder pick already deep-scans via _resolveXc8FromFolder.
async function cmdSelectXc8Path() {
    const candidates = findAllXc8Candidates();
    const tc = detect();
    const items = candidates.map(c => ({
        label: `$(folder-opened) ${c.path}`,
        description: c.source,
        picked: !!tc.xc8 && _samePath(c.path, tc.xc8),
        pick: c.path,
    }));
    items.push({ label: '$(file) Browse for the xc8-cc executable…', browse: 'file' });
    items.push({ label: '$(folder-opened) Browse for the XC8 folder…', browse: 'folder' });
    const manual = String(H.cfg('xc8.path') || '').trim();
    if (manual) items.push({ label: '$(close) Clear manual path (use auto-detect)', browse: 'clear' });

    const picked = await vscode.window.showQuickPick(items, {
        title: 'AVR-MDF › Select XC8 Toolchain',
        placeHolder: candidates.length
            ? `Detected ${candidates.length} xc8-cc location(s) — or browse`
            : 'XC8 (xc8-cc) not detected — browse for the executable or folder',
        matchOnDescription: true,
    });
    if (!picked) return null;

    let chosen = null;
    if (picked.browse === 'file') {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
            openLabel: 'Select xc8-cc executable',
            title: 'AVR-MDF: select the xc8-cc executable (e.g. …\\xc8-v4.00\\bin\\xc8-cc.exe)',
            filters: IS_WIN
                ? { 'xc8-cc executable': ['exe'], 'All files': ['*'] }
                : { 'All files': ['*'] },
        });
        if (!uris || !uris.length) return null;
        chosen = uris[0].fsPath;
    } else if (picked.browse === 'folder') {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            openLabel: 'Select XC8 folder',
            title: 'AVR-MDF: select the XC8 folder — the extracted xc8-v4.00 (bin\\xc8-cc.exe inside), the v2.x install dir, or any parent of them',
        });
        if (!uris || !uris.length) return null;
        chosen = await _resolveXc8FromFolder(uris[0].fsPath);
        if (!chosen) return null;
    } else if (picked.browse === 'clear') {
        await H.setCfg('xc8.path', '');
        H.log('[toolchain] xc8.path cleared');
        return _finishXc8Change(null);
    } else {
        chosen = picked.pick;   // a detected candidate executable
    }
    return _finishXc8Change(chosen);
}

// Validate a picked XC8 folder: fast probes first (bin/, v*/bin, xc8/bin,
// one/two levels of subfolders), then the bounded deep scan. Returns the
// RESOLVED EXE path; "Use anyway" stores the raw folder.
async function _resolveXc8FromFolder(dir) {
    for (const d of _xc8ProbeDirs(dir)) {
        const x = _probeXc8(d);
        if (x) return x;
    }
    const use = await vscode.window.showWarningMessage(
        `XC8 (xc8-cc.exe) was not found in "${dir}" — the folder itself, bin/, v*/bin, known nested layouts and a deep scan (up to 4 levels) were all checked. See the AVR output channel for details. Use this folder anyway?`,
        'Use anyway', 'Cancel'
    );
    return use === 'Use anyway' ? dir : null;
}

// Persist the choice, re-detect and refresh — the XC8 twin of
// _finishToolchainChange.
async function _finishXc8Change(chosen) {
    if (chosen) {
        await H.setCfg('xc8.path', chosen);
        H.log(`[toolchain] xc8.path set to: ${chosen}`);
    }
    invalidate();
    const fresh = detect();
    _refreshToolchainUi();
    if (fresh.xc8) {
        vscode.window.showInformationMessage(
            `AVR: XC8 ${fresh.xc8Version ? fresh.xc8Version + ' — ' : ''}${fresh.xc8}`);
    } else {
        vscode.window.showWarningMessage('AVR: XC8 (xc8-cc) still not found');
    }
    return fresh;
}

// ─── v0.3.2: cmdDetectCompilers REMOVED (111.jpg, red annotation) ──────────
// The separate "Detect BOTH compilers in one folder (deep scan)" command and
// its tree rows were declared redundant («ВОТ ЭТИ КОМАНДЫ ИЗЛИШНЕ ИХ МОЖНО
// УБРАТЬ»). Nothing is lost: the deep-scan machinery itself lives on inside
// _resolveGccFromFolder / _resolveXc8FromFolder (the "Browse for the …
// folder…" entries), so a picked folder with a
// nested dist layout (avr-gcc-16.1.0-x64-windows\bin\avr-gcc.exe,
// xc8-v4.00\bin\xc8-cc.exe) is still captured by the plain browse flow.

// v0.3.5: the proactive autoscan of Downloads/Desktop/Documents/home (added
// in 0.3.1) is REMOVED — detection is the standard places + PATH + the
// explicit Select Toolchain / Select XC8 pickers, nothing scans the user's
// personal folders behind their back.

// ─── XC8 device naming ───────────────────────────────────────────────────────
// The boards DB uses avrdude-style lowercase ids (atmega328p); XC8's -mcpu
// wants MPLAB device names (ATmega328P, ATtiny85, AT90USB1286 …). Normalize.
function xc8McuName(mcu) {
    const m = String(mcu || '').toLowerCase();
    if (!m) return m;
    let out;
    if (m.startsWith('atxmega')) out = 'ATxmega' + m.slice(7);
    else if (m.startsWith('attiny')) out = 'ATtiny' + m.slice(6);
    else if (m.startsWith('atmega')) out = 'ATmega' + m.slice(6);
    else if (m.startsWith('at90')) out = 'AT90' + m.slice(4).toUpperCase();
    else out = m;
    // uppercase variant letters after digits: 328p → 328P, 32u4 → 32U4, 32e5 → 32E5
    out = out.replace(/(\d)([a-z])/g, (w, d, c) => d + c.toUpperCase());
    return out.replace(/(\d+)([a-z]+)$/i, (w, d, letters) => d + letters.toUpperCase());
}

module.exports = { detect, invalidate, requireGcc, requireXc8, requireAvrdude, cmdSelectToolchain, cmdSelectXc8Path, xc8McuName };
