'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// flash.js — avrdude integration: Flash / EEPROM up+download / chip erase /
// the interactive terminal / part & programmer listings.
//
// The command is assembled from: project upload{} + board upload{} +
// avr.programmer/avr.comPort settings + avr.avrdude.* settings. A custom
// upload.tool + args with full ${...} variable expansion overrides everything.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Toolchain = require('./toolchain');
const Boards = require('./boards');
const Validator = require('./validator');
const Hooks  = require('./hooks');
const { buildVars } = require('./build');

const TERM = 'AVR';

// ─── Flash recipes (one-click programmer configurations) ─────────────────────
// ids verified against the avrdude 8.2 manual, Appendix C (List of
// Programmers): dragon_pp (HVPP), flip1 (DFU v1 for ATmega*U*), avr109 with
// the documented -r "1200 bps touch" that opens Caterina bootloaders.
// flags: extra avrdude options the recipe always carries.
const RECIPES = [
    { id: 'usbasp',       label: 'USBasp (ISP)',                    port: 'usb',  baud: '',      desc: 'The classic open ISP programmer. Slow-clock rescue: add -B 32 (avrdude 7+) for fresh chips.' },
    { id: 'usbtiny',      label: 'USBtinyISP (ISP)',                port: 'usb',  baud: '',      desc: 'Ladyada\'s tiny ISP stick.' },
    { id: 'arduino',      label: 'Optiboot / Arduino (bootloader)', port: 'serial', baud: '115200', desc: 'Uno/Nano/Pro Mini bootloader: DTR auto-reset + flash write.' },
    { id: 'stk500v1',     label: 'STK500 v1 (old bootloader/ISP)',  port: 'serial', baud: '19200', desc: 'Ancient Arduino bootloaders and serial STK500 clones.' },
    { id: 'stk500v2',     label: 'STK500 v2 (ISP)',                 port: 'serial', baud: '115200', desc: 'STK500 compatible (also the mkII protocol).' },
    { id: 'avr109',       label: 'Caterina / avr109 (Leonardo)',    port: 'serial', baud: '57600', flags: ['-r'], desc: 'ATmega32U4 boards: Leonardo, Micro, Pro Micro. -r does the 1200 bps touch that opens the bootloader (avrdude 7+).' },
    { id: 'urclock',      label: 'Urclock bootloader (avrdude 7+)', port: 'serial', baud: '115200', desc: 'The modern urprotocol bootloader — avrdude 7 native.' },
    { id: 'serialupdi',   label: 'SerialUPDI (UPDI)',               port: 'serial', baud: '115200', desc: 'UPDI programming through a plain USB-serial adapter + resistor (avrdude 7+).' },
    { id: 'jtag2updi',    label: 'jtag2updi (Arduino as UPDI programmer)', port: 'serial', baud: '115200', desc: 'The jtag2updi sketch on an Arduino boardside.' },
    { id: 'atmelice_isp', label: 'Atmel-ICE (ISP)',                 port: 'usb',  baud: '',      desc: 'Atmel-ICE in ISP mode.' },
    { id: 'atmelice_pdi', label: 'Atmel-ICE (PDI — xmega)',         port: 'usb',  baud: '',      desc: 'ATxmega via PDI.' },
    { id: 'atmelice_updi',label: 'Atmel-ICE (UPDI)',                port: 'usb',  baud: '',      desc: 'Modern AVR parts via UPDI.' },
    { id: 'pickit4_updi', label: 'PICkit 4 (UPDI/ISP)',             port: 'usb',  baud: '',      desc: 'PICkit 4 UPDI — -x hvupdi enables high-voltage UPDI entry for a pin locked as RESET/GPIO.' },
    { id: 'snap_updi',    label: 'MPLAB SNAP (UPDI/ISP)',           port: 'usb',  baud: '',      desc: 'MPLAB SNAP in UPDI mode.' },
    { id: 'powerdebugger_updi', label: 'Power Debugger (UPDI)',     port: 'usb',  baud: '',      desc: 'Power Debugger — UPDI (high-voltage entry with -x hvupdi).' },
    { id: 'dragon_isp',   label: 'AVR Dragon (ISP)',                port: 'usb',  baud: '',      desc: 'The Dragon in ISP mode.' },
    { id: 'dragon_pp',    label: 'AVR Dragon (HV parallel)',        port: 'usb',  baud: '',      desc: 'High-voltage parallel programming (HVPP) — rescues RSTDISBL/SPIEN mishaps.' },
    { id: 'dragon_dw',    label: 'AVR Dragon (debugWIRE)',          port: 'usb',  baud: '',      desc: 'debugWIRE (DWEN fuse set) — the Dragon speaks dw.' },
    { id: 'buspirate',    label: 'Bus Pirate (ISP)',                port: 'serial', baud: '115200', desc: 'The Bus Pirate as a slow-but-universal AVR programmer.' },
    { id: 'flip1',        label: 'FLIP / flip1 (ATmega32U4 DFU v1)', port: 'usb',  baud: '',      desc: 'The native USB DFU v1 bootloader on ATmega32U4/16U2-class parts (flip2 is the DFU v2 flavour for Xmega).' },
    { id: 'custom',       label: 'Custom (edit in the project)',    port: 'usb',  baud: '',      desc: 'Set upload.tool / upload.args in avr-project.json — full ${…} variable expansion.' },
];
function recipeFor(id) { return RECIPES.find(r => r.id === id) || null; }

// Does this programmer need a serial port (-P COMx / /dev/ttyUSB0)?
function needsPort(programmerId) {
    const r = recipeFor(programmerId);
    if (r) return r.port === 'serial';
    // heuristic for ids not in the table
    return ['arduino', 'avr109', 'stk500', 'avrisp', 'serialupdi', 'jtag2', 'buspirate', 'urclock', 'avr910', 'jtagmkii', 'jtag2updi']
        .some(p => programmerId.startsWith(p));
}

// ─── The avrdude argv assembly ───────────────────────────────────────────────
function avrdudeArgv({ proj, board, tc, op }) {
    // op: { us: ['-U','flash:w:...:a'], e?: bool }
    const up = (proj && proj.upload) || {};
    const bUp = (board && board.upload) || {};
    const programmer = String(up.programmer || H.cfg('programmer') || bUp.protocol || 'usbasp');
    const part = String((board && board.build && board.build.mcu) || (proj && proj.board) || '');
    const baud = String(up.baud || bUp.speed || recipeFor(programmer)?.baud || '');
    const port = String(up.port || H.cfg('comPort') || '');

    const argv = ['-c', programmer, '-p', part];
    if (needsPort(programmer)) {
        if (!port) return { error: `The programmer "${programmer}" needs a serial port — select one first (AVR: Select Port).` };
        argv.push('-P', port);
        if (baud) argv.push('-b', String(parseInt(baud, 10) || baud));
    }
    // recipe-carried options (e.g. avr109's -r 1200 bps touch — avrdude 7+;
    // avrdude 8.2 manual, -r: "used to trigger programming mode for certain
    // boards like Arduino Leonardo, Arduino Micro/Pro Micro")
    const recipe = recipeFor(programmer);
    if (recipe && Array.isArray(recipe.flags)) argv.push(...recipe.flags);
    if (H.cfg('avrdude.verbose')) argv.push('-v');
    if (!H.cfg('avrdude.verify')) argv.push('-V');
    const extra = String(H.cfg('avrdude.extraArgs') || '').trim();
    if (extra) argv.push(...extra.split(/\s+/));
    if (Array.isArray(up.extra_args)) argv.push(...up.extra_args);
    if (op.erase) argv.push('-e');
    for (const u of (op.us || [])) argv.push('-U', u);
    return { exe: tc.avrdude, argv, programmer, part, port };
}

// ─── Flash ───────────────────────────────────────────────────────────────────
async function flash() {
    if (H.checkBusy()) return;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const tc = Toolchain.requireAvrdude();
    if (!tc) return;
    const board = Boards.getBoard(proj.board);

    // firmware artifact (v0.3.20: ${…}-expanded output paths)
    const _out = H.expandOutPaths(root, proj);
    const outDirRel = _out.outDirRel;
    const outName = _out.outName;
    const hexPath = path.join(_out.outDirAbs, outName + '.hex');
    const elfPath = path.join(_out.outDirAbs, outName + '.elf');

    const up = proj.upload || {};
    // custom tool override
    if (up.tool && up.tool !== 'avrdude' && Array.isArray(up.args)) {
        await flashCustom(proj, up);
        return;
    }

    let fw = hexPath;
    let fwFmt = 'a';                       // auto: .hex → Intel Hex (the -U default)
    if (!fs.existsSync(fw) && fs.existsSync(elfPath)) {
        fw = elfPath;
        fwFmt = 'e';                       // explicit ELF input (avrdude ≥7;
                                          // manual example: -U flash:w:blink.elf:e)
    }
    if (!fs.existsSync(fw)) {
        const pick = await vscode.window.showErrorMessage(
            `AVR: ${outName}.hex not found — build the project first (${outDirRel}/).`,
            'Build now'
        );
        if (pick === 'Build now') { await require('./build').build(); }
        return;
    }

    const ops = [`flash:w:${fw}:${fwFmt}`];
    if (up.eeprom) {
        // v0.3.21: outDirAbs, NOT path.join(root, outDirRel) — an absolute
        // output_dir (${workspaceFolder}/out) made join() glue root+abs and
        // the .eep existence check silently failed (EEPROM never flashed)
        const eepPath = path.join(_out.outDirAbs, outName + '.eep');
        if (fs.existsSync(eepPath)) ops.push(`eeprom:w:${eepPath}:a`);
    }
    const built = avrdudeArgv({ proj, board, tc, op: { us: ops, erase: !!H.cfg('avrdude.eraseBeforeFlash') } });
    if (built.error) {
        vscode.window.showErrorMessage(`AVR: ${built.error}`, 'Select Port')
            .then(a => { if (a === 'Select Port') vscode.commands.executeCommand('avr.selectPort'); });
        return;
    }

    // v0.3.16: the toolchain NAME string (build.js passes 'avr-gcc'/'xc8') —
    // the tc OBJECT here stringified to "[object Object]" inside ${toolchain}
    // in pre/post_upload hooks and custom upload args.
    const vars = buildVars(root, proj, board, { toolchain: H.getProjectToolchain(root) });
    // pre_upload hook
    H.setBusy('Flash');
    try {
        const preEc = await Hooks.runHook(proj, 'pre_upload', vars, TERM);
        if (preEc !== 0) {
            vscode.window.showErrorMessage(`AVR: pre_upload hook failed (exit ${preEc}) — flash aborted.`);
            return;
        }
        H.log(`[flash] avrdude ${built.argv.join(' ')}`);
        const line = [H.q(built.exe), ...built.argv.map(a => (/[^\w:,=+.\-\/\\]/.test(a) ? H.q(a) : a))].join(' ');
        const ec = await H.runInTerminal(TERM, [line]);
        if (ec === 0) {
            H.flashBarFeedback('flash', '$(check) Flashed', '$(zap) Flash');
            const postEc = await Hooks.runHook(proj, 'post_upload', vars, TERM);
            if (postEc !== 0) H.log(`[flash] post_upload hook exit ${postEc} (ignored)`);
            H.log('✔ Flash OK');
            if (H.cfg('monitorAutoOpen')) {
                const Monitor = require('./monitor');
                Monitor.reveal();
                if (!Monitor.isConnected()) Monitor.connectDefault();
            }
            return true;
        } else if (ec === -1) {
            vscode.window.showErrorMessage('AVR: flash interrupted (no exit code seen).');
            return false;
        } else {
            vscode.window.showErrorMessage(`AVR: avrdude failed (exit ${ec}) — see the AVR terminal output.`);
            return false;
        }
    } finally {
        H.clearBusy();
    }
}

async function flashCustom(proj, up) {
    const root = H.getActiveRoot();
    const board = Boards.getBoard(proj.board);
    const vars = buildVars(root, proj, board, { toolchain: H.getProjectToolchain(root) });
    const resolved = up.args.map(a => H.configVarResolver()(H.envVarResolver()(H.expandVars(a, vars))));
    const line = [H.q(up.tool), ...resolved.map(a => (/[^\w:,=+.\-\/\\]/.test(a) ? H.q(a) : a))].join(' ');
    H.setBusy('Flash');
    try {
        H.log(`[flash] custom tool: ${line}`);
        const ec = await H.runInTerminal(TERM, [line]);
        if (ec === 0) {
            H.flashBarFeedback('flash', '$(check) Flashed', '$(zap) Flash');
            return true;
        } else {
            vscode.window.showErrorMessage(`AVR: custom upload tool failed (exit ${ec}).`);
            return false;
        }
    } finally {
        H.clearBusy();
    }
}

// ─── EEPROM / erase / listings / terminal ────────────────────────────────────
// v0.3.12 (222.jpg): the EEPROM pair rebuilt on the sdcc-mdf device.js flow —
// a FILE PICKER for the upload (any .hex/.eep/.bin image, the dialog opening
// in build/ where <out>.eep lands), a timestamped dump in build/ for the
// download with an exit-code-aware toast (+ byte count + Open button), and
// the busy gate BEFORE any dialog work. runAvrdudeOp now RETURNS the exit
// code so the caller can branch on it (the old download toasted "saved" on
// file existence alone — even when avrdude had failed).
async function eepromUpload() {
    if (H.checkBusy()) return;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const _out0 = H.expandOutPaths(root, proj);
    const outName = _out0.outName;
    const buildDir = _out0.outDirAbs;
    const eepArtifact = path.join(buildDir, outName + '.eep');
    // the sdcc-mdf picker: any EEPROM image; smart default dir — build/ with
    // the .eep from the last build, the project root before the first build
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false, openLabel: 'Write EEPROM image',
        title: `AVR: EEPROM image to write (.hex / .eep / .bin)${fs.existsSync(eepArtifact) ? ` — ${outName}.eep from the last build is in ${_out0.outDirRel}/` : ''}`,
        defaultUri: vscode.Uri.file(fs.existsSync(buildDir) ? buildDir : root),
        filters: { 'EEPROM images': ['hex', 'eep', 'bin'], 'All files': ['*'] },
    });
    if (!picked || !picked.length) return;
    const file = picked[0].fsPath;
    if (!fs.existsSync(file)) { vscode.window.showErrorMessage(`AVR: file not found: ${file}`); return; }
    // :a — auto-detect the INPUT format (avrdude 8.2 manual: sniffed from the
    // content — Intel Hex .hex/.eep, raw .bin); the manual's ":a … valid for
    // input only" is exactly the upload case
    await runAvrdudeOp([`eeprom:w:${file}:a`], 'EEPROM upload');
}

async function eepromDownload() {
    if (H.checkBusy()) return;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    let outDir = H.expandOutPaths(root, proj).outDirAbs;
    try { if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true }); }
    catch { outDir = root; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);   // 2026-09-14T17-09-18
    const target = path.join(outDir, `eeprom-dump-${stamp}.hex`);
    const ec = await runAvrdudeOp([`eeprom:r:${target}:i`], 'EEPROM download', { board: Boards.getBoard(proj.board) });
    if (ec === 0 && fs.existsSync(target)) {
        const size = fs.statSync(target).size;
        vscode.window.showInformationMessage(`AVR: EEPROM read → ${path.relative(root, target)} (${size} bytes)`, 'Open')
            .then(a => { if (a === 'Open') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target)); });
        H.log(`[eeprom] dumped → ${target}`);
    } else if (ec === 0) {
        // avrdude exit 0 without a dump file — nothing was created on disk
        vscode.window.showWarningMessage('AVR: avrdude exited 0 but no dump file was created.');
    }
    // ec > 0 / ec === -1 — runAvrdudeOp already showed the failure/interrupt toast
}

async function chipErase() {
    if (H.checkBusy()) return;
    const pick = await vscode.window.showWarningMessage(
        'AVR: erase the whole chip? Flash, EEPROM (unless EESAVE) and lock bits go to erased state.',
        { modal: true }, 'Erase chip'
    );
    if (pick !== 'Erase chip') return;
    await runAvrdudeOp([], 'Chip erase', { erase: true });
}

async function runAvrdudeOp(us, label, extra = {}) {
    if (H.checkBusy()) return;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }
    const tc = Toolchain.requireAvrdude();
    if (!tc) return;
    const board = extra.board || Boards.getBoard(proj.board);
    const built = avrdudeArgv({ proj, board, tc, op: { us, erase: extra.erase } });
    if (built.error) {
        vscode.window.showErrorMessage(`AVR: ${built.error}`, 'Select Port')
            .then(a => { if (a === 'Select Port') vscode.commands.executeCommand('avr.selectPort'); });
        return;
    }
    H.setBusy(label);
    try {
        const line = [H.q(built.exe), ...built.argv.map(a => (/[^\w:,=+.\-\/\\]/.test(a) ? H.q(a) : a))].join(' ');
        const ec = await H.runInTerminal(TERM, [line]);
        if (ec === 0) {
            vscode.window.showInformationMessage(`AVR: ${label} — OK.`);
            H.log(`✔ ${label} OK`);
        } else if (ec === -1) {
            vscode.window.showWarningMessage(`AVR: ${label} interrupted (no exit code seen — terminal closed or timed out).`);
        } else {
            vscode.window.showErrorMessage(`AVR: ${label} failed (exit ${ec}) — see the AVR terminal.`);
        }
        return ec;
    } finally {
        H.clearBusy();
    }
}

// v0.3.3 (111.jpg — «эти команды избыточны»): listParts / listProgrammers /
// avrdudeTerminal removed — the avrdude -p ? / -c ? listings and the -t shell
// are gone from the UI; the flash/fuses/eeprom flows are untouched.

// ─── The programmer picker (recipes) ─────────────────────────────────────────
async function selectProgrammer() {
    const root = H.getActiveRoot();
    let proj = null;
    if (root) {
        const r = Validator.readProjectConfig(root);
        if (r.status === 'ok') proj = r.proj;
    }
    const current = String((proj && proj.upload && proj.upload.programmer) || H.cfg('programmer') || '');
    const items = RECIPES.map(r => ({
        label: (r.id === current ? '$(check) ' : '') + r.label,
        description: r.id + (r.port === 'serial' ? ' · serial' : ' · USB'),
        detail: r.desc,
        recipe: r,
    }));
    const pick = await vscode.window.showQuickPick(items, {
        matchOnDescription: true, matchOnDetail: true,
        placeHolder: 'Select the avrdude programmer (-c)',
    });
    if (!pick) return;
    if (pick.recipe.id === 'custom') {
        vscode.commands.executeCommand('avr.editProject');
        return;
    }
    if (proj && root) {
        // store in the project upload block (survives, travels with the code)
        proj.upload = proj.upload || {};
        proj.upload.programmer = pick.recipe.id;
        if (pick.recipe.port === 'serial' && pick.recipe.baud) proj.upload.baud = pick.recipe.baud;
        try {
            fs.writeFileSync(path.join(root, 'avr-project.json'), JSON.stringify(proj, null, 2) + '\n');
        } catch (e) {
            vscode.window.showErrorMessage(`AVR: could not update avr-project.json — ${e.message}`);
            return;
        }
        H.log(`[flash] programmer → ${pick.recipe.id} (project)`);
    } else {
        await H.setCfg('programmer', pick.recipe.id);
        H.log(`[flash] programmer → ${pick.recipe.id} (setting)`);
    }
    if (H.getProvider()) H.getProvider().refresh();
    vscode.window.showInformationMessage(`AVR: programmer set to ${pick.recipe.id}.`);
}

module.exports = {
    flash, eepromUpload, eepromDownload, chipErase,
    selectProgrammer,
    RECIPES, needsPort, avrdudeArgv,
};
