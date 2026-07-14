"""Seed the private profile corpus into D1 (the repo is public; this data never touches git).

Put files in profile/ (gitignored):
  profile/resume.md        -> profile key 'resume'
  profile/bio.md           -> 'bio'
  profile/skills.yaml      -> 'skills'   (phrase -> proficiency 0..1, see skills.example.yaml)
  profile/essays/*.md      -> 'essay:<filename>'

Then, with CF_ACCOUNT_ID / CF_API_TOKEN / D1_DB_ID exported:
  python pipeline/scripts/seed_profile.py
"""
import pathlib
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from grabber.db import D1  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2] / "profile"


def upsert(db: D1, key: str, content: str) -> None:
    db.query(
        "INSERT OR REPLACE INTO profile (key, content, updated_at) VALUES (?,?,?)",
        (key, content, datetime.now(timezone.utc).isoformat()),
    )
    print(f"seeded: {key} ({len(content)} chars)")


def main() -> None:
    db = D1()
    mapping = {"resume.md": "resume", "bio.md": "bio", "skills.yaml": "skills"}
    seeded = 0
    for fname, key in mapping.items():
        f = ROOT / fname
        if f.exists():
            upsert(db, key, f.read_text())
            seeded += 1
    for f in sorted((ROOT / "essays").glob("*.md")) if (ROOT / "essays").exists() else []:
        upsert(db, f"essay:{f.stem}", f.read_text())
        seeded += 1
    if not seeded:
        raise SystemExit(f"Nothing found under {ROOT} — see this script's docstring for layout")


if __name__ == "__main__":
    main()
