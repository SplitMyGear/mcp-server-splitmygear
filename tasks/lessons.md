# Lessons (self-maintained)

- **`pkill -f <pattern>` can match the shell running it.** The pattern
  `next start -p 3100` appeared in my own command line, so pkill killed the
  invoking shell (exit 144) and the rest of the command never ran. Find the pid
  with `pgrep -fl` first (excluding the pgrep itself) and `kill <pid>`.
- **The MCP SDK's deprecated `server.tool(name, shape, annotations, cb)`
  overload silently drops the description.** The 18 original tools shipped to
  models with no description at all. Always use `registerTool(name, { title,
  description, inputSchema, annotations }, cb)` and assert in a test that every
  tool has a description.
- **No em-dashes in model/user-facing strings in this repo (SPLIT-1331).**
  Tool descriptions, schema `.describe()` text, server instructions and the
  hosted pages use ":" / ";" / "," instead. A registry test now enforces it for
  tool descriptions.
- **Generated docs beat hand-written docs.** `docs/mcp-tools.md` and the DXT
  manifest tool list had drifted from the code (old `userId` arguments). They
  are now rendered from the tool registry and diffed in CI.
