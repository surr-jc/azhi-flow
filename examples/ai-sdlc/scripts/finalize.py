"""Picks the change that goes to release approval and writes its evidence record.

Reads JSON on stdin: the ticket, the weight decision, and for each path (lite, full) the rounds
that ran. A round is {change, verdicts}: the build agent's output for that round (null when the
round was skipped) and the reviewers' verdicts for it. The last round that ran wins.

The verdict rule is the AI-SDLC one: a round is approved only when every reviewer approved, no
finding is critical or major, and no reviewer saw a prompt injection attempt. If findings remain
after the last allowed round, the change is flagged needs_human_attention, never silently shipped.

The evidence record is a plain digest of what was reviewed and tested. It is not a signature.
"""
import hashlib
import json
import sys

data = json.load(sys.stdin)
weight = data["weight"]
rounds = data["lite"] if weight["final"] == "lite" else data["full"]
ran = [(i, r) for i, r in enumerate(rounds) if r.get("change")]
if not ran:
    raise SystemExit("no build ran")
index, last = ran[-1]
change = last["change"]
ws = change.get("workspace") or {}

reviewers, counts, findings = [], {"critical": 0, "major": 0, "minor": 0, "suggestion": 0}, []
injection = False
for name, v in (last.get("verdicts") or {}).items():
    if not v:
        continue
    injection = injection or bool(v.get("prompt_injection_detected"))
    n = {k: 0 for k in counts}
    for f in v.get("findings", []):
        n[f["severity"]] += 1
        counts[f["severity"]] += 1
        findings.append({"reviewer": name, **f})
    reviewers.append({"reviewer": name, "approved": bool(v.get("approved")), "summary": v.get("summary", ""), **n})

approved = bool(reviewers) and all(r["approved"] for r in reviewers) and counts["critical"] == 0 and counts["major"] == 0 and not injection
files = ws.get("files", [])
tests = ws.get("tests") or {}
tests_passed = tests.get("status") == "passed"
ship = tests_passed and len(files) > 0
flagged = not approved

digest = lambda s: hashlib.sha256(s.encode("utf-8")).hexdigest()
file_hashes = [{"path": f["path"], "status": f["status"], "sha256": digest(f.get("content", ""))} for f in sorted(files, key=lambda f: f["path"])]
record = {
    "ticket": data["ticket"],
    "repository": data["repo"],
    "base_sha": ws.get("base_sha"),
    "weight": weight,
    "design_review": data.get("design_review"),
    "fix_rounds_used": index,
    "tests": {k: tests.get(k) for k in ("status", "command", "exit_code", "attempts")},
    "reviewers": [{k: r[k] for k in ("reviewer", "approved", "critical", "major", "minor", "suggestion")} for r in reviewers],
    "verdict": {"approved": approved, "prompt_injection_detected": injection, "needs_human_attention": flagged},
    "files": file_hashes,
    "diff_sha256": digest(ws.get("diff", "")),
}
record["record_sha256"] = digest(json.dumps(record, sort_keys=True, separators=(",", ":")))

lines = ["## Evidence record", "",
         f"- Weight: **{weight['final']}** (proposed {weight['proposed']}" + (f", overridden by {weight['overridden_by']}" if weight.get("overridden_by") else "") + ")",
         f"- Fix rounds used: {index}",
         f"- Tests: {tests.get('status')} (`{tests.get('command')}`, attempt {tests.get('attempts')})",
         "- Reviewers: " + ("; ".join(f"{r['reviewer']} {'approved' if r['approved'] else 'requested changes'} ({r['critical']} critical, {r['major']} major)" for r in reviewers) or "none"),
         f"- Diff SHA-256: `{record['diff_sha256']}`",
         f"- Record SHA-256: `{record['record_sha256']}`",
         "", "This is a digest of what was reviewed and tested, not a signature.", "",
         "<details><summary>Record</summary>", "", "```json", json.dumps(record, indent=2, sort_keys=True), "```", "</details>"]
if flagged:
    lines = ["> **Needs human attention:** reviewers still have critical or major findings after the last fix round.", ""] + lines

title = change["pr_title"]
if flagged and "[needs-human-attention]" not in title:
    title = (title + " [needs-human-attention]")[:120]

out = {
    "ship": ship,
    "needs_human_attention": flagged,
    "round": index,
    "change": {
        "summary": change["summary"],
        "commit_message": change["commit_message"],
        "pr_title": title,
        "pr_body": change["pr_body"],
        "deviations": change["deviations"],
        "tests_added": change["tests_added"],
        "base_sha": ws.get("base_sha", ""),
        "files": files,
        "diff": ws.get("diff", ""),
        "stats": ws.get("stats") or {"files": len(files), "additions": 0, "deletions": 0},
        "tests": {k: tests[k] for k in ("status", "command", "exit_code", "attempts") if k in tests},
    },
    "verdict": {"approved": approved, "counts": counts, "reviewers": reviewers, "findings": findings, "prompt_injection_detected": injection},
    "evidence": record,
    "evidence_markdown": "\n".join(lines),
}
print(json.dumps(out))
