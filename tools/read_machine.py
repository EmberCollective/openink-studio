"""Read-only GRBL snapshot; no reset, unlock or movement."""
import json
import time
from pathlib import Path
import serial

def snapshot():
    rows = []
    with serial.Serial('COM10', 115200, timeout=0.2) as sp:
        sp.dtr = sp.rts = True
        time.sleep(0.5)
        rows.append({'tx': None, 'rx': sp.read_all().decode('ascii', 'replace')})
        for cmd in (b'?', b'$$\r\n', b'$G\r\n', b'$I\r\n', b'$#\r\n'):
            sp.write(cmd)
            time.sleep(1)
            rows.append({'tx': cmd.decode(), 'rx': sp.read_all().decode('ascii', 'replace')})
    out = Path('docs/evidence/runs/machine-snapshot-current.json')
    out.write_text(json.dumps(rows, indent=2), encoding='utf-8')
    print(out.read_text(encoding='utf-8'))

if __name__ == '__main__':
    snapshot()
