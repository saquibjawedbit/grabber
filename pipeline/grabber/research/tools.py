"""What a research agent can do with a real machine: search, read anything
(including JS-heavy pages), and watch talks by reading their transcripts.

Everything here is best-effort — a dead source returns an error string the agent
reads and works around, it never crashes the job.
"""
import json
import re

import requests

from .. import config

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"}
TIMEOUT = 25


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def search(query: str, n: int = 8) -> list[dict]:
    """Search engines block datacenter IPs — a CI runner gets a 202 challenge from
    DuckDuckGo every time. The Worker's IP isn't blocked, so ask it to search for us
    and keep the heavy reading here. CSE first when keyed; direct DDG last resort."""
    if config.GOOGLE_CSE_KEY and config.GOOGLE_CSE_ID:
        try:
            r = requests.get(
                "https://www.googleapis.com/customsearch/v1",
                params={"key": config.GOOGLE_CSE_KEY, "cx": config.GOOGLE_CSE_ID,
                        "num": min(n, 10), "q": query},
                timeout=TIMEOUT,
            )
            if r.ok:
                items = r.json().get("items", [])
                if items:
                    return [{"title": i.get("title", ""), "url": i.get("link", ""),
                             "snippet": (i.get("snippet") or "")[:200]} for i in items]
        except Exception as e:
            print(f"search: cse failed ({type(e).__name__})")

    if config.DASH_URL and config.DASH_TOKEN:
        try:
            r = requests.get(
                f"{config.DASH_URL}/api/tool",
                params={"t": config.DASH_TOKEN, "name": "web_search",
                        "args": json.dumps({"query": query})},
                timeout=TIMEOUT,
            )
            if r.ok:
                res = r.json().get("results") or []
                if res:
                    return res[:n]
                print(f"search: worker proxy returned nothing ({r.json().get('error', '')[:60]})")
        except Exception as e:
            print(f"search: worker proxy failed ({type(e).__name__})")

    try:
        r = requests.post("https://lite.duckduckgo.com/lite/", data={"q": query},
                          headers=UA, timeout=TIMEOUT)
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(r.text, "html.parser")
        out = []
        for a in soup.find_all("a", href=True):
            href = a["href"]
            title = _clean(a.get_text())
            if href.startswith("http") and "duckduckgo.com" not in href and len(title) > 8:
                out.append({"title": title[:120], "url": href, "snippet": ""})
            if len(out) >= n:
                break
        if not out:
            print(f"search: ddg gave nothing (status {r.status_code})")
        return out
    except Exception as e:
        print(f"search: ddg failed ({type(e).__name__})")
        return []


def read_url(url: str, render: bool = False) -> str:
    """Plain fetch first; render with a real browser only when the page needs it."""
    if not render:
        try:
            r = requests.get(url, headers=UA, timeout=TIMEOUT)
            if r.ok:
                if "application/pdf" in r.headers.get("content-type", ""):
                    return _read_pdf(r.content)
                from bs4 import BeautifulSoup
                soup = BeautifulSoup(r.text, "html.parser")
                for t in soup(["script", "style", "nav", "footer", "header"]):
                    t.decompose()
                text = _clean(soup.get_text(" "))
                if len(text) > 400:
                    return text[:12000]
        except Exception as e:
            print(f"read: plain fetch failed ({type(e).__name__})")
    return _render(url)


def _read_pdf(data: bytes) -> str:
    try:
        import io

        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        return _clean(" ".join((p.extract_text() or "") for p in reader.pages[:20]))[:12000]
    except Exception as e:
        return f"[could not read pdf: {type(e).__name__}]"


def _render(url: str) -> str:
    """Headless Chromium — for React apps and anything that fights a plain GET."""
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(user_agent=UA["User-Agent"])
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1800)
            text = page.evaluate("() => document.body.innerText")
            browser.close()
            return _clean(text)[:12000]
    except Exception as e:
        return f"[could not read {url}: {type(e).__name__}]"


YT_RE = re.compile(r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/shorts/)([A-Za-z0-9_-]{11})")


def watch_video(url_or_id: str) -> str:
    """Read a talk instead of watching it — transcripts are free and 100x faster."""
    m = YT_RE.search(url_or_id)
    vid = m.group(1) if m else url_or_id.strip()
    if len(vid) != 11:
        return "[not a youtube url or id]"
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        api = YouTubeTranscriptApi()
        try:
            fetched = api.fetch(vid, languages=["en", "en-US", "en-GB", "hi"])
        except AttributeError:  # older api surface
            fetched = YouTubeTranscriptApi.get_transcript(vid, languages=["en", "en-US", "hi"])
        chunks = [getattr(s, "text", None) or s.get("text", "") for s in fetched]
        return _clean(" ".join(chunks))[:12000] or "[empty transcript]"
    except Exception as e:
        return f"[no transcript available: {type(e).__name__}]"


def search_videos(query: str, n: int = 4) -> list[dict]:
    """Find talks worth reading. Scrapes the results page — no API key needed."""
    try:
        r = requests.get("https://www.youtube.com/results",
                         params={"search_query": query}, headers=UA, timeout=TIMEOUT)
        ids, out = [], []
        for m in re.finditer(r'"videoId":"([A-Za-z0-9_-]{11})".*?"text":"([^"]{6,110})"', r.text):
            vid, title = m.group(1), m.group(2)
            if vid in ids:
                continue
            ids.append(vid)
            out.append({"id": vid, "title": title, "url": f"https://youtu.be/{vid}"})
            if len(out) >= n:
                break
        return out
    except Exception as e:
        print(f"search_videos failed ({type(e).__name__})")
        return []


TOOL_SPECS = json.dumps([
    {"tool": "search", "args": {"query": "..."}, "does": "web search, returns titles+urls"},
    {"tool": "read", "args": {"url": "https://...", "render": False},
     "does": "read a page as text (set render true for JS-heavy sites); handles PDFs"},
    {"tool": "search_videos", "args": {"query": "..."}, "does": "find talks/interviews on YouTube"},
    {"tool": "watch", "args": {"url": "youtube url or id"}, "does": "read a video's transcript"},
    {"tool": "done", "args": {"report": "markdown", "confidence": "high|medium|low"},
     "does": "finish and hand back the report"},
], indent=None)
