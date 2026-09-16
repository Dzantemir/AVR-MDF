'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// debugProvider.js — the type "avr" DebugConfigurationProvider + the inline
// debug-adapter factory. F5 without launch.json starts the simavr session for
// the active project; an unbuilt project offers Build & Debug (the Debug build
// writes the DWARF info the session feeds to avr-gdb).
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Validator = require('./validator');
const { AvrDebugSession } = require('./debugSession');

// ─── registration ────────────────────────────────────────────────────────────
function register(ctx) {
    const provider = new AvrConfigurationProvider();
    ctx.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('avr', provider));

    const factory = {
        createDebugAdapterDescriptor(session, executable) {
            return new vscode.DebugAdapterInlineImplementation(new AvrDebugSession());
        },
    };
    ctx.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('avr', factory));
}

class AvrConfigurationProvider {
    // dynamic (dropdown) entries in the Run-and-Debug selector
    provideDebugConfigurations(folder, token) {
        return [
            { type: 'avr', request: 'launch', name: 'AVR: Debug (simavr)' },
            {
                type: 'avr', request: 'launch', backend: 'gdb',
                name: 'AVR: Debug (hardware GDB)',
                program: '${workspaceFolder}/build/firmware.elf',
                gdbHost: '127.0.0.1', gdbPort: 4242,
                gdbServerCmd: 'avarice --jtag /dev/ttyUSB0 :4242',
            },
        ];
    }

    // F5 without launch.json lands here — synthesize the simavr config
    resolveDebugConfiguration(folder, config, token) {
        if (!config.type) config.type = 'avr';
        if (!config.request) config.request = 'launch';
        if (!config.name) config.name = 'AVR: Debug (simavr)';
        if (config.backend === undefined) config.backend = 'sim';
        return config;
    }

    // variables substituted + the pre-start gate (program exists? build first?)
    async resolveDebugConfigurationWithSubstitutedVariables(folder, config, token) {
        // XC8 guard: the simavr/avr-gdb debug stack consumes avr-gcc DWARF ELFs;
        // XC8 builds flash fine but do not participate in this debug flow.
        const dbgRoot = H.getActiveRoot() || (folder && folder.uri.fsPath);
        if (dbgRoot && H.getProjectToolchain(dbgRoot) === 'xc8') {
            const sw = await vscode.window.showInformationMessage(
                'AVR: debugging (simavr / avr-gdb) requires the GNU avr-gcc toolchain — the active project compiles with Microchip XC8.',
                'Switch to avr-gcc', 'Cancel'
            );
            if (sw === 'Switch to avr-gcc') {
                vscode.commands.executeCommand('avr.switchToolchain');
            }
            return undefined;   // cancel the launch
        }
        // default program from the active project
        if (!config.program) {
            const root = H.getActiveRoot() || (folder && folder.uri.fsPath);
            if (root) {
                const outDirRel = 'build', outName = 'firmware';
                try {
                    const r = Validator.readProjectConfig(root);
                    if (r.status === 'ok') {
                        const proj = r.proj;
                        const _out = H.expandOutPaths(root, proj);
                        config.program = path.join(_out.outDirAbs, _out.outName + '.elf');
                    } else {
                        config.program = path.join(root, outDirRel, outName + '.elf');
                    }
                } catch {
                    config.program = path.join(root, outDirRel, outName + '.elf');
                }
            }
        }
        // the gate: a missing program is fixable — offer Build & Debug
        if (config.program && !fs.existsSync(config.program)) {
            const root = H.getActiveRoot() || (folder && folder.uri.fsPath);
            if (root && Validator.readProjectConfig(root).status === 'ok') {
                const pick = await vscode.window.showInformationMessage(
                    `AVR: the debug target is not built yet (${path.basename(config.program)} missing). Build in Debug mode first?`,
                    'Build & Debug', 'Cancel'
                );
                if (pick !== 'Build & Debug') return undefined;   // cancels the launch
                // ensure Debug mode for DWARF info
                const prevMode = String(H.cfg('buildMode') || 'release');
                if (prevMode !== 'debug') {
                    await vscode.workspace.getConfiguration('avr').update('buildMode', 'debug', vscode.ConfigurationTarget.Workspace);
                }
                try { await vscode.commands.executeCommand('avr.build'); } catch {}
                if (prevMode !== 'debug') {
                    await vscode.workspace.getConfiguration('avr').update('buildMode', prevMode, vscode.ConfigurationTarget.Workspace);
                }
                if (!fs.existsSync(config.program)) {
                    vscode.window.showErrorMessage('AVR: build did not produce the ELF — fix the build errors and press F5 again.');
                    return undefined;
                }
            } else {
                vscode.window.showErrorMessage(`AVR: program not found: ${config.program}`);
                return undefined;
            }
        }
        return config;
    }
}

module.exports = { register };
