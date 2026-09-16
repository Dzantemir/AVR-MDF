'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// build.js — the AVR-MDF build pipeline.
//
//   sources → build/obj/**.o        (avr-gcc / avr-g++ per extension; .S gets
//                                    C-preprocessed by the driver, .s is plain)
//   components → build/comp/<n>.a   (compiled with board flags, avr-ar rcs)
//   link → build/<name>.elf         (driver adds crt*.o, libc, libgcc in order;
//                                    -mrelax = assembler --mlink-relax + ld --relax)
//   objcopy → .hex (+ .bin / .eep)  (avr-objcopy -O ihex -R .eeprom …)
//   size   → terminal + memory report
//
// AVR specifics honoured here:
//   • -mmcu=<board mcu> + -DF_CPU=<board f_cpu> come from the board JSON
//   • -ffunction-sections -fdata-sections + -Wl,--gc-sections  (dead code)
//   • -mrelax — the documented AVR relaxation switch (GCC AVR Options:
//     "Setting -mrelax just adds the --mlink-relax option to the
//     assembler's command line and the --relax option to the linker's
//     command line"; avr-libc: don't pass --relax / -Wl,--relax directly)
//   • -flto optional (avr-gcc ≥ 4.9 toolchains)
//   • .eeprom section extracted to .eep only when it is non-empty
//   • Debug mode: -Og -g + DEBUG (DWARF for simavr/avr-gdb), Release: -Os
// Every step runs in the AVR terminal with an exit-code marker; a failing
// step is replayed HIDDEN (execFile) to capture stderr for the Problems panel.
// ─────────────────────────────────────────────────────────────────────────────
const vscode   = require('vscode');
const path     = require('path');
const fs       = require('fs');
const cp       = require('child_process');
const H        = require('./helpers');
const Toolchain = require('./toolchain');
const Boards   = require('./boards');
const Hooks    = require('./hooks');
const Validator = require('./validator');
const Memory   = require('./memory');
const { collectSources, collectComponents, collectLibraries, collectIncludes, C_EXTS, ASM_EXTS } = require('./sources');

const TERM = 'AVR';

// ─── The variable set for hooks / upload / output_dir expansion ──────────────
function buildVars(root, proj, board, extra = {}) {
    // v0.3.20: output_dir / output_name expand ${…} (base set + ${config:…}/
    // ${env:…}) — `build/${config:buildMode}` keeps debug and release apart
    const { outDirAbs: outDir, outName } = H.expandOutPaths(root, proj);
    const mcu = board ? board.build.mcu : String(proj.board || '').toLowerCase();
    const vars = {
        'workspaceFolder': root,
        'project.name': proj.name || path.basename(root),
        'project.root': root,
        'board.id': proj.board || '',
        'board.mcu': mcu,
        'board.name': board ? board.name : (proj.board || ''),
        'board.fcpu': board ? board.build.f_cpu : '1000000UL',
        'board.family': board ? (board.build.family || 'classic') : 'classic',
        'board.flash': board ? String(board.build.memory.flash) : '0',
        'board.ram': board ? String(board.build.memory.ram) : '0',
        'board.eeprom': board ? String(board.build.memory.eeprom) : '0',
        'board.protocol': board && board.upload ? (board.upload.protocol || '') : '',
        'outputDir': outDir,
        'outputName': outName,
        'outputElf': path.join(outDir, outName + '.elf'),
        'outputHex': path.join(outDir, outName + '.hex'),
        'outputBin': path.join(outDir, outName + '.bin'),
        'outputEep': path.join(outDir, outName + '.eep'),
        'outputMap': path.join(outDir, outName + '.map'),
        'buildMode': String(H.cfg('buildMode') || 'release').toLowerCase(),
    };
    return Object.assign(vars, extra);
}

// ─── Compiler / linker argv construction ─────────────────────────────────────
function targetFlags(board, proj) {
    if (board) return Boards.buildFlags(board);
    const mcu = String(proj.board || '').toLowerCase();
    return [`-mmcu=${mcu}`, '-DF_CPU=1000000UL'];
}
function optimizationFlags(proj) {
    const b = proj.build || {};
    // debug mode supplies its own -Og below — don't emit a contradicting level
    // (a later -O simply wins, but the command line should say one thing)
    const debug = String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug';
    if (debug) return [];
    if (typeof b.optimization === 'string' && b.optimization) return [`-O${b.optimization.replace(/^-O/, '')}`];
    if (boardOptimization(proj)) return [`-O${boardOptimization(proj)}`];
    return ['-Os'];
}
function boardOptimization(proj) {
    const b = Boards.getBoard(proj.board);
    return b && b.build && b.build.optimization ? b.build.optimization : 's';
}
function modeFlags() {
    const debug = String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug';
    return debug ? ['-Og', '-g', '-DDEBUG'] : [];
}
function sectionFlags(proj) {
    const b = proj.build || {};
    const gc = b.gc_sections !== false;      // default ON
    return gc ? ['-ffunction-sections', '-fdata-sections'] : [];
}

function compileArgv(srcObj, ctx) {
    const { tc, board, proj, includeDirs } = ctx;
    const b = proj.build || {};
    const isCxx = ['.cpp', '.cc', '.cxx'].includes(srcObj.ext);
    const exe = isCxx
        ? (path.join(path.dirname(tc.gcc), 'avr-g++') + (H.IS_WIN ? '.exe' : ''))
        : tc.gcc;
    const argv = [
        ...targetFlags(board, proj),
        ...optimizationFlags(proj),
        ...modeFlags(),
        ...sectionFlags(proj),
        ...(b.lto ? ['-flto'] : []),
        '-Wall', '-Wextra',
    ];
    // .S (uppercase) rides the C preprocessor, .s (lowercase) is plain
    // assembly — avr-gcc dispatches by case (GCC manual, "AVR Options"/Input
    // Files); forcing -x assembler-with-cpp on .s would run cpp on files that
    // may use `#` as a comment character. Non-GCC extensions (.asm/.a51/.a90)
    // have no driver dispatch at all → pick one explicitly (cpp for the macros).
    if (srcObj.kind === 'asm') {
        if (srcObj.extRaw === '.s') argv.push('-x', 'assembler');
        else argv.push('-x', 'assembler-with-cpp');
    }
    if (srcObj.kind === 'c' && Array.isArray(b.c_flags)) argv.push(...b.c_flags);
    if (isCxx && Array.isArray(b.cxx_flags)) argv.push(...b.cxx_flags);
    if (srcObj.kind === 'asm' && Array.isArray(b.asm_flags)) argv.push(...b.asm_flags);
    if (Array.isArray(b.extra_flags)) argv.push(...b.extra_flags);
    if (srcObj.flags) argv.push(...srcObj.flags);
    for (const inc of includeDirs) argv.push(`-I${inc}`);
    if (tc.includeDir) argv.push(`-I${tc.includeDir}`);
    argv.push('-c', srcObj.file, '-o', srcObj.obj);
    return { exe, argv };
}

function linkArgv(ctx) {
    const { tc, board, proj, objects, compLibs, prebuiltLibs } = ctx;
    const b = proj.build || {};
    const outElf = path.join(ctx.outDir, ctx.outName + '.elf');
    const argv = [
        ...targetFlags(board, proj),
        ...optimizationFlags(proj),
        ...(b.lto ? ['-flto'] : []),
    ];
    if (b.gc_sections !== false) argv.push('-Wl,--gc-sections');
    // -mrelax, NOT -Wl,--relax — avr-libc (linker options): "--relax: Don't use
    // this option directly or per -Wl,--relax. Instead, link with avr-gcc ...
    // -mrelax"; FAQ: "-mrelax must be given on the compiler command-line that is
    // used to link the final ELF file". Per the GCC AVR Options: -mrelax adds
    // --mlink-relax to the assembler AND --relax to the linker (trampolines/
    // EIND linker stubs require relaxation to be on).
    if (b.relax !== false) argv.push('-mrelax');
    argv.push(`-Wl,-Map=${path.join(ctx.outDir, ctx.outName + '.map')}`);
    if (Array.isArray(b.link_flags)) argv.push(...b.link_flags);
    for (const o of objects) argv.push(o);
    if (compLibs.length) {
        argv.push(`-L${path.join(ctx.outDir, 'comp')}`);
        for (const n of compLibs) argv.push(`-l${n}`);
    }
    for (const lib of prebuiltLibs) argv.push(lib.file);
    argv.push('-o', outElf);
    return { exe: tc.gcc, argv, outElf };
}

// ─── The after-build toast, ESP-IDF style ─────────────────────────────────────
//   ✅ AVR › Build succeeded in 2.4s — firmware.elf (RAM 96B/2K (5%) · Flash 1.2K/32K (4%))
// Two actions (VS Code renders the first as the primary button, the rest as
// secondary — same look as the ESP8266-IDF notification):
//   Flash  → avr.flash (the old single action)
//   Memory → reveals the Memory view (section bars, top symbols, history —
//            the report generate()/generateXc8() just refreshed for THIS build)
function _notifyBuildSuccess(prefix, outName, t0) {
    let usage = '';
    try {
        const M = require('./memory');
        usage = (M.lastUsageHuman ? M.lastUsageHuman() : '') || '';
    } catch { /* memory view's trouble must not eat the toast */ }
    const dt = (Date.now() - t0) / 1000;
    const tTxt = dt < 10 ? `${dt.toFixed(1)}s` : `${Math.round(dt)}s`;
    const msg = `✅ ${prefix} › Build succeeded in ${tTxt} — ${outName}.elf${usage ? ` (${usage})` : ''}`;
    vscode.window.showInformationMessage(msg, 'Flash', 'Memory').then(a => {
        if (a === 'Flash') vscode.commands.executeCommand('avr.flash');
        else if (a === 'Memory') vscode.commands.executeCommand('avr.memoryView.focus');
    });
}

// ─── The build ───────────────────────────────────────────────────────────────
async function build() {
    if (H.checkBusy()) return;
    const t0 = Date.now();   // the success toast reports the elapsed time
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }

    const { status, proj, parseError } = Validator.readProjectConfig(root);
    if (status === 'missing') {
        vscode.window.showErrorMessage('AVR: no avr-project.json in the project folder.', 'Create Project')
            .then(a => { if (a === 'Create Project') vscode.commands.executeCommand('avr.createProject'); });
        return;
    }
    if (status === 'broken') {
        vscode.window.showErrorMessage(`AVR: avr-project.json is broken JSON — ${parseError}`);
        return;
    }
    const report = Validator.validateProjectConfig(proj, root, { countSources: false });
    if (report.errors.length) {
        vscode.window.showErrorMessage(
            `AVR: avr-project.json has ${report.errors.length} error(s) — build blocked.`,
            'Show Problems'
        ).then(a => { if (a === 'Show Problems') vscode.commands.executeCommand('avr.showProblems'); });
        return;
    }
    // The project's compiler: GNU avr-gcc (default) or Microchip XC8
    const toolchain = proj.toolchain === 'xc8' ? 'xc8' : 'avr-gcc';
    const tc = toolchain === 'xc8' ? Toolchain.requireXc8() : Toolchain.requireGcc();
    if (!tc) return;

    const board = Boards.getBoard(proj.board);
    const vars = buildVars(root, proj, board, { 'toolchain': toolchain });

    H.setBusy('Build');
    try {
        // Save unsaved editors before compiling
        try { await vscode.workspace.saveAll(false); } catch {}

        // XC8 builds take their own single-command pipeline
        if (toolchain === 'xc8') {
            return await buildXc8(root, proj, board, tc, vars, t0);
        }

        // Output dirs (v0.3.20: ${…}-expanded — same values buildVars uses)
        const _out = H.expandOutPaths(root, proj);
        const outDir = _out.outDirAbs;
        const outName = _out.outName;
        const objDir = path.join(outDir, 'obj');
        const compDir = path.join(outDir, 'comp');
        for (const d of [outDir, objDir, compDir]) {
            try { fs.mkdirSync(d, { recursive: true }); } catch {}
        }

        // Collect sources
        const collected = collectSources(root, proj);
        if (!collected.sources.length) {
            vscode.window.showErrorMessage('AVR: no source files found (proj.sources[] — default folder "src").');
            return;
        }
        const includeDirs = collectIncludes(root, proj);

        H.log(`[build] board=${proj.board} mcu=${board ? board.build.mcu : proj.board} sources=${collected.sources.length} mode=${vars['buildMode']}`);

        // pre_build hook
        const preEc = await Hooks.runHook(proj, 'pre_build', vars, TERM);
        if (preEc !== 0) {
            vscode.window.showErrorMessage(`AVR: pre_build hook failed (exit ${preEc}) — build aborted.`);
            return;
        }

        // ── compile steps ────────────────────────────────────────────────────
        const ctx = { tc, board, proj, includeDirs, outDir, outName };
        const objects = [];
        for (const src of collected.sources) {
            const rel = path.relative(root, src.file);
            const objRel = rel.replace(/\\+/g, '/').replace(/\.[^.]+$/, '') + '.o';
            src.obj = path.join(objDir, objRel);
            try { fs.mkdirSync(path.dirname(src.obj), { recursive: true }); } catch {}
            objects.push(src.obj);
        }

        // Component compilation: each component → obj tree → .a
        const components = collectComponents(root, proj);
        const compLibs = [];
        for (const comp of components) {
            const compObjDir = path.join(objDir, 'components', comp.name);
            try { fs.mkdirSync(compObjDir, { recursive: true }); } catch {}
            const compObjs = [];
            for (const f of comp.files) {
                const extRaw = path.extname(f);
                const ext = extRaw.toLowerCase();
                if (!C_EXTS.has(ext) && !ASM_EXTS.has(ext)) continue;
                const o = path.join(compObjDir, path.basename(f).replace(/\.[^.]+$/, '') + '.o');
                const step = compileArgv({ file: f, obj: o, kind: ASM_EXTS.has(ext) ? 'asm' : 'c', ext, extRaw }, {
                    ...ctx, includeDirs: [...includeDirs, ...comp.includes],
                });
                const ec = await runStep(step, `compile ${path.relative(root, f)}`);
                if (ec !== 0) return;
                compObjs.push(o);
            }
            if (compObjs.length) {
                const libName = `avr_mdf_${comp.name.replace(/[^A-Za-z0-9_]/g, '_')}`;
                const libPath = path.join(compDir, `${libName}.a`);
                const ar = path.join(path.dirname(tc.gcc), 'avr-ar') + (H.IS_WIN ? '.exe' : '');
                const arStep = { exe: ar, argv: ['rcs', libPath, ...compObjs] };
                const ec = await runStep(arStep, `archive ${comp.name}`);
                if (ec !== 0) return;
                compLibs.push(libName);
            }
        }

        for (const src of collected.sources) {
            const step = compileArgv(src, ctx);
            const ec = await runStep(step, `compile ${path.relative(root, src.file)}`);
            if (ec !== 0) return;
        }

        // ── link ─────────────────────────────────────────────────────────────
        const prebuiltLibs = collectLibraries(root, proj);
        const linkStep = linkArgv({ ...ctx, objects, compLibs, prebuiltLibs });
        const linkEc = await runStep(linkStep, 'link');
        if (linkEc !== 0) return;

        // post_link hook
        const postLinkEc = await Hooks.runHook(proj, 'post_link', vars, TERM);
        if (postLinkEc !== 0) {
            vscode.window.showErrorMessage(`AVR: post_link hook failed (exit ${postLinkEc}) — build aborted.`);
            return;
        }

        // ── objcopy: hex (+bin, +eep) ────────────────────────────────────────
        const elfPath = linkStep.outElf;
        const hexPath = path.join(outDir, outName + '.hex');
        const binPath = path.join(outDir, outName + '.bin');
        const eepPath = path.join(outDir, outName + '.eep');
        const objcopy = path.join(path.dirname(tc.gcc), 'avr-objcopy') + (H.IS_WIN ? '.exe' : '');

        const hexStep = {
            exe: objcopy,
            // WinAVR-classic exclusion recipe (equivalent for classic parts to the
            // avr-libc demo's "-j .text -j .data -O ihex", but ALSO correct on
            // GCC ≥14 where .rodata of AVR64*/AVR128* lives in flash — an include
            // list would drop it). Fuses/lock/signature/eeprom stay out of the
            // flash image: avrdude / the Fuse Editor program them separately.
            argv: ['-O', 'ihex', '-R', '.eeprom', '-R', '.fuse', '-R', '.lock', '-R', '.signature', elfPath, hexPath],
        };
        const hexEc = await runStep(hexStep, 'objcopy → .hex');
        if (hexEc !== 0) return;

        // section sizes (hidden execFile — feeds the memory report + .eep decision)
        const sizes = await sectionSizes(tc, elfPath);
        if (H.cfg('autoHexBin')) {
            const binStep = { exe: objcopy, argv: ['-O', 'binary', elfPath, binPath] };
            const binEc = await runStep(binStep, 'objcopy → .bin');
            if (binEc !== 0) return;
            if (sizes && sizes['.eeprom'] > 0) {
                const eepStep = {
                    exe: objcopy,
                    argv: ['-j', '.eeprom', '--set-section-flags=.eeprom=alloc,load',
                           '--change-section-lma', '.eeprom=0', '-O', 'ihex', elfPath, eepPath],
                };
                const eepEc = await runStep(eepStep, 'objcopy → .eep');
                if (eepEc !== 0) return;
            }
        }

        // size line in the terminal (visible summary)
        const sizeExe = path.join(path.dirname(tc.gcc), 'avr-size') + (H.IS_WIN ? '.exe' : '');
        const sizeEc = await runStep({ exe: sizeExe, argv: [elfPath] }, 'size');
        if (sizeEc !== 0) return;   // size failing is odd but treat honestly

        // post_build hook
        const postBuildEc = await Hooks.runHook(proj, 'post_build', vars, TERM);
        if (postBuildEc !== 0) {
            vscode.window.showErrorMessage(`AVR: post_build hook failed (exit ${postBuildEc}).`);
            return;
        }

        // Memory report + view refresh (generate() is async — v0.3.16: awaited,
        // the old fire-and-forget call could toast the PREVIOUS build's usage
        // and an async rejection escaped the sync catch)
        try {
            await Memory.generate(root, proj, board, {
                elfPath, hexPath, eepPath, sections: sizes,
                mapPath: path.join(outDir, outName + '.map'),
                toolchain: tc,
                outDir,   // v0.3.21: history lands in the expanded dir
            });
        } catch (e) { H.log(`[memory] report generation failed: ${e.message}`); }

        H.flashBarFeedback('build', '$(check) Build OK', '$(tools) Build');
        H.log(`✔ Build OK: ${hexPath}`);
        _notifyBuildSuccess('AVR', outName, t0);

        // post-build action
        if (String(H.cfg('postBuildAction') || 'none') === 'flash') {
            H.clearBusy();   // flash takes the busy flag itself
            return await require('./flash').flash();
        }
        return true;   // v0.3.16: success flag — tasks.js reports ✔/✖ off this
    } finally {
        H.clearBusy();
    }
}

// ─── The XC8 pipeline ─────────────────────────────────────────────────────
//
// xc8-cc (MPLAB XC8) compiles AND assembles AND links in ONE step — but its
// -o output is ALWAYS an ELF (User Guide §3.6.2.3: "You cannot use this
// option to change the type (format) of the output file"; §3.2.2.1). The
// flashable Intel HEX is a SEPARATE avr-objcopy step, exactly as the manual
// does it (Table 3-2: ".hex … avr-objcopy application"; the MPLAB X
// "Generate hex file" checkbox just runs avr-objcopy after linking):
//
//   xc8-cc -mcpu=ATmega328P [-Wl,-Map=…] [-I…] [-D…] [-O…] [-g] [-std=c99]
//          [-Wall] -DF_CPU=… -o build/firmware.elf src/main.c … spi.s
//   avr-objcopy -O ihex -R .eeprom -R .fuse -R .lock -R .signature
//          build/firmware.elf build/firmware.hex
//
// Device names follow the MPLAB spelling (ATmega328P) — xc8McuName maps the
// board DB ids. F_CPU feeds <util/delay.h> (_delay_ms — User Guide §8.4.1:
// "The macro F_CPU should be defined…"; _XTAL_FREQ/__delay_ms are PIC-only
// constructs that DO NOT exist on the AVR target). .s/.S assembly files ride
// the SAME command — §3.2.4: "a single build command can contain a mix of C
// and assembly source files". Extra options ride along via avr.xc8.extraArgs.

// XC8 ships its OWN avr binutils (<xc8>/avr/bin/avr-objcopy…) — prefer them
// so XC8-only installs build cleanly; fall back to the avr-gcc toolchain's
// tool, then to null (the caller reports honestly).
function _xc8Tool(tc, name) {
    if (tc && tc.xc8Modules && tc.xc8Modules[name]) return tc.xc8Modules[name];
    if (tc && tc.gcc) return path.join(path.dirname(tc.gcc), name) + (H.IS_WIN ? '.exe' : '');
    return null;
}

async function buildXc8(root, proj, board, tc, vars, t0) {
    if (!t0) t0 = Date.now();   // direct callers (none today) still get honest timing
    // v0.3.20: ${…}-expanded — the same values buildVars carries
    const outDir = vars['outputDir'];
    const outName = vars['outputName'];
    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

    const collected = collectSources(root, proj);
    if (!collected.sources.length) {
        vscode.window.showErrorMessage('AVR: no source files found (proj.sources[] — default folder "src").');
        return;
    }
    const includeDirs = collectIncludes(root, proj);
    const mcu = Toolchain.xc8McuName(board ? board.build.mcu : String(proj.board || ''));
    const fcpuHz = board ? (board.build.f_cpu_hz || 1000000) : 1000000;

    H.log(`[build:xc8] board=${proj.board} mcu=${mcu} sources=${collected.sources.length} mode=${vars['buildMode']}`);

    const preEc = await Hooks.runHook(proj, 'pre_build', vars, TERM);
    if (preEc !== 0) {
        vscode.window.showErrorMessage(`AVR: pre_build hook failed (exit ${preEc}) — build aborted.`);
        return;
    }

    // sources: the driver takes .c/.cpp AND assembles .s/.S in the same
    // command (User Guide §3.2.4 — .S gets the C preprocessor, .s is plain)
    const srcFiles = [];
    for (const s of collected.sources) {
        if (['.c', '.cpp', '.cc', '.cxx', '.s', '.S'].includes(s.ext)) srcFiles.push(s.file);
        else H.log(`[build:xc8] skipped ${path.relative(root, s.file)} — the xc8-cc driver takes .c/.cpp/.s/.S`);
    }
    if (!srcFiles.length) {
        vscode.window.showErrorMessage('AVR: XC8 build found no .c/.cpp/.s/.S sources.');
        return;
    }

    // ── the one xc8-cc invocation ────────────────────────────────────────
    const isDebug = String(H.cfg('buildMode') || 'release').toLowerCase() === 'debug';
    const elfPath = path.join(outDir, outName + '.elf');   // -o is ALWAYS an ELF
    const argv = [`-mcpu=${mcu}`];
    // the linker map (User Guide §3.4.1: file.map ← -Wl,-Map=file.map) — left
    // next to the ELF for reading; the Memory view uses avr-size on the ELF
    argv.push(`-Wl,-Map=${path.join(outDir, outName + '.map')}`);
    // relaxation — the SAME build.relax switch as the gcc pipeline (the
    // Project Editor checkbox never distinguished toolchains, but XC8 silently
    // ignored it before). The xc8-cc driver documents -m[no-]relax (User Guide
    // §3.6.1.12; its driver default is -mno-relax, the extension opts into
    // relaxation for both toolchains so the setting means the same thing).
    if ((proj.build && proj.build.relax) !== false) argv.push('-mrelax');
    const opt = String(H.cfg('xc8.optimization') || 'default').toLowerCase();
    // v0.3.16: debug mode owns the level (the gcc pipeline's 0.3.11 rule —
    // "the command line should say one thing") — no -O2 … -O0 contradictions
    if (!isDebug) {
        if (opt === '0') argv.push('-O0');
        else if (opt === '1') argv.push('-O1');
        else if (opt === '2') argv.push('-O2');
        else if (opt === '3') argv.push('-O3');
    }
    if (isDebug) argv.push('-O0', '-g', '-DDEBUG');
    // -std: the xc8-cc driver documents c89/c90/c99 ONLY (User Guide Table
    // 3-11) — c11 is an avr-gcc-side choice, skipped here with a log line
    const cStd = String(H.cfg('xc8.cStandard') || 'c99').toLowerCase();
    if (['c89', 'c90', 'c99'].includes(cStd)) argv.push(`-std=${cStd}`);
    else if (cStd === 'c11') H.log('[build:xc8] -std=c11 skipped — the XC8 driver accepts c89/c90/c99 only (User Guide Table 3-11); pass a custom -std via avr.xc8.extraArgs if your build needs it');
    if (H.cfg('xc8.warnings') !== false) argv.push('-Wall');
    argv.push(`-DF_CPU=${fcpuHz}UL`);   // <util/delay.h> reads F_CPU (§8.4.1)
    for (const d of (proj.defines || [])) {
        const dv = typeof d === 'string' ? d : (d && d.name ? d.name + (d.value !== undefined ? '=' + d.value : '') : null);
        if (dv) argv.push(`-D${dv}`);
    }
    for (const inc of includeDirs) argv.push(`-I${inc}`);
    const extra = String(H.cfg('xc8.extraArgs') || '').trim();
    if (extra) argv.push(..._splitArgs(extra));
    argv.push('-o', elfPath);
    for (const f of srcFiles) argv.push(f);

    const step = { exe: tc.xc8, argv };
    const ec = await runStep(step, `xc8-cc ${outName}`);
    if (ec !== 0) return;

    // ── the Intel HEX is a separate avr-objcopy step (User Guide §3.2.2.1:
    // "If a hex file is required… avr-objcopy -O ihex a.out ex1.hex"; Table
    // 3-2: .hex ← avr-objcopy application) — same WinAVR recipe as the gcc
    // pipeline: the flash image without the eeprom/fuse/lock/signature
    // sections (fuses are burned by avrdude / the Fuse Editor, as with gcc)
    const objcopy = _xc8Tool(tc, 'avr-objcopy');
    if (!objcopy) {
        vscode.window.showErrorMessage(
            'AVR: XC8 linked the ELF, but no avr-objcopy was found — the .hex is not generated. ' +
            'XC8 ships avr-objcopy in <xc8>/avr/bin (re-select the XC8 folder); an avr-gcc toolchain works too.');
        return;
    }
    const hexPath = path.join(outDir, outName + '.hex');
    const hexEc = await runStep({
        exe: objcopy,
        argv: ['-O', 'ihex', '-R', '.eeprom', '-R', '.fuse', '-R', '.lock', '-R', '.signature', elfPath, hexPath],
    }, 'objcopy → .hex');
    if (hexEc !== 0) return;

    // section sizes (hidden — feeds the memory report + the .eep decision);
    // XC8's own avr-size (avr/bin) preferred, avr-gcc's as the fallback
    const sizes = await sectionSizes(tc, elfPath, _xc8Tool(tc, 'avr-size'));

    // the EEPROM image — the same avr-objcopy-after-linking step the MPLAB X
    // "Generate eep file" checkbox performs (§3.7.2.2); only when the linked
    // ELF actually has a non-empty .eeprom section
    const eepPath = path.join(outDir, outName + '.eep');
    let hasEep = false;
    if (sizes && sizes['.eeprom'] > 0) {
        const eepEc = await runStep({
            exe: objcopy,
            argv: ['-j', '.eeprom', '--set-section-flags=.eeprom=alloc,load',
                   '--change-section-lma', '.eeprom=0', '-O', 'ihex', elfPath, eepPath],
        }, 'objcopy → .eep');
        if (eepEc === 0) hasEep = true;
    }

    // ── memory usage: from the ELF sections (avr-size) — the GNU path the
    // AVR toolchain actually has. (The former "Program space used … of …"
    // parser was the PIC XC8 map format — XC8-for-AVR never prints it.)
    let usage = null;
    if (sizes) {
        try {
            const M = require('./memory');
            const u = M.computeUsage ? M.computeUsage(sizes, board) : null;
            if (u) usage = u;
        } catch {}
    }
    if (!usage) {
        const limits = board && board.build && board.build.memory
            ? board.build.memory : { flash: 0, ram: 0, eeprom: 0 };
        usage = {
            flash: { used: 0, total: limits.flash || 0 },
            ram:   { used: 0, total: limits.ram || 0 },
            eeprom:{ used: 0, total: limits.eeprom || 0 },
            sections: {},
        };
    }

    // post_link / post_build hooks (same lifecycle as the gcc pipeline)
    const postLinkEc = await Hooks.runHook(proj, 'post_link', vars, TERM);
    if (postLinkEc !== 0) {
        vscode.window.showErrorMessage(`AVR: post_link hook failed (exit ${postLinkEc}) — build aborted.`);
        return;
    }
    const postBuildEc = await Hooks.runHook(proj, 'post_build', vars, TERM);
    if (postBuildEc !== 0) {
        vscode.window.showErrorMessage(`AVR: post_build hook failed (exit ${postBuildEc}).`);
        return;
    }

    // Memory report + view refresh
    try {
        const M = require('./memory');
        if (M.generateXc8) {
            await M.generateXc8(root, proj, board, {
                elfPath, hexPath, eepPath: hasEep ? eepPath : null, usage, toolchain: tc,
                outDir,   // v0.3.21: history lands in the expanded dir
            });
        }
    } catch (e) { H.log(`[memory] XC8 report generation failed: ${e.message}`); }

    H.flashBarFeedback('build', '$(check) Build OK', '$(tools) Build');
    H.log(`✔ Build OK (XC8): ${hexPath}`);
    _notifyBuildSuccess('AVR (XC8)', outName, t0);

    if (String(H.cfg('postBuildAction') || 'none') === 'flash') {
        H.clearBusy();
        return await require('./flash').flash();
    }
    return true;   // v0.3.16: success flag — tasks.js reports ✔/✖ off this
}

// whitespace-split with basic quoted-segment support (avrdude-style)
function _splitArgs(str) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(String(str))) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
    return out;
}

// ─── Step runner: terminal + marker; failure → hidden replay → Problems ──────
// v0.3.16: a plain async function — the old `new Promise(async …)` executor
// swallowed a throw from runInTerminal and the build hung on the busy spinner.
async function runStep(step, label) {
    // Build the command line for the terminal: quote exe, then args
    // (flags are one-per-argv-entry; paths may contain spaces → quote each
    // argument that needs it for the active shell)
    const line = [H.q(step.exe), ...step.argv.map(a => (/[^\w:,=+.\-\/\\]/.test(a) ? H.q(a) : a))].join(' ');
    const ec = await H.runInTerminal(TERM, [line], {});
    if (ec === 0) return 0;
    if (ec === -1) {
        vscode.window.showErrorMessage(`AVR: ${label} interrupted (no exit code seen).`);
        return ec;
    }
    H.log(`✖ ${label} failed (exit ${ec}) — replaying hidden for diagnostics`);
    replayHidden(step, label, ec);
    return ec;
}
function replayHidden(step, label, ec) {
    try {
        const r = cp.spawnSync(step.exe, step.argv, { timeout: 30000, encoding: 'utf8', windowHide: true, cwd: H.getActiveRoot() || undefined });
        const stderr = String(r.stderr || '');
        const stdout = String(r.stdout || '');
        // gcc diagnostics → Problems panel
        const diags = [];
        for (const line of (stderr + '\n' + stdout).split('\n')) {
            const d = H.parseGccDiagLine(line, H.getActiveRoot() || process.cwd());
            if (d) diags.push(d);
        }
        if (!diags.length) {
            const ldDiags = H.parseLdDiagLines(stdout, stderr, H.getActiveRoot() || process.cwd());
            diags.push(...ldDiags);
        }
        if (diags.length) {
            H.reportDiagnostics(diags, H.getActiveRoot());
            H.log(`[build] ${diags.length} diagnostic(s) → Problems panel`);
        } else {
            H.getOutputChannel().appendLine(`── ${label} failed (exit ${ec}) ──\n${stderr || stdout || '(no output captured)'}`);
            H.getOutputChannel().show(true);
        }
    } catch (e) {
        H.log(`[build] hidden replay failed: ${e.message}`);
    }
}

// ─── avr-size -A (hidden; sections map for the memory report) ────────────────
// sizeExeOverride: the XC8 pipeline passes XC8's own avr-size (avr/bin);
// without it the avr-gcc toolchain's tool next to tc.gcc is used.
function sectionSizes(tc, elfPath, sizeExeOverride) {
    return new Promise((resolve) => {
        try {
            const sizeExe = sizeExeOverride
                || path.join(path.dirname(tc.gcc), 'avr-size') + (H.IS_WIN ? '.exe' : '');
            const r = cp.spawnSync(sizeExe, ['-A', elfPath], { timeout: 10000, encoding: 'utf8', windowHide: true });
            const text = String(r.stdout || '');
            const sections = {};
            for (const line of text.split('\n')) {
                const m = /^\s*(\.[\w.]+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
                if (m) sections[m[1]] = parseInt(m[2], 10);
            }
            resolve(Object.keys(sections).length ? sections : null);
        } catch { resolve(null); }
    });
}

// ─── Clean ───────────────────────────────────────────────────────────────────
async function clean() {
    if (H.checkBusy()) return;
    const root = H.getActiveRoot();
    if (!root) { H.warnNoProject(); return; }
    const { status, proj } = Validator.readProjectConfig(root);
    if (status !== 'ok') { H.warnNoProject(); return; }

    // v0.3.20: ${…}-expanded output dir — clean removes what the build made
    const outDir = H.expandOutPaths(root, proj);
    const outDirAbs = outDir.outDirAbs;
    // v0.3.21 data-loss guard: output_dir resolving to the project root (or
    // a parent of it — '../' tricks, weird variables) must never be rm -rf'd
    if (path.resolve(outDirAbs) === path.resolve(root) ||
        path.resolve(root).startsWith(path.resolve(outDirAbs) + path.sep)) {
        vscode.window.showErrorMessage(
            `AVR: refusing to clean — build.output_dir (${outDir.outDirRel}) resolves to the project root or above; fix it in the Project Editor.`);
        return;
    }
    if (!fs.existsSync(outDirAbs)) {
        vscode.window.showInformationMessage('AVR: build folder does not exist — nothing to clean.');
        return;
    }
    H.setBusy('Clean');
    try {
        const kind = H.shellKind();
        let ec;
        if (kind === H.SHELL_CMD) {
            ec = await H.runInTerminal(TERM, [`rmdir /s /q ${H.q(outDirAbs)}`]);
        } else if (kind === H.SHELL_POWERSHELL) {
            ec = await H.runInTerminal(TERM, [`Remove-Item -Recurse -Force -LiteralPath ${H.q(outDirAbs)}`]);
        } else {
            ec = await H.runInTerminal(TERM, [`rm -rf ${H.q(outDirAbs)}`]);
        }
        H.clearDiagnostics();
        Memory.reset();
        if (H.getProvider()) H.getProvider().refresh();
        if (ec === 0) {
            H.flashBarFeedback('clean', '$(check) Cleaned', '$(trash) Clean');
            vscode.window.showInformationMessage(`AVR: removed ${outDir.outDirRel}/`);
        } else {
            vscode.window.showErrorMessage(`AVR: clean failed (exit ${ec}).`);
        }
        return ec === 0;   // v0.3.16: success flag — tasks.js reports ✔/✖ off this
    } finally {
        H.clearBusy();
    }
}

module.exports = { build, clean, buildVars };
// test hook — same convention as memoryView's _getHtml/_payload: the public
// API above stays trimmed, the toast notifier is reachable for the audit tool
module.exports._notifyBuildSuccess = _notifyBuildSuccess;
