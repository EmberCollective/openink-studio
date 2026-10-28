"""Render a local ordinary font for optional AutoTrace centerline conversion."""
import sys
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

font_path, text_path, output, size, dpi = sys.argv[1:]
font = ImageFont.truetype(font_path, max(1, round(float(size) * float(dpi) / 25.4)))
text = open(text_path, encoding='utf-8').read()
probe = ImageDraw.Draw(Image.new('L', (1, 1), 255))
box = probe.multiline_textbbox((0, 0), text, font=font)
width, height = box[2] - box[0] + 8, box[3] - box[1] + 8
if width * height > 50_000_000:
    raise ValueError('Rendered text exceeds 50 million pixels')
image = Image.new('L', (width, height), 255)
ImageDraw.Draw(image).multiline_text((4-box[0], 4-box[1]), text, font=font, fill=0)
image.save(output)
Path(output).with_suffix('.json').write_text(json.dumps({
    'origin_x': 4-box[0],
    'baseline_y': 4-box[1]+font.getmetrics()[0],
    'advance': max(font.getlength(line) for line in text.split('\n')),
}), encoding='utf-8')
