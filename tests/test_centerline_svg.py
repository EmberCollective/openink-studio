"""Offline parsing/selection regressions, including the actual Inko sample."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from centerline_svg import path_points, read_svg, bounds, select_window, place_strokes
from stepper_job import build_job


class CenterlineSvgTests(unittest.TestCase):
    def svg(self, content, **attrs):
        properties = dict(width='100mm', height='100mm', viewBox='0 0 100 100',
                          fill='none', stroke='black')
        properties.update(attrs)
        values = ' '.join(f'{key}="{value}"' for key, value in properties.items())
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'sample.svg'
            path.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" {values}>{content}</svg>', encoding='utf-8')
            return read_svg(path)

    def test_relative_implicit_lines_and_moveto_current_point(self):
        strokes = path_points('m 10 20 1 2 3 4 l -2 -3 1 0 m 5 6 2 3')
        self.assertEqual(strokes, [[(10,20,0),(11,22,1),(14,26,1),(12,23,1),(13,23,1)],
                                   [(18,29,0),(20,32,1)]])

    def test_absolute_implicit_lines_scientific_and_adjacent_signed_values(self):
        self.assertEqual(path_points('M1e1-2e0 3.5.5 L4,6 7,8'),
                         [[(10,-2,0),(3.5,.5,1),(4,6,1),(7,8,1)]])

    def test_missing_commands_or_coordinates_rejected(self):
        for data in ('1 2', 'L1 2', 'M', 'M0', 'M0 0 L', 'M0 0 L1',
                     'M0 0 L M1 2', 'M0 0 @ L1 2', 'M0 0 L1 2 3'):
            with self.subTest(data=data), self.assertRaises(ValueError):
                path_points(data)

    def test_curves_closepath_and_other_commands_are_not_silently_dropped(self):
        for command in ('C', 'c', 'Q', 'S', 'T', 'A', 'a', 'H', 'V', 'Z', 'z'):
            with self.subTest(command=command), self.assertRaises(ValueError):
                path_points('M0 0 '+command+' 1 2 3 4 5 6 7')

    def test_nonfinite_and_relative_overflow_rejected(self):
        for data in ('Mnan 0', 'Minf 0', 'M1e309 0', 'M1e308 0 l1e308 1'):
            with self.subTest(data=data), self.assertRaises(ValueError):
                path_points(data)

    def test_viewbox_origin_and_mm_scale(self):
        self.assertEqual(self.svg('<g><path d="M10 20 L20 30"/></g>',
                                  width='20mm', height='40mm', viewBox='10 20 100 200'),
                         [[(0,0,0),(2,2,1)]])

    def test_unimplemented_transform_styles_and_geometry_rejected(self):
        content = [
            '<g transform="translate(1 2)"><path d="M0 0 L1 2"/></g>',
            '<path transform="scale(2)" d="M0 0 L1 2"/>',
            '<g style="display:none"><path d="M0 0 L1 2"/></g>',
            '<path d="M0 0 L1 2" visibility="hidden"/>',
            '<path d="M0 0 L1 2"><animate attributeName="d"/></path>',
            '<rect x="0" y="0" width="10" height="10"/>',
            '<use href="#a"/>', '<svg><path d="M0 0 L1 2"/></svg>',
        ]
        for value in content:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.svg(value)

    def test_fill_and_stroke_inheritance_required_for_centerlines(self):
        self.assertEqual(self.svg('<g fill="none" stroke="#000"><path d="M0 0 L1 2"/></g>',
                                  fill='black', stroke='none'), [[(0,0,0),(1,2,1)]])
        self.assertEqual(self.svg('<g fill="inherit" stroke="inherit"><path d="M0 0 L1 2"/></g>'),
                         [[(0,0,0),(1,2,1)]])
        for content, attrs in [
            ('<path d="M0 0 L1 2"/>', {'fill':'black', 'stroke':'none'}),
            ('<g fill="red"><path d="M0 0 L1 2"/></g>', {}),
            ('<path fill="red" d="M0 0 L1 2"/>', {}),
            ('<g stroke="none"><path d="M0 0 L1 2"/></g>', {}),
            ('<path stroke="transparent" d="M0 0 L1 2"/>', {}),
        ]:
            with self.subTest(content=content, attrs=attrs), self.assertRaisesRegex(ValueError, 'Centerline'):
                self.svg(content, **attrs)

    def test_bad_viewport_and_conversion_overflow_rejected(self):
        for attrs in ({'width':'100px'}, {'width':'nanmm'}, {'height':'0mm'},
                      {'viewBox':'0 0 0 100'}, {'viewBox':'0 0 inf 100'},
                      {'viewBox':'0 0 100 200'}, {'viewBox':'0 0 1e-320 1e-320'}):
            with self.subTest(attrs=attrs), self.assertRaises(ValueError):
                self.svg('<path d="M0 0 L1 2"/>', **attrs)
        with self.assertRaises(ValueError):
            self.svg('<path d="M1e308 0 L1e308 2"/>', viewBox='-1e308 0 100 100')

    def test_window_preserves_whole_paths_and_rejects_cut(self):
        strokes = [[(0,0,0),(2,2,1)], [(5,5,0),(7,7,1)]]
        self.assertEqual(select_window(strokes, (4,4,8,8)), [strokes[1]])
        with self.assertRaisesRegex(ValueError, 'intersects'):
            select_window(strokes, (1,1,8,8))
        with self.assertRaisesRegex(ValueError, 'intersects'):
            select_window([[(-1,1,0),(3,1,1)]], (0,0,2,2))
        for window in ((8,8,9,9), (1,1,0,0), (0,0,float('nan'),1), (0,0,1)):
            with self.subTest(window=window), self.assertRaises(ValueError):
                select_window(strokes, window)

    def test_y_flip_and_placement_use_ink_bounds(self):
        source = [[(10,20,0),(12,25,1)], [(11,21,0),(13,24,1)]]
        self.assertEqual(place_strokes(source, at=(30,40), scale=2),
                         [[(30,50,0),(34,40,1)],[(32,48,0),(36,42,1)]])

    def test_invalid_placement_nonfinite_and_machine_range_rejected(self):
        source = [[(0,0,0),(2,2,1)]]
        for at, scale in (((float('nan'),0),1), ((0,0),0), ((0,0),-1),
                          ((0,0),float('inf')), ((0,0),1e308)):
            with self.subTest(at=at, scale=scale), self.assertRaises(ValueError):
                place_strokes(source, at, scale)
        for at in ((-1,0),(194,194)):
            with self.subTest(at=at), self.assertRaises(ValueError):
                build_job(place_strokes(source, at))
        with self.assertRaises(ValueError):
            bounds([[(1,1,0),(float('nan'),2,1)]])

    def test_actual_source_selection_equals_standalone_svg_and_job(self):
        if not (ROOT/'docs/samples/svg/selection.json').exists():
            self.skipTest('Local source selection fixture is excluded from public exports')
        manifest = json.loads((ROOT/'docs/samples/svg/selection.json').read_text(encoding='utf-8'))
        source = ROOT / manifest['source']
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), manifest['source_sha256'])
        selected = select_window(read_svg(source), manifest['selection_window_mm'])
        standalone = read_svg(ROOT/'docs/samples/svg/gong-shi-xi.svg')
        self.assertEqual(selected, standalone)
        self.assertEqual(len(selected), manifest['path_count'])
        self.assertEqual(sum(map(len, selected)), manifest['point_count'])
        self.assertEqual(list(bounds(selected)), manifest['bounds_mm'])
        self.assertEqual(build_job(place_strokes(selected, (35,5), 2)),
                         build_job(place_strokes(standalone, (35,5), 2)))


if __name__ == '__main__':
    unittest.main()
