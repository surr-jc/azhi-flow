# Portable assets

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
