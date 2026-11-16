"""Joins the two ways to a ticket: the GitHub issue (intake_github) or the inputs of a Story without a tracker
(files_ticket). Reads JSON on stdin, prints JSON.

Input:  {"github": <ticket or null>, "files": <ticket or null>}. Exactly one of them ran.
Output: that ticket with the nine fields ticket.normalize returns: {source, key, title, description, priority,
        reporter, status, labels, url}. A missing text is empty and missing labels are [].
Neither ticket, both, or a ticket without a key stops the Story (the script exits with an error): nothing can be built
without a ticket, and a guess would name the branch.
"""
import json
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

TEXT = ("source", "key", "title", "description", "priority", "reporter", "status", "url")


def fail(message):
    raise SystemExit(f"intake: {message}")


data = json.load(sys.stdin)
if not isinstance(data, dict):
    fail("the input is not an object")
found = [t for t in (data.get("github"), data.get("files")) if isinstance(t, dict)]
if not found:
    fail("no ticket was read: neither the GitHub issue nor the Story inputs ran")
if len(found) > 1:
    fail("two tickets were read, so it is not clear which Story this is")
ticket = found[0]
out = {name: ticket[name] if isinstance(ticket.get(name), str) else "" for name in TEXT}
if not out["key"]:
    fail("the ticket has no key")
labels = ticket.get("labels")
out["labels"] = [l for l in labels if isinstance(l, str)][:50] if isinstance(labels, list) else []
print(json.dumps(out))
