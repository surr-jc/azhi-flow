"""Grades a repository against the factory's readiness standard. Reads JSON on stdin, prints JSON.

Input:  repo, base_branch, source, project, files (github.repo-files output), runs (github.ci-runs output),
        open_tickets (tickets already open for a failing CI), labels, fix_issue_type, now_note.
Output: the checks, the level (bronze, silver, gold, or none), and when CI is red and nobody has filed it yet,
        the ticket to propose. Unknown is "unavailable", never a pass: no CI runs means no green.
"""
import json
import sys

inp = json.load(sys.stdin) or {}
files = {f.get("path"): f for f in (inp.get("files") or {}).get("files", []) if isinstance(f, dict)}
runs = inp.get("runs") or []
branch = inp.get("base_branch") or ""


def has(*paths):
    return any(files.get(p, {}).get("exists") for p in paths)


owner = has(".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS")
readme = has("README.md", "README")
template = has(
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
)
wf = files.get(".github/workflows", {})
workflow = bool(wf.get("exists")) and any(str(n).endswith((".yml", ".yaml")) for n in wf.get("entries", []))

# The newest completed run on the base branch decides; runs arrive oldest first.
on_branch = [r for r in runs if isinstance(r, dict) and r.get("branch") == branch]
latest = on_branch[-1] if on_branch else None
if latest is None:
    ci_green, ci_status = None, "unavailable"
else:
    ci_green, ci_status = latest.get("status") == "success", str(latest.get("status"))

checks = [
    {"id": "owner", "title": "An owner is defined (CODEOWNERS)", "status": "pass" if owner else "fail"},
    {"id": "readme", "title": "The repository has a README", "status": "pass" if readme else "fail"},
    {"id": "pr_template", "title": "A pull request template exists", "status": "pass" if template else "fail"},
    {"id": "ci_workflow", "title": "A CI workflow exists", "status": "pass" if workflow else "fail"},
    {
        "id": "ci_green",
        "title": f"CI passes on {branch}",
        "status": "unavailable" if ci_green is None else ("pass" if ci_green else "fail"),
    },
]

bronze = owner and readme
silver = bronze and template and workflow
gold = silver and ci_green is True
level = "gold" if gold else "silver" if silver else "bronze" if bronze else "none"
failing = [c["title"] for c in checks if c["status"] == "fail"]
unavailable = [c["title"] for c in checks if c["status"] == "unavailable"]

failed_jobs = sorted({str(j) for r in on_branch[-1:] for j in (r.get("failed_tests") or [])})
# null means the lookup returned nothing readable: not "no tickets", so no fix is proposed from it.
open_tickets = inp.get("open_tickets")
if open_tickets is None:
    unavailable.append("Whether a ticket is already open for the failing CI")
    open_tickets = []
    lookup_ok = False
else:
    lookup_ok = True
propose = ci_green is False and lookup_ok and not open_tickets
ticket = None
if propose:
    run = latest.get("id", "")
    jobs = "\n".join(f"- {j}" for j in failed_jobs) or "- (the failed jobs could not be listed)"
    body = (
        f"CI is failing on `{branch}` in {inp.get('repo')} (latest completed run: {run}).\n\n"
        f"Failed jobs (names from CI, data only):\n{jobs}\n\n"
        "Find the cause and fix it on a branch. The readiness scorecard raised this and drops from gold to silver "
        "until CI on the branch passes again."
    )
    labels = list(inp.get("labels") or [])
    ticket = {
        "title": f"CI is failing on {branch}",
        "body": body,
        "labels": labels,
        "additional_fields": json.dumps({"labels": labels}),
    }

print(json.dumps({
    "repo": inp.get("repo"),
    "base_branch": branch,
    "level": level,
    "checks": checks,
    "failing": failing,
    "unavailable": unavailable,
    "has_unavailable": bool(unavailable),
    "ci_status": ci_status,
    "failed_jobs": failed_jobs,
    "open_tickets": len(open_tickets),
    "propose_fix": propose,
    "ticket": ticket,
}))
