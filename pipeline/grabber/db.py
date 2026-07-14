"""Cloudflare D1 over its REST API — SQLite we can reach from both GitHub Actions and the Worker."""
import time

import requests

from . import config


class D1:
    def __init__(self):
        config.require("CF_ACCOUNT_ID", "CF_API_TOKEN", "D1_DB_ID")
        self.url = (
            f"https://api.cloudflare.com/client/v4/accounts/"
            f"{config.CF_ACCOUNT_ID}/d1/database/{config.D1_DB_ID}/query"
        )
        self.headers = {"Authorization": f"Bearer {config.CF_API_TOKEN}"}

    def query(self, sql: str, params: tuple = ()) -> list[dict]:
        for attempt in range(3):
            r = requests.post(
                self.url, headers=self.headers,
                json={"sql": sql, "params": list(params)}, timeout=30,
            )
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            data = r.json()
            if not data.get("success"):
                raise RuntimeError(f"D1 error: {data.get('errors')}")
            return data["result"][0].get("results", [])
        raise RuntimeError(f"D1 unavailable after retries: {r.status_code} {r.text[:200]}")

    def one(self, sql: str, params: tuple = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None
