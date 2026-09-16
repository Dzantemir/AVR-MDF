'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// gdbMi.js — a compact GDB/MI v3 client: spawns avr-gdb -i=mi3, tokenizes
// commands, parses MI result/async/notify/stream records (recursive descent
// over the MI value grammar) and surfaces them as events + promises.
// ─────────────────────────────────────────────────────────────────────────────
const cp     = require('child_process');
const events = require('events');

class GdbMi extends events.EventEmitter {
    constructor(exe, args = [], cwd) {
        super();
        this._exe = exe;
        this._args = args;
        this._cwd = cwd;
        this._proc = null;
        this._token = 0;
        this._pending = new Map();   // token → {resolve, reject}
        this._buffer = '';
        this._exited = false;
    }

    get pid() { return this._proc ? this._proc.pid : null; }
    get exited() { return this._exited; }

    start() {
        this._proc = cp.spawn(this._exe, this._args, {
            stdio: ['pipe', 'pipe', 'pipe'], cwd: this._cwd, windowHide: true,
        });
        this._proc.stdout.setEncoding('utf8');
        this._proc.stdout.on('data', (c) => this._onData(c));
        this._proc.stderr.setEncoding('utf8');
        this._proc.stderr.on('data', (c) => this.emit('log', String(c)));
        this._proc.on('error', (e) => this._failAll(e));
        this._proc.on('exit', (code, signal) => {
            this._exited = true;
            this._failAll(new Error(`gdb exited (${code ?? signal})`));
            this.emit('exit', code, signal);
        });
        return new Promise((resolve, reject) => {
            // "(gdb)" prompt = ready — v0.3.16: ONE listener resolves, clears
            // the timeout and removes itself (the old second anonymous
            // listener was never taken off the emitter)
            const onPrompt = () => { this.off('prompt', onPrompt); clearTimeout(t); resolve(); };
            this.on('prompt', onPrompt);
            const t = setTimeout(() => {
                this.off('prompt', onPrompt);
                reject(new Error('gdb did not start (no MI prompt)'));
            }, 8000);
        });
    }

    stop() {
        this.send('-gdb-exit').catch(() => {});
        setTimeout(() => { try { this._proc && this._proc.kill(); } catch {} }, 1500);
    }
    kill() {
        try { this._proc && this._proc.kill(); } catch {}
    }

    // Send an MI command; resolves with the result record's results object.
    send(cmd) {
        if (this._exited) return Promise.reject(new Error('gdb has exited'));
        const token = ++this._token;
        return new Promise((resolve, reject) => {
            this._pending.set(token, { resolve, reject });
            try {
                this._proc.stdin.write(`${token}${cmd}\n`);
            } catch (e) {
                this._pending.delete(token);
                reject(e);
            }
        });
    }
    // convenience wrappers
    execContinue()  { return this.send('-exec-continue'); }
    execNext()      { return this.send('-exec-next'); }
    execStep()      { return this.send('-exec-step'); }
    execFinish()    { return this.send('-exec-finish'); }
    execInterrupt() { return this.send('-exec-interrupt'); }

    _failAll(err) {
        for (const [, p] of this._pending) { try { p.reject(err); } catch {} }
        this._pending.clear();
    }

    _onData(chunk) {
        this._buffer += String(chunk);
        let idx;
        while ((idx = this._buffer.indexOf('\n')) >= 0) {
            const line = this._buffer.slice(0, idx).replace(/\r$/, '');
            this._buffer = this._buffer.slice(idx + 1);
            if (line.trim()) this._onLine(line.trim());
        }
    }

    _onLine(line) {
        // stream records
        let m = /^([~@&])(".*")$/.exec(line);
        if (m) {
            const text = _cUnescape(m[2]);
            if (m[1] === '~') this.emit('console', text);
            else if (m[1] === '@') this.emit('target', text);
            else this.emit('log', text);
            return;
        }
        // prompt
        if (line === '(gdb)') { this.emit('prompt'); return; }
        // async records
        if (line.startsWith('*')) {
            const rec = _parseResults(line.slice(1));
            this.emit('async', rec);   // rec.cls: 'stopped' | 'running' | …
            return;
        }
        // notify records
        if (line.startsWith('=')) {
            const rec = _parseResults(line.slice(1));
            this.emit('notify', rec);
            return;
        }
        // result records (maybe tokenized)
        m = /^(\d+)?\^([a-z-]+)(,(.*))?$/.exec(line);
        if (m) {
            const token = m[1] ? parseInt(m[1], 10) : null;
            const cls = m[2];
            const parsed = m[4] ? _parseResults(m[4]) : { cls: '', results: {} };
            if (token !== null && this._pending.has(token)) {
                const p = this._pending.get(token);
                this._pending.delete(token);
                if (cls === 'error') p.reject(new Error(parsed.results.msg || 'gdb error'));
                else p.resolve({ cls, results: parsed.results });
            } else {
                this.emit('result', { cls, results: parsed.results, token });
            }
            return;
        }
        // console log lines from gdb itself — ignore silently
    }
}

// ─── MI value grammar parser ─────────────────────────────────────────────────
// result-list := ( variable "," value )? ( "," variable "," value )*
// value      := const | tuple | list
function _parseResults(s) {
    const pos = { i: 0 };
    const out = { cls: '', results: {} };
    // async/notify records: "*stopped,reason=…" — the class is the leading bare
    // token followed by a COMMA (or the whole record). A token followed by '='
    // is a result KEY, not a class (result records: "bkpt={…}").
    if (!s.startsWith('"')) {
        const clsMatch = /^([a-zA-Z-]+)(?=[,=]|$)/.exec(s);
        if (clsMatch && !s.slice(0, clsMatch[0].length + 1).startsWith(clsMatch[1] + '=')) {
            out.cls = clsMatch[1];
            pos.i = clsMatch[0].length;
        }
    }
    const res = _parseResultList(s, pos);
    out.results = res;
    return out;
}
function _parseResultList(s, pos) {
    const out = {};
    _skipWs(s, pos);
    while (pos.i < s.length) {
        if (s[pos.i] === ',') { pos.i++; _skipWs(s, pos); }
        if (pos.i >= s.length) break;
        // variable name
        const name = _parseName(s, pos);
        if (name === null) break;
        _skipWs(s, pos);
        if (s[pos.i] !== '=') break;
        pos.i++;
        _skipWs(s, pos);
        out[name] = _parseValue(s, pos);
        _skipWs(s, pos);
    }
    return out;
}
function _parseName(s, pos) {
    const start = pos.i;
    while (pos.i < s.length && /[A-Za-z0-9_.\-]/.test(s[pos.i])) pos.i++;
    if (pos.i === start) return null;
    return s.slice(start, pos.i);
}
function _parseValue(s, pos) {
    const c = s[pos.i];
    if (c === '"') return _parseCString(s, pos);
    if (c === '{') return _parseTuple(s, pos);
    if (c === '[') return _parseList(s, pos);
    // bare const (rare): read until , } ] or end
    let start = pos.i;
    while (pos.i < s.length && !/[,}\]]/.test(s[pos.i])) pos.i++;
    return s.slice(start, pos.i).trim();
}
function _parseTuple(s, pos) {
    pos.i++;   // {
    const out = _parseResultList(s, pos);
    _skipWs(s, pos);
    if (s[pos.i] === '}') pos.i++;
    return out;
}
function _parseList(s, pos) {
    pos.i++;   // [
    const out = [];
    _skipWs(s, pos);
    while (pos.i < s.length && s[pos.i] !== ']') {
        const before = pos.i;
        // MI lists come in TWO shapes: value-list ([{…},{…}]) and result-list
        // ([frame={…},frame={…}]) — try "name=" first, rewind on bare values.
        const save = pos.i;
        const name = _parseName(s, pos);
        _skipWs(s, pos);
        if (name !== null && s[pos.i] === '=') {
            pos.i++;
            _skipWs(s, pos);
            const v = _parseValue(s, pos);
            if (v && typeof v === 'object' && !Array.isArray(v)) v._miName = name;
            out.push(v);
        } else {
            pos.i = save;   // bare value
            out.push(_parseValue(s, pos));
        }
        _skipWs(s, pos);
        if (s[pos.i] === ',') { pos.i++; _skipWs(s, pos); }
        if (pos.i === before) break;   // no progress — malformed, bail out
    }
    if (s[pos.i] === ']') pos.i++;
    return out;
}
function _parseCString(s, pos) {
    // returns the UNESCAPED string, advances past the closing quote
    let out = '';
    pos.i++;   // opening "
    while (pos.i < s.length) {
        const c = s[pos.i];
        if (c === '\\' && pos.i + 1 < s.length) {
            const n = s[pos.i + 1];
            if (n === 'n') { out += '\n'; pos.i += 2; continue; }
            if (n === 't') { out += '\t'; pos.i += 2; continue; }
            if (n === 'r') { out += '\r'; pos.i += 2; continue; }
            if (n === '"') { out += '"'; pos.i += 2; continue; }
            if (n === '\\') { out += '\\'; pos.i += 2; continue; }
            if (n === "'") { out += "'"; pos.i += 2; continue; }
            // \xNN escapes
            const hx = /^\\x([0-9A-Fa-f]{1,2})/.exec(s.slice(pos.i));
            if (hx) { out += String.fromCharCode(parseInt(hx[1], 16)); pos.i += hx[0].length; continue; }
            out += n; pos.i += 2; continue;
        }
        if (c === '"') { pos.i++; break; }
        out += c;
        pos.i++;
    }
    return out;
}
function _skipWs(s, pos) {
    while (pos.i < s.length && /\s/.test(s[pos.i])) pos.i++;
}
function _cUnescape(raw) {
    const pos = { i: 0 };
    if (raw[0] === '"') return _parseCString(raw, pos);
    return raw;
}

module.exports = { GdbMi };
