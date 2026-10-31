"""Picks the next ticket for one lap of the factory, by rules. Reads JSON on stdin, prints JSON.

Input:  source (github|jira), repo, config {claim_label, owner_label, priority_label},
        github {queues: [github.factory-queue items ...]} or jira {issues: [jira_search issues]}.
Output: route "work" or "idle", the ticket to deliver, the label sets for the claim and a send-back, and why
        every other ticket was skipped.

The order is the transcript's: a ticket that is blocked, already claimed or in a pull request, or waiting for
its owner is never picked; then priority first, then the ticket that unblocks the most other queued tickets,
then the oldest. Anything that cannot be read (a status, a dependency) counts as blocking: the lap does less
rather than start work out of order. Ticket text is data; nothing in it is run.
"""
import json
import re
import sys

d = json.load(sys.stdin) or {}
cfg = d.get("config") or {}
claim, owner, prio = cfg.get("claim_label", ""), cfg.get("owner_label", ""), cfg.get("priority_label", "")
source = d.get("source", "github")
repo = d.get("repo", "")

DONE_NAMES = {"done", "closed", "resolved", "complete", "completed"}
HIGH = {"highest", "high", "blocker", "critical"}
SLICE = re.compile(r"Slice (\d+) of (\d+)\.")
DEP = re.compile(r"Depends on ([^\n]*?)\. Do not start")
DEP_ONE = re.compile(r"slice (\d+):([^;]*)")


def slice_text(text):
    text = text or ""
    s, dep = SLICE.search(text), DEP.search(text)
    depends = []
    if dep:
        depends = [int(m.group(1)) for m in DEP_ONE.finditer(dep.group(1)) if "left out of this plan" not in m.group(2)]
    return (int(s.group(1)) if s else 0), depends


items = []
unreadable = False
if source == "github":
    seen = set()
    for q in (d.get("github") or {}).get("queues") or []:
        for it in (q or {}).get("items") or []:
            if it["number"] in seen:
                continue
            seen.add(it["number"])
            items.append({
                "key": f"#{it['number']}",
                "ref": f"{repo}#{it['number']}",
                "number": it["number"],
                "title": it.get("title", ""),
                "labels": list(it.get("labels") or []),
                "parent": str(it.get("parent") or ""),
                "slice": int(it.get("slice") or 0),
                "depends": list(it.get("depends") or []),
                "blocked": bool(it.get("blocked")),
                "reason": it.get("reason", ""),
                "in_flight": bool(it.get("in_flight")),
                "done": False,
                "high": prio in (it.get("labels") or []),
                "created": it.get("created_at", ""),
                "sort": it["number"],
            })
else:
    issues = (d.get("jira") or {}).get("issues")
    unreadable = issues is None
    issues = issues or []

    def field(i, k):
        f = i.get("fields") if isinstance(i.get("fields"), dict) else {}
        return i.get(k, f.get(k))

    def name_of(v):
        return (v.get("name") if isinstance(v, dict) else v) or ""

    def is_done(status):
        # None when the status cannot be read: that is not "done".
        if not status:
            return None
        if isinstance(status, dict):
            cat = status.get("category") or (status.get("statusCategory") or {}).get("key") or (status.get("statusCategory") or {}).get("name") or ""
            if str(cat).lower() in ("done", "complete"):
                return True
            nm = status.get("name", "")
            return str(nm).lower() in DONE_NAMES if nm else None
        return str(status).lower() in DONE_NAMES

    def parent_of(i):
        p = field(i, "parent")
        if isinstance(p, dict):
            return str(p.get("key") or "")
        if p:
            return str(p)
        m = re.search(r"^Part of ([A-Z][A-Z0-9_]*-\d+)", str(field(i, "description") or ""), re.M)
        return m.group(1) if m else ""

    by_key = {}
    for i in issues:
        key = str(i.get("key") or "")
        if not key:
            continue
        sl, deps = slice_text(str(field(i, "description") or ""))
        by_key[key] = {"i": i, "slice": sl, "depends": deps, "parent": parent_of(i), "done": is_done(field(i, "status"))}

    for key, b in by_key.items():
        i = b["i"]
        why = []
        # Blocked by an issue link ("is blocked by"): the other issue must be done, and readable.
        for link in field(i, "issuelinks") or []:
            t = link.get("type") or {}
            other = link.get("inward_issue") or link.get("inwardIssue")
            if not other or "block" not in (str(t.get("inward", "")) + str(t.get("name", ""))).lower():
                continue
            st = is_done(other.get("status") or (other.get("fields") or {}).get("status"))
            if st is not True:
                why.append(f"blocked by {other.get('key', 'an issue')}" + ("" if st is False else " (status unreadable)"))
        # Blocked by an earlier slice named in its description.
        for n in b["depends"]:
            sib = next((v for k, v in by_key.items() if v["parent"] and v["parent"] == b["parent"] and v["slice"] == n), None)
            if not b["parent"]:
                why.append(f"depends on slice {n} but names no parent")
            elif sib is None:
                why.append(f"slice {n} not found among the results (the query must include done issues)")
            elif sib["done"] is not True:
                why.append(f"waiting for slice {n}" + ("" if sib["done"] is False else " (status unreadable)"))
        labels = [str(x) for x in (field(i, "labels") or [])]
        pr = name_of(field(i, "priority")).lower()
        items.append({
            "key": key,
            "ref": key,
            "number": 0,
            "title": str(field(i, "summary") or ""),
            "labels": labels,
            "parent": b["parent"],
            "slice": b["slice"],
            "depends": b["depends"],
            "blocked": bool(why),
            "reason": "; ".join(why),
            "in_flight": bool(claim) and claim in labels,
            "done": b["done"],
            "high": prio in labels or pr in HIGH,
            "created": str(field(i, "created") or ""),
            "sort": int(key.rsplit("-", 1)[-1]) if key.rsplit("-", 1)[-1].isdigit() else 0,
        })

skipped, candidates = [], []
for it in items:
    if it["done"] is True:
        why = "already done"
    elif it["done"] is None and source == "jira":
        why = "status unreadable"
    elif it["in_flight"]:
        why = "a lap or a pull request already has it"
    elif owner and owner in it["labels"]:
        why = "waiting for its owner"
    elif it["blocked"]:
        why = it["reason"] or "blocked"
    else:
        candidates.append(it)
        continue
    skipped.append({"key": it["key"], "why": why})


def unblocks(it):
    # Other tickets still waiting that name this slice of the same parent.
    if not it["slice"] or not it["parent"]:
        return 0
    return sum(1 for o in items if o is not it and o["parent"] == it["parent"] and it["slice"] in o["depends"] and o["done"] is not True)


candidates.sort(key=lambda it: (not it["high"], -unblocks(it), it["created"] or "~", it["sort"]))
chosen = candidates[0] if candidates else None


def labels_json(labels):
    return json.dumps({"labels": labels})


if chosen:
    claimed = sorted(set(chosen["labels"]) | ({claim} if claim else set()))
    sent_back = sorted(set(chosen["labels"]) | ({claim} if claim else set()) | ({owner} if owner else set()))
    why = (["high priority"] if chosen["high"] else []) + ([f"unblocks {unblocks(chosen)} other ticket(s)"] if unblocks(chosen) else [])
    out = {
        "route": "work",
        "ticket": {"source": source, "key": chosen["key"], "ref": chosen["ref"], "number": chosen["number"], "title": chosen["title"]},
        "reason": "; ".join(why) or "oldest workable ticket",
        "claim_labels": [claim] if claim else [],
        "claim_fields": labels_json(claimed),
        "sendback_labels": [owner] if owner else [],
        "sendback_fields": labels_json(sent_back),
        "skipped": skipped,
    }
else:
    out = {
        "route": "idle",
        "ticket": {"source": source, "key": "", "ref": "", "number": 0, "title": ""},
        "reason": "the Jira search returned nothing readable" if source == "jira" and unreadable else "nothing is workable" if items else "the queue is empty",
        "claim_labels": [],
        "claim_fields": "{}",
        "sendback_labels": [],
        "sendback_fields": "{}",
        "skipped": skipped,
    }
print(json.dumps(out))
