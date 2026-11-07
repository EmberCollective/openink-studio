"""Crop correction and recognition safety do not require downloading OCR models."""
import importlib.util
import math
import base64
import io
from pathlib import Path
import sys
import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw

HELPERS = Path(__file__).resolve().parents[1] / 'desktop/helpers'
sys.path.insert(0, str(HELPERS))
import handwriting_import as handwriting
import handwriting_paths as paths


class HandwritingTests(unittest.TestCase):
    def test_page_traces_once_then_counts_finished_splits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = Image.new('RGB', (30, 20), 'white')
            ImageDraw.Draw(image).line((4, 3, 24, 16), fill='black', width=2)
            image.save(root / 'source.png')
            progress_path = root / 'progress.json'
            events, fits = [], []
            writer = handwriting.write_progress
            def record(path, stage, done, total):
                writer(path, stage, done, total)
                events.append(json.loads(progress_path.read_text(encoding='utf-8')))
            def recognize(image, model_dir, path):
                handwriting.write_progress(path, 'model_load', 0, 2)
                handwriting.write_progress(path, 'model_load', 2, 2)
                handwriting.write_progress(path, 'ocr', 0, 0)
                return [dict(character=char, confidence=.9, bounds=[0, 0, 15, 20]) for char in ('见', '字')]
            def trace(image, output, command):
                event = json.loads(progress_path.read_text(encoding='utf-8'))
                self.assertEqual(event, dict(stage='trace', done=0, total=0))
                fits.append(image.size)
                Path(output).write_text(f'<svg width="{image.width}" height="{image.height}"><path fill="none" stroke="black" d="M8 8L12 16"/></svg>')
            request = dict(path=str(root / 'source.png'), progress_path=str(progress_path),
                           options=dict(page=1, dpi=300, threshold=180, conservative=True, autotrace_path='unused'))
            with patch.object(handwriting, 'write_progress', side_effect=record), \
                    patch.object(handwriting, 'recognize', side_effect=recognize), \
                    patch.object(handwriting, 'trace_image', side_effect=trace):
                result = handwriting.run(request)
            self.assertEqual(fits, [(42, 32)])
            self.assertTrue(all(c['svg'] and not c.get('error') for c in result['candidates']))
            counts = [e['done'] for e in events if e['stage'] == 'split']
            self.assertEqual(counts, sorted(counts))
            self.assertEqual(events[-1], dict(stage='split', done=2, total=2))
            self.assertTrue(all(c['crossing'] and c['needs_review'] for c in result['candidates']))
            self.assertEqual([e['total'] for e in events if e['stage'] == 'ocr'], [0])
            self.assertFalse(progress_path.with_suffix('.tmp').exists())

    def test_line_and_cubic_are_really_cut_without_clip_masks(self):
        root = ET.fromstring('<svg><path d="M-5 5L15 5 M-5 2C0 2 10 8 15 8"/></svg>')
        parsed = paths.parse_paths(root, (0, 0))
        result, crossing, assigned = paths.crop_paths(parsed, (0, 0, 10, 10))
        self.assertTrue(crossing)
        self.assertEqual(assigned, [0, 1])
        line = paths.parse_paths(ET.fromstring('<svg><path d="'+result[0]+'"/></svg>'), (0, 0))[0][1][0][0]
        self.assertAlmostEqual(line[0][0], 0, places=8)
        self.assertEqual(line[-1], (10., 5.))
        self.assertIn('C', result[1])
        cropped = paths.parse_paths(ET.fromstring('<svg><path d="'+result[1]+'"/></svg>'), (0, 0))
        segment = cropped[0][1][0][0]
        self.assertAlmostEqual(segment[0][0], 0, places=8)
        self.assertAlmostEqual(segment[-1][0], 10, places=8)
        for i in range(101):
            self.assertTrue(paths.inside(paths.split_bezier(segment, i/100)[0][-1], (0, 0, 10, 10)))

    def test_tangent_does_not_add_pen_lift_and_loop_preserves_exit_gap(self):
        tangent = ((0., 1.), (1., -1/3), (2., -1/3), (3., 1.))
        clipped = paths.clip_segment(tangent, (-1, 0, 4, 2))
        self.assertEqual(len(clipped), 1)
        self.assertEqual(clipped[0], tangent)
        loop = ((0., 0.), (20., 20.), (-20., 20.), (0., 0.))
        clipped = paths.clip_segment(loop, (-10, 0, 10, 5))
        self.assertEqual(len(clipped), 2)
        for segment in clipped:
            for i in range(51):
                self.assertTrue(paths.inside(paths.split_bezier(segment, i/50)[0][-1], (-10, 0, 10, 5)))

    def test_parser_keeps_subpaths_and_relative_implicit_commands(self):
        root = ET.fromstring('<svg><path d="m8 8 2 0 c0 1 1 2 2 2 z m10 0 l1 1"/></svg>')
        parsed = paths.parse_paths(root, (8, 8))
        self.assertEqual(len(parsed), 2)
        self.assertEqual(parsed[0][1][0][0], ((0., 0.), (2., 0.)))
        self.assertEqual(parsed[1][1][0][0][0], (10., 0.))
        for data in ('M0 0H10', 'M0 0Q1 2 3 4', 'M0 0C1 2', 'L1 1', 'M0 0@L1 1'):
            with self.assertRaises(ValueError):
                paths.parse_paths(ET.fromstring('<svg><path d="'+data+'"/></svg>'), (0, 0))

    def test_whole_page_retry_origin_and_crop_padding_align(self):
        image = Image.new('RGB', (40, 30), 'black')
        candidates = [dict(character='见', confidence=1., bounds=[10, 5, 10, 10])]
        def trace(padded, output, command):
            # Original page (11,6) -> pad6 + retry2 -> (19,14).
            Path(output).write_text(f'<svg viewBox="2 2 {padded.width} {padded.height}"><path d="M19 14L25 20"/></svg>')
        with patch.object(handwriting, 'trace_image', side_effect=trace):
            handwriting.fit_page(image, candidates, dict(threshold=180, conservative=True, autotrace_path='unused'), None)
        candidate = candidates[0]
        self.assertFalse(candidate['crossing'])
        root = ET.fromstring(candidate['svg'])
        group = list(root)[0]
        matrix = [float(v) for v in group.get('transform')[7:-1].split()]
        self.assertEqual(list(group)[0].get('d'), 'M11 6 L17 12')
        self.assertAlmostEqual(11*matrix[0]+matrix[4], 7/22*1000)
        self.assertAlmostEqual(6*matrix[3]+matrix[5], 7/22*1000)
        self.assertNotIn('clipPath', candidate['svg'])

    def test_page_failure_retains_candidates_for_manual_refit(self):
        image = Image.new('RGB', (40, 30), 'black')
        candidates = [dict(character='见', confidence=1., bounds=[10, 5, 10, 10])]
        with patch.object(handwriting, 'trace_image', side_effect=RuntimeError('native failure')):
            handwriting.fit_page(image, candidates, dict(threshold=180, conservative=True, autotrace_path='unused'), None)
        self.assertEqual(candidates[0]['character'], '见')
        self.assertIn('native failure', candidates[0]['error'])
        self.assertTrue(candidates[0]['crop_data_url'])

    def test_progress_file_lock_does_not_abort_work(self):
        with patch.object(Path, 'replace', side_effect=PermissionError('locked')), \
                patch.object(Path, 'write_text'):
            handwriting.write_progress('progress.json', 'trace', 1, 2)

    def test_preview_changes_page_without_ocr_or_trace(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'pages.tiff'
            Image.new('RGB', (20, 30), 'red').save(source, save_all=True, append_images=[Image.new('RGB', (20, 30), 'blue')])
            with patch.object(handwriting, 'recognize', side_effect=AssertionError('Preview must not run OCR')), \
                    patch.object(handwriting, 'fit_crop', side_effect=AssertionError('Preview must not fit curves')):
                for page, color in ((1, (255, 0, 0)), (2, (0, 0, 255))):
                    result = handwriting.run({'path': str(source), 'options': {'page': page, 'dpi': 300}, 'preview_only': True})
                    self.assertEqual((result['width'], result['height'], result['page'], result['page_count']), (20, 30, page, 2))
                    self.assertNotIn('candidates', result)
                    with Image.open(io.BytesIO(base64.b64decode(result['image_data_url'].split(',')[1]))) as preview:
                        self.assertEqual(preview.getpixel((0, 0)), color)
                with self.assertRaises(ValueError):
                    handwriting.run({'path': str(source), 'options': {'page': 3, 'dpi': 300}, 'preview_only': True})

    def test_preview_cli_needs_no_ocr_or_autotrace_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new('RGB', (12, 14), 'white').save(root / 'source.png')
            request = {'path': str(root / 'source.png'), 'options': {'page': 1, 'dpi': 300}, 'preview_only': True}
            (root / 'request.json').write_text(json.dumps(request), encoding='utf-8')
            run = subprocess.run([sys.executable, '-I', str(HELPERS / 'handwriting_import.py'), str(root / 'request.json'), str(root / 'result.json')], cwd=root, capture_output=True, timeout=30)
            self.assertEqual(run.returncode, 0, run.stderr.decode('utf-8', errors='replace'))
            result = json.loads((root / 'result.json').read_text(encoding='utf-8'))
            self.assertEqual((result['width'], result['height'], result['page_count']), (12, 14, 1))
            self.assertNotIn('candidates', result)

    def test_isolated_python_can_import_sibling_trace_module(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new('RGB', (20, 20), 'white').save(root / 'blank.png')
            request = {'path': str(root / 'blank.png'), 'options': {'page': 1, 'dpi': 300, 'threshold': 180}, 'bounds': [0, 0, 20, 20]}
            (root / 'request.json').write_text(json.dumps(request), encoding='utf-8')
            run = subprocess.run([sys.executable, '-I', str(HELPERS / 'handwriting_import.py'), str(root / 'request.json'), str(root / 'result.json')], cwd=root, capture_output=True, timeout=30)
            self.assertEqual(run.returncode, 0, run.stderr.decode('utf-8', errors='replace'))
            self.assertIn('error', json.loads((root / 'result.json').read_text(encoding='utf-8')))

    def test_out_of_page_and_nonfinite_crops_fail(self):
        for bounds in ([0, 0, 0, 20], [-1, 0, 20, 20], [90, 0, 20, 20], [0, 0, math.nan, 20]):
            with self.assertRaises(ValueError):
                handwriting.crop_bounds(bounds, 100, 100)
        self.assertEqual(handwriting.crop_bounds([1.2, 2.3, 8.5, 9.1], 100, 100), (1, 2, 10, 12))

    def test_empty_crop_does_not_invent_strokes(self):
        result = handwriting.fit_crop(Image.new('RGB', (20, 20), 'white'), [0, 0, 20, 20], {'threshold': 180})
        self.assertIn('error', result)
        self.assertEqual(result['svg'], '')

    def test_refit_changes_crop_and_preserves_curves_with_touch_warning(self):
        image = Image.new('RGB', (40, 30), 'white')
        ImageDraw.Draw(image).line((10, 5, 10, 25), fill='black', width=2)
        options = dict(threshold=180, conservative=True, autotrace_path='autotrace')
        seen = []
        def trace(crop, output, cmd):
            seen.append(crop.size)
            Path(output).write_text(f'<svg width="{crop.width}" height="{crop.height}"><path fill="none" stroke="black" d="M6 6C6 8 6 10 6 12"/></svg>')
        with patch.object(handwriting, 'trace_image', side_effect=trace):
            result = handwriting.fit_crop(image, [10, 4, 12, 23], options)
            other = handwriting.fit_crop(image, [5, 0, 25, 30], options)
        self.assertTrue(result['touching'])
        self.assertFalse(other['touching'])
        self.assertNotEqual(seen[0], seen[1])
        root = ET.fromstring(result['svg'])
        self.assertEqual(root.get('viewBox'), '0 0 1000 1000')
        self.assertIn('C6 8', result['svg'])
        with Image.open(io.BytesIO(base64.b64decode(result['crop_data_url'].split(',')[1]))) as preview:
            self.assertEqual(preview.size, seen[0])
            self.assertEqual(preview.getpixel((6, 7)), (0, 0, 0))

    def test_image_exif_and_page_validation(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'source.png'
            Image.new('RGBA', (12, 14), (0, 0, 0, 0)).save(path)
            image, count = handwriting.load_page(path, dict(page=1, dpi=300))
            self.assertEqual((image.size, count, image.getpixel((0, 0))), ((12, 14), 1, (255, 255, 255)))
            with self.assertRaises(ValueError):
                handwriting.load_page(path, dict(page=2, dpi=300))

    def test_retry_viewport_offset_is_removed_from_normalization(self):
        image = Image.new('RGB', (40, 30), 'black')
        def trace(crop, output, cmd):
            Path(output).write_text(f'<svg viewBox="2 2 {crop.width} {crop.height}"><path d="M8 8L10 10"/></svg>')
        with patch.object(handwriting, 'trace_image', side_effect=trace):
            result = handwriting.fit_crop(image, [0, 0, 40, 30], dict(threshold=180, conservative=True, autotrace_path='autotrace'))
        group = list(ET.fromstring(result['svg']))[0]
        matrix = [float(v) for v in group.get('transform')[7:-1].split()]
        scale = 1000 / 52
        self.assertAlmostEqual(matrix[4], -2 * scale)
        self.assertAlmostEqual(matrix[5], (1000 - 42 * scale) / 2 - 2 * scale)

    def test_failed_trace_is_reviewable_instead_of_losing_other_candidates(self):
        with patch.object(handwriting, 'trace_image', side_effect=RuntimeError('native failure')):
            result = handwriting.fit_crop(Image.new('RGB', (12, 12), 'black'), [0, 0, 12, 12],
                                          dict(threshold=180, conservative=True, autotrace_path='autotrace'))
        self.assertIn('native failure', result['error'])
        self.assertEqual(result['svg'], '')


if __name__ == '__main__':
    unittest.main()
