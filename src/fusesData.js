'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Fuse-bit database for the AVR-MDF fuse editor.
//
// SAFETY: fuse errors can lock a user out of the chip (SPIEN=1, RSTDISBL=0,
// wrong DWEN…). Only layouts verified against the Microchip datasheets are
// listed here; every other MCU falls back to raw hex editing with a warning.
// Fuse bits are ACTIVE-LOW in effect: "0 = programmed = feature ON" for most
// bits, factory state is 1 (0xFF).
//
// avrdude memories: lfuse / hfuse / efuse / lock (classic),
// fuse0..fuse8 (modern UPDI parts), fuse0..fuse5 (xmega).
// ─────────────────────────────────────────────────────────────────────────────

const CLASSIC = {
    // ── ATmega328P family: 328P / 328 / 168 / 168P share one layout ──────────
    'atmega328p': _f328('ATmega328P', 0x62, 0xD9, 0xFF),
    'atmega328':  _f328('ATmega328',  0x62, 0xD9, 0xFF),
    'atmega168p': _f328('ATmega168P', 0x62, 0xDF, 0xFF),
    'atmega168':  _f328('ATmega168',  0x62, 0xDF, 0xFF),

    // ── ATmega2560 / 1280 (JTAG parts, CKDIV8 + HWBE) ────────────────────────
    'atmega2560': {
        defaults: { lfuse: 0x62, hfuse: 0xD9, efuse: 0xFF, lock: 0x3F },
        lfuse: _lCKSEL(),
        hfuse: {
            bits: [
                { name: 'BOOTRST',  bit: 0, desc: '0 = reset vector jumps to the bootloader section' },
                { name: 'BOOTSZ0',  bit: 1, desc: 'Boot section size bit 0 (00 = 8 KB on the 2560)' },
                { name: 'BOOTSZ1',  bit: 2, desc: 'Boot section size bit 1' },
                { name: 'EESAVE',   bit: 3, desc: '0 = EEPROM preserved during chip erase' },
                { name: 'WDTON',    bit: 4, desc: '0 = watchdog always on (cannot be disabled in software)' },
                { name: 'SPIEN',    bit: 5, desc: '0 = serial SPI programming enabled — LEAVE 1 ONLY with a parallel/HV programmer available!' },
                { name: 'JTAGEN',   bit: 6, desc: '0 = JTAG enabled (boundary scan / JTAG debug)' },
                { name: 'OCDEN',    bit: 7, desc: '0 = on-chip debug enabled (needs JTAGEN=0)' },
            ],
        },
        efuse: {
            bits: [
                { name: 'BODLEVEL0', bit: 0, desc: 'Brown-out level bit 0 (111 = BOD disabled; see datasheet table)' },
                { name: 'BODLEVEL1', bit: 1, desc: 'Brown-out level bit 1' },
                { name: 'BODLEVEL2', bit: 2, desc: 'Brown-out level bit 2' },
                { name: 'HWBE',      bit: 3, desc: '0 = hardware boot enable (bootloader entered via HWB pin)' },
            ],
        },
        lock: _lockBits(),
        presets: [
            { name: 'Internal 1 MHz (factory)',  lfuse: 0x62, hfuse: 0xD9, efuse: 0xFF },
            { name: 'Internal 8 MHz',            lfuse: 0xE2, hfuse: 0xD9, efuse: 0xFF },
            { name: 'External crystal 16 MHz',   lfuse: 0xFF, hfuse: 0xD9, efuse: 0xFF },
            { name: 'Arduino Mega (Optiboot 8K)', lfuse: 0xFF, hfuse: 0xD8, efuse: 0xFD },
        ],
        cksel: _cksel328(),
    },
    'atmega1280': null,   // filled below (same layout as 2560)

    // ── ATtiny25 / 45 / 85 (BODLEVEL in hfuse, no efuse) ─────────────────────
    'attiny85': _tiny85('ATtiny85', 0x62, 0xDF),
    'attiny45': _tiny85('ATtiny45', 0x62, 0xDF),
    'attiny25': _tiny85('ATtiny25', 0x62, 0xDF),

    // ── ATtiny24 / 44 / 84 ───────────────────────────────────────────────────
    'attiny84': _tiny85('ATtiny84', 0x62, 0xDF),
    'attiny44': _tiny85('ATtiny44', 0x62, 0xDF),
    'attiny24': _tiny85('ATtiny24', 0x62, 0xDF),

    // ── ATtiny2313 / 4313 ────────────────────────────────────────────────────
    'attiny2313': _tiny2313('ATtiny2313', 0x64, 0xDF),
    'attiny4313': _tiny2313('ATtiny4313', 0x64, 0xDF),

    // ── ATmega16 / 32 (BOD in lfuse, CKOPT + JTAG in hfuse, no efuse) ────────
    'atmega16': _mega16('ATmega16', 0xC1, 0x99),
    'atmega32': _mega16('ATmega32', null, 0x99),

    // ── ATmega8 (lfuse only — hfuse layout differs, edit hex + datasheet) ────
    'atmega8': {
        defaults: { lfuse: 0xE1, hfuse: null, efuse: null, lock: 0x3F },
        lfuse: {
            bits: [
                { name: 'CKSEL0', bit: 0, desc: 'Clock select bit 0 (0001 = internal 1 MHz RC — factory)' },
                { name: 'CKSEL1', bit: 1, desc: 'Clock select bit 1' },
                { name: 'CKSEL2', bit: 2, desc: 'Clock select bit 2' },
                { name: 'CKSEL3', bit: 3, desc: 'Clock select bit 3' },
                { name: 'SUT0',   bit: 4, desc: 'Start-up time bit 0' },
                { name: 'SUT1',   bit: 5, desc: 'Start-up time bit 1' },
                { name: '(unused)', bit: 6, desc: 'unused, keep 1' },
                { name: '(unused)', bit: 7, desc: 'unused, keep 1' },
            ],
        },
        hfuse: null,   // bit layout differs from the 328 family — hex mode + datasheet
        efuse: null,   // ATmega8 has no extended fuse
        lock: _lockBits(),
        presets: [
            { name: 'Internal 1 MHz (factory)', lfuse: 0xE1 },
            { name: 'Internal 8 MHz',           lfuse: 0xE4 },
        ],
        cksel: [
            { value: 0b0000, desc: 'External clock' },
            { value: 0b0001, desc: 'Internal 1 MHz RC (factory)' },
            { value: 0b0010, desc: 'Internal 2 MHz RC' },
            { value: 0b0011, desc: 'Internal 4 MHz RC' },
            { value: 0b0100, desc: 'Internal 8 MHz RC' },
            { value: 0b0101, desc: 'Crystal / ceramic (see datasheet CKSEL table)' },
        ],
        note: 'The ATmega8 high-fuse layout (OCDEN / SPIEN / CKOPT / EESAVE / BOOTSZ / BOOTRST) differs from newer parts — check the datasheet § "Fuse Bits" before writing hfuse.',
    },
};
CLASSIC['atmega1280'] = JSON.parse(JSON.stringify(CLASSIC['atmega2560']));
CLASSIC['atmega1280'].defaults = { lfuse: 0x62, hfuse: 0xD9, efuse: 0xFF, lock: 0x3F };
CLASSIC['atmega1280'].presets = [
    { name: 'Internal 1 MHz (factory)', lfuse: 0x62, hfuse: 0xD9, efuse: 0xFF },
    { name: 'Internal 8 MHz',           lfuse: 0xE2, hfuse: 0xD9, efuse: 0xFF },
    { name: 'External crystal 16 MHz',  lfuse: 0xFF, hfuse: 0xD9, efuse: 0xFF },
];

// ── layout helpers (shared bit maps) ─────────────────────────────────────────
function _lCKSEL() {
    return {
        bits: [
            { name: 'CKSEL0', bit: 0, desc: 'Clock select bit 0 (see CKSEL table)' },
            { name: 'CKSEL1', bit: 1, desc: 'Clock select bit 1' },
            { name: 'CKSEL2', bit: 2, desc: 'Clock select bit 2' },
            { name: 'CKSEL3', bit: 3, desc: 'Clock select bit 3' },
            { name: 'SUT0',   bit: 4, desc: 'Start-up time bit 0 (extra delay from reset)' },
            { name: 'SUT1',   bit: 5, desc: 'Start-up time bit 1' },
            { name: 'CKOUT',  bit: 6, desc: '0 = system clock output on the CKOUT pin' },
            { name: 'CKDIV8', bit: 7, desc: '0 = system clock divided by 8 at start (1 MHz from the 8 MHz RC)' },
        ],
    };
}
function _f328(name, lf, hf, ef) {
    return {
        defaults: { lfuse: lf, hfuse: hf, efuse: ef, lock: 0x3F },
        lfuse: _lCKSEL(),
        hfuse: {
            bits: [
                { name: 'BOOTRST',  bit: 0, desc: '0 = reset vector points at the bootloader section' },
                { name: 'BOOTSZ0',  bit: 1, desc: 'Boot size bit 0 (01 = 512 B — Optiboot)' },
                { name: 'BOOTSZ1',  bit: 2, desc: 'Boot size bit 1' },
                { name: 'EESAVE',   bit: 3, desc: '0 = EEPROM preserved during chip erase' },
                { name: 'WDTON',    bit: 4, desc: '0 = watchdog always on' },
                { name: 'SPIEN',    bit: 5, desc: '0 = ISP programming enabled — NEVER set 1 unless you have HV/parallel programming!' },
                { name: 'DWEN',     bit: 6, desc: '0 = debugWIRE enabled (RESET pin becomes debug wire — ISP stops working until DWEN is cleared via debugWIRE!)' },
                { name: 'RSTDISBL', bit: 7, desc: '0 = RESET disabled, pin becomes GPIO — ISP entry via reset is lost. Requires HV programming to recover!' },
            ],
        },
        efuse: {
            bits: [
                { name: 'BODLEVEL0', bit: 0, desc: 'Brown-out level bit 0 (111 = BOD off; 110=1.8V, 101=2.7V, 100=4.3V)' },
                { name: 'BODLEVEL1', bit: 1, desc: 'Brown-out level bit 1' },
                { name: 'BODLEVEL2', bit: 2, desc: 'Brown-out level bit 2' },
            ],
        },
        lock: _lockBits(),
        presets: [
            { name: 'Internal 1 MHz (factory)',  lfuse: 0x62, hfuse: 0xD9, efuse: 0xFF },
            { name: 'Internal 8 MHz',            lfuse: 0xE2, hfuse: 0xD9, efuse: 0xFF },
            { name: 'External crystal 8–16 MHz', lfuse: 0xF7, hfuse: 0xD9, efuse: 0xFF },
            { name: 'Ext. crystal + BOD 2.7 V',  lfuse: 0xF7, hfuse: 0xD9, efuse: 0xFD },
            { name: 'Optiboot 512 B (Uno)',      lfuse: 0xFF, hfuse: 0xDE, efuse: 0xFF },
        ],
        cksel: _cksel328(),
    };
}
function _cksel328() {
    return [
        { value: 0b0000, desc: 'External clock' },
        { value: 0b0001, desc: 'Internal 8 MHz RC' },
        { value: 0b0010, desc: 'Internal 8 MHz RC (factory)' },
        { value: 0b0011, desc: 'Internal 128 kHz WDT oscillator' },
        { value: 0b0100, desc: 'Low-power crystal 0.4–0.9 MHz' },
        { value: 0b0101, desc: 'Low-power crystal 0.9–3.0 MHz' },
        { value: 0b0110, desc: 'Low-power crystal 3.0–8.0 MHz' },
        { value: 0b0111, desc: 'Low-power crystal 8.0–16 MHz (classic 16 MHz value, lfuse 0xF7)' },
        { value: 0b1001, desc: 'Ceramic resonator 0.4–0.9 MHz' },
        { value: 0b1010, desc: 'Ceramic resonator 0.9–3.0 MHz' },
        { value: 0b1011, desc: 'Ceramic resonator 3.0–8.0 MHz' },
        { value: 0b1100, desc: 'Full-swing crystal 0.4–0.9 MHz' },
        { value: 0b1101, desc: 'Full-swing crystal 0.9–3.0 MHz' },
        { value: 0b1110, desc: 'Full-swing crystal 3.0–8.0 MHz' },
        { value: 0b1111, desc: 'Full-swing crystal 8.0–16 MHz' },
    ];
}
function _tiny85(name, lf, hf) {
    return {
        defaults: { lfuse: lf, hfuse: hf, efuse: null, lock: 0x3F },
        lfuse: _lCKSEL(),
        hfuse: {
            bits: [
                { name: 'BODLEVEL0', bit: 0, desc: 'Brown-out level bit 0 (111 = BOD off)' },
                { name: 'BODLEVEL1', bit: 1, desc: 'Brown-out level bit 1' },
                { name: 'BODLEVEL2', bit: 2, desc: 'Brown-out level bit 2' },
                { name: 'EESAVE',    bit: 3, desc: '0 = EEPROM preserved during chip erase' },
                { name: 'WDTON',     bit: 4, desc: '0 = watchdog always on' },
                { name: 'SPIEN',     bit: 5, desc: '0 = ISP programming enabled — never set 1 without HV programming!' },
                { name: 'DWEN',      bit: 6, desc: '0 = debugWIRE on (RESET becomes debug pin)' },
                { name: 'RSTDISBL',  bit: 7, desc: '0 = RESET pin disabled → HV programming needed to recover!' },
            ],
        },
        efuse: null,   // no extended fuse on tiny25/45/85/24/44/84
        lock: _lockBits(),
        presets: [
            { name: 'Internal 1 MHz (factory)', lfuse: 0x62, hfuse: 0xDF },
            { name: 'Internal 8 MHz',           lfuse: 0xE2, hfuse: 0xDF },
        ],
        cksel: [
            { value: 0b0000, desc: 'External clock' },
            { value: 0b0001, desc: 'Internal 6.4 MHz (PLL-derived)' },
            { value: 0b0010, desc: 'Internal 8 MHz RC (factory)' },
            { value: 0b0011, desc: 'Internal 16 MHz PLL' },
            { value: 0b0100, desc: 'Internal 128 kHz WDT oscillator' },
            { value: 0b0101, desc: 'See datasheet CKSEL table' },
        ],
    };
}
function _tiny2313(name, lf, hf) {
    return {
        defaults: { lfuse: lf, hfuse: hf, efuse: null, lock: 0x3F },
        lfuse: _lCKSEL(),
        hfuse: {
            bits: [
                { name: 'BODLEVEL0', bit: 0, desc: 'Brown-out level bit 0 (111 = BOD off)' },
                { name: 'BODLEVEL1', bit: 1, desc: 'Brown-out level bit 1' },
                { name: 'BODLEVEL2', bit: 2, desc: 'Brown-out level bit 2' },
                { name: 'EESAVE',    bit: 3, desc: '0 = EEPROM preserved during chip erase' },
                { name: 'WDTON',     bit: 4, desc: '0 = watchdog always on' },
                { name: 'SPIEN',     bit: 5, desc: '0 = ISP programming enabled' },
                { name: 'DWEN',      bit: 6, desc: '0 = debugWIRE on' },
                { name: 'RSTDISBL',  bit: 7, desc: '0 = RESET pin disabled — HV programming needed!' },
            ],
        },
        efuse: null,
        lock: _lockBits(),
        presets: [
            { name: 'Internal 1 MHz (factory)', lfuse: 0x64, hfuse: 0xDF },
            { name: 'Internal 8 MHz',           lfuse: 0xE4, hfuse: 0xDF },
        ],
        cksel: [
            { value: 0b0000, desc: 'External clock' },
            { value: 0b0100, desc: 'Internal 8 MHz RC (factory)' },
            { value: 0b0101, desc: 'See datasheet CKSEL table' },
        ],
    };
}
function _mega16(name, lf, hf) {
    return {
        defaults: { lfuse: lf, hfuse: hf, efuse: null, lock: 0x3F },
        lfuse: {
            bits: [
                { name: 'CKSEL0', bit: 0, desc: 'Clock select bit 0' },
                { name: 'CKSEL1', bit: 1, desc: 'Clock select bit 1' },
                { name: 'CKSEL2', bit: 2, desc: 'Clock select bit 2' },
                { name: 'CKSEL3', bit: 3, desc: 'Clock select bit 3' },
                { name: 'SUT0',   bit: 4, desc: 'Start-up time bit 0' },
                { name: 'SUT1',   bit: 5, desc: 'Start-up time bit 1' },
                { name: 'BODEN',  bit: 6, desc: '0 = brown-out detector enabled' },
                { name: 'BODLEVEL', bit: 7, desc: '0 = BOD trip 4.0 V, 1 = 2.7 V (with BODEN=0)' },
            ],
        },
        hfuse: {
            bits: [
                { name: 'BOOTRST', bit: 0, desc: '0 = reset jumps to the bootloader section' },
                { name: 'BOOTSZ0', bit: 1, desc: 'Boot size bit 0' },
                { name: 'BOOTSZ1', bit: 2, desc: 'Boot size bit 1' },
                { name: 'EESAVE',  bit: 3, desc: '0 = EEPROM preserved during chip erase' },
                { name: 'CKOPT',   bit: 4, desc: '0 = full-swing crystal amplifier (recommended ≥ 8 MHz crystals)' },
                { name: 'SPIEN',   bit: 5, desc: '0 = ISP programming enabled — never set 1 without HV programming!' },
                { name: 'JTAGEN',  bit: 6, desc: '0 = JTAG enabled' },
                { name: 'OCDEN',   bit: 7, desc: '0 = on-chip debug enabled (JTAG)' },
            ],
        },
        efuse: null,
        lock: _lockBits(),
        presets: [
            { name: 'Internal 1 MHz (factory)', lfuse: 0xC1, hfuse: 0x99 },
            { name: 'Internal 8 MHz',           lfuse: 0xC4, hfuse: 0x99 },
            { name: 'Ext. crystal 8–16 MHz',    lfuse: 0xFF, hfuse: 0xC9 },
        ],
        cksel: [
            { value: 0b0000, desc: 'External clock' },
            { value: 0b0001, desc: 'Internal 1 MHz RC (factory)' },
            { value: 0b0010, desc: 'Internal 2 MHz RC' },
            { value: 0b0011, desc: 'Internal 4 MHz RC' },
            { value: 0b0100, desc: 'Internal 8 MHz RC' },
            { value: 0b0101, desc: 'Crystal / ceramic (see datasheet CKSEL table)' },
        ],
    };
}
function _lockBits() {
    return {
        bits: [
            { name: 'LB1',   bit: 0, desc: 'Lock bit 1 (with LB2: 11 = no lock; further programming/verify locks — see table)' },
            { name: 'LB2',   bit: 1, desc: 'Lock bit 2' },
            { name: 'BLB01', bit: 2, desc: 'Boot lock bits 0 — SPM write to application section' },
            { name: 'BLB02', bit: 3, desc: 'Boot lock bits 0 — LPM read of application from boot' },
            { name: 'BLB11', bit: 4, desc: 'Boot lock bits 1 — SPM write to boot section' },
            { name: 'BLB12', bit: 5, desc: 'Boot lock bits 1 — LPM read of boot from application' },
        ],
    };
}

// ── Modern UPDI parts (tiny 0/1/2-series, mega 0/1-series) ───────────────────
const MODERN = {
    note: 'Modern UPDI parts store fuses as fuse0..fuse8 — avrdude memory names "fuse0", "fuse1", "fuse2", "fuse4"… depending on the part. FUSE writes go through the UPDI interface.',
    fuses: {
        fuse0: { name: 'WDTCFG',  desc: 'Watchdog: WINDOW + PERIOD' },
        fuse1: { name: 'BODCFG',  desc: 'Brown-out: BODLEVEL, ACTIVE, SLEEP, SAMPFREQ' },
        fuse2: { name: 'OSCCFG',  desc: 'Oscillator — FREQSEL bit 0: 0 = 16 MHz, 1 = 20 MHz (factory 20 MHz)' },
        fuse4: { name: 'TCD0CFG', desc: 'Timer/Counter TCD0 configuration (parts that have a TCD0)' },
        fuse5: { name: 'SYSCFG0', desc: 'Startup/CRC + EESYSCFG (EEPROM erase during chip erase)' },
        fuse6: { name: 'SYSCFG1', desc: 'Startup time (SUT)' },
        fuse7: { name: 'APPEND',  desc: 'Application section end — flash partitioning for A/B boot' },
        fuse8: { name: 'BOOTEND', desc: 'Boot section end — flash partitioning' },
    },
    defaults: { fuse0: 0x00, fuse1: 0x00, fuse2: 0x01 },
};

// ── ATxmega ──────────────────────────────────────────────────────────────────
const XMEGA = {
    note: 'ATxmega fuses are the memories fuse0..fuse5 (JTAG UID, watchdog WDP/WP, BOD, OSC, startup…). The exact byte set varies per part — inspect yours with `avrdude -p <part> -c <pgm> -t` then `part`, and always verify values against the datasheet before writing.',
};

// ── Lock bits ────────────────────────────────────────────────────────────────
const LOCK = {
    note: 'Classic lock byte: LB2/LB1 (11 = no lock; other combinations lock further programming and/or verification!), BLB01/BLB02 + BLB11/BLB12 protect the boot and application sections from read/write. Modern UPDI parts use the LOCKBIT register (0x00 = unlocked). Writing lock bits can PERMANENTLY disable further programming — know exactly what you write.',
};

module.exports = { CLASSIC, MODERN, XMEGA, LOCK };
