"""Versioned local prompting contract; no audio, model or network access."""
from __future__ import annotations

import hashlib
import json

SERVICE_VERSION = "2.1.0"
LIMITS = {"max_hotwords": 100, "max_hotword_characters": 1000, "max_context_characters": 400}
# ECMAScript String.trim whitespace, shared with the plugin (not Python's broader strip).
TRIM = " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def text(value):
    if not isinstance(value, str) or any(0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise ValueError("Enhancement text must be valid Unicode strings")
    return value.strip(TRIM)


def normalize_enhancement(value):
    if value is None:
        return None
    if (not isinstance(value, dict) or type(value.get("version")) is not int
            or value["version"] != 1 or set(value) - {"version", "hotwords", "context_text"}):
        raise ValueError("Unsupported enhancement structure or version")
    words = value.get("hotwords", [])
    if not isinstance(words, list):
        raise ValueError("Hotwords must be a list of strings")
    normalized = list(dict.fromkeys(word for item in words if (word := text(item))))
    context = text(value.get("context_text", ""))
    if (len(normalized) > LIMITS["max_hotwords"]
            or sum(map(len, normalized)) > LIMITS["max_hotword_characters"]
            or len(context) > LIMITS["max_context_characters"]):
        raise ValueError("Enhancement exceeds the advertised budget")
    return {"version": 1, "hotwords": normalized, "context_text": context}


def enhancement_fingerprint(value):
    if value is None:
        return None
    canonical = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def model_capabilities(models):
    return {model: {"enhancement": {"version": 1, "transports": ["jobs"],
            "hotwords": True, "context": True, "limits": dict(LIMITS)}} for model in models}
