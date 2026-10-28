"""Bounded Z-only experiment. No XY moves, reset, unlock or zeroing.

Run dry first. Optional --hold compares $1=255; original value is restored
only after Z returns to its initial position. Position reports are not sensors.
"""
import argparse
import time
from grbl_transport import GrblTransport

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', default='COM10')
    ap.add_argument('--depth', type=float, default=4)
    ap.add_argument('--hold', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--log', default='docs/evidence/runs/z-probe-current.jsonl')
    a = ap.parse_args()
    if not 0 < a.depth <= 4:
        ap.error('probe depth must be in (0,4] mm')
    commands = ['G21', 'G91', f'G1 Z{a.depth:g} F300', '[wait Idle, observe 8 seconds]',
                f'G1 Z{-a.depth:g} F300', '[wait Idle]', 'G90']
    print('\n'.join(commands), flush=True)
    if a.dry_run:
        return
    with GrblTransport(a.port, log_path=a.log) as p:
        initial = p.query_status()
        if initial.state != 'Idle':
            raise RuntimeError('Machine must already be Idle: '+initial.raw)
        settings = p.read_settings()
        print('BEFORE', p.query_status().raw, 'settings', settings, flush=True)
        # Relative bounded motion avoids trusting undocumented report units.
        old_hold = settings[1]
        if a.hold:
            p.send('$1=255')
        p.send('G21')
        p.send('G91')
        p.send(f'G1 Z{a.depth:g} F300')
        print('DOWN', p.wait_idle().raw, flush=True)
        for i in range(8):
            time.sleep(1)
            print('HOLD', i+1, p.query_status().raw, flush=True)
        p.send(f'G1 Z{-a.depth:g} F300')
        print('UP', p.wait_idle().raw, flush=True)
        p.send('G90')
        if a.hold:
            p.send(f'$1={old_hold:g}')
            assert p.read_settings()[1] == old_hold

if __name__ == '__main__':
    main()
