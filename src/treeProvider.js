'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// treeProvider.js — three tree providers:
//   AvrProvider      — the Project & Commands view (the daily loop)
//   AvrDevtoolsProvider — the Development Tools view (utilities catalogue)
//   AvrLibcProvider  — the AVR-Libc Reference view (modules → functions)
// Colored ThemeIcon + ThemeColor tokens, persisted expansion via opts.isExpanded.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Validator = require('./validator');
const Boards = require('./boards');

class AvrItem extends vscode.TreeItem {
    constructor(label, opts) {
        super(label, vscode.TreeItemCollapsibleState.None);
        opts = opts || {};
        this.command = opts.command
            ? (typeof opts.command === 'string'
                ? { command: opts.command, title: label }
                : { title: label, ...opts.command })
            : undefined;
        this.iconPath = opts.icon
            ? new vscode.ThemeIcon(opts.icon, opts.iconColor ? new vscode.ThemeColor(opts.iconColor) : undefined)
            : undefined;
        this.description = opts.desc || '';
        this.tooltip = opts.tooltip || label;
        if (opts.contextValue) this.contextValue = opts.contextValue;
    }
}
class AvrGroup extends vscode.TreeItem {
    // v0.3.5: optional opts {desc, tooltip} — the two Development Tools
    // branches carry their state (version / not found) in the description so
    // a collapsed view still tells the story.
    constructor(id, label, children, expanded, opts) {
        super(label, expanded ? vscode.TreeItemCollapsibleState.Expanded
                              : vscode.TreeItemCollapsibleState.Collapsed);
        this.id = id;
        this._children = children;
        opts = opts || {};
        if (opts.desc) this.description = opts.desc;
        if (opts.tooltip) this.tooltip = opts.tooltip;
    }
    getChildren() { return this._children; }
}

function _base(opts) {
    return { isExpanded: (opts && typeof opts.isExpanded === 'function') ? opts.isExpanded : () => false };
}

// ─── Project & Commands ──────────────────────────────────────────────────────
class AvrProvider {
    constructor(opts) {
        this._isExpanded = _base(opts).isExpanded;
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._emitter.event;
    }
    refresh() { this._emitter.fire(undefined); }
    getTreeItem(el) { return el; }
    getChildren(el) {
        if (el instanceof AvrGroup) return el._children;
        if (el) return [];
        return this._getRoot();
    }
    _getRoot() {
        const root = H.getActiveRoot();

        let proj = null, cfgStatus = 'missing', report = null;
        if (root) {
            const loaded = Validator.readProjectConfig(root);
            cfgStatus = loaded.status;
            if (loaded.status === 'ok') {
                proj = loaded.proj;
                try {
                    report = Validator.validateProjectConfig(proj, root, { countSources: true });
                } catch (e) {
                    report = { valid: false, errors: [`validation crashed: ${e && e.message}`], warnings: [], infos: [] };
                }
            }
        }

        const items = [];

        items.push(new AvrItem('Create New Project', {
            command: 'avr.createProject', icon: 'new-folder', iconColor: 'charts.green',
            tooltip: 'Create a new AVR project from a template (board-aware main.c)',
        }));
        items.push(new AvrItem('Import Project…', {
            command: 'avr.importProject', icon: 'desktop-download', iconColor: 'charts.cyan',
            tooltip: 'Import an Arduino sketch (.ino), PlatformIO (platformio.ini), Makefile, Code::Blocks (.cbp) or Eclipse CDT (.cproject) project — a draft avr-project.json is created next to it, nothing moves',
        }));
        items.push(new AvrItem('Manage MCU definitions…', {
            command: 'avr.manageBoards', icon: 'circuit-board', iconColor: 'charts.purple',
            tooltip: 'Board Manager: add, edit, duplicate or delete MCU definitions (memory, clocks, upload defaults). Global boards are available in all projects.',
        }));

        // ── Project Folder group ─────────────────────────────────────────────
        const projChildren = [];
        if (root && proj) {
            const board = Boards.getBoard(proj.board);
            projChildren.push(new AvrItem(path.basename(root), {
                command: 'avr.selectProject',
                icon: 'folder-active', iconColor: 'charts.yellow',
                tooltip: root + '\nClick to select a different project folder.',
                contextValue: 'projectItem',
                desc: 'click to change',
            }));
            const errN = report.errors.length, warnN = report.warnings.length;
            if (errN > 0) {
                projChildren.push(new AvrItem(`config: ${errN} error${errN > 1 ? 's' : ''}`, {
                    command: 'avr.showProblems', icon: 'error', iconColor: 'charts.red',
                    tooltip: 'avr-project.json has errors — click for details (build is blocked)',
                    desc: warnN ? `+${warnN} warn` : '',
                }));
            } else if (warnN > 0) {
                projChildren.push(new AvrItem(`config: ${warnN} warning${warnN > 1 ? 's' : ''}`, {
                    command: 'avr.showProblems', icon: 'warning', iconColor: 'charts.yellow',
                    tooltip: 'avr-project.json has warnings — click for details (build continues)',
                }));
            } else {
                projChildren.push(new AvrItem('config: valid', {
                    command: 'avr.showProblems', icon: 'check', iconColor: 'charts.green',
                    tooltip: 'avr-project.json is valid — click for the full report',
                }));
            }
            projChildren.push(new AvrItem(`MCU: ${proj.board || 'unknown'}`, {
                command: 'avr.editProject',
                icon: 'circuit-board', iconColor: 'charts.purple',
                tooltip: `Board (MCU): ${proj.board || 'unknown'}${board ? `\n${board.name} · ${board.build.mcu} · flash ${(board.build.memory && board.build.memory.flash) || 0}B · RAM ${(board.build.memory && board.build.memory.ram) || 0}B` : ''}\nChange it in the Project Editor (✎) or via the Board Manager`,
            }));
            const srcCount = (proj.sources || []).length;
            const isXc8 = (proj.toolchain === 'xc8');
            {
                let detail = '';
                try {
                    const tc = H.getToolchainCache() || require('./toolchain').detect();
                    if (isXc8 && tc.xc8) detail = `\n${tc.xc8}${tc.xc8Version ? ' · v' + tc.xc8Version : ''}`;
                    else if (!isXc8 && tc.gcc) detail = `\n${tc.gcc}${tc.gccVersion ? ' · v' + tc.gccVersion : ''}`;
                    else detail = '\ncompiler not detected';
                } catch {}
                projChildren.push(new AvrItem(isXc8 ? 'Toolchain: XC8 (xc8-cc)' : 'Toolchain: avr-gcc (GNU)', {
                    command: 'avr.switchToolchain',
                    icon: 'chip', iconColor: isXc8 ? 'charts.orange' : 'charts.green',
                    tooltip: (isXc8
                        ? 'Microchip XC8 — compiles AND links in one xc8-cc step, emits the .hex directly.'
                        : 'GNU avr-gcc + avr-libc — the classic compile → link → objcopy pipeline.') +
                        detail + '\nClick (or Ctrl+Alt+T) to switch avr-gcc ⇄ XC8.',
                    desc: 'switch',
                }));
            }
            projChildren.push(new AvrItem(`Sources: ${srcCount} rule(s)${report.counts && report.counts.sources !== undefined ? ` · ${report.counts.sources} file(s)` : ''}`, {
                icon: 'file-code', iconColor: 'charts.orange',
                tooltip: 'Application source files (proj.sources[]). Default folder: src/ — scanned recursively for .c/.cpp/.S/.s (assembled by avr-gcc itself).',
            }));
            const incCount = (proj.includes || []).length;
            projChildren.push(new AvrItem(`Includes: ${incCount} dir(s)`, {
                icon: 'file-code', iconColor: 'charts.orange',
                tooltip: (proj.includes || []).map(i => typeof i === 'string' ? i : String(i && i.path)).join('\n') +
                    (incCount ? '' : '\n(no include dirs — add an "include" folder)'),
            }));
            let libCount = 0;
            for (const entry of (proj.libraries || [])) {
                if (typeof entry === 'string') {
                    if (entry.toLowerCase().endsWith('.a')) libCount += 1;
                    else {
                        try {
                            const dir = path.join(root, entry);
                            if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
                                libCount += fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.a')).length;
                            }
                        } catch {}
                    }
                } else libCount += 1;
            }
            projChildren.push(new AvrItem(`Libraries: ${libCount}`, {
                icon: 'library', iconColor: 'charts.blue',
                tooltip: 'Prebuilt .a archives — linked as-is after the components.\nproj.libraries[] entries: a folder is scanned for *.a, a .a file is linked directly.',
            }));
            let compCount = report.counts && report.counts.components !== undefined ? report.counts.components : 0;
            for (const entry of (proj.components || [])) {
                if (typeof entry === 'string') {
                    try {
                        const dir = path.join(root, entry);
                        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
                            compCount = Math.max(compCount,
                                fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).length);
                        }
                    } catch {}
                }
            }
            projChildren.push(new AvrItem(`Components: ${compCount}`, {
                icon: 'package', iconColor: 'charts.cyan',
                tooltip: 'Source libraries — compiled with the project board flags, archived with avr-ar, linked after the app objects.\nEach subfolder of a components[] folder is one source library.',
            }));
            const outDir = (proj.build && proj.build.output_dir) || 'build';
            projChildren.push(new AvrItem(`Output: ${outDir}/`, {
                icon: 'folder', iconColor: 'charts.yellow',
                tooltip: `${outDir}/ — obj/**, firmware.elf/.hex/.bin/.eep/.map`,
            }));
            const hookNames = Object.keys((proj.build && proj.build.hooks) || {});
            if (hookNames.length) {
                projChildren.push(new AvrItem(`Hooks: ${hookNames.join(', ')}`, {
                    icon: 'list-unordered', iconColor: 'charts.orange',
                }));
            }
        } else if (root && cfgStatus === 'broken') {
            projChildren.push(new AvrItem(path.basename(root), {
                command: 'avr.selectProject', icon: 'folder', iconColor: 'charts.yellow',
                tooltip: root + '\n(avr-project.json has a JSON syntax error!)\nClick to select a different project folder.',
                contextValue: 'projectItem', desc: 'click to change',
            }));
            projChildren.push(new AvrItem('config: broken JSON', {
                command: 'avr.showProblems', icon: 'error', iconColor: 'charts.red',
                tooltip: 'avr-project.json cannot be parsed — click for the error',
            }));
        } else if (root) {
            projChildren.push(new AvrItem(path.basename(root), {
                command: 'avr.selectProject', icon: 'folder', iconColor: 'charts.yellow',
                tooltip: root + '\n(no avr-project.json found)\nClick to select a different project folder.',
                contextValue: 'projectItem', desc: 'click to change',
            }));
            projChildren.push(new AvrItem('avr-project.json: not found', {
                command: 'avr.createProject', icon: 'warning', iconColor: 'charts.yellow',
                tooltip: 'This folder is not an AVR project. Click to create one here…',
            }));
        } else {
            projChildren.push(new AvrItem('folder not found', {
                command: 'avr.selectProject', icon: 'error', iconColor: 'charts.red',
                tooltip: 'Select project workspace folder', desc: 'click to select',
            }));
        }
        items.push(new AvrGroup('projectGroup', '📁  Project Folder', projChildren, this._isExpanded('projectGroup')));

        // ── Actions ──────────────────────────────────────────────────────────
        items.push(new AvrGroup('actionsGroup', '⚙️  Actions', [
            new AvrItem('Build', {
                command: 'avr.build', icon: 'tools', iconColor: 'charts.green',
                tooltip: 'avr-gcc build (Ctrl+Alt+B) — compile → link → .hex/.bin/.eep + size report',
            }),
            new AvrItem('Flash', {
                command: 'avr.flash', icon: 'zap', iconColor: 'charts.blue',
                tooltip: 'Flash firmware with avrdude (Ctrl+Alt+F)',
            }),
            new AvrItem('Clean', {
                command: 'avr.clean', icon: 'trash', iconColor: 'charts.red',
                tooltip: 'Remove build output (Ctrl+Alt+C)',
            }),
            // v0.3.5 — the Disassembly row, the sdcc-mdf 0.29.0 pattern; v0.3.6
            // — the picker: the full listing from the built ELF (build/<out>.lss
            // — avr-objdump -d -S: address + opcode + your C source) plus every
            // .o the build left, disassembled on demand only when picked.
            new AvrItem('Disassembly', {
                command: 'avr.showDisassembly', icon: 'file-code', iconColor: 'charts.orange',
                tooltip: 'Disassembly — pick a target: the full listing from the built ELF (.lss — address + opcode + your C source, avr-objdump -d -S) or any object from the build tree (.o — unrelocated, on demand)',
            }),
        ], this._isExpanded('actionsGroup')));

        // ── AVR specifics: fuses / eeprom / avrdude tools ────────────────────
        // v0.3.8: plain "Device" — the sdcc-mdf 0.29.0 wording (its
        // deviceGroup carries the exact same label).
        // v0.3.12 (222.jpg): the "Read Fuses from Chip" / "Write Fuses to
        // Chip" rows are GONE — duplicates of the Fuse Editor page (its own
        // ⟳ Read / ⇧ Write buttons); the EEPROM row is split into the two
        // sdcc-mdf rows (upload… / download…), matching deviceGroup there.
        items.push(new AvrGroup('avrGroup', '🔧  Device', [
            new AvrItem('Fuse Editor…', {
                command: 'avr.fuses.open', icon: 'settings-gear', iconColor: 'charts.orange',
                tooltip: 'Bit-level lfuse/hfuse/efuse editor with presets, read & write via avrdude (17 classic MCUs verified; hex mode for the rest)',
            }),
            new AvrItem('Chip Erase', {
                command: 'avr.avrdude.erase', icon: 'zap', iconColor: 'charts.red',
                tooltip: 'avrdude -e — erase flash + EEPROM (unless EESAVE) + lock bits',
            }),
            new AvrItem('EEPROM: upload…', {
                command: 'avr.eeprom.upload', icon: 'cloud-upload', iconColor: 'charts.green',
                tooltip: 'Write an EEPROM image (.hex / .eep / .bin) to the chip (avrdude -U eeprom:w:…:a) — the picker opens in build/, where <out>.eep from the last build lives',
            }),
            new AvrItem('EEPROM: download…', {
                command: 'avr.eeprom.download', icon: 'cloud-download', iconColor: 'charts.blue',
                tooltip: 'Read the chip\'s EEPROM into build/eeprom-dump-<date>.hex (avrdude -U eeprom:r:…:i) — a toast with the byte count + Open button',
            }),
        ], this._isExpanded('avrGroup')));

        // v0.3.8 (user request): the "🔌 Port Settings" branch is BACK — the
        // sdcc-mdf portGroup pattern verbatim: one row that both shows and
        // changes the serial port (avr.selectPort → the comPort config; the
        // status-bar chip, the Serial Monitor and this tree stay in sync —
        // cmdSelectPort refreshes the provider). The programmer keeps living
        // in the Project Editor's Upload card; the "avrdude Utilities" rows
        // (111.jpg) stay retired.
        const port = H.cfg('comPort') || '—';
        items.push(new AvrGroup('portGroup', '🔌  Port Settings', [
            new AvrItem(`Port: ${port}`, {
                command: 'avr.selectPort', icon: 'plug', iconColor: 'charts.blue',
                tooltip: 'Click to select port',
                desc: port === '—' ? 'not selected' : '',
            }),
        ], this._isExpanded('portGroup')));

        return items;
    }
}

// ─── Development Tools ───────────────────────────────────────────────────────
class AvrDevtoolsProvider {
    constructor(opts) {
        this._isExpanded = _base(opts).isExpanded;
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._emitter.event;
    }
    refresh() { this._emitter.fire(undefined); }
    getTreeItem(el) { return el; }
    getChildren(el) {
        if (el instanceof AvrGroup) return el._children;
        if (el) return [];
        return this._getRoot();
    }
    _getRoot() {
        const tc = H.getToolchainCache() || require('./toolchain').detect();
        const U = require('./utilsData');
        const _modsOf = (tcx) => (tcx && tcx.modules) || {};
        // v0.3.2 (111.jpg, green annotation «ВОТ ЭТИ ИКОНКИ ДОЛЖНЫ БЫТЬ ОДИНАКОВЫ
        // ДЛЯ ИНДИКАЦИИ СОСТОЯНИЙ»): ONE consistent state scheme across the
        // whole Developer Tools view — found = check/green, missing =
        // warning/yellow. Previously the rows mixed close/red, warning/yellow
        // and check/orange for the very same two states.
        // v0.3.3: _row takes the catalogue (BY_NAME) so the SAME renderer
        // serves the avr-gcc and the XC8 branches — identical layout:
        // header → includes → category groups → Utilities count → select row.
        const _row = (name, found, p, byName) => new AvrItem(name, {
            icon: found ? 'check' : 'warning',
            iconColor: found ? 'charts.green' : 'charts.yellow',
            desc: found ? '' : 'missing',
            tooltip: (found ? (p + '\n') : 'Not found.\n') +
                (byName[name] ? (byName[name].desc + '\n') : '') +
                (byName[name] && byName[name].note ? (byName[name].note + '\n') : ''),
        });
        const _catGroup = (id, g, mods, byName) => {
            const items = g.items.map(it => _row(it.name, !!mods[it.name], mods[it.name] || null, byName));
            const foundN = g.items.filter(it => mods[it.name]).length;
            return new AvrGroup(id, `${g.label} (${foundN}/${g.items.length})`, items, this._isExpanded(id));
        };
        // v0.3.5 (111.jpg, green annotation «тебе надо разделить этот общий
        // список со статистикой и командами выбора папки на две раскрывающиеся
        // ветки»): the former FLAT list is now TWO collapsible branches —
        // avr-gcc (GNU) and XC8 (Microchip). Every row below them is
        // unchanged; the branch descriptions carry the state (version /
        // not found) so even fully collapsed the view tells the story.
        const gccKids = [];
        if (tc && tc.gcc) {
            gccKids.push(new AvrItem(`avr-gcc${tc.gccVersion ? ' v' + tc.gccVersion : ''}`, {
                icon: 'check', iconColor: 'charts.green', tooltip: tc.gcc,
            }));
            if (tc.includeDir) {
                gccKids.push(new AvrItem('avr-libc', {
                    icon: 'check', iconColor: 'charts.green',
                    desc: 'include: ' + tc.includeDir.split(path.sep).slice(-2).join(path.sep),
                    tooltip: `avr-libc headers: ${tc.includeDir}\n(io.h, interrupt.h, util/delay.h, … — see the AVR-Libc Reference view)`,
                }));
            } else {
                gccKids.push(new AvrItem('avr-libc headers', {
                    icon: 'warning', iconColor: 'charts.yellow',
                    desc: 'not found',
                    tooltip: 'avr/include not located next to avr-gcc — IntelliSense and builds that #include <avr/io.h> may fail.',
                }));
            }
            for (const g of U.GROUPS) {
                if (g.id === 'core') {
                    for (const it of g.items) {
                        if (it.name === 'avr-gcc') continue;
                        gccKids.push(_row(it.name, !!_modsOf(tc)[it.name], _modsOf(tc)[it.name] || null, U.BY_NAME));
                    }
                } else {
                    gccKids.push(_catGroup(g.treeId || ('tc' + g.id + 'Group'), g, _modsOf(tc), U.BY_NAME));
                }
            }
            const foundN = U.ALL.filter(n => _modsOf(tc)[n]).length;
            gccKids.push(new AvrItem('Utilities', {
                icon: 'package', iconColor: 'charts.cyan',
                desc: `${foundN}/${U.ALL.length} found`,
                tooltip: `${U.ALL.length} tools of the AVR toolchain + companions (avrdude, simavr, avarice, make) resolved live from the toolchain folder and PATH.`,
            }));
            gccKids.push(new AvrItem('Select avr-gcc toolchain…', {
                command: 'avr.selectToolchain', icon: 'folder-opened', iconColor: 'charts.orange',
                tooltip: 'Auto-detected locations, browse for the bin folder / avr-gcc, or clear',
            }));
        } else {
            gccKids.push(new AvrItem('avr-gcc not found', {
                command: 'avr.selectToolchain', icon: 'warning', iconColor: 'charts.yellow',
                tooltip: 'avr-gcc not found. Click to select the toolchain — browse for the executable or the folder (the extracted avr-gcc-16.1.0-x64-windows or any parent of it; nested layouts are deep-scanned).',
            }));
        }
        // ── Microchip XC8 (the alternative toolchain) ─────────────────────
        // v0.3.3 (111.jpg — «вывод статистики для XC8 должен соответствовать
        // avr-gcc»): the XC8 branch mirrors the avr-gcc branch EXACTLY —
        // version header → include-dirs row → category groups with live
        // found-counts (driver tools, the GCC AVR backend, its binutils, the
        // PIC backend — all resolved from the REAL xc8-v4.00 layout) → a
        // Utilities N/M row → the select row.
        const xc8Kids = [];
        if (tc && tc.xc8) {
            const xmods = tc.xc8Modules || {};
            xc8Kids.push(new AvrItem(`xc8-cc${tc.xc8Version ? ' v' + tc.xc8Version : ''}`, {
                icon: 'check', iconColor: 'charts.green', tooltip: tc.xc8,
                desc: 'Microchip XC8',
            }));
            const incs = tc.xc8IncludeDirs || [];
            if (incs.length) {
                xc8Kids.push(new AvrItem('XC8 includes', {
                    icon: 'check', iconColor: 'charts.green',
                    desc: `${incs.length} dir${incs.length > 1 ? 's' : ''}`,
                    tooltip: 'XC8 system include dirs (the GCC AVR backend avr-libc, the PIC headers…):\n' + incs.join('\n'),
                }));
            } else {
                xc8Kids.push(new AvrItem('XC8 includes', {
                    icon: 'warning', iconColor: 'charts.yellow', desc: 'not found',
                    tooltip: 'No XC8 include dirs located next to xc8-cc — IntelliSense may miss <xc.h> / <avr/io.h>.',
                }));
            }
            for (const g of U.XC8_GROUPS) {
                xc8Kids.push(_catGroup(g.treeId, g, xmods, U.XC8_BY_NAME));
            }
            const xFound = U.XC8_ALL.filter(n => xmods[n]).length;
            xc8Kids.push(new AvrItem('XC8 utilities', {
                icon: 'package', iconColor: 'charts.cyan',
                desc: `${xFound}/${U.XC8_ALL.length} found`,
                tooltip: `${U.XC8_ALL.length} tools of the XC8 distribution (driver tools + the GCC AVR backend + its binutils + the PIC backend) resolved live from the xc8-v4.00 layout.`,
            }));
            xc8Kids.push(new AvrItem('Select XC8 toolchain…', {
                command: 'avr.selectXc8Path', icon: 'folder-opened', iconColor: 'charts.orange',
                tooltip: 'Auto-detected locations, browse for the bin folder / xc8-cc, or clear',
            }));
        } else {
            // v0.3.2: same not-found icon as avr-gcc — one state, one glyph
            // (was close/red before).
            xc8Kids.push(new AvrItem('XC8 not found', {
                command: 'avr.selectXc8Path', icon: 'warning', iconColor: 'charts.yellow',
                tooltip: 'Microchip XC8 (xc8-cc) not found — it compiles both AVR and PIC 8-bit devices.\nClick to select its install folder (the extracted xc8-v4.00 or any parent of it; nested layouts are deep-scanned).',
                desc: 'optional alternative toolchain',
            }));
        }
        return [
            new AvrGroup('gccBranch', 'avr-gcc (GNU)', gccKids, this._isExpanded('gccBranch'), {
                desc: (tc && tc.gcc) ? (tc.gccVersion ? 'v' + tc.gccVersion : 'found') : 'not found',
                tooltip: (tc && tc.gcc)
                    ? `${tc.gcc}\nThe GNU AVR toolchain — the default compiler (avr-gcc + avr-libc + binutils).`
                    : 'avr-gcc not found. Expand the branch and click the Select row (or the warning row) to pick the toolchain.',
            }),
            new AvrGroup('xc8Branch', 'XC8 (Microchip)', xc8Kids, this._isExpanded('xc8Branch'), {
                desc: (tc && tc.xc8) ? (tc.xc8Version ? 'v' + tc.xc8Version : 'found') : 'not found',
                tooltip: (tc && tc.xc8)
                    ? `${tc.xc8}\nMicrochip XC8 — the alternative compiler (AVR + PIC 8-bit via the xc8-cc driver).`
                    : 'Microchip XC8 (xc8-cc) not found — the optional alternative toolchain.\nExpand the branch and click the Select row to pick its install folder.',
            }),
        ];
    }
}

// ─── Reference view: avr-libc (GNU) or XC8 (Microchip) ──────────────────────
class AvrLibcProvider {
    constructor() {
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._emitter.event;
        this._libc = require('./avrlibcData');
        this._xc8 = require('./xc8Data');
    }
    // the dataset follows the ACTIVE project's toolchain
    _data() {
        return H.getProjectToolchain() === 'xc8' ? this._xc8 : this._libc;
    }
    // field adapters: avrlibcData uses header/summary/notes(string);
    // xc8Data uses name/description/notes(array)
    _header(mod) { return mod.header || mod.name || mod.id; }
    _summary(mod) { return mod.summary || mod.description || ''; }
    _notes(mod) {
        const n = mod.notes;
        if (Array.isArray(n)) return n.join('\n');
        return String(n || '');
    }
    refresh() { this._emitter.fire(undefined); }
    getTreeItem(el) { return el; }
    getChildren(el) {
        if (el instanceof AvrGroup) return el._children;
        if (el) return [];
        const data = this._data();
        const isXc8 = data === this._xc8;
        const kids = [];
        kids.push(new AvrItem(`${data.MODULES_COUNT} modules · ${data.FUNCTIONS_COUNT} entries`, {
            icon: 'book', iconColor: 'charts.cyan',
            tooltip: isXc8
                ? 'The Microchip XC8 catalogue: <xc.h>, delays, interrupts, #pragma config, the C library subset and the xc8-cc driver options.\nSwitch the project toolchain to avr-gcc to browse avr-libc instead. Manual: XC8 C Compiler User\'s Guide for AVR MCU.'
                : 'The avr-libc catalogue (2.x): every header the toolchain ships with its functions, macros and usage notes.\nRight-click a module → insert its #include. The manual: https://www.nongnu.org/avr-libc/user-manual/\nSwitch the project toolchain to XC8 to browse the XC8 reference instead.',
            desc: isXc8 ? 'XC8 (project toolchain)' : 'avr-libc (project toolchain)',
        }));
        for (const mod of data.MODULES) {
            const children = [];
            for (const fn of (mod.functions || [])) {
                children.push(new AvrItem(fn.name, {
                    icon: 'symbol-function', iconColor: 'charts.blue',
                    desc: (fn.signature || '').slice(0, 60),
                    tooltip: `${fn.signature || fn.name}\n${fn.desc || ''}`,
                    contextValue: 'avrlibc.function',
                }));
            }
            for (const mac of (mod.macros || [])) {
                children.push(new AvrItem(mac.name, {
                    icon: 'symbol-constant', iconColor: 'charts.orange',
                    desc: 'macro',
                    tooltip: `${mac.name} — ${mac.desc || ''}`,
                    contextValue: 'avrlibc.function',
                }));
            }
            kids.push(new AvrGroup((isXc8 ? 'xc8.' : 'libc.') + mod.id, this._header(mod), children, false));
            // module item carries the include for the context-menu insert
            const modItem = kids[kids.length - 1];
            const notes = this._notes(mod);
            modItem.tooltip = new vscode.MarkdownString(
                `**${this._header(mod)}** — ${this._summary(mod)}\n\n` +
                (notes ? notes + '\n\n' : '') +
                '```c\n' + mod.include + '\n```');
            modItem.description = `${(mod.functions || []).length}+`;
            modItem.includeText = mod.include;   // used by avr.libc.insert
            modItem.contextValue = 'avrlibc.module';
            modItem.iconPath = new vscode.ThemeIcon('file-code', new vscode.ThemeColor('charts.green'));
        }
        return kids;
    }
}

module.exports = { AvrItem, AvrGroup, AvrProvider, AvrDevtoolsProvider, AvrLibcProvider };
