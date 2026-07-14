# profile/ — private, gitignored

The repo is public; everything here except this README and `skills.example.yaml`
is ignored by git and lives only in D1 after seeding.

Layout:

```
profile/
  resume.md        # your resume, markdown
  bio.md           # 3-6 lines: who you are, what you're aiming for
  skills.yaml      # phrase -> proficiency 0..1 (copy skills.example.yaml)
  essays/
    somefellowship-2025.md   # every past application essay you can find
```

Seed into D1:

```
export CF_ACCOUNT_ID=... CF_API_TOKEN=... D1_DB_ID=...
python pipeline/scripts/seed_profile.py
```

Re-run any time you update a file. More past essays = better drafts.
