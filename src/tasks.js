'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// tasks.js — the three AVR tasks (Build / Flash / Clean) merged into the
// workspace folder's .vscode/tasks.json, running the EXTENSION'S OWN commands
// through a CustomExecution pseudoterminal (the task terminal carries the task
// lifecycle; the real output stays in the AVR terminal / Problems panel —
// a static shell line could never reproduce the orchestration). Merge-only and
// add-if-missing: the user's own tasks and formatting are never touched.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');

const AVR_TASKS = [
    { type: 'avr', label: 'AVR: Build', action: 'build', isDefaultBuild: true },
    { type: 'avr', label: 'AVR: Flash', action: 'flash' },
    { type: 'avr', label: 'AVR: Clean', action: 'clean' },
];

function _tasksFileFor(root) {
    const vsDir = path.join(root, '.vscode');
    return { vsDir, file: path.join(vsDir, 'tasks.json') };
}
const _sameEntry = (a, b) => !!(a && b && a.type === 'avr' && a.type === b.type && a.label === b.label);

function _detectIndent(raw) {
    const m = /^([ \t]+)\S/m.exec(raw);
    return m ? m[1] : '\t';
}
function _writeAtomic(file, text) {
    const tmp = file + '.avr-tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

// merge into the folder owning the active project (or the first workspace
// folder). Silent; gated by avr.autoGenerateTasks.
function syncAfterProjectChange() {
    try {
        if (!H.cfg('autoGenerateTasks')) return;
        const root = _owningFolder();
        if (!root) return;
        const changed = mergeInto(root);
        if (changed) H.log(`[tasks] merged AVR tasks into ${path.relative(root, _tasksFileFor(root).file) || 'tasks.json'}`);
    } catch (e) {
        H.log(`[tasks] sync failed: ${e.message}`);
    }
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

function mergeInto(root) {
    const { vsDir, file } = _tasksFileFor(root);
    try { fs.mkdirSync(vsDir, { recursive: true }); } catch {}

    let doc = { version: '2.0.0', tasks: [] };
    let indent = '\t';
    if (fs.existsSync(file)) {
        for (const d of vscode.window.visibleTextEditors) {
            if (d.document.uri.fsPath === file && d.document.isDirty) {
                H.log('[tasks] tasks.json has unsaved edits — skipped');
                return false;
            }
        }
        const raw = fs.readFileSync(file, 'utf8');
        const { ok, data, error } = H.readJsonFile(file);
        if (!ok) {
            H.log(`[tasks] tasks.json is not valid JSON (${error}) — left alone`);
            return false;
        }
        indent = _detectIndent(raw);
        doc = data && typeof data === 'object' ? data : doc;
        if (!Array.isArray(doc.tasks)) doc.tasks = [];
    }

    let changed = false;
    for (const t of AVR_TASKS) {
        if (doc.tasks.some(e => _sameEntry(e, t))) continue;
        const entry = { type: t.type, action: t.action, label: t.label, problemMatcher: ['$avr'] };
        if (t.isDefaultBuild) {
            entry.group = { kind: 'build', isDefault: true };
        }
        doc.tasks.push(entry);
        changed = true;
    }
    if (!changed) return false;

    _writeAtomic(file, JSON.stringify(doc, null, indent === '\t' ? '\t' : 2) + '\n');
    return true;
}

// The palette command — explicit intent, reports what happened
async function cmdGenerateTasks() {
    const root = _owningFolder();
    if (!root) { H.warnNoProject(); return; }
    const changed = mergeInto(root);
    vscode.window.showInformationMessage(
        changed ? 'AVR: tasks.json updated — AVR: Build (default, Ctrl+Shift+B) / Flash / Clean are available via Tasks: Run Task.'
                : 'AVR: tasks.json already carries the three AVR tasks — nothing to do.');
}

// ─── The custom task execution ───────────────────────────────────────────────
// The contributed task TYPE is "avr" (package.json taskDefinitions) — VS Code
// hands every {type:"avr"} task here; we run the extension's own command and
// mirror its completion into the task's pseudoterminal.
function provideTasks() {
    return AVR_TASKS.map(t => {
        const task = new vscode.Task(
            { type: 'avr', action: t.action },
            vscode.TaskScope.Workspace,
            t.label, 'AVR-MDF',
            new vscode.CustomExecution(async () => {
                return new AvrTaskTerminal(t);
            })
        );
        if (t.isDefaultBuild) task.group = { kind: 'build', isDefault: true };
        task.problemMatchers = ['$avr'];
        return task;
    });
}
function resolveTask(task) {
    const action = (task.definition && task.definition.action) || 'build';
    const def = { type: 'avr', action };
    const t = new vscode.Task(
        def, task.scope || vscode.TaskScope.Workspace, task.name, 'AVR-MDF',
        new vscode.CustomExecution(async () => new AvrTaskTerminal({ action, label: task.name }))
    );
    t.problemMatchers = ['$avr'];
    return t;
}

const ACTION_TO_CMD = { build: 'avr.build', flash: 'avr.flash', clean: 'avr.clean' };

class AvrTaskTerminal {
    constructor(task) { this._task = task; }
    open(initialDimensions) {
        const cmd = ACTION_TO_CMD[this._task.action] || 'avr.build';
        this._write(`▶ ${this._task.label} — running the extension's command…\r\n`);
        // v0.3.16: build/flash/clean RESOLVE with a success boolean now — a
        // failed build used to end the task with exit 0 / "✔ done" (VS Code
        // reported failed builds as successful).
        vscode.commands.executeCommand(cmd).then((ok) => {
            if (ok) {
                this._write(`✔ done\r\n`);
                this._close();
            } else {
                this._write(`✖ finished with errors — see the AVR output / terminal\r\n`);
                this._close(1);
            }
        }, (err) => {
            this._write(`✖ failed: ${err && err.message}\r\n`);
            this._close(1);
        });
    }
    _write(s) {
        try { this._emitter?.fire(s); } catch {}
    }
    get onDidWrite() {
        if (!this._emitter) this._emitter = new vscode.EventEmitter();
        return this._emitter.event;
    }
    get onDidClose() {
        if (!this._closeEmitter) this._closeEmitter = new vscode.EventEmitter();
        return this._closeEmitter.event;
    }
    _close(code) {
        try { this._closeEmitter?.fire(code ?? 0); } catch {}
    }
    close() {}
    handleInput() {}
}

module.exports = { syncAfterProjectChange, cmdGenerateTasks, provideTasks, resolveTask };
