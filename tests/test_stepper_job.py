"""Shared executor preflight remains independent of font/SVG parsing."""
import contextlib
import io
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from stepper_job import build_job, execute_job


def status(state='Idle', z=0, offset=(0, 0, 0)):
    return SimpleNamespace(state=state, raw='<'+state+'>',
                           mpos_mm=(0, 0, z), wpos_mm=(0, 0, z), wco_mm=offset)


class SharedStepperTests(unittest.TestCase):
    def test_import_does_not_load_font_or_crypto_modules(self):
        script = "import sys;sys.path.insert(0,'tools');import stepper_job;assert not {'gfont_write','gfont_tool','kenjoy_crypt','official_write'} & sys.modules.keys()"
        result = subprocess.run([sys.executable, '-c', script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_valid_preflight_runs_generated_lines_unchanged(self):
        lines = build_job([[(1, 2, 0), (3, 4, 1)]])
        with patch('stepper_job.GrblTransport') as transport, contextlib.redirect_stdout(io.StringIO()):
            p = transport.return_value.__enter__.return_value
            p.query_status.return_value = status()
            p.send.return_value = ['[GC:G1 G54 G17 G21 G90 G94 M5]', 'ok']
            end = status()
            p.run.return_value = end
            self.assertIs(execute_job(lines, 'FAKE', log_path='unused.jsonl'), end)
            transport.assert_called_once_with('FAKE', log_path='unused.jsonl', report_units='mm')
            p.run.assert_called_once_with(lines)
            p.send.assert_called_once_with('$G')

    def test_bad_start_refuses_job_before_motion(self):
        cases = [status(state='Run'), status(z=1), status(offset=(1, 0, 0))]
        for initial in cases:
            with self.subTest(initial=initial), patch('stepper_job.GrblTransport') as transport:
                p = transport.return_value.__enter__.return_value
                p.query_status.return_value = initial
                p.send.return_value = ['[GC:G0 G54 G21 G90]']
                with self.assertRaises(RuntimeError):
                    execute_job(['G21'], 'FAKE')
                p.run.assert_not_called()

    def test_wrong_work_system_refuses_job(self):
        with patch('stepper_job.GrblTransport') as transport:
            p = transport.return_value.__enter__.return_value
            p.query_status.return_value = status()
            p.send.return_value = ['[GC:G0 G55 G21 G90]']
            with self.assertRaisesRegex(RuntimeError, 'G54'):
                execute_job(['G21'], 'FAKE')
            p.run.assert_not_called()

    def test_final_z_must_be_verified(self):
        with patch('stepper_job.GrblTransport') as transport, contextlib.redirect_stdout(io.StringIO()):
            p = transport.return_value.__enter__.return_value
            p.query_status.return_value = status()
            p.send.return_value = ['[GC:G0 G54 G21 G90]']
            p.run.return_value = status(z=4)
            with self.assertRaisesRegex(RuntimeError, 'Final Z0'):
                execute_job(['G21'], 'FAKE')


if __name__ == '__main__':
    unittest.main()
