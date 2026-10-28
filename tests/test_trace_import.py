"""AutoTrace native-crash recovery must preserve source pixels and coordinates."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from PIL import Image

SPEC = importlib.util.spec_from_file_location(
    'trace_import', Path(__file__).resolve().parents[1] / 'desktop/helpers/trace_import.py')
trace_import = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trace_import)


class TraceImportTests(unittest.TestCase):
    def test_access_violation_retry_preserves_pixels_and_original_viewport(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'trace.svg'
            image = Image.new('RGB', (64, 48), 'white')
            image.putpixel((0, 47), (0, 0, 0))
            calls = []

            def run(cmd, **kwargs):
                calls.append(cmd)
                with Image.open(output.with_suffix('.ppm')) as raster:
                    if len(calls) == 1:
                        self.assertEqual(raster.tobytes(), image.tobytes())
                        raise subprocess.CalledProcessError(0xc0000005, cmd)
                    self.assertEqual(raster.size, (68, 52))
                    self.assertEqual(raster.crop((2, 2, 66, 50)).tobytes(), image.tobytes())
                    self.assertEqual(raster.getpixel((0, 49)), (255, 255, 255))
                output.write_text('<svg width="68" height="52"><path d="M2 49L12 49"/></svg>')

            with patch.object(trace_import.subprocess, 'run', side_effect=run):
                trace_import.trace_image(image, output, ['autotrace', 'original-parameters'])
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0], calls[1])
            root = ET.parse(output).getroot()
            self.assertEqual((root.get('width'), root.get('height')), ('64', '48'))
            self.assertEqual(root.get('viewBox'), '2 2 64 48')
            self.assertEqual(root.find('path').get('d'), 'M2 49L12 49')

    def test_other_errors_are_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(trace_import.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, [])) as run:
                with self.assertRaises(subprocess.CalledProcessError):
                    trace_import.trace_image(Image.new('RGB', (4, 4)), Path(directory) / 'trace.svg', [])
                self.assertEqual(run.call_count, 1)

    def test_second_crash_stops_with_actionable_error(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(trace_import.subprocess, 'run', side_effect=subprocess.CalledProcessError(-1073741819, [])) as run:
                with self.assertRaisesRegex(RuntimeError, 'border retry also failed'):
                    trace_import.trace_image(Image.new('RGB', (4, 4)), Path(directory) / 'trace.svg', [])
                self.assertEqual(run.call_count, 2)

    def test_successful_first_attempt_is_not_rewritten(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'trace.svg'
            expected = '<svg width="4" height="4"/>'
            def run(*args, **kwargs):
                output.write_text(expected)
            with patch.object(trace_import.subprocess, 'run', side_effect=run) as mocked:
                trace_import.trace_image(Image.new('RGB', (4, 4)), output, [])
                self.assertEqual(mocked.call_count, 1)
            self.assertEqual(output.read_text(), expected)


if __name__ == '__main__':
    unittest.main()
