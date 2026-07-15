"""Free-tier LLM access: Cloudflare Workers AI (gpt-oss-120b, 10k neurons/day free,
same token as D1) primary; NVIDIA, Gemini, Groq as fallbacks.
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
            # Reasoning models spend this budget thinking before they emit a word —
            # too low and `content` comes back null with everything in the reasoning.
            "max_tokens": 6000,
        },
        timeout=180,
    )
    r.raise_for_status()
    msg = r.json()["choices"][0]["message"]
    text = msg.get("content")
    if not text:
        # gpt-oss sometimes stops inside its reasoning channel. The decision we want
        # is usually sitting right there, so salvage it rather than lose the step.
        text = msg.get("reasoning_content") or msg.get("reasoning") or ""
        if text:
            print("llm: no content channel, salvaged from reasoning")
    if not text or not text.strip():
        raise ValueError("empty completion (model emitted no content)")
    return text


def _cloudflare(prompt: str) -> str:
    return _openai_compat(
        f"https://api.cloudflare.com/client/v4/accounts/{config.CF_ACCOUNT_ID}/ai/v1",
        config.CF_API_TOKEN, config.CF_AI_MODEL, prompt)


def _nvidia(prompt: str) -> str:
    return _openai_compat(
        "https://integrate.api.nvidia.com/v1", config.NVIDIA_API_KEY, config.NVIDIA_MODEL, prompt)


def _groq(prompt: str) -> str:
    return _openai_compat(
        "https://api.groq.com/openai/v1", config.GROQ_API_KEY, config.GROQ_MODEL, prompt)


PROVIDERS = [
    ("cloudflare", lambda: config.CF_API_TOKEN and config.CF_ACCOUNT_ID, _cloudflare),
    ("nvidia", lambda: config.NVIDIA_API_KEY, _nvidia),
    ("gemini", lambda: config.GEMINI_API_KEY, _gemini),
    ("groq", lambda: config.GROQ_API_KEY, _groq),
]


def complete(prompt: str) -> str:
    """Never returns None or empty — raises instead, so callers can't be surprised."""
    available = [(name, fn) for name, key, fn in PROVIDERS if key()]
    if not available:
        raise RuntimeError(
            "No LLM available: set CF_API_TOKEN+CF_ACCOUNT_ID, NVIDIA_API_KEY, "
            "GEMINI_API_KEY, or GROQ_API_KEY")
    last = None
    # Two passes: a provider that stalls or empties out often succeeds on retry.
    for attempt in range(2):
        for name, fn in available:
            _pace()
            try:
                text = fn(prompt)
                if text and text.strip():
                    return text
                last = ValueError(f"{name} returned empty")
            except Exception as e:
                last = e
                print(f"llm: {name} failed ({type(e).__name__}: {str(e)[:120]})")
    raise last or RuntimeError("all LLM providers failed")


def complete_json(prompt: str) -> dict:
    text = complete(prompt + "\n\nRespond with ONLY a JSON object, no markdown fences.")
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError(f"LLM returned no JSON: {text[:200]}")
    return json.loads(m.group(0))
