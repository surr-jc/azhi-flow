"""Computes authoritative CI numbers. Reads runs as JSON on stdin, prints metrics as JSON."""
import json
import sys

runs = json.load(sys.stdin) or []
total = len(runs)
passed = sum(1 for r in runs if r.get("status") == "success")
durations = [r["duration_s"] for r in runs if isinstance(r.get("duration_s"), (int, float))]

print(json.dumps({
    "runs": total,
    "passed": passed,
    "pass_rate": round(passed / total, 4) if total else None,
    "pass_rate_pct": round(100 * passed / total, 1) if total else None,
    "mean_duration_s": round(sum(durations) / len(durations), 1) if durations else None,
}))
