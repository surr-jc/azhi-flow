"""One fingerprint of everything a review depends on, so a re-run with nothing new can be skipped.

Reads JSON on stdin: {repo, pr, head_sha, review_from, ticket, version}. The fingerprint is a SHA-256 over the
repository, the pull request, the head commit, the commit the diff starts from, the whole requirement (an edited
issue or description changes it) and the workflow's `fingerprint_version`, which you bump when the workflow or its
prompts change in a way that should re-review. It goes into the posted comment as a hidden marker; the next run
compares it with the one it reads back. Plain rules, no model.
"""
import hashlib
import json
import sys

d = json.load(sys.stdin)
t = d.get("ticket") or {}
parts = {
    "repo": d.get("repo"),
    "pr": d.get("pr"),
    "head_sha": d.get("head_sha"),
    "review_from": d.get("review_from") or "",
    "origin": t.get("origin"),
    "key": t.get("key"),
    "title": t.get("title"),
    "description": t.get("description"),
    "comments": t.get("comments"),
    "version": str(d.get("version")),
}
print(json.dumps({"value": hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=True).encode("utf-8")).hexdigest()}))
