"""Splits the reviewers' findings by what the verifier decided, with plain rules and no model.

Reads JSON on stdin: the reviewers' outputs (each {reviewer, summary, findings}), the verifier's
checks, and the minimum confidence. A finding is
  kept        confirmed by the verifier with confidence at or above the minimum
  dropped     refuted, or confirmed below the minimum (the verifier was not sure enough)
  unverified  unverifiable, or the verifier gave no check for its id; shown as "check by hand",
              never counted toward the verdict
Only kept findings can make the review request changes.
"""
import json
import sys

data = json.load(sys.stdin)
minimum = int(data["min_confidence"])
checks = {}
for c in data["checks"]:
    checks.setdefault(c["id"], c)  # the first check for an id wins

reviews, unverified, dropped = [], [], []
found = kept = 0
for r in data["reviews"]:
    mine = []
    for f in r.get("findings", []):
        found += 1
        c = checks.get(f["id"])
        if c is None or c["verdict"] == "unverifiable":
            unverified.append({"reviewer": r["reviewer"], **f, "why": "unverifiable" if c else "no check was returned"})
        elif c["verdict"] == "confirmed" and c["confidence"] >= minimum:
            kept += 1
            mine.append({**f, "confidence": c["confidence"], "verification": c["evidence"]})
        else:
            dropped.append({"reviewer": r["reviewer"], "id": f["id"], "title": f["title"], "verdict": c["verdict"], "confidence": c["confidence"], "evidence": c["evidence"]})
    reviews.append({"reviewer": r["reviewer"], "summary": r.get("summary", ""), "findings": mine})

json.dump(
    {
        "reviews": reviews,
        "unverified": unverified,
        "dropped": dropped,
        "stats": {"found": found, "kept": kept, "unverified": len(unverified), "dropped": len(dropped), "min_confidence": minimum},
    },
    sys.stdout,
)
