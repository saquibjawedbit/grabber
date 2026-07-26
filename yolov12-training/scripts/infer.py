#!/usr/bin/env python3
"""Run inference and report FPS — your realtime sanity check on the buggy.

    python scripts/infer.py --weights best.pt --source 0            # webcam
    python scripts/infer.py --weights best.engine --source clip.mp4 # video (Jetson)
    python scripts/infer.py --weights best.pt --source data/images/test  # folder

Works with any exported format Ultralytics can load (.pt/.onnx/.engine/...).
The printed FPS is what actually matters for the buggy — the COCO table is only a
ranking. Aim for well above your control-loop rate.
"""
import argparse
import time
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--source", default="0", help="0=cam, a video file, image, or folder")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--iou", type=float, default=0.45)
    ap.add_argument("--device", default=None)
    ap.add_argument("--save", action="store_true", help="save annotated output")
    ap.add_argument("--show", action="store_true", help="live window (needs a display)")
    args = ap.parse_args()

    from ultralytics import YOLO

    source = int(args.source) if args.source.isdigit() else args.source
    model = YOLO(args.weights)

    # stream=True yields per-frame results and keeps memory flat on long videos.
    results = model.predict(source=source, imgsz=args.imgsz, conf=args.conf,
                            iou=args.iou, device=args.device, save=args.save,
                            show=args.show, stream=True, verbose=False)

    n, t_infer, t0 = 0, 0.0, time.time()
    for r in results:
        n += 1
        # r.speed is per-frame ms: {preprocess, inference, postprocess}
        if getattr(r, "speed", None):
            t_infer += r.speed.get("inference", 0.0)
    wall = time.time() - t0

    if n:
        print(f"\nFrames: {n}")
        if t_infer:
            print(f"Model inference: {t_infer / n:.2f} ms/frame  (~{1000 * n / t_infer:.1f} FPS pure model)")
        print(f"End-to-end: {wall:.2f}s  (~{n / wall:.1f} FPS incl. I/O)")
        print("→ The end-to-end FPS on the buggy is the number that must beat your control loop.")
    else:
        print("No frames processed — check --source.")


if __name__ == "__main__":
    main()
