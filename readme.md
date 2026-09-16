<h1 align="center">AVR-MDF</h1>

<p align="center">
  <strong>Microcontroller Development Framework</strong> — build, flash, fuses & debug <b>ATmega / ATtiny / ATxmega</b> projects with <b>GNU avr-gcc + avr-libc</b> or <b>Microchip XC8</b> (<code>xc8-cc</code>) — switchable per project — directly from VS Code: 39 commands, 36 settings, 311 MCUs, avrdude flashing, simavr/avr-gdb debugging.
</p>

<p align="center">
  <a href="https://github.com/Dzantemir/avr-mdf"><img alt="version" src="https://img.shields.io/badge/version-0.3.24-orange"></a>
  <a href="./LICENSE.txt"><img alt="license" src="https://img.shields.io/badge/license-MIT-green"></a>
  <a href="https://gcc.gnu.org/wiki/avr-gcc"><img alt="avr-gcc" src="https://img.shields.io/badge/avr--gcc-toolchain-orange"></a>
  <a href="https://www.nongnu.org/avr-libc/"><img alt="avr-libc" src="https://img.shields.io/badge/avr--libc-2.x-blue"></a>
  <a href="https://www.microchip.com/en-us/products/compilers/microchip-xc8"><img alt="XC8" src="https://img.shields.io/badge/Microchip%20XC8-xc8--cc-red"></a>
  <a href="https://avrdudes.github.io/avrdude/"><img alt="avrdude" src="https://img.shields.io/badge/avrdude-6..7-purple"></a>
  <a href="https://github.com/buserror/simavr"><img alt="simavr" src="https://img.shields.io/badge/simavr-gdb--server-teal"></a>
  <a href="https://code.visualstudio.com/"><img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-1.75%2B-orange"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-Win%20%7C%20Linux%20%7C%20macOS-lightgrey">
</p>

---

## What's new in 0.3.24

- 🏷️ **Marketplace upload fix: categories** — the upload was rejected with `The category 'Embedded' is not available in language 'en-us'`: the Marketplace accepts a fixed category list only and `Embedded` has never been on it. The extension now files under **Programming Languages**, **Debuggers** (it ships a real simavr/avr-gdb debug provider) and **Other**; `embedded` stays a search keyword. No extension code changed

## What's new in 0.3.23

- 📦 **Marketplace-ready VSIX packaging** — the VSIX manifest schema version is now the canonical `2.0.0` (it accidentally carried the extension version since the first release — VS Code's installer tolerated it, the publisher validation did not), the zip layout matches `vsce package` output (no directory entries, normalized file modes), and the package is built with the real `@vscode/vsce`. No extension code changed

*Full history: [changelog.md](https://github.com/Dzantemir/avr-mdf/blob/HEAD/changelog.md)*

## Highlights

- 🔀 **Two toolchains** — every project compiles with **GNU avr-gcc** (avr-libc, `F_CPU`, `ISR()`, simavr/avr-gdb debug) or **Microchip XC8** (`xc8-cc`: `<xc.h>`, `F_CPU` + `<util/delay.h>`, `#pragma config`, one-step compile+link → ELF → avr-objcopy → `.hex`; AVR *and* PIC 8-bit devices). Switch per project: status-bar chip, `Ctrl+Alt+T`, palette, wizard or project editor
- 🧩 **MCU database** — 311 built-in MCUs: the full avr-gcc device list (every ATtiny/ATmega/AT90/ATxmega series, modern DA/DB/DD/EA, automotive ATA, Arduino aliases), grouped into 15 series. Curate your own in the **Board Manager** — series tree, prefix filter, card editor; user boards survive updates in `~/.avr-mdf/boards`
- ⚙️ **Build** — `avr-gcc`/`avr-g++` with `-mmcu`/`-DF_CPU` from the board, `-ffunction-sections -fdata-sections` + `-Wl,--gc-sections`, AVR **linker relaxation** (`-mrelax`, the documented switch that arms both the assembler and the linker), optional LTO, components (`avr-ar`), per-language flags, hooks; `.elf → .hex/.bin/.eep`; errors land in the **Problems panel**
- 🚀 **Zero-setup debugging** — F5 starts **simavr** (`-g`) and drives **avr-gdb (MI)**: breakpoints, stepping, variables & watches, registers, memory. Hardware: any GDB-RSP server (avarice, Atmel-ICE, Dragon…)
- 🔥 **Fuse editor** — bit-level lfuse/hfuse/efuse/lock editing (17 verified classic layouts), CKSEL clock tables, presets, **read & write via avrdude**, UPDI fuse0…fuse8 hex mode
- ⚡ **Flash with avrdude** — 20 programmer recipes (USBasp, Optiboot, Caterina with the `-r` touch, urclock, SerialUPDI, jtag2updi, Atmel-ICE, PICkit4/SNAP, Dragon incl. HV, Bus Pirate, flip1), EEPROM up/download, chip erase
- 📡 **Serial Monitor** — port/baud dropdowns in the toolbar (↻ re-scan), timestamps/autoscroll, EOL picker by the input row, rx/tx byte counters in the status line, status-bar Start/Stop
- 📊 **Memory report** — flash/RAM/EEPROM bars against the board's limits, symbols, build history + chart
- 📚 **AVR-Libc Reference** — 28 modules / 214 functions browsable in the sidebar (XC8 projects get the XC8 catalogue instead) with one-click `#include` insertion
- 🔧 **Development Tools** — every toolchain utility with live found/missing state, incl. the full XC8 catalogue (37 tools)
- ✅ **tasks.json & launch.json** write themselves (merge-only); IntelliSense configures itself through the real compiler
- 📥 **Import** — a guided wizard for Arduino sketches, PlatformIO, Makefiles, Code::Blocks and Eclipse CDT projects

## Requirements

- An **avr-gcc toolchain** (avr-gcc + avr-binutils + avr-libc) — auto-detected: PATH → Arduino IDE bundled tools → Microchip Studio → WinAVR → CrossPack/homebrew, or point AVR-MDF at it
- Optional: **Microchip XC8** (`xc8-cc`, per-project), **avrdude** (flash), **simavr** + **avr-gdb** (debugging), **avarice** (hardware debug)

## Installation

`code --install-extension avr-mdf-0.3.18.vsix`, or Extensions view → `···` → **Install from VSIX…**. Upgrading from any 0.3.x is a plain install-over; projects, settings and global boards carry over untouched.

## Toolchains

Every project carries its own `toolchain` field in `avr-project.json` — `avr-gcc` (the default) or `xc8`. Switch via the **status-bar chip** (`Ctrl+Alt+T`), **AVR: Switch Toolchain** in the palette, the project view/editor, or the create wizard. Switching preserves every other project field and refreshes the status bar, tree, IntelliSense and the Reference view.

### Picking a toolchain folder

`AVR: Select Toolchain Path` / `AVR: Select XC8 Compiler Path` accept a `bin` folder, the executable, a distribution **root folder**, or **any parent folder**: nested layouts are probed (avr-gcc: `bin/`, `avr-gcc/bin/`, `avr/bin/`, `avr8-gnu-toolchain/bin/`…; XC8: `bin/`, `v*/bin/`, `xc8/bin/`…), with a bounded BFS deep scan (≤ 4 levels) as the fallback. Verified against the real archives:

- [**ZakKemble avr-gcc-build 16.1.0 x64 Windows**](https://github.com/ZakKemble/avr-gcc-build/releases) — pick the extracted `avr-gcc-16.1.0-x64-windows` folder; `bin/avr-gcc.exe` (+ `avrdude.exe`, `make.exe`, `avr-gdb.exe`) is captured automatically
- [**Microchip XC8 v4.00**](https://www.microchip.com/en-us/tools-resources/develop/mplab-xc-compilers/xc8#downloads) — pick the extracted `xc8-v4.00` folder; `bin/xc8-cc.exe` plus the AVR/PIC backends are captured

The pickers list every auto-detected candidate with its source, persist the **resolved executable**, and end with a version toast + full view refresh; an unmatched folder gets an honest "checked everything — use anyway?" fallback.

### GNU avr-gcc (default)

`avr-gcc`/`avr-g++` with `-mmcu`/`-DF_CPU` from the board, avr-libc, components via `avr-ar`, `.elf` → `.hex`/`.bin`/`.eep`, hooks, avr-size memory report. **Debugging (F5 — simavr/avr-gdb) lives on this path.**

### Microchip XC8 (`xc8-cc`)

- **Install** MPLAB XC8 from [microchip.com](https://www.microchip.com/en-us/products/compilers/microchip-xc8) (the free license is enough); auto-detected or set via `avr.xc8.path` / **AVR: Select XC8 Compiler Path**.
- **Build** is a single `xc8-cc` invocation (compile + assemble + link, `-mcpu=` MPLAB device spelling, `F_CPU` from the board so `_delay_ms()` from `<util/delay.h>` works) leaving the ELF, then XC8's own `avr-objcopy -O ihex` emits the `.hex` (+ `.eep`); `#pragma config` fuse values land in the fuse sections — burn them with avrdude / the Fuse Editor.
- **Options**: `avr.xc8.optimization`, `avr.xc8.cStandard` (c90/c99 — the documented set), `avr.xc8.warnings`, `avr.xc8.extraArgs` (e.g. `-mdfp=…`, `-mext=cci`).
- **Memory report** from the ELF via XC8's own `avr-size`/`avr-nm`; **flashing** identical (the same 20 avrdude recipes); **debugging** offers to switch to avr-gcc first (simavr/avr-gdb needs avr-gcc DWARF).

## Quick start

1. Install the AVR toolchain (e.g. `sudo apt install gcc-avr avr-libc avrdude simavr gdb-avr` / `brew tap osx-cross/avr && brew install avr-gcc avr-binutils avr-libc avrdude simavr`).
2. **Create New Project** (sidebar) → name → board → toolchain → a fresh folder.
3. Write code in `src/main.c` (the template already blinks) → **Build** (`Ctrl+Alt+B`).
4. Press **F5** — on an unbuilt project the **Build & Debug** button builds (Debug mode) and starts simavr; execution stops on `main()`.
5. Pick a programmer and **Flash** (`Ctrl+Alt+F`); the Serial Monitor opens automatically.

## The sidebar

| View | What it gives you |
|---|---|
| **Project & Commands** | Create / Import project, live config status, board & sources overview, **Actions** (Build / Flash / Clean / Disassembly), **Device** (Fuse Editor… / Chip Erase / EEPROM upload & download) and **Port Settings** |
| **Memory** | usage bars with threshold tick + Δ, symbols, build-history chart, live updates after every build |
| **Serial Monitor** | port/baud dropdowns, Start/⏹ Stop, timestamps & autoscroll, EOL, send line, rx/tx counters |
| **Development Tools** | avr-gcc + XC8 catalogues with live found-counts and the toolchain pickers |
| **AVR-Libc Reference** | every avr-libc module / function (or the XC8 catalogue) — right-click → insert the `#include` |

Every view is a draggable tab; **AVR: Return Views to the Sidebar** brings them home. Keybindings: `Ctrl+Alt+B/F/C` build/flash/clean, `Ctrl+Alt+M` monitor, `Ctrl+Alt+D` debug, `Ctrl+Alt+T` switch toolchain.

## Project layout

```
my-project/
├─ avr-project.json     # the project file (visual editor: ✎ in the tree)
├─ src/                 # .c/.cpp/.S sources (recursively; .S gets cpp)
├─ include/ lib/ components/   # optional (components = source libraries)
└─ build/               # obj/**, comp/**, firmware.elf/.hex/.bin/.eep/.map
```

Minimal `avr-project.json`:

```json
{
  "name": "blink",
  "board": "uno",
  "sources": ["src"],
  "build": { "output_dir": "build", "output_name": "firmware" }
}
```

Build options: `optimization` (default `-Os`), `c_flags`/`cxx_flags`/`asm_flags`/`link_flags`, `lto`, `gc_sections` (on), `relax` (on), hooks `pre_build` / `post_link` / `post_build` / `pre_upload` / `post_upload` (a string, or an array for several commands per stage). Upload: `programmer` (avrdude -c), `port`, `baud`, `eeprom`, `tool`+`args` (custom with full `${…}` expansion), `fuses` (starting values for the Fuse Editor). Variables: `${workspaceFolder}`, `${board.mcu}`, `${board.fcpu}`, `${outputHex}`, `${config:avr.comPort}`, `${env:NAME}`… — unresolved ones stay literal.

## Fuses

`AVR: Open Fuse Editor…` — bit-level editing with per-bit descriptions (SPIEN / RSTDISBL / DWEN warnings included), CKSEL clock tables, presets (internal 1/8 MHz, external crystal, Optiboot, BOD…), **Read from chip** / **Write to chip** via avrdude with a confirmation listing the exact bytes. Verified layouts: ATmega328P/328/168(P), 2560/1280, tiny25/45/85, tiny24/44/84, tiny2313/4313, mega16/32, mega8. Everything else falls back to raw hex mode with a datasheet warning.

## Debugging

Simulator-first on **simavr** with **avr-gdb** in MI mode — one flow, no native modules:

1. Press **F5** (works without launch.json): starts `simavr -g -m <mcu> -f <freq> firmware.elf`, connects avr-gdb to `:1234`, stops on `main()`.
2. Breakpoints, stepping, hover variables, Locals/Registers, watches, memory via the Hex Editor, raw gdb commands in the Debug Console (`info registers`, `x/16x 0x100`, `disassemble`…).
3. **Hardware**: the `gdb` backend attaches to any GDB-RSP server — set `gdbServerCmd` (e.g. `avarice --jtag /dev/ttyUSB0 :4242`) and the extension launches/stops it for you.

Debugging is avr-gcc-only — on an XC8 project F5 offers to switch the toolchain first.

## avrdude

- Recipes in **AVR: Select Programmer** (stored in the project's `upload.programmer`)
- `-U flash:w:firmware.hex:a` by default — the ELF is accepted too when the hex is missing (explicit `:e`, avrdude 7+)
- EEPROM: upload any image you pick (`.hex` / `.eep` / `.bin`, auto-detected format) / download dumps to `build/eeprom-dump-<date>.hex` (toast with the byte count + Open)
- `avr.avrdude.verbose` (`-v`), `avr.avrdude.verify` off → `-V`, `avr.avrdude.eraseBeforeFlash` → `-e`, `avr.avrdude.extraArgs` for global extras

## Coming from another IDE?

**AVR: Import Project from Other IDE…** — pick the format (Arduino sketch `.ino` / PlatformIO `platformio.ini` / Makefile / Code::Blocks `.cbp` / Eclipse CDT `.cproject`), pick the file, review the draft (name, MCU, sources, flags, upload + honest notes on anything that could not be migrated), and it writes `avr-project.json` **in place**, adds the folder to the workspace, syncs tasks/launch/IntelliSense and opens the Project Editor.

## Settings

| Setting | Default | Description |
|---|---|---|
| `avr.toolchainPath` | `""` | avr-gcc bin folder / prefix / executable; empty = auto-detect |
| `avr.xc8.path` | `""` | Microchip XC8 location (`bin` folder or `xc8-cc` executable); empty = auto-detect |
| `avr.xc8.optimization` | `default` | XC8 optimization level (`-O`): `default`/`0`/`1`/`2`/`3` |
| `avr.xc8.cStandard` | `c99` | XC8 C standard (`-std=`): `c90`/`c99` |
| `avr.xc8.warnings` | `true` | pass `-Wall` to `xc8-cc` |
| `avr.xc8.extraArgs` | `""` | extra `xc8-cc` arguments (e.g. `--opt=+asm,+speed`) |
| `avr.avrdudePath` | `""` | avrdude override |
| `avr.simavrPath` | `""` | simavr override |
| `avr.gdbPath` | `""` | avr-gdb override |
| `avr.boardsDir` | `""` | extra board JSON folder (priority: project `.avr/boards` → this → global → built-in) |
| `avr.comPort` | `""` | serial port |
| `avr.programmer` | `""` | default avrdude programmer (project `upload.programmer` wins) |
| `avr.shellPath` | `""` | Windows shell override |
| `avr.reuseTerminal` | `true` | reuse the AVR terminal |
| `avr.saveSettingsToWorkspace` | `true` | save port etc. to workspace settings |
| `avr.autoHexBin` | `true` | also produce `.bin` + `.eep` after build |
| `avr.postBuildAction` | `none` | `flash` = flash right after a successful build |
| `avr.buildMode` | `release` | `debug` adds `-Og -g` + `DEBUG` (DWARF for simavr/GDB) |
| `avr.avrdude.verbose` | `false` | pass `-v` to avrdude |
| `avr.avrdude.verify` | `true` | verify flash after writing (off adds `-V`) |
| `avr.avrdude.eraseBeforeFlash` | `false` | explicit chip erase (`-e`) before writing |
| `avr.avrdude.extraArgs` | `""` | global extra avrdude arguments |
| `avr.debug.stopOnEntry` | `true` | run to `main()` on F5 |
| `avr.debug.simPath` | `""` | explicit simavr |
| `avr.debug.gdbPath` | `""` | explicit avr-gdb |
| `avr.debug.clockFromBoard` | `true` | feed the board's `f_cpu` to simavr (`-f`) |
| `avr.debug.mcu` | `""` | override the simulator MCU |
| `avr.debug.syncLaunchJson` | `true` | merge the debug records into launch.json |
| `avr.intellisense.autoConfig` | `true` | configure IntelliSense when missing |
| `avr.autoGenerateTasks` | `true` | merge the three AVR tasks into tasks.json |
| `avr.monitorBaud` | `115200` | default Serial Monitor baud |
| `avr.monitorEol` | `lf` | send-line terminator |
| `avr.monitorTimestamps` | `false` | prefix received lines with a timestamp |
| `avr.monitorAutoOpen` | `true` | open the Serial Monitor after flash |
| `avr.memory.thresholdWarning` | `85` | area turns yellow at this % |
| `avr.memory.historyLimit` | `50` | builds kept in the memory report history |

**Supported shells:** PowerShell, cmd, bash, sh, zsh, fish, dash, ksh, csh, tcsh, WSL — commands run in the AVR terminal with per-shell exit-code markers; long lines are split at token boundaries under the shell's line limit; compiler failures are replayed hidden to capture stderr for the Problems panel.

## License

[MIT](https://github.com/Dzantemir/avr-mdf/blob/HEAD/LICENSE.txt) © Dzantemir
