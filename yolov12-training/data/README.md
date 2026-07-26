# Dataset layout (YOLO format)

Your 4,000 images and their labels go here. YOLOv12 uses the standard Ultralytics
YOLO format: one `.txt` label file per image, same basename, one line per object:

```
<class_id> <x_center> <y_center> <width> <height>
```

All four box values are **normalised to [0, 1]** (fraction of image width/height).
`class_id` is a 0-based index into the `names` list in `data.yaml`.

Example — `images/train/frame_0001.jpg` pairs with `labels/train/frame_0001.txt`:

```
0 0.512 0.634 0.220 0.410
2 0.180 0.775 0.090 0.150
```

## Final on-disk layout

`split_dataset.py` produces exactly this (Ultralytics finds labels by swapping
`images/` → `labels/` in the path, so keep the two trees mirrored):

```
data/
├── data.yaml
├── images/
│   ├── train/   *.jpg
│   ├── val/     *.jpg
│   └── test/    *.jpg
└── labels/
    ├── train/   *.txt
    ├── val/     *.txt
    └── test/    *.txt
```

## This project: already split

The NXP Cup dataset ships pre-split (train/valid/test), unzipped at
`../dataset/NXPCUP_2026.v2-v1_a.yolov12/`, and `data.yaml` points straight at it.
**You do not need to split anything** — go run `scripts/train.py`.

## Splitting a *different* flat folder (for reuse elsewhere)

If some *other* dataset has its images + `.txt` labels in one directory (or in
parallel `images/`+`labels/` dirs), run:

```bash
python scripts/split_dataset.py --src /path/to/all_data --out data --val 0.15 --test 0.05
```

It shuffles deterministically (seeded), keeps each image with its label, and
warns about images that have no label (background/negative frames are allowed —
they just get an empty or missing label file).

## Notes

- **Class balance.** With 4k images, check that every class has enough examples.
  `validate.py` prints a per-class breakdown; the confusion matrix in
  `runs/detect/val/` shows which classes get confused.
- **Backgrounds.** Including some images with *no* objects (empty label files)
  reduces false positives on the buggy — recommended if your scene has clutter.
- **This folder is gitignored** (see `../.gitignore`) so you don't commit
  thousands of images/weights. Keep the dataset in cloud storage or DVC.
