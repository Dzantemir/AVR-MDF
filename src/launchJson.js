'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// launchJson.js — the two debug records (simavr simulator / hardware GDB)
// merged into the workspace folder's .vscode/launch.json — add-if-missing,
// silent, gated by avr.debug.syncLaunchJson. Guard rails: never write under
// unsaved edits, never touch an unparseable file, atomic temp+rename write.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');

const VARIANTS = [
    {
        label: 'AVR: Debug (simavr)',
        body: { type: 'avr', request: 'launch', name: 'AVR: Debug (simavr)' },
    },
    {
        label: 'AVR: Debug (hardware GDB)',
        body: {
            type: 'avr', request: 'launch', backend: 'gdb',
            name: 'AVR: Debug (hardware GDB)',
            // v0.3.21: no hardcoded `program` — a stale '${workspaceFolder}/build/
            // firmware.elf' overrode the debug provider's expandOutPaths default,
            // so projects with a custom output_dir got "build did not produce the
            // ELF" after a successful build. Leave program unset and the provider
            // resolves <outDir>/<outName>.elf from avr-project.json.
            gdbHost: '127.0.0.1',
            gdbPort: 4242,
            gdbServerCmd: 'avarice --jtag /dev/ttyUSB0 :4242',
        },
    },
];

function _launchFileFor(root) {
    const vsDir = path.join(root, '.vscode');
    return { vsDir, file: path.join(vsDir, 'launch.json') };
}
function _detectIndent(raw) {
    const m = /^([ \t]+)\S/m.exec(raw);
    return m ? m[1] : '\t';
}
function _writeAtomic(file, text) {
    const tmp = file + '.avr-tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}
function _owningFolder() {
    const root = H.getActiveRoot();
    if (root) {
        const folders = vscode.workspace.workspaceFolders || [];
        const f = folders.find(f => {
            const rel = path.relative(f.uri.fsPath, root);
            return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        });
        return f ? f.uri.fsPath : root;
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : null;
}

function syncAfterProjectChange() {
    try {
        if (!H.cfg('debug.syncLaunchJson')) return;
        const root = _owningFolder();
        if (!root) return;
        const changed = mergeInto(root);
        if (changed) H.log('[launch] debug records merged into launch.json');
    } catch (e) {
        H.log(`[launch] sync failed: ${e.message}`);
    }
}

function mergeInto(root) {
    const { vsDir, file } = _launchFileFor(root);
    try { fs.mkdirSync(vsDir, { recursive: true }); } catch {}

    let doc = { version: '0.2.0', configurations: [] };
    let indent = '\t';
    if (fs.existsSync(file)) {
        for (const d of vscode.window.visibleTextEditors) {
            if (d.document.uri.fsPath === file && d.document.isDirty) {
                H.log('[launch] launch.json has unsaved edits — skipped');
                return false;
            }
        }
        const raw = fs.readFileSync(file, 'utf8');
        const { ok, data, error } = H.readJsonFile(file);
        if (!ok) {
            H.log(`[launch] launch.json is not valid JSON (${error}) — left alone`);
            return false;
        }
        indent = _detectIndent(raw);
        doc = data && typeof data === 'object' ? data : doc;
        if (!Array.isArray(doc.configurations)) doc.configurations = [];
    }

    let changed = false;
    for (const v of VARIANTS) {
        if (doc.configurations.some(c => c && c.type === 'avr' && c.name === v.body.name)) continue;
        doc.configurations.push(JSON.parse(JSON.stringify(v.body)));
        changed = true;
    }
    if (!changed) return false;

    _writeAtomic(file, JSON.stringify(doc, null, indent === '\t' ? '\t' : 2) + '\n');
    return true;
}

async function cmdSyncLaunchConfigs() {
    const root = _owningFolder();
    if (!root) { H.warnNoProject(); return; }
    const changed = mergeInto(root);
    vscode.window.showInformationMessage(
        changed ? 'AVR: launch.json updated — pick "AVR: Debug (simavr)" or "AVR: Debug (hardware GDB)" in the Run-and-Debug selector.'
                : 'AVR: launch.json already carries the AVR debug records — nothing to do.');
}

module.exports = { syncAfterProjectChange, cmdSyncLaunchConfigs };
