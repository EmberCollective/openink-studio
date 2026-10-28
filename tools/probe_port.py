import serial, time, sys

def drain(sp, ms, label):
    end = time.time() + ms/1000
    buf = b''
    while time.time() < end:
        n = sp.inWaiting()
        if n:
            buf += sp.read(n)
        time.sleep(0.04)
    s = buf.decode('latin1')
    print(f"[{label}] " + (repr(s) if s else "(no response)"))
    return s

sp = serial.Serial('COM10', 115200, bytesize=8, parity='N', stopbits=1,
                   dsrdtr=False, rtscts=False, timeout=0.2)
sp.dtr = True; sp.rts = True
time.sleep(0.3)
drain(sp, 300, 'banner')
sp.write(b"\r\n");            drain(sp, 800, 'CRLF  (GRBL banner?)')
sp.write(b"?");               drain(sp, 500, '?      (GRBL status?)')
sp.write(b"V\r\n");           drain(sp, 500, 'V      (EBB version?)')
sp.write(b"M115\r\n");        drain(sp, 800, 'M115   (Marlin?)')
sp.write(b"$$\r\n");          drain(sp, 1500, '$$     (GRBL settings?)')
sp.close()
print("done")
