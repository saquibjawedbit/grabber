"""Free-tier LLM access: Gemini primary, Groq (OpenAI-compatible) fallback.
Plain REST, no SDKs. A fixed sleep between calls keeps us under free-tier RPM."""
import json
import re
import time

import requests

from .. import config

_last_call = 0.0


def _pace():
    global _last_call
    wait = config.LLM_CALL_GAP_S - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.time()


def _gemini(prompt: str) -> str:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{config.GEMINI_MODEL}:generateContent?key={config.GEMINI_API_KEY}"
    )
    r = requests.post(
        url,
        json={"contents": [{"parts": [{"text": prompt}]}]},
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["candidates"][0]["content"]["parts"][0]["text"]


def _groq(prompt: str) -> str:
    r = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {config.GROQ_API_KEY}"},
        json={"model": config.GROQ_MODEL, "messages": [{"role": "user", "content": prompt}]},
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def complete(prompt: str) -> str:
    _pace()
    if config.GEMINI_API_KEY:
        try:
            return _gemini(prompt)
        except Exception as e:
            print(f"llm: gemini failed ({e}), trying groq")
    if config.GROQ_API_KEY:
        return _groq(prompt)
    raise RuntimeError("No LLM available: set GEMINI_API_KEY (or GROQ_API_KEY)")


def complete_json(prompt: str) -> dict:
    text = complete(prompt + "\n\nRespond with ONLY a JSON object, no markdown fences.")
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError(f"LLM returned no JSON: {text[:200]}")
    return json.loads(m.group(0))
