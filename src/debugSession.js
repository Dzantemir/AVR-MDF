'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// debugSession.js — the AVR DAP session driving avr-gdb through MI:
//
//   sim backend:  spawn `simavr -g -m <mcu> -f <freq> [args] <elf>` (gdb stub
//                 on :1234) → spawn avr-gdb -i=mi3 → -target-select remote
//   gdb backend:  optionally spawn gdbServerCmd (avarice / manual simavr / …)
//                 → spawn avr-gdb -i=mi3 → attach to gdbHost:gdbPort
//
// DAP↔MI mapping: breakpoints ↔ -break-insert/-f (pending); stepping ↔
// -exec-next/step/finish; stack ↔ -stack-list-frames; variables ↔
// -stack-list-variables + -var-create/-var-list-children (lazy, per frame);
// hover/watch ↔ -data-evaluate-expression; memory ↔ -data-read-memory-bytes;
// registers ↔ -data-list-register-names/-values; the Debug Console forwards
// plain text to gdb's console interpreter (info registers, x/16x 0x100 …).
// ─────────────────────────────────────────────────────────────────────────────
const net    = require('net');
const path   = require('path');
const fs     = require('fs');
const cp     = require('child_process');
const H      = require('./helpers');
const DAP    = require('./dap');
const { GdbMi } = require('./gdbMi');

const SIM_DEFAULT_PORT = 1234;

// variable reference allocation:
//   0            → root (scopes)
//   1000+frameId → locals list of that frame
//   100000+n     → a varobj (children / evaluate results)
class AvrDebugSession extends DAP.DebugSession {
    constructor() {
        super();
        this._gdb = null;
        this._serverProc = null;
        this._varobjs = new Map();     // ref → { name, expr, varname, frame }
        this._nextVarRef = 100000;
        this._frameRefs = new Map();   // 1000+frameId → frameId
        this._breakpoints = [];        // [{ id, loc }]
        this._terminated = false;
        this._registers = [];
        this._started = false;
    }

    // ─── capabilities ────────────────────────────────────────────────────────
    initializeRequest(response, args) {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsSetVariable = true;
        response.body.supportsReadMemoryRequest = true;
        response.body.supportsTerminateRequest = true;
        response.body.supportsRestartRequest = false;
        response.body.supportsDisassembleRequest = false;
        response.body.exceptionBreakpointFilters = [];
        this.sendResponse(response);
    }

    // ─── launch ──────────────────────────────────────────────────────────────
    async launchRequest(response, args) {
        try {
            // v0.3.16: store the CONFIGURED copy — the raw args ignored the
            // avr.debug.stopOnEntry setting (only launch.json's own value won)
            this._launchCfg = this._config(args);
            await this._launch(args);
            this.sendResponse(response);
            this.sendEvent(new DAP.InitializedEvent());
        } catch (e) {
            this._fail(response, e.message || String(e));
            // a failed launch must not leave a half-open session hanging
            this._terminate(() => this.sendEvent(new DAP.TerminatedEvent()));
        }
    }
    attachRequest(response, args) {
        this._fail(response, 'AVR-MDF: attach is not supported — use launch (sim or gdb backend).');
        this.sendEvent(new DAP.TerminatedEvent());
    }

    async _launch(args) {
        const cfg = this._config(args);
        const backend = cfg.backend === 'gdb' ? 'gdb' : 'sim';

        // program (ELF with DWARF)
        let program = cfg.program;
        if (!program) {
            throw new Error('no program — set "program" in launch.json or build the active project (the default is build/firmware.elf)');
        }
        if (!fs.existsSync(program)) {
            throw new Error(`program not found: ${program}`);
        }
        const isElf = fs.readFileSync(program).slice(0, 4).toString('binary') === '\x7fELF';
        if (!isElf) this._out(`⚠ ${path.basename(program)} is not an ELF — debug info comes from the .elf (build in Debug mode for -g).`, 'console');

        // gdb
        const gdbExe = cfg.gdbPath || this._detectGdb();
        if (!gdbExe) throw new Error('avr-gdb not found (setting avr.debug.gdbPath / avr.gdbPath, the toolchain folder and PATH were checked)');

        if (backend === 'sim') {
            await this._startSimavr(cfg, program);
        } else {
            await this._startGdbServer(cfg);
        }

        // start gdb (MI)
        this._out(`Starting avr-gdb…\n`, 'console');
        this._gdb = new GdbMi(gdbExe, ['-i=mi3', program], cfg.cwd);
        this._wireGdbEvents();
        await this._gdb.start();
        await this._gdb.send('-gdb-set pagination off');
        await this._gdb.send('-gdb-set confirm off');
        await this._gdb.send('-gdb-set breakpoint pending on');
        try { await this._gdb.send('-gdb-set print pretty on'); } catch {}
        // registers names (best-effort)
        try {
            const rn = await this._gdb.send('-data-list-register-names');
            if (rn && rn.results && Array.isArray(rn.results['register-names'])) {
                this._registers = rn.results['register-names'];
            }
        } catch {}

        // connect
        const port = backend === 'sim' ? (cfg.simPort || SIM_DEFAULT_PORT) : (cfg.gdbPort || 4242);
        const host = cfg.gdbHost || '127.0.0.1';
        this._out(`Connecting to the GDB server at ${host}:${port}…\n`, 'console');
        const sel = await this._gdb.send(`-target-select remote ${host}:${port}`);
        if (sel.cls === 'error') throw new Error(`could not connect to ${host}:${port} — is the ${backend === 'sim' ? 'simavr' : 'GDB server'} running?`);

        if (Array.isArray(cfg.preRunCommands)) {
            for (const c of cfg.preRunCommands) {
                await this._gdb.send(`-interpreter-exec console "${String(c).replace(/"/g, '\\"')}"`).catch(() => {});
            }
        }
        this._started = true;
    }

    _config(args) {
        const cfg = Object.assign({}, args);
        // defaults from settings
        if (!cfg.stopOnEntry && cfg.stopOnEntry !== false) cfg.stopOnEntry = !!H.cfg('debug.stopOnEntry');
        if (!cfg.gdbPath) cfg.gdbPath = H.cfg('debug.gdbPath') || H.cfg('gdbPath') || '';
        if (!cfg.simPath) cfg.simPath = H.cfg('debug.simPath') || H.cfg('simavrPath') || '';
        // default program from the active project
        if (!cfg.program) {
            const root = H.getActiveRoot();
            if (root) {
                try {
                    const proj = JSON.parse(fs.readFileSync(path.join(root, 'avr-project.json'), 'utf8').replace(/^\uFEFF/, ''));
                    const _out = H.expandOutPaths(root, proj);
                    cfg.program = path.join(_out.outDirAbs, _out.outName + '.elf');
                    // sim mcu/freq from the board
                    if (!cfg.mcu || !cfg.freq) {
                        const Boards = require('./boards');
                        const board = Boards.getBoard(proj.board);
                        if (board) {
                            if (!cfg.mcu) cfg.mcu = H.cfg('debug.mcu') || board.build.mcu;
                            if (!cfg.freq && H.cfg('debug.clockFromBoard')) cfg.freq = board.build.f_cpu_hz;
                        }
                    }
                } catch {}
            }
        }
        if (!cfg.cwd && cfg.program) cfg.cwd = path.dirname(cfg.program);
        return cfg;
    }
    _detectGdb() {
        const tc = require('./toolchain').detect();
        return tc.avrgdb || null;
    }
    _detectSimavr() {
        const tc = require('./toolchain').detect();
        return tc.simavr || null;
    }

    async _startSimavr(cfg, program) {
        const simExe = cfg.simPath || this._detectSimavr();
        if (!simExe) throw new Error('simavr not found — install it (Linux/macOS packages, Windows: see the readme) or set avr.debug.simPath');
        const mcu = cfg.mcu || 'atmega328p';
        const freq = cfg.freq || 1000000;
        const port = cfg.simPort || SIM_DEFAULT_PORT;
        const argv = ['-g', '-m', mcu, '-f', String(freq)];
        for (const a of (cfg.simArgs || [])) argv.push(String(a));
        argv.push(program);
        this._out(`Starting simavr: ${path.basename(simExe)} ${argv.join(' ')}\n`, 'console');
        this._serverProc = cp.spawn(simExe, argv, { stdio: ['ignore', 'pipe', 'pipe'], cwd: cfg.cwd, windowHide: true });
        this._serverProc.stdout.setEncoding('utf8');
        this._serverProc.stdout.on('data', (c) => this._out(String(c), 'stdout'));
        this._serverProc.stderr.setEncoding('utf8');
        this._serverProc.stderr.on('data', (c) => this._out(String(c), 'stderr'));
        this._serverProc.on('exit', (code) => {
            if (!this._terminated) {
                this._out(`simavr exited (${code ?? 'signal'})\n`, 'console');
                this.sendEvent(new DAP.TerminatedEvent());
            }
        });
        // wait for the gdb stub to listen
        await this._waitForPort('127.0.0.1', port, 8000, `simavr did not open the gdb port ${port}`);
    }
    async _startGdbServer(cfg) {
        const cmd = String(cfg.gdbServerCmd || '').trim();
        if (!cmd) {
            // the user runs the server themselves — just verify it's listening
            const host = cfg.gdbHost || '127.0.0.1';
            const port = cfg.gdbPort || 4242;
            try { await this._waitForPort(host, port, 1500, ''); } catch {
                this._out(`⚠ no GDB server seen at ${host}:${port} yet — trying to attach anyway…\n`, 'console');
            }
            return;
        }
        const argv = _splitCommandLine(cmd);
        const exe = argv.shift();
        this._out(`Starting GDB server: ${cmd}\n`, 'console');
        this._serverProc = cp.spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'], cwd: cfg.cwd, windowHide: true });
        this._serverProc.stdout.setEncoding('utf8');
        this._serverProc.stdout.on('data', (c) => this._out(String(c), 'stdout'));
        this._serverProc.stderr.setEncoding('utf8');
        this._serverProc.stderr.on('data', (c) => this._out(String(c), 'stderr'));
        this._serverProc.on('exit', (code) => {
            if (!this._terminated) this._out(`GDB server exited (${code ?? 'signal'})\n`, 'console');
        });
        const host = cfg.gdbHost || '127.0.0.1';
        const port = cfg.gdbPort || 4242;
        await this._waitForPort(host, port, 15000, `the GDB server did not open ${host}:${port}`);
    }
    _waitForPort(host, port, timeoutMs, failMsg) {
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const tryOnce = () => {
                const sock = net.connect({ host, port });
                sock.once('connect', () => { sock.destroy(); resolve(); });
                sock.once('error', () => {
                    sock.destroy();
                    if (Date.now() - started > timeoutMs) {
                        reject(new Error(failMsg || `could not connect to ${host}:${port}`));
                    } else {
                        setTimeout(tryOnce, 200);
                    }
                });
            };
            tryOnce();
        });
    }

    // ─── gdb event wiring ────────────────────────────────────────────────────
    _wireGdbEvents() {
        const g = this._gdb;
        g.on('console', (t) => this._out(t, 'console'));
        g.on('target', (t) => this._out(t, 'stdout'));
        g.on('log', (t) => { /* MI echo — noisy, keep quiet */ });
        g.on('async', (rec) => this._onAsync(rec));
        g.on('exit', () => {
            if (!this._terminated) this.sendEvent(new DAP.TerminatedEvent());
        });
    }
    _onAsync(rec) {
        if (rec.cls === 'running') {
            this.sendEvent(new DAP.ContinuedEvent(1, true));
            return;
        }
        if (rec.cls !== 'stopped') return;
        const r = rec.results || {};
        const reason = r.reason || '';
        if (reason.startsWith('exited')) {
            this._out(`Program ${reason}.\n`, 'console');
            this.sendEvent(new DAP.TerminatedEvent());
            return;
        }
        let dapReason = 'breakpoint';
        if (reason === 'end-stepping-range' || reason === 'function-finished') dapReason = 'step';
        else if (reason === 'signal-received') dapReason = 'pause';
        else if (reason === 'breakpoint-hit') dapReason = 'breakpoint';
        this._invalidateFrameVars();
        const ev = new DAP.StoppedEvent(dapReason, 1);
        ev.body.allThreadsStopped = true;
        this.sendEvent(ev);
    }
    _out(text, category) {
        this.sendEvent(new DAP.OutputEvent(String(text), category || 'console'));
    }
    _fail(response, message) {
        this._out(`✖ ${message}\n`, 'console');
        this.sendErrorResponse(response, 1, message);
    }

    // ─── breakpoints ─────────────────────────────────────────────────────────
    // v0.3.16: setBreakpointsRequest (lowercase b/p) — dap.js dispatches
    // request.command + 'Request' and VS Code sends "setBreakpoints"; the old
    // capital-B/P name never matched and every breakpoint request came back
    // as "unsupported command".
    async setBreakpointsRequest(response, args) {
        const file = args.source && (args.source.path || args.source.name);
        const bkpts = [];
        if (file) {
            // clear our breakpoints (gdb has no per-file bulk op — delete all
            // ours and re-insert)
            const ids = this._breakpoints.map(b => b.id);
            if (ids.length) {
                try { await this._gdb.send(`-break-delete ${ids.join(' ')}`); } catch {}
                this._breakpoints = [];
            }
            for (const bp of (args.breakpoints || [])) {
                const loc = `${file}:${bp.line}`;
                try {
                    const res = await this._gdb.send(`-break-insert -f ${_miQuote(loc)}`);
                    const b = res.results && res.results.bkpt;
                    const id = b ? parseInt(b.number, 10) : 0;
                    const pending = !b || b.pending === 'y' || b.pending === '1' || b.addr === '<PENDING>';
                    this._breakpoints.push({ id, loc });
                    bkpts.push({
                        verified: !pending,
                        line: b && b.line ? parseInt(b.line, 10) : bp.line,
                    });
                } catch (e) {
                    bkpts.push({ verified: false, line: bp.line, message: e.message });
                }
            }
        }
        response.body = { breakpoints: bkpts };
        this.sendResponse(response);
    }

    // ─── the run ─────────────────────────────────────────────────────────────
    async configurationDoneRequest(response, args) {
        this.sendResponse(response);
        const cfg = this._launchCfg || {};
        if (cfg.stopOnEntry !== false) {
            try {
                await this._gdb.send('-break-insert -f main');
                await this._gdb.execContinue();
                return;
            } catch (e) {
                this._out(`(no main breakpoint: ${e.message} — continuing)\n`, 'console');
            }
        }
        try { await this._gdb.execContinue(); }
        catch (e) { this._out(`✖ ${e.message}\n`, 'console'); }
    }

    // ─── execution control ───────────────────────────────────────────────────
    async continueRequest(response, args) {
        try { await this._gdb.execContinue(); this.sendResponse(response); }
        catch (e) { this._fail(response, e.message); }
    }
    async nextRequest(response, args) {
        try { await this._gdb.execNext(); this.sendResponse(response); }
        catch (e) { this._fail(response, e.message); }
    }
    async stepInRequest(response, args) {
        try { await this._gdb.execStep(); this.sendResponse(response); }
        catch (e) { this._fail(response, e.message); }
    }
    async stepOutRequest(response, args) {
        try { await this._gdb.execFinish(); this.sendResponse(response); }
        catch (e) { this._fail(response, e.message); }
    }
    async pauseRequest(response, args) {
        try { await this._gdb.execInterrupt(); this.sendResponse(response); }
        catch (e) { this._fail(response, e.message); }
    }

    // ─── threads/stack ───────────────────────────────────────────────────────
    threadsRequest(response, args) {
        response.body = { threads: [new DAP.Thread(1, 'AVR core')] };
        this.sendResponse(response);
    }
    async stackTraceRequest(response, args) {
        try {
            const res = await this._gdb.send('-stack-list-frames');
            const frames = ((res.results || {}).stack) || [];
            const total = frames.length;
            const start = args.startFrame || 0;
            const count = args.levels !== undefined ? args.levels : total - start;
            const out = [];
            for (let i = start; i < Math.min(total, start + count); i++) {
                const f = frames[i];
                const level = parseInt(f.level, 10);
                this._frameRefs.set(1000 + level, level);
                // v0.3.16: StackFrame(id, name, source, line, column) — the old
                // call passed (func, Source, line, 0, level): id was a STRING,
                // the Source object sat in `name` and line was always 0
                const src = (f.fullname || f.file)
                    ? new DAP.Source(f.file || path.basename(f.fullname), f.fullname || f.file)
                    : undefined;
                out.push(new DAP.StackFrame(
                    level,
                    f.func || '<unknown>',
                    src,
                    f.line ? parseInt(f.line, 10) : 0,
                    0
                ));
            }
            response.body = { stackFrames: out, totalFrames: total };
            this.sendResponse(response);
        } catch (e) {
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendResponse(response);
        }
    }

    // ─── scopes & variables ──────────────────────────────────────────────────
    scopesRequest(response, args) {
        const frameId = args.frameId || 0;
        const scopes = [];
        scopes.push(new DAP.Scope('Locals', 1000 + frameId));
        if (this._registers.length) {
            scopes.push(new DAP.Scope('Registers', 999000));
        }
        response.body = { scopes };
        this.sendResponse(response);
    }
    async variablesRequest(response, args) {
        const ref = args.variablesReference;
        try {
            let vars = [];
            if (ref === 999000) {
                vars = await this._registerVars();
            } else if (ref >= 100000) {
                vars = await this._varobjChildren(ref);
            } else if (ref >= 1000) {
                const frameId = this._frameRefs.get(ref) ?? (ref - 1000);
                vars = await this._frameLocals(frameId);
            }
            response.body = { variables: vars };
            this.sendResponse(response);
        } catch (e) {
            response.body = { variables: [] };
            this.sendResponse(response);
        }
    }
    async _frameLocals(frameId) {
        const res = await this._gdb.send(`-stack-list-variables --thread 1 --frame ${frameId} --simple-values`);
        const list = ((res.results || {}).variables) || [];
        const out = [];
        for (const v of list) {
            // v0.3.16: the 3rd ctor arg is variablesReference (an int) — the
            // old ''/type-string made "int" the ref on the wire
            const item = new DAP.Variable(v.name, v.value === undefined ? '' : String(v.value), 0);
            // aggregates ({…} or […]) get expandable refs lazily
            if (v.value === undefined || /^\{.*\}$/.test(String(v.value)) || /^\[.*\]$/.test(String(v.value))) {
                item.variablesReference = await this._makeVarobj(v.name, frameId);
            }
            out.push(item);
        }
        return out;
    }
    async _makeVarobj(expr, frameId) {
        // create a gdb varobj bound to the CURRENT frame position — recreated
        // lazily on each stop (frame ids are unstable across stops anyway)
        const ref = this._nextVarRef++;
        this._varobjs.set(ref, { expr: String(expr), frameId, varname: null });
        return ref;
    }
    async _varobjChildren(ref) {
        const vo = this._varobjs.get(ref);
        if (!vo) return [];
        if (!vo.varname) await this._materialize(vo, ref);
        const res = await this._gdb.send(`-var-list-children --simple-values ${vo.varname}`);
        const children = ((res.results || {}).child) || [];
        const out = [];
        for (const c of children) {
            const name = c.name || c.exp || '?';
            const disp = (c.value !== undefined) ? String(c.value) : '';
            const item = new DAP.Variable(name, disp, 0);   // v0.3.16: ref, not the type string
            const nc = parseInt(c.numchild || '0', 10);
            if (nc > 0) {
                // child varobjs inherit the parent's varname path
                const childRef = this._nextVarRef++;
                this._varobjs.set(childRef, { expr: `${vo.expr}${name.startsWith('.') ? '' : '.'}${name}`, frameId: vo.frameId, varname: `${vo.varname}.${name}` });
                item.variablesReference = childRef;
            }
            out.push(item);
        }
        return out;
    }
    async _materialize(vo, ref) {
        // select the frame the varobj was asked for, then create it
        try { await this._gdb.send(`-stack-select-frame ${vo.frameId}`); } catch {}
        const created = await this._gdb.send(`-var-create avrvar_${ref} * ${_miQuote(vo.expr)}`);
        vo.varname = created.results && created.results.name;
    }
    async _registerVars() {
        const out = [];
        try {
            const res = await this._gdb.send('-data-list-register-values x');
            const vals = ((res.results || {})['register-values']) || [];
            for (const rv of vals) {
                const idx = parseInt(rv.number, 10);
                const name = this._registers[idx] || `r${idx}`;
                const item = new DAP.Variable(name, String(rv.value !== undefined ? rv.value : ''), 0);
                out.push(item);
            }
        } catch {}
        return out;
    }
    _invalidateFrameVars() {
        // varobjs die with their frames — drop the materialized handles
        for (const [ref, vo] of this._varobjs) {
            // v0.3.16: send() returns a PROMISE — a plain try/catch never
            // caught the ^error rejection and every stop leaked an
            // unhandledRejection into the extension host
            if (vo.varname) {
                try { this._gdb.send(`-var-delete ${vo.varname}`).catch(() => {}); } catch {}
                vo.varname = null;
            }
        }
    }

    async setVariableRequest(response, args) {
        // DAP semantics: variablesReference = the CONTAINER, name = the child
        const ref = args.variablesReference;
        try {
            let varname = null;
            if (ref === 999000) throw new Error('registers are read-only');
            if (ref >= 100000) {
                const vo = this._varobjs.get(ref);
                if (!vo) throw new Error('unknown container');
                if (!vo.varname) await this._materialize(vo, ref);
                varname = `${vo.varname}.${args.name}`;
            } else if (ref >= 1000 && ref < 999000) {
                const frameId = this._frameRefs.get(ref) ?? (ref - 1000);
                await this._gdb.send(`-stack-select-frame ${frameId}`);
                const created = await this._gdb.send(`-var-create setv * ${_miQuote(args.name)}`);
                varname = created.results && created.results.name;
            } else throw new Error('this scope is read-only');
            const res = await this._gdb.send(`-var-assign ${varname} ${_miQuote(args.value)}`);
            const value = res.results && res.results.value !== undefined ? String(res.results.value) : args.value;
            if (ref >= 1000 && ref < 999000 && varname && varname.startsWith('setv')) {
                try { await this._gdb.send(`-var-delete ${varname}`); } catch {}
            }
            response.body = { value };
            this.sendResponse(response);
        } catch (e) {
            this._fail(response, e.message);
        }
    }

    // ─── evaluate (hover / watch / repl) ──────────────────────────────────────────
    async evaluateRequest(response, args) {
        const expr = String(args.expression || '');
        const frameId = args.frameId || 0;
        try {
            if (args.context === 'repl') {
                // power users: raw gdb console commands from the Debug Console
                const line = expr.startsWith('-')
                    ? expr
                    : `-interpreter-exec console ${_miQuote(expr)}`;
                const res = await this._gdb.send(line);
                const val = res.results && (res.results.value !== undefined ? res.results.value : '');
                response.body = { result: typeof val === 'string' ? val : '', variablesReference: 0 };
                this.sendResponse(response);
                return;
            }
            // evaluate in the requested frame
            try { await this._gdb.send(`-stack-select-frame ${frameId}`); } catch {}
            const res = await this._gdb.send(`-data-evaluate-expression ${_miQuote(expr)}`);
            let value = res.results && res.results.value;
            if (value === undefined) value = '(no value)';
            response.body = { result: String(value), variablesReference: 0 };
            this.sendResponse(response);
        } catch (e) {
            if (args.context === 'hover') {
                response.body = { result: '', variablesReference: 0 };
                this.sendResponse(response);
            } else {
                this._fail(response, e.message);
            }
        }
    }

    // ─── memory (the Hex Editor / memory viewer) ─────────────────────────────
    async readMemoryRequest(response, args) {
        try {
            const count = args.count || 0;
            let addr = typeof args.address === 'string' ? args.address : (args.address !== undefined ? '0x' + args.address.toString(16) : null);
            if (addr === null) throw new Error('no address');
            // resolve memoryReference strings like "0x100" / "gdb expressions"
            const res = await this._gdb.send(`-data-read-memory-bytes ${_miQuote(String(addr))} ${count}`);
            const mem = ((res.results || {}).memory) || [];
            let hex = '';
            let begin = addr;
            for (const block of mem) {
                if (begin === addr && block.begin !== undefined) begin = block.begin;
                hex += String(block.contents || '').replace(/\s+/g, '');
            }
            response.body = { address: begin, data: hex };
            this.sendResponse(response);
        } catch (e) {
            this._fail(response, e.message);
        }
    }

    // ─── teardown ────────────────────────────────────────────────────────────
    disconnectRequest(response, args) {
        this._terminate(() => this.sendResponse(response));
    }
    terminateRequest(response, args) {
        this._terminate(() => this.sendResponse(response));
    }
    _terminate(done) {
        if (this._terminated) { done(); return; }
        this._terminated = true;
        if (this._gdb) {
            try { this._gdb.send('-target-detach').catch(() => {}); } catch {}
            this._gdb.kill();
            this._gdb = null;
        }
        if (this._serverProc) {
            const p = this._serverProc;
            setTimeout(() => { try { p.kill(); } catch {} }, 300);
            this._serverProc = null;
        }
        done();
    }
}

function _miQuote(s) {
    return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
// minimal shell-like splitter (quotes aware) for gdbServerCmd
function _splitCommandLine(line) {
    const out = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote) quote = null;
            else cur += c;
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (/\s/.test(c)) {
            if (cur) { out.push(cur); cur = ''; }
        } else cur += c;
    }
    if (cur) out.push(cur);
    return out;
}

module.exports = { AvrDebugSession };
