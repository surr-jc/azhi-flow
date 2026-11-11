"""Derives the change id and the archive folder name from the ticket.

Reads JSON on stdin: {"key": ..., "title": ...}. The ticket text is untrusted, so the id is built only from
[a-z0-9-]: every other character becomes a hyphen. It is used as a folder name and a branch suffix, never as a
command. The date is the run's date (UTC), used for openspec/changes/archive/<date>-<id>/.
"""
import datetime
import json
import re
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

data = json.load(sys.stdin)
def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


# The key comes first and is never cut short of its own end: a release's Stories are `<release>-s1`, `-s2` and the
# release part alone can fill 48 characters, so cutting the joined text there gave every Story the same id.
key_slug = slugify(data.get("key") or "")[:61].strip("-")
slug = key_slug if len(key_slug) >= 48 else slugify(f"{data.get('key') or ''} {data.get('title') or ''}")[:48].strip("-")
if not slug:
    raise SystemExit("the ticket has no key or title to name the change after")
date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
print(json.dumps({"id": slug, "date": date, "change_dir": f"openspec/changes/{slug}", "archive_dir": f"openspec/changes/archive/{date}-{slug}"}))
