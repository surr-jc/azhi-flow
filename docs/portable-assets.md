# Portable assets (the Library)

Azhi Flow's **Portable assets** library stores reusable MCP servers, agents, skills, and commands as versioned definitions. Publish a version before attaching it to a workflow; the workflow records the exact published version, so later edits do not silently change a workflow.

## OpenCode MCP setup

Choose **OpenCode guide** on an MCP asset to get its installation steps. The generated `opencode.jsonc` contribution follows OpenCode's current `mcp` schema:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "docs": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer {env:DOCS_API_KEY}" }
    }
  }
}
```

For a local server, use `type: "local"` and a command array such as `["npx", "-y", "my-mcp-server"]`. Add this configuration in the project-root `opencode.jsonc` or globally in `~/.config/opencode/opencode.json`. Never put a secret in the asset definition; use OpenCode environment placeholders such as `{env:DOCS_API_KEY}`.

For OAuth MCP servers, run `opencode mcp auth <server-name>` after configuration. Verify all connections with `opencode mcp list`; diagnose a connection with `opencode mcp debug <server-name>`.

The workflow page can download its attached definitions as an OpenCode bundle. The bundle contains `opencode.jsonc`, agent files in `.opencode/agents/`, skill files in `.opencode/skills/<name>/SKILL.md`, and command files in `.opencode/commands/`.

## Finding things: live marketplaces

The **Library** page (`/ui/assets`) has a **Discover** tab for each kind. The Azhi server searches live, so the web app needs no third-party access:

| Kind | Source |
|---|---|
| MCP servers | The official MCP Registry (`registry.modelcontextprotocol.io`). Hosted servers become `remote` definitions, npm, PyPI and Docker packages become `local` ones. |
| Agents, commands, skills | GitHub **plugin marketplaces**: any repository with `.claude-plugin/marketplace.json` (the layout Claude Code plugins use). Built in: `anthropics/skills`, `anthropics/claude-plugins-official`, `wshobson/agents`. An admin can add any other repository, or turn the whole feature off (air-gapped installs) under **Manage marketplaces**. |

Preview shows exactly what an import would store, what environment variables it needs, and what was **not** carried over (for example a skill's bundled scripts, or an agent's tool list). **Import as draft** re-fetches the item on the server (the browser never supplies the definition), records its source URL and a SHA-256 of the fetched file in the definition's `provenance`, and creates a draft. An author reviews it and publishes it like any other asset; attaching needs a published version.

Things to know:

- A `local` MCP server is a program that runs on a worker (`npx`, `uvx`, `docker`). The preview and the library mark it "runs on a worker". Only import ones whose source you trust.
- Secrets are never stored. A definition names environment variables (`{env:NAME}`), listed under `needs`.
- GitHub lists a plugin's contents through its API (60 requests an hour without a token). Without access, skills that a marketplace lists explicitly still appear, but agents and commands found by walking a plugin's folders do not. Set `AZHI_GITHUB_TOKEN` on the server to lift the limit. Results are cached for ten minutes.
- Requests only go to `registry.modelcontextprotocol.io`, `raw.githubusercontent.com` and `api.github.com`.

## One Add MCP server wizard

**Library > MCP servers > Add an MCP server** asks how the server runs (hosted URL, or a package on a worker), builds the definition, and shows the setup for each harness as you type. It saves a draft library asset. For a hosted server it can also connect it to Azhi's gateway, so tool steps and model agents can call it with every write in the action ledger. The Tools and Connections pages remain for that gateway side.

## Harnesses

Each asset can be exported for **OpenCode** (`opencode.jsonc`, `.opencode/...`) and **Claude Code** (`.mcp.json`, `.claude/agents`, `.claude/skills`, `.claude/commands`):

- `GET /v1/assets/:id/harness-guides`: files and setup steps per harness for one asset.
- `GET /v1/workflows/:slug/opencode-export` and `.../claude-export`: the files for everything attached to a workflow.
- `POST /v1/assets/preview-guides`: the same for a definition that is not saved yet.

Marketplace API: `GET /v1/marketplace/search?kind=&q=&source=&cursor=`, `GET /v1/marketplace/item?id=`, `POST /v1/marketplace/import`, and `GET`/`PUT /v1/marketplace/config` (admin).
