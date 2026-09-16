# Changelog

## 0.3.24 — Marketplace upload fix: categories ('Embedded' is not an available category)

Upload error: `The category 'Embedded' is not available in language 'en-us'` — the Marketplace accepts a **fixed approved category list only**, and `Embedded` has never been on it (it sat in `categories` since the first hand-written `package.json`; the store's upload validation is the only place that cares). **No extension code changed** — the `src/` files are byte-identical to 0.3.23.

- **Categories are now `Programming Languages`, `Debuggers`, `Other`** — all three on the approved list, and all three honest: the C/asm toolchains under Programming Languages, the shipped simavr/avr-gdb debug provider under Debuggers
- **`embedded` stays a search keyword** (tags are free-form, unlike categories) — discoverability via search is unchanged
- The new verification battery hard-codes the full approved category list so a future edit can never re-introduce an invalid one

## 0.3.23 — Marketplace-ready VSIX packaging (manifest schema + zip layout)

«ты не правильно оформил vsix из за этого я не могу его опубликовать» — the first upload attempt to the Marketplace exposed three packaging defects that had been inherited from the very first hand-made VSIX (0.3.4). VS Code's installer tolerated all three, the publisher validation does not. **No extension code changed** — the `src/` files are byte-identical to 0.3.22.

- **`<PackageManifest Version="…">` is the MANIFEST SCHEMA version, not the extension version** — it carried `0.3.4`→`0.3.22` from release one (every hand bump copied the extension version into it). The canonical value is `2.0.0`, exactly what `vsce` writes; now pinned — the extension version lives in `<Identity Version>` (and `package.json`) only
- **The zip layout now matches `vsce package` output** — no directory entries (11 were shipped), normalized 644 file modes (they were 755 from the extraction). `[Content_Types].xml` turned out to be byte-identical to what `vsce` itself writes (dotted extension names included) — kept as-is
- **The five gallery badges moved into `package.json` `badges`** — the manifest is now fully derivable from `package.json` (`vsce` regenerates it verbatim), and the listing keeps its version/license/avr-libc/avrdude/XC8 badges; the derived `Tags` gained `keybindings,debuggers` and `GalleryFlags` honestly says `Public Preview` (`preview: true` was always set). `galleryBanner`, `qna`, `repository`, `bugs`, `homepage` were already there and already fed the manifest properties
- The package was built and validated with the real **`@vscode/vsce` 4.0.0** in addition to the in-house verification battery

## 0.3.22 — ESP-IDF-style build toast: elapsed time, human sizes, Memory button

The after-build notification now looks like the ESP8266-IDF one — buttons included:

- **`✅ AVR › Build succeeded in 2.4s — firmware.elf (RAM 96B/2K (5%) · Flash 1.2K/32K (4%))`** — the elapsed time measured from the actual build start (was absent), the linked `.elf` (the toast used to name the `.hex` with raw `1234/32768B` byte counts), and compact human units: `96B`, `1.2K`, `32K`. RAM comes first, Flash last (the ESP-IDF order); **EEPROM joins the line only when something actually lives in it** (`EEPROM 4B/1K (0%)` — a permanent `0B/1K (0%)` would be noise)
- **A secondary `Memory` button next to `Flash`** — VS Code renders the first toast action as primary and the rest as secondary, so the pair looks exactly like the ESP8266-IDF notification. `Flash` (primary) still runs `avr.flash`; `Memory` (secondary) reveals the **Memory view** — the section bars, top symbols and history that `generate()` refreshed for this very build. No more hunting the sidebar after every build to check what ate the RAM
- **Both pipelines share one notifier** — XC8 projects get the same toast with their own timing and sizes (`✅ AVR (XC8) › …`), measured from the same `build()` entry point
- The raw-byte `usageText()` format is untouched — the Memory view, status bar and history keep their exact units; the human formatter is a separate read-only path

## 0.3.21 — full audit of the 0.3.20 port: 15 fixes (variables, editor merge, monitor robustness)

«просмотри проект снова и поищи ошибки» — three parallel audit agents + a personal line-by-line re-verification of every claim. The port itself was sound; the bugs below are the seams it left.

**Variables / output paths (the 0.3.20 headline feature actually works now):**

- **`${config:buildMode}` / `${config:comPort}` resolve** — the port dropped sdcc-mdf's namespace fallback: `configVarResolver` looked up a TOP-LEVEL `buildMode` setting that doesn't exist (ours is `avr.buildMode`), so the advertised `build/${config:buildMode}` output-dir tip left the literal `${config:buildMode}` in the path and builds landed in a junk directory named exactly that. Short keys now try `avr.<key>` first, full dotted ids as-is (the sdcc-mdf `tryKeys` mechanic)
- **EEPROM-after-flash follows an absolute `output_dir`** — flash.js built the `.eep` path as `join(root, outDirRel)`; with `${workspaceFolder}/out` the existence check silently failed and the eeprom op was skipped. Now `outDirAbs` like the `.hex` next to it
- **Memory view survives a restart** — `reloadFromDisk`/`histPath` read the RAW `output_dir`; with variables in it the view showed "no build" after every restart and the history went to a literal junk folder. The expanded dir is now threaded in from the vscode side (memory.js stays pure-node)
- **Empty expansion can't aim Clean at the project root** — a variable expanding to `''` or `.` made `outDirAbs` the root itself; `output_dir: '..'` escaped it. expandOutPaths falls back to `build`, a hand-edited `output_name` with separators is sanitized, and clean() outright REFUSES to delete the project root or anything containing it
- **launch.json hardware-GDB template no longer pins `program`** to a stale `build/firmware.elf` — unset, the debug provider resolves `<outDir>/<outName>.elf` (custom output dirs stopped getting "build did not produce the ELF" after a successful build)

**Project Editor:**

- **Save MERGES with the on-disk config instead of overwriting it** — the form has no field for `build.extra_flags`, `upload.extra_args` or the `fuse0…8` of modern tinyAVR/AVR-Dx parts (the editor manages lfuse/hfuse/efuse only), and the wholesale `JSON.stringify(form)` silently ERASED them on every Save (the sdcc-mdf merge lesson, finally ported). Managed keys overlay: absent optional keys are removed, unmanaged keys and unknown hook stages survive; a broken-on-disk file degrades to the old behaviour
- **`hooks: null` no longer crashes the validator** — `typeof null === 'object'` passed the guard and `Object.keys(null)` threw, killing Build / Show Project Problems / the Select Project picker on a hand-edited config. New type checks for `upload.port` / `programmer` / `baud` / `eeprom` too
- **A non-canonical `optimization` ('Os', 'O2'…) survives a Save** — it matched no `<option>`, the select went blank and the key was silently deleted; a raw option now keeps it visible and intact
- Re-invoking the editor command **reveals the panel instead of re-pushing disk state** (unsaved edits are no longer discarded); the programmer select uses `onchange` (the listener count used to grow on every state push); the ${…} picker no longer yanks focus back on outside-click/scroll dismiss; `placeMenu*` clears the stale max-height before measuring

**Serial Monitor:**

- **Connect re-entrancy guard** — a double-click during the 1–3 s PowerShell READY window spawned a SECOND pump on the same port: the loser OPENFAILed with a misleading toast and the overwritten `_proc` handle orphaned the winner (unkillable, sends dead). Also identity-guards: a stale pump's late exit can't clobber the live session anymore
- **`READY` may split across stdout chunks** — the first-chunk `startsWith('READY')` test dropped split markers (6 s timeout on a healthy port); the marker is buffered until complete, and the tail after it rides `pushChunk` (counted in rx, line-split)
- **POSIX connect errors surface** — a stream error before `open` left the promise pending forever (Start silently no-op'd); an unspawnable powershell.exe used to raise an uncaught `error` event. Both reject properly now; `_carry` is cleared on spontaneous death (a truncated last line must not prefix the next session)
- **The configured baud is honest** — a non-preset `avr.monitorBaud` (250000…) had no matching `<option>`, the select showed 300 and Start connected at 300; the value now joins the list (and the live connection can add its own option). The status line keeps `@ baud` on every stats update (the sdcc format); the toggle reads `▶ Start` / `■ Stop` like the donor; the last <250 ms of a burst is no longer lost from the rx/tx counters (trailing flush); an empty scan offers the configured port; a re-scan while connected keeps the live port on screen
- Opening the monitor (view or Start) latches the status-bar items visible — they used to appear only via the tree view; a port picked from the status bar no longer stays shadowed by the toolbar's stale selection

## 0.3.20 — Serial Monitor redesign, Project Editor: separate hooks + variable menus + Build mode

Four sdcc-mdf UX pieces ported over:

- **Serial Monitor — the sdcc-mdf design & layout**: the toolbar now carries the port and baud **dropdowns** (fed by a live port scan; the view-title ↻ button re-scans), a connection **dot**, and ONE toggle button — `▶ Start` idle / red `■ Stop` connected; the EOL picker moved down to the input row next to Send; a bottom **status line** shows `connected: COM19 @ 115200 · 1234 B rx · 56 B tx` with throttled counters; Ctrl+L clears; the selects lock and mirror the live connection. The engine (PowerShell pump / stty streams) is unchanged
- **Hooks — five separate fields instead of one mixed textarea**: pre_build / post_link / post_build / pre_upload / post_upload each get their own row with an ⓘ tooltip and a variable button; one command **per line** (multiple commands per stage run in order; a non-zero exit still stops the pipeline). Stored form: a single command keeps the historical string, two or more save as an array — pre-0.3.20 configs are read as one-command lists and stay byte-identical after a Save
- **Pseudo-variable menus** (the sdcc-mdf picker): clicking the variable button next to Output dir/name, any hook field or the custom upload tool/args opens a grouped, searchable menu with a detail pane and insert-at-cursor; it lists ONLY variables avr-mdf really expands — project paths, outputs (elf/hex/bin/eep/map), board facts, buildMode/toolchain, config/env resolvers (with the NAME pre-selected for typing over)
- **Build mode in the editor**: a Release/Debug segmented control in the Build card writes the same `avr.buildMode` setting the status bar flips — immediately (no Save), confirmed back to the webview, and it follows when the mode is switched elsewhere. To make the variables honest, `output_dir` / `output_name` now expand variables everywhere they are read (gcc build, XC8 build, flash, clean, the debug provider, disassembly) — `build/${config:buildMode}` keeps debug and release artefacts apart
- New command: `AVR: Refresh Serial Ports` (the monitor view-title ↻ button — re-added from the 0.3.16 removal, now actually feeding the toolbar's port list)

## 0.3.19 — killed terminal no longer spins the busy indicator forever — killed terminal no longer spins the busy indicator forever

Killing the AVR terminal mid-command (Build / Flash / Clean / fuse writes / hooks) left the busy indicator spinning for the full 30-minute marker timeout — the shell died before ever writing the exit-code marker, so the poller had nothing to read, nothing resolved, and every AVR command stayed locked behind the busy gate (111.jpg: «нажал килл терминал — индикатор остаётся навсегда»).

- Two detectors cover every kill mode: `window.onDidCloseTerminal` (the trash can / the tab's X) and a `terminal.exitStatus` check in the marker poll itself (kill-without-close, or a shell that died on its own)
- Both take ONE last look at the marker before giving up — a command that finished a tick before the kill still reports its real exit code; otherwise the wait resolves `-1` "interrupted" within ~0.25 s, and the callers' existing handling (toast + `clearBusy()`) frees the indicator
- The dead terminal is dropped from the reuse cache, so the next command gets a fresh one; the 30-minute backstop stays as the last resort

## 0.3.18 — new icons + compact docs

- **New icons** — the extension (marketplace) icon and the sidebar / activity-bar mark are replaced with the new artwork. The mono SVG's fill is `currentColor` (the VS Code convention for activity-bar icons): identical black artwork in light themes, still visible in dark ones
- **Docs compacted** — the readme keeps only the two latest "What's new" entries + a pointer here; the stale 0.3.3-era *Upgrading* section (the rename story, the 0.1.0 activation-crash history), the duplicated toolchain-detection paragraph and the "commands added in 0.2.0" table are gone; every changelog entry below is trimmed to the essential facts

## 0.3.17 — the long-command splitter (cmd.exe's 8191-char line limit)

`runInTerminal` sent the whole command + exit-code marker as **one `sendText`** — no length check. cmd.exe truncates a terminal line at 8191 chars; with absolute paths the link line grows by len(root) × N(objects), so a large build was silently fed to the compiler **cut mid-path** (the bug sdcc-mdf fixed twice: link v0.13.17, flash v0.28.9).

- The splitter lives in the single chokepoint `runInTerminal`, covering every call site at once: the avr-gcc link step, avrdude flash / EEPROM / custom upload, fuse writes, hooks, clean
- Short lines are sent byte-for-byte as before; anything over **7000** chars is split at token boundaries by a **quote-aware tokenizer** (a quoted path is never cut in half — cmd `"…""…"`, POSIX `'\''`, PowerShell `''` all handled) and continued with the shell's own continuation: `^` in cmd, backtick in PowerShell, `\` in POSIX/fish
- The exit-code marker always rides the LAST physical line, so the OK/FAIL toasts still track the whole logical command

## 0.3.16 — the full code audit (errors + dead code)

20 real bugs + ~40 dead-code items, every finding re-verified line-by-line:

- **Debugger**: breakpoints never worked — the DAP handler name never matched the dispatcher, `sendErrorResponse` didn't exist, StackFrame args were swapped; `stopOnEntry` was ignored; `-var-delete` rejections leaked
- **Fuse Editor**: re-opened with stale board state; ATxmega fuses could not be read or written at all (they rode the classic lfuse/hfuse/efuse branch)
- **Project Editor**: Save could write project A's form into project B's `avr-project.json` (now targets the panel's own project)
- **Monitor**: "Clear" actually clears; the EOL choice persists; no unhandled rejections after the view closes; the truncated-line carry resets on disconnect
- **Build/tasks**: `Memory.generate` is awaited; XC8 debug builds no longer carry `-O2 … -O0`; `${toolchain}` no longer expands to `[object Object]`; failed builds end the AVR task with ✖ / exit 1 instead of "✔ done"; no more "▶ undefined"
- Minimal hand-written board JSON no longer crashes the picker/tree; IntelliSense no longer writes `F_CPU=undefined`
- ~250 lines of dead code deleted (the `uartTemplate` family, `cdCmd`/`chainCmd`, the fake `avr.monitor.refreshPorts` command, `memoryView.render`/`reveal`, `dap.Breakpoint`, 29 dead exports); `runStep` lost its `new Promise(async…)` anti-pattern

## 0.3.15 — the Project Editor was dead since 0.3.10 (111.jpg: "opens in an inactive state")

One escaped apostrophe (`XC8\'s`, from the 0.3.10 XC8-tooltip rewrite) inside the webview's inline `<script>`: the outer template literal ate the backslash, the browser got a raw `'` mid-string → `SyntaxError: Unexpected identifier 's'` — the whole script died at parse time, `ready` was never posted, and every field stayed a grey placeholder (the "inactive" editor). Fixed (`\\'`); every webview's generated script is now syntax-checked in the test harness, and the editor was proven to fill fields + round-trip a Save in a VM.

## 0.3.14 — the terminal headers REMOVED (the "echo мусор" fix)

0.3.13 made the headers print correctly — but printing them at all was noise: every op opened with `echo ── Chip erase ──` **and** its output. All eight header sites dropped them; the terminal shows only the operation itself, and the result arrives as a toast. The exit-code marker (the invisible tail that powers the OK/FAIL toasts) is untouched; `echoCmd()` is gone. The `no device found matching VID 0x03eb` error in the same log was hardware — the Atmel-ICE not seen on USB — not the extension.

## 0.3.13 — the terminal headers finally PRINT (the "кривая консоль" fix)

Headers were sent as bare text, so cmd.exe tried to *execute* them: `«──» не является внутренней или внешней командой`. One central fix: every header became a real echo command for the active shell (cmd `echo …` with `& | < > ^` defused, `Write-Output '…'` in PowerShell, `echo '…'` in POSIX/fish); the command line, quoting and the exit-code marker were verified against the same log and were already correct.

## 0.3.12 — the Device branch slimmed & the EEPROM pair rebuilt on the sdcc-mdf flow (222.jpg)

- Removed the duplicate **Read Fuses from Chip** / **Write Fuses to Chip** rows + palette commands — the Fuse Editor already runs both with the values in sight
- **EEPROM upload** = a file picker (any `.hex`/`.eep`/`.bin`, `-U eeprom:w:<file>:a` auto-detect); **download** dumps to `build/eeprom-dump-<date>.hex` and toasts the byte count + Open — and only on real success (the old one toasted "saved" on file existence alone)
- Busy gates moved before any dialog work; interrupted runs (no exit code seen) are told apart from tool failures

## 0.3.11 — the avr-gcc side audited against GCC / avr-libc / avrdude docs

Six real mistakes fixed: linker relaxation is **`-mrelax`** on the avr-gcc link line (not `-Wl,--relax` — the avr-libc manual forbids the direct form; the assembler side was missing); `.s` vs `.S` dispatch by case (lowercase `.s` no longer rides the C preprocessor); debug builds carry `-Og` alone (not `-Os … -Og`); programmer ids **`dragon_pp`** (not the non-existent `dragon_hvp`) and **`flip1`** for ATmega32U4 DFU (not the Xmega-only `flip2`); Caterina/avr109 recipes perform the documented `-r` 1200 bps touch; the ELF flash fallback uses the explicit `:e` input format. avr-libc reference texts synced to 2.2.0 (delay limits, printf-float linker flags incl. `-lm`, `__AVR_LIBC_DATE_`).

## 0.3.10 — the XC8 pipeline audited against the official Microchip docs (7 fixes)

The audit against the MPLAB XC8-for-AVR documentation found **seven real mistakes**:

- **The big one**: xc8-cc's `-o` is ALWAYS an ELF — what landed in `firmware.hex` was an ELF with a .hex name. The build now follows the documented pipeline: `xc8-cc … -o <out>.elf` → XC8's own `avr-objcopy -O ihex …` → the real `.hex` (+ `.eep`)
- Delays: `_XTAL_FREQ`/`__delay_ms` are PIC-only constructs; AVR uses `F_CPU` + `<util/delay.h>` — a fresh XC8 blink project compiles now
- `-std=c11` was invalid (c89/c90/c99 only); `.s/.S` assembly rides the same command; the memory report uses XC8's own avr-size/avr-nm with `-Wl,-Map=`; Disassembly uses XC8's own avr-objdump; the reference pages match the docs

## 0.3.9 — port selection rebuilt on the sdcc-mdf 0.29.0 flow

The picker shows only really detected ports (each `$(plug) <port>`, current pre-picked) + a validated manual fallback; the Windows enumeration is `[System.IO.Ports.SerialPort]::GetPortNames()` — the old blind fallback **fabricated COM1…COM32** whenever the CIM query missed. `ports.js` is the sdcc-mdf shape: synchronous `detectPorts()` with a 2.5 s cache. The sdcc-mdf flow verbatim.

## 0.3.8 — the "🔌 Port Settings" branch is back; "Fuses & Device" → "Device"

One `Port: <COM3 / /dev/ttyUSB0 / …>` row — click to pick (the `avr.selectPort` picker), synced with the status-bar chip, the Serial Monitor and the tree. The "Fuses & Device" group renamed to plain **Device** (the sdcc-mdf wording).

## 0.3.7 — the Memory view redesigned to the sdcc-mdf look

Tabs (**Overview / Symbols / History**) with client-side rendering; area bars with the threshold tick + Δ vs the previous build; Symbols as its own tab (`avr-nm --size-sort`, by-area rollup, top sections); the History scrubber with a column chart; live updates on every build; the view badge carries the most-loaded area %; honest empty states (no more blank view after a restart).

## 0.3.6 — Disassembly picker: any .o object on demand

Pick the full ELF listing (`build/<out>.lss`, `avr-objdump -d -S`, reused while fresh) or **any object the build left** (`build/obj/**.o`, `build/comp/**.o`) — disassembled on the fly with `-r` relocations noted. Works with objects but no linked ELF (a failed link) too.

## 0.3.5 — Disassembly like sdcc-mdf, two Development Tools branches, declutter

Disassembly is a real `build/<out>.lss` file reused while fresh (instant repeat opens); the Development Tools view splits into **avr-gcc (GNU)** / **XC8 (Microchip)** collapsible branches with state in the description; the folder-icon header button, the "Write template main.c" and "Toggle JSON preview" buttons are gone; the 0.3.1 proactive autoscan of personal folders is gone.

## 0.3.4 — fixed the forever-spinning Build indicator on cmd.exe

`echo 1>file` — a digit glued to `>` is parsed by cmd.exe as a HANDLE NUMBER, so the marker stayed empty, the poller read NaN forever and the busy indicator spun up to 30 minutes (Flash / Clean / Fuses too). The marker is now `(>file echo 1)` — redirection first, the digit a plain echo argument. `q()` also quotes paths containing parentheses.

## 0.3.3 — renamed AVR-MDF, decluttered sidebar, XC8 stats on par with avr-gcc

**AVR-GCC-MDF → AVR-MDF** (new id `avr-mdf` — uninstall the old one first; global boards auto-migrate `~/.avr-gcc-mdf/boards` → `~/.avr-mdf/boards`). XC8 stats mirror avr-gcc in the Development Tools view; the "avrdude Utilities" and "Port & Programmer" groups are gone (44 → 41 commands).

## 0.3.2 — folder-settings write fixed, leaner Select Toolchain, consistent state icons

`setCfg` wrote through a folder-scoped configuration target VS Code rejects (`Unable to write to Folder Settings…`) — settings now go to `.vscode/settings.json` or Global properly. The deep-scan command/row duplicates are gone (the deep scan lives inside the browse flow); ONE state-icon scheme everywhere (found `$(check)` green / missing `$(warning)` yellow).

## 0.3.1 — bulletproof compiler-folder capture (verified against the real archives)

Probing verified against the real ZakKemble avr-gcc 16.1.0 x64 Windows and Microchip XC8 v4.00 archives (both roots captured by a plain folder pick); bounded BFS deep scan (≤ 4 levels) so any nesting works; every probe/scan step logged; honest "not found — what was checked" warnings.

## 0.3.0 — the big MCU list, redesigned editors, icons & toolchain detection

MCU database **74 → 311** (the full avr-gcc device list — every ATtiny/ATmega/AT90/ATxmega series, modern DA/DB/DD/EA, automotive ATA, Arduino aliases — 15 series); Board Manager, Project Editor and the import wizard redesigned (two-column webview, card forms, guided flow); every command declares a codicon (view-title buttons render as icons, three blank ones fixed); picking a toolchain distribution root folder works (nested `bin/` layouts probed, resolved executable persisted).

## 0.2.0 — dual toolchain (Microchip XC8) + activation fix

Fixed the 0.1.0 activation crash (the DAP payload classes are vendored in `src/dap.js`; webview views register via `registerWebviewViewProvider`). Added Microchip XC8 support with per-project avr-gcc ⇄ XC8 switching, XC8 auto-detection + `avr.xc8.*` settings, and the Reference view's avr-libc ⇄ XC8 catalogue switch.

## 0.1.0 — the first public cut

Project model + visual Project Editor, 74 built-in MCUs + Board Manager, the build pipeline (avr-gcc/avr-g++, components, hooks, Problems panel), memory view, avrdude (20 recipes, flash/EEPROM, chip erase), fuse editor, Serial Monitor, simavr/avr-gdb debugging, Development Tools, the AVR-Libc reference, tasks/launch/IntelliSense auto-generation, and the import wizard (Arduino / PlatformIO / Makefile / Code::Blocks / Eclipse CDT).
