"""Joins the ready branch and the answered branch. Echoes the answers a person gave (or an empty string)."""
import json
import sys

data = json.load(sys.stdin)
answers = (data.get("answers") or "").strip()
print(json.dumps({"answers": answers, "asked": bool(answers)}))
