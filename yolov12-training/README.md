# YOLOv12 Training — Edge Buggy (Realtime Detection)

Train a YOLOv12 object detector on ~4,000 labelled images and deploy it to a
buggy's edge computer for **realtime** inference. This project is a thin,
reproducible wrapper around [Ultralytics](https://docs.ultralytics.com/), which
ships YOLOv12 (`yolo12{n,s,m,l,x}.pt`).

> This lives as a subfolder of the `grabber` repo for now. It is fully
> self-contained — copy `yolov12-training/` into its own git repo any time
> (`cp -r yolov12-training ../yolov12-buggy && cd ../yolov12-buggy && git init`).

---

## TL;DR — which model should you train?

**Train `YOLO12n` (nano).** For a battery-powered buggy where the whole point is
*realtime* detection, nano is the right default — and with only 4k images the
smaller model also generalises better and overfits less.

Step up to **`YOLO12s` (small)** *only* if your edge board is a Jetson Orin-class
device **and** you measure nano as fast enough with accuracy headroom to spare.

### The numbers that matter (official COCO table)

| Model  | mAP<sup>val</sup> 50-95 | T4 TensorRT (ms) | params (M) | FLOPs (B) | Verdict for a buggy |
|--------|:----:|:----:|:----:|:----:|----|
| **YOLO12n** | 40.6 | **1.64** | **2.6** | **6.5** | ✅ **Start here** — fastest, lightest, realtime on modest hardware |
| YOLO12s | 48.0 | 2.61 | 9.3 | 21.4 | ⚠️ Only if the board is beefy (Jetson Orin) and you need the accuracy |
| YOLO12m | 52.5 | 4.86 | 20.2 | 67.5 | ❌ Too heavy for realtime on an edge buggy |
| YOLO12l | 53.7 | 6.77 | 26.4 | 88.9 | ❌ Server/desktop GPU only |
| YOLO12x | 55.2 | 11.79 | 59.1 | 199.0 | ❌ Server/desktop GPU only |

**Why nano wins for a buggy**

- **Realtime budget.** A buggy reacts to what's in front of it *now*. You want
  the whole capture→infer→act loop under one frame time. Nano's ~1.6 ms on a T4
  translates to comfortably realtime even on much weaker edge boards after
  TensorRT/INT8 export; `m`/`l`/`x` blow the budget.
- **Power & thermals.** 2.6 M params / 6.5 B FLOPs draws far less than `s`
  (3.3× the compute) — critical on a battery, and it stays cooler in an enclosed
  chassis so it won't thermal-throttle mid-run.
- **Small dataset.** 4k images is modest. Big models have the capacity to
  memorise it; nano's smaller capacity is a natural regulariser and, with the
  augmentation defaults here, generalises better to the real world.

### Match the model to your actual edge hardware

The buggy's compute board is the real deciding factor. Pick the row that matches
what's on the buggy:

| Edge board on the buggy | Recommended model | Export / runtime | Realistic FPS @ 640 |
|---|---|---|---|
| Raspberry Pi 4/5 (CPU only) | `YOLO12n` @ 320–416 px | ONNX / NCNN, INT8 | ~5–15 |
| Coral / Hailo-8 accelerator | `YOLO12n` | vendor toolchain (INT8) | 30+ |
| Jetson Nano | `YOLO12n` | TensorRT FP16 | ~20–30 |
| **Jetson Orin Nano / NX** | `YOLO12n` (or `s` if headroom) | TensorRT FP16/INT8 | 30–60+ |
| x86 mini-PC + small GPU | `YOLO12s` | TensorRT FP16 | 60+ |

> If you tell me the exact board, I'll lock the model + input size + export flags
> to it. When unsure, **train nano, export to your runtime, measure FPS on the
> buggy, and only move up if you have room.**

---

## Quickstart

```bash
cd yolov12-training
python -m venv .venv && source .venv/bin/activate      # optional but recommended
pip install -r requirements.txt

# 1. Put your 4k images + YOLO-format labels in place (see data/README.md),
#    then split them into train/val/test:
python scripts/split_dataset.py --src /path/to/all_data --out data --val 0.15 --test 0.05

# 2. Edit data/data.yaml — set your class names.

# 3. Train nano (defaults tuned for a ~4k-image edge model):
python scripts/train.py --model yolo12n.pt --data data/data.yaml --epochs 150 --imgsz 640

# 4. Validate + look at the confusion matrix / PR curves:
python scripts/validate.py --weights runs/detect/train/weights/best.pt --data data/data.yaml

# 5. Export for the buggy (TensorRT on Jetson, ONNX/NCNN elsewhere):
python scripts/export.py --weights runs/detect/train/weights/best.pt --format engine --half   # Jetson
python scripts/export.py --weights runs/detect/train/weights/best.pt --format onnx --int8      # CPU/accelerator

# 6. Smoke-test inference (webcam, video file, or image folder):
python scripts/infer.py --weights runs/detect/train/weights/best.pt --source 0
```

## What's here

```
yolov12-training/
├── README.md              # this file
├── requirements.txt       # ultralytics + friends
├── configs/
│   └── train_nano.yaml    # ready-to-run hyperparameters for the edge nano model
├── data/
│   ├── data.yaml          # dataset descriptor — EDIT class names
│   └── README.md          # expected folder/label layout (YOLO format)
└── scripts/
    ├── split_dataset.py   # split a flat image+label folder into train/val/test
    ├── train.py           # training entrypoint
    ├── validate.py        # run validation, dump metrics
    ├── export.py          # export best.pt to ONNX / TensorRT / NCNN / TFLite
    └── infer.py           # quick inference / FPS check on cam, video, or folder
```

## Training notes (4k images, edge target)

- **Epochs.** 4k images is small; 100–200 epochs with early-stopping
  (`patience=30`) is usually right. The config defaults to 150.
- **Input size.** Train at 640 for accuracy, then **also export at the size you
  will actually run** (e.g. 416 or 320) and re-measure — dropping resolution is
  the single biggest realtime speed lever on the buggy.
- **Batch size.** `--batch -1` lets Ultralytics auto-pick ~60% VRAM. On a small
  training GPU, 16 is a safe fixed value.
- **Augmentation.** Defaults include mosaic + light HSV/flip. `mosaic` auto-turns
  off for the last 10 epochs (`close_mosaic=10`) so the model fine-tunes on
  realistic single-image framing — important since the buggy sees one frame at a
  time.
- **Quantize for the edge.** FP16 (`--half`) is free accuracy-neutral speed on
  Jetson. INT8 (`--int8`) roughly halves latency again; validate mAP after INT8
  and pass representative buggy footage as calibration data.
- **Measure on the buggy, not the laptop.** The COCO T4 numbers are a *ranking*,
  not your FPS. Always benchmark `best.engine` on the actual board.

## Requirements / environment

- Python 3.9+.
- A CUDA GPU for training (Colab/Kaggle free tiers work for a 4k-image nano run).
- On the buggy: the matching Ultralytics/ONNX-Runtime/TensorRT for that board.

See Ultralytics YOLOv12 docs: https://docs.ultralytics.com/models/yolo12/
