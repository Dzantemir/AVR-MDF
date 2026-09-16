'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// extension.js — AVR-MDF activation: tree views, webview views, status
// bar, all commands, the project create/select wizards, port picking,
// disassembly, libc helpers, settings-change hooks and teardown.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Toolchain = require('./toolchain');
const Boards = require('./boards');
const Tree   = require('./treeProvider');
const StatusBar = require('./statusBar');
const Build  = require('./build');
const Flash  = require('./flash');
const Fuses  = require('./fuses');
const Monitor = require('./monitor');
const MemoryView = require('./memoryView');
const Ports  = require('./ports');
const Validator = require('./validator');
const IntelliSense = require('./intellisense');
const Tasks  = require('./tasks');
const LaunchJson = require('./launchJson');
const ProjEdit = require('./projectEditor');
const BoardManager = require('./boardManager');
const ImportProject = require('./importProject');
const DebugProvider = require('./debugProvider');

// An active root is acceptable if it exists on disk and is either a workspace
// folder itself or located INSIDE one (projects created in subfolders must
// survive a VS Code restart).
function _isRootAcceptable(rootPath) {
    if (!rootPath) return false;
    try { if (!fs.existsSync(rootPath)) return false; } catch { return false; }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return true;
    return folders.some(f => {
        const rel = path.relative(f.uri.fsPath, rootPath);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
}

// Candidate projects for auto-pick and the Select Project picker:
// workspace folders + their DIRECT subfolders containing avr-project.json.
function _collectCandidateProjects() {
    const out = [];
    const seen = new Set();
    const folders = vscode.workspace.workspaceFolders || [];
    const probe = (fsPath, isSubfolder) => {
        if (seen.has(fsPath)) return;
        seen.add(fsPath);
        const { status, proj, parseError } = Validator.readProjectConfig(fsPath);
        let projectType, hint;
        if (status === 'missing') { projectType = 'none'; hint = 'No avr-project.json — not an AVR project'; }
        else if (status === 'broken') { projectType = 'broken'; hint = `avr-project.json: broken JSON (${parseError})`; }
        else {
            const report = Validator.validateProjectConfig(proj, fsPath, { countSources: false });
            if (report.errors.length) { projectType = 'errors'; hint = `avr-project.json: ${report.errors.length} error(s)`; }
            else if (report.warnings.length) { projectType = 'warnings'; hint = `valid with ${report.warnings.length} warning(s)`; }
            else { projectType = 'valid'; hint = 'AVR project (config valid)'; }
        }
        out.push({ fsPath, projectType, hint, isSubfolder });
    };
    for (const f of folders) {
        probe(f.uri.fsPath, false);
        try {
            for (const entry of fs.readdirSync(f.uri.fsPath, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
                const sub = path.join(f.uri.fsPath, entry.name);
                if (fs.existsSync(path.join(sub, 'avr-project.json'))) probe(sub, true);
            }
        } catch {}
    }
    return out;
}

function activate(ctx) {
    H.setCtx(ctx);
    const oc = H.getOutputChannel();
    ctx.subscriptions.push(oc);
    oc.appendLine('[AVR-MDF] Extension activated');

    Boards.migrateLegacyBoards();

    // Restore active root (never auto-pick — the user selects explicitly)
    const savedRoot = ctx.workspaceState.get('avrActiveRoot');
    if (_isRootAcceptable(savedRoot)) {
        H.setActiveRoot(savedRoot);
    }
    // bridge for pure-node modules (memory.js)
    try { require('./memory').setActiveRootBridge(savedRoot || ''); } catch {}

    // ─── Tree views ───────────────────────────────────────────────────────
    const expandedIds = new Set(ctx.workspaceState.get('avrTreeExpanded') || []);
    const saveExpandedIds = () => ctx.workspaceState.update('avrTreeExpanded', [...expandedIds]);
    const isExpanded = (id) => expandedIds.has(id);
    const provider = new Tree.AvrProvider({ isExpanded });
    H.setProvider(provider);
    const treeView = vscode.window.createTreeView('avr.projectView', { treeDataProvider: provider });
    ctx.subscriptions.push(treeView);
    ctx.subscriptions.push(
        treeView.onDidExpandElement(e => { if (e.element && e.element.id) { expandedIds.add(e.element.id); saveExpandedIds(); } }),
        treeView.onDidCollapseElement(e => { if (e.element && e.element.id) { expandedIds.delete(e.element.id); saveExpandedIds(); } }),
        treeView.onDidChangeVisibility(e => { if (e.visible) StatusBar.markUiVisible(); }),
    );
    if (treeView.visible) StatusBar.markUiVisible();

    const devtoolsProvider = new Tree.AvrDevtoolsProvider({ isExpanded });
    H.setDevtoolsProvider(devtoolsProvider);
    const devtoolsView = vscode.window.createTreeView('avr.devtoolsView', { treeDataProvider: devtoolsProvider });
    ctx.subscriptions.push(devtoolsView);
    // v0.3.5: the Development Tools branches (avr-gcc / XC8) remember their
    // expanded state too — same persisted set as the project tree.
    ctx.subscriptions.push(
        devtoolsView.onDidExpandElement(e => { if (e.element && e.element.id) { expandedIds.add(e.element.id); saveExpandedIds(); } }),
        devtoolsView.onDidCollapseElement(e => { if (e.element && e.element.id) { expandedIds.delete(e.element.id); saveExpandedIds(); } }),
        // v0.3.16: collected like the project tree's listener above — the
        // dropped disposable leaked the subscription on deactivate
        devtoolsView.onDidChangeVisibility(e => { if (e.visible) StatusBar.markUiVisible(); }),
    );

    const libcProvider = new Tree.AvrLibcProvider();
    H.setLibcProvider(libcProvider);
    const libcView = vscode.window.createTreeView('avr.libcView', { treeDataProvider: libcProvider });
    ctx.subscriptions.push(libcView);
    ctx.subscriptions.push(libcView.onDidChangeVisibility(e => { if (e.visible) StatusBar.markUiVisible(); }));   // v0.3.16: collected

    // ─── Webview views ────────────────────────────────────────────────────
    MemoryView.register(ctx);
    Monitor.register(ctx);

    // ─── Status bar ───────────────────────────────────────────────────────
    StatusBar.createStatusBar(ctx);

    // ─── Debug ────────────────────────────────────────────────────────────
    DebugProvider.register(ctx);

    // ─── Tasks (the "avr" task type) ──────────────────────────────────────
    ctx.subscriptions.push(vscode.tasks.registerTaskProvider('avr', {
        provideTasks: () => Tasks.provideTasks(),
        resolveTask: (task) => Tasks.resolveTask(task),
    }));

    // ─── Commands ─────────────────────────────────────────────────────────
    const reg = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
    reg('avr.build',   () => Build.build());
    reg('avr.flash',   () => Flash.flash());
    reg('avr.clean',   () => Build.clean());
    reg('avr.openMonitor', () => Monitor.cmdOpen());
    reg('avr.monitor.start', () => Monitor.cmdStart());
    reg('avr.monitor.stop',  () => Monitor.cmdStop());
    reg('avr.monitor.clear', () => Monitor.clearOutput());   // v0.3.16: actually clears (was reveal-only)
    // v0.3.20: the Serial Monitor toolbar's port dropdown needs fresh data —
    // the view-title button (the sdcc-mdf design) re-scans and pushes the
    // list into the webview
    reg('avr.monitor.refreshPorts', () => Monitor.cmdRefreshPorts());
    reg('avr.createProject', cmdCreateProject);
    reg('avr.importProject', ImportProject.cmdImportProject);
    reg('avr.selectProject', cmdSelectProject);
    reg('avr.clearProject', cmdClearProject);
    reg('avr.editProject', ProjEdit.openProjectEditor);
    reg('avr.syncLaunchConfigs', LaunchJson.cmdSyncLaunchConfigs);
    reg('avr.generateTasks', Tasks.cmdGenerateTasks);
    reg('avr.showProblems', cmdShowProblems);
    reg('avr.selectBoard', cmdSelectBoard);
    reg('avr.manageBoards', BoardManager.openBoardManager);
    reg('avr.exportBoards', BoardManager.cmdExport);
    reg('avr.importBoards', BoardManager.cmdImport);
    reg('avr.selectToolchain', Toolchain.cmdSelectToolchain);
    reg('avr.selectXc8Path', Toolchain.cmdSelectXc8Path);
    // v0.3.2: avr.detectCompilers removed (111.jpg — the command was declared
    // redundant; the deep scan lives on inside the folder-browse validation).
    reg('avr.switchToolchain', cmdSwitchToolchain);
    reg('avr.selectProgrammer', Flash.selectProgrammer);
    reg('avr.selectPort', cmdSelectPort);
    reg('avr.configureIntelliSense', IntelliSense.cmdConfigureIntelliSense);
    reg('avr.toggleBuildMode', StatusBar.cmdToggleBuildMode);
    reg('avr.refreshMemory', () => MemoryView.refresh());
    reg('avr.fuses.open', Fuses.cmdOpen);
    // v0.3.12 (222.jpg): avr.fuses.read / avr.fuses.write REMOVED — duplicates
    // of the Fuse Editor page (its own ⟳ Read / ⇧ Write buttons do the same,
    // with the values in sight); the tree rows and palette entries are gone.
    reg('avr.eeprom.upload', Flash.eepromUpload);
    reg('avr.eeprom.download', Flash.eepromDownload);
    reg('avr.avrdude.erase', Flash.chipErase);
    // v0.3.3 (111.jpg — «эти команды избыточны»): the avrdude listing/
    // terminal commands removed from the palette; the programmer lives in
    // the Project Editor's Upload card and the port in the status bar chip.
    reg('avr.showDisassembly', cmdShowDisassembly);
    reg('avr.libc.insert', cmdLibcInsert);
    reg('avr.libc.doc', cmdLibcDoc);
    reg('avr.refresh', () => {
        Toolchain.invalidate();
        Boards.invalidate();
        if (H.getProvider()) H.getProvider().refresh();
        if (H.getDevtoolsProvider()) H.getDevtoolsProvider().refresh();
        if (H.getLibcProvider()) H.getLibcProvider().refresh();
        MemoryView.reloadFromDisk();
    });
    reg('avr.collapseAll', () => { try { vscode.commands.executeCommand('avr.projectView.collapseAll'); } catch {} });
    reg('avr.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:avr-mdf');
    });
    reg('avr.returnViews', () => {
        // reset OUR views' locations (the built-in way for one container)
        for (const view of ['avr.projectView', 'avr.memoryView', 'avr.monitorView', 'avr.devtoolsView', 'avr.libcView']) {
            try { vscode.commands.executeCommand(`${view}.resetViewLocation`); } catch {}
        }
    });

    // ─── Config-change hooks ──────────────────────────────────────────────
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('avr')) {
            Toolchain.invalidate();
            Boards.invalidate();
            StatusBar.refreshStatusBar();
            if (H.getProvider()) H.getProvider().refresh();
            if (H.getDevtoolsProvider()) H.getDevtoolsProvider().refresh();
            // v0.3.20: the Project Editor's Release/Debug segmented control
            // follows a buildMode switch made from the status bar / palette
            if (e.affectsConfiguration('avr.buildMode')) {
                try { ProjEdit.notifyBuildModeChanged(); } catch {}
            }
            // v0.3.21: a new port picked via the status bar / palette must not
            // stay shadowed by the monitor toolbar's stale selection
            if (e.affectsConfiguration('avr.comPort')) {
                try { Monitor.onComPortChanged(); } catch {}
            }
        }
    }));

    // ─── Startup flow ─────────────────────────────────────────────────────
    // toolchain detection (feeds the devtools view; runs lazily on view open too)
    try {
        Toolchain.detect();
        if (H.getDevtoolsProvider()) H.getDevtoolsProvider().refresh();
    } catch (e) {
        H.log(`[toolchain] startup detection failed: ${e.message}`);
    }
    // tasks/launch/intellisense for the restored project
    if (H.getActiveRoot()) {
        Tasks.syncAfterProjectChange();
        LaunchJson.syncAfterProjectChange();
        IntelliSense.syncAfterProjectChange();
        MemoryView.reloadFromDisk();
    }
}

// ─── Select / clear project ──────────────────────────────────────────────────
async function cmdSelectProject() {
    if (H.checkBusy()) return;
    const candidates = _collectCandidateProjects();
    const items = candidates.map(c => ({
        label: path.basename(c.fsPath) + (c.isSubfolder ? '  (subfolder)' : ''),
        description: c.fsPath,
        detail: c.hint,
        kind: vscode.QuickPickItemKind.Default,
        pick: c,
    }));
    items.push({ label: '$(file-directory) Browse for a folder…', browse: true });
    const pick = await vscode.window.showQuickPick(items, {
        matchOnDescription: true, matchOnDetail: true,
        placeHolder: 'Select the AVR project folder (the one with avr-project.json)',
    });
    if (!pick) return;
    let root = null;
    if (pick.browse) {
        const sel = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            title: 'AVR › Select the project folder',
        });
        if (!sel || !sel.length) return;
        root = sel[0].fsPath;
    } else {
        root = pick.pick.fsPath;
        if (pick.pick.projectType === 'none') {
            // refuse non-projects with an actionable error
            const fix = await vscode.window.showErrorMessage(
                `AVR: "${path.basename(root)}" is not an AVR project (no avr-project.json).`,
                'Create project here', 'Pick another folder'
            );
            if (fix === 'Create project here') {
                // v0.3.16: a cancelled board pick returned null and crashed
                // _createProjectIn ("failed to create the project")
                const boardId = await Boards.selectBoard(null, { placeHolder: 'Board for the new project' });
                if (!boardId) return;
                await _createProjectIn(root, path.basename(root), boardId, 'avr-gcc');
                return;
            }
            if (fix === 'Pick another folder') { cmdSelectProject(); return; }
            return;
        }
        if (pick.pick.projectType === 'broken') {
            vscode.window.showErrorMessage(`AVR: avr-project.json in "${path.basename(root)}" is broken JSON — fix it first.`);
            return;
        }
    }
    _setActiveProject(root);
}

function _setActiveProject(root) {
    H.setActiveRoot(root);
    H.getCtx()?.workspaceState.update('avrActiveRoot', root);
    Boards.invalidate();
    try { require('./memory').setActiveRootBridge(root || ''); } catch {}
    if (H.getProvider()) H.getProvider().refresh();
    if (H.getLibcProvider()) H.getLibcProvider().refresh();
    try { require('./statusBar').refreshStatusBar(); } catch {}
    MemoryView.reloadFromDisk();
    Tasks.syncAfterProjectChange();
    LaunchJson.syncAfterProjectChange();
    IntelliSense.syncAfterProjectChange();
    H.log(`Active project → ${root}`);
}

function cmdClearProject() {
    if (H.checkBusy()) return;
    H.setActiveRoot(null);
    H.getCtx()?.workspaceState.update('avrActiveRoot', null);
    Boards.invalidate();
    try { require('./memory').setActiveRootBridge(''); } catch {}
    if (H.getProvider()) H.getProvider().refresh();
    MemoryView.reloadFromDisk();
}

// ─── Create project (wizard) ─────────────────────────────────────────────────
async function cmdCreateProject() {
    if (H.checkBusy()) return;
    // Step 1: name
    const name = await vscode.window.showInputBox({
        prompt: 'Project name (used in avr-project.json; keep it ASCII — it can flow into build paths via ${project.name})',
        value: 'my-avr-project',
        validateInput: validateProjectNameValue,
    });
    if (!name) return;
    // Step 2: board
    const boardId = await Boards.selectBoard(null, { placeHolder: 'Target board / MCU (drives -mmcu, -DF_CPU, memory limits, template)' });
    if (!boardId) return;
    // Step 3: toolchain (GNU avr-gcc or Microchip XC8)
    const Toolchain = require('./toolchain');
    const tcDetect = Toolchain.detect();
    const tcPick = await vscode.window.showQuickPick([
        {
            label: `$(circuit-board) GNU avr-gcc`,
            description: 'avr-libc · ISR() · F_CPU · simavr/avr-gdb debug',
            detail: tcDetect.gcc ? `detected: ${tcDetect.gcc}${tcDetect.gccVersion ? ' (v' + tcDetect.gccVersion + ')' : ''}` : 'not detected — install the AVR toolchain later',
            value: 'avr-gcc',
        },
        {
            label: `$(chip) Microchip XC8`,
            description: 'xc8-cc · <xc.h> · F_CPU/_delay_ms (util/delay.h) · #pragma config',
            detail: tcDetect.xc8 ? `detected: ${tcDetect.xc8}${tcDetect.xc8Version ? ' (v' + tcDetect.xc8Version + ')' : ''}` : 'not detected — install MPLAB XC8 later',
            value: 'xc8',
        },
    ], { placeHolder: 'Compiler for the new project (switchable any time via AVR: Switch Toolchain)' });
    if (!tcPick) return;
    const toolchain = tcPick.value;
    // Step 4: folder (native dialog — create a new folder anywhere)
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: 'Create Project Here',
        title: 'AVR-MDF › Create Project Folder (new or empty)',
    });
    if (!picked || picked.length === 0) return;
    await _createProjectIn(picked[0].fsPath, name, boardId, toolchain);
}

async function _createProjectIn(projectDir, name, boardId, toolchain) {
    toolchain = toolchain === 'xc8' ? 'xc8' : 'avr-gcc';
    if (fs.existsSync(path.join(projectDir, 'avr-project.json'))) {
        vscode.window.showErrorMessage(
            `AVR: "${path.basename(projectDir)}" already contains an avr-project.json — refusing to overwrite. Pick an empty folder.`
        );
        return;
    }
    const clobberTargets = [
        path.join(projectDir, 'src', 'main.c'),
        path.join(projectDir, '.vscode', 'settings.json'),
    ].filter(p => fs.existsSync(p));
    if (clobberTargets.length) {
        const rel = clobberTargets.map(p => path.relative(projectDir, p) || path.basename(p));
        const overwrite = await vscode.window.showInformationMessage(
            `AVR: "${path.basename(projectDir)}" already contains ${rel.join(', ')} — creating the project here overwrites ${rel.length > 1 ? 'them' : 'it'}.`,
            'Overwrite and create', 'Cancel'
        );
        if (overwrite !== 'Overwrite and create') return;
    }

    const board = Boards.getBoard(boardId);
    let mainPath = null;
    try {
        for (const d of ['src', 'include', 'lib', 'components', '.vscode']) {
            fs.mkdirSync(path.join(projectDir, d), { recursive: true });
        }
        mainPath = path.join(projectDir, 'src', 'main.c');
        fs.writeFileSync(mainPath, Boards.mainTemplate(board, toolchain));
        fs.writeFileSync(path.join(projectDir, 'lib', 'README.md'),
            '# Prebuilt libraries\n\nDrop prebuilt `*.a` archives here — every `*.a` in this folder is linked\nas-is after the components. The folder is listed as `"lib"` in `libraries`\nof avr-project.json by default.\n');
        fs.writeFileSync(path.join(projectDir, 'components', 'README.md'),
            '# Source components (ESP8266-IDF pattern)\n\nEach subfolder of `components/` is one source library:\n- compiled with the project board flags (-mmcu, -DF_CPU);\n- archived with `avr-ar rcs build/comp/avr_mdf_<name>.a`;\n- linked after the application objects.\n\nComponent layout convention (optional):\n\n    components/mylib/\n      *.c            ← sources (auto-scanned)\n      inc/           ← include dir (auto-added when present)\n');
        fs.writeFileSync(path.join(projectDir, 'avr-project.json'), JSON.stringify({
            name,
            board: boardId,
            toolchain,
            sources: ['src'],
            includes: ['include'],
            defines: [],
            libraries: ['lib'],
            components: ['components'],
            build: { output_dir: 'build', output_name: 'firmware', hooks: {} },
            upload: { tool: 'avrdude' },
        }, null, 2) + '\n');
        fs.writeFileSync(path.join(projectDir, '.vscode', 'settings.json'), JSON.stringify({}, null, 2) + '\n');
    } catch (e) {
        vscode.window.showErrorMessage(
            `AVR: failed to create the project in "${projectDir}": ${e.message}`, 'Open Folder'
        ).then(a => {
            if (a === 'Open Folder') vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectDir));
        });
        H.log(`Create project failed: ${e.message}`);
        return;
    }

    // add to the workspace
    const startIdx = vscode.workspace.workspaceFolders?.length || 0;
    let added = false;
    try {
        added = vscode.workspace.updateWorkspaceFolders(
            startIdx, 0,
            { uri: vscode.Uri.file(projectDir), name: path.basename(projectDir) }
        );
    } catch (e) {
        H.log(`updateWorkspaceFolders threw: ${e.message}`);
    }

    _setActiveProject(projectDir);

    try { await IntelliSense.syncAfterProjectChange(); } catch (e) {
        H.log(`[intellisense] auto-configure after project creation failed: ${e.message}`);
    }
    try {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(mainPath));
    } catch (e) {
        H.log(`Failed to open main.c: ${e.message}`);
    }
    vscode.window.showInformationMessage(
        `✅ Project "${name}" created (board: ${boardId}, toolchain: ${toolchain})${added ? ' and added to the workspace.' : '.'}` +
        (toolchain === 'avr-gcc' ? ' Press F5 to debug on simavr.' : ' XC8: flash via avrdude as usual (Ctrl+Alt+F).')
    );
    H.log(`Project created: ${projectDir} (board: ${boardId}, added to workspace: ${added})`);
}

// ─── Select port ─────────────────────────────────────────────────────────────
// v0.3.9: the sdcc-mdf 0.29.0 cmdSelectPort flow verbatim — ONLY the detected
// ports in the picker ($$(plug) rows, the current one marked/picked, no
// fabricated COM1…COM32 list), "Enter port manually…" as the single fallback,
// the manual box pre-filled with the current port and validated, and a toast
// confirming the choice. The tree row / status chip / monitor sync stays.
async function cmdSelectPort() {
    if (H.checkBusy()) return null;
    const current = H.cfg('comPort') || '';
    const detected = Ports.detectPorts();

    const items = detected.map(p => ({
        label: `$(plug) ${p}`,
        description: p === current ? 'current' : '',
        picked: p === current,
        port: p,
    }));
    items.push({ label: '$(edit) Enter port manually…', port: null });

    const picked = await vscode.window.showQuickPick(items, {
        title: 'AVR: Select Serial Port',
        placeHolder: detected.length ? 'Detected ports' : 'No ports detected — enter manually',
        matchOnDescription: false,
    });
    if (!picked) return null;

    let input = picked.port;
    if (!input) {
        input = await vscode.window.showInputBox({
            prompt: 'Enter port manually',
            placeHolder: H.IS_WIN ? 'COM3' : '/dev/ttyUSB0',
            value: current,
            validateInput: text => {
                if (!text) return 'Port cannot be empty';
                if (!/^[a-zA-Z0-9./\\_-]+$/.test(text)) return 'Invalid characters in port name';
                return null;
            },
        });
        if (!input) return null;
    }

    await H.setCfg('comPort', input);
    vscode.window.showInformationMessage(`AVR: Port → ${input}`);
    H.log(`Port selected: ${input}`);
    StatusBar.refreshStatusBar();
    Monitor.postState();
    if (H.getProvider()) H.getProvider().refresh();
    return input;
}

// ─── Select board (change the project's board) ───────────────────────────────
async function cmdSelectBoard() {
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const id = await Boards.selectBoard(proj.board);
    if (!id) return;
    proj.board = id;
    try {
        fs.writeFileSync(path.join(root, 'avr-project.json'), JSON.stringify(proj, null, 2) + '\n');
        Boards.invalidate();
        if (H.getProvider()) H.getProvider().refresh();
        vscode.window.showInformationMessage(`AVR: board → ${id} (rebuild to apply the new -mmcu).`);
        H.log(`Board → ${id}`);
        IntelliSense.syncAfterProjectChange();
    } catch (e) {
        vscode.window.showErrorMessage(`AVR: could not update the project — ${e.message}`);
    }
}

// ─── Show problems (the config report) ───────────────────────────────────────
function cmdShowProblems() {
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj, parseError } = Validator.readProjectConfig(root);
    const text = status === 'missing'
        ? 'No avr-project.json in the active folder.'
        : status === 'broken'
            ? `avr-project.json is broken JSON:\n${parseError}`
            : Validator.reportText(proj, root);
    const doc = vscode.window.createOutputChannel('AVR — Project Report');
    doc.clear();
    doc.appendLine(text);
    doc.show(true);
}

// ─── Disassembly (the sdcc-mdf 0.29.0 pattern, AVR-flavoured) ───────────────
// v0.3.6 — the picker, the exact sdcc-mdf shape: sdcc's own build already
// leaves a source-interleaved .rst next to every object and its Disassembly
// command just collects them into a QuickPick; avr-gcc leaves none, so the
// picker offers what WE can produce — the FULL listing from the linked ELF
// (build/<out>.lss, the classic WinAVR convention — address + opcode + the C
// source interleaved, reused while fresh) and EVERY object the build left in
// the tree (build/obj/**.o mirrors the sources, build/comp/**.o are the
// components), disassembled ON DEMAND — only when picked — into <name>.lss
// next to the object (unrelocated: addresses count from the section start,
// -r shows the relocations to resolve). No ELF and no objects → the honest
// warning with a Build offer. A single full listing (no objects) opens
// directly — the 0.3.5 feel, no picker noise.
function _walkObjects(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!e.name.startsWith('.')) _walkObjects(p, out); }
        else if (/\.o$/i.test(e.name)) out.push(p);
    }
}

// run avr-objdump → listing text (throws with stderr on empty output)
function _objdump(objdump, args, cwd) {
    const cp = require('child_process');
    const r = cp.spawnSync(objdump, args, { timeout: 20000, encoding: 'utf8', windowHide: true, cwd });
    const text = String(r.stdout || '');
    if (!text) throw new Error(String(r.stderr || 'no output'));
    return text;
}

async function cmdShowDisassembly() {
    if (H.checkBusy()) return;                       // the sdcc-mdf busy gate
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    // v0.3.10: the binutils come from EITHER toolchain — an XC8 project on
    // an XC8-only install uses XC8's own avr-objdump (<xc8>/avr/bin) instead
    // of demanding avr-gcc (XC8 ships the full avr binutils, User Guide ch. 5)
    const isXc8 = proj.toolchain === 'xc8';
    const tc = isXc8 ? Toolchain.requireXc8() : Toolchain.requireGcc();
    if (!tc) return;
    const _out = H.expandOutPaths(root, proj);
    const outDir = _out.outDirAbs;
    const outName = _out.outName;
    // avr-gcc and XC8 (0.3.10: -o is always an ELF) leave <out>.elf
    const elf = [outName + '.elf', outName + '.hex.elf']
        .map(n => path.join(outDir, n))
        .find(p => fs.existsSync(p));
    // every object the build left — the .o picker entries
    const objects = [];
    _walkObjects(outDir, objects);
    objects.sort((a, b) => a.localeCompare(b));

    if (!elf && !objects.length) {
        const build = await vscode.window.showWarningMessage(
            `AVR: nothing to disassemble in the build output (no ${outName}.elf, no objects) — build first.`,
            'Build');
        if (build === 'Build') vscode.commands.executeCommand('avr.build');
        return;
    }

    // the picker: the full ELF listing + every object, sdcc-mdf style
    const items = [];
    if (elf) items.push({
        label: `$(file-code) ${outName}.elf — full listing`,
        description: path.relative(root, path.join(outDir, outName + '.lss')),
        detail: 'the linked firmware · address + opcode + C source (avr-objdump -d -S) · the real Flash layout',
        target: elf, full: true,
    });
    for (const o of objects) items.push({
        label: `$(file-binary) ${path.basename(o)}`,
        description: path.relative(root, o),
        detail: 'object file · unrelocated — addresses from the section start, relocations shown (avr-objdump -d -S -r)',
        target: o, full: false,
    });
    // one option and it is the full listing → open it directly (the 0.3.5 feel)
    const pick = (items.length === 1 && items[0].full)
        ? items[0]
        : await vscode.window.showQuickPick(items, {
            title: 'AVR: Disassembly — pick a target',
            placeHolder: elf ? `${outName}.elf — full listing` : 'objects only — the ELF is not linked yet',
            matchOnDescription: true,
        });
    if (!pick) return;

    const target = pick.target;                      // the ELF or the picked .o
    const lss = pick.full
        ? path.join(outDir, outName + '.lss')        // build/<out>.lss
        : target.replace(/\.o$/i, '.lss');           // <obj>.lss next to the object
    // XC8's own avr-objdump for XC8 projects (xc8Modules, or <xc8>/avr/bin
    // directly), avr-gcc's otherwise
    const objdump = (isXc8 && tc.xc8Modules && tc.xc8Modules['avr-objdump'])
        || (isXc8 && tc.xc8BinDir && path.join(path.dirname(tc.xc8BinDir), 'avr', 'bin', 'avr-objdump') + (H.IS_WIN ? '.exe' : ''))
        || (tc.gcc ? path.join(path.dirname(tc.gcc), 'avr-objdump') + (H.IS_WIN ? '.exe' : '') : null);
    if (!objdump) {
        vscode.window.showErrorMessage('AVR: no avr-objdump found — XC8 ships one in <xc8>/avr/bin (re-select the XC8 folder); an avr-gcc toolchain works too.');
        return;
    }
    // regenerate only when stale or missing (mtime vs the source binary)
    let stale = true;
    try { stale = fs.statSync(lss).mtimeMs < fs.statSync(target).mtimeMs; } catch {}
    if (stale) {
        let text;
        try {
            text = _objdump(objdump,
                pick.full ? ['-d', '-S', target] : ['-d', '-S', '-r', target], root);
        } catch (e) {
            vscode.window.showErrorMessage(`AVR: avr-objdump failed — ${e.message}`);
            return;
        }
        try {
            fs.mkdirSync(path.dirname(lss), { recursive: true });   // the .o dir always exists — just in case
            fs.writeFileSync(lss, text);
        } catch {}                                    // best-effort; opening works either way
        H.log(`[disassembly] ${text.split('\n').length} lines → ${path.relative(root, lss)}`);
    }
    try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(lss));
        await vscode.languages.setTextDocumentLanguage(doc, 'c');   // objdump -S interleaves C source
        await vscode.window.showTextDocument(doc, { preview: true });
    } catch (e) {
        vscode.window.showErrorMessage(`AVR: cannot open ${path.relative(root, lss)} — ${e.message}`);
    }
}

// ─── AVR-Libc helpers ────────────────────────────────────────────────────────
function cmdLibcInsert(item) {
    // item = the tree node (module header string or the module item);
    // the tree sets includeText (e.g. '#include <xc.h>') for both datasets
    const includeText = item && typeof item === 'object' ? item.includeText : null;
    const header = includeText
        ? includeText.replace(/^#\s*include\s*<(.+)>.*$/s, '$1').trim()
        : (typeof item === 'string' ? item : (item && item.label ? String(item.label) : null));
    if (!header || !header.includes('.h')) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage(`AVR: ${header} — open a C file to insert the include.`);
        return;
    }
    const include = `#include <${header}>`;
    const doc = editor.document;
    const text = doc.getText();
    if (text.includes(include)) {
        vscode.window.setStatusBarMessage(`AVR: ${header} already included`, 2500);
        return;
    }
    editor.edit(eb => {
        // insert after the last existing #include (or at the top)
        let insertLine = 0;
        for (let i = 0; i < doc.lineCount; i++) {
            if (/^\s*#\s*include/.test(doc.lineAt(i).text)) insertLine = i + 1;
        }
        eb.insert(new vscode.Position(insertLine, 0), include + '\n');
    }).then(ok => {
        if (ok) vscode.window.setStatusBarMessage(`AVR: inserted ${include}`, 2500);
    });
}

function cmdLibcDoc(item) {
    // item = tree node of a function/macro — show its details in a QuickPick-ish info
    const label = typeof item === 'string' ? item : (item && item.label ? String(item.label) : '');
    if (!label) return;
    const datasets = [];
    if (H.getProjectToolchain() === 'xc8') {
        datasets.push(require('./xc8Data'));
        datasets.push(require('./avrlibcData'));
    } else {
        datasets.push(require('./avrlibcData'));
        datasets.push(require('./xc8Data'));
    }
    let found = null, mod = null;
    for (const d of datasets) {
        for (const m of d.MODULES) {
            for (const f of (m.functions || [])) if (f.name === label) { found = f; mod = m; break; }
            if (!found) for (const mac of (m.macros || [])) if (mac.name === label) { found = mac; mod = m; break; }
            if (found) break;
        }
        if (found) break;
    }
    if (!found) return;
    const modHeader = mod.header || mod.name || mod.id;
    const modNotes = Array.isArray(mod.notes) ? mod.notes.join(' · ') : String(mod.notes || '');
    const desc = found.desc || found.description || '';
    const isXc8mod = datasets.indexOf(datasets.find(d => d.MODULES.includes(mod))) === 0 && H.getProjectToolchain() === 'xc8';
    const md = new vscode.MarkdownString(
        `**${found.name}** — from \`${modHeader}\`\n\n` +
        `\`\`\`c\n${found.signature || found.name}\n\`\`\`\n\n` +
        `${desc}\n\n` +
        (modNotes ? `> ${modNotes}\n\n` : '') +
        (isXc8mod ? 'MPLAB XC8 C Compiler User\'s Guide for AVR MCU' : '[avr-libc manual](https://www.nongnu.org/avr-libc/user-manual/)')
    );
    vscode.window.showInformationMessage(`${found.name}: ${desc || found.signature || ''} (from ${modHeader})`, 'Copy signature')
        .then(a => { if (a === 'Copy signature') vscode.env.clipboard.writeText(found.signature || found.name); });
}

// ─── Toolchain switch (GNU avr-gcc ⇄ Microchip XC8) ──────────────────────────
async function cmdSwitchToolchain() {
    if (H.checkBusy()) return;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status === 'broken') {
        vscode.window.showErrorMessage('AVR: avr-project.json is broken JSON — fix it first.');
        return;
    }
    if (status !== 'ok') { H.warnNoProject(); return; }

    const current = proj.toolchain === 'xc8' ? 'xc8' : 'avr-gcc';
    const tc = Toolchain.detect();
    const items = [
        {
            label: `${current === 'avr-gcc' ? '$(check) ' : ''}$(circuit-board) GNU avr-gcc`,
            description: 'avr-libc · avr/io.h · ISR() · F_CPU · simavr/avr-gdb debug',
            detail: tc.gcc ? `detected: ${tc.gcc}${tc.gccVersion ? ' (v' + tc.gccVersion + ')' : ''}` : 'NOT detected — builds will fail until you install it',
            value: 'avr-gcc',
        },
        {
            label: `${current === 'xc8' ? '$(check) ' : ''}$(chip) Microchip XC8`,
            description: 'xc8-cc · <xc.h> · F_CPU/_delay_ms (util/delay.h) · #pragma config · one-step build',
            detail: tc.xc8 ? `detected: ${tc.xc8}${tc.xc8Version ? ' (v' + tc.xc8Version + ')' : ''}` : 'NOT detected — install MPLAB XC8 or pick its folder',
            value: 'xc8',
        },
    ];
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Project compiler — current: ${current === 'xc8' ? 'Microchip XC8' : 'GNU avr-gcc'} (writes "toolchain" to avr-project.json)`,
    });
    if (!pick || pick.value === current) return;

    // write the field, preserving everything else + 2-space formatting
    const file = path.join(root, 'avr-project.json');
    const next = Object.assign({}, proj, { toolchain: pick.value });
    // keep the key order natural: name, board, toolchain, …
    delete next.toolchain;
    const ordered = {};
    for (const k of ['name', 'board']) if (next[k] !== undefined) { ordered[k] = next[k]; delete next[k]; }
    ordered.toolchain = pick.value;
    Object.assign(ordered, next);
    try {
        fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n');
    } catch (e) {
        vscode.window.showErrorMessage(`AVR: failed to update avr-project.json — ${e.message}`);
        return;
    }
    H.log(`Toolchain switched: ${current} → ${pick.value} (${root})`);

    // the whole UI follows: chip, tree rows, reference view, IntelliSense
    if (H.getProvider()) H.getProvider().refresh();
    if (H.getLibcProvider()) H.getLibcProvider().refresh();
    try { require('./statusBar').refreshStatusBar(); } catch {}
    try { IntelliSense.syncAfterProjectChange(); } catch {}

    const tips = pick.value === 'xc8'
        ? 'XC8 active: xc8-cc compiles+links in one step and emits the .hex directly. main.c templates use <xc.h> — the Create New Project wizard writes the skeleton for the active toolchain. Debugging (F5) needs avr-gcc.'
        : 'avr-gcc active: the full compile → link → objcopy pipeline with avr-libc. F5 debugs on simavr.';
    vscode.window.showInformationMessage(`AVR: project toolchain → ${pick.value === 'xc8' ? 'Microchip XC8' : 'GNU avr-gcc'}.`, 'Got it');
    H.log(`Switch tips: ${tips}`);
}

// ─── Name validation (Windows-safe ASCII token) ──────────────────────────────
const WINDOWS_RESERVED_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);
function validateProjectNameValue(v) {
    const s = String(v || '').trim();
    if (!s) return 'Project name is required.';
    if (!H.isAscii(s)) return 'Only ASCII characters (Latin letters, digits, "-" and "_") — the name flows into build paths, and the toolchain requires ASCII arguments.';
    if (!/^[A-Za-z]/.test(s)) return 'The name must start with a Latin letter (digits/-/_ are not allowed as the first character).';
    if (!/^[A-Za-z0-9_-]+$/.test(s)) return 'Only Latin letters, digits, "-" and "_" are allowed.';
    if (WINDOWS_RESERVED_NAMES.has(s.toUpperCase())) return `"${s}" is a reserved Windows device name — pick a different name.`;
    if (/[. ]$/.test(s)) return 'The name must not end with a dot or a space (Windows silently strips them).';
    if (s.length > 64) return 'Keep the name under 64 characters — it participates in build paths.';
    return null;
}

function deactivate() {
    H.clearBusy();
    try { require('./monitor').disconnect('extension deactivating'); } catch {}
    const terms = H.getTerms();
    for (const t of Object.values(terms)) { try { t.dispose(); } catch {} }
    H.setTerms({});
}

module.exports = { activate, deactivate };
