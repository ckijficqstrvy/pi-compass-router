#!/usr/bin/env python3
"""pi-compass laya classification bridge (SPEC Part 4.2).

JSONL over stdio — one JSON object per line, no network listener.
Protocol (speced 2026-10-01, "橋接契約"):

  in : {"id": str, "state": str, "questions": {...}}
  out: {"id": str, "analysis": {...}}   # analysis = Agent.system_one() verbatim
       {"id": str, "error": str}        # load/inference failure (truncated)
       {"ready": true}                  # model loaded (warm signal, no id)

Loads the model once at startup (warm), then answers each line. Every
question's `questions` payload is passed straight to `system_one()`, which
runs `_to_internal()` on it — score questions must therefore carry `criteria`
(a nonempty list), not `legend`. Errors are reported per-line and never crash
the process.
"""

from __future__ import annotations

import json
import sys
import traceback

ERROR_CAP = 400  # keep error text bounded (mirrors sanitizeRemote's intent)


def _emit(obj: dict) -> None:
    """Write one JSON object as a single line and flush (protocol: line-delimited)."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _fail(request_id: str, exc: BaseException) -> None:
    text = "".join(traceback.format_exception_only(type(exc), exc)).strip()
    _emit({"id": request_id, "error": text[:ERROR_CAP]})


def main() -> None:
    # Import here so a broken import surfaces as a per-line error, not a crash
    # before the ready signal — but model load below is the real gate.
    from laya_mlx import Agent

    model_id = sys.argv[1] if len(sys.argv) > 1 else "aac6fef/laya-multilingual-mlx"

    agent = None
    load_error = None
    try:
        agent = Agent(model_id, dtype="float16")
    except Exception as exc:  # noqa: BLE001 — report, keep reading lines
        load_error = exc

    if load_error is None:
        _emit({"ready": True})
    else:
        # Announce readiness-with-failure by answering every request with the
        # load error instead of pretending we're up.
        _emit({"ready": True, "load_error": str(load_error)[:ERROR_CAP]})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = "?"
        try:
            request = json.loads(line)
            request_id = str(request.get("id", "?"))
        except Exception as exc:  # noqa: BLE001
            _fail(request_id, exc)
            continue

        if load_error is not None:
            _fail(request_id, load_error)
            continue

        try:
            state = request.get("state", "")
            questions = request.get("questions")
            if not isinstance(questions, dict):
                raise ValueError("questions must be an object")
            analysis = agent.system_one(state, questions)
            _emit({"id": request_id, "analysis": analysis})
        except Exception as exc:  # noqa: BLE001 — per-request failure, keep serving
            _fail(request_id, exc)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 — last-resort: never dump a raw traceback
        _emit({"id": "?", "error": "fatal: " + traceback.format_exc()[-ERROR_CAP:]})
        sys.exit(1)