"""Decides the review from the evidence, with plain rules and no model.

Reads JSON on stdin: {origin, requirements, conformance, reviews, probes, surface, strategy, checks, min_confidence}.
  strategy     the probe strategist's advice; only its advisory setup_command is used, to tell a person what to set
  reviews      the static reviewer's output ({reviewer, summary, findings})
  conformance  the conformance reviewer's output (criteria statuses and G findings)
  probes       probe_results.py output (one result per attack scenario)
  checks       the refuter's checks, one per finding id (C, S, G and P ids)

Adversarial verdict (the adversarial-pr-review skill):
  breaks    at least one reproduced failure that the refuter confirmed at or above min_confidence
  unproven  nothing reproduced, and a decisive scenario was not executed, or no probe executed and passed
  holds     a probe executed and passed, and nothing decisive is unproven. Not proof the change is correct.
A reproduced failure the refuter refuted, or could not confirm, is unproven: the probe may be wrong.

Overall light (what the PR gets): red when it breaks, a blocker survived, or a requirement is missing;
yellow when it is unproven, a major finding survived, or a requirement is only partly met, unverifiable or
unsettled; green otherwise. An inferred requirement (the PR's own description) never makes a light red.
"""
import json
import re
import sys

d = json.load(sys.stdin)
minimum = int(d["min_confidence"])
origin = d.get("origin") or "inferred"
inferred = origin == "inferred"
checks = {}
for c in d.get("checks") or []:
    checks.setdefault(c["id"], c)
MUST = {"blocker": "MUST", "major": "SHOULD", "minor": "MAY"}
RANK = {"blocker": 0, "major": 1, "minor": 2}


def clean(s, n=600):
    return re.sub(r"\s+", " ", str(s or "")).replace("`", "'").replace("@", "@​").strip()[:n]


def settle(f):
    """kept / dropped / unverified for one finding."""
    c = checks.get(f["id"])
    if c is None or c["verdict"] == "unverifiable":
        return "unverified", c
    if c["verdict"] == "confirmed" and c["confidence"] >= minimum:
        return "kept", c
    return "dropped", c


found = 0
kept_findings, check_by_hand, dropped = [], [], []
settled = {}  # finding id -> state, for the criteria below


def take(f, reviewer, source):
    global found
    found += 1
    state, c = settle(f)
    settled[f["id"]] = state
    row = {"id": f["id"], "source": source, "reviewer": reviewer, "path": f.get("path", ""), "line": f.get("line", 0), "title": clean(f["title"], 120), "detail": clean(f.get("detail"), 1000), "severity": f["severity"]}
    if f.get("criterion"):
        row["criterion"] = f["criterion"]
    if state == "kept":
        graded = c.get("severity") or f["severity"]
        if inferred and source == "conformance":
            graded = "minor"  # a gap against a requirement nobody wrote down is a question, not a defect
        row.update(severity=graded, confidence=c["confidence"], verification=clean(c["evidence"]))
        if graded != f["severity"]:
            row["reported_severity"] = f["severity"]
        kept_findings.append(row)
    elif state == "unverified":
        check_by_hand.append({**row, "why": "unverifiable" if c else "the refuter returned no check"})
    else:
        dropped.append({"id": f["id"], "title": row["title"], "verdict": c["verdict"], "confidence": c["confidence"], "evidence": clean(c["evidence"])})


for r in d.get("reviews") or []:
    for f in r.get("findings", []):
        take(f, r.get("reviewer", "static"), "static")
conf = d.get("conformance") or {}
for f in conf.get("findings", []):
    take(f, conf.get("reviewer", "conformance"), "conformance")

# Requirement criteria: the conformance reviewer's status, corrected by what the refuter decided.
said = {c["id"]: c for c in conf.get("criteria", [])}
by_criterion = {}
for f in conf.get("findings", []):
    if f.get("criterion"):
        by_criterion[f["criterion"]] = f["id"]
criteria = []
for r in (d.get("requirements") or {}).get("criteria", []):
    c = said.get(r["id"])
    status, why = ("unverifiable", "the conformance reviewer did not assess it") if c is None else (c["status"], c["evidence"])
    if status in ("missing", "partial"):
        gid = by_criterion.get(r["id"])
        state = settled.get(gid)
        if state == "dropped" and checks[gid]["verdict"] == "refuted":
            status, why = "met", "the refuter did not find the gap: " + why
        elif state != "kept":
            status, why = "unverifiable", "the gap could not be confirmed: " + why
    criteria.append({"id": r["id"], "text": clean(r["text"], 400), "kind": r["kind"], "status": status, "evidence": clean(why, 400), "path": (c or {}).get("path", ""), "line": (c or {}).get("line", 0)})
coverage = {k: sum(1 for c in criteria if c["status"] == k) for k in ("met", "partial", "missing", "unverifiable")}
coverage.update(total=len(criteria), inferred=inferred)

# Probes.
probes = d.get("probes") or {}
surface = d.get("surface") or {}
reproduced, ruled_out, unproven = [], [], []
for s in probes.get("scenarios", []):
    base = {k: s[k] for k in ("id", "title", "class", "level", "kind", "decisive", "mode", "command", "mechanism", "observed", "reason")}
    base["probe_files"] = [f["path"] for f in s["probe_files"]]
    base["title"] = clean(base["title"], 120)
    base["mechanism"] = clean(base["mechanism"], 300)
    base["command"] = clean(base["command"], 300)
    if s["state"] == "ruled_out":
        ruled_out.append(base)
    elif s["state"] == "unproven":
        unproven.append(base)
    else:
        found += 1
        state, c = settle({"id": s["id"]})
        if state == "kept":
            sev = MUST[c.get("severity") or {"high": "blocker", "medium": "major", "low": "minor"}[s["impact"]]]
            reproduced.append({**base, "severity": sev, "confidence": c["confidence"], "verification": clean(c["evidence"]), "impact": s["impact"]})
        else:
            if state == "dropped":
                dropped.append({"id": s["id"], "title": base["title"], "verdict": c["verdict"], "confidence": c["confidence"], "evidence": clean(c["evidence"])})
            why = "the refuter " + ("refuted it: " + clean(c["evidence"], 300) if state == "dropped" and c["verdict"] == "refuted" else "could not confirm it")
            unproven.append({**base, "reason": why + " (probe saw: " + base["observed"] + ")"})
reproduced.sort(key=lambda r: ["MUST", "SHOULD", "MAY"].index(r["severity"]))

strategy = d.get("strategy") or {}
executed = [s for s in probes.get("scenarios", []) if s["mode"] == "executed"]
# The setup advice is shown when probes were expected but none gave a result (the setup probably does not fit the project).
setup_hint = {
    "show": bool(strategy.get("setup_command")) and bool(executed) and (not probes.get("runner_ran", False) or not any(s["state"] != "unproven" for s in executed)),
    "command": clean(strategy.get("setup_command"), 600),
    "stack": clean(strategy.get("stack"), 200),
}

executable = surface.get("executable", True)
held_exec = any(r["level"].startswith("L3") for r in ruled_out)
decisive_open = any(u["decisive"] for u in unproven)
if reproduced:
    verdict, note = "breaks", "A failure was reproduced and independently confirmed."
elif not executable:
    verdict, note = "holds", "Nothing executable changed, so this means nothing was left to attack, not that the code is safe."
elif not probes.get("scenarios"):
    verdict, note = "unproven", "No attack scenario was selected or reported, so nothing was tried."
elif decisive_open:
    verdict, note = "unproven", "A decisive scenario could not be executed or confirmed."
elif not held_exec:
    verdict, note = "unproven", "No probe executed and passed: scenarios ruled out by reading alone do not carry a pass."
else:
    verdict, note = "holds", "The attacks that were tried did not land. This is not proof the change is correct."

kept_findings.sort(key=lambda f: (RANK[f["severity"]], f["id"]))
req_missing = [] if inferred else [c for c in criteria if c["status"] == "missing"]
req_soft = [] if inferred else [c for c in criteria if c["status"] in ("partial", "unverifiable")]
dirty = bool(probes.get("dirty_paths"))
if verdict == "breaks" or any(f["severity"] == "blocker" for f in kept_findings) or req_missing:
    light, rec = "red", "request_changes"
elif verdict == "unproven" or any(f["severity"] == "major" for f in kept_findings) or req_soft or check_by_hand or dirty:
    light, rec = "yellow", "comment"
else:
    light, rec = "green", "approve"

json.dump(
    {
        "verdict": verdict,
        "verdict_note": note,
        "light": light,
        "recommendation": rec,
        "origin": origin,
        "reproduced": reproduced,
        "ruled_out": ruled_out,
        "unproven": unproven,
        "findings": kept_findings,
        "check_by_hand": check_by_hand,
        "dropped": dropped,
        "setup_hint": setup_hint,
        "attack_surface": [{"element": x["element"], "what": clean(x["what"], 300), "where": clean(x["where"], 200)} for x in surface.get("surface", [])],
        "deferred": [{"title": clean(x["title"], 160), "why": clean(x["why"], 200)} for x in surface.get("deferred", [])],
        "criteria": criteria,
        "coverage": coverage,
        "stats": {"found": found, "kept": len(kept_findings) + len(reproduced), "unverified": len(check_by_hand), "dropped": len(dropped), "min_confidence": minimum, "probes_selected": len(probes.get("scenarios", [])), "probes_run": sum(1 for s in probes.get("scenarios", []) if s["mode"] == "executed" and s["state"] != "unproven")},
    },
    sys.stdout,
)
