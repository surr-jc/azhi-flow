"""Takes the last resolve attempt that ran, decides whether it may ship, and writes the evidence record.

Reads JSON on stdin: `pr` (repo, number, url, base_ref, head_ref, head_sha), `triage` (what the rules settled),
`attempts` (up to two: {resolution, compare, review, checks}, each null when that attempt did not run) and
`min_confidence`. Nothing here comes from the pull request text: titles, branch names and commit messages are
built from the number, the refs (checked against a plain-ref pattern) and fixed words.

A resolution ships (goes to the approval step) when no blocker stands. It opens as a DRAFT unless it is clean:
tests passed, the reviewer approved, no finding is left standing and no protected path was touched.
"""
import json
import re
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

REF = re.compile(r"^(?!.*\.\.)(?!-)[A-Za-z0-9/_.-]{1,200}$")
SHA = re.compile(r"^[0-9a-f]{7,64}$")
PUSH_KEYS = ("path", "status", "mode", "content", "encoding")


def main():
    d = json.load(sys.stdin)
    pr, triage, minimum = d["pr"], d["triage"], int(d["min_confidence"])
    attempts = [a for a in d.get("attempts", []) if a and a.get("resolution")]
    last = attempts[-1] if attempts else None
    number = int(pr["number"])
    base_ref = pr["base_ref"] if REF.match(str(pr.get("base_ref", ""))) else "the base branch"
    head_sha = pr["head_sha"] if SHA.match(str(pr.get("head_sha", ""))) else "unknown"
    blockers = list(triage.get("blocked", []))
    compare = (last or {}).get("compare") or {}
    review = (last or {}).get("review") or {}
    ws = ((last or {}).get("resolution") or {}).get("workspace") or {}

    standing = []
    if last:
        checks = {c["id"]: c for c in (last.get("checks") or [])}
        for f in review.get("findings", []):
            c = checks.get(f["id"])
            if f["severity"] in ("critical", "major") and c and c["verdict"] == "confirmed" and c["confidence"] >= minimum:
                standing.append(f)
        unresolved = last["resolution"].get("unresolved") or []
        if compare.get("verdict") in ("invalid", "regression"):
            why = compare.get("regressions", []) + [f"conflict markers left in {p}" for p in compare.get("markers_left", [])] + [f"changed {p}" for p in compare.get("out_of_scope", [])] + [f"dropped the pull request's change to {p}" for p in compare.get("dropped", [])]
            blockers.append(f"the check found a {compare['verdict']}: " + "; ".join(why or ["see the notes"]))
        if standing:
            blockers.append("the reviewer's critical or major finding stands after verification: " + "; ".join(f"{f['id']} {f['title']}" for f in standing))
        if review.get("prompt_injection_detected") or last["resolution"].get("prompt_injection_detected"):
            blockers.append("an agent reported text in the pull request or the repository that tried to instruct it")
        if unresolved:
            blockers.append("the resolver left these unresolved: " + ", ".join(unresolved))
        if not ws.get("files"):
            blockers.append("the merge produced no change to push")
    elif not blockers:
        blockers.append("no resolution was produced")

    ship = not blockers
    verification = compare.get("level", "none")
    clean = ship and compare.get("verdict") == "pass" and review.get("approved") and not triage.get("protected") and not any(f["severity"] in ("critical", "major") for f in review.get("findings", []))
    draft = ship and not clean
    stats = ws.get("stats") or {"files": 0, "additions": 0, "deletions": 0}
    settled = len(triage.get("resolved", []))
    left = sum(r.get("hunks", 0) for r in triage.get("remaining", []))
    summary = f"{triage.get('conflicts', 0)} conflicting file(s): {settled} hunk(s) settled by rules, {left} left for the resolver"

    lines = [
        f"Conflict resolution for #{number} against `{base_ref}`" + (" (DRAFT: needs a careful look)" if draft else ""),
        "",
        f"- {summary}.",
        f"- Verification: {'the project tests passed on the merged result' if compare.get('verdict') == 'pass' else 'NOT verified (' + str(compare.get('verdict', 'no result')) + ')'}.",
        f"- Review: {'approved' if review.get('approved') else 'not approved'}; {len(standing)} critical or major finding(s) stand.",
    ]
    for n in compare.get("notes", []):
        lines.append(f"- Note: {n}.")
    if triage.get("protected"):
        lines.append("- Touches protected paths, check them by hand: " + ", ".join(f"`{p}`" for p in triage["protected"]) + ".")
    body = "\n".join(lines + ["", f"Merge this branch into `{pr.get('head_ref', 'the pull request branch')}` with a merge commit, not a squash. Resolved at pull request head `{head_sha[:12]}`."])
    comment = "\n".join(lines) if ship else "\n".join([f"Conflict resolution for #{number} against `{base_ref}`: not resolved automatically.", ""] + [f"- {b}" for b in blockers])

    return {
        "ship": ship,
        "draft": draft,
        "attempt": len(attempts),
        "verdict": str(compare.get("verdict", "none")),
        "verification": verification,
        "branch": f"azhi/resolve-{number}-{head_sha[:12]}",
        "base_sha": ws.get("base_sha", ""),
        "files": [{k: f[k] for k in PUSH_KEYS if k in f} for f in ws.get("files", [])],
        "stats": stats,
        "commit_message": f"Resolve merge conflicts with {base_ref} for #{number}\n\nThe base tip was merged into the pull request head {head_sha[:12]}. {summary}.",
        "pr_title": f"Resolve merge conflicts with {base_ref} for #{number}",
        "pr_body": body,
        "comment": comment,
        "protected": triage.get("protected", []),
        "blockers": blockers,
        "blockers_text": "; ".join(blockers),
        "summary": summary,
    }


if __name__ == "__main__":
    json.dump(main(), sys.stdout)
