"""Multi-vendor tunable-laser layer for the coreConsole backend.

One scheme for every laser (existing Santec TSLs and new vendors alike):

    transport (how bytes move)  x  driver (what commands mean)

Transports are synchronous/blocking (used via ``asyncio.to_thread`` like every
other device call in the backend). Resource strings are URIs:

    tcp://192.168.1.50:5025      raw SCPI socket (Keysight N777-C etc.) - no VISA
    visa://GPIB0::10::INSTR      pyvisa (needs NI-VISA + 488.2 on the host)
    ftdi://SANTEC:<serial>       Santec FTDI-direct USB (pyftdi, VISA-free)
    serial:///dev/tty.usbserial  RS-232 (EXFO T100S-HP dialect framing)
    SIM::LASER<n>::INSTR         simulator row (handled by the backend, not here)

Command facts are cited from vendor programming guides (see the plan's research
table): Keysight N777-C sweep SCPI + STFinished per-step triggers + lambda
logging were verified against the N7770-90C02 programming guide; the EXFO
T100S-HP MNEMONIC=VALUE dialect against T100SHP_PG_6.07v1.0. The EXFO
T200S/T500S command set is NOT publicly verified - that driver refuses to run
rather than guessing commands.
"""
from __future__ import annotations

import re
import socket
import struct
import time
from typing import Any, Callable, Optional

import numpy as np


class LaserError(Exception):
    """Raised for any laser transport/driver failure (user-facing message)."""


# ---------------------------------------------------------------------------
# Transports
# ---------------------------------------------------------------------------

class LaserTransport:
    """write/query seam. Implementations add framing per physical link."""

    def write(self, cmd: str) -> None:
        raise NotImplementedError

    def query(self, cmd: str) -> str:
        raise NotImplementedError

    def read_raw(self, n_bytes: int) -> bytes:
        """Read exactly n bytes (binary block payloads). Optional."""
        raise LaserError("Binary read not supported on this transport")

    def close(self) -> None:
        pass


class TcpScpiTransport(LaserTransport):
    """Raw SCPI-over-TCP (port 5025 convention). Newline framing, no VISA."""

    def __init__(self, host: str, port: int = 5025, timeout_s: float = 5.0) -> None:
        try:
            self._sock = socket.create_connection((host, port), timeout=timeout_s)
        except OSError as err:
            raise LaserError(f"Cannot connect to {host}:{port} ({err})") from err
        self._sock.settimeout(timeout_s)
        self._sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._rxbuf = b""

    def write(self, cmd: str) -> None:
        try:
            self._sock.sendall(cmd.encode("ascii") + b"\n")
        except OSError as err:
            raise LaserError(f"Laser socket write failed ({err})") from err

    def _read_line(self) -> bytes:
        while b"\n" not in self._rxbuf:
            try:
                chunk = self._sock.recv(4096)
            except socket.timeout as err:
                raise LaserError("Laser reply timed out") from err
            except OSError as err:
                raise LaserError(f"Laser socket read failed ({err})") from err
            if not chunk:
                raise LaserError("Laser closed the connection")
            self._rxbuf += chunk
        line, self._rxbuf = self._rxbuf.split(b"\n", 1)
        return line

    def query(self, cmd: str) -> str:
        self.write(cmd)
        return self._read_line().decode("ascii", "replace").strip()

    def read_raw(self, n_bytes: int) -> bytes:
        out = self._rxbuf
        self._rxbuf = b""
        while len(out) < n_bytes:
            try:
                chunk = self._sock.recv(min(65536, n_bytes - len(out)))
            except socket.timeout as err:
                raise LaserError("Laser binary read timed out") from err
            if not chunk:
                raise LaserError("Laser closed the connection mid-block")
            out += chunk
        self._rxbuf = out[n_bytes:]
        return out[:n_bytes]

    def close(self) -> None:
        try:
            self._sock.close()
        except OSError:
            pass


class VisaTransport(LaserTransport):
    """pyvisa-backed transport (GPIB). Lazy import; actionable error if the
    VISA runtime is missing."""

    def __init__(self, resource: str, timeout_ms: int = 5000) -> None:
        try:
            import pyvisa
        except ImportError as err:
            raise LaserError("pyvisa is not installed in the backend") from err
        try:
            rm = pyvisa.ResourceManager()
            self._inst = rm.open_resource(resource)
        except Exception as err:
            raise LaserError(
                f"Cannot open VISA resource {resource}: {err}. "
                "Install NI-VISA (and NI-488.2 for GPIB), then retry.") from err
        self._inst.timeout = timeout_ms
        self._inst.write_termination = "\n"
        self._inst.read_termination = "\n"

    def write(self, cmd: str) -> None:
        try:
            self._inst.write(cmd)
        except Exception as err:
            raise LaserError(f"VISA write failed: {err}") from err

    def query(self, cmd: str) -> str:
        try:
            return str(self._inst.query(cmd)).strip()
        except Exception as err:
            raise LaserError(f"VISA query failed: {err}") from err

    def read_raw(self, n_bytes: int) -> bytes:
        try:
            return bytes(self._inst.read_bytes(n_bytes))
        except Exception as err:
            raise LaserError(f"VISA binary read failed: {err}") from err

    def close(self) -> None:
        try:
            self._inst.close()
        except Exception:
            pass


def _strip_ctl(raw: bytes) -> str:
    """Mirror of the old JS normalizeLaserResponse: drop control bytes/nulls."""
    return raw.replace(b"\x00", b"").decode("ascii", "replace").strip("\r\n\x11\x13 \t")


class FtdiTransport(LaserTransport):
    """Santec FTDI-direct USB (replaces the old D2XX node addon).

    Framing from the proven addon: 9600 baud 8N1, commands terminated with CR,
    replies CR-terminated with stray control bytes stripped.
    """

    def __init__(self, serial_number: str, timeout_s: float = 2.0) -> None:
        try:
            from pyftdi.serialext import serial_for_url
        except ImportError as err:
            raise LaserError("pyftdi is not installed in the backend") from err
        url = f"ftdi://::{serial_number}/1"
        try:
            self._port = serial_for_url(url, baudrate=9600, timeout=timeout_s)
        except Exception as err:
            raise LaserError(
                f"Cannot open Santec FTDI device {serial_number!r}: {err}") from err

    def write(self, cmd: str) -> None:
        try:
            self._port.write(cmd.encode("ascii") + b"\r")
        except Exception as err:
            raise LaserError(f"FTDI write failed: {err}") from err

    def query(self, cmd: str) -> str:
        self.write(cmd)
        try:
            raw = self._port.read_until(b"\r")
        except Exception as err:
            raise LaserError(f"FTDI read failed: {err}") from err
        if not raw:
            raise LaserError("Laser reply timed out (FTDI)")
        return _strip_ctl(raw)

    def close(self) -> None:
        try:
            self._port.close()
        except Exception:
            pass

    @staticmethod
    def list_devices() -> list[str]:
        """Serial numbers of connected FTDI devices (best effort)."""
        try:
            from pyftdi.usbtools import UsbTools
            devs = UsbTools.find_all([(0x0403, 0x6001), (0x0403, 0x6010), (0x0403, 0x6014)])
            return [d[0].sn for d in devs if d[0].sn]
        except Exception:
            return []


class SerialCmdTransport(LaserTransport):
    """RS-232 for the EXFO T100S-HP dialect: 9600 8N1, CR terminator; every
    command answers ``OK`` (or ``...ERROR``), responses end CR '>' space."""

    def __init__(self, port: str, timeout_s: float = 2.0) -> None:
        try:
            import serial
        except ImportError as err:
            raise LaserError("pyserial is not installed") from err
        try:
            self._port = serial.Serial(port, baudrate=9600, bytesize=8,
                                       parity="N", stopbits=1, timeout=timeout_s)
        except Exception as err:
            raise LaserError(f"Cannot open serial port {port}: {err}") from err

    def _read_reply(self) -> str:
        # Replies terminate with CR '>' ' '; read until '>' then strip.
        raw = b""
        deadline = time.monotonic() + (self._port.timeout or 2.0)
        while b">" not in raw and time.monotonic() < deadline:
            chunk = self._port.read(1)
            if chunk:
                raw += chunk
        return _strip_ctl(raw.replace(b">", b""))

    def write(self, cmd: str) -> None:
        try:
            self._port.write(cmd.encode("ascii") + b"\r")
        except Exception as err:
            raise LaserError(f"Serial write failed: {err}") from err
        reply = self._read_reply()
        if "ERROR" in reply.upper():
            raise LaserError(f"Laser rejected {cmd!r}: {reply}")

    def query(self, cmd: str) -> str:
        try:
            self._port.write(cmd.encode("ascii") + b"\r")
        except Exception as err:
            raise LaserError(f"Serial write failed: {err}") from err
        reply = self._read_reply()
        if not reply:
            raise LaserError("Laser reply timed out (serial)")
        return reply

    def close(self) -> None:
        try:
            self._port.close()
        except Exception:
            pass


class MockTransport(LaserTransport):
    """Test transport: replays a response table and records every command."""

    def __init__(self, responses: Optional[dict[str, str]] = None,
                 default: str = "", binary: bytes = b"") -> None:
        self.sent: list[str] = []
        self.responses = responses or {}
        self.default = default
        self.binary = binary

    def write(self, cmd: str) -> None:
        self.sent.append(cmd)

    def query(self, cmd: str) -> str:
        self.sent.append(cmd)
        for pattern, reply in self.responses.items():
            if re.fullmatch(pattern, cmd, re.IGNORECASE):
                return reply
        return self.default

    def read_raw(self, n_bytes: int) -> bytes:
        out, self.binary = self.binary[:n_bytes], self.binary[n_bytes:]
        return out


# ---------------------------------------------------------------------------
# Resource URIs
# ---------------------------------------------------------------------------

def open_transport(resource: str, timeout_s: float = 5.0) -> LaserTransport:
    """Open a transport from a resource URI (see module docstring)."""
    r = str(resource or "").strip()
    if r.startswith("tcp://"):
        rest = r[len("tcp://"):]
        host, _, port_s = rest.partition(":")
        if not host:
            raise LaserError(f"Bad tcp resource: {resource!r}")
        return TcpScpiTransport(host, int(port_s) if port_s else 5025, timeout_s)
    if r.startswith("visa://"):
        return VisaTransport(r[len("visa://"):])
    # Legacy bare VISA strings (GPIB0::10::INSTR) from live VISA scans.
    if "::" in r and not r.upper().startswith("SIM::"):
        return VisaTransport(r)
    if r.startswith("ftdi://SANTEC:") or r.startswith("FTDI:SANTEC:"):
        sn = r.split("SANTEC:", 1)[1].strip("/")
        return FtdiTransport(sn)
    if r.startswith("serial://"):
        return SerialCmdTransport(r[len("serial://"):])
    raise LaserError(f"Unrecognized laser resource: {resource!r}")


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------

class Capabilities(dict):
    """Plain dict with attribute sugar; serialized into probe/scan replies."""

    def __getattr__(self, k: str) -> Any:
        try:
            return self[k]
        except KeyError:
            return None


def _fmt(v: float) -> str:
    """Match laser-js formatNumber: exponential for extreme magnitudes."""
    a = abs(v)
    if v != 0 and (a >= 1e6 or a < 1e-3):
        s = f"{v:.6e}"
        mant, _, exp = s.partition("e")
        mant = mant.rstrip("0").rstrip(".")
        return f"{mant}e{int(exp)}"
    return f"{v:.6f}".rstrip("0").rstrip(".") or "0"


class TunableLaser:
    """Vendor-neutral driver interface. All methods blocking."""

    model = "UNKNOWN"
    vendor = "UNKNOWN"

    def __init__(self, transport: LaserTransport, idn: str = "") -> None:
        self.t = transport
        self.idn = idn

    @property
    def capabilities(self) -> Capabilities:
        return Capabilities(continuous_sweep=False, stepped_sweep=False,
                            trigger_out=False, lambda_log=False,
                            max_speed_nm_s=None, wl_range_nm=None,
                            sweep=False)

    # -- basic control ------------------------------------------------------
    def set_wavelength_nm(self, nm: float) -> None:
        raise NotImplementedError

    def set_power_mw(self, mw: float) -> None:
        raise NotImplementedError

    def park(self, nm: float) -> None:
        """Post-sweep: return the laser to its resting wavelength."""
        self.set_wavelength_nm(nm)

    # -- sweeping -----------------------------------------------------------
    def configure_sweep(self, start_nm: float, stop_nm: float,
                        speed_nm_s: float, power_mw: float, *,
                        stepped: bool = False, step_pm: float = 0.0) -> None:
        raise LaserError(f"{self.model} does not support sweeps")

    def start_sweep(self) -> None:
        raise LaserError(f"{self.model} does not support sweeps")

    def stop_sweep(self) -> None:
        pass

    def read_lambda_log(self) -> Optional[np.ndarray]:
        return None

    def close(self) -> None:
        self.t.close()


class SantecTSL(TunableLaser):
    """TSL550/570/770 — direct port of laser-js (command order preserved)."""

    vendor = "Santec"

    def __init__(self, transport: LaserTransport, idn: str, model: str) -> None:
        super().__init__(transport, idn)
        self.model = model  # TSL550 | TSL570 | TSL770
        self._metres = model == "TSL770"

    @property
    def capabilities(self) -> Capabilities:
        return Capabilities(continuous_sweep=True, stepped_sweep=False,
                            trigger_out=True, lambda_log=False,
                            max_speed_nm_s=200 if self.model == "TSL770" else 100,
                            wl_range_nm=None, sweep=True)

    def _wl(self, nm: float) -> str:
        return _fmt(nm * 1e-9) if self._metres else _fmt(nm)

    def set_wavelength_nm(self, nm: float) -> None:
        self.t.write(f":WAV:UNIT {1 if self._metres else 0}")
        self.t.write(f":WAV {self._wl(nm)}")

    def set_power_mw(self, mw: float) -> None:
        self.t.write(":POW:UNIT 1")
        self.t.write(f":POW {_fmt(mw)}")

    def configure_sweep(self, start_nm: float, stop_nm: float,
                        speed_nm_s: float, power_mw: float, *,
                        stepped: bool = False, step_pm: float = 0.0) -> None:
        if stepped:
            raise LaserError(f"{self.model}: stepped sweep not supported")
        w = self.t.write
        # Exact laser-js configureForSweep sequence (proven on the bench).
        w("*RST")
        w(":POW:ATT:AUT 1")
        w(":POW:UNIT 1")
        w(":TRIG:INP:EXT0")
        w(":WAV:SWE:CYCL 1")
        w(":TRIG:OUTP2")            # sweep-start pulse -> coreDAQ BNC
        w(":POW 20.0")
        w(f":POW {_fmt(power_mw)}")
        speed = speed_nm_s * 1e-9 if self._metres else speed_nm_s
        w(f":WAV:UNIT {1 if self._metres else 0}")
        w(f":WAV:SWE:SPE {_fmt(speed)}")
        w(f":WAV {self._wl(start_nm)}")
        w(f":WAV:SWE:STAR {self._wl(start_nm)}")
        w(f":WAV:SWE:STOP {self._wl(stop_nm)}")
        w(":WAV:SWE:MOD 1")
        w(":WAV:SWE:DWEL 0")

    def start_sweep(self) -> None:
        self.t.write("WAV:SWE 1")

    def stop_sweep(self) -> None:
        self.t.write("WAV:SWE 0")


class KeysightN777(TunableLaser):
    """N7776C/N7778C/N7779C swept TLS + N7711A/N7714A set-and-hold sources.

    SCPI verified against the N7770-90C02 programming guide; sweep source is
    index 0 (``sour0``), triggers via ``trig0:outp``.
    """

    vendor = "Keysight"

    SWEPT_MODELS = ("N7776C", "N7778C", "N7779C")
    SET_ONLY_MODELS = ("N7711A", "N7714A")

    def __init__(self, transport: LaserTransport, idn: str, model: str) -> None:
        super().__init__(transport, idn)
        self.model = model
        self._stepped_only = model == "N7779C"
        self._set_only = model in self.SET_ONLY_MODELS
        self._llog_armed = False
        self._n_steps = 0

    @property
    def capabilities(self) -> Capabilities:
        if self._set_only:
            return Capabilities(continuous_sweep=False, stepped_sweep=False,
                                trigger_out=False, lambda_log=False,
                                max_speed_nm_s=None, wl_range_nm=None, sweep=False)
        return Capabilities(
            continuous_sweep=not self._stepped_only,
            stepped_sweep=True,
            trigger_out=True,
            lambda_log=True,
            max_speed_nm_s=200,
            wl_range_nm=None,
            sweep=True,
        )

    def set_wavelength_nm(self, nm: float) -> None:
        self.t.write(f":SOUR0:WAV {_fmt(nm)}NM")

    def set_power_mw(self, mw: float) -> None:
        self.t.write(":SOUR0:POW:UNIT W")
        self.t.write(f":SOUR0:POW {_fmt(mw)}MW")

    def configure_sweep(self, start_nm: float, stop_nm: float,
                        speed_nm_s: float, power_mw: float, *,
                        stepped: bool = False, step_pm: float = 0.0) -> None:
        if self._set_only:
            raise LaserError(f"{self.model} is a set-and-hold source (no sweep engine)")
        if start_nm >= stop_nm:
            # LLOG sweeps require ascending wavelength (verified constraint).
            raise LaserError("Keysight sweeps require start < stop wavelength")
        w = self.t.write
        w("*CLS")
        self.set_power_mw(power_mw)
        w(":SOUR0:AM:STAT OFF")                       # LLOG prerequisite
        w(f":SOUR0:WAV:SWE:STAR {_fmt(start_nm)}NM")
        w(f":SOUR0:WAV:SWE:STOP {_fmt(stop_nm)}NM")
        w(":SOUR0:WAV:SWE:CYCL 1")
        if stepped or self._stepped_only:
            if step_pm <= 0:
                raise LaserError("Stepped sweep needs a step size (pm)")
            w(":SOUR0:WAV:SWE:MODE STEP")
            w(f":SOUR0:WAV:SWE:STEP {_fmt(step_pm / 1000.0)}NM")
            w(f":SOUR0:WAV:SWE:DWEL {_fmt(0.1)}S")
        else:
            w(":SOUR0:WAV:SWE:MODE CONT")
            w(f":SOUR0:WAV:SWE:SPE {_fmt(speed_nm_s)}nm/s")
            if step_pm > 0:
                # In CONTINUOUS mode STFinished triggers fire at equal
                # wavelength intervals given by :STEP (verified behavior) —
                # this is what clocks the coreDAQ's stepped capture.
                w(f":SOUR0:WAV:SWE:STEP {_fmt(step_pm / 1000.0)}NM")
        if step_pm > 0:
            w(":TRIG0:OUTP STF")                      # per-step trigger out
            w(":SOUR0:WAV:SWE:LLOG 1")
            self._llog_armed = True
            span_pm = (stop_nm - start_nm) * 1000.0
            self._n_steps = int(round(span_pm / step_pm)) + 1
        else:
            w(":TRIG0:OUTP SWST")                     # sweep-start trigger out
            w(":SOUR0:WAV:SWE:LLOG 0")
            self._llog_armed = False

    def start_sweep(self) -> None:
        self.t.write(":SOUR0:WAV:SWE STAR")

    def stop_sweep(self) -> None:
        self.t.write(":SOUR0:WAV:SWE STOP")

    def sweep_done(self) -> bool:
        # Guide: :SOUR0:WAV:SWE? returns the sweep state (0 = stopped).
        try:
            return self.t.query(":SOUR0:WAV:SWE?").strip().startswith("0")
        except LaserError:
            return False

    def read_lambda_log(self) -> Optional[np.ndarray]:
        """Read :SOUR0:READ:DATA? LLOG — SCPI definite-length binary block of
        8-byte little-endian doubles (metres) -> wavelengths in nm."""
        if not self._llog_armed:
            return None
        self.t.write(":SOUR0:READ:DATA? LLOG")
        head = self.t.read_raw(2)
        if not head.startswith(b"#"):
            raise LaserError(f"Bad LLOG block header: {head!r}")
        n_digits = int(head[1:2])
        n_bytes = int(self.t.read_raw(n_digits).decode("ascii"))
        payload = self.t.read_raw(n_bytes)
        try:
            self.t.read_raw(1)  # trailing newline
        except LaserError:
            pass
        wl_m = np.frombuffer(payload, dtype="<f8")
        return wl_m * 1e9


class ExfoT100S(TunableLaser):
    """EXFO T100S-HP — proprietary MNEMONIC=VALUE dialect (not SCPI).

    Wavelength/power set-and-settle only; sweeps run host-stepped (Engine C).
    """

    vendor = "EXFO"
    model = "T100S-HP"

    @property
    def capabilities(self) -> Capabilities:
        return Capabilities(continuous_sweep=False, stepped_sweep=False,
                            trigger_out=False, lambda_log=False,
                            max_speed_nm_s=None, wl_range_nm=(1500.0, 1630.0),
                            sweep=True, host_stepped=True)

    def enable_output(self) -> None:
        self.t.write("ENABLE")

    def set_wavelength_nm(self, nm: float) -> None:
        self.t.write(f"L={nm:.3f}")

    def get_wavelength_nm(self) -> float:
        reply = self.t.query("L?")           # e.g. "L=1550.000"
        m = re.search(r"([0-9]+\.?[0-9]*)", reply)
        if not m:
            raise LaserError(f"Unparseable wavelength reply: {reply!r}")
        return float(m.group(1))

    def set_power_mw(self, mw: float) -> None:
        self.t.write("MW")                   # power unit = mW
        self.t.write(f"P={mw:.2f}")


class ExfoT200S(TunableLaser):
    """EXFO T200S/T500S — placeholder. The programming guide is not publicly
    verifiable; refusing beats guessing commands at a live laser."""

    vendor = "EXFO"

    def __init__(self, transport: LaserTransport, idn: str, model: str) -> None:
        super().__init__(transport, idn)
        self.model = model

    @property
    def capabilities(self) -> Capabilities:
        return Capabilities(continuous_sweep=False, stepped_sweep=False,
                            trigger_out=False, lambda_log=False,
                            max_speed_nm_s=None, wl_range_nm=None,
                            sweep=False, unverified=True)

    def set_wavelength_nm(self, nm: float) -> None:
        raise LaserError(
            "EXFO T200S/T500S command set is not yet verified — provide the "
            "programming guide (or connect the unit for interactive bring-up).")


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

def detect_laser(idn: str) -> Optional[tuple[str, str, Callable[..., TunableLaser]]]:
    """IDN string -> (vendor, model, driver factory) or None."""
    txt = str(idn or "").upper()

    for m in ("TSL550", "TSL570", "TSL770"):
        if m in txt.replace("-", "") or (("SANTEC" in txt) and m[-3:] in txt):
            return ("Santec", m, lambda t, i, _m=m: SantecTSL(t, i, _m))

    for m in KeysightN777.SWEPT_MODELS + KeysightN777.SET_ONLY_MODELS:
        if m in txt:
            return ("Keysight", m, lambda t, i, _m=m: KeysightN777(t, i, _m))

    if "T100S" in txt or "TUNICS" in txt:
        return ("EXFO", "T100S-HP", lambda t, i: ExfoT100S(t, i))
    for m in ("T200S", "T500S"):
        if m in txt:
            return ("EXFO", m, lambda t, i, _m=m: ExfoT200S(t, i, _m))

    return None


def probe_resource(resource: str, timeout_s: float = 5.0) -> dict:
    """Open a resource, identify the laser, return a registry row. Closes the
    transport before returning."""
    t = open_transport(resource, timeout_s)
    try:
        idn = ""
        try:
            idn = t.query("*IDN?")
        except LaserError:
            pass
        if not idn or "ERROR" in idn.upper():
            # EXFO T100S dialect fallback: a parseable L? reply identifies it.
            try:
                reply = t.query("L?")
                if re.search(r"L\s*=?\s*[0-9]", reply, re.IGNORECASE):
                    idn = "EXFO,T100S-HP (dialect-detected)"
            except LaserError:
                pass
        if not idn:
            raise LaserError("No response to *IDN? (or L?) on this resource")
        found = detect_laser(idn)
        if not found:
            raise LaserError(f"Unrecognized laser IDN: {idn!r}")
        vendor, model, factory = found
        caps = factory(t, idn).capabilities
        return {
            "resource": resource,
            "idn": idn,
            "model": model,
            "vendor": vendor,
            "backend": resource.split(":", 1)[0],
            "capabilities": dict(caps),
        }
    finally:
        t.close()


def open_laser(resource: str, timeout_s: float = 5.0) -> TunableLaser:
    """Open a transport, identify and return a ready driver (caller closes)."""
    t = open_transport(resource, timeout_s)
    try:
        idn = ""
        try:
            idn = t.query("*IDN?")
        except LaserError:
            pass
        if not idn:
            try:
                reply = t.query("L?")
                if re.search(r"L\s*=?\s*[0-9]", reply, re.IGNORECASE):
                    idn = "EXFO,T100S-HP (dialect-detected)"
            except LaserError:
                pass
        found = detect_laser(idn)
        if not found:
            t.close()
            raise LaserError(f"Unrecognized laser on {resource}: IDN={idn!r}")
        _, _, factory = found
        return factory(t, idn)
    except LaserError:
        raise
    except Exception:
        t.close()
        raise
