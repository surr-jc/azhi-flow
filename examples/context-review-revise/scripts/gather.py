"""Reads {"topic": ...} on stdin and prints the facts the writers will use. Fixture data: a real workflow would
call a search or lookup tool here."""
import json
import sys

# The worker pipes UTF-8 JSON; on Windows Python would read it in the legacy code page and corrupt non-ASCII text.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

topic = json.load(sys.stdin)["topic"]
facts = [
    f"{topic} has a short history that the draft should mention in one sentence.",
    f"{topic} is easiest to explain with one concrete example.",
    f"The reader knows nothing about {topic}.",
]
print(json.dumps({"topic": topic, "facts": facts}))
