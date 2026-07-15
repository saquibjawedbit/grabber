"""Free-tier LLM access: NVIDIA NIM primary, Gemini then Groq as fallbacks.
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


def _openai_compat(base_url: str, key: str, model: str, prompt: str) -> str:
    r = requests.post(
        f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.4,
            "max_tokens": 2048,
        },
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _nvidia(prompt: str) -> str:
    return _openai_compat(
        "https://integrate.api.nvidia.com/v1", config.NVIDIA_API_KEY, config.NVIDIA_MODEL, prompt)


def _groq(prompt: str) -> str:
    return _openai_compat(
        "https://api.groq.com/openai/v1", config.GROQ_API_KEY, config.GROQ_MODEL, prompt)


PROVIDERS = [
    ("nvidia", lambda: config.NVIDIA_API_KEY, _nvidia),
    ("gemini", lambda: config.GEMINI_API_KEY, _gemini),
    ("groq", lambda: config.GROQ_API_KEY, _groq),
]


def complete(prompt: str) -> str:
    _pace()
    available = [(name, fn) for name, key, fn in PROVIDERS if key()]
    if not available:
        raise RuntimeError("No LLM available: set NVIDIA_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY")
    for i, (name, fn) in enumerate(available):
        try:
            return fn(prompt)
        except Exception as e:
            if i == len(available) - 1:
                raise
            print(f"llm: {name} failed ({e}), trying {available[i + 1][0]}")


def complete_json(prompt: str) -> dict:
    text = complete(prompt + "\n\nRespond with ONLY a JSON object, no markdown fences.")
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError(f"LLM returned no JSON: {text[:200]}")
    return json.loads(m.group(0))
