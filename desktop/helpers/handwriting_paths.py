"""Split AutoTrace's line/cubic centerlines at crop edges without SVG clip masks."""
import math
import re

TOKEN = re.compile(r'[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')


def bounds(points):
    return (min(p[0] for p in points), min(p[1] for p in points),
            max(p[0] for p in points), max(p[1] for p in points))


def disjoint(a, b):
    return a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3]


def inside(point, rect):
    return rect[0] - 1e-7 <= point[0] <= rect[2] + 1e-7 and rect[1] - 1e-7 <= point[1] <= rect[3] + 1e-7


def parse_paths(root, origin):
    """Absolute page-space line/cubic segments, preserving separate subpaths."""
    paths = []
    segment_count = 0
    for node in root.iter():
        if 'transform' in node.attrib:
            raise ValueError('AutoTrace 输出包含不支持的坐标变换')
        if node.tag.split('}')[-1] != 'path':
            continue
        data = node.get('d', '')
        if TOKEN.sub('', data).strip(' ,\t\r\n'):
            raise ValueError('AutoTrace 路径格式无效')
        tokens = TOKEN.findall(data)
        i, command, current, start, segments = 0, None, (0., 0.), None, []

        def finish():
            if segments:
                paths.append((bounds([p for segment, _ in segments for p in segment]), list(segments)))
                segments.clear()

        def append(points):
            nonlocal segment_count
            # Page trace is padded; remove that padding and the native crash-retry origin.
            points = tuple((x - origin[0], y - origin[1]) for x, y in points)
            segments.append((points, bounds(points)))
            segment_count += 1
            if segment_count > 1_000_000:
                raise ValueError('整页拟合超过 100 万段，请裁剪素材或降低 DPI')

        while i < len(tokens):
            if tokens[i].isalpha():
                command = tokens[i]
                i += 1
                if command not in 'MmLlCcZz':
                    raise ValueError(f'AutoTrace 输出不支持的路径命令：{command}')
                if command in 'Zz':
                    if start is None:
                        raise ValueError('AutoTrace closepath 缺少起点')
                    if current != start:
                        append((current, start))
                    current, command = start, None
                    continue
                if i == len(tokens):
                    raise ValueError('AutoTrace 路径命令缺少坐标')
            if command is None:
                raise ValueError('AutoTrace 路径缺少命令')
            count = 6 if command in 'Cc' else 2
            if i + count > len(tokens):
                raise ValueError('AutoTrace 路径坐标不完整')
            try:
                values = [float(v) for v in tokens[i:i + count]]
            except ValueError as exc:
                raise ValueError('AutoTrace 路径坐标无效') from exc
            if not all(math.isfinite(v) for v in values):
                raise ValueError('AutoTrace 路径坐标不是有限数值')
            points = [(values[k], values[k + 1]) for k in range(0, count, 2)]
            if command.islower():
                points = [(x + current[0], y + current[1]) for x, y in points]
            if not all(math.isfinite(v) for point in points for v in point):
                raise ValueError('AutoTrace 相对坐标溢出')
            if command in 'Mm':
                finish()
                current = start = points[0]
                command = 'l' if command == 'm' else 'L'
            else:
                if start is None:
                    raise ValueError('AutoTrace 路径必须从 M 开始')
                append((current, *points))
                current = points[-1]
            i += count
        finish()
    return paths


def split_bezier(points, t):
    left, right, row = [points[0]], [points[-1]], list(points)
    while len(row) > 1:
        row = [((1-t)*a[0] + t*b[0], (1-t)*a[1] + t*b[1]) for a, b in zip(row, row[1:])]
        left.append(row[0])
        right.append(row[-1])
    return tuple(left), tuple(reversed(right))


def clip_segment(points, rect):
    hull = bounds(points)
    if disjoint(hull, rect):
        return []
    if inside((hull[0], hull[1]), rect) and inside((hull[2], hull[3]), rect):
        return [points]
    import numpy as np
    cuts = [0., 1.]
    for axis in (0, 1):
        values = [p[axis] for p in points]
        coefficients = ([values[1] - values[0], values[0]] if len(points) == 2 else
                        [-values[0] + 3*values[1] - 3*values[2] + values[3],
                         3*values[0] - 6*values[1] + 3*values[2], -3*values[0] + 3*values[1], values[0]])
        for edge in (rect[axis], rect[axis+2]):
            polynomial = coefficients[:-1] + [coefficients[-1] - edge]
            for root in np.roots(polynomial):
                if abs(root.imag) < 1e-7 and 0 < root.real < 1:
                    cuts.append(float(root.real))
    cuts.sort()
    unique = [cuts[0]]
    for value in cuts[1:]:
        if value - unique[-1] > 1e-10:
            unique.append(value)
    # Merge adjacent inside intervals, so tangency to an edge does not add fake pen lifts.
    intervals = []
    for a, b in zip(unique, unique[1:]):
        midpoint = split_bezier(points, (a+b)/2)[0][-1]
        if inside(midpoint, rect):
            if intervals and abs(intervals[-1][1] - a) < 1e-10:
                intervals[-1] = (intervals[-1][0], b)
            else:
                intervals.append((a, b))
    result = []
    for a, b in intervals:
        prefix = split_bezier(points, b)[0]
        result.append(split_bezier(prefix, a/b)[1] if a > 0 else prefix)
    return result


def crop_paths(paths, rect):
    """Return path d strings, whether real geometry was cut, and source path indices."""
    output, crossing, owners = [], False, []
    for index, (hull, segments) in enumerate(paths):
        if disjoint(hull, rect):
            continue
        pieces, previous, clipped = [], None, False
        for points, segment_hull in segments:
            parts = [] if disjoint(segment_hull, rect) else clip_segment(points, rect)
            if len(parts) != 1 or parts[0] != points:
                clipped = True
            if not parts:
                previous = None
            for part_index, part in enumerate(parts):
                if part_index or previous is None or math.dist(previous, part[0]) > 1e-7:
                    pieces.append('M' + ' '.join(f'{v:.12g}' for v in part[0]))
                pieces.append(('L' if len(part) == 2 else 'C') + ' '.join(f'{v:.12g}' for p in part[1:] for v in p))
                previous = part[-1]
        if pieces:
            output.append(' '.join(pieces))
            owners.append(index)
            crossing = crossing or clipped
    return output, crossing, owners
