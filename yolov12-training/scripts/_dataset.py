"""Shared helper: make a data.yaml's `path` absolute.

Ultralytics resolves a *relative* `path:` in a data.yaml against its global
datasets dir, not against the yaml's own location — which breaks a project-local
dataset. This rewrites `path` to an absolute path (relative to the yaml file) and
writes a sibling `*.resolved.yaml` that the training/val scripts pass instead.
Idempotent and dependency-light (only pyyaml).
"""
from pathlib import Path

import yaml


def resolve_data_yaml(data_path) -> str:
    """Return a path to a data.yaml whose `path` is absolute.

    If `path` is already absolute (or missing), the original file is returned
    unchanged. Otherwise a `<name>.resolved.yaml` is written next to it.
    """
    p = Path(data_path).resolve()
    with open(p) as f:
        cfg = yaml.safe_load(f) or {}

    raw = cfg.get("path")
    if not raw:
        return str(p)
    root = Path(raw)
    if root.is_absolute():
        return str(p)

    cfg["path"] = str((p.parent / root).resolve())
    out = p.with_suffix(".resolved.yaml")
    with open(out, "w") as f:
        yaml.safe_dump(cfg, f, sort_keys=False)
    return str(out)
