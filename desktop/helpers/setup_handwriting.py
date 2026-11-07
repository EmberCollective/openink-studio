"""Explicit opt-in model download; normal recognition only opens local models."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))


def main():
    parser = argparse.ArgumentParser(description='Download PP-OCRv5 server ONNX models for local handwriting recognition')
    parser.add_argument('--models', type=Path, required=True)
    args = parser.parse_args()
    from rapidocr import RapidOCR, ModelType, OCRVersion
    import numpy as np
    args.models.mkdir(parents=True, exist_ok=True)
    engine = RapidOCR(params={'Global.model_root_dir': str(args.models.resolve()), 'Global.use_cls': False,
                             'Det.ocr_version': OCRVersion.PPOCRV5, 'Det.model_type': ModelType.SERVER,
                             'Rec.ocr_version': OCRVersion.PPOCRV5, 'Rec.model_type': ModelType.SERVER})
    # Both models initialize lazily; exercise each explicitly, including recognizer on blank input.
    image = np.full((48, 320, 3), 255, dtype=np.uint8)
    engine(image, use_det=True, use_rec=False)
    engine(image, use_det=False, use_rec=True)
    from handwriting_import import resolve_models
    print(f'Models ready: {resolve_models(str(args.models.resolve()))}')


if __name__ == '__main__':
    main()
