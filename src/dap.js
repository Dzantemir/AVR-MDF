'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// dap.js — vendored minimal subset of the npm package "@vscode/debugadapter".
//
// Why this exists: the DAP payload classes (Thread, StackFrame, Scope,
// Variable, Source, the *Event classes) and the abstract DebugSession base
// class are NOT part of the stable `vscode` extension API (there they exist
// only as TypeScript interfaces — undefined at runtime!). Extending
// `vscode.DebugSession` crashed the whole extension activation, which left
// every sidebar view without its data provider. This module provides exactly
// the pieces our AvrDebugSession needs, honouring the same wire contract that
// DebugAdapterInlineImplementation expects:
//
//   handleMessage(msg)      — dispatch incoming DAP requests
//   onDidSendMessage        — Event firing outgoing DAP messages (with seq)
//   sendResponse / sendEvent
//
// The classes mirror the field names of the Debug Adapter Protocol so the
// messages produced are byte-for-byte what VS Code expects.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');

// ─── protocol message wrappers ───────────────────────────────────────────────
class ProtocolMessage {
    constructor(type) { this.type = type; this.seq = 0; }
}

class Response extends ProtocolMessage {
    constructor(request, success = true, message) {
        super('response');
        this.request_seq = request.seq;
        this.command = request.command;
        this.success = success;
        if (message) this.message = message;
        this.body = {};
    }
}

class Event extends ProtocolMessage {
    constructor(event, body) {
        super('event');
        this.event = event;
        this.body = body || {};
    }
}

// ─── standard events (subset used by the AVR session) ────────────────────────
class InitializedEvent extends Event {
    constructor() { super('initialized'); }
}

class TerminatedEvent extends Event {
    constructor() { super('terminated'); }
}

class ContinuedEvent extends Event {
    constructor(threadId, allThreadsContinued) {
        super('continued', { threadId, allThreadsContinued: !!allThreadsContinued });
    }
}

class StoppedEvent extends Event {
    constructor(reason, threadId, text) {
        super('stopped', { reason, threadId });
        if (text) this.body.text = text;
    }
}

class OutputEvent extends Event {
    constructor(text, category) {
        super('output', { category: category || 'console', output: String(text) });
    }
}

// ─── payload types (subset used by the AVR session) ──────────────────────────
class Thread {
    constructor(id, name) { this.id = id; this.name = name; }
}

class Source {
    constructor(name, path, sourceReference) {
        this.name = name;
        this.path = path;
        if (sourceReference !== undefined) this.sourceReference = sourceReference;
    }
}

class StackFrame {
    constructor(id, name, source, line, column) {
        this.id = id;
        this.name = name;
        this.source = source;
        this.line = line;
        this.column = column;
    }
}

class Scope {
    constructor(name, variablesReference, expensive) {
        this.name = name;
        this.variablesReference = variablesReference;
        this.expensive = !!expensive;
    }
}

class Variable {
    constructor(name, value, variablesReference, namedVariables, indexedVariables) {
        this.name = name;
        this.value = value;
        this.variablesReference = variablesReference === undefined ? 0 : variablesReference;
        if (namedVariables !== undefined) this.namedVariables = namedVariables;
        if (indexedVariables !== undefined) this.indexedVariables = indexedVariables;
    }
}

// ─── the session base class ──────────────────────────────────────────────────
class DebugSession {
    constructor() {
        this._outgoing = new vscode.EventEmitter();
        this._seq = 0;
    }

    // Event<ProtocolMessage> — consumed by DebugAdapterInlineImplementation
    get onDidSendMessage() { return this._outgoing.event; }

    // Incoming DAP message (parsed JSON object from VS Code)
    handleMessage(message) {
        if (!message || message.type !== 'request') return;
        const request = message;
        const response = new Response(request);
        const handlerName = request.command + 'Request';
        const handler = this[handlerName];
        try {
            if (typeof handler !== 'function') {
                // politely fail unknown commands instead of hanging the UI
                response.success = false;
                response.message = `unsupported command '${request.command}'`;
                this.sendResponse(response);
                return;
            }
            const result = handler.call(this, response, request.arguments);
            if (result && typeof result.then === 'function') {
                result.catch(err => {
                    if (!response._sent) {
                        response.success = false;
                        response.message = err && err.message ? err.message : String(err);
                        this.sendResponse(response);
                    }
                });
            }
        } catch (err) {
            if (!response._sent) {
                response.success = false;
                response.message = err && err.message ? err.message : String(err);
            }
            this.sendResponse(response);
        }
    }

    // Outgoing response (seq assigned here; guards against double sends)
    sendResponse(response) {
        if (!response || response._sent) return;
        response._sent = true;
        response.seq = ++this._seq;
        this._outgoing.fire(response);
    }

    // v0.3.16: the @vscode/debugadapter error-response contract the AVR
    // session's _fail() calls — it simply did not exist, so every _fail()
    // threw "sendErrorResponse is not a function" and masked the real error.
    sendErrorResponse(response, code, message) {
        if (!response || response._sent) return;
        response.success = false;
        const msg = String(message || 'error');
        response.message = msg;
        response.body = response.body || {};
        response.body.error = { id: Number(code) || 0, format: msg };
        this.sendResponse(response);
    }

    // Outgoing event (seq assigned here)
    sendEvent(event) {
        event.seq = ++this._seq;
        this._outgoing.fire(event);
    }

    dispose() {
        this._outgoing.dispose();
    }
}

module.exports = {
    ProtocolMessage, Response, Event,
    InitializedEvent, TerminatedEvent, ContinuedEvent, StoppedEvent, OutputEvent,
    Thread, Source, StackFrame, Scope, Variable,
    DebugSession,
};
