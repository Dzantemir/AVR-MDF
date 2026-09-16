'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// memoryView.js — the Memory sidebar webview, the sdcc-mdf 0.29.0 design.
//
// v0.3.7 — the redesign: the report is now CLIENT-rendered with the exact
// sdcc-mdf look — a header (project · board · MCU · build time), TABS
// (Overview / Symbols / History), slim 8px area bars with the threshold
// tick and Δ vs the previous build, a Symbols tab (top symbols by
// avr-nm --size-sort, the by-area rollup, the top sections), a History tab
// with a slider + column chart (one column per build — flash size, the
// color by the limit), an empty state with the ▤ glyph, a badge on the
// view icon (the most-loaded area as NN%) and LIVE updates: every build
// pushes the fresh report through Memory.onCollect — no manual Refresh
// needed (Refresh stays on the view title bar, $(refresh)).
//
// CONSTRUCTION NOTE (the sdcc-mdf 0.14.1 lesson, applied structurally): the
// webview script is built as a PLAIN ARRAY OF SINGLE-QUOTED LINES joined
// with '\n' — normal string semantics, immune to template-literal escapes.
// The HTML shell template contains no backslashes and only the two intended
// ${…} interpolations (data payload + script body).
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const H      = require('./helpers');
const Memory = require('./memory');

let _view = null;                        // sidebar WebviewView
let _last = { report: null, history: [] };

// ─── registration (extension.js activate) ────────────────────────────────────
function register(ctx) {
    ctx.subscriptions.push(
        vscode.window.registerWebviewViewProvider('avr.memoryView', {
            resolveWebviewView(view) {
                view.webview.options = { enableScripts: true };
                _view = view;
                view.webview.html = _getHtml();
                _wire(view.webview);
                view.onDidDispose(() => { if (_view === view) _view = null; }, null, ctx.subscriptions);
                // Artifacts may exist from an earlier build (previous session
                // included) — pull them from disk so the view is never blank.
                reloadFromDisk();
            },
        }, { webviewOptions: { enableScripts: true } })
    );
    // Every build (and every reset/clean) lands here — the view live-updates.
    Memory.onCollect(push);
}

function _wire(webview) {
    webview.onDidReceiveMessage(msg => {
        if (!msg || !msg.type) return;
        if (msg.type === 'ready') {
            // cheap refresh round-trip (the html already embeds the payload;
            // this covers data that changed between build and re-resolve)
            _post(webview);
        }
    });
}

// The notifier target — Memory.generate() / generateXc8() / reset() land here.
function push() {
    _last = _payload(Memory.lastReport());
    if (_view) { _post(_view.webview); _updateBadge(); }
}

function _post(webview) {
    try { webview.postMessage({ type: 'report', report: _last.report, history: _last.history }); } catch { /* disposed mid-send */ }
}

// Badge on the view icon: the most-loaded area as "NN%".
function _updateBadge() {
    if (!_view) return;
    const rep = _last.report;
    try {
        if (!rep || !rep.ok || !rep.areas || !rep.areas.length) { _view.badge = undefined; return; }
        let worst = null;
        for (const a of rep.areas) {
            if (!a.max) continue;
            const pct = a.used * 100 / a.max;
            if (!worst || pct > worst.pct) worst = { pct, a };
        }
        if (!worst) { _view.badge = undefined; return; }
        const p = Math.round(worst.pct);
        _view.badge = {
            value: p + '%',
            tooltip: worst.a.label + ': ' + worst.a.used + ' / ' + worst.a.max + ' B (' + p + '%)' +
                (rep.warnings && rep.warnings.length ? ' — near or over the limit' : ''),
        };
    } catch { /* badge API missing on very old VS Code — cosmetic only */ }
}

// Command: refresh from the artifacts on disk (the view title bar $(refresh)).
async function refresh() { await reloadFromDisk(); }

// Re-collect the report from build artifacts without rebuilding. Used when
// the view (re)opens and after project switches. History is read-only here —
// snapshots are only appended by real builds (Memory.generate).
async function reloadFromDisk() {
    // restart-safe bridge sync: memory.js is pure node and reads the active
    // root from the env bridge — H.getActiveRoot() (workspaceState) is the
    // truth after a VS Code restart, before any project is (re)selected.
    const root = H.getActiveRoot();
    if (root) { try { Memory.setActiveRootBridge(root); } catch {} }
    // v0.3.21: hand memory.js the EXPANDED output dir — the raw
    // build.output_dir with ${…} made the elf check fail on every restart
    let outDirAbs = null;
    if (root) {
        try {
            const rc = require('./validator').readProjectConfig(root);
            if (rc.status === 'ok') outDirAbs = H.expandOutPaths(root, rc.proj).outDirAbs;
        } catch {}
    }
    const Toolchain = require('./toolchain');
    const rep = await Memory.reloadFromDisk(Toolchain.detect(), outDirAbs);
    _last = _payload(rep);
    if (_view) { _post(_view.webview); _updateBadge(); }
}

// ─── the avr report → the sdcc-mdf-shaped payload ───────────────────────────
function _payload(rep) {
    if (!rep) {
        const root = H.getActiveRoot();
        return { report: { ok: false, reason: root ? 'no-build' : 'no-project' }, history: [] };
    }
    const u = rep.usage || {};
    const area = (id, label, x) =>
        ({ id, label, used: (x && x.used) || 0, max: (x && x.total) || 0 });
    const areas = [
        area('flash',  'Flash (.text + .data)', u.flash),
        area('ram',    'RAM (.data + .bss)',    u.ram),
        area('eeprom', 'EEPROM',                u.eeprom),
    ].filter(a => a.max || a.used);
    const threshold = Math.max(1, Math.min(100, Number(H.cfg('memory.thresholdWarning')) || 85));

    // warnings — the sdcc scheme: yellow at/after the threshold, red at 100%
    const warnings = [];
    for (const a of areas) {
        if (!a.max) continue;
        const pct = Math.round(a.used * 100 / a.max);
        if (pct >= 100) warnings.push({ level: 'full', label: a.label, used: a.used, max: a.max, pct });
        else if (pct >= threshold) warnings.push({ level: 'warn', label: a.label, used: a.used, max: a.max, pct });
    }

    // Δ vs the previous build — the diff line on every Overview row
    const hist = (rep.history || []).slice();
    const diff = {}; let hasDiff = false;
    if (hist.length >= 2) {
        const cur = hist[hist.length - 1], prev = hist[hist.length - 2];
        for (const id of ['flash', 'ram', 'eeprom']) {
            const c = cur.usage && cur.usage[id] ? cur.usage[id].used : null;
            const p = prev.usage && prev.usage[id] ? prev.usage[id].used : null;
            if (c === null || p === null) continue;
            diff[id] = c - p; hasDiff = true;
        }
    }

    // symbols → the by-area rollup (the "Module" table slot of the sdcc design)
    const byArea = {};
    for (const s of (rep.symbols || [])) {
        const w = s.where || '?';
        if (!byArea[w]) byArea[w] = { name: w, size: 0, count: 0 };
        byArea[w].size += s.size; byArea[w].count++;
    }
    const modules = Object.values(byArea).sort((a, b) => b.size - a.size);

    const sections = Object.entries(u.sections || {})
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 14)
        .map(([name, size]) => ({ name, size }));

    const board = rep.board || {};
    const proj = _readProj(rep.root);
    const limit = Math.max(1, Number(H.cfg('memory.historyLimit')) || 50);
    return {
        report: {
            ok: true,
            areas,
            symbols: rep.symbols || [],
            sections,
            modules,
            meta: {
                project: (proj && proj.name) || path.basename(rep.root || 'firmware'),
                board: board.name || (proj && proj.board) || '',
                target: (board.build && board.build.mcu) || '',
                generatedAt: rep.ts || null,
            },
            threshold,
            warnings,
            diff: hasDiff ? diff : null,
            elf: rep.elfPath ? path.basename(rep.elfPath) : '',
            toolchain: rep.toolchain || 'avr-gcc',
        },
        history: hist.slice(-limit).map(e => ({
            t: e.ts, board: e.board || '',
            usage: e.usage || {},
        })),
    };
}

function _readProj(root) {
    if (!root) return null;
    try {
        const p = path.join(root, 'avr-project.json');
        if (!fs.existsSync(p)) return null;
        const r = H.readJsonFile(p);          // → { ok, data } in avr-mdf
        return r && r.ok ? r.data : null;
    } catch { return null; }
}

// ─── HTML ─────────────────────────────────────────────────────────────────────
function _getHtml() {
    const payload = { report: _last.report, history: _last.history };
    // v0.13.17 lesson (sdcc-mdf): escape ALL '<' inside the embedded JSON
    // (\u003C is parsed back to '<' by the webview JS engine and can never
    // break out of the script element).
    const dataJson = JSON.stringify(payload).replace(/</g, '\\u003C');
    const script = _webviewScript();
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>AVR Memory</title>
<style>
body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 12px);
    margin: 0; padding: 8px;
    box-sizing: border-box;
}
body * { box-sizing: border-box; }
.dim { color: var(--vscode-descriptionForeground); }
#hdr { margin-bottom: 8px; display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
#hdrMain { min-width: 0; }
#hdrTitle { font-weight: 600; }
#hdrSub { color: var(--vscode-descriptionForeground); font-size: 0.92em; margin-top: 2px; }
#tabs { display: flex; gap: 2px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #888)); margin-bottom: 8px; align-items: stretch; }
.tabbtn {
    background: transparent; color: var(--vscode-editor-foreground);
    border: none; border-bottom: 2px solid transparent;
    padding: 4px 8px; cursor: pointer; font-size: 0.95em;
}
.tabbtn:hover { background: var(--vscode-toolbar-hoverBackground); }
.tabbtn.on { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
/* narrow sidebar (the view can be dragged down to ~200px) */
@media (max-width: 320px) {
    .tabbtn { padding: 4px 5px; font-size: 0.88em; }
    .rv { font-size: 0.92em; }
}
.tabpage { display: none; }
.row { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; }
.rl { overflow-wrap: anywhere; }
.rv { white-space: nowrap; color: var(--vscode-descriptionForeground); }
.bar { position: relative; height: 8px; margin-top: 3px; background: var(--vscode-editorWidget-background, var(--vscode-widget-background, rgba(128,128,128,.15))); border-radius: 4px; overflow: hidden; }
.fill { height: 100%; border-radius: 4px; }
.b-ok   { background: var(--vscode-charts-green); }
.b-warn { background: var(--vscode-charts-yellow); }
.b-full { background: var(--vscode-charts-red); }
.b-none { background: var(--vscode-charts-blue); width: 4px !important; }
.tick { position: absolute; top: -1px; bottom: -1px; width: 1px; background: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); opacity: .7; }
.note { color: var(--vscode-descriptionForeground); margin-top: 8px; font-size: 0.92em; }
.warn { color: var(--vscode-editorWarning-foreground); margin-top: 6px; }
.crit { color: var(--vscode-editorError-foreground); margin-top: 6px; }
table { border-collapse: collapse; width: 100%; margin-top: 8px; }
th, td { text-align: left; padding: 3px 6px 3px 0; overflow-wrap: anywhere; }
th { color: var(--vscode-descriptionForeground); font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #888)); }
td.n { text-align: right; white-space: nowrap; color: var(--vscode-descriptionForeground); }
#histRange { width: 100%; margin-top: 8px; }
#histInfo { margin-top: 8px; }
#histChart { display: flex; align-items: flex-end; gap: 2px; height: 64px; margin-top: 8px; }
.hcol { flex: 1 1 0; min-width: 3px; border-radius: 2px 2px 0 0; background: var(--vscode-charts-green); opacity: .55; }
.hcol.sel { opacity: 1; outline: 1px solid var(--vscode-focusBorder); }
.hcol.w { background: var(--vscode-charts-yellow); }
.hcol.f { background: var(--vscode-charts-red); }
.legend { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 0.88em; line-height: 1.5; }
.empty { color: var(--vscode-descriptionForeground); padding: 24px 4px; text-align: center; line-height: 1.7; }
.empty .big { font-size: 2em; display: block; margin-bottom: 6px; opacity: .8; }
</style></head>
<body>
<div id="hdr">
    <div id="hdrMain">
        <div id="hdrTitle">—</div>
        <div id="hdrSub"></div>
    </div>
</div>
<div id="tabs">
    <button class="tabbtn" data-tab="overview">Overview</button>
    <button class="tabbtn" data-tab="symbols">Symbols</button>
    <button class="tabbtn" data-tab="history">History</button>
</div>
<div id="tab-overview" class="tabpage">
    <div id="areas"></div>
    <div id="warnline"></div>
</div>
<div id="tab-symbols" class="tabpage">
    <table id="symTable"></table>
    <table id="modTable"></table>
    <table id="secTable"></table>
</div>
<div id="tab-history" class="tabpage">
    <input type="range" id="histRange" min="0" max="0" value="0" aria-label="Build history position">
    <div id="histInfo" class="note"></div>
    <div id="histChart"></div>
    <div class="legend">Each column is one build (flash size). Drag the slider to inspect a past build.</div>
</div>
<div id="empty" class="empty"></div>
<script>const DATA = ${dataJson};
${script}</script>
</body></html>`;
}

// ─── the webview script (plain array of lines — see the header note) ─────────
function _webviewScript() {
    const L = [];
    const s = (line) => { L.push(line); };

    s("'use strict';");
    s('(function () {');
    s('    const vscode = acquireVsCodeApi();');
    s('    const st0 = (typeof vscode.getState === "function" ? vscode.getState() : null) || {};');
    s('    let tab = st0.tab || "overview";');
    s('    let histIdx = -1;                      // -1 = live (rightmost build)');
    s('    const D = { report: DATA.report || null, history: DATA.history || [] };');
    s('    const TABS = ["overview", "symbols", "history"];');
    s('');
    s('    function byId(id) { return document.getElementById(id); }');
    s('    function esc(v) {');
    s('        return String(v === null || v === undefined ? "" : v)');
    s('            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")');
    s('            .replace(/"/g, "&quot;");');
    s('    }');
    s('    function saveState() { try { vscode.setState({ tab: tab }); } catch (e) {} }');
    s('    function threshold() {');
    s('        const t = (D.report && D.report.threshold) || 85;');
    s('        return Math.max(1, Math.min(100, Number(t) || 85));');
    s('    }');
    s('    function fmtB(n) {');
    s('        if (n === null || n === undefined) return "\\u2014";');
    s('        if (n >= 1024) return (n / 1024).toFixed(n >= 10240 ? 0 : 1) + " KB";');
    s('        return String(n) + " B";');
    s('    }');
    s('    function areaLabel(id) {');
    s('        if (D.report && D.report.areas) { for (const a of D.report.areas) { if (a.id === id) return a.label; } }');
    s('        return id;');
    s('    }');
    s('');
    s('    // ── tabs ──');
    s('    function renderTabs() {');
    s('        const btns = document.querySelectorAll(".tabbtn");');
    s('        for (let i = 0; i < btns.length; i++) {');
    s('            const el = btns[i];');
    s('            const on = el.getAttribute("data-tab") === tab;');
    s('            el.className = on ? "tabbtn on" : "tabbtn";');
    s('        }');
    s('        // NB: the ACTIVE page needs an explicit "block" — setting');
    s('        // style.display = "" would just drop the inline override and the');
    s('        // CSS default (.tabpage { display:none }) would hide it again.');
    s('        for (const t of TABS) {');
    s('            const pg = byId("tab-" + t);');
    s('            if (pg) pg.style.display = (t === tab) ? "block" : "none";');
    s('        }');
    s('    }');
    s('    function switchTab(t) { tab = t; saveState(); renderTabs(); }');
    s('');
    s('    // ── overview ──');
    s('    function clsFor(pct) {');
    s('        if (pct === null) return "b-none";');
    s('        if (pct >= 100) return "b-full";');
    s('        if (pct >= threshold()) return "b-warn";');
    s('        return "b-ok";');
    s('    }');
    s('    function renderOverview() {');
    s('        const rep = D.report;');
    s('        const host = byId("areas");');
    s('        if (!host || !rep || !rep.ok) { if (host) host.innerHTML = ""; return; }');
    s('        let html = "";');
    s('        for (const a of rep.areas) {');
    s('            const pct = a.max ? (a.used * 100 / a.max) : null;');
    s('            const w = pct === null ? 0 : Math.min(100, pct);');
    s('            const d = rep.diff ? rep.diff[a.id] : null;');
    s('            const dTxt = (d === null || d === undefined) ? "" :');
    s('                \' <span class="dim">(\\u0394\' + (d > 0 ? "+" : "") + d + " B)</span>";');
    s('            html += \'<div class="row"><div class="rl">\' + esc(a.label) + dTxt + \'</div>\' +');
    s('                \'<div class="rv">\' + fmtB(a.used) + (a.max ? " / " + fmtB(a.max) : "") +');
    s('                (pct !== null ? " \\u00b7 " + Math.round(pct) + "%" : "") + "</div></div>";');
    s('            html += \'<div class="bar"><div class="fill \' + clsFor(pct) + \'" style="width:\' + w + \'%"></div>\' +');
    s('                (a.max ? \'<div class="tick" style="left:\' + threshold() + \'%"></div>\' : "") + "</div>";');
    s('        }');
    s('        host.innerHTML = html;');
    s('        const wl = byId("warnline");');
    s('        if (wl) {');
    s('            let w = "";');
    s('            if (rep.warnings) {');
    s('                for (const x of rep.warnings) {');
    s('                    w += \'<div class="\' + (x.level === "full" ? "crit" : "warn") + \'">\' +');
    s('                        (x.level === "full" ? "\\u25cf " : "\\u26a0 ") + esc(x.label) +');
    s('                        ": " + x.used + "/" + x.max + " B (" + x.pct + "%)</div>";');
    s('                }');
    s('            }');
    s('            wl.innerHTML = w;');
    s('        }');
    s('    }');
    s('');
    s('    // ── symbols ──');
    s('    function renderSymbols() {');
    s('        const rep = D.report;');
    s('        const st = byId("symTable");');
    s('        const mt = byId("modTable");');
    s('        const sc = byId("secTable");');
    s('        if (!st || !mt || !sc) return;');
    s('        if (!rep || !rep.ok) { st.innerHTML = ""; mt.innerHTML = ""; sc.innerHTML = ""; return; }');
    s('        let h = "<tr><th>Symbol</th><th>\\u2248 size</th><th>Area</th></tr>";');
    s('        const syms = rep.symbols || [];');
    s('        if (!syms.length) {');
    s('            h += \'<tr><td colspan="3" class="dim">No symbols (avr-nm --size-sort found nothing)</td></tr>\';');
    s('        }');
    s('        for (const s of syms) {');
    s('            h += "<tr><td>" + esc(s.name) + \'</td><td class="n">\' + s.size + " B</td><td>" +');
    s('                esc(s.where || "?") + "</td></tr>";');
    s('        }');
    s('        st.innerHTML = h;');
    s('        let m = "<tr><th>Area</th><th>\\u2248 size</th><th>symbols</th></tr>";');
    s('        const mods = rep.modules || [];');
    s('        if (!mods.length) {');
    s('            m += \'<tr><td colspan="3" class="dim">\\u2014</td></tr>\';');
    s('        }');
    s('        for (const x of mods) {');
    s('            m += "<tr><td>" + esc(x.name) + \'</td><td class="n">\' + x.size + " B</td><td class=\\"n\\">" + x.count + "</td></tr>";');
    s('        }');
    s('        mt.innerHTML = m;');
    s('        let c = "<tr><th>Section</th><th>size</th></tr>";');
    s('        const secs = rep.sections || [];');
    s('        if (!secs.length) {');
    s('            c += \'<tr><td colspan="2" class="dim">\\u2014</td></tr>\';');
    s('        }');
    s('        for (const x of secs) {');
    s('            c += "<tr><td>" + esc(x.name) + \'</td><td class="n">\' + x.size + " B</td></tr>";');
    s('        }');
    s('        sc.innerHTML = c;');
    s('    }');
    s('');
    s('    // ── history ──');
    s('    function histArea(e, id) { return e && e.usage && e.usage[id] ? e.usage[id] : null; }');
    s('    function renderHistoryInfo() {');
    s('        const hist = D.history || [];');
    s('        const info = byId("histInfo");');
    s('        if (!info) return;');
    s('        if (!hist.length) { info.textContent = "No build history yet \\u2014 build the project."; return; }');
    s('        const i = histIdx >= 0 && histIdx < hist.length ? histIdx : hist.length - 1;');
    s('        histIdx = i;');
    s('        const e = hist[i];');
    s('        const prev = i > 0 ? hist[i - 1] : null;');
    s('        const when = new Date(e.t).toLocaleString();');
    s('        let txt = "Build " + (i + 1) + "/" + hist.length + " \\u00b7 " + when;');
    s('        if (e.board) txt += " \\u00b7 " + esc(e.board);');
    s('        for (const id of ["flash", "ram", "eeprom"]) {');
    s('            const a = histArea(e, id);');
    s('            if (!a) continue;');
    s('            const p = prev ? histArea(prev, id) : null;');
    s('            const d = p ? (+a.used) - (+p.used) : null;');
    s('            txt += "<br>" + esc(areaLabel(id)) + ": " + fmtB(+a.used) +');
    s('                (a.total ? " / " + fmtB(+a.total) : "") +');
    s('                (d !== null ? \' <span class="dim">(\\u0394\' + (d > 0 ? "+" : "") + d + " B)</span>" : "");');
    s('        }');
    s('        info.innerHTML = txt;');
    s('    }');
    s('    function renderHistory() {');
    s('        const hist = D.history || [];');
    s('        const range = byId("histRange");');
    s('        const chart = byId("histChart");');
    s('        if (!range || !chart) return;');
    s('        if (!hist.length) {');
    s('            range.style.display = "none";');
    s('            chart.innerHTML = "";');
    s('            renderHistoryInfo();');
    s('            return;');
    s('        }');
    s('        range.style.display = "";');
    s('        range.min = 0;');
    s('        range.max = hist.length - 1;');
    s('        if (histIdx < 0 || histIdx >= hist.length) histIdx = hist.length - 1;');
    s('        range.value = String(histIdx);');
    s('        let maxV = 0;');
    s('        for (const e of hist) { const a = histArea(e, "flash"); if (a) maxV = Math.max(maxV, +a.used || 0); }');
    s('        if (maxV <= 0) maxV = 1;');
    s('        // NOTE: the chart shows the TREND, so columns scale against the');
    s('        // LARGEST BUILD, not against the board limit — the limit is');
    s('        // encoded by the column COLOR (green/yellow/red by percent).');
    s('        let html = "";');
    s('        for (let i = 0; i < hist.length; i++) {');
    s('            const a = histArea(hist[i], "flash");');
    s('            const used = a ? (+a.used || 0) : 0; const max = a ? (+a.total || 0) : 0;');
    s('            const hPct = Math.max(4, Math.round(used * 100 / maxV));');
    s('            const pct = max ? used * 100 / max : null;');
    s('            const cls = "hcol" + (pct !== null && pct >= 100 ? " f" : pct !== null && pct >= threshold() ? " w" : "") +');
    s('                (i === histIdx ? " sel" : "");');
    s('            html += \'<div class="\' + cls + \'" style="height:\' + hPct + \'%" title="\' +');
    s('                esc(new Date(hist[i].t).toLocaleString()) + \' \\u00b7 flash \' + esc(String(used)) + \' B"></div>\';');
    s('        }');
    s('        chart.innerHTML = html;');
    s('        renderHistoryInfo();');
    s('    }');
    s('');
    s('    // ── header + empty state ──');
    s('    function renderHeader() {');
    s('        const rep = D.report;');
    s('        const t = byId("hdrTitle");');
    s('        const sb = byId("hdrSub");');
    s('        if (!t || !sb) return;');
    s('        if (!rep || !rep.ok) { t.textContent = "AVR Memory"; sb.textContent = ""; return; }');
    s('        const m = rep.meta || {};');
    s('        t.textContent = m.project || "firmware";');
    s('        let sub = [m.board, m.target].filter(Boolean).join(" \\u00b7 ");');
    s('        if (m.generatedAt) sub += (sub ? " \\u00b7 " : "") + new Date(m.generatedAt).toLocaleTimeString();');
    s('        sb.textContent = sub;');
    s('    }');
    s('    function renderEmpty() {');
    s('        const el = byId("empty");');
    s('        if (!el) return;');
    s('        const rep = D.report;');
    s('        if (rep && rep.ok) { el.style.display = "none"; return; }');
    s('        el.style.display = "";');
    s('        let why = "Build the project \\u2014 the memory report appears here automatically.";');
    s('        if (rep && rep.reason === "no-project") why = "Select an AVR project first.";');
    s('        if (rep && rep.reason === "no-build") why = "No build yet \\u2014 build the project (Ctrl+Alt+B) to see flash / RAM / EEPROM usage.";');
    s('        el.innerHTML = \'<span class="big">\\u25a4</span>\' + esc(why);');
    s('    }');
    s('');
    s('    function renderAll() {');
    s('        renderHeader(); renderTabs(); renderOverview();');
    s('        renderSymbols(); renderHistory(); renderEmpty();');
    s('    }');
    s('');
    s('    // ── events ──');
    s('    const tabsEl = byId("tabs");');
    s('    if (tabsEl) {');
    s('        tabsEl.addEventListener("click", function (ev) {');
    s('            const b = ev.target && ev.target.closest ? ev.target.closest("button") : null;');
    s('            if (!b) return;');
    s('            const t = b.getAttribute("data-tab");');
    s('            if (t) switchTab(t);');
    s('        });');
    s('    }');
    s('    const hr = byId("histRange");');
    s('    if (hr) {');
    s('        hr.addEventListener("input", function () {');
    s('            histIdx = parseInt(hr.value, 10) || 0;');
    s('            renderHistory();');
    s('        });');
    s('    }');
    s('    window.addEventListener("message", function (ev) {');
    s('        const m = ev.data;');
    s('        if (!m || m.type !== "report") return;');
    s('        D.report = m.report || null;');
    s('        D.history = (m.history !== undefined && m.history !== null) ? m.history : [];');
    s('        histIdx = -1;');
    s('        renderAll();');
    s('    });');
    s('');
    s('    renderAll();');
    s('    vscode.postMessage({ type: "ready" });');
    s('})();');
    return L.join('\n');
}

module.exports = { register, refresh, reloadFromDisk, _getHtml, _payload };
