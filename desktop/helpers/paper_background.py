"""Local paper raster preparation; never sends device commands or changes originals."""
import argparse
import base64
import json
from pathlib import Path
import sys

for parent in Path(__file__).resolve().parents:
    cached = parent / '.cache' / 'pdf-review'
    if cached.is_dir():
        sys.path.append(str(cached))

import numpy as np
import cv2
from PIL import Image, ImageOps

MAX_PIXELS = 50_000_000
MAX_FILE = 128 * 1024 * 1024


def load_source(path, page):
    path = Path(path)
    if path.stat().st_size > MAX_FILE:
        raise ValueError('背景文件超过 128 MB')
    if path.suffix.lower() == '.pdf':
        import fitz
        with fitz.open(path) as pdf:
            if not pdf.is_pdf or not 1 <= page <= len(pdf) or len(pdf) > 10000:
                raise ValueError('PDF 页码或页数无效')
            source = pdf[page - 1]
            if source.rect.width * source.rect.height * (150 / 72) ** 2 > MAX_PIXELS:
                raise ValueError('PDF 页面过大')
            pix = source.get_pixmap(dpi=150, colorspace=fitz.csRGB, alpha=False)
            image, count = Image.frombytes('RGB', (pix.width, pix.height), pix.samples), len(pdf)
    else:
        if path.suffix.lower() not in ('.png', '.jpg', '.jpeg') or page != 1:
            raise ValueError('背景只支持 PNG、JPEG 或 PDF；图片页码应为 1')
        with Image.open(path) as source:
            if source.width * source.height > MAX_PIXELS:
                raise ValueError('图片超过 5000 万像素')
            source = ImageOps.exif_transpose(source).convert('RGBA')
            image = Image.alpha_composite(Image.new('RGBA', source.size, 'white'), source).convert('RGB')
        count = 1
    image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
    return np.asarray(image), count


def validate_corners(points):
    p = np.asarray(points, dtype=np.float32)
    if p.shape != (4, 2) or not np.isfinite(p).all() or (p < 0).any() or (p > 1).any():
        raise ValueError('四角须是 0..1 范围内的四组坐标')
    edges = np.roll(p, -1, axis=0) - p
    following = np.roll(edges, -1, axis=0)
    crosses = edges[:, 0] * following[:, 1] - edges[:, 1] * following[:, 0]
    area = abs(np.dot(p[:, 0], np.roll(p[:, 1], -1)) - np.dot(p[:, 1], np.roll(p[:, 0], -1))) / 2
    if not (crosses > 0.001).all() or area < 0.05:
        raise ValueError('四角须按左上、右上、右下、左下顺序围成有效纸面')
    return p


def detect_corners(rgb):
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    _, mask = cv2.threshold(cv2.GaussianBlur(gray, (5, 5), 0), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    h, w = gray.shape
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        polygon = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
        if len(polygon) != 4 or cv2.contourArea(polygon) < w * h * .35:
            continue
        points = polygon.reshape(4, 2).astype(np.float32)
        center = points.mean(axis=0)
        points = points[np.argsort(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]))]
        points = np.roll(points, -int(np.argmin(points.sum(axis=1))), axis=0)
        points /= np.array([w - 1, h - 1])
        try:
            return validate_corners(points).tolist()
        except ValueError:
            pass
    return [[0., 0.], [1., 0.], [1., 1.], [0., 1.]]


def rectify(rgb, corners, width_mm, height_mm):
    p = validate_corners(corners)
    h, w = rgb.shape[:2]
    output_h = min(1600, max(h, w))
    output_w = max(64, round(output_h * width_mm / height_mm))
    if output_w > 1600:
        output_h = max(64, round(output_h * 1600 / output_w))
        output_w = 1600
    transform = cv2.getPerspectiveTransform(p * np.array([w - 1, h - 1], np.float32),
        np.array([[0, 0], [output_w - 1, 0], [output_w - 1, output_h - 1], [0, output_h - 1]], np.float32))
    return cv2.warpPerspective(rgb, transform, (output_w, output_h), borderValue=(255, 255, 255))


def normalize_light(rgb):
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    # A broad illumination field removes shadows without binary display output.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))
    field = cv2.GaussianBlur(cv2.morphologyEx(gray, cv2.MORPH_CLOSE, kernel), (0, 0), 15)
    corrected = cv2.divide(gray, np.maximum(field, 1), scale=255)
    return cv2.cvtColor(corrected, cv2.COLOR_GRAY2RGB)


def detect_lines(rgb, width_mm, height_mm):
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    h, w = gray.shape
    ink = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 7)
    segments = cv2.HoughLinesP(ink, 1, np.pi / 1800, max(20, w // 20), minLineLength=w * .2, maxLineGap=12)
    angles = []
    if segments is not None:
        for x1, y1, x2, y2 in segments.reshape(-1, 4):
            angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
            if abs(angle) <= 8:
                angles.append(angle)
    angle = float(np.median(angles)) if angles else 0.
    matrix = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1)
    aligned = cv2.warpAffine(ink, matrix, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
    aligned = cv2.morphologyEx(aligned, cv2.MORPH_CLOSE, np.ones((1, 7), np.uint8))
    # Allow a small vertical tolerance for antialiasing and local curvature;
    # otherwise long, one-pixel rules disappear during horizontal opening.
    tolerant = cv2.dilate(aligned, np.ones((3, 1), np.uint8))
    horizontal = cv2.morphologyEx(tolerant, cv2.MORPH_OPEN, np.ones((1, max(16, w // 20)), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(horizontal)
    inverse = cv2.invertAffineTransform(matrix)
    candidates = []
    for index in range(1, count):
        x, y, length, thickness, area = stats[index]
        if length < w * .06 or thickness > h * .025 or y < h * .015 or y > h * .985:
            continue
        ys, xs = np.nonzero(labels[y:y+thickness, x:x+length] == index)
        xs, ys = xs + x, ys + y
        vx, vy, cx, cy = cv2.fitLine(np.column_stack([xs, ys]).astype(np.float32), cv2.DIST_HUBER, 0, .01, .01).ravel()
        slope = float(vy / vx) if abs(vx) > 1e-6 else 0.
        candidates.append(dict(x0=float(x), x1=float(x + length - 1), slope=slope,
                               intercept=float(cy - cx * slope), pixels=np.column_stack([xs, ys])))

    # Compare fragments at the SAME x, not at their separate midpoints: a sloped
    # physical row has different midpoint heights on the left and right halves.
    # Complete-link grouping prevents a chain of nearby fragments joining rows.
    def compatible(a, b):
        left, right = max(a['x0'], b['x0']), min(a['x1'], b['x1'])
        at = (left + right) / 2
        error = abs((a['slope'] - b['slope']) * at + a['intercept'] - b['intercept'])
        tolerance = max(2.5, h * .004) if left <= right else max(4., h * .006)
        return error <= tolerance and abs(a['slope'] - b['slope']) <= .07

    groups = []
    for candidate in sorted(candidates, key=lambda c: -(c['x1'] - c['x0'])):
        matches = [group for group in groups if all(compatible(candidate, other) for other in group)]
        if matches:
            group = min(matches, key=lambda g: abs(candidate['slope'] * w/2 + candidate['intercept']
                - np.median([c['slope'] * w/2 + c['intercept'] for c in g])))
            group.append(candidate)
        else:
            groups.append([candidate])
    merged = []
    for group in groups:
        x0, x1 = min(c['x0'] for c in group), max(c['x1'] for c in group)
        if x1 - x0 < w * .25:
            continue
        pixels = np.concatenate([c['pixels'] for c in group]).astype(np.float32)
        vx, vy, cx, cy = cv2.fitLine(pixels, cv2.DIST_HUBER, 0, .01, .01).ravel()
        slope = float(vy / vx) if abs(vx) > 1e-6 else 0.
        # A mildly curved printed rule is represented by one best-fit straight
        # baseline across its observed extent, not by multiple numbered pieces.
        endpoints = np.array([[x0, float(cy + (x0 - cx) * slope), 1],
                              [x1, float(cy + (x1 - cx) * slope), 1]]) @ inverse.T
        endpoints = np.clip(endpoints, [0, 0], [w - 1, h - 1]) * [width_mm / w, height_mm / h]
        merged.append((float(endpoints[:, 1].mean()), endpoints.tolist()))
    merged.sort(key=lambda item: item[0])
    if len(merged) > 500:
        raise ValueError('候选横线超过 500 条，请裁剪到单页纸张')
    return [dict(id=f'line-{i + 1}', start=points[0], end=points[1]) for i, (_, points) in enumerate(merged)]


def prepare(source, output, page, width_mm, height_mm, corners=None, remove_shadow=True, process=False):
    if not np.isfinite([width_mm, height_mm]).all() or not 1 <= width_mm <= 210 or not 1 <= height_mm <= 297:
        raise ValueError('画布尺寸须位于 X210 / Y297 mm 软件范围内')
    rgb, page_count = load_source(source, page)
    points = validate_corners(corners).tolist() if corners is not None else detect_corners(rgb)
    lines = []
    if process:
        rgb = rectify(rgb, points, width_mm, height_mm)
        if remove_shadow:
            rgb = normalize_light(rgb)
        lines = detect_lines(rgb, width_mm, height_mm)
    Image.fromarray(rgb).save(output, format='PNG')
    payload = Path(output).read_bytes()
    if len(payload) > 10 * 1024 * 1024:
        raise ValueError('背景预览超过 10 MB')
    return dict(path=str(Path(output).resolve()), source_path=str(Path(source).resolve()), kind='image',
                page=page, page_count=page_count, width_mm=width_mm, height_mm=height_mm,
                data_url='data:image/png;base64,' + base64.b64encode(payload).decode('ascii'),
                guide_lines=lines, corners=points, processed=process, guides_visible=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('output')
    parser.add_argument('--page', type=int, default=1)
    parser.add_argument('--width', type=float, required=True)
    parser.add_argument('--height', type=float, required=True)
    parser.add_argument('--corners')
    parser.add_argument('--process', action='store_true')
    parser.add_argument('--remove-shadow', action='store_true')
    args = parser.parse_args()
    value = prepare(args.source, args.output, args.page, args.width, args.height,
                    json.loads(args.corners) if args.corners else None, args.remove_shadow, args.process)
    print(json.dumps(value, ensure_ascii=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
