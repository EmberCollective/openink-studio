#!/usr/bin/env python3
"""SVG centerlines -> validated Stepper job. No private fonts or decryption.

Default: anchor the first path point at the current pen XY (single connection).
Example: write_svg.py sample.svg --scale 2 --dry-run
Only millimetre M/L SVG paths are supported; full paths are preserved.
"""
import argparse
import hashlib
import json
from pathlib import Path
from centerline_svg import read_svg, select_window, place_strokes, bounds
from stepper_job import build_job, execute_job, anchor_first_point

def place_at_first_point(strokes, anchor, scale):
    """Flip/scale source paths and keep the first travel target at anchor."""
    local = place_strokes(strokes, (0, 0), scale)
    return anchor_first_point(local, anchor)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('svg')
    ap.add_argument('--port')
    ap.add_argument('--win', help='Source window x0,y0,x1,y1 mm; refuses cut paths')
    ap.add_argument('--at', help='Explicit absolute ink lower-left XY, mm; default: current XY is first path point')
    ap.add_argument('--scale', type=float, default=1)
    ap.add_argument('--z-down', type=float, default=4)
    ap.add_argument('--z-speed', type=float, default=300)
    ap.add_argument('--feed', type=float, default=1200)
    ap.add_argument('--jog', type=float, default=1500)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--out', default='out_svg.gcode')
    ap.add_argument('--log', default='docs/evidence/runs/svg-write-current.jsonl')
    a = ap.parse_args(argv)
    all_strokes = read_svg(a.svg)
    window = tuple(map(float,a.win.split(','))) if a.win else None
    selected = select_window(all_strokes,window)
    explicit_at = tuple(map(float,a.at.split(','))) if a.at is not None else None
    live = bool(a.port) and not a.dry_run

    def generate(initial=None):
        if explicit_at is not None:
            anchor = explicit_at
            mode, position_source = 'absolute-bounds', 'explicit-at'
            placed = place_strokes(selected, anchor, a.scale)
        else:
            # Offline preview uses a clearly labelled hypothetical anchor, not
            # remembered machine coordinates. Choose enough positive margin
            # for geometry on either side of the first point.
            local = place_strokes(selected, (0, 0), a.scale)
            first = next((s[0] for s in local if len(s) >= 2), None)
            if first is None:
                raise ValueError('No drawable strokes')
            anchor = initial.wpos_mm[:2] if initial is not None else first[:2]
            mode = 'current-first-point'
            position_source = 'live-preflight' if initial is not None else 'assumed-preview'
            placed = place_at_first_point(selected, anchor, a.scale)
        job = build_job(placed, z_on=a.z_down,z_feed=a.z_speed,feed=a.feed,jog=a.jog,
                        current_anchor=anchor if explicit_at is None else None)
        Path(a.out).write_bytes(('\n'.join(job)+'\n').encode('ascii'))
        report = dict(source=str(Path(a.svg)), sha256=hashlib.sha256(Path(a.svg).read_bytes()).hexdigest(),
                      window=window, source_bounds=bounds(selected), machine_bounds=bounds(placed),
                      paths=len(selected), points=sum(map(len, selected)), commands=len(job),
                      at=anchor, anchor_mode=mode, position_source=position_source,
                      position_assumed=position_source == 'assumed-preview',
                      scale=a.scale, z_down=a.z_down, z_speed=a.z_speed,
                      feed=a.feed,jog=a.jog, fonts_required=False)
        if position_source == 'assumed-preview':
            report['placement_note'] = 'OFFLINE ASSUMPTION: anchor chosen so ink bounds start at (0,0); no machine position was read. Live execution regenerates from current first-point XY.'
        Path(a.out+'.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
        return job

    if live:
        execute_job(generate, a.port, log_path=a.log)
    else:
        generate()

if __name__ == '__main__':
    main()
