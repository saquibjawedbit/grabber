#!/usr/bin/env python3
"""Export best.pt to an edge-friendly format for the buggy.

Jetson (TensorRT engine, FP16 — the usual buggy target):
    python scripts/export.py --weights runs/detect/train/weights/best.pt \
                             --format engine --half --imgsz 512

CPU / Raspberry Pi (ONNX or NCNN, INT8 for speed):
    python scripts/export.py --weights .../best.pt --format onnx --int8 --imgsz 512
    python scripts/export.py --weights .../best.pt --format ncnn --imgsz 512

⚠️ Tiny objects: this dataset's signs are ~15 px. Normally you'd shrink the
input size for FPS, but here that erases the objects — keep --imgsz 512 (native).
If you MUST go faster, drop to 448 and re-validate; do NOT go to 320/416 blindly.
Always re-run validate.py --imgsz <same size> to see the accuracy you're trading.
"""
import argparse

VALID = ["onnx", "engine", "ncnn", "tflite", "openvino", "torchscript",
         "coreml", "saved_model", "pb", "edgetpu"]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--format", default="onnx", choices=VALID)
    ap.add_argument("--imgsz", type=int, default=512, help="export input size — keep 512 (tiny objects)")
    ap.add_argument("--half", action="store_true", help="FP16 (Jetson/GPU)")
    ap.add_argument("--int8", action="store_true", help="INT8 quantization (needs calibration data)")
    ap.add_argument("--data", default=None, help="data.yaml for INT8 calibration")
    ap.add_argument("--simplify", action="store_true", help="simplify ONNX graph")
    ap.add_argument("--device", default=None)
    ap.add_argument("--nms", action="store_true", help="embed NMS in the exported graph")
    args = ap.parse_args()

    if args.half and args.int8:
        raise SystemExit("Pick one of --half or --int8, not both.")

    from ultralytics import YOLO

    model = YOLO(args.weights)
    kwargs = dict(format=args.format, imgsz=args.imgsz, half=args.half,
                  int8=args.int8, simplify=args.simplify, nms=args.nms)
    if args.device is not None:
        kwargs["device"] = args.device
    if args.int8 and args.data:
        kwargs["data"] = args.data  # representative images calibrate INT8 ranges

    path = model.export(**kwargs)
    print(f"\n✅ Exported → {path}")
    print("Copy this file to the buggy and load it with the matching runtime.")
    if args.int8:
        print("⚠️  Re-run validate.py against the INT8 model to confirm mAP is still acceptable.")


if __name__ == "__main__":
    main()
