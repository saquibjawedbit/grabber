"""Unstop open opportunities (hackathons + competitions).

NOTE: unofficial public endpoint. If parsing breaks, inspect
unstop.com/api/public/opportunity/search-result in devtools and adjust.
"""
import requests

from ..models import Posting

API = "https://unstop.com/api/public/opportunity/search-result"


def fetch() -> list[Posting]:
    postings = []
    for opp_type in ("hackathons", "competitions"):
        r = requests.get(
            API,
            params={"opportunity": opp_type, "per_page": 30, "oppstatus": "open"},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=30,
        )
        r.raise_for_status()
        items = (r.json().get("data", {}) or {}).get("data", []) or []
        for it in items:
            if not it.get("id") or not it.get("title"):
                continue
            regn = it.get("regnRequirements") or {}
            postings.append(Posting(
                source="unstop",
                external_id=str(it["id"]),
                title=it.get("title", ""),
                url=f"https://unstop.com/{it.get('public_url') or it.get('seo_url') or ''}",
                body=it.get("seo_details", [{}])[0].get("description", "") if it.get("seo_details") else "",
                org=(it.get("organisation") or {}).get("name", ""),
                deadline=regn.get("end_regn_dt") or "",
                posted_at=it.get("start_date") or "",
            ))
    return postings
