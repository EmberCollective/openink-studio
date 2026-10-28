#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
svg2plotter.py - Inko 中心线 SVG -> 奎享写字机(GRBL)直连绘制工具
面向 GRBL 写字机的独立重写（黑盒行为验证）

用法:
  python svg2plotter.py page-001.svg --dry-run -o out.gcode     # 只生成 G-code
  python svg2plotter.py page-001.svg --port COM10               # 直连绘制
  python svg2plotter.py page-001.svg --port COM10 --fit 190x190 --at 5,5
依赖: pip install pyserial   (仅直连模式需要)

坐标约定(与原软件一致):
  - SVG mm 坐标原点左上、X 右、Y 下, 直接映射为 G-code 绝对坐标
  - 机器硬件通过 $3=2 (Y 步进方向翻转) 补偿极性, 无需软件翻转
  - 默认 --fit 190x190 将内容等比缩放到机器安全行程内 ($130/$131=200mm)
"""
import argparse, re, sys, time

try:
    import serial
except ImportError:
    serial = None

PEN_DOWN = "M3 S1000"   # $30=1000 (最大 PWM), $32=1 激光/笔模式
PEN_UP = "M5"
DWELL = 0.3             # 抬/落笔后停留, 秒 (原软件默认 0.2)
# Z 轴笔控 (本机实测有效的模式): 落笔 = Z 轴下压, 抬笔 = Z0
Z_DOWN_DEFAULT = 3.0    # 落笔深度 mm (原软件默认 2, 用户要求加深)
Z_SPEED = 3000

# ---------------- SVG 解析 ----------------
NUM = r'[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?'
PATH_RE = re.compile(r'<path\b[^>]*\bd="([^"]*)"', re.S)

def parse_centerline_svg(text):
    """解析 Inko 中心线 SVG -> strokes: [ [(x,y,pen), ...], ... ]
    仅支持 M/L (Inko 导出为绝对坐标 + 空格分隔); 其他命令报错。"""
    strokes = []
    for m in PATH_RE.finditer(text):
        d = m.group(1)
        toks = re.findall(r'([MLmlZzHhVvCcSsQqTtAa])|(' + NUM + r')', d)
        stroke = []
        cx = cy = 0.0
        i = 0
        while i < len(toks):
            cmd, num = toks[i]
            if cmd:
                i += 1
                if cmd in 'Mm':
                    if stroke:
                        strokes.append(stroke); stroke = []
                    x = float(toks[i][1]); y = float(toks[i + 1][1]); i += 2
                    if cmd == 'm':
                        cx += x; cy += y
                    else:
                        cx, cy = x, y
                    stroke.append((cx, cy, 0))
                elif cmd in 'Ll':
                    x = float(toks[i][1]); y = float(toks[i + 1][1]); i += 2
                    if cmd == 'l':
                        cx += x; cy += y
                    else:
                        cx, cy = x, y
                    stroke.append((cx, cy, 1))
                elif cmd in 'Zz':
                    if stroke:
                        stroke.append((stroke[0][0], stroke[0][1], 1))
                else:
                    raise ValueError(
                        "不支持的中心线命令 '%s' - 仅支持 M/L 直线中心线 SVG (Inko 导出格式)" % cmd)
            else:
                x = float(num); y = float(toks[i + 1][1]); i += 2
                if not stroke:
                    cx, cy = x, y
                    stroke.append((cx, cy, 0))
                else:
                    cx, cy = x, y
                    stroke.append((cx, cy, 1))
        if stroke:
            strokes.append(stroke)
    return strokes

def bbox(strokes):
    xs = [p[0] for s in strokes for p in s]
    ys = [p[1] for s in strokes for p in s]
    return min(xs), min(ys), max(xs), max(ys)

# ---------------- G-code 生成 ----------------
def make_gcode(strokes, feed=1500, jog=2500, fit=None, at=(0, 0), limit=(195, 195)):
    """fit=(w,h): 等比缩放内容至 w*h 内; at: 放置原点(mm). 返回 (lines, meta)"""
    x0, y0, x1, y1 = bbox(strokes)
    w, h = x1 - x0, y1 - y0
    scale = 1.0
    if fit:
        fw, fh = fit
        scale = min(fw / w if w else 1, fh / h if h else 1, 1.0)
        scale = min(scale, (limit[0] - at[0]) / w if w else 1,
                    (limit[1] - at[1]) / h if h else 1)
    def tx(x, y):
        return (at[0] + (x - x0) * scale, at[1] + (y - y0) * scale)
    g = []
    g.append("$X")                      # 解锁
    g.append("G21 G90")                 # mm / 绝对
    g.append("F%d" % feed)
    g.append(PEN_UP)
    npts = 0
    for s in strokes:
        if len(s) < 2:
            continue
        px, py = tx(*s[0][:2])
        g.append("G0 X%.3f Y%.3f F%d" % (px, py, jog))
        g.append(PEN_DOWN)
        g.append("G4 P%.2f" % DWELL)
        for (x, y, pen) in s[1:]:
            if pen == 1:
                qx, qy = tx(x, y)
                g.append("G1 X%.3f Y%.3f F%d" % (qx, qy, feed))
                npts += 1
        g.append(PEN_UP)
        g.append("G4 P%.2f" % DWELL)
    g.append("G90 G0 X0 Y0")            # 回原点
    meta = dict(scale=scale, strokes=len(strokes), points=npts,
                src=(w, h), out=(w * scale, h * scale))
    return g, meta

# ---------------- GRBL 流式执行 ----------------
class Plotter:
    def __init__(self, port, baud=115200):
        if serial is None:
            sys.exit("需要 pyserial: pip install pyserial")
        self.sp = serial.Serial(port, baud, timeout=0.3)
        self.sp.dtr = True; self.sp.rts = True
        time.sleep(0.3)
        self._read()
        self.send("\r\n")               # 唤醒

    def _read(self):
        buf = b''
        while self.sp.inWaiting():
            buf += self.sp.read(self.sp.inWaiting())
        return buf.decode('latin1')

    def send(self, line, wait=10.0):
        self.sp.write((line.strip() + '\n').encode())
        end = time.time() + wait
        acc = ''
        while time.time() < end:
            acc += self._read()
            if 'ok' in acc or 'error' in acc:
                return acc.strip()
            time.sleep(0.02)
        return 'TIMEOUT ' + acc.strip()

    def run(self, lines, progress=True):
        err = 0
        for i, ln in enumerate(lines):
            r = self.send(ln)
            if 'error' in r or 'TIMEOUT' in r:
                err += 1
                print("\n[!] #%d '%s' -> %s" % (i, ln, r))
                if err >= 5:
                    self.send(PEN_UP)
                    sys.exit("连续 5 个错误, 已抬笔中止")
            if progress and i % 50 == 0:
                print("\r  %d/%d (%d%%)" % (i, len(lines), 100 * i // len(lines)),
                      end='', flush=True)
        print("\r  %d/%d (100%%)" % (len(lines), len(lines)))
        return err

    def close(self):
        try:
            self.send(PEN_UP)
        except Exception:
            pass
        self.sp.close()

def main():
    ap = argparse.ArgumentParser(description='Inko 中心线 SVG -> 奎享写字机 (GRBL)')
    ap.add_argument('svg')
    ap.add_argument('-o', '--out', help='输出 G-code 文件')
    ap.add_argument('--port', help='串口, 如 COM10')
    ap.add_argument('--baud', type=int, default=115200)
    ap.add_argument('--feed', type=int, default=1500, help='画线速度 mm/min')
    ap.add_argument('--jog', type=int, default=2500, help='空程速度 mm/min')
    ap.add_argument('--fit', help='等比缩放到 WxH mm, 如 190x190; 默认 190x190')
    ap.add_argument('--at', default='0,0', help='放置原点 mm, 如 5,5')
    ap.add_argument('--limit', default='195,195', help='机器安全行程 mm')
    ap.add_argument('--dry-run', action='store_true', help='只生成 G-code 不连接')
    a = ap.parse_args()

    text = open(a.svg, encoding='utf-8').read()
    strokes = parse_centerline_svg(text)
    if not strokes:
        sys.exit("SVG 中未找到 <path> - 请使用 Inko 导出的中心线 SVG")
    fit = tuple(map(float, a.fit.split('x'))) if a.fit else (190, 190)
    at = tuple(map(float, a.at.split(',')))
    limit = tuple(map(float, a.limit.split(',')))
    lines, meta = make_gcode(strokes, a.feed, a.jog, fit, at, limit)
    print("笔划 %d  点 %d  缩放 %.3f (%.0fx%.0f -> %.0fx%.0f mm)" % (
        meta['strokes'], meta['points'], meta['scale'],
        meta['src'][0], meta['src'][1], meta['out'][0], meta['out'][1]))

    if a.dry_run or not a.port:
        out = a.out or (a.svg.rsplit('.', 1)[0] + '.gcode')
        open(out, 'w', encoding='ascii').write('\n'.join(lines) + '\n')
        print("G-code 已写入 %s (%d 行)" % (out, len(lines)))
        return

    print("连接 %s @ %d ..." % (a.port, a.baud))
    p = Plotter(a.port, a.baud)
    try:
        p.run(lines)
        print("绘制完成")
    except KeyboardInterrupt:
        print("\n中断: 抬笔...")
        p.send(PEN_UP); p.send("G90 G0 X0 Y0")
    finally:
        p.close()

if __name__ == '__main__':
    main()
