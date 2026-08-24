# YOLOv12 Training — NXP Cup 2026 Edge Buggy (Realtime Detection)

Train a YOLOv12 object detector on the **NXP Cup 2026** dataset and deploy it to
the buggy's edge computer for **realtime** inference. Thin, reproducible wrapper
around [Ultralytics](https://docs.ultralytics.com/), which ships YOLOv12
(`yolo12{n,s,m,l,x}.pt`).

> Self-contained. Copy `yolov12-training/` into its own git repo any time
> (`cp -r yolov12-training ../nxpcup-buggy && cd ../nxpcup-buggy && git init`).

## The dataset (verified from your zip)

| | |
|---|---|
| Images | **2167** total — train **1896** / valid **90** / test **181** (already split) |
| Image size | **512 × 512** (Roboflow "fit", black-padded) |
| Classes (**output size = 9**) | `A, B, C, Left, Right, Straight, X, Y, Z` |
| Boxes | ~18k, avg ~9 objects/image |
| **Object size** | **TINY** — median box ~18×15 px; **99.8 %** are < 32×32 px, **49 %** < 16×16 px |
| Augmentation | Roboflow already baked in 3 versions/image (crop, shear, brightness, exposure, blur, noise) |

Two facts drive every choice below: the images are **512²** and the objects are
**tiny**. So we train at the native **512** and **never downscale the input** —
shrinking to 320/416 (the usual FPS trick) would erase 15-pixel signs.

The dataset is unzipped at `dataset/NXPCUP_2026.v2-v1_a.yolov12/` (gitignored, not
committed). `data/data.yaml` already points at it with the 9 classes filled in.

---

## TL;DR — which model, what size, what output?

- **Model:** `YOLO12n` (nano) — realtime on an edge buggy; small dataset favors it too.
- **Image size:** **512** (train, val, export, infer — all 512). Do **not** go below.
- **Output size:** **9** (the 9 classes). Ultralytics sets this from `data.yaml`'s `nc`.

Step up to **`YOLO12s`** *only* if (a) your board is Jetson Orin-class **and**
(b) nano's recall on the tiny signs isn't good enough after training. `s` has a
bigger backbone that helps small objects — but costs ~3× the compute.

### The COCO speed/accuracy table (a ranking, not your FPS)

| Model  | mAP 50-95 | T4 TensorRT (ms) | params (M) | FLOPs (B) | Verdict for this buggy |
|--------|:----:|:----:|:----:|:----:|----|
| **YOLO12n** | 40.6 | **1.64** | **2.6** | **6.5** | ✅ **Start here** — fastest, lightest |
| YOLO12s | 48.0 | 2.61 | 9.3 | 21.4 | ⚠️ Fallback if nano misses too many tiny signs *and* board allows |
| YOLO12m | 52.5 | 4.86 | 20.2 | 67.5 | ❌ Too heavy for realtime on the edge |
| YOLO12l | 53.7 | 6.77 | 26.4 | 88.9 | ❌ Server/desktop GPU only |
| YOLO12x | 55.2 | 11.79 | 59.1 | 199.0 | ❌ Server/desktop GPU only |

On *your* 9-class data both models score far higher than these 80-class COCO
numbers — use the table only to rank speed vs. accuracy, then measure for real.

### Match the model to your actual edge hardware

Because the objects are tiny, input size stays at **512** on every board — you
trade FPS via the model, quantization, and the accelerator, **not** by shrinking.

| Edge board on the buggy | Model | Runtime | Notes |
|---|---|---|---|
| Raspberry Pi 4/5 (CPU) | `YOLO12n` @ 512 | ONNX / NCNN, INT8 | tight — expect low single-digit→~10 FPS; a Coral/Hailo stick helps a lot |
| Coral / Hailo-8 accelerator | `YOLO12n` @ 512 | vendor toolchain (INT8) | best FPS-per-watt for tiny objects |
| Jetson Nano | `YOLO12n` @ 512 | TensorRT FP16 | ~15–25 FPS |
| **Jetson Orin Nano / NX** | `YOLO12n` (or `s`) @ 512 | TensorRT FP16/INT8 | 30–60+ FPS; room to try `s` |
| x86 mini-PC + small GPU | `YOLO12s` @ 512 | TensorRT FP16 | 60+ FPS |

> Tell me the exact board and I'll lock model + quantization + export flags to it.

---

## Quickstart

```bash
cd yolov12-training
python -m venv .venv && source .venv/bin/activate      # optional but recommended
pip install -r requirements.txt

# Dataset is already unzipped + wired into data/data.yaml. No splitting needed
# (Roboflow already did train/valid/test). Just train:

# 1. Train nano at native 512 (config already tuned for this dataset):
python scripts/train.py                                # uses configs/train_nano.yaml

# 2. Validate on the test split + confusion matrix / PR curves:
python scripts/validate.py --weights runs/detect/nxpcup_n_512/weights/best.pt --split test

# 3. Export for the buggy (keep imgsz 512):
python scripts/export.py --weights runs/detect/nxpcup_n_512/weights/best.pt --format engine --half   # Jetson
python scripts/export.py --weights runs/detect/nxpcup_n_512/weights/best.pt --format onnx --int8       # CPU/accelerator

# 4. FPS smoke-test (webcam / video / image folder):
python scripts/infer.py --weights runs/detect/nxpcup_n_512/weights/best.pt --source 0
```

`split_dataset.py` is included for *other* datasets — you don't need it here since
this one is pre-split.

## Train on GitHub Actions (no local GPU needed)

The repo ships a workflow that trains in the cloud and hands you the weights as a
downloadable artifact — no setup on your machine.

1. Push this branch, then go to the repo's **Actions** tab.
2. Pick **"Train YOLOv12 (NXP Cup)"** → **Run workflow**. Defaults are sane
   (`yolo12n`, imgsz 512, 5-hour cap); tweak if you like.
3. When it finishes, open the run and download the **`yolov12-weights-*`**
   artifact — it contains `best.pt`, `best.onnx`, `results.csv`, and the plots.

**Important — it runs on CPU.** GitHub-hosted runners are free but have **no
GPU**, and a job is capped at **6 hours**. The workflow passes `--time 5.0` so
Ultralytics stops and saves before that wall. Because this dataset converges
fast, a 5-hour CPU run still trains many epochs and reaches high mAP — but it is
*not* the same as a full 200-epoch GPU run. For the best model, run on a GPU
(Colab/Kaggle free tier, or a self-hosted `gpu` runner — see the workflow header).

The dataset travels with the repo as `nxpcup_dataset.zip` (22 MB); the workflow
unzips it into `dataset/`.

## Train on a free GPU (Colab) — the fast path

For the full 200-epoch run in minutes instead of hours, use the included
**`train_colab.ipynb`**:

1. Open [colab.research.google.com](https://colab.research.google.com) → **File →
   Open notebook → GitHub**, paste your repo URL, and pick `train_colab.ipynb`
   (or upload the file directly).
2. **Runtime → Change runtime type → T4 GPU**, then **Runtime → Run all**.
3. The notebook clones this branch, unzips the dataset, trains on the GPU,
   validates, exports ONNX, and **auto-downloads** `nxpcup_yolov12_weights.zip`
   (weights + plots) at the end.

Same `scripts/train.py` and config as everything else — just on a GPU.

## What's here

```
yolov12-training/
├── README.md              # this file
├── requirements.txt       # ultralytics + friends
├── nxpcup_dataset.zip     # the dataset (committed so Actions can train)
├── train_colab.ipynb      # one-click GPU training on Colab → downloads the weights
├── configs/
│   └── train_nano.yaml    # tuned for THIS dataset: nano @ 512, tiny-object-safe aug
├── data/
│   ├── data.yaml          # points at dataset/, 9 classes filled in
│   └── README.md          # YOLO label format reference
├── dataset/               # (gitignored) unzipped NXP Cup data lives here
└── scripts/
    ├── _dataset.py        # resolves data.yaml `path` to absolute (import helper)
    ├── split_dataset.py   # split a flat folder (for other datasets — not needed here)
    ├── train.py           # training entrypoint
    ├── validate.py        # validation + per-class metrics
    ├── export.py          # export best.pt to ONNX / TensorRT / NCNN / TFLite
    └── infer.py           # inference / FPS check on cam, video, or folder

# plus the cloud-training workflow (repo root):
# .github/workflows/train-yolo.yml
```

## Training notes (tuned for tiny objects)

- **Image size = 512, everywhere.** This is the single most important setting for
  this dataset. The signs are ~15 px; 320/416 would destroy them. Train, validate,
  export, and run all at 512. If you must claw back FPS, try 448 and re-validate —
  never guess.
- **Epochs.** 200 with `patience=40`. Small dataset + hard tiny objects benefit
  from the longer budget; early-stopping ends it when val mAP plateaus.
- **Augmentation is deliberately gentle.** Roboflow already tripled the data with
  crop/shear/brightness/exposure/blur/noise, so the config adds only light HSV +
  half-strength mosaic (full mosaic shrinks already-tiny objects too much) and
  **no rotation**.
- **⚠️ Horizontal flip is OFF.** `Left` and `Right` are directional classes — a
  flip would turn a Left sign into a Right one without swapping the label. Only
  enable `fliplr` if those classes are distinguished by flip-invariant marks.
- **Watch recall, not just mAP.** On a moving buggy a *missed* sign is worse than
  a stray box. `validate.py` prints per-class numbers; check `Left`/`Right`/the
  rare classes specifically. If nano's recall on the smallest signs is weak, that
  is the trigger to try `YOLO12s`.
- **Quantize on the edge.** FP16 (`--half`) is near-free speed on Jetson. INT8
  (`--int8`) roughly halves latency again but can hurt tiny-object accuracy —
  calibrate with representative buggy footage (`--data`) and re-validate.
- **Measure on the buggy, not the laptop.** COCO T4 ms is a ranking. Benchmark
  `best.engine` at 512 on the real board with `infer.py`.

## Requirements / environment

- Python 3.9+, and a CUDA GPU for training (Colab/Kaggle free tiers handle a
  nano @ 512 run on 2k images easily).
- On the buggy: the matching Ultralytics / ONNX-Runtime / TensorRT for that board.

Ultralytics YOLOv12 docs: https://docs.ultralytics.com/models/yolo12/
