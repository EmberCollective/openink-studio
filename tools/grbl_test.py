import serial, time

class Grbl:
    def __init__(self, port='COM10', baud=115200):
        self.sp = serial.Serial(port, baud, timeout=0.3)
        self.sp.dtr = True; self.sp.rts = True
        time.sleep(0.3)
        self.drain()
        self.send('\r\n')  # wake up

    def drain(self):
        buf = b''
        while self.sp.inWaiting():
            buf += self.sp.read(self.sp.inWaiting())
        return buf.decode('latin1')

    def send(self, cmd, wait=2.0):
        """send one line, wait for ok/error"""
        self.sp.write((cmd.strip() + '\n').encode())
        end = time.time() + wait
        out = []
        while time.time() < end:
            data = self.drain()
            if data:
                out.append(data)
                joined = ''.join(out)
                if 'ok' in joined or 'error' in joined:
                    return joined.strip()
            time.sleep(0.03)
        return ('TIMEOUT: ' + ''.join(out)).strip()

g = Grbl()
print("unlock:", g.send('$X'))
print("mm/abs:", g.send('G21 G90'))
print("pen up:", g.send('M5'))
print("dry move:", g.send('G0 X5 Y5 F2500'))
print("home:", g.send('G0 X0 Y0'))
print("--- draw 10mm test square ---")
print("goto:", g.send('G0 X10 Y10'))
print("pen dn:", g.send('M3 S1000'))
print("dwell:", g.send('G4 P0.3'))
for c in ['G1 X20 Y10 F1500', 'G1 X20 Y20', 'G1 X10 Y20', 'G1 X10 Y10']:
    print(c, '->', g.send(c))
print("pen up:", g.send('M5'))
print("dwell:", g.send('G4 P0.3'))
print("home:", g.send('G0 X0 Y0'))
g.sp.close()
print("TEST COMPLETE")
