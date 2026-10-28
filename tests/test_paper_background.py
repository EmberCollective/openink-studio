"""Synthetic paper processing checks; no device or private user-photo fixtures."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageDraw

SPEC = importlib.util.spec_from_file_location('paper_background', Path(__file__).resolve().parents[1] / 'desktop/helpers/paper_background.py')
paper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(paper)


class PaperBackgroundTests(unittest.TestCase):
    def ruled(self):
        image = Image.new('RGB', (800, 1100), 'white')
        draw = ImageDraw.Draw(image)
        for y in [100, 180, 280, 400, 550, 730, 900]:
            draw.line((65, y, 735, y), fill=(210, 210, 210), width=2)
        return image

    def test_nonuniform_faint_lines_are_not_equalized(self):
        lines = paper.detect_lines(np.asarray(self.ruled()), 200, 275)
        self.assertEqual(len(lines), 7)
        np.testing.assert_allclose([line['start'][1] for line in lines], np.array([100,180,280,400,550,730,900]) / 4, atol=.6)
        self.assertGreater(lines[-1]['start'][1] - lines[-2]['start'][1], lines[1]['start'][1] - lines[0]['start'][1])

    def test_shadow_normalization_keeps_lines_and_tilt(self):
        rgb = np.asarray(self.ruled()).astype(float)
        rgb *= np.linspace(.55, 1, 800)[None, :, None]
        rotated = Image.fromarray(rgb.astype('uint8')).rotate(2, fillcolor='white')
        cleaned = paper.normalize_light(np.asarray(rotated))
        self.assertGreater(cleaned[400, 90, 0], 235)
        lines = paper.detect_lines(cleaned, 200, 275)
        self.assertEqual(len(lines), 7)
        self.assertGreater(abs(lines[0]['start'][1] - lines[0]['end'][1]), 2)

    def test_split_sloping_rows_merge_at_shared_x_not_midpoint_height(self):
        image = Image.new('RGB', (1000, 1200), 'white')
        draw = ImageDraw.Draw(image)
        for y in [120, 310, 700]:
            for left, right in [(60, 430), (550, 940)]:
                draw.line((left, y + left*.035, right, y + right*.035), fill=(110,110,110), width=2)
        lines = paper.detect_lines(np.asarray(image), 200, 240)
        self.assertEqual(len(lines), 3)
        for line, y in zip(lines, [120,310,700]):
            self.assertLess(line['start'][0], 14)
            self.assertGreater(line['end'][0], 186)
            self.assertAlmostEqual(line['start'][1], (y+60*.035)*.2, delta=.7)
            self.assertAlmostEqual(line['end'][1], (y+940*.035)*.2, delta=.7)

    def test_overlapping_fragments_merge_but_close_nonuniform_rows_survive(self):
        image = Image.new('RGB', (1000, 1200), 'white')
        draw = ImageDraw.Draw(image)
        # Duplicate/overlapping edges only two pixels apart are one printed row;
        # the distinct row eight pixels lower must not be swallowed by chaining.
        draw.line((50,200,620,200), fill=(90,90,90), width=1)
        draw.line((370,202,950,202), fill=(90,90,90), width=1)
        for y in [210, 285, 430]:
            draw.line((50,y,950,y), fill=(90,90,90), width=1)
        lines = paper.detect_lines(np.asarray(image), 200, 240)
        self.assertEqual(len(lines), 4)
        np.testing.assert_allclose([np.mean([v['start'][1],v['end'][1]]) for v in lines],
                                   [40.2,42,57,86], atol=.4)

    def test_mildly_curved_rules_have_one_full_extent_best_fit_each(self):
        image = Image.new('RGB', (1000, 1200), 'white')
        draw = ImageDraw.Draw(image)
        for y in [130, 310, 580, 900]:
            points = [(x, y + 7*((x-500)/450)**2 + .012*x) for x in range(50,951)]
            draw.line(points, fill=(130,130,130), width=2)
        lines = paper.detect_lines(np.asarray(image), 200, 240)
        self.assertEqual(len(lines), 4)
        for line, y in zip(lines, [130,310,580,900]):
            self.assertLess(line['start'][0], 15)
            self.assertGreater(line['end'][0], 185)
            self.assertAlmostEqual(np.mean([line['start'][1],line['end'][1]]), (y+8)*.2, delta=1)

    def test_preview_process_preserve_original_and_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / '照片.png'; source.write_bytes(b'')
            self.ruled().save(source); original = source.read_bytes()
            output = Path(directory) / 'result.png'
            preview = paper.prepare(source, output, 1, 200, 275, process=False)
            self.assertFalse(preview['processed']); self.assertEqual(preview['guide_lines'], [])
            processed = paper.prepare(source, output, 1, 200, 275, corners=[[0,0],[1,0],[1,1],[0,1]], process=True)
            self.assertTrue(processed['processed']); self.assertEqual(len(processed['guide_lines']), 7)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(processed['source_path'], str(source.resolve()))
            self.assertTrue(processed['data_url'].startswith('data:image/png;base64,'))
            with Image.open(output) as result:
                self.assertAlmostEqual(result.width / result.height, 200 / 275, places=3)

    def test_invalid_corners_dimensions_and_corrupt_source(self):
        for points in [[[0,0],[1,1],[1,0],[0,1]], [[0,0],[1,0],[1,1],[-1,1]], [[0,0],[0,0],[1,1],[0,1]]]:
            with self.assertRaises(ValueError): paper.validate_corners(points)
        with self.assertRaises(ValueError): paper.prepare('missing.png','unused.png',1,999,297)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'bad.png'; source.write_bytes(b'not an image')
            with self.assertRaises(Exception): paper.load_source(source, 1)

    def test_perspective_quad_and_pdf_page_selection(self):
        import fitz
        original = np.asarray(self.ruled())
        corners = np.array([[.12,.05],[.87,.11],[.96,.93],[.05,.89]], np.float32)
        transform = paper.cv2.getPerspectiveTransform(np.array([[0,0],[799,0],[799,1099],[0,1099]], np.float32), corners * np.array([799,1099],np.float32))
        photographed = paper.cv2.warpPerspective(original, transform, (800,1100), borderValue=(90,90,90))
        corrected = paper.rectify(photographed, corners, 200,275)
        lines = paper.detect_lines(corrected,200,275)
        self.assertEqual(len(lines),7)
        np.testing.assert_allclose([line['start'][1] for line in lines], np.array([100,180,280,400,550,730,900])/4, atol=1)
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'paper.pdf'
            with fitz.open() as pdf:
                pdf.new_page(width=200,height=275)
                page=pdf.new_page(width=200,height=275)
                page.draw_line((20,90),(180,90),color=(.3,.3,.3),width=1)
                pdf.save(source)
            result=paper.prepare(source,Path(directory)/'page.png',2,200,275,process=True)
            self.assertEqual(result['page_count'],2)
            self.assertEqual(len(result['guide_lines']),1)
            self.assertAlmostEqual(result['guide_lines'][0]['start'][1],90,delta=1)
            with self.assertRaises(ValueError): paper.load_source(source,3)

    def test_manual_four_corners_rectify_full_photo_not_just_contrast(self):
        # A photographed trapezoid on a bright desk deliberately makes automatic
        # paper detection ambiguous. Only the supplied four corners locate paper.
        sheet = self.ruled()
        draw = ImageDraw.Draw(sheet)
        markers = [(70, 45, (220, 20, 20)), (730, 45, (20, 170, 20)),
                   (730, 1045, (20, 20, 220)), (70, 1045, (190, 20, 190))]
        for x, y, color in markers:
            draw.rectangle((x-14, y-14, x+14, y+14), fill=color)
        photo_size = (1200, 1400)
        photo_corners = np.array([[330, 160], [850, 310], [1110, 1290], [90, 1120]], np.float32)
        transform = paper.cv2.getPerspectiveTransform(
            np.array([[0,0],[799,0],[799,1099],[0,1099]], np.float32), photo_corners)
        photo = paper.cv2.warpPerspective(np.asarray(sheet), transform, photo_size, borderValue=(245,245,245))
        normalized = photo_corners / np.array([1199,1399], np.float32)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'perspective.png'
            output = Path(directory) / 'rectified.png'
            Image.fromarray(photo).save(source)
            original = source.read_bytes()
            preview = paper.prepare(source, output, 1, 200, 275, process=False)
            with Image.open(output) as image:
                self.assertEqual(image.size, photo_size)
            self.assertEqual(preview['guide_lines'], [])
            for remove_shadow in (False, True):
                result = paper.prepare(source, output, 1, 200, 275,
                    corners=normalized.tolist(), remove_shadow=remove_shadow, process=True)
                with Image.open(output) as image:
                    corrected = np.asarray(image)
                    self.assertAlmostEqual(image.width / image.height, 200 / 275, delta=.001)
                    self.assertNotEqual(image.size, photo_size)
                # Both endpoints of every line must match the original rectangle,
                # even though all seven lines slope in the simulated photograph.
                self.assertEqual(len(result['guide_lines']), 7)
                for line, y in zip(result['guide_lines'], [100,180,280,400,550,730,900]):
                    self.assertAlmostEqual(line['start'][1], y/4, delta=.6)
                    self.assertAlmostEqual(line['end'][1], y/4, delta=.6)
                    self.assertAlmostEqual(line['start'][0], 65/4, delta=1)
                    self.assertAlmostEqual(line['end'][0], 735/4, delta=1)
                if not remove_shadow:
                    # Four independent colored fiducials must return to their
                    # known rectangular positions. Contrast-only processing,
                    # a bounding-box crop, or ignoring corners cannot pass.
                    for x, y, color in markers:
                        distance = np.linalg.norm(corrected.astype(float) - color, axis=2)
                        ys, xs = np.nonzero(distance < 25)
                        self.assertGreater(len(xs), 100)
                        self.assertAlmostEqual(xs.mean()/(corrected.shape[1]-1), x/799, delta=.003)
                        self.assertAlmostEqual(ys.mean()/(corrected.shape[0]-1), y/1099, delta=.003)
                self.assertEqual(source.read_bytes(), original)
                np.testing.assert_allclose(result['corners'], normalized, atol=1e-6)


if __name__ == '__main__':
    unittest.main()
