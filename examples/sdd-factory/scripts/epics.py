"""Writes the text of each epic the backlog splitter will receive. Reads JSON on stdin, prints JSON.

Input:  prd (the approved release plan), drop (epic numbers the approver left out, e.g. "2,3"), brief_key, greenfield
        (true when the repository has no code yet: the first epic kept then says its first slice is a runnable scaffold).
Output: the epics to split, in order, each as one Markdown text with the release context in front, so the
        splitter's analyst sees the invariants and journeys, not just its own epic. Epic numbers keep the plan's
        numbering. Text is cut to the splitter's 20000 character limit.
"""
import json
import re
import sys

d = json.load(sys.stdin) or {}
prd = d.get("prd") or {}
dropped = {int(n) for n in re.findall(r"\d+", d.get("drop") or "")}
MAX = 19000
GREENFIELD = (
    "\n## Greenfield\nThe repository has no code yet. The first Story of this epic is a runnable scaffold: the project layout "
    "for the chosen stack, one passing test, a CI workflow that runs it, a README with the run and test commands, and "
    ".azhi/commands.json with the install, typecheck, test and build commands. Plan nothing else in this epic until it.\n"
)


def bullets(items):
    return "\n".join(f"- {x}" for x in items) if items else "- none stated"


context = (
    f"# Release: {prd.get('title', '')}\n\n{prd.get('summary', '')}\n\n"
    f"## Invariants (must stay true after every ticket)\n{bullets(prd.get('invariants'))}\n\n"
    f"## User journeys\n" + "\n".join(f"- {j['name']}: " + " -> ".join(j["steps"]) for j in prd.get("journeys") or []) + "\n\n"
    f"## Non-goals\n{bullets(prd.get('non_goals'))}\n"
)

epics = []
for n, e in enumerate(prd.get("epics") or [], start=1):
    if n in dropped:
        continue
    note = e.get("depends_on_note") or ""
    text = (
        f"{context}\n# Epic {n}: {e['title']}\n\n{e['goal']}\n\n## Scope\n{bullets(e.get('scope'))}\n\n"
        f"## Acceptance criteria\n{bullets(e.get('acceptance_criteria'))}\n"
        + (f"\n## Order\n{note}\n" if note else "")
    )
    if n == 1 and prd.get("walking_skeleton"):
        text += f"\n## Walking skeleton\n{prd['walking_skeleton']}\n"
    # The scaffold goes in the first epic that is split, whichever epic that is: the approver may have left epic 1 out.
    # The cut leaves room for it, so a long epic never loses the instruction.
    scaffold = not epics and d.get("greenfield") is True
    limit = MAX - len(GREENFIELD) if scaffold else MAX
    truncated = len(text) > limit
    text = text[:limit] + (GREENFIELD if scaffold else "")
    epics.append({"n": n, "title": e["title"], "text": text, "truncated": truncated})

print(json.dumps({"count": len(epics), "epics": epics, "dropped": sorted(dropped)}))
