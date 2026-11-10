"""An id for this release, used in branch names and file paths. Reads JSON on stdin, prints JSON.

Input:  prd (the release plan, only its title is read).
Output: {id}. The slug of the plan's title (lowercase a-z 0-9 and "-", other runs become one "-", trimmed, at most 40
        characters, "release" when nothing is left), a "-", then 6 random hex characters. The id matches
        ^[a-z0-9][a-z0-9-]{0,60}$.
The characters are random, not a hash of the run's inputs, so that two runs of the same goal on the same repository get
different branches: a hash would make the second run push over the branches of the first while its pull requests are
still open. A resumed run still keeps its names, because a step that succeeded is not run again and its output is carried
into the resumed run.
The title is untrusted text from an agent: only its ASCII letters and digits survive.
"""
import json
import re
import secrets
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

SLUG_MAX = 40


def text(value):
    return value if isinstance(value, str) else ""


def slug(title):
    # Only ASCII letters and digits are kept; anything else (spaces, punctuation, other scripts) is a separator.
    lowered = text(title).lower()
    s = re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")[:SLUG_MAX].strip("-")
    return s or "release"


def decide(data):
    prd = data.get("prd")
    title = prd.get("title") if isinstance(prd, dict) else None
    return {"id": f"{slug(title)}-{secrets.token_hex(3)}"}


payload = json.load(sys.stdin)
print(json.dumps(decide(payload if isinstance(payload, dict) else {})))
