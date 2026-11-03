# Workflow bundles (export and import)

A **bundle** is one zip holding a workflow and everything it needs to run on another Azhi Flow. Export it from a workflow's **Version and files** settings (**Export bundle**); import it from **Workflows > Import a bundle** (admin).

## What is inside

```
bundle.json                        format, secret names, a SHA-256 of every other file
package/<path>                     the workflow package: workflow.yaml, profiles, harness, scripts, schemas, templates
tools/<id>@<version>.json          the gateway tools its steps and agents call
assets/<kind>/<slug>.json          attached library items: MCP servers, agents, skills, commands
datasets/<name>/dataset.json       trust, ACL and tags
datasets/<name>/docs/<path>        the dataset's documents (Markdown and text)
harness/opencode, harness/claude-code   the same library items as OpenCode and Claude Code files
```

The `harness/` files are for using the items outside Azhi; import ignores them. Secret **values** are never exported: the index lists the names a tool expects (`credential`), and the import report shows which are not yet set. Datasets the exporter may not read (dataset ACL) and tools that are no longer registered are listed under `omitted` rather than silently dropped.

## Importing

`POST /v1/workflows/import?mode=add|override&dry_run=true|false` with the zip as the body (`content-type: application/zip`, admin). The web page always runs a dry run first and shows each item as **add**, **replace**, **same** or **kept**.

| | `add` (default) | `override` |
|---|---|---|
| Tool, library item, dataset missing here | created | created |
| Exists and identical | unchanged | unchanged |
| Exists and differs | kept as it is | replaced: a new tool revision, a new library item version (published and attached), changed dataset documents rewritten and a new dataset revision published with the bundle's tags |
| Workflow exists here | kept | saved as a new **draft** version |

Nothing is deleted: documents not in the bundle stay, and earlier versions and revisions remain. In `add` mode an existing dataset keeps its own trust and ACL.

Order of writes: tools, datasets, the workflow package, then library items (attaching needs the workflow). If the workflow does not compile here, the tools and datasets already added stay; fix the cause and import again, since unchanged items are skipped.

The imported workflow is a draft. The web page signs it with the browser's publisher key as the Upload page does; publishing is still a separate step.

## Safety

A bundle is untrusted input. The reader rejects unsafe paths (`..`, absolute, backslashes), duplicate or encrypted entries, more than 5000 files, and entries over 16 MB (128 MB unpacked); every file's SHA-256 must match `bundle.json`; library items go through the same validation as the Library (including the check for secret-like values); datasets accept only Markdown and text. Importing tools can register commands that run on a worker (`mcp-stdio`) or call a URL, which is why it needs the admin role and why the plan lists each tool's transport before anything is written.
