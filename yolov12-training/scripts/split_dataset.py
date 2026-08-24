#!/usr/bin/env python3
"""Split a flat image+label collection into YOLO train/val/test folders.

Accepts either:
  --src DIR                 # images and .txt labels mixed in one folder, OR
  --src DIR with images/ and labels/ subfolders

Produces (under --out):
  images/{train,val,test}/  and  labels/{train,val,test}/

Each image is moved (or copied with --copy) together with its label. Images
without a label are treated as background/negative frames (allowed) and warned
about. Deterministic given --seed.
"""
import argparse
import random
import shutil
from pathlib import Path

IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}


def find_pairs(src: Path):
    """Return list of (image_path, label_path_or_None)."""
    img_dir = src / "images" if (src / "images").is_dir() else src
    lbl_dir = src / "labels" if (src / "labels").is_dir() else src

    images = sorted(p for p in img_dir.rglob("*") if p.suffix.lower() in IMG_EXTS)
    pairs = []
    for img in images:
        lbl = lbl_dir / (img.stem + ".txt")
        pairs.append((img, lbl if lbl.exists() else None))
    return pairs


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", required=True, type=Path, help="source folder")
    ap.add_argument("--out", required=True, type=Path, help="output dataset root (e.g. data)")
    ap.add_argument("--val", type=float, default=0.15, help="val fraction")
    ap.add_argument("--test", type=float, default=0.05, help="test fraction (0 to skip)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--copy", action="store_true", help="copy instead of move")
    args = ap.parse_args()

    assert 0 <= args.val < 1 and 0 <= args.test < 1 and args.val + args.test < 1, \
        "val+test must be < 1"

    pairs = find_pairs(args.src)
    if not pairs:
        raise SystemExit(f"No images found under {args.src}")

    unlabelled = [p for p, l in pairs if l is None]
    if unlabelled:
        print(f"⚠️  {len(unlabelled)} images have no .txt label — kept as background frames.")

    random.Random(args.seed).shuffle(pairs)
    n = len(pairs)
    n_test = int(n * args.test)
    n_val = int(n * args.val)
    splits = {
        "test": pairs[:n_test],
        "val": pairs[n_test:n_test + n_val],
        "train": pairs[n_test + n_val:],
    }

    op = shutil.copy2 if args.copy else shutil.move
    for split, items in splits.items():
        if not items:
            continue
        img_out = args.out / "images" / split
        lbl_out = args.out / "labels" / split
        img_out.mkdir(parents=True, exist_ok=True)
        lbl_out.mkdir(parents=True, exist_ok=True)
        for img, lbl in items:
            op(str(img), str(img_out / img.name))
            if lbl is not None:
                op(str(lbl), str(lbl_out / lbl.name))
        print(f"{split:5s}: {len(items)} images -> {img_out}")

    print(f"\nDone. Total {n} images "
          f"(train {len(splits['train'])}, val {len(splits['val'])}, test {len(splits['test'])}).")
    print("Next: edit data/data.yaml class names, then run scripts/train.py")


if __name__ == "__main__":
    main()
