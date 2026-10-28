"""Shared bounded Stepper jobs for already-normalized machine-mm paths.

No font parser, cryptography, SVG parser, homing or firmware-setting changes.
build_job accepts paths of (x, y, pen) with pen=0 at each path's start and
pen=1 for drawing points. execute_job accepts generated command lines and
performs the same calibrated-origin checks for every input format.
"""
import math

from grbl_transport import GrblTransport


def anchor_first_point(strokes_mm, anchor):
    """Translate machine-oriented paths so first drawable point equals XY."""
    if len(anchor) != 2 or not all(math.isfinite(v) for v in anchor):
        raise ValueError('Invalid current-position anchor')
    first = next((s[0] for s in strokes_mm if len(s) >= 2), None)
    if first is None:
        raise ValueError('No drawable strokes')
    x0, y0 = first[:2]
    return [[(anchor[0] + x-x0, anchor[1] + y-y0, pen) for x,y,pen in s]
            for s in strokes_mm]


def build_job(strokes_mm, z_on=4, z_off=0, z_feed=300, feed=1200, jog=1500,
              current_anchor=None):
    """Saved Stepper configuration; slower feeds, no dwell or XY return.

    Pen-up travel uses feed-limited G1 instead of official G0 (G0 ignores F).
    Input coordinates must already be machine coordinates, including Y flip.
    current_anchor enables signed work coordinates bounded relative to the
    manually prepared start, not absolute 0..195. This is a numeric envelope,
    not a measurement of physical clearance from the machine frame.
    """
    vals = (z_on, z_off, z_feed, feed, jog)
    if not all(math.isfinite(v) for v in vals) or not (0 <= z_off < z_on <= 4):
        raise ValueError('Validated Z range is 0 <= off < on <= 4 mm')
    if not (0 < z_feed <= 300 and 0 < feed <= 4000 and 0 < jog <= 4000):
        raise ValueError('Feed outside validated limits')
    if current_anchor is not None:
        if len(current_anchor) != 2 or not all(math.isfinite(v) for v in current_anchor):
            raise ValueError('Invalid current-position anchor')
        points = [p for s in strokes_mm if len(s) >= 2 for p in s]
        if not all(math.isfinite(v) for p in points for v in p[:2]):
            raise ValueError('Nonfinite XY')
        for axis in (0, 1):
            values = [p[axis] for p in points]
            if values and (max(values)-min(values) > 195
                           or any(abs(v-current_anchor[axis]) > 195 for v in values)):
                raise ValueError('XY exceeds current-anchor 195 mm envelope')
    up = f'G1G90 Z{z_off:.3f}F{z_feed:g}'
    down = f'G1G90 Z{z_on:.3f}F{z_feed:g}'
    g = ['G21', 'G90', 'G94', 'G54', up]
    drawn = 0
    for s in strokes_mm:
        if len(s) < 2:
            continue
        x0, y0, _ = s[0]
        if current_anchor is None and not all(math.isfinite(v) and 0 <= v <= 195 for p in s for v in p[:2]):
            raise ValueError('XY outside 0..195 mm')
        drawn += 1
        g.append(up)
        g.append('G1 X%.3fY%.3fF%g' % (x0, y0, jog))
        g.append(down)
        for (x, y, pen) in s[1:]:
            if pen == 1:
                g.append('G1 X%.3fY%.3fF%g' % (x, y, feed))
    if not drawn:
        raise ValueError('No drawable strokes')
    g.append(up)
    return g


def execute_job(lines, port, log_path='docs/evidence/runs/stepper-write-current.jsonl'):
    """Run build_job output after checking Idle, G54, zero WCO and raised Z0.

    lines may be a callable(initial_status), evaluated only after the read-only
    preflight, on this same connection. This supports current-position jobs
    without opening/closing the port between measuring and generating them.
    Returns the final Status after Idle and Z0 verification. Exceptions stop
    sending; closing the transport never emits a pen or return command.
    The selected mm report override is specific to this machine's measured
    command/report behavior, despite its $13=1 setting.
    """
    with GrblTransport(port, log_path=log_path, report_units='mm') as p:
        initial = p.query_status()
        if initial.state != 'Idle':
            raise RuntimeError('Machine must already be Idle: '+initial.raw)
        p.read_settings()
        modal = p.send('$G')
        if not any('[GC:' in row and 'G54 ' in row for row in modal):
            raise RuntimeError('Select/inspect G54 before running')
        for _ in range(40):
            initial = p.query_status()
            if initial.state != 'Idle':
                raise RuntimeError('Machine moved during preflight: '+initial.raw)
            if initial.wpos_mm is not None:
                break
        if initial.wpos_mm is None or initial.mpos_mm is None or initial.wco_mm is None:
            raise RuntimeError('Missing WCO: cannot verify work coordinates')
        if abs(initial.wpos_mm[2]) > 0.05:
            raise RuntimeError('Start at calibrated raised Z0; do not auto-zero an unknown pen height')
        if any(abs(v) > 0.05 for v in initial.wco_mm):
            raise RuntimeError('Nonzero work offset: inspect manual origin before running')
        print('START', initial.raw, flush=True)
        if callable(lines):
            lines = lines(initial)
            # Generation may include preview/file writes. Refuse if the start
            # changed meanwhile; never silently reuse a stale placement.
            current = p.query_status()
            if (current.state != 'Idle' or current.wpos_mm is None
                    or current.wco_mm is None
                    or any(abs(a-b) > 0.001 for a,b in zip(current.wpos_mm, initial.wpos_mm))
                    or any(abs(a-b) > 0.001 for a,b in zip(current.wco_mm, initial.wco_mm))):
                raise RuntimeError('Position changed after placement; regenerate from current position')
        end = p.run(lines)
        if end.mpos_mm is None or abs(end.mpos_mm[2]) > 0.05:
            raise RuntimeError('Final Z0 position not confirmed: '+end.raw)
        print('DONE Idle, Z0; paper result requires observation:', end.raw, flush=True)
        return end
