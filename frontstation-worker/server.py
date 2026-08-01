#!/usr/bin/env python3
"""
KGM Front-Station micro-worker（encoder 轨）
- /health
- /v1/intent
- /v1/rerank   （优先 sentence-transformers CrossEncoder；否则 MiniLM embed 余弦）
- /v1/summarize（抽取式）

CUDA：安装 onnxruntime-gpu / torch+cuda 时自动用 GPU。
不与 decoder-only Native GPU 混用。
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

HOST = os.environ.get("KGM_FRONTSTATION_WORKER_HOST", "127.0.0.1")
PORT = int(os.environ.get("KGM_FRONTSTATION_WORKER_PORT", "8091"))
EMBED_MODEL = os.environ.get(
    "KGM_FRONTSTATION_WORKER_EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
)
CE_MODEL = os.environ.get(
    "KGM_FRONTSTATION_WORKER_CE_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2"
)
DEVICE = os.environ.get("KGM_FRONTSTATION_WORKER_DEVICE", "auto")  # auto|cpu|cuda

_embedder = None
_cross_encoder = None
_backend_note = "hash_fallback"


def _resolve_device() -> str:
    if DEVICE != "auto":
        return DEVICE
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _load_models() -> None:
    global _embedder, _cross_encoder, _backend_note
    device = _resolve_device()
    try:
        from sentence_transformers import SentenceTransformer, CrossEncoder

        _embedder = SentenceTransformer(EMBED_MODEL, device=device)
        try:
            _cross_encoder = CrossEncoder(CE_MODEL, device=device)
            _backend_note = f"sentence_transformers+ce@{device}"
        except Exception as exc:
            _cross_encoder = None
            _backend_note = f"sentence_transformers_embed@{device} (ce_failed:{exc})"
        print(f"[frontstation-worker] loaded {_backend_note}", file=sys.stderr)
        return
    except Exception as exc:
        print(f"[frontstation-worker] sentence-transformers unavailable: {exc}", file=sys.stderr)

    try:
        import onnxruntime as ort  # noqa: F401

        _backend_note = f"onnxruntime_present_but_no_st@{device}"
    except Exception:
        _backend_note = "stdlib_hash_fallback"
    print(f"[frontstation-worker] using {_backend_note}", file=sys.stderr)


INTENT_PROTOS = {
    "path_analysis": "path analysis relation path 路径 关系链",
    "summary": "summary summarize 总结 概括 摘要",
    "risk_analysis": "risk 风险 合规 threat",
    "code_generation": "code typescript python function 代码 编程",
    "structured_output": "json schema 结构化",
    "math_reasoning": "math equation 计算 方程",
    "translation": "translate 翻译",
    "reasoning": "why reason 为什么 推理",
    "knowledge_query": "what is who is 是什么 介绍",
    "general": "hello please 你好 帮我",
}


def _tokenize(text: str) -> set[str]:
    return {t for t in re.split(r"[^\w\u4e00-\u9fff]+", text.lower()) if len(t) > 1}


def _hash_embed(text: str, dim: int = 64) -> list[float]:
    vec = [0.0] * dim
    for tok in _tokenize(text):
        h = hash(tok) & 0xFFFFFFFF
        idx = h % dim
        sign = 1.0 if (h & 1) == 0 else -1.0
        vec[idx] += sign
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _embed(texts: list[str]) -> list[list[float]]:
    if _embedder is not None:
        vectors = _embedder.encode(texts, normalize_embeddings=True)
        return [list(map(float, v)) for v in vectors]
    return [_hash_embed(t) for t in texts]


def _keyword_intent(text: str) -> str | None:
    lower = text.lower()
    if "path" in lower or "路径" in text or "关系链" in text:
        return "path_analysis"
    if "summary" in lower or "总结" in text or "概括" in text:
        return "summary"
    if "risk" in lower or "风险" in text:
        return "risk_analysis"
    if re.search(r"typescript|javascript|python|代码|编程|函数", text, re.I):
        return "code_generation"
    if re.search(r"json|schema|结构化", text, re.I):
        return "structured_output"
    if re.search(r"math|积分|方程|计算|求解", text, re.I):
        return "math_reasoning"
    if "translate" in lower or "翻译" in text:
        return "translation"
    if "why" in lower or "为什么" in text or "推理" in text:
        return "reasoning"
    return None


def classify_intent(text: str) -> dict[str, Any]:
    kw = _keyword_intent(text)
    labels = list(INTENT_PROTOS.keys())
    proto_texts = [INTENT_PROTOS[k] for k in labels]
    vectors = _embed([text, *proto_texts])
    q = vectors[0]
    raw = {labels[i]: _cos(q, vectors[i + 1]) for i in range(len(labels))}
    mx = max(raw.values()) if raw else 0.0
    exps = {k: math.exp(v - mx) for k, v in raw.items()}
    s = sum(exps.values()) or 1.0
    scores = {k: exps[k] / s for k in exps}
    best = max(scores, key=scores.get)
    if kw:
        scores[kw] = max(scores.get(kw, 0.0), 0.75)
        best = kw
    return {
        "intent": best,
        "confidence": scores[best],
        "scores": scores,
        "backend": "http",
        "worker_backend": _backend_note,
        "kceIntent": best if best in {"path_analysis", "summary", "risk_analysis", "knowledge_query"} else "knowledge_query",
    }


def rerank(query: str, documents: list[dict[str, str]], top_k: int) -> dict[str, Any]:
    if not documents:
        return {"results": [], "backend": "http", "worker_backend": _backend_note}
    if _cross_encoder is not None:
        pairs = [(query, d.get("text", "")) for d in documents]
        scores = _cross_encoder.predict(pairs)
        ranked = sorted(
            [
                {"id": d.get("id", str(i)), "text": d.get("text", ""), "score": float(scores[i])}
                for i, d in enumerate(documents)
            ],
            key=lambda x: x["score"],
            reverse=True,
        )
        return {
            "results": ranked[: max(1, top_k)],
            "backend": "http",
            "worker_backend": _backend_note,
        }

    qv = _embed([query])[0]
    ranked = []
    for d in documents:
        dv = _embed([d.get("text", "")])[0]
        ranked.append({"id": d.get("id", ""), "text": d.get("text", ""), "score": _cos(qv, dv)})
    ranked.sort(key=lambda x: x["score"], reverse=True)
    return {"results": ranked[: max(1, top_k)], "backend": "http", "worker_backend": _backend_note}


def extractive_summarize(text: str, max_sentences: int = 3, max_chars: int = 480) -> dict[str, Any]:
    parts = [p.strip() for p in re.split(r"(?<=[。！？.!?；;])\s*|\n+", text) if p.strip()]
    if not parts:
        return {"summary": "", "sentences": [], "backend": "http"}
    if len(parts) <= max_sentences:
        summary = "".join(parts) if any("\u4e00" <= c <= "\u9fff" for c in text) else " ".join(parts)
        return {
            "summary": summary[:max_chars],
            "sentences": [{"text": s, "score": 1.0 - i * 0.01, "index": i} for i, s in enumerate(parts)],
            "backend": "http",
        }

    tokens = [_tokenize(s) for s in parts]
    n = len(parts)
    scores = [1.0 / n] * n
    damping = 0.85
    for _ in range(20):
        nxt = [0.0] * n
        for i in range(n):
            ssum = 0.0
            for j in range(n):
                if i == j:
                    continue
                inter = len(tokens[i] & tokens[j])
                if inter <= 0:
                    continue
                sim = inter / (math.log(1 + len(tokens[i])) + math.log(1 + len(tokens[j])))
                out = 0.0
                for k in range(n):
                    if k == j:
                        continue
                    inter2 = len(tokens[j] & tokens[k])
                    if inter2 > 0:
                        out += inter2 / (math.log(1 + len(tokens[j])) + math.log(1 + len(tokens[k])))
                if out > 0:
                    ssum += (sim / out) * scores[j]
            nxt[i] = (1 - damping) / n + damping * ssum
        scores = nxt

    ranked = sorted(
        [{"text": parts[i], "score": scores[i], "index": i} for i in range(n)],
        key=lambda x: x["score"],
        reverse=True,
    )
    selected = sorted(ranked[:max_sentences], key=lambda x: x["index"])
    zh = any("\u4e00" <= c <= "\u9fff" for c in text)
    summary = ("".join(s["text"] for s in selected) if zh else " ".join(s["text"] for s in selected))
    if len(summary) > max_chars:
        summary = summary[: max_chars - 1] + "…"
    return {"summary": summary, "sentences": ranked, "backend": "http"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def _send(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/health", "/v1/health"):
            self._send(
                200,
                {
                    "ok": True,
                    "track": "encoder_frontstation",
                    "worker_backend": _backend_note,
                    "device": _resolve_device(),
                },
            )
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            data = self._read_json()
        except Exception:
            self._send(400, {"error": "invalid_json"})
            return
        if path == "/v1/intent":
            self._send(200, classify_intent(str(data.get("text", ""))))
            return
        if path == "/v1/rerank":
            docs = data.get("documents") or []
            top_k = int(data.get("top_k") or data.get("topK") or 10)
            self._send(200, rerank(str(data.get("query", "")), docs, top_k))
            return
        if path == "/v1/summarize":
            self._send(
                200,
                extractive_summarize(
                    str(data.get("text", "")),
                    int(data.get("max_sentences") or 3),
                    int(data.get("max_chars") or 480),
                ),
            )
            return
        self._send(404, {"error": "not_found"})


def main() -> None:
    _load_models()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[frontstation-worker] listening on http://{HOST}:{PORT} track=encoder_frontstation", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
