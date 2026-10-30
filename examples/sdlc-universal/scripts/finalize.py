"""Picks the change that goes to release approval and writes its evidence record.

Reads JSON on stdin: the ticket, the weight decision, the minimum verifier confidence, and for each
path (lite, full) the rounds that ran. A round is {change, verdicts, checks}: the build agent's output
for that round (null when the round was skipped), the reviewers' verdicts for it and the verifier's
checks of their critical and major findings. The last round that ran wins.

The verdict rule is the AI-SDLC one, with the verifier added: a round is approved only when every
reviewer approved (or all of their critical and major findings were refuted), no critical or major
finding was confirmed, none is left unverified, and no reviewer saw a prompt injection attempt. If findings remain
after the last allowed round, the change is flagged needs_human_attention, never silently shipped.

Some problems block instead of flag: a confirmed critical finding, an unmet acceptance criterion, a reviewer
that did not judge every acceptance criterion of the requirements, and a build that ran out of steps. A
blocked change has ship=false and `blockers` says why; the workflow sends it back instead of asking for release.

The evidence record is a plain digest of what was reviewed and tested. It is not a signature.
"""
import hashlib
import json
import re
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

data = json.load(sys.stdin)
weight = data["weight"]
rounds = data["lite"] if weight["final"] == "lite" else data["full"]
ran = [(i, r) for i, r in enumerate(rounds) if r.get("change")]
if not ran:
    raise SystemExit("no build ran")
index, last = ran[-1]
change = last["change"]
ws = change.get("workspace") or {}

# The verdicts and checks come from the latest round, up to the last build, that was reviewed. A fix whose diff is
# identical to the build before it is not reviewed again, and then the earlier round's findings still stand.
reviewed_index = next((i for i in range(index, -1, -1) if any((rounds[i].get("verdicts") or {}).values())), index)
review = rounds[reviewed_index]

# Critical and major findings count only when the verifier confirmed them with enough confidence.
# Refuted ones (or confirmed below the bar) are dropped and listed; unverifiable ones, or ones the
# verifier gave no check for, are kept apart and flag the change for a person instead of blocking it.
minimum = int(data.get("min_confidence", 80))
checks = {}
for c in review.get("checks") or []:
    checks.setdefault(c["id"], c)

reviewers, counts, findings, dropped, unverified = [], {"critical": 0, "major": 0, "minor": 0, "suggestion": 0}, [], [], []
injection = False
reviewers_ok = True
for name, v in (review.get("verdicts") or {}).items():
    if not v:
        continue
    injection = injection or bool(v.get("prompt_injection_detected"))
    n = {k: 0 for k in counts}
    blocking = contested = 0
    for f in v.get("findings", []):
        if f["severity"] in ("critical", "major"):
            contested += 1
            c = checks.get(f.get("id"))
            if c is None or c["verdict"] == "unverifiable":
                unverified.append({"reviewer": name, **f, "why": "unverifiable" if c else "no check was returned"})
                continue
            if not (c["verdict"] == "confirmed" and c["confidence"] >= minimum):
                dropped.append({"reviewer": name, "id": f.get("id"), "severity": f["severity"], "verdict": c["verdict"], "confidence": c["confidence"], "evidence": c["evidence"]})
                continue
            blocking += 1
            findings.append({"reviewer": name, **f, "confidence": c["confidence"]})
        else:
            findings.append({"reviewer": name, **f})
        n[f["severity"]] += 1
        counts[f["severity"]] += 1
    # A reviewer who asked for changes is satisfied when every critical or major finding of theirs was
    # refuted; one who asked for changes without any such finding stays unsatisfied.
    approved_by_reviewer = bool(v.get("approved")) or (contested > 0 and blocking == 0 and not any(u["reviewer"] == name for u in unverified))
    reviewers_ok = reviewers_ok and approved_by_reviewer
    reviewers.append({"reviewer": name, "approved": approved_by_reviewer, "summary": v.get("summary", ""), **n})

approved = bool(reviewers) and reviewers_ok and counts["critical"] == 0 and counts["major"] == 0 and not injection and not unverified
files = ws.get("files", [])
tests = ws.get("tests") or {}
tests_passed = tests.get("status") == "passed"
# What the reviewers say about each acceptance criterion (the first reviewer that returned them).
criteria = []
for _v in (review.get("verdicts") or {}).values():
    if _v and _v.get("criteria"):
        criteria = _v["criteria"]
        break
crit_counts = {k: sum(1 for c in criteria if c.get("status") == k) for k in ("met", "partial", "unmet", "unverifiable")}
all_met = bool(criteria) and crit_counts["met"] == len(criteria)
# The reviewer must judge every acceptance criterion of the requirements; a short or missing list is not a pass.
expected = (data.get("requirements") or {}).get("acceptance_criteria") or []
criteria_missing = max(0, len(expected) - len(criteria))
incomplete = crit_counts["partial"] + crit_counts["unmet"] + criteria_missing > 0
step_limit = bool(ws.get("step_limit_reached"))

# Whether the new or changed test files were run (the static test command prints a marker line).
_m = re.search(r"AZHI_TARGETED_TESTS (passed|failed) (\d+) file", tests.get("output") or "")
targeted = {"result": _m.group(1), "files": int(_m.group(2))} if _m else None

# How the change was verified: "full" (the whole test command passed), "static" (the full command could
# not run here, so typecheck and build passed instead) or "none" (nothing could run and a person chose to
# continue). Only "full" can open as a normal pull request.
verification = data.get("verification") or ("none" if data.get("untested") else "full")
untested = verification == "none" and not tests_passed
static = verification == "static"
# Blockers keep the change from release approval altogether; everything else only flags the pull request.
blockers = []
if counts["critical"]:
    blockers.append(f"{counts['critical']} confirmed critical finding(s): " + ", ".join(f["id"] for f in findings if f["severity"] == "critical"))
if crit_counts["unmet"]:
    blockers.append(f"{crit_counts['unmet']} acceptance criterion(s) unmet")
if criteria_missing:
    blockers.append(f"the reviewer judged {len(criteria)} of {len(expected)} acceptance criteria")
if step_limit:
    blockers.append("the build ran out of steps and may be unfinished")
ship = (tests_passed or untested) and len(files) > 0 and not blockers
flagged = (not approved) or untested or static or incomplete or step_limit
strategy = data.get("strategy") or {}

# A pull request that closes its ticket on merge must be one that finishes it: otherwise the closing keyword
# ("Closes #28") becomes "Refs #28", so merging a draft never closes the ticket by itself.
closing_ok = (not flagged) and verification == "full" and (all_met or not criteria)
pr_body = change["pr_body"]
closes_removed = False
_closing = re.compile(r"(?im)^(\s*)(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*((?:[\w.-]+/[\w.-]+)?#\d+)")
if not closing_ok and _closing.search(pr_body):
    pr_body = _closing.sub(lambda m: f"{m.group(1)}Refs {m.group(2)}", pr_body)
    closes_removed = True

digest = lambda s: hashlib.sha256(s.encode("utf-8", "surrogatepass")).hexdigest()
file_hashes = [{"path": f["path"], "status": f["status"], "sha256": digest(f.get("content", ""))} for f in sorted(files, key=lambda f: f["path"])]
record = {
    "ticket": data["ticket"],
    "repository": data["repo"],
    "base_sha": ws.get("base_sha"),
    "weight": weight,
    "design_review": data.get("design_review"),
    "fix_rounds_used": index,
    "reviewed_round": reviewed_index,
    "blockers": blockers,
    "step_limit_reached": step_limit,
    "tests": {k: tests.get(k) for k in ("status", "command", "exit_code", "attempts")},
    "verification": verification,
    "coverage": strategy or None,
    "criteria": criteria,
    "criteria_expected": len(expected),
    "targeted_tests": targeted,
    "closing_keyword_replaced": closes_removed,
    "reviewers": [{k: r[k] for k in ("reviewer", "approved", "critical", "major", "minor", "suggestion")} for r in reviewers],
    "verdict": {"approved": approved, "prompt_injection_detected": injection, "needs_human_attention": flagged, "verification": {"min_confidence": minimum, "dropped": len(dropped), "unverified": len(unverified)}},
    "files": file_hashes,
    "diff_sha256": digest(ws.get("diff", "")),
}
record["record_sha256"] = digest(json.dumps(record, sort_keys=True, separators=(",", ":")))

lines = ["## Evidence record", "",
         f"- Weight: **{weight['final']}** (proposed {weight['proposed']}" + (f", overridden by {weight['overridden_by']}" if weight.get("overridden_by") else "") + ")",
         f"- Fix rounds used: {index}",
         f"- Tests: {tests.get('status')} (`{tests.get('command')}`, attempt {tests.get('attempts')})",
         *([f"- New or changed test files run: {targeted['result']} ({targeted['files']} file(s))"] if targeted else []),
         *([f"- Acceptance criteria: {crit_counts['met']} of {len(criteria)} met" + "".join(f", {crit_counts[k]} {k}" for k in ("partial", "unmet", "unverifiable") if crit_counts[k])] if criteria else []),
         *(["- Closing keyword replaced by `Refs`: this change does not finish the ticket, so merging it will not close it"] if closes_removed else []),
         "- Reviewers: " + ("; ".join(f"{r['reviewer']} {'approved' if r['approved'] else 'requested changes'} ({r['critical']} critical, {r['major']} major)" for r in reviewers) or "none"),
         f"- Verifier: {len(dropped)} critical or major finding(s) refuted or below {minimum}/100 and dropped, {len(unverified)} could not be verified",
         f"- Diff SHA-256: `{record['diff_sha256']}`",
         f"- Record SHA-256: `{record['record_sha256']}`",
         "", "This is a digest of what was reviewed and tested, not a signature.", "",
         "<details><summary>Record</summary>", "", "```json", json.dumps(record, indent=2, sort_keys=True), "```", "</details>"]
def cell(text, limit=300):
    t = " ".join(str(text).split()).replace("|", "\\|")
    return t if len(t) <= limit else t[: limit - 3] + "..."


# Reviewer text is model output about untrusted code: it goes into the pull request as table cells and list items only.
detail = []
if blockers:
    detail += ["### Blockers", ""] + [f"- {b}" for b in blockers] + [""]
if findings:
    detail += ["### Review findings", "", "| ID | Severity | Where | Message | Confidence |", "|---|---|---|---|---|"]
    for f in findings:
        where = f.get("path", "") + (f":{f['line']}" if f.get("line") else "")
        detail.append(f"| {f['id']} | {f['severity']} | {cell(where, 120)} | {cell(f['message'])} | {f.get('confidence', '-')} |")
    detail.append("")
if unverified:
    detail += ["### Findings the verifier could not settle", ""] + [f"- {u.get('id')} ({u['severity']}, {cell(u.get('path', ''), 120)}): {cell(u['message'])} - {u['why']}" for u in unverified] + [""]
if dropped:
    detail += ["### Findings dropped by the verifier", ""] + [f"- {d['id']} ({d['severity']}): {d['verdict']} at {d['confidence']}/100" for d in dropped] + [""]
open_criteria = [c for c in criteria if c.get("status") != "met"]
if open_criteria or criteria_missing:
    detail += ["### Acceptance criteria not met", "", "| Criterion | Status | Evidence |", "|---|---|---|"]
    detail += [f"| {cell(c['criterion'])} | {c['status']} | {cell(c['evidence'])} |" for c in open_criteria]
    if criteria_missing:
        detail.append(f"| {criteria_missing} criterion(s) the reviewer did not judge | missing | |")
    detail.append("")
if detail:
    at = lines.index("<details><summary>Record</summary>")
    lines = lines[:at] + detail + lines[at:]

if untested:
    lines = ["> **WARNING - NOT VERIFIED BY TESTS:** the test suite could not run in this environment (the base branch failed its own tests before any change), and a person chose to continue. Run the tests yourself before merging.", ""] + lines
if static:
    cov = ""
    if strategy:
        cov = (" Blocked here: " + str(strategy.get("blocked_suites")) + " suite(s), runnable: " + str(strategy.get("runnable_suites"))
               + " (" + str(strategy.get("basis")) + "). Not covered: " + str(strategy.get("does_not_cover")) + ".")
    lines = ["> **VERIFIED BY STATIC CHECKS ONLY:** the full test command could not run in this environment ("
             + str(strategy.get("failure_class", "unknown")) + "), so typecheck and build passed instead. That shows the change compiles, not that it behaves."
             + (f" The new or changed test files were also run and {targeted['result']}." if targeted else " No test was run.")
             + cov + " Run the tests before merging.", ""] + lines
if flagged and not ((untested or static) and approved):
    lines = ["> **Needs human attention:** reviewers still have critical or major findings after the last fix round, findings the verifier could not settle, acceptance criteria that are not met, or a build that ran out of steps.", ""] + lines

title = change["pr_title"]
if untested and "[untested]" not in title:
    title = (title + " [untested]")[:120]
elif static and "[static-checks-only]" not in title:
    title = (title + " [static-checks-only]")[:120]
elif flagged and "[needs-human-attention]" not in title:
    title = (title + " [needs-human-attention]")[:120]

out = {
    "ship": ship,
    "blocked": bool(blockers),
    "blockers": blockers,
    "blockers_text": "; ".join(blockers),
    "needs_human_attention": flagged,
    "untested": untested,
    "verification": verification,
    "round": index,
    "change": {
        "summary": change["summary"],
        "commit_message": change["commit_message"],
        "pr_title": title,
        "pr_body": pr_body,
        "deviations": change["deviations"],
        "tests_added": change["tests_added"],
        "base_sha": ws.get("base_sha", ""),
        "files": files,
        "diff": ws.get("diff", ""),
        "stats": ws.get("stats") or {"files": len(files), "additions": 0, "deletions": 0},
        "tests": {k: tests[k] for k in ("status", "command", "exit_code", "attempts") if k in tests},
    },
    "verdict": {"approved": approved, "counts": counts, "reviewers": reviewers, "findings": findings, "dropped": dropped, "unverified": unverified, "prompt_injection_detected": injection},
    "evidence": record,
    "criteria": criteria,
    "criteria_counts": crit_counts,
    "criteria_missing": criteria_missing,
    "targeted_tests": targeted,
    "closes_removed": closes_removed,
    "evidence_markdown": "\n".join(lines),
}
print(json.dumps(out))
