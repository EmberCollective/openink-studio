"""Offline curve geometry and strict AutoTrace import regressions."""
import math
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'tools'))
from flatten_autotrace import flatten_cubic, flatten_path, convert_svg, _distance_to_segment
from centerline_svg import read_svg


class FlattenAutoTraceTests(unittest.TestCase):
    def test_curve_deviation_within_mm_tolerance(self):
        curves = [((0,0),(0,10),(10,10),(10,0)),
                  ((0,0),(10,10),(-10,10),(0,0)),
                  ((0,0),(10,0),(-10,0),(1,0))]
        tolerance = .02
        for control in curves:
            with self.subTest(control=control):
                points = [control[0]]+flatten_cubic(*control, tolerance)
                self.assertEqual(points[-1], control[-1])
                self.assertGreater(len(points), 2)
                for i in range(1001):
                    t = i/1000
                    weights = ((1-t)**3, 3*(1-t)**2*t, 3*(1-t)*t*t, t**3)
                    p = tuple(sum(w*c[axis] for w,c in zip(weights,control)) for axis in (0,1))
                    error = min(_distance_to_segment(p,a,b) for a,b in zip(points,points[1:]))
                    self.assertLessEqual(error, tolerance+1e-12)

    def test_straight_cubic_does_not_add_needless_points(self):
        self.assertEqual(flatten_cubic((0,0),(1,0),(2,0),(3,0),.01), [(3,0)])

    def test_subdivision_cap_does_not_silently_relax_tolerance(self):
        with self.assertRaisesRegex(ValueError, 'subdivision limit'):
            flatten_cubic((0,0),(0,10),(10,10),(10,0),.0001,max_depth=1)

    def test_relative_implicit_commands_and_close_are_preserved(self):
        paths, stats = flatten_path('m10 20 2 0 c0 1 2 1 2 0 0 -1 2 -1 2 0 z m10 10 l1 1z', .1, .001)
        self.assertEqual(len(paths), 2)
        self.assertEqual(paths[0][0], (1,2))
        self.assertEqual(paths[0][-1], paths[0][0])
        self.assertEqual(paths[1], [(2,3),(2.1,3.1),(2,3)])
        self.assertEqual(stats, {'cubic_segments':2,'close_commands':2})

    def test_separate_movetos_do_not_join_and_line_points_remain(self):
        paths, stats = flatten_path('M0 0 L1 0 2 0 M5 5 L6 6 Z', 1, .1)
        self.assertEqual(paths, [[(0,0),(1,0),(2,0)],[(5,5),(6,6),(5,5)]])
        self.assertEqual(stats['close_commands'], 1)

    def test_bad_commands_and_nonfinite_are_rejected(self):
        for data in ('Z', 'L0 0', 'M', 'M0 0 C1 2 3', 'M0 0 Q1 2 3 4',
                     'M0 0 H1', 'M0 0 Z1 2', 'M0 0 C0 0 1 1 NaN 2',
                     'M1e308 0 l1e308 0', 'M0 0@L1 2'):
            with self.subTest(data=data), self.assertRaises(ValueError):
                flatten_path(data, 1, .01)

    def convert(self, body, **attrs):
        properties = dict(width='100', height='100px', xmlns='http://www.w3.org/2000/svg')
        properties.update(attrs)
        attrib = ' '.join(f'{k}="{v}"' for k,v in properties.items())
        with tempfile.TemporaryDirectory() as folder:
            src, dst = Path(folder)/'in.svg', Path(folder)/'out.svg'
            src.write_text(f'<svg {attrib}>{body}</svg>', encoding='utf-8')
            report = convert_svg(src, dst, .1, .005)
            return report, read_svg(dst)

    def test_style_inheritance_pixel_scale_and_output_contract(self):
        report, paths = self.convert('<g style="fill: none; stroke: #000000; stroke-width: 1">'
                                     '<path d="M10 20 C10 30 20 30 20 20 Z M40 40 L50 50"/></g>')
        self.assertEqual(report['output_paths'], 2)
        self.assertEqual(report['source_paths'], 1)
        self.assertEqual(report['width_mm'], 10)
        self.assertEqual(report['height_mm'], 10)
        self.assertEqual(report['cubic_segments'], 1)
        self.assertEqual(report['close_commands'], 1)
        self.assertEqual(paths[0][0][:2], (1,2))
        self.assertEqual(paths[0][-1][:2], (1,2))
        self.assertEqual(paths[1], [(4,4,0),(5,5,1)])

    def test_viewbox_mapping(self):
        report, paths = self.convert('<path fill="none" stroke="black" d="M10 20 L20 30"/>',
                                     width='100px',height='200px',viewBox='10 20 50 100')
        self.assertEqual(paths, [[(0,0,0),(2,2,1)]])

    def test_filled_white_hidden_transformed_or_unsupported_geometry_rejected(self):
        bad = ['<path fill="black" stroke="black" d="M0 0 L1 1"/>',
               '<path fill="none" stroke="white" d="M0 0 L1 1"/>',
               '<path fill="none" stroke="#ffffff" d="M0 0 L1 1"/>',
               '<path fill="none" stroke="none" d="M0 0 L1 1"/>',
               '<path style="fill:none;stroke:black;opacity:0" d="M0 0 L1 1"/>',
               '<path fill="none" stroke="black" stroke-width="0" d="M0 0 L1 1"/>',
               '<g transform="scale(2)"><path fill="none" stroke="black" d="M0 0 L1 1"/></g>',
               '<rect width="20" height="20"/>',
               '<path fill="none" stroke="black" d="M0 0 L1 1"><animate/></path>']
        for body in bad:
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.convert(body)

    def test_invalid_dimensions_and_nonuniform_viewport_rejected(self):
        body = '<path fill="none" stroke="black" d="M0 0 L1 1"/>'
        for attrs in ({'width':'10mm'}, {'height':'0'}, {'width':'NaN'},
                      {'viewBox':'0 0 100 200'}, {'viewBox':'0 0 0 0'}):
            with self.subTest(attrs=attrs), self.assertRaises(ValueError):
                self.convert(body, **attrs)

    def test_tolerance_measured_after_pixel_conversion(self):
        paths, _ = flatten_path('M0 0 C0 100 100 100 100 0', .01, .01)
        expected = [(0,0)]+flatten_cubic((0,0),(0,1),(1,1),(1,0),.01)
        self.assertEqual(paths, [expected])
        for value in (0,-1,float('nan'),float('inf')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                flatten_path('M0 0 L1 1', 1, value)


if __name__ == '__main__':
    unittest.main()
