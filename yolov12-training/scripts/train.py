#!/usr/bin/env python3
"""Train a YOLOv12 detector.

Loads defaults from a YAML config (configs/train_nano.yaml) and lets any CLI flag
override them, so the common case is just:

    python scripts/train.py                      # uses configs/train_nano.yaml
    python scripts/train.py --model yolo12s.pt   # bump to small
    python scripts/train.py --epochs 200 --imgsz 640 --batch 16
"""
import argparse
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DEFAULT_CFG = ROOT / "configs" / "train_nano.yaml"


def load_cfg(path: Path) -> dict:
    if path and path.exists():
        with open(path) as f:
            return yaml.safe_load(f) or {}
    return {}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cfg", type=Path, default=DEFAULT_CFG,
                    help="YAML of train() args (default: configs/train_nano.yaml)")
    # Common overrides. Anything omitted falls back to the YAML / Ultralytics defaults.
    ap.add_argument("--model", help="e.g. yolo12n.pt / yolo12s.pt / yolo12n.yaml")
    ap.add_argument("--data", help="path to data.yaml")
    ap.add_argument("--epochs", type=int)
    ap.add_argument("--imgsz", type=int)
    ap.add_argument("--batch", type=int)
    ap.add_argument("--device", help="GPU index, comma list, or 'cpu'")
    ap.add_argument("--name", help="run name under runs/detect/")
    ap.add_argument("--time", type=float,
                    help="max training HOURS (Ultralytics stops early + saves). "
                         "Used by the GitHub Actions CPU job to fit the 6h limit.")
    ap.add_argument("--cache", help="'ram' or 'disk' to cache images (speeds epochs)")
    ap.add_argument("--patience", type=int)
    ap.add_argument("--resume", action="store_true", help="resume last run")
    args = ap.parse_args()

    cfg = load_cfg(args.cfg)

    # CLI overrides (only keys the user actually set)
    overrides = {k: v for k, v in vars(args).items()
                 if k not in {"cfg", "resume"} and v is not None}
    cfg.update(overrides)
    if args.resume:
        cfg["resume"] = True

    # Resolve relative data/model paths against project root for convenience.
    if "data" in cfg and not Path(cfg["data"]).is_absolute():
        cand = ROOT / cfg["data"]
        if cand.exists():
            cfg["data"] = str(cand)

    # Make the data.yaml `path` absolute (Ultralytics won't resolve it relative
    # to the yaml). See scripts/_dataset.py.
    if "data" in cfg:
        from _dataset import resolve_data_yaml
        cfg["data"] = resolve_data_yaml(cfg["data"])

    model_name = cfg.pop("model", "yolo12n.pt")

    # Import here so --help works without torch installed.
    from ultralytics import YOLO

    print(f"→ model: {model_name}")
    print(f"→ train args: {cfg}")
    model = YOLO(model_name)
    results = model.train(**cfg)

    print("\n✅ Training done.")
    save_dir = getattr(results, "save_dir", None) or cfg.get("project", "runs/detect")
    print(f"Weights: {save_dir}/weights/best.pt")
    print("Next: scripts/validate.py then scripts/export.py")


if __name__ == "__main__":
    main()
