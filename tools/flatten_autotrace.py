#!/usr/bin/env python3
"""Flatten black, unfilled AutoTrace SVG paths into millimetre M/L SVG.

No smoothing, path joining, resampling, or font dependency. M/L/C/Z (including
relative and implicit arguments) are supported. Curves are split by de Casteljau
until both interior control points are within tolerance of the chord segment.
The Bezier convex-hull property bounds curve-to-polyline distance. Tolerance is
measured AFTER pixel_mm conversion, in output/source mm. A later machine scale
multiplies that error. This checks stroked geometry, not whether the producer
actually used AutoTrace --centerline; provenance must establish that separately.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

NUMBER = r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?'
TOKEN = re.compile(r'[A-Za-z]|' + NUMBER)
SVG_NS = 'http://www.w3.org/2000/svg'
MAX_POINTS = 1_000_000
BLACK = {'black', '#000', '#000000', 'rgb(0,0,0)', 'rgb(0%,0%,0%)'}
STYLE_KEYS = {'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
              'stroke-miterlimit', 'fill-rule'}
FORBIDDEN = {'transform', 'clip-path', 'mask', 'filter', 'display', 'visibility',
             'opacity', 'stroke-opacity', 'fill-opacity', 'stroke-dasharray',
             'stroke-dashoffset'}


def _finite_point(point):
    if not all(math.isfinite(v) for v in point):
        raise ValueError('Nonfinite or overflowing path coordinate')
    return point


def _distance_to_segment(p, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    length = math.hypot(dx, dy)
    if not math.isfinite(length):
        raise ValueError('Geometry magnitude is too large')
    if length == 0:
        return math.dist(p, a)
    ux, uy = dx/length, dy/length
    projection = max(0.0, min(length, (p[0]-a[0])*ux+(p[1]-a[1])*uy))
    return math.hypot(p[0]-a[0]-projection*ux, p[1]-a[1]-projection*uy)


def flatten_cubic(p0, p1, p2, p3, tolerance_mm, max_depth=24):
    """Return chord endpoints excluding p0, ending exactly at p3.

    Reject unresolved curves at the depth/point cap rather than silently
    relaxing tolerance. Degenerate endpoint chords and loops are supported.
    """
    if not math.isfinite(tolerance_mm) or tolerance_mm <= 0:
        raise ValueError('tolerance_mm must be finite and positive')
    for point in (p0, p1, p2, p3):
        _finite_point(point)
    result = []
    stack = [(p0, p1, p2, p3, 0)]
    while stack:
        a, b, c, d, depth = stack.pop()
        flatness = max(_distance_to_segment(b, a, d), _distance_to_segment(c, a, d))
        if not math.isfinite(flatness):
            raise ValueError('Geometry magnitude is too large')
        # Half the user tolerance leaves room for floating-point arithmetic.
        if flatness <= tolerance_mm * 0.5:
            result.append(d)
            if len(result) > MAX_POINTS:
                raise ValueError('Curve output point limit exceeded')
            continue
        if depth >= max_depth:
            raise ValueError('Curve subdivision limit reached before tolerance')
        def midpoint(x, y):
            return _finite_point((x[0]*0.5+y[0]*0.5, x[1]*0.5+y[1]*0.5))
        ab, bc, cd = midpoint(a, b), midpoint(b, c), midpoint(c, d)
        abc, bcd = midpoint(ab, bc), midpoint(bc, cd)
        mid = midpoint(abc, bcd)
        stack.append((mid, bcd, cd, d, depth+1))
        stack.append((a, ab, abc, mid, depth+1))
    return result


def flatten_path(data, pixel_mm, tolerance_mm, origin=(0.0, 0.0), viewport_scale=1.0):
    """Parse one SVG d into separate lists of (x_mm,y_mm), plus counts."""
    tokens = TOKEN.findall(data)
    if TOKEN.sub('', data).strip(' ,\t\r\n'):
        raise ValueError('Malformed SVG path data')
    for v in (pixel_mm, tolerance_mm, viewport_scale):
        if not math.isfinite(v) or v <= 0:
            raise ValueError('Scale and tolerance must be finite and positive')
    factor = pixel_mm*viewport_scale
    if not math.isfinite(factor) or factor <= 0:
        raise ValueError('Pixel conversion overflow or underflow')
    def mm(p):
        return _finite_point(((p[0]-origin[0])*factor, (p[1]-origin[1])*factor))
    paths, current_path = [], None
    current = (0.0, 0.0)
    start = None
    command = None
    closed = curves = 0
    i = 0
    output_count = 0
    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]
            i += 1
            if command not in 'MmLlCcZz':
                raise ValueError('Unsupported SVG path command: '+command)
            if command in 'Zz':
                if current_path is None or start is None:
                    raise ValueError('Closepath without a subpath')
                current_path.append(mm(start))
                output_count += 1
                current = start
                closed += 1
                command = None
                continue
            if i == len(tokens):
                raise ValueError('Missing coordinates after command')
        if command is None:
            raise ValueError('Path must start with M; commands required after Z')
        count = 6 if command in 'Cc' else 2
        if i+count > len(tokens):
            raise ValueError('Incomplete path command')
        try:
            values = [float(v) for v in tokens[i:i+count]]
        except ValueError as exc:
            raise ValueError('Incomplete or malformed path coordinates') from exc
        if not all(math.isfinite(v) for v in values):
            raise ValueError('Nonfinite path coordinates')
        i += count
        points = [tuple(values[k:k+2]) for k in range(0, count, 2)]
        if command.islower():
            points = [_finite_point((x+current[0], y+current[1])) for x,y in points]
        if command in 'Mm':
            if current_path is not None:
                paths.append(current_path)
            current = start = points[0]
            current_path = [mm(current)]
            output_count += 1
            command = 'l' if command == 'm' else 'L'
        elif current_path is None:
            raise ValueError('Path must begin with moveto')
        elif command in 'Ll':
            current = points[0]
            current_path.append(mm(current))
            output_count += 1
        else:
            samples = flatten_cubic(mm(current), *[mm(p) for p in points], tolerance_mm)
            current_path.extend(samples)
            output_count += len(samples)
            current = points[-1]
            curves += 1
        if output_count > MAX_POINTS:
            raise ValueError('Path output point limit exceeded')
    if current_path is not None:
        paths.append(current_path)
    return paths, {'cubic_segments': curves, 'close_commands': closed}


def _pixel_size(value):
    match = re.fullmatch('('+NUMBER+')(?:px)?', (value or '').strip())
    if not match or not math.isfinite(float(match[1])) or float(match[1]) <= 0:
        raise ValueError('AutoTrace SVG width/height must be positive pixels')
    return float(match[1])


def convert_svg(input_path, output_path, pixel_mm, tolerance_mm):
    """Validate and flatten a pixel SVG; write only after full validation."""
    for v in (pixel_mm, tolerance_mm):
        if not math.isfinite(v) or v <= 0:
            raise ValueError('pixel_mm and tolerance_mm must be finite and positive')
    data = Path(input_path).read_bytes()
    root = ET.fromstring(data)
    if root.tag.rsplit('}', 1)[-1] != 'svg':
        raise ValueError('Not an SVG root')
    width, height = _pixel_size(root.get('width')), _pixel_size(root.get('height'))
    if 'viewBox' in root.attrib:
        view = [float(x) for x in re.split(r'[\s,]+', root.get('viewBox').strip()) if x]
        if len(view) != 4 or not all(math.isfinite(v) for v in view) or min(view[2:]) <= 0:
            raise ValueError('Invalid viewBox')
    else:
        view = [0.0, 0.0, width, height]
    sx, sy = width/view[2], height/view[3]
    if not all(math.isfinite(v) and v > 0 for v in (sx, sy)) or not math.isclose(sx, sy, rel_tol=1e-12):
        raise ValueError('Nonuniform or invalid viewBox scaling unsupported')
    width_mm, height_mm = width*pixel_mm, height*pixel_mm
    if not all(math.isfinite(v) and v > 0 for v in (width_mm, height_mm)):
        raise ValueError('Converted SVG dimensions overflow or underflow')
    paths = []
    stats = {'source_paths': 0, 'cubic_segments': 0, 'close_commands': 0}
    def visit(node, inherited):
        tag = node.tag.rsplit('}', 1)[-1]
        if tag in ('metadata', 'title', 'desc'):
            return
        if tag not in ('svg', 'g', 'path') or (tag == 'svg' and node is not root):
            raise ValueError('Unsupported SVG geometry: '+tag)
        if FORBIDDEN.intersection(node.attrib):
            raise ValueError('Unsupported rendering attribute: '+str(FORBIDDEN.intersection(node.attrib)))
        style = {}
        for item in node.get('style', '').split(';'):
            if not item.strip():
                continue
            key, sep, value = item.partition(':')
            key, value = key.strip(), value.strip()
            if not sep or key not in STYLE_KEYS or not value or '!important' in value:
                raise ValueError('Unsupported SVG style: '+item)
            style[key] = value
        actual = dict(inherited)
        for key in STYLE_KEYS:
            value = style.get(key, node.get(key, inherited.get(key)))
            if value is not None and value != 'inherit':
                actual[key] = value.strip()
        if tag == 'path':
            if len(node):
                raise ValueError('Path children/animations unsupported')
            fill = actual['fill'].lower()
            stroke = re.sub(r'\s+', '', actual['stroke'].lower())
            if fill != 'none' or stroke not in BLACK:
                raise ValueError('Require fill=none and black stroke; filled/white/background paths are refused')
            if _pixel_size(actual.get('stroke-width', '1')) <= 0:
                raise ValueError('Stroke width must be positive')
            if not node.get('d', '').strip():
                raise ValueError('Empty path')
            found, counts = flatten_path(node.get('d'), pixel_mm, tolerance_mm,
                                         origin=tuple(view[:2]), viewport_scale=sx)
            paths.extend(found)
            stats['source_paths'] += 1
            for key, value in counts.items():
                stats[key] += value
        else:
            for child in node:
                visit(child, actual)
    visit(root, {'fill':'black', 'stroke':'none', 'stroke-width':'1'})
    if not paths or sum(len(p) for p in paths) > MAX_POINTS:
        raise ValueError('No paths or output point limit exceeded')
    ET.register_namespace('', SVG_NS)
    result = ET.Element('{'+SVG_NS+'}svg', width=repr(width_mm)+'mm', height=repr(height_mm)+'mm',
                        viewBox=f'0 0 {width_mm!r} {height_mm!r}')
    report = dict(source=str(input_path), source_sha256=hashlib.sha256(data).hexdigest(),
                  pixel_mm=pixel_mm, tolerance_mm=tolerance_mm, width_mm=width_mm,
                  height_mm=height_mm, output_paths=len(paths), points=sum(map(len,paths)), **stats)
    ET.SubElement(result, '{'+SVG_NS+'}metadata').text = json.dumps(report, ensure_ascii=False)
    ET.SubElement(result, '{'+SVG_NS+'}desc').text = (
        'AutoTrace black unfilled paths flattened by adaptive de Casteljau; '
        'no path joining or smoothing. Tolerance is in this SVG mm space.')
    group = ET.SubElement(result, '{'+SVG_NS+'}g', fill='none', stroke='#000000',
                          attrib={'stroke-width':'0.3', 'stroke-linecap':'round', 'stroke-linejoin':'round'})
    for path in paths:
        commands = [f'{"M" if i == 0 else "L"}{x!r} {y!r}' for i,(x,y) in enumerate(path)]
        ET.SubElement(group, '{'+SVG_NS+'}path', d=' '.join(commands))
    Path(output_path).write_bytes(ET.tostring(result, encoding='utf-8', xml_declaration=True))
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('input_svg')
    ap.add_argument('output_svg')
    ap.add_argument('--pixel-mm', required=True, type=float)
    ap.add_argument('--tolerance-mm', required=True, type=float)
    args = ap.parse_args()
    print(json.dumps(convert_svg(args.input_svg, args.output_svg, args.pixel_mm,
                                 args.tolerance_mm), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
