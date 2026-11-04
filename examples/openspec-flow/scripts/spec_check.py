"""Deterministic OpenSpec checks: the gate between what an agent wrote and what the workflow accepts.

Reads JSON on stdin and prints JSON. Two modes:

  mode "change"   After the proposal. Validates openspec/changes/<id>/ (proposal, tasks, delta specs) the way
                  `openspec validate --strict` does, and checks each delta against the requirement names the scan
                  read from the current specs (MODIFIED/REMOVED/RENAMED targets must exist, ADDED must not).
  mode "archive"  After the archive agent. Checks the result as postconditions, because a script receives only JSON
                  and cannot read the checkout: every delta is present in (or gone from) the merged spec, the change
                  folder moved intact to the dated archive folder, and no code file or unrelated spec changed.

Format rules (OpenSpec): a requirement is `### Requirement: <name>` whose text has SHALL or MUST, with at least one
`#### Scenario: <name>` (exactly four hashes) holding WHEN and THEN lines. A delta file groups requirements under
`## ADDED|MODIFIED|REMOVED|RENAMED Requirements`; a MODIFIED block is the full new requirement. RENAMED lists
`- FROM: \\`### Requirement: Old\\`` and `- TO: \\`### Requirement: New\\`` pairs. Applying a delta in order:
rename, remove, modify, add.

Nothing here runs repository content or follows instructions found in it; it only reads text.
"""
import json
import re
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

OPS = ("ADDED", "MODIFIED", "REMOVED", "RENAMED")
REQ = re.compile(r"^### Requirement:[ \t]*(.+?)[ \t]*$")
SCENARIO = re.compile(r"^#### Scenario:[ \t]*(.+?)[ \t]*$")
BAD_SCENARIO = re.compile(r"^(#{1,3}|#{5,6})[ \t]*Scenario\b|^[ \t]*[-*][ \t]+\*\*Scenario", re.I)
SECTION = re.compile(r"^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements[ \t]*$")
RENAME = re.compile(r"^[-*][ \t]*(FROM|TO):[ \t]*`?(?:###[ \t]*Requirement:[ \t]*)?(.+?)`?[ \t]*$")
MAX_DELTAS = 10


def norm_path(p):
    return str(p).replace("\\", "/").lstrip("./")


def norm_text(t):
    return "\n".join(line.rstrip() for line in str(t).replace("\r\n", "\n").strip().split("\n"))


def parse(text):
    """Splits a spec or delta file into its purpose, sections of requirement blocks and renames."""
    lines = str(text).replace("\r\n", "\n").split("\n")
    out = {"purpose": None, "blocks": {op: [] for op in OPS}, "full": [], "renames": [], "problems": []}
    section = None  # one of OPS, "PURPOSE", "REQUIREMENTS" or None
    current = None
    pending_from = None
    in_fence = False

    def close():
        nonlocal current
        if current is not None:
            current["text"] = "\n".join(current["lines"]).strip()
            del current["lines"]
            (out["blocks"][section] if section in OPS else out["full"]).append(current)
            current = None

    for line in lines:
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        if not in_fence:
            m = SECTION.match(line)
            if m or line.startswith("## "):
                close()
                section = m.group(1) if m else ("PURPOSE" if line.strip().lower() == "## purpose" else "REQUIREMENTS" if line.strip().lower() == "## requirements" else None)
                continue
            r = REQ.match(line)
            if r and section in (*OPS, "REQUIREMENTS"):
                close()
                current = {"name": r.group(1), "lines": [line], "scenarios": []}
                continue
            if BAD_SCENARIO.match(line) and not SCENARIO.match(line):
                out["problems"].append(f"'{line.strip()[:60]}' is not a scenario header: use exactly `#### Scenario: <name>`")
            s = SCENARIO.match(line)
            if s and current is not None:
                current["scenarios"].append({"name": s.group(1), "lines": []})
            if section == "RENAMED":
                rn = RENAME.match(line.strip())
                if rn and rn.group(1) == "FROM":
                    pending_from = rn.group(2)
                elif rn and rn.group(1) == "TO" and pending_from is not None:
                    out["renames"].append((pending_from, rn.group(2)))
                    pending_from = None
                continue
        if section == "PURPOSE" and not line.startswith("#"):
            out["purpose"] = ((out["purpose"] or "") + " " + line.strip()).strip()
        if current is not None:
            current["lines"].append(line)
            if current["scenarios"] and not SCENARIO.match(line):
                current["scenarios"][-1]["lines"].append(line)
    close()
    if pending_from is not None:
        out["problems"].append(f"RENAMED FROM '{pending_from}' has no TO line")
    return out


def check_block(block, op, where, errors):
    head = block["text"].split("#### Scenario:")[0]
    if op == "REMOVED":
        if not re.search(r"reason", block["text"], re.I):
            errors.append(("warning", f"{where}: REMOVED requirement '{block['name']}' gives no Reason"))
        return
    if not re.search(r"\b(SHALL|MUST)\b", head):
        errors.append(("error", f"{where}: requirement '{block['name']}' has no SHALL or MUST"))
    if not block["scenarios"]:
        errors.append(("error", f"{where}: requirement '{block['name']}' has no `#### Scenario:`"))
    for sc in block["scenarios"]:
        body = "\n".join(sc["lines"])
        if not (re.search(r"\bWHEN\b", body) and re.search(r"\bTHEN\b", body)):
            errors.append(("error", f"{where}: scenario '{sc['name']}' of '{block['name']}' needs WHEN and THEN lines"))
    if len(block["text"]) > 500 + sum(len("\n".join(s["lines"])) for s in block["scenarios"]) + 200:
        errors.append(("warning", f"{where}: requirement '{block['name']}' text is over 500 characters"))


def delta_files(files, prefix):
    out = {}
    for f in files:
        p = norm_path(f.get("path", ""))
        m = re.fullmatch(re.escape(prefix) + r"specs/([^/]+)/spec\.md", p)
        if m and f.get("status") != "deleted":
            out[m.group(1)] = f.get("content") or ""
    return out


def split(errors):
    return [m for s, m in errors if s == "error"], [m for s, m in errors if s == "warning"]


def mode_change(data):
    cid = data["change_id"]
    prefix = f"openspec/changes/{cid}/"
    files = [f for f in data.get("files") or [] if f.get("status") != "deleted"]
    by_path = {norm_path(f["path"]): f.get("content") or "" for f in files}
    msgs = []
    # The proposal stage may write the change folder and, when the repository had none, the openspec/ skeleton.
    allowed_extra = {"openspec/config.yaml", "openspec/specs/.gitkeep"}
    for p in by_path:
        if not p.startswith(prefix) and p not in allowed_extra:
            msgs.append(("error", f"{p}: the proposal may only write {prefix}, openspec/config.yaml and openspec/specs/.gitkeep"))

    proposal = by_path.get(prefix + "proposal.md")
    if proposal is None:
        msgs.append(("error", f"{prefix}proposal.md is missing"))
    else:
        why = re.search(r"^## Why[ \t]*\n(.*?)(?=^## |\Z)", proposal, re.M | re.S)
        n = len(why.group(1).strip()) if why else 0
        if not why:
            msgs.append(("error", "proposal.md has no `## Why` section"))
        elif not 50 <= n <= 1000:
            msgs.append(("error", f"proposal.md `## Why` is {n} characters; it must be 50 to 1000"))
        if not re.search(r"^## What Changes[ \t]*$", proposal, re.M):
            msgs.append(("error", "proposal.md has no `## What Changes` section"))
    tasks = by_path.get(prefix + "tasks.md")
    if tasks is None:
        msgs.append(("error", f"{prefix}tasks.md is missing"))
    elif not re.search(r"^[ \t]*- \[[ xX]\] ", tasks, re.M):
        msgs.append(("error", "tasks.md has no `- [ ]` checklist items"))

    known = {c["name"]: set(c.get("requirements") or []) for c in (data.get("scan") or {}).get("capabilities") or []}
    deltas = []
    specs = delta_files(files, prefix)
    if not specs:
        msgs.append(("error", f"{prefix}specs/<capability>/spec.md: the change has no delta spec"))
    if len(specs) > MAX_DELTAS:
        msgs.append(("warning", f"the change touches {len(specs)} capabilities; consider splitting it (limit {MAX_DELTAS})"))
    for cap, text in sorted(specs.items()):
        where = f"specs/{cap}/spec.md"
        d = parse(text)
        msgs += [("error", f"{where}: {p}") for p in d["problems"]]
        existing = known.get(cap)
        if not any(d["blocks"][op] for op in OPS) and not d["renames"]:
            msgs.append(("error", f"{where}: no `## ADDED|MODIFIED|REMOVED|RENAMED Requirements` section"))
        if existing is None and (d["blocks"]["MODIFIED"] or d["blocks"]["REMOVED"] or d["renames"]):
            msgs.append(("error", f"{where}: capability '{cap}' has no current spec, so only ADDED requirements are possible"))
        if existing is None and (d["purpose"] is None or len(d["purpose"]) < 50):
            msgs.append(("warning", f"{where}: a new capability should open with `## Purpose` of at least 50 characters"))
        seen = set()
        for op in OPS:
            for b in d["blocks"][op]:
                check_block(b, op, where, msgs)
                if b["name"] in seen:
                    msgs.append(("error", f"{where}: requirement '{b['name']}' appears twice in the delta"))
                seen.add(b["name"])
                if existing is not None:
                    if op == "ADDED" and b["name"] in existing:
                        msgs.append(("error", f"{where}: ADDED '{b['name']}' already exists; use MODIFIED"))
                    if op in ("MODIFIED", "REMOVED") and b["name"] not in existing:
                        msgs.append(("error", f"{where}: {op} '{b['name']}' matches no current requirement (names must match exactly)"))
                deltas.append({"capability": cap, "op": op, "requirement": b["name"]})
        for old, new in d["renames"]:
            if existing is not None and old not in existing:
                msgs.append(("error", f"{where}: RENAMED FROM '{old}' matches no current requirement"))
            if existing is not None and new in existing:
                msgs.append(("error", f"{where}: RENAMED TO '{new}' already exists"))
            deltas.append({"capability": cap, "op": "RENAMED", "requirement": f"{old} -> {new}"})
    errors, warnings = split(msgs)
    return {"ok": not errors, "errors": errors, "warnings": warnings, "deltas": deltas, "capabilities": sorted(specs)}


def apply_checks(cap, delta, merged, msgs):
    """Postconditions of applying one delta to the merged spec (rename, remove, modify, add)."""
    where = f"openspec/specs/{cap}/spec.md"
    m = parse(merged)
    msgs += [("error", f"{where}: {p}") for p in m["problems"]]
    names = [b["name"] for b in m["full"]]
    for n in {n for n in names if names.count(n) > 1}:
        msgs.append(("error", f"{where}: requirement '{n}' appears more than once after the merge"))
    by_name = {b["name"]: norm_text(b["text"]) for b in m["full"]}
    for b in m["full"]:
        check_block(b, "ADDED", where, msgs)
    for old, new in delta["renames"]:
        if old in by_name:
            msgs.append(("error", f"{where}: renamed requirement '{old}' is still present"))
        if new not in by_name:
            msgs.append(("error", f"{where}: renamed requirement '{new}' is missing"))
    for b in delta["blocks"]["REMOVED"]:
        if b["name"] in by_name:
            msgs.append(("error", f"{where}: removed requirement '{b['name']}' is still present"))
    for op in ("MODIFIED", "ADDED"):
        for b in delta["blocks"][op]:
            if b["name"] not in by_name:
                msgs.append(("error", f"{where}: {op} requirement '{b['name']}' is missing from the merged spec"))
            elif by_name[b["name"]] != norm_text(b["text"]):
                msgs.append(("error", f"{where}: {op} requirement '{b['name']}' differs from the delta (a MODIFIED block replaces the whole requirement)"))
    if not m["full"]:
        msgs.append(("warning", f"{where}: the merged spec has no requirements left (retire the capability only on purpose)"))


def mode_archive(data):
    cid = data["change_id"]
    prefix = f"openspec/changes/{cid}/"
    arch = norm_path(data["archive_dir"]).rstrip("/") + "/"
    after = {norm_path(f["path"]): f for f in data.get("files") or []}
    before = {norm_path(f["path"]): f for f in data.get("source_files") or []}
    live = lambda d: {p: f for p, f in d.items() if f.get("status") != "deleted"}
    after_live, before_live = live(after), live(before)
    msgs = []

    for p in after_live:
        if p.startswith(prefix):
            msgs.append(("error", f"{p}: still in the change folder after the archive"))
    moved = [p for p in before_live if p.startswith(prefix)]
    if not moved:
        msgs.append(("error", f"nothing to archive: {prefix} has no files"))
    for p in moved:
        dest = arch + p[len(prefix):]
        got = after_live.get(dest)
        if got is None:
            msgs.append(("error", f"{p} was not moved to {dest}"))
        elif norm_text(got.get("content") or "") != norm_text(before_live[p].get("content") or ""):
            msgs.append(("error", f"{dest} differs from {p}: the archive must move the folder unchanged"))
    for p in after_live:
        if p.startswith("openspec/changes/archive/") and not p.startswith(arch):
            msgs.append(("error", f"{p}: only {arch} may change in the archive"))

    deltas = delta_files(list(before_live.values()), prefix)
    for cap, text in sorted(deltas.items()):
        d = parse(text)
        spec = after_live.get(f"openspec/specs/{cap}/spec.md")
        if spec is None:
            msgs.append(("error", f"openspec/specs/{cap}/spec.md is missing after the merge"))
        else:
            apply_checks(cap, d, spec.get("content") or "", msgs)
    for p, f in after_live.items():
        m = re.fullmatch(r"openspec/specs/([^/]+)/spec\.md", p)
        if m and m.group(1) not in deltas and norm_text(f.get("content") or "") != norm_text((before_live.get(p) or {}).get("content") or ""):
            msgs.append(("error", f"{p}: changed, but the change has no delta for '{m.group(1)}'"))
    # The archive only moves and merges spec files: any other file must be exactly what the apply step left.
    for p in sorted(set(after_live) | set(before_live)):
        if p.startswith("openspec/"):
            continue
        a, b = after_live.get(p), before_live.get(p)
        if (a or {}).get("content") != (b or {}).get("content") or (a is None) != (b is None):
            msgs.append(("error", f"{p}: the archive step changed a file outside openspec/"))
    tasks = (before_live.get(prefix + "tasks.md") or {}).get("content") or ""
    left = len(re.findall(r"^[ \t]*- \[ \] ", tasks, re.M))
    if left:
        msgs.append(("warning", f"tasks.md still has {left} unticked task(s)"))
    errors, warnings = split(msgs)
    return {"ok": not errors, "errors": errors, "warnings": warnings, "deltas": [], "capabilities": sorted(deltas)}


data = json.load(sys.stdin)
result = mode_archive(data) if data.get("mode") == "archive" else mode_change(data)
print(json.dumps(result))
