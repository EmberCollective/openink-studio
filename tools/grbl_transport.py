"""Conservative GRBL transport. ACK means accepted; wait_idle means finished.

No reset, unlock, origin change or pen command is implicit. Opening a physical
port asserts RTS/DTR as required by this machine; adapters may react to that.
Only one caller may use an instance at a time. By default *_mm coordinates
require read_settings() first and follow $13. report_units='mm' or 'inch'
explicitly overrides that conversion; raw reports and the override are logged.
2026-10-25 command/report observation (docs/evidence/machine-2026-10-25/z-probe-baseline.jsonl): this
machine reports a raw Z delta of 4.000 for G21 G91 Z4 despite $13=1. Its
executor therefore selects 'mm'; this is not a physical-distance measurement.
"""
from dataclasses import dataclass
import json
import math
from pathlib import Path
import re
import time


class GrblError(RuntimeError):
    pass


@dataclass(frozen=True)
class Status:
    state: str
    raw: str
    fields: dict
    mpos_mm: tuple | None
    wpos_mm: tuple | None
    wco_mm: tuple | None


class GrblTransport:
    def __init__(self, port=None, baud=115200, log_path=None, serial_instance=None,
                 report_units='settings'):
        if report_units not in ('settings', 'mm', 'inch'):
            raise ValueError("report_units must be 'settings', 'mm', or 'inch'")
        self.report_units = report_units
        self.failed = False
        self.report_inches = None
        self._wco_raw = None
        self._rx = bytearray()
        self._started = False
        self._log_file = None
        if log_path is not None:
            path = Path(log_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            self._log_file = path.open('a', encoding='utf-8')
        try:
            if serial_instance is None:
                import serial
                self.sp = serial.Serial(port=None, baudrate=baud, timeout=0.05,
                                        write_timeout=2)
                self.sp.dtr = True
                self.sp.rts = True
                self.sp.port = port
                self.sp.open()
            else:
                self.sp = serial_instance
            self._log('open', {'port': port, 'baud': baud, 'report_units': report_units})
        except BaseException:
            if self._log_file:
                self._log_file.close()
            raise

    def _log(self, event, value):
        if self._log_file:
            self._log_file.write(json.dumps({'time': time.time(), 'event': event,
                                            'value': value}, ensure_ascii=False) + '\n')
            self._log_file.flush()

    def _fail(self, message):
        self.failed = True
        self._log('fault', message)
        raise GrblError(message)

    def _write(self, data):
        self._log('tx', data.decode('ascii'))
        try:
            count = self.sp.write(data)
        except Exception as exc:
            self._fail('Serial write failed: ' + str(exc))
        if count != len(data):
            self._fail('Partial serial write')

    def _line(self, deadline):
        while True:
            if b'\n' in self._rx:
                raw, _, rest = self._rx.partition(b'\n')
                self._rx = bytearray(rest)
                line = raw.decode('ascii', errors='replace').rstrip('\r')
                self._log('rx', line)
                if line:
                    return line
            if time.monotonic() >= deadline:
                self._fail('Timed out waiting for a complete GRBL response')
            try:
                data = self.sp.read(max(1, self.sp.in_waiting))
            except Exception as exc:
                self._fail('Serial read failed: ' + str(exc))
            self._rx.extend(data)
            if len(self._rx) > 65536:
                self._fail('Oversized unterminated GRBL response')

    def _check_fault(self, line, allow_startup=False):
        if line.startswith(('error:', 'ALARM:')):
            self._fail('Controller rejected operation: ' + line)
        if line.startswith('Grbl ') and not allow_startup:
            self._fail('Controller restarted during operation: ' + line)

    def _drain(self, deadline):
        """Process already-buffered reports; never let stale ACK accept new work."""
        while self._rx or self.sp.in_waiting:
            # A leftover blank CRLF is not a response to wait for.
            if not self._rx.strip(b'\r\n'):
                self._rx.clear()
                if not self.sp.in_waiting:
                    break
                self._rx.extend(self.sp.read(self.sp.in_waiting))
                if not self._rx.strip(b'\r\n'):
                    continue
            line = self._line(deadline)
            self._check_fault(line, allow_startup=not self._started)
            if line == 'ok':
                self._fail('Unexpected stale ACK before command; stream is not synchronized')
            if line.startswith('<'):
                self._status(line)

    def send(self, line, timeout=10.0):
        if self.failed:
            raise GrblError('Transport faulted; reconnect and inspect before sending commands')
        line = line.strip()
        if not line or any(ord(c) < 32 or ord(c) > 126 or c in '?!~' for c in line):
            raise ValueError('send requires one nonempty ASCII G-code/settings line')
        deadline = time.monotonic() + timeout
        self._drain(deadline)
        self._started = True
        if re.search(r'G(?:10|43(?:\.1)?|49|5[4-9]|92(?:\.[123])?)(?![\d.])', line, re.I):
            self._wco_raw = None
        if re.match(r'\$13\s*=|\$RST=', line, re.I):
            self.report_inches = None
            self._wco_raw = None
        # This controller ACKs CR and LF separately. One LF means one ACK;
        # CRLF would leave an empty-command ACK to contaminate the next send.
        self._write((line + '\n').encode('ascii'))
        replies = []
        while True:
            reply = self._line(deadline)
            self._check_fault(reply)
            replies.append(reply)
            if reply.startswith('<'):
                self._status(reply)
            if reply == 'ok':
                return replies

    def read_settings(self, timeout=10.0):
        settings = {}
        for line in self.send('$$', timeout):
            match = re.fullmatch(r'\$(\d+)=([-+]?\d+(?:\.\d+)?)', line)
            if match:
                settings[int(match[1])] = float(match[2])
        if settings.get(13) not in (0, 1):
            self._fail('Settings response lacks a valid $13 report-unit setting')
        inches = bool(settings[13])
        if inches != self.report_inches:
            self._wco_raw = None
        self.report_inches = inches
        return settings

    def _status(self, line):
        if not line.startswith('<') or not line.endswith('>'):
            self._fail('Malformed status report: ' + line)
        parts = line[1:-1].split('|')
        fields = dict(p.split(':', 1) for p in parts[1:] if ':' in p)

        def vector(key):
            if key not in fields:
                return None
            try:
                value = tuple(float(x) for x in fields[key].split(','))
                if len(value) != 3 or not all(math.isfinite(x) for x in value):
                    raise ValueError()
                return value
            except ValueError:
                self._fail('Invalid ' + key + ' vector: ' + line)

        mpos, wpos, wco = vector('MPos'), vector('WPos'), vector('WCO')
        if wco is not None:
            self._wco_raw = wco
        wco = self._wco_raw
        inches = self.report_inches if self.report_units == 'settings' else self.report_units == 'inch'
        if inches is None:
            mpos = wpos = wco = None
        else:
            factor = 25.4 if inches else 1.0
            mpos, wpos, wco = (None if v is None else tuple(x * factor for x in v)
                               for v in (mpos, wpos, wco))
            if wpos is None and mpos is not None and wco is not None:
                wpos = tuple(m - o for m, o in zip(mpos, wco))
            if mpos is None and wpos is not None and wco is not None:
                mpos = tuple(w + o for w, o in zip(wpos, wco))
        return Status(parts[0], line, fields, mpos, wpos, wco)

    def query_status(self, timeout=2.0):
        deadline = time.monotonic() + timeout
        self._drain(deadline)
        self._started = True
        self._write(b'?')
        while True:
            reply = self._line(deadline)
            self._check_fault(reply)
            if reply == 'ok':
                self._fail('Unexpected ACK while waiting for realtime status')
            if reply.startswith('<'):
                return self._status(reply)

    def wait_idle(self, timeout=30.0, poll_interval=0.05):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.query_status(timeout=min(2.0, max(0.001, deadline-time.monotonic())))
            if status.state == 'Idle':
                return status
            if status.state.split(':')[0] not in ('Run', 'Jog'):
                self._fail('Controller is not running or idle: ' + status.raw)
            time.sleep(min(poll_interval, max(0, deadline-time.monotonic())))
        self._fail('Timed out waiting for Idle')

    def run(self, lines, timeout=10.0, idle_timeout=60.0):
        for line in lines:
            if line.strip():
                self.send(line, timeout)
        return self.wait_idle(idle_timeout)

    def close(self):
        try:
            self.sp.close()
            self._log('close', None)
        finally:
            if self._log_file:
                self._log_file.close()
                self._log_file = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
