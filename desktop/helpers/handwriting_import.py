"""Local handwriting candidates and editable crop fitting; never controls hardware."""
import base64
import contextlib
import io
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import xml.etree.ElementTree as ET

# Embedded Python ._pth files also omit the executed script's directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Embedded Python ._pth files ignore PYTHONPATH; honor the explicit app override.
for module_dir in os.environ.get('OPENINK_PYTHON_MODULES', '').split(os.pathsep):
    if module_dir and Path(module_dir).is_dir():
        sys.path.append(module_dir)

from trace_import import trace_image
from handwriting_paths import parse_paths, crop_paths

MAX_PIXELS = 50_000_000
MAX_CANDIDATES = 1000
MODEL_FILES = ('ch_PP-OCRv5_det_server.onnx', 'ch_PP-OCRv5_rec_server.onnx')


def write_progress(path, stage, done, total):
    if not path:
        return
    target = Path(path)
    temporary = target.with_suffix('.tmp')
    try:
        temporary.write_text(json.dumps(dict(stage=stage, done=done, total=total)), encoding='utf-8')
        temporary.replace(target)
    except OSError:
        # Progress is best effort; a transient file lock must not discard fitted glyphs.
        pass


def load_page(path, options):
    from PIL import Image, ImageOps
    page, dpi = options['page'], options['dpi']
    if Path(path).suffix.lower() == '.pdf':
        import fitz
        with fitz.open(path) as pdf:
            count = len(pdf)
            if not 1 <= page <= count:
                raise ValueError(f'PDF 页码必须在 1 至 {count} 之间')
            p = pdf[page - 1]
            if p.rect.width * p.rect.height * (dpi / 72) ** 2 > MAX_PIXELS:
                raise ValueError('页面超过 5000 万像素，请降低 DPI')
            pix = p.get_pixmap(dpi=int(dpi), colorspace=fitz.csRGB, alpha=False)
            image = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    else:
        with Image.open(path) as source:
            count = getattr(source, 'n_frames', 1)
            if not 1 <= page <= count:
                raise ValueError(f'图片页码必须在 1 至 {count} 之间')
            source.seek(page - 1)
            if source.width * source.height > MAX_PIXELS:
                raise ValueError('图片超过 5000 万像素')
            rgba = ImageOps.exif_transpose(source).convert('RGBA')
            image = Image.alpha_composite(Image.new('RGBA', rgba.size, 'white'), rgba).convert('RGB')
    if image.width * image.height > MAX_PIXELS:
        raise ValueError('页面超过 5000 万像素')
    return image, count


def crop_bounds(bounds, width, height):
    if len(bounds) != 4 or any(not math.isfinite(v) for v in bounds):
        raise ValueError('切字范围必须为有限的 x、y、宽、高')
    x, y, w, h = bounds
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > width or y + h > height:
        raise ValueError('切字范围必须位于页面内且宽高大于零')
    return math.floor(x), math.floor(y), math.ceil(x + w), math.ceil(y + h)


def crop_data(image, bounds, options):
    from PIL import ImageOps
    rect = crop_bounds(bounds, *image.size)
    original = image.crop(rect)
    crop = original.convert('L').point(lambda v: 0 if v < options['threshold'] else 255)
    edges = (crop.crop((0, 0, crop.width, min(2, crop.height))),
             crop.crop((0, max(0, crop.height - 2), crop.width, crop.height)),
             crop.crop((0, 0, min(2, crop.width), crop.height)),
             crop.crop((max(0, crop.width - 2), 0, crop.width, crop.height)))
    touching = any(edge.getextrema()[0] == 0 for edge in edges)
    result = dict(svg='', touching=touching, crossing=False, width_mm=1000., height_mm=1000., advance_mm=1000.)
    preview = io.BytesIO()
    ImageOps.expand(original, border=6, fill='white').save(preview, format='PNG')
    result['crop_data_url'] = 'data:image/png;base64,' + base64.b64encode(preview.getvalue()).decode('ascii')
    return rect, crop, result


def trace_raster(image, options):
    f, e, line, d = (0, .5, .5, 0) if options.get('conservative') else (
        options['filter_iterations'], options['error_threshold'], options['line_threshold'], options['despeckle_level'])
    with tempfile.TemporaryDirectory(prefix='openink-glyph-') as temp:
        output = Path(temp) / 'trace.svg'
        cmd = [options['autotrace_path'], '-centerline', '-background-color', 'FFFFFF',
               '-despeckle-level', str(d), '-filter-iterations', str(f),
               '-error-threshold', str(e), '-line-threshold', str(line),
               '-output-file', str(output), str(output.with_suffix('.ppm'))]
        trace_image(image, output, cmd)
        return ET.parse(output).getroot()


def fit_crop(image, bounds, options):
    from PIL import ImageOps
    _, crop, result = crop_data(image, bounds, options)
    if crop.getextrema()[0] != 0:
        return dict(result, error='切字范围内没有可拟合的墨迹')
    padded = ImageOps.expand(crop.convert('RGB'), border=6, fill='white')
    try:
        root = trace_raster(padded, options)
        # Preserve original cubic curves, including the crash-recovery viewport offset.
        vb = [float(v) for v in root.get('viewBox', f'0 0 {padded.width} {padded.height}').replace(',', ' ').split()]
        scale = 1000 / max(vb[2:])
        dx, dy = (1000 - vb[2] * scale) / 2 - vb[0] * scale, (1000 - vb[3] * scale) / 2 - vb[1] * scale
        normalized = ET.Element('svg', {'xmlns': 'http://www.w3.org/2000/svg', 'width': '1000', 'height': '1000', 'viewBox': '0 0 1000 1000'})
        group = ET.SubElement(normalized, 'g', {'transform': f'matrix({scale} 0 0 {scale} {dx} {dy})'})
        for child in root:
            if child.tag.split('}')[-1] in ('path', 'g'):
                group.append(child)
        result['svg'] = ET.tostring(normalized, encoding='unicode')
    except Exception as exc:
        result['error'] = f'拟合失败：{exc}'
    return result


def fit_page(image, candidates, options, progress_path):
    from PIL import ImageOps
    total, paths, owners, error = len(candidates), [], {}, None
    if not total:
        write_progress(progress_path, 'split', 0, 0)
        return
    write_progress(progress_path, 'trace', 0, 0)
    try:
        binary = image.convert('L').point(lambda v: 0 if v < options['threshold'] else 255).convert('RGB')
        padded = ImageOps.expand(binary, border=6, fill='white')
        root = trace_raster(padded, options)
        vb = [float(v) for v in root.get('viewBox', f'0 0 {padded.width} {padded.height}').replace(',', ' ').split()]
        if len(vb) != 4 or not all(math.isfinite(v) for v in vb) or abs(vb[2]-padded.width) > 1e-6 or abs(vb[3]-padded.height) > 1e-6:
            raise ValueError('整页 AutoTrace 输出视口与源图尺寸不一致')
        paths = parse_paths(root, (vb[0] + 6, vb[1] + 6))
    except Exception as exc:
        error = f'整页拟合失败：{exc}；可在人工校准中按框重新拟合'
    write_progress(progress_path, 'split', 0, total)
    for index, candidate in enumerate(candidates):
        rect, crop, result = crop_data(image, candidate['bounds'], options)
        if error:
            result['error'] = error
        elif crop.getextrema()[0] != 0:
            result['error'] = '切字范围内没有可拟合的墨迹'
        else:
            data, result['crossing'], assigned = crop_paths(paths, rect)
            if not data:
                result['error'] = '字框内没有可用曲线，请调整边框后重新拟合'
            else:
                width, height = rect[2] - rect[0] + 12, rect[3] - rect[1] + 12
                scale = 1000 / max(width, height)
                dx, dy = (1000-width*scale)/2 + (6-rect[0])*scale, (1000-height*scale)/2 + (6-rect[1])*scale
                svg = ET.Element('svg', {'xmlns': 'http://www.w3.org/2000/svg', 'width': '1000', 'height': '1000', 'viewBox': '0 0 1000 1000'})
                group = ET.SubElement(svg, 'g', {'transform': f'matrix({scale} 0 0 {scale} {dx} {dy})', 'fill': 'none', 'stroke': 'black'})
                for d in data:
                    ET.SubElement(group, 'path', {'d': d})
                result['svg'] = ET.tostring(svg, encoding='unicode')
                for owner in assigned:
                    owners.setdefault(owner, []).append(index)
        candidate.update(result)
        write_progress(progress_path, 'split', index + 1, total)
    for shared in owners.values():
        if len(shared) > 1:
            for index in shared:
                candidates[index]['crossing'] = True


def resolve_models(explicit=None):
    roots = [Path(explicit)] if explicit else []
    if os.environ.get('OPENINK_OCR_MODELS'):
        roots.append(Path(os.environ['OPENINK_OCR_MODELS']))
    roots.extend((Path(__file__).resolve().parent / 'ocr-models',
                  Path(__file__).resolve().parent.parent / 'ocr-models',
                  Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'OpenInkStudio' / 'ocr-models'))
    for root in roots:
        if all((root / name).is_file() for name in MODEL_FILES):
            return root
    raise RuntimeError('缺少本地手写识别模型。运行 helpers/setup_handwriting.py --models <模型目录>，'
                       '然后在工具中选择该目录，或设置 OPENINK_OCR_MODELS。需要 PP-OCRv5 server 检测及识别 ONNX 模型。')


def recognize(image, model_dir, progress_path=None):
    write_progress(progress_path, 'model_load', 0, 2)
    try:
        from rapidocr import RapidOCR, ModelType, OCRVersion
    except ImportError as exc:
        raise RuntimeError(f'当前 Python 未安装手写识别组件：{sys.executable}。使用该解释器运行 '
                           '-m pip install -r helpers/requirements-handwriting.txt') from exc
    root = resolve_models(model_dir)
    params = {'Global.use_cls': False, 'Global.max_side_len': 3508,
              'Global.return_word_box': True, 'Global.return_single_char_box': True,
              'Global.text_score': 0.0, 'Global.log_level': 'error',
              'Global.model_root_dir': str(root),
              'Det.ocr_version': OCRVersion.PPOCRV5, 'Det.model_type': ModelType.SERVER,
              'Rec.ocr_version': OCRVersion.PPOCRV5, 'Rec.model_type': ModelType.SERVER,
              'Det.model_path': str(root / MODEL_FILES[0]), 'Rec.model_path': str(root / MODEL_FILES[1]),
              'EngineConfig.onnxruntime.intra_op_num_threads': 4,
              'EngineConfig.onnxruntime.inter_op_num_threads': 1}
    import numpy as np
    with contextlib.redirect_stdout(sys.stderr):
        engine = RapidOCR(params=params)
        # Pinned RapidOCR 3.10 loads lazily; finish model loading before reporting inference.
        engine._load_det_model()
        write_progress(progress_path, 'model_load', 1, 2)
        engine._load_rec_model()
        write_progress(progress_path, 'model_load', 2, 2)
        write_progress(progress_path, 'ocr', 0, 0)
        result = engine(np.asarray(image), return_word_box=True)
    words = result.word_results
    if words is None:
        return []
    candidates = []
    for line in words:
        for text, score, box in line:
            points = np.asarray(box, dtype=float)
            if points.shape != (4, 2) or not np.isfinite(points).all():
                continue
            x0, y0 = np.maximum(np.floor(points.min(axis=0)), [0, 0])
            x1, y1 = np.minimum(np.ceil(points.max(axis=0)), image.size)
            if x1 <= x0 or y1 <= y0:
                continue
            # Some OCR versions still return a word box; keep it for manual splitting/correction.
            candidates.append(dict(id=f'candidate-{len(candidates) + 1}', character=str(text),
                                   confidence=float(score), bounds=[float(x0), float(y0), float(x1-x0), float(y1-y0)]))
    if len(candidates) > MAX_CANDIDATES:
        raise ValueError('单页识别超过 1000 个候选，请先裁剪素材后分批导入')
    return candidates


def run(request):
    options = request['options']
    progress_path = request.get('progress_path')
    write_progress(progress_path, 'rasterize', 0, 1)
    image, count = load_page(request['path'], options)
    write_progress(progress_path, 'rasterize', 1, 1)
    if 'bounds' in request:
        return fit_crop(image, request['bounds'], options)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    page = dict(width=image.width, height=image.height, page=options['page'], page_count=count,
                image_data_url='data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii'))
    if request.get('preview_only'):
        return page
    candidates = recognize(image, request.get('model_dir'), progress_path)
    fit_page(image, candidates, options, progress_path)
    for candidate in candidates:
        candidate['needs_review'] = (candidate['touching'] or candidate['crossing'] or candidate['confidence'] < .85
                                     or len(candidate['character']) != 1 or bool(candidate.get('error')))
    candidates.sort(key=lambda c: not c['needs_review'])
    return dict(page, candidates=candidates)


if __name__ == '__main__':
    try:
        request = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        Path(sys.argv[2]).write_text(json.dumps(run(request), ensure_ascii=False, allow_nan=False), encoding='utf-8')
    except Exception as exc:
        print(f'{exc}\nPython: {sys.executable}', file=sys.stderr)
        sys.exit(1)
