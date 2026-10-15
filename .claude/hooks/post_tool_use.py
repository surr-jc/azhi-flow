#!/usr/bin/env python3
"""PostToolUse hook: append one short JSON line per tool call to .claude/logs/tools.jsonl.

Records only time, tool name, and the first 120 characters of the command or path. The
pack's original hook rewrote the whole event history as one growing JSON array on every
call; this is append-only and small. Fails open: errors never break the session.
"""
import json, sys, time
from pathlib import Path

try:
    d = json.load(sys.stdin)
    ti = d.get("tool_input") or {}
    target = ti.get("command") or ti.get("file_path") or ti.get("pattern") or ""
    log = Path(__file__).resolve().parent.parent / "logs"
    log.mkdir(exist_ok=True)
    with (log / "tools.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({"t": int(time.time()), "tool": d.get("tool_name"), "target": str(target)[:120]}) + "\n")
except Exception:
    pass
sys.exit(0)
