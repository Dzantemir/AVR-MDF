'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// sources.js — pure-node source collection (no vscode dependency):
//   sources[] entries: "src" folder (recursive) or explicit .c/.cpp/.S/.s/.asm files
//   includes[]:        folders (passed as -I)
//   libraries[]:       .a files or folders scanned for *.a
//   components[]:      folders whose SUBFOLDERS are source libraries
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');

const C_EXTS   = new Set(['.c', '.cc', '.cpp', '.cxx']);
const ASM_EXTS = new Set(['.s', '.S', '.asm', '.a51', '.a90']);
const LIB_EXT  = '.a';

function _walk(dir, out, filter) {
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) _walk(full, out, filter);
            else if (entry.isFile() && filter(entry.name)) out.push(full);
        }
    } catch {}
    return out;
}

// entry can be: "src" (folder) | "src/main.c" (file) | {path, flags} | {path, exclude?}
function _entryPath(entry) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && typeof entry.path === 'string') return entry.path;
    return null;
}
function _entryFlags(entry) {
    return (entry && typeof entry === 'object' && Array.isArray(entry.flags)) ? entry.flags : null;
}

// → { sources: [{file, kind: 'c'|'asm', flags}], errors: [] }
function collectSources(root, proj) {
    const result = { sources: [], errors: [] };
    const seen = new Set();
    const add = (file, flags) => {
        const norm = path.normalize(file);
        if (seen.has(norm)) return;
        seen.add(norm);
        // extRaw keeps the case: avr-gcc dispatches .S (C preprocessor) and .s
        // (plain assembly) differently; ext stays lowercased for matching.
        const extRaw = path.extname(file);
        const ext = extRaw.toLowerCase();
        const kind = C_EXTS.has(ext) ? 'c' : ASM_EXTS.has(ext) ? 'asm' : null;
        if (!kind) return;
        result.sources.push({ file, kind, flags, ext, extRaw });
    };
    for (const entry of (proj.sources || [])) {
        const rel = _entryPath(entry);
        if (!rel) { result.errors.push(`sources: invalid entry ${JSON.stringify(entry)}`); continue; }
        const flags = _entryFlags(entry);
        const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
        let st = null;
        try { st = fs.statSync(abs); } catch {}
        if (!st) { result.errors.push(`sources: not found: ${rel}`); continue; }
        if (st.isDirectory()) {
            for (const f of _walk(abs, [], n => C_EXTS.has(path.extname(n).toLowerCase()) || ASM_EXTS.has(path.extname(n).toLowerCase()))) {
                add(f, flags);
            }
        } else if (st.isFile()) {
            add(abs, flags);
        }
    }
    result.sources.sort((a, b) => a.file.localeCompare(b.file));
    return result;
}

// → [{file}] prebuilt .a libraries (entries: folder → scanned, file → direct)
function collectLibraries(root, proj) {
    const out = [];
    for (const entry of (proj.libraries || [])) {
        const rel = _entryPath(entry);
        if (!rel) continue;
        const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
        let st = null;
        try { st = fs.statSync(abs); } catch {}
        if (!st) continue;
        if (st.isDirectory()) {
            for (const f of _walk(abs, [], n => n.toLowerCase().endsWith(LIB_EXT))) out.push({ file: f });
        } else if (st.isFile() && abs.toLowerCase().endsWith(LIB_EXT)) {
            out.push({ file: abs });
        }
    }
    return out;
}

// → [{name, path, sources[], includes[]}] source libraries (components)
// entry: "components" (folder of subfolders) | {name, path, pattern?, includes?}
function collectComponents(root, proj) {
    const out = [];
    for (const entry of (proj.components || [])) {
        if (typeof entry === 'string') {
            const abs = path.isAbsolute(entry) ? entry : path.join(root, entry);
            let st = null;
            try { st = fs.statSync(abs); } catch {}
            if (!st || !st.isDirectory()) continue;
            try {
                for (const sub of fs.readdirSync(abs, { withFileTypes: true })) {
                    if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
                    const compDir = path.join(abs, sub.name);
                    out.push(_makeComponent(sub.name, compDir, root));
                }
            } catch {}
        } else if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
            const abs = path.isAbsolute(entry.path) ? entry.path : path.join(root, entry.path);
            if (!fs.existsSync(abs)) continue;
            out.push(_makeComponent(entry.name || path.basename(abs), abs, root, entry));
        }
    }
    return out;
}
function _makeComponent(name, dir, root, entry) {
    entry = entry || {};
    let files;
    if (entry.pattern && typeof entry.pattern === 'string') {
        // minimal glob: "**/*.c" / "*.c"
        const ext = path.extname(entry.pattern).toLowerCase();
        files = _walk(dir, [], n => path.extname(n).toLowerCase() === (ext || '.c'));
    } else {
        files = _walk(dir, [], n => {
            const e = path.extname(n).toLowerCase();
            return C_EXTS.has(e) || ASM_EXTS.has(e);
        });
    }
    const includes = [];
    for (const inc of (entry.includes || [])) {
        const abs = path.isAbsolute(inc) ? inc : path.join(root, inc);
        try { if (fs.statSync(abs).isDirectory()) includes.push(abs); } catch {}
    }
    // convention: components/<name>/inc or include/ added automatically
    for (const cand of ['inc', 'include']) {
        const p = path.join(dir, cand);
        try { if (fs.statSync(p).isDirectory()) includes.push(p); } catch {}
    }
    return { name, path: dir, files, includes };
}

// include dirs for -I
function collectIncludes(root, proj) {
    const out = [];
    for (const entry of (proj.includes || [])) {
        const rel = typeof entry === 'string' ? entry : (entry && typeof entry.path === 'string' ? entry.path : null);
        if (!rel) continue;
        const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
        try { if (fs.statSync(abs).isDirectory()) out.push(abs); } catch {}
    }
    return out;
}

module.exports = { collectSources, collectLibraries, collectComponents, collectIncludes, C_EXTS, ASM_EXTS };
