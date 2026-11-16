# Workflow tags and categories

A workspace with hundreds of workflows needs more than a search box. Every workflow carries
`tags`, and the workflow list files it under a category picked from them.

## Tags

```yaml
schema_version: "2.0"
id: pr-review
name: Pull request review
tags: [code-review, pull-request, github]
```

Up to 10 tags, each lowercase letters, digits and dashes (32 characters at most), no repeats.
Tags are part of the definition, so they are versioned and signed with it. Set them in
`workflow.yaml`, in the editor (Workflow > Tags), or let the builder chat write them: its skill
tells it to tag every workflow it creates.

## How the category is picked

The category is never stored. The server reads the tags of the workflow's latest version and
takes the category of **the first tag a category knows** (`src/definition/category.ts`), so put
the most telling tag first.

| Category | Tags that pick it |
| --- | --- |
| Delivery | `delivery`, `sdlc`, `implementation`, `feature`, `release`, `factory` |
| Planning | `planning`, `breakdown`, `spec`, `sizing`, `readiness` |
| Code review | `code-review`, `review`, `pull-request`, `merge-conflict` |
| Investigation | `investigation`, `rca`, `debugging`, `incident`, `triage` |
| Testing | `testing`, `qa`, `verification` |
| Reports | `report`, `digest`, `metrics`, `summary` |
| Operations | `operations`, `ci`, `deploy`, `monitoring`, `maintenance` |
| Security | `security`, `compliance`, `audit`, `vulnerability` |
| Documentation | `documentation`, `docs`, `knowledge` |
| Support | `support`, `customer`, `helpdesk` |
| Data | `data`, `etl`, `analytics` |
| Learn Azhi | `learn`, `demo`, `tutorial` |

When no tag names a category the API says `category: null`; it does not guess from the name or
the description. The list then shows the workflow under "Other" (a version saved before tags
existed keeps the category the marketplace gave it). Other tags (`github`, `jira`, a team name)
do not pick a category but are searchable.

## In mission control

- **Workflows**: a chip per category with its count, the list grouped under category headings,
  tags on each card (click one to search for it), and a search that matches name, description,
  id and tags.
- **Marketplace**: bundled workflows are filed by the same rule from their own tags.
- **Editor**: the Tags field shows the category the tags pick as you type.

## API

- `GET /v1/workflows/summary`: each workflow has `category` and `latest.tags`.
- `GET /v1/workflows/categories`: the table above, as `[{name, tags}]`.
- `GET /v1/examples`: each example has `tags` and `category`.

To add a category or a tag, edit `WORKFLOW_CATEGORIES` and the list in `src/builder/skill.md`;
`test/workflow-category.test.ts` fails when the two disagree or a tag belongs to two categories.
