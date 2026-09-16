'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// validator.js — read & validate avr-project.json (the tree's config status,
// the Project Problems command and the build gate all live off this).
// ─────────────────────────────────────────────────────────────────────────────
const path     = require('path');
const fs       = require('fs');
const H        = require('./helpers');
const Boards   = require('./boards');
const { collectSources } = require('./sources');

const PROJECT_FILE = 'avr-project.json';

function projectFilePath(root) { return path.join(root, PROJECT_FILE); }

// → { status: 'missing' | 'broken' | 'ok', proj?, parseError? }
function readProjectConfig(root) {
    if (!root) return { status: 'missing' };
    const file = projectFilePath(root);
    if (!fs.existsSync(file)) return { status: 'missing' };
    const { ok, data, error } = H.readJsonFile(file);
    if (!ok) return { status: 'broken', parseError: error };
    return { status: 'ok', proj: data };
}

// → { valid, errors[], warnings[], infos[], counts: {sources, components, libraries} }
function validateProjectConfig(proj, root, { countSources = true } = {}) {
    const errors = [], warnings = [], infos = [];
    const counts = { sources: 0, components: 0, libraries: 0 };

    if (!proj || typeof proj !== 'object') {
        return { valid: false, errors: ['project config is not a JSON object'], warnings, infos, counts };
    }
    if (typeof proj.name !== 'string' || !proj.name.trim()) errors.push('name: missing (string required)');
    else if (!H.isAscii(proj.name)) warnings.push('name: non-ASCII characters (build paths want ASCII)');

    if (proj.toolchain !== undefined) {
        if (proj.toolchain !== 'avr-gcc' && proj.toolchain !== 'xc8') {
            warnings.push(`toolchain: "${proj.toolchain}" is unknown — expected "avr-gcc" or "xc8" (defaulting to avr-gcc)`);
        }
    }

    if (typeof proj.board !== 'string' || !proj.board) {
        errors.push('board: missing — pick the target MCU (e.g. "atmega328p", "uno")');
    } else {
        const b = Boards.getBoard(proj.board);
        if (!b) {
            warnings.push(`board: "${proj.board}" is not in the MCU database — the raw -mmcu=${proj.board} flag will be used`);
        }
    }

    // sources
    if (!Array.isArray(proj.sources) || !proj.sources.length) {
        warnings.push('sources: empty — nothing to build (default folder: "src")');
    } else if (countSources) {
        const collected = collectSources(root, proj);
        counts.sources = collected.sources.length;
        for (const e of collected.errors) warnings.push(e);
        if (collected.sources.length === 0 && collected.errors.length === 0) {
            warnings.push('sources: no .c/.cpp/.S files found in the configured paths');
        }
    }
    if (!Array.isArray(proj.sources)) errors.push('sources: must be an array');

    // includes / libraries / components
    for (const key of ['includes', 'libraries', 'components', 'defines']) {
        if (proj[key] !== undefined && !Array.isArray(proj[key])) {
            errors.push(`${key}: must be an array`);
        }
    }

    // build
    const build = proj.build || {};
    if (proj.build !== undefined && typeof proj.build !== 'object') errors.push('build: must be an object');
    if (build.output_dir !== undefined && typeof build.output_dir !== 'string') errors.push('build.output_dir: must be a string');
    if (build.output_name !== undefined && /[/\\]/.test(String(build.output_name))) errors.push('build.output_name: must be a file name, not a path');
    for (const flagKey of ['c_flags', 'cxx_flags', 'asm_flags', 'link_flags', 'extra_flags']) {
        if (build[flagKey] !== undefined && !Array.isArray(build[flagKey])) errors.push(`build.${flagKey}: must be an array`);
    }
    if (build.lto !== undefined && typeof build.lto !== 'boolean') errors.push('build.lto: must be boolean');
    if (build.gc_sections !== undefined && typeof build.gc_sections !== 'boolean') errors.push('build.gc_sections: must be boolean');
    if (build.relax !== undefined && typeof build.relax !== 'boolean') errors.push('build.relax: must be boolean');
    if (build.hooks !== undefined) {
        // v0.3.21: `hooks: null` passed the old typeof-object guard and crashed
        // Object.keys(null) — a hand-edited file killed Build / Show Project
        // Problems / the Select Project picker with an unhandled TypeError
        if (!build.hooks || typeof build.hooks !== 'object' || Array.isArray(build.hooks)) errors.push('build.hooks: must be an object');
        else {
            for (const k of Object.keys(build.hooks)) {
                const v = build.hooks[k];
                // v0.3.20: string (one command — the pre-0.3.20 form) OR
                // array of strings (one per line — the Project Editor form)
                const ok = (typeof v === 'string') ||
                    (Array.isArray(v) && v.every(c => typeof c === 'string'));
                if (!ok) errors.push(`build.hooks.${k}: must be a command string or an array of command strings`);
            }
        }
    }

    // upload
    const upload = proj.upload || {};
    if (proj.upload !== undefined && typeof proj.upload !== 'object') errors.push('upload: must be an object');
    if (upload.tool !== undefined && typeof upload.tool !== 'string') errors.push('upload.tool: must be a string');
    if (upload.args !== undefined && !Array.isArray(upload.args)) errors.push('upload.args: must be an array');
    // v0.3.21: port / programmer / baud had no type checks — a hand-edited
    // `baud: {}` stringified to "[object Object]" and silently round-tripped
    if (upload.programmer !== undefined && typeof upload.programmer !== 'string') errors.push('upload.programmer: must be a string');
    if (upload.port !== undefined && typeof upload.port !== 'string') errors.push('upload.port: must be a string');
    if (upload.baud !== undefined && typeof upload.baud !== 'number' && typeof upload.baud !== 'string') errors.push('upload.baud: must be a number');
    if (upload.eeprom !== undefined && typeof upload.eeprom !== 'boolean') errors.push('upload.eeprom: must be a boolean');

    // counts (components/libraries without heavy fs work when countSources=false)
    if (countSources) {
        try {
            const { collectComponents, collectLibraries } = require('./sources');
            counts.components = collectComponents(root, proj).length;
            counts.libraries = collectLibraries(root, proj).length;
        } catch {}
    }

    if (!errors.length && !warnings.length) infos.push('Configuration is valid.');
    return { valid: errors.length === 0, errors, warnings, infos, counts };
}

// The report shown by AVR: Show Project Problems
function reportText(proj, root) {
    const r = validateProjectConfig(proj, root, { countSources: true });
    const lines = [];
    lines.push(`avr-project.json — ${r.valid ? (r.warnings.length ? 'valid with warnings' : 'valid') : 'INVALID'}`);
    lines.push('');
    for (const e of r.errors)   lines.push(`✖ ${e}`);
    for (const w of r.warnings) lines.push(`⚠ ${w}`);
    for (const i of r.infos)    lines.push(`✔ ${i}`);
    lines.push('');
    lines.push(`sources: ${r.counts.sources}, components: ${r.counts.components}, libraries: ${r.counts.libraries}`);
    return lines.join('\n');
}

module.exports = { PROJECT_FILE, readProjectConfig, validateProjectConfig, reportText };
