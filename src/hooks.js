'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// hooks.js — pre_build / post_link / post_build / pre_upload / post_upload
// shell hooks from avr-project.json build.hooks, in the AVR terminal.
//
// v0.3.20 (the sdcc-mdf design): every stage is a LIST of commands — the
// Project Editor gives each stage its own multi-line field, one command per
// line. The stored form stays back-compatible: a bare string is one command
// (what every pre-0.3.20 config has), an array runs them in order. A non-zero
// exit stops the stage (and the pipeline checks it) — the same contract as
// before, per command now. Every line rides runInTerminal, so the 0.3.17
// long-command splitter and the 0.3.19 killed-terminal watch apply too.
// ${...} variables are expanded (unresolved ones stay literal).
// ─────────────────────────────────────────────────────────────────────────────
const H = require('./helpers');

function getHook(proj, name) {
    const cmd = proj && proj.build && proj.build.hooks ? proj.build.hooks[name] : null;
    if (typeof cmd === 'string' && cmd.trim()) return [cmd.trim()];
    if (Array.isArray(cmd)) return cmd.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim());
    return [];
}

// vars: the full variable set from build.buildVars()
async function runHook(proj, name, vars, termName = 'AVR') {
    const cmds = getHook(proj, name);
    if (!cmds.length) return 0;
    let last = 0;
    for (let i = 0; i < cmds.length; i++) {
        const expanded = H.configVarResolver()(H.envVarResolver()(H.expandVars(cmds[i], vars)));
        H.log(`[hook] ${name} [${i + 1}/${cmds.length}]: ${expanded}`);
        last = await H.runInTerminal(termName, [expanded]);
        if (last !== 0) {
            H.log(`[hook] ${name} FAILED (exit ${last})`);
            return last;   // abort the stage — the pipeline's exit check does the rest
        }
    }
    return last;
}

module.exports = { runHook };
