'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ports.js — serial port detection, the sdcc-mdf 0.29.0 approach verbatim:
//   Windows: [System.IO.Ports.SerialPort]::GetPortNames() — ONLY the ports
//            that are actually present. v0.3.9: the old Win32_SerialPort CIM
//            query with its blind "registry-style COM scan" fallback (a
//            fabricated COM1…COM32 list) is GONE — an empty result now
//            honestly means "No ports detected — enter manually".
//   Linux:   /dev pattern scan (ttyUSB / ttyACM / ttyS)
//   macOS:   the same scan's cu.* / tty.* patterns incl. the CP210x
//            (SLAB_USBtoUART) and CH340 (wchusbserial) adapter names
// v0.3.9 (the sdcc-mdf v0.28.9 pattern): detectPorts() is SYNCHRONOUS with a
//   short TTL cache — the Serial Monitor's bursts don't re-spawn PowerShell
//   per call. list() stays as the legacy async wrapper for the monitor.
// ─────────────────────────────────────────────────────────────────────────────
const cp   = require('child_process');
const fs   = require('fs');
const path = require('path');
const H    = require('./helpers');

const PORTS_CACHE_MS = 2500;
let _portsCache = null;   // { at, list } — the last scan

function detectPorts() {
    if (_portsCache && (Date.now() - _portsCache.at) < PORTS_CACHE_MS) {
        return _portsCache.list.slice();   // copy — callers must not mutate the cache
    }
    const list = _scanPorts();
    _portsCache = { at: Date.now(), list };
    return list.slice();
}

function _scanPorts() {
    try {
        if (H.IS_WIN) {
            const out = cp.execSync(
                'powershell.exe -NoProfile -Command "[System.IO.Ports.SerialPort]::GetPortNames() -join \',\'"',
                { timeout: 5000, windowsHide: true }
            ).toString().trim();
            return out ? out.split(',').map(s => s.trim()).filter(Boolean) : [];
        }
        const devDir = '/dev';
        if (!fs.existsSync(devDir)) return [];
        // the sdcc-mdf pattern list — the two most common USB-serial adapters
        // on macOS included: CP210x (cu.SLAB_USBtoUART) and CH340
        // (cu.wchusbserial*, the older 10.13–11 driver layout)
        const patterns = [
            /^ttyUSB\d+/, /^ttyACM\d+/, /^ttyS\d+/,
            /^tty\.usbserial/, /^tty\.usbmodem/,
            /^cu\.usbserial/, /^cu\.usbmodem/,
            /^cu\.SLAB_USBtoUART/, /^tty\.SLAB_USBtoUART/,   // CP210x (macOS)
            /^cu\.wchusbserial/, /^tty\.wchusbserial/,       // CH340 (macOS, legacy driver)
        ];
        return fs.readdirSync(devDir)
            .filter(n => patterns.some(p => p.test(n)))
            .map(n => path.join(devDir, n))
            .sort();
    } catch {
        return [];
    }
}

// async wrapper (kept for external callers / the port picker's flows) —
// the webview dropdown is fed the ids; descriptions are gone with the CIM
// query — an id is all a port needs here
function list() { return Promise.resolve(detectPorts().map(id => ({ id }))); }

module.exports = { list, detectPorts };
