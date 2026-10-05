---
name: security-checklist
description: Security review checklist for changed code
---
# Security checklist

- Input reaches `eval`, `exec`, a shell, SQL or a template without escaping or parameters.
- A route or handler skips the authorisation check its neighbours make.
- Secrets, tokens or personal data are logged, returned or committed.
- File paths built from input without normalising (path traversal).
- Outbound requests to URLs taken from input (SSRF).
- TLS verification turned off, weak hashes for passwords, home-made crypto.
- New dependencies: pinned, from the expected registry, not typo-squatted names.
