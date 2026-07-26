#!/usr/bin/env python3
"""Validate a trained YOLOv12 model and print the metrics that matter for a buggy.

    python scripts/validate.py --weights runs/detect/train/weights/best.pt \
                               --data data/data.yaml --split val

Writes confusion matrix + PR curves to runs/detect/val/. mAP50-95 is the headline
number; for a realtime detector also watch per-class recall (missed detections
are worse than a stray box on a moving buggy).
"""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--weights", required=True, help="path to best.pt")
    ap.add_argument("--data", default=str(ROOT / "data" / "data.yaml"))
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--split", default="val", choices=["train", "val", "test"])
    ap.add_argument("--device", default=None)
    ap.add_argument("--conf", type=float, default=0.001, help="low conf for metric calc")
    ap.add_argument("--iou", type=float, default=0.6)
    args = ap.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.weights)
    m = model.val(data=args.data, imgsz=args.imgsz, split=args.split,
                  device=args.device, conf=args.conf, iou=args.iou, plots=True)

    box = m.box
    print("\n===== Validation summary =====")
    print(f"mAP50-95 : {box.map:.4f}")
    print(f"mAP50    : {box.map50:.4f}")
    print(f"mAP75    : {box.map75:.4f}")
    print(f"precision: {box.mp:.4f}")
    print(f"recall   : {box.mr:.4f}")

    # Per-class breakdown — spot weak classes before deploying to the buggy.
    names = model.names
    try:
        print("\nPer-class mAP50-95:")
        for i, ap_i in zip(box.ap_class_index, box.maps[box.ap_class_index]):
            print(f"  {names[int(i)]:20s} {ap_i:.4f}")
    except Exception:
        pass  # ap arrays vary across ultralytics versions; headline metrics above suffice

    print(f"\nPlots saved under runs/detect/ (confusion_matrix.png, PR_curve.png).")


if __name__ == "__main__":
    main()
