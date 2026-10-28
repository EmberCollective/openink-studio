"""Strict millimetre M/L centerline SVG reader; no fonts required."""
import math
import re
import xml.etree.ElementTree as ET

NUMBER = r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?'
TOKEN = re.compile(r'[A-Za-z]|' + NUMBER)

def path_points(data):
    tokens = TOKEN.findall(data)
    if TOKEN.sub('', data).strip(' ,\t\r\n'):
        raise ValueError('Malformed path data')
    strokes, stroke = [], []
    command = None
    x = y = 0.0
    i = 0
    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]
            i += 1
            if command not in ('M', 'm', 'L', 'l'):
                raise ValueError('Only M/L centerlines supported: ' + command)
            if i == len(tokens):
                raise ValueError('Missing path coordinates')
        if command is None or i+1 >= len(tokens):
            raise ValueError('Missing path coordinate pair')
        try:
            a, b = float(tokens[i]), float(tokens[i+1])
        except ValueError as exc:
            raise ValueError('Invalid path coordinate pair') from exc
        if not math.isfinite(a) or not math.isfinite(b):
            raise ValueError('Nonfinite coordinates')
        i += 2
        if command.islower():
            a, b = x+a, y+b
        if not math.isfinite(a) or not math.isfinite(b):
            raise ValueError('Relative path coordinates overflow')
        x, y = a, b
        if command in ('M', 'm'):
            if stroke:
                strokes.append(stroke)
            stroke = [(x, y, 0)]
            command = 'l' if command == 'm' else 'L'
        else:
            if not stroke:
                raise ValueError('Path must begin with moveto')
            stroke.append((x, y, 1))
    if stroke:
        strokes.append(stroke)
    return strokes

def read_svg(path):
    root = ET.parse(path).getroot()
    if root.tag.rsplit('}', 1)[-1] != 'svg':
        raise ValueError('Not an SVG root')
    def mm(value):
        m = re.fullmatch('('+NUMBER+')mm', value or '')
        if not m or not math.isfinite(float(m[1])) or float(m[1]) <= 0:
            raise ValueError('SVG must declare positive width/height in mm')
        return float(m[1])
    width, height = mm(root.get('width')), mm(root.get('height'))
    view = [float(v) for v in re.split(r'[\s,]+', root.get('viewBox', '').strip()) if v]
    if len(view) != 4 or not all(math.isfinite(v) for v in view) or min(view[2:]) <= 0:
        raise ValueError('Invalid SVG viewBox')
    sx, sy = width/view[2], height/view[3]
    if not all(math.isfinite(v) and v > 0 for v in (sx, sy)):
        raise ValueError('SVG viewport scale is not finite and positive')
    if not math.isclose(sx, sy, rel_tol=1e-5):
        raise ValueError('Nonuniform viewport unsupported; normalize SVG first')
    strokes = []
    def visit(node, inherited_fill='black', inherited_stroke='none'):
        tag = node.tag.rsplit('}', 1)[-1]
        if tag in ('metadata', 'desc', 'title'):
            return
        if tag not in ('svg', 'g', 'path') or (tag == 'svg' and node is not root):
            raise ValueError('Unsupported SVG element: '+tag)
        for attr in ('transform', 'style', 'clip-path', 'mask', 'display', 'visibility', 'opacity'):
            if attr in node.attrib:
                raise ValueError('Unsupported SVG attribute: '+attr)
        fill = node.get('fill', inherited_fill).strip()
        stroke_color = node.get('stroke', inherited_stroke).strip()
        if fill == 'inherit':
            fill = inherited_fill
        if stroke_color == 'inherit':
            stroke_color = inherited_stroke
        if tag == 'path':
            if fill.lower() != 'none' or stroke_color.lower() in ('none', 'transparent', ''):
                raise ValueError('Centerline paths require inherited fill="none" and a visible stroke')
            if len(node):
                raise ValueError('Path animations/children unsupported')
            for stroke in path_points(node.get('d', '')):
                converted = [((x-view[0])*sx, (y-view[1])*sy, pen) for x,y,pen in stroke]
                if not all(math.isfinite(v) for p in converted for v in p[:2]):
                    raise ValueError('SVG coordinate conversion overflow')
                strokes.append(converted)
        else:
            for child in node:
                visit(child, fill, stroke_color)
    visit(root)
    if not strokes:
        raise ValueError('No paths in SVG')
    return strokes

def bounds(strokes):
    points = [p for s in strokes for p in s]
    if not points:
        raise ValueError('No points')
    if not all(math.isfinite(v) for p in points for v in p[:2]):
        raise ValueError('Nonfinite path coordinates')
    return (min(p[0] for p in points), min(p[1] for p in points),
            max(p[0] for p in points), max(p[1] for p in points))

def select_window(strokes, window):
    if window is None:
        return strokes
    x0, y0, x1, y1 = window
    if not all(math.isfinite(v) for v in window) or x1 <= x0 or y1 <= y0:
        raise ValueError('Window must be finite x0,y0,x1,y1')
    selected = []
    for s in strokes:
        a,b,c,d = bounds([s])
        if a >= x0 and b >= y0 and c <= x1 and d <= y1:
            selected.append(s)
        elif not (c < x0 or a > x1 or d < y0 or b > y1):
            raise ValueError('Selection boundary intersects a path; enlarge or move window')
    if not selected:
        raise ValueError('No complete paths in selection')
    return selected

def place_strokes(strokes, at=(0,0), scale=1):
    if len(at) != 2 or not all(math.isfinite(v) for v in (*at,scale)) or scale <= 0:
        raise ValueError('Invalid placement/scale')
    x0,y0,x1,y1 = bounds(strokes)
    placed = [[(at[0]+(x-x0)*scale, at[1]+(y1-y)*scale, pen)
               for x,y,pen in s] for s in strokes]
    bounds(placed)  # Reject arithmetic overflow before G-code generation.
    return placed
