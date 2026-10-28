"""Visible external raster pipeline: PyMuPDF/Pillow -> AutoTrace (no machine IO)."""
import argparse
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

# Optional direct-CLI development discovery. Rust additionally passes explicit
# module directories through PYTHONPATH, independently of helper location/CWD.
for parent in Path(__file__).resolve().parents:
    cached = parent / '.cache' / 'pdf-review'
    if cached.is_dir():
        sys.path.append(str(cached))


def trace_image(image, output, cmd):
    from PIL import ImageOps

    ppm = Path(output).with_suffix('.ppm')
    image.save(ppm)
    run_args = dict(check=True, capture_output=True, text=True,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        subprocess.run(cmd, **run_args)
    except subprocess.CalledProcessError as error:
        if error.returncode & 0xffffffff != 0xc0000005:
            raise
        # Some Windows AutoTrace inputs crash without a white guard border.
        ImageOps.expand(image, border=2, fill='white').save(ppm)
        try:
            subprocess.run(cmd, **run_args)
        except subprocess.CalledProcessError as retry:
            raise RuntimeError(
                f'AutoTrace crashed (0xC0000005); border retry also failed '
                f'(exit {retry.returncode}). Original image was not modified. '
                f'Try a cropped image or another AutoTrace build. {retry.stderr or ""}'
            ) from retry
        tree = ET.parse(output)
        root = tree.getroot()
        root.set('width', str(image.width))
        root.set('height', str(image.height))
        # Undo only the guard border; keep the original pixel-to-mm mapping.
        root.set('viewBox', f'2 2 {image.width} {image.height}')
        tree.write(output, encoding='utf-8', xml_declaration=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('source')
    p.add_argument('output')
    p.add_argument('--autotrace', required=True)
    p.add_argument('--page', type=int, default=1)
    p.add_argument('--dpi', type=float, default=300)
    p.add_argument('--threshold', type=int, default=180)
    p.add_argument('--conservative', action='store_true')
    p.add_argument('--filter-iterations', type=int, default=4)
    p.add_argument('--error-threshold', type=float, default=2.0)
    p.add_argument('--line-threshold', type=float, default=1.0)
    p.add_argument('--despeckle-level', type=int, default=0)
    a = p.parse_args()
    try:
        from PIL import Image
    except ImportError:
        raise RuntimeError('Missing Pillow. Install: python -m pip install Pillow PyMuPDF')
    if not 36 <= a.dpi <= 1200 or not float(a.dpi).is_integer() or not 0 <= a.threshold <= 255:
        raise ValueError('DPI must be an integer 36..1200; threshold must be 0..255')
    if not 0 <= a.filter_iterations <= 20 or not 0 <= a.despeckle_level <= 20 or not 0 < a.error_threshold <= 20 or not 0 < a.line_threshold <= 20:
        raise ValueError('AutoTrace filter/despeckle must be 0..20; error/line thresholds must be >0..20')
    if Path(a.source).suffix.lower() == '.pdf':
        try:
            import fitz
        except ImportError:
            raise RuntimeError('Missing PyMuPDF. Install: python -m pip install Pillow PyMuPDF')
        with fitz.open(a.source) as pdf:
            if not 1 <= a.page <= len(pdf):
                raise ValueError(f'PDF page must be 1..{len(pdf)}')
            page = pdf[a.page - 1]
            if page.rect.width * page.rect.height * (a.dpi / 72) ** 2 > 50_000_000:
                raise ValueError('Page raster exceeds 50 million pixels; lower DPI')
            pix = page.get_pixmap(dpi=round(a.dpi), colorspace=fitz.csRGB, alpha=False)
            image = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    else:
        image = Image.open(a.source)
        image.seek(a.page - 1)
        image = image.convert('RGBA')
        white = Image.new('RGBA', image.size, 'white')
        image = Image.alpha_composite(white, image).convert('RGB')
    if image.width * image.height > 50_000_000:
        raise ValueError('Image exceeds 50 million pixels')
    # Threshold only: no enlargement, morphological cleanup or invented strokes.
    image = image.convert('L').point(lambda v: 0 if v < a.threshold else 255).convert('RGB')
    ppm = Path(a.output).with_suffix('.ppm')
    if a.conservative:
        a.filter_iterations, a.error_threshold, a.line_threshold, a.despeckle_level = 0, 0.5, 0.5, 0
    cmd = [a.autotrace, '-centerline', '-background-color', 'FFFFFF',
           '-despeckle-level', str(a.despeckle_level),
           '-filter-iterations', str(a.filter_iterations),
           '-error-threshold', str(a.error_threshold), '-line-threshold', str(a.line_threshold)]
    cmd += ['-output-file', a.output, str(ppm)]
    trace_image(image, a.output, cmd)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'{e}\nPython: {sys.executable}\nHelper: {Path(__file__).resolve()}\nModule search: {sys.path}', file=sys.stderr)
        sys.exit(1)
