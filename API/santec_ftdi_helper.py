#!/usr/bin/env python3
import argparse
import base64
import json
import re
import sys
import time
from typing import Any, Dict, List, Optional, Tuple


def _out(obj: Dict[str, Any], code: int = 0) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=True))
    sys.stdout.flush()
    raise SystemExit(code)


def _decode_payload(b64: Optional[str]) -> Dict[str, Any]:
    if not b64:
        return {}
    try:
        raw = base64.b64decode(b64.encode('ascii'), validate=True)
        parsed = json.loads(raw.decode('utf-8'))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _detect_model(idn: str) -> Optional[str]:
    t = str(idn or '').upper()
    if 'TSL550' in t or ('SANTEC' in t and '550' in t):
        return 'TSL550'
    if 'TSL570' in t or ('SANTEC' in t and '570' in t):
        return 'TSL570'
    if 'TSL710' in t or ('SANTEC' in t and '710' in t):
        return 'TSL710'
    if 'TSL770' in t or ('SANTEC' in t and '770' in t):
        return 'TSL770'
    return None


def _parse_resource(resource: str) -> str:
    txt = str(resource or '').strip()
    if txt.upper().startswith('FTDI::'):
        txt = txt.split('::', 1)[1].strip()
    if not txt:
        raise RuntimeError('Missing FTDI resource/serial')
    return txt


def _import_ftd2xx():
    try:
        import ftd2xx  # type: ignore
        return ftd2xx, None
    except Exception as exc:
        return None, str(exc)


def _normalize_devices(raw) -> List[str]:
    if raw is None:
        return []
    if isinstance(raw, (bytes, bytearray)):
        return [raw.decode('ascii', errors='ignore').strip()]
    out = []
    if isinstance(raw, (list, tuple)):
        for item in raw:
            if isinstance(item, (bytes, bytearray)):
                s = item.decode('ascii', errors='ignore').strip()
            else:
                s = str(item).strip()
            if s:
                out.append(s)
    else:
        s = str(raw).strip()
        if s:
            out.append(s)
    return out


def _set_data_characteristics(dev, ftd2xx) -> None:
    defs = getattr(ftd2xx, 'defines', None)
    if defs is None:
        return
    try:
        dev.setDataCharacteristics(defs.BITS_8, defs.STOP_BITS_1, defs.PARITY_NONE)
    except Exception:
        pass


def _set_flow_control(dev, ftd2xx) -> None:
    defs = getattr(ftd2xx, 'defines', None)
    if defs is None:
        return
    try:
        dev.setFlowControl(defs.FLOW_NONE, 0, 0)
    except Exception:
        pass


def _open_dev(ftd2xx, serial_txt: str, baud: int, timeout_ms: int):
    defs = getattr(ftd2xx, 'defines', None)
    serial_b = serial_txt.encode('ascii', errors='ignore')
    if defs is not None and hasattr(defs, 'OPEN_BY_SERIAL_NUMBER'):
        dev = ftd2xx.openEx(serial_b, defs.OPEN_BY_SERIAL_NUMBER)
    else:
        dev = ftd2xx.openEx(serial_b, 1)
    try:
        try:
            dev.resetDevice()
        except Exception:
            pass
        try:
            dev.purge()
        except Exception:
            pass
        dev.setTimeouts(int(timeout_ms), int(timeout_ms))
        dev.setBaudRate(int(baud))
        _set_data_characteristics(dev, ftd2xx)
        _set_flow_control(dev, ftd2xx)
        return dev
    except Exception:
        try:
            dev.close()
        except Exception:
            pass
        raise


def _read_available(dev) -> bytes:
    try:
        q = int(dev.getQueueStatus())
    except Exception:
        q = 0
    if q <= 0:
        return b''
    try:
        return bytes(dev.read(q))
    except Exception:
        return b''


def _query(dev, cmd: str, timeout_ms: int = 1800) -> str:
    line = str(cmd).strip()
    if not line:
        raise RuntimeError('Empty command')
    if not line.endswith('\n'):
        line += '\n'

    try:
        dev.purge()
    except Exception:
        pass

    dev.write(line.encode('ascii', errors='ignore'))

    deadline = time.time() + max(0.2, timeout_ms / 1000.0)
    rx = bytearray()
    while time.time() < deadline:
        chunk = _read_available(dev)
        if chunk:
            rx.extend(chunk)
            if b'\n' in chunk or b'\r' in chunk:
                break
        time.sleep(0.02)

    txt = bytes(rx).decode('ascii', errors='ignore').replace('\r', '\n')
    lines = [ln.strip() for ln in txt.split('\n') if ln.strip()]
    return lines[-1] if lines else ''


def _write(dev, cmd: str) -> None:
    line = str(cmd).strip()
    if not line:
        raise RuntimeError('Empty command')
    if not line.endswith('\n'):
        line += '\n'
    dev.write(line.encode('ascii', errors='ignore'))


def _parse_sweep_state(raw: str) -> Tuple[bool, Optional[bool]]:
    txt = str(raw or '').strip()
    if not txt:
        return False, None
    upper = txt.upper()
    try:
        num = float(txt)
        return True, num > 0
    except Exception:
        pass
    if any(k in upper for k in ['STOP', 'OFF', 'IDLE', 'READY']):
        return True, False
    if any(k in upper for k in ['RUN', 'SWEEP', 'BUSY', 'PAUS']):
        return True, True
    return False, None


def _scan_one_serial(ftd2xx, serial_txt: str) -> Dict[str, Any]:
    baud_candidates = [9600, 19200, 38400, 57600, 115200]
    cmd_candidates = ['*IDN?', 'IDN?']
    last_err = None
    for baud in baud_candidates:
        dev = None
        try:
            dev = _open_dev(ftd2xx, serial_txt, baud, 1800)
            for cmd in cmd_candidates:
                reply = _query(dev, cmd, 1800)
                if reply:
                    model = _detect_model(reply)
                    if model or 'SANTEC' in reply.upper() or 'TSL' in reply.upper():
                        return {
                            'resource': f'FTDI::{serial_txt}',
                            'idn': reply,
                            'model': model,
                            'backend': 'ftdi-d2xx',
                            'baud': baud,
                        }
            # no usable IDN at this baud
        except Exception as exc:
            last_err = str(exc)
        finally:
            if dev is not None:
                try:
                    dev.close()
                except Exception:
                    pass
    return {
        'resource': f'FTDI::{serial_txt}',
        'idn': None,
        'model': None,
        'backend': 'ftdi-d2xx',
        'error': last_err,
    }


def action_health(_payload: Dict[str, Any]) -> Dict[str, Any]:
    ftd2xx, err = _import_ftd2xx()
    out = {
        'backend': 'ftdi-d2xx',
        'driver_ok': ftd2xx is not None,
        'module': 'ftd2xx',
        'error': err,
        'devices': [],
    }
    if ftd2xx is None:
        return out
    try:
        out['devices'] = _normalize_devices(ftd2xx.listDevices())
    except Exception as exc:
        out['error'] = str(exc)
    return out


def action_scan(_payload: Dict[str, Any]) -> Dict[str, Any]:
    ftd2xx, err = _import_ftd2xx()
    if ftd2xx is None:
        return {
            'rows': [],
            'warnings': [f'FTDI D2XX/pyftd2xx unavailable: {err}'],
            'backend': 'ftdi-d2xx',
        }
    try:
        serials = _normalize_devices(ftd2xx.listDevices())
    except Exception as exc:
        return {
            'rows': [],
            'warnings': [f'FTDI listDevices failed: {exc}'],
            'backend': 'ftdi-d2xx',
        }

    rows = [_scan_one_serial(ftd2xx, s) for s in serials]
    return {
        'rows': rows,
        'warnings': [],
        'backend': 'ftdi-d2xx',
    }


def action_query(payload: Dict[str, Any]) -> Dict[str, Any]:
    ftd2xx, err = _import_ftd2xx()
    if ftd2xx is None:
        raise RuntimeError(f'FTDI D2XX/pyftd2xx unavailable: {err}')
    serial_txt = _parse_resource(str(payload.get('resource') or ''))
    cmd = str(payload.get('cmd') or payload.get('command') or '').strip()
    if not cmd:
        raise RuntimeError('Empty command')
    baud = int(payload.get('baud') or 115200)
    timeout_ms = int(payload.get('timeout_ms') or 2500)

    dev = _open_dev(ftd2xx, serial_txt, baud, timeout_ms)
    try:
        reply = _query(dev, cmd, timeout_ms)
    finally:
        try:
            dev.close()
        except Exception:
            pass

    return {
        'resource': f'FTDI::{serial_txt}',
        'command': cmd,
        'reply': reply,
        'model': _detect_model(reply) if cmd.upper() in ('*IDN?', 'IDN?') else None,
        'backend': 'ftdi-d2xx',
    }


def _configure_for_sweep(dev, start_nm: float, stop_nm: float, power_mw: float, speed_nm_s: float) -> None:
    cmds = [
        '*RST',
        ':POW:ATT:AUT 1',
        ':POW:UNIT 1',
        ':TRIG:INP:EXT0',
        ':WAV:SWE:CYCL 1',
        ':TRIG:OUTP2',
        ':POW 20.0',
        f':POW {power_mw:g}',
        ':WAV:UNIT 0',
        f':WAV:SWE:SPE {speed_nm_s:g}',
        f':WAV {start_nm:g}',
        f':WAV:SWE:STAR {start_nm:g}',
        f':WAV:SWE:STOP {stop_nm:g}',
        ':WAV:SWE:MOD 1',
        ':WAV:SWE:DWEL 0',
    ]
    for c in cmds:
        _write(dev, c)
        time.sleep(0.03)
def _wait_sweep_complete(dev, timeout_ms: int, poll_interval_ms: int) -> Dict[str, Any]:
    queries = [':WAV:SWE?', 'WAV:SWE?', ':WAV:SWE:STAT?', 'WAV:SWE:STAT?']
    deadline = time.time() + max(0.3, timeout_ms / 1000.0)
    last = {'known': False, 'running': None, 'raw': None, 'command': None}
    while time.time() < deadline:
        for q in queries:
            try:
                raw = _query(dev, q, 1500)
                known, running = _parse_sweep_state(raw)
                if known:
                    last = {'known': True, 'running': running, 'raw': raw, 'command': q}
                    if running is False:
                        return {'complete': True, **last}
                    break
            except Exception:
                continue
        time.sleep(max(0.05, poll_interval_ms / 1000.0))
    return {'complete': False, **last}


def action_sweep(payload: Dict[str, Any]) -> Dict[str, Any]:
    ftd2xx, err = _import_ftd2xx()
    if ftd2xx is None:
        raise RuntimeError(f'FTDI D2XX/pyftd2xx unavailable: {err}')

    serial_txt = _parse_resource(str(payload.get('resource') or ''))
    start_nm = float(payload.get('start_nm'))
    stop_nm = float(payload.get('stop_nm'))
    power_mw = float(payload.get('power_mw'))
    speed_nm_s = float(payload.get('speed_nm_s'))
    timeout_ms = int(payload.get('timeout_ms') or 10000)
    poll_interval_ms = int(payload.get('poll_interval_ms') or 250)
    acquisition_wait_s = float(payload.get('acquisition_wait_s') or 0.0)
    baud = int(payload.get('baud') or 115200)

    dev = _open_dev(ftd2xx, serial_txt, baud, 3000)
    try:
        idn = _query(dev, '*IDN?', 2000)
        model = _detect_model(idn)
        _configure_for_sweep(dev, start_nm, stop_nm, power_mw, speed_nm_s)
        _write(dev, 'WAV:SWE 1')
        wait_s = max(0.0, acquisition_wait_s)
        if wait_s > 0:
            time.sleep(wait_s)
        state = _wait_sweep_complete(dev, timeout_ms, poll_interval_ms)
        return {
            'resource': f'FTDI::{serial_txt}',
            'idn': idn,
            'model': model,
            'backend': 'ftdi-d2xx',
            'sweep_state': state,
        }
    finally:
        try:
            dev.close()
        except Exception:
            pass


def action_set_wavelength(payload: Dict[str, Any]) -> Dict[str, Any]:
    ftd2xx, err = _import_ftd2xx()
    if ftd2xx is None:
        raise RuntimeError(f'FTDI D2XX/pyftd2xx unavailable: {err}')
    serial_txt = _parse_resource(str(payload.get('resource') or ''))
    wl = float(payload.get('wavelength_nm'))
    baud = int(payload.get('baud') or 115200)
    dev = _open_dev(ftd2xx, serial_txt, baud, 2500)
    try:
        _write(dev, ':WAV:UNIT 0')
        _write(dev, f':WAV {wl:g}')
        time.sleep(0.05)
        rb = ''
        try:
            rb = _query(dev, ':WAV?', 2000)
        except Exception:
            rb = ''
        return {
            'resource': f'FTDI::{serial_txt}',
            'backend': 'ftdi-d2xx',
            'readback': rb,
        }
    finally:
        try:
            dev.close()
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['health', 'scan', 'query', 'sweep', 'set_wavelength'])
    parser.add_argument('--payload-b64', default='')
    args = parser.parse_args()

    payload = _decode_payload(args.payload_b64)

    try:
        if args.action == 'health':
            out = action_health(payload)
        elif args.action == 'scan':
            out = action_scan(payload)
        elif args.action == 'query':
            out = action_query(payload)
        elif args.action == 'sweep':
            out = action_sweep(payload)
        elif args.action == 'set_wavelength':
            out = action_set_wavelength(payload)
        else:
            raise RuntimeError('Unknown action')
        _out({'ok': True, **out}, 0)
    except Exception as exc:
        _out({'ok': False, 'error': str(exc)}, 1)


if __name__ == '__main__':
    main()
