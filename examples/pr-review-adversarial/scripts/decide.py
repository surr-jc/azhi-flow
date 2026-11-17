"""Decides whether this run reviews or is skipped as already done, with plain rules and no model.

Reads JSON on stdin: {force, post, fingerprint, existing}. `existing` is what the pull request's sticky comment says
(null when it was not read: a forced run, or a dry run, which always reviews). The run is skipped only when this
workflow's own comment exists and carries exactly the fingerprint computed for this run.
"""
import json
import sys

d = json.load(sys.stdin)
ex = d.get("existing")
if d.get("force"):
    out = {"decision": "run", "reason": "forced"}
elif d.get("post") is False:
    out = {"decision": "run", "reason": "dry run"}
elif not ex or not ex.get("found"):
    out = {"decision": "run", "reason": "no earlier review"}
elif not ex.get("fingerprint"):
    out = {"decision": "run", "reason": "the earlier review has no fingerprint"}
elif ex["fingerprint"] == d.get("fingerprint"):
    out = {"decision": "skip", "reason": "unchanged since the posted review"}
else:
    out = {"decision": "run", "reason": "the commit, requirement or workflow changed"}
print(json.dumps(out))
