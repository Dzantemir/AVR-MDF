'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// utilsData.js — the catalogue of every AVR toolchain utility the extension
// knows about (data only, no vscode). The Development Tools view renders this
// as nested category groups with live found-counts; Toolchain.detect resolves
// each one to a concrete path.
//
// Covering the GNU AVR toolchain (avr-gcc + avr-binutils), avr-libc's
// companions, avrdude, simavr, avarice and make.
// ─────────────────────────────────────────────────────────────────────────────

const GROUPS = [
    {
        id: 'core',
        treeId: 'tcCoreGroup',
        label: 'Core',
        items: [
            { name: 'avr-gcc',  desc: 'The C compiler driver — also drives the assembler, linker and libc when invoked on .c/.S files. Everything in a build flows through it.', note: 'Accepts -mmcu=<device> (e.g. -mmcu=atmega328p) or -mmcu=<arch> (avr5).' },
            { name: 'avr-g++',  desc: 'The C++ compiler driver (avr-g++ is avr-gcc with a C++ front end). Freestanding C++: exceptions/RTTI off is recommended.', note: 'C++ constructors run via .init6; needs care with memory.' },
        ],
    },
    {
        id: 'asmlnk',
        treeId: 'tcAsmLnkGroup',
        label: 'Assembler & Linker',
        items: [
            { name: 'avr-as',  desc: 'The GNU assembler — normally invoked through avr-gcc on .s/.S files (.S gets C preprocessing).', note: 'Device selection comes from the -mmcu the gcc driver passes.' },
            { name: 'avr-ld',  desc: 'The linker — normally driven via avr-gcc, which adds the right crt<mcu>.o startup, libgcc, libc and libm in the correct order.', note: 'Direct use requires wiring crt/stdlibs by hand.' },
            { name: 'avr-ld.bfd', optional: true, desc: 'The alternative linker front end (same BFD backend as avr-ld).' },
            { name: 'avr-lto-dump', optional: true, desc: 'LTO object dumper (binutils ≥ 2.36-ish; present when the toolchain has LTO tools).' },
        ],
    },
    {
        id: 'binutils',
        treeId: 'tcBinutilsGroup',
        label: 'Binary Utilities',
        items: [
            { name: 'avr-objcopy', desc: 'Copies/converts object files — THE tool producing .hex/.bin/.eep from the ELF: -O ihex -R .eeprom -R .fuse …', note: '-j .eeprom -O ihex → firmware.eep' },
            { name: 'avr-objdump', desc: 'Disassembler & ELF inspector (-d -S shows source-interleaved disassembly; -h lists sections; -t the symbol table).' },
            { name: 'avr-size',    desc: 'Section sizes — the memory report engine: .text+.data → flash, .data+.bss → RAM, .eeprom → EEPROM.', note: 'The extension parses `avr-size -A` output.' },
            { name: 'avr-nm',      desc: 'Symbol table lister — the memory view uses `avr-nm --size-sort` for symbol sizes.' },
            { name: 'avr-ar',      desc: 'Archiver — builds .a libraries for components (avr-ar rcs build/libname.a *.o).' },
            { name: 'avr-ranlib',  desc: 'Generates the archive symbol index for .a libraries (implied by `ar s`).' },
            { name: 'avr-strip',   desc: 'Removes symbols/debug info from binaries (the release step when size matters).' },
            { name: 'avr-readelf', desc: 'ELF structure dumper (headers, sections, DWARF debug info).' },
            { name: 'avr-strings', desc: 'Finds printable strings inside binaries.' },
            { name: 'avr-addr2line', desc: 'Maps code addresses back to source files/lines (crash decoding).' },
            { name: 'avr-c++filt', desc: 'Demangles C++ symbol names.' },
            { name: 'avr-elfedit', desc: 'Edits ELF headers (arch/flags).' },
            { name: 'avr-gcov', optional: true, desc: 'Coverage analysis tool (with -coverage builds).' },
            { name: 'avr-gprof', optional: true, desc: 'Profiling display tool (flat profile from gmon.out — simulator runs).' },
        ],
    },
    {
        id: 'debug',
        treeId: 'tcDebugGroup',
        label: 'Debugging',
        items: [
            { name: 'avr-gdb', desc: 'The GDB debugger with the AVR backend — the debug engine the extension drives in MI mode against simavr or a hardware GDB server.', note: 'target remote :1234 (simavr -g) / :4242 (avarice).' },
            { name: 'avarice', desc: 'GDB-RSP bridge for real hardware: JTAG ICE mkI/II/3, Atmel-ICE, AVR Dragon, Power Debugger (JTAG / debugWIRE / PDI / UPDI as supported).', external: true },
        ],
    },
    {
        id: 'sim',
        treeId: 'tcSimGroup',
        label: 'Simulation',
        items: [
            { name: 'simavr', desc: 'Lean AVR simulator with a built-in GDB server (-g) and VCD trace output (-ti <vector>). The extension runs it as `simavr -g -m <mcu> -f <freq> firmware.elf`.', external: true },
        ],
    },
    {
        id: 'flash',
        treeId: 'tcFlashGroup',
        label: 'Flashing',
        items: [
            { name: 'avrdude', desc: 'The uploader: ISP (usbasp, usbtiny, STK500, AVR Dragon…), bootloaders (arduino/Optiboot, avr109/caterina, urclock), UPDI (serialupdi, jtag2updi, Atmel-ICE, PICkit4, SNAP, Power Debugger), PDI (xmega), and the -t interactive terminal.', external: true, note: 'List parts: avrdude -p ? / programmers: avrdude -c ?' },
        ],
    },
    {
        id: 'build',
        treeId: 'tcBuildGroup',
        label: 'Build tools',
        items: [
            { name: 'make', desc: 'GNU Make — runs the generated commands (the extension builds directly, but make-based workflows integrate too).', external: true },
        ],
    },
];

// Flat name lists (BY_NAME lookup + the "found X / total" counters)
const ALL = [];
const BY_NAME = {};
for (const g of GROUPS) {
    for (const it of g.items) {
        ALL.push(it.name);
        BY_NAME[it.name] = Object.assign({ group: g.label, optional: false, external: false }, it);
    }
}

// ─── The Microchip XC8 companion catalogue (v0.3.3) ───────────────────────────
// Mirrors the REAL xc8-v4.00 Windows distribution layout:
//   <root>/bin        xc8-cc (the driver — rendered as the branch header, so
//                     not listed here), xc8-ar, xc8-clangd, xc-ccov and the
//                     avr-/pic-objcopy/objdump front ends
//   <root>/avr/bin    the GCC 5.4.0-based AVR backend xc8-cc drives for AVR
//                     devices (avr-gcc, avr-g++, avr-as, avr-ld, …, avr-gdb)
//   <root>/avr/avr/bin  that backend's binutils (unprefixed ar/as/ld/nm/… +
//                     avr-pa, the XC8 patch tool)
//   <root>/pic/bin    the PIC 8-bit backend (aspic/cgpic/hlink/hexmate/…)
// `dir` is probed relative to the XC8 install root, with <root>/bin as the
// fallback search dir for every group.
const XC8_GROUPS = [
    {
        id: 'xc8driver', treeId: 'xc8DriverGroup', label: 'XC8 Driver Tools', dir: 'bin',
        items: [
            { name: 'xc8-ar',     desc: 'The XC8 archiver — builds .a libraries for XC8 projects (xc8-ar rcs lib.a *.o).' },
            { name: 'xc8-clangd', desc: 'The clangd language server shipped with XC8 v4 — language services for XC8 sources.', note: 'xc8-clangd can serve clangd-compatible editors.' },
            { name: 'xc-ccov',    desc: 'XC8 code-coverage companion — merges/reads .coverage files from instrumented builds.' },
        ],
    },
    {
        id: 'xc8avr', treeId: 'xc8AvrGroup', label: 'AVR Backend (GNU)', dir: 'avr/bin',
        items: [
            { name: 'avr-gcc',     desc: 'The GCC-based AVR compiler xc8-cc drives under the hood for AVR devices (GCC 5.4.0 in XC8 v4.00).', note: 'XC8 for AVR emits the classic ELF pipeline through this backend.' },
            { name: 'avr-g++',     desc: 'The backend C++ driver (freestanding C++ for AVR).' },
            { name: 'avr-as',      desc: 'The backend GNU assembler for AVR.' },
            { name: 'avr-ld',      desc: 'The backend linker for AVR.' },
            { name: 'avr-objcopy', desc: 'Copies/converts objects — produces the .hex/.eep from the ELF (also fronted by bin/avr-objcopy).' },
            { name: 'avr-objdump', desc: 'Disassembler & ELF inspector for the AVR backend (also fronted by bin/avr-objdump).' },
            { name: 'avr-size',    desc: 'Section sizes — the memory report engine (.text+.data → flash, .data+.bss → RAM).' },
            { name: 'avr-nm',      desc: 'Symbol table lister for the AVR backend.' },
            { name: 'avr-gdb',     desc: 'GDB with the AVR backend — debugging XC8-built AVR firmware.' },
        ],
    },
    {
        id: 'xc8avrbin', treeId: 'xc8AvrBinGroup', label: 'AVR Backend (binutils)', dir: 'avr/avr/bin',
        items: [
            { name: 'ar',       desc: 'Archiver of the backend binutils tree (unprefixed).' },
            { name: 'as',       desc: 'Assembler of the backend binutils tree (unprefixed).' },
            { name: 'ld',       desc: 'Linker of the backend binutils tree (unprefixed).' },
            { name: 'nm',       desc: 'Symbol lister of the backend binutils tree (unprefixed).' },
            { name: 'objcopy',  desc: 'Object converter of the backend binutils tree (unprefixed).' },
            { name: 'objdump',  desc: 'Object inspector of the backend binutils tree (unprefixed).' },
            { name: 'ranlib',   desc: 'Archive index generator of the backend binutils tree (unprefixed).' },
            { name: 'readelf',  desc: 'ELF dumper of the backend binutils tree (unprefixed).' },
            { name: 'strip',    desc: 'Symbol remover of the backend binutils tree (unprefixed).' },
            { name: 'avr-pa',   desc: 'The XC8 patch/annotation tool applied to backend objects (avr-pa).' },
        ],
    },
    {
        id: 'xc8pic', treeId: 'xc8PicGroup', label: 'PIC Backend', dir: 'pic/bin',
        items: [
            { name: 'aspic',     desc: 'The PIC assembler (mid-range core).' },
            { name: 'aspic18',   desc: 'The PIC18 assembler.' },
            { name: 'cgpic',     desc: 'The PIC code generator (mid-range).' },
            { name: 'cgpic18',   desc: 'The PIC18 code generator.' },
            { name: 'clang',     desc: 'The clang front end used by the XC8 PIC pipeline.' },
            { name: 'clist',     desc: 'XC8 assembly/C intermediate lister.' },
            { name: 'cromwell',  desc: 'The XC8 ROM utility (checksums/code protection data).' },
            { name: 'driver',    desc: 'The classic XC8 driver (mid-range PIC).' },
            { name: 'driver18',  desc: 'The classic XC8 driver (PIC18).' },
            { name: 'dump',      desc: 'XC8 object-file dumper.' },
            { name: 'hexmate',   desc: 'Hex file manipulator — merges/patches INTEL HEX files (docs/Hexmate_Readme).' },
            { name: 'hlink',     desc: 'The XC8 PIC linker.' },
            { name: 'libr',      desc: 'The XC8 PIC librarian.' },
            { name: 'pic-objcopy', desc: 'The objcopy front end for PIC objects (bin/pic-objcopy).' },
            { name: 'pic-objdump', desc: 'The objdump front end for PIC objects (bin/pic-objdump).' },
        ],
    },
];

const XC8_ALL = [];
const XC8_BY_NAME = {};
for (const g of XC8_GROUPS) {
    for (const it of g.items) {
        XC8_ALL.push(it.name);
        XC8_BY_NAME[it.name] = Object.assign({ group: g.label, dir: g.dir, optional: false, external: false }, it);
    }
}

module.exports = { GROUPS, ALL, BY_NAME, XC8_GROUPS, XC8_ALL, XC8_BY_NAME };
