"""Settles the easy conflict hunks with plain rules (no model) and says what is left.

Reads JSON on stdin: `change` (the `workspace` of the merge step: the pull request merged with its base, conflict
markers in the tree, `merge.conflicts` listing the unmerged paths by kind) and `pr` (facts passed through to the
later steps). The files are untrusted data from a repository: they are parsed, never run.

A hunk is settled only by a rule that cannot lose a side's change:
  identical     both sides made the same edit
  one_side      one side left the common ancestor's text alone, so the other side's edit wins
  whitespace    the sides differ only in trailing whitespace or blank lines (indentation is never touched)
  union         both sides only added lines to an import block or a changelog; the additions are combined
Everything else stays for the resolver. Whole files are never guessed: a conflict that is not "both sides edited
the file" (a delete against an edit, a rename), a binary file and a lock file are `blocked`, because the
resolver cannot delete files or run a package manager and a wrong guess there is silent.
"""
import fnmatch
import json
import re
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

LOCKFILES = ("package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "Pipfile.lock", "go.sum", "composer.lock", "Gemfile.lock", "uv.lock")
PROTECTED = (".github/*", ".claude/*", ".hooks/*", ".husky/*")
IMPORT = re.compile(r"^\s*(import\s|from\s+\S+\s+import\s|using\s|#include\s|use\s|(const|let|var)\s+.+=\s*require\()")
CHANGELOG = re.compile(r"(^|/)(changelog|changes|history|news|release[-_ ]?notes)(\.[a-z]+)?$", re.I)
START, BASE, MID, END = re.compile(r"^<{7}(\s|$)"), re.compile(r"^\|{7}(\s|$)"), re.compile(r"^={7}\s*$"), re.compile(r"^>{7}(\s|$)")


def text_of(line):
    return line.rstrip("\r\n")


def eol_of(line):
    return line[len(text_of(line)):] or "\n"


def parse(lines):
    """Yields ("text", [lines]) and ("hunk", ours, base, theirs, [raw lines]) in file order, or None when the markers are broken."""
    out, i = [], 0
    while i < len(lines):
        if not START.match(text_of(lines[i])):
            if out and out[-1][0] == "text":
                out[-1][1].append(lines[i])
            else:
                out.append(("text", [lines[i]]))
            i += 1
            continue
        raw, ours, base, theirs, part = [lines[i]], [], None, [], "ours"
        i += 1
        while i < len(lines):
            t = text_of(lines[i])
            raw.append(lines[i])
            if END.match(t):
                break
            if BASE.match(t) and part == "ours":
                part, base = "base", []
            elif MID.match(t) and part in ("ours", "base"):
                part = "theirs"
            else:
                {"ours": ours, "base": base, "theirs": theirs}[part].append(lines[i])
            i += 1
        else:
            return None
        if part != "theirs":
            return None
        out.append(("hunk", ours, base, theirs, raw))
        i += 1
    return out


def norm(ls):
    return [text_of(l).rstrip() for l in ls if text_of(l).strip()]


def settle(path, ours, base, theirs):
    """The lines that replace one hunk and the rule that settled it, or (None, None)."""
    o, t = [text_of(l) for l in ours], [text_of(l) for l in theirs]
    eol = eol_of((ours or theirs or ["\n"])[0])
    if o == t:
        return ours, "identical"
    if base is not None:
        b = [text_of(l) for l in base]
        if o == b:
            return theirs, "one_side"
        if t == b:
            return ours, "one_side"
    if norm(ours) == norm(theirs):
        return ours, "whitespace"
    if base is not None and (CHANGELOG.search(path) or (all(IMPORT.match(l) for l in o + t if l.strip()) and (o or t))):
        b = [text_of(l) for l in base]
        if all(l in o for l in b) and all(l in t for l in b):
            merged = o + [l for l in t if l not in o]
            return [l + eol for l in merged], "union"
    return None, None


def main():
    data = json.load(sys.stdin)
    change, pr = data["change"], data.get("pr") or {}
    merge = change.get("merge") or {}
    files = [dict(f) for f in change.get("files", [])]
    by_path = {f["path"]: f for f in files}
    resolved, remaining, protected, blocked = [], [], [], []

    for c in merge.get("conflicts", []):
        path, kind = c["path"], c["kind"]
        if path.rsplit("/", 1)[-1] in LOCKFILES:
            blocked.append(f"{path}: a lock file conflicts; regenerate it with the package manager (this workflow cannot run one)")
            continue
        if kind not in ("both_modified", "both_added"):
            blocked.append(f"{path}: {kind.replace('_', ' ')}; a person must decide whether the file stays")
            continue
        f = by_path.get(path)
        if f is None or f.get("encoding") == "base64" or f.get("content") is None:
            blocked.append(f"{path}: binary or unreadable conflicting file")
            continue
        if any(fnmatch.fnmatch(path, g) for g in PROTECTED):
            protected.append(path)
        parts = parse(f["content"].splitlines(keepends=True))
        if parts is None:
            blocked.append(f"{path}: the conflict markers are incomplete")
            continue
        out, left, total = [], 0, 0
        for p in parts:
            if p[0] == "text":
                out.extend(p[1])
                continue
            total += 1
            _, ours, base, theirs, raw = p
            lines, rule = settle(path, ours, base, theirs)
            if lines is None:
                left += 1
                out.extend(raw)
            else:
                out.extend(lines)
                resolved.append({"path": path, "rule": rule})
        f["content"] = "".join(out)
        if left:
            remaining.append({"path": path, "kind": kind, "hunks": left, "of": total})

    keep = ("path", "status", "mode", "content", "encoding")
    return {
        "change": {"repo": change["repo"], "base_sha": change["base_sha"], "files": [{k: f[k] for k in keep if k in f} for f in files]},
        "pr": {**pr, "head_sha": merge.get("head_sha", pr.get("head_sha", "")), "base_tip": merge.get("base_sha", "")},
        "conflicts": len(merge.get("conflicts", [])),
        "resolved": resolved,
        "remaining": remaining,
        "protected": sorted(set(protected)),
        "blocked": blocked,
        "needs_model": bool(remaining),
    }


if __name__ == "__main__":
    json.dump(main(), sys.stdout)
