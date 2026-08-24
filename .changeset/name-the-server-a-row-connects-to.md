---
'@dshline/dshline': minor
---

`/plugins` names the external server a composition row connects to.

A row that connects to an external server takes its identity from which server that is. Two rows loading the same module — the shape `@deepseek-ai/dsh-mcp-client` takes, one plugin instance per MCP server — were previously indistinguishable in the browser: such a config carries more than three keys and nested values (a command, an argument list, an environment), so the generic config summary deliberately showed nothing for either.

`config.serverName` and `config.transport` are now read structurally and shown beside the row, following exactly the pattern `config.provider` already uses: named after the fields, read for any row that declares them, and never evaluated when the value is a `!!js` expression.

This reports what the composition file says and nothing more — not that the server exists, is reachable, or is connected. There is no seam that would answer those questions: `dsh-mcp-client` registers its tools on `ctx.tools` and publishes no registry, so a real MCP browser is upstream work. Inferring one from the `mcp__<server>__` prefix on tool names would be inferring capability state from rendered identifiers, which is an explicit non-goal.
