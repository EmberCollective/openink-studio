"""Offline protocol regressions; never opens a real serial port."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from grbl_transport import GrblError, GrblTransport


class FakeSerial:
    def __init__(self, responses=(), initial=b'', chunksize=3):
        self.responses = list(responses)
        self.rx = bytearray(initial)
        self.writes = []
        self.closed = False
        self.chunksize = chunksize

    @property
    def in_waiting(self):
        return len(self.rx)

    def read(self, size):
        size = min(size, self.chunksize)
        result = bytes(self.rx[:size])
        del self.rx[:size]
        return result

    def write(self, data):
        self.writes.append(data)
        if self.responses:
            expected, response = self.responses.pop(0)
            if data != expected:
                raise AssertionError((data, expected))
            self.rx.extend(response)
        return len(data)

    def close(self):
        self.closed = True


class TransportTests(unittest.TestCase):
    def test_exact_ack_and_split_lines(self):
        sp = FakeSerial([(b'G21\n', b'[MSG:looks ok but is not ACK]\r\n<Run|MPos:0,0,0>\r\nok\r\n')])
        p = GrblTransport(serial_instance=sp)
        replies = p.send('G21')
        self.assertEqual(len(replies), 3)
        self.assertEqual(replies[-1], 'ok')

    def test_false_ack_times_out_and_latches(self):
        sp = FakeSerial([(b'G21\n', b'[MSG:ok]\r\n')])
        p = GrblTransport(serial_instance=sp)
        with self.assertRaises(GrblError):
            p.send('G21', timeout=0.01)
        with self.assertRaises(GrblError):
            p.send('G0X1')
        self.assertEqual(sp.writes, [b'G21\n'])

    def test_first_error_stops_job_without_pen_or_motion_cleanup(self):
        sp = FakeSerial([(b'G21\n', b'error:20\r\n')])
        p = GrblTransport(serial_instance=sp)
        with self.assertRaises(GrblError):
            p.run(['G21', 'G0X100', 'M5'])
        p.close()
        self.assertTrue(sp.closed)
        self.assertEqual(sp.writes, [b'G21\n'])

    def test_stale_ack_cannot_accept_new_command(self):
        sp = FakeSerial(initial=b'ok\r\n')
        p = GrblTransport(serial_instance=sp)
        with self.assertRaisesRegex(GrblError, 'stale ACK'):
            p.send('G0X1')
        self.assertEqual(sp.writes, [])

    def test_duplicate_ack_blocks_next_line(self):
        sp = FakeSerial([(b'G21\n', b'ok\r\nok\r\n')], chunksize=100)
        p = GrblTransport(serial_instance=sp)
        p.send('G21')
        with self.assertRaisesRegex(GrblError, 'stale ACK'):
            p.send('G0X1')
        self.assertEqual(sp.writes, [b'G21\n'])

    def test_blank_line_leftovers_do_not_block_next_command(self):
        sp = FakeSerial([(b'G21\n', b'ok\r\n\r\n'),
                         (b'G90\n', b'ok\r\n')], initial=b'\r\n\r\n', chunksize=100)
        p = GrblTransport(serial_instance=sp)
        p.send('G21', timeout=0.01)
        p.send('G90', timeout=0.01)
        self.assertFalse(p.failed)

    def test_ack_is_not_completion(self):
        sp = FakeSerial([(b'G1X1\n', b'ok\r\n'),
                         (b'?', b'<Run|MPos:0,0,0>\r\n'),
                         (b'?', b'<Idle|MPos:1,0,0>\r\n')])
        p = GrblTransport(serial_instance=sp)
        p.send('G1X1')
        self.assertEqual(sp.writes, [b'G1X1\n'])
        self.assertEqual(p.wait_idle(poll_interval=0).state, 'Idle')
        self.assertEqual(sp.writes[1:], [b'?', b'?'])

    def test_units_wco_and_cached_offset(self):
        sp = FakeSerial([(b'$$\n', b'$1=25\r\n$13=1\r\nok\r\n'),
                         (b'?', b'<Idle|MPos:1,2,3|WCO:0.5,1,0>\r\n'),
                         (b'?', b'<Idle|MPos:2,3,4>\r\n')])
        p = GrblTransport(serial_instance=sp)
        self.assertEqual(p.read_settings()[1], 25)
        first = p.query_status()
        self.assertEqual(first.mpos_mm, (25.4, 50.8, 76.19999999999999))
        self.assertEqual(first.wpos_mm[:2], (12.7, 25.4))
        second = p.query_status()
        self.assertAlmostEqual(second.wpos_mm[0], 38.1)

    def test_unknown_units_are_not_guessed(self):
        sp = FakeSerial([(b'?', b'<Idle|MPos:1,2,3|WCO:0,0,0>\r\n')])
        p = GrblTransport(serial_instance=sp)
        status = p.query_status()
        self.assertIsNone(status.mpos_mm)
        self.assertEqual(status.fields['MPos'], '1,2,3')

    def test_units_change_requires_reread(self):
        sp = FakeSerial([(b'$$\n', b'$13=1\r\nok\r\n'),
                         (b'$13=0\n', b'ok\r\n'),
                         (b'?', b'<Idle|MPos:1,2,3>\r\n')])
        p = GrblTransport(serial_instance=sp)
        p.read_settings()
        p.send('$13=0')
        self.assertIsNone(p.query_status().mpos_mm)

    def test_mm_override_ignores_setting_and_converts_wco_consistently(self):
        sp = FakeSerial([(b'$$\n', b'$13=1\r\nok\r\n'),
                         (b'?', b'<Idle|MPos:0,0,4|WCO:0,0,1>\r\n')])
        p = GrblTransport(serial_instance=sp, report_units='mm')
        self.assertEqual(p.read_settings()[13], 1)
        status = p.query_status()
        self.assertEqual(status.mpos_mm, (0, 0, 4))
        self.assertEqual(status.wco_mm, (0, 0, 1))
        self.assertEqual(status.wpos_mm, (0, 0, 3))

    def test_inch_override_works_before_settings_and_despite_setting_zero(self):
        sp = FakeSerial([(b'?', b'<Idle|MPos:0,0,1>\r\n'),
                         (b'$$\n', b'$13=0\r\nok\r\n'),
                         (b'?', b'<Idle|WPos:0,0,1|WCO:0,0,1>\r\n')])
        p = GrblTransport(serial_instance=sp, report_units='inch')
        self.assertEqual(p.query_status().mpos_mm, (0, 0, 25.4))
        self.assertEqual(p.read_settings()[13], 0)
        self.assertEqual(p.query_status().mpos_mm, (0, 0, 50.8))

    def test_bad_report_unit_override_rejected_before_open(self):
        with self.assertRaises(ValueError):
            GrblTransport(report_units='auto')

    def test_wpos_report_to_machine_and_offset_invalidation(self):
        sp = FakeSerial([(b'$$\n', b'$13=0\r\nok\r\n'),
                         (b'?', b'<Idle|WPos:1,2,3|WCO:10,20,30>\r\n'),
                         (b'G10L20P1X0\n', b'ok\r\n'),
                         (b'?', b'<Idle|MPos:11,22,33>\r\n')])
        p = GrblTransport(serial_instance=sp)
        p.read_settings()
        self.assertEqual(p.query_status().mpos_mm, (11, 22, 33))
        p.send('G10L20P1X0')
        self.assertIsNone(p.query_status().wpos_mm)

    def test_query_skips_old_status_and_does_not_send_newline(self):
        sp = FakeSerial([(b'?', b'<Run|MPos:1,0,0>\r\n')], initial=b'<Idle|MPos:0,0,0>\r\n')
        p = GrblTransport(serial_instance=sp)
        self.assertEqual(p.query_status().state, 'Run')
        self.assertEqual(sp.writes, [b'?'])

    def test_alarm_and_hold_are_not_success(self):
        for report in (b'ALARM:1\r\n', b'<Hold:0|MPos:0,0,0>\r\n'):
            with self.subTest(report=report):
                sp = FakeSerial([(b'?', report)])
                p = GrblTransport(serial_instance=sp)
                with self.assertRaises(GrblError):
                    p.wait_idle()

    def test_restart_during_command_is_fault(self):
        sp = FakeSerial([(b'G21\n', b'Grbl 1.1h [help]\r\nok\r\n')])
        p = GrblTransport(serial_instance=sp)
        with self.assertRaisesRegex(GrblError, 'restarted'):
            p.send('G21')

    def test_log_records_exact_tx_and_close_sends_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'trace.jsonl'
            sp = FakeSerial([(b'?', b'<Idle|MPos:0,0,0>\r\n')])
            with GrblTransport(serial_instance=sp, log_path=path) as p:
                p.query_status()
            entries = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
            self.assertEqual([x['value'] for x in entries if x['event'] == 'tx'], ['?'])
            self.assertEqual(entries[-1]['event'], 'close')
            self.assertTrue(sp.closed)

    def test_multiline_and_realtime_rejected_by_send(self):
        sp = FakeSerial()
        p = GrblTransport(serial_instance=sp)
        for command in ('G1X1\nG1X2', '?', '!', '~', '\x18', ''):
            with self.subTest(command=command):
                with self.assertRaises(ValueError):
                    p.send(command)
        self.assertFalse(sp.writes)


if __name__ == '__main__':
    unittest.main()
