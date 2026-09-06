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
- **Check the machine before sizing a workflow.** The Workflow tool caps
  concurrency at `min(16, nproc - 2)` PER RUN; on this 4-CPU box that is 2
  agents at a time, so one 15-agent workflow would have taken ~2 hours. Run
  `nproc` first and split independent work into several parallel runs of the
  same script, selected by `args`.
- **`scriptPath` must be readable from the current context.** The path the
  tool returns lives under a project-slug directory tied to the cwd at launch;
  after a `cd` it is rejected. Copy the script into the session scratchpad and
  launch from there.
- **Stop a workflow only when the tree is clean.** Agents write mid-flight;
  before killing a run, check `git status` and be ready to revert their
  partial files (they never commit).

## Prefix guards need a boundary test before they ship (PR #734 review, 2026-09-06)

- Symptom: `pathAllowed` kept a broad `pathname.startsWith(prefix)` next to the
  strict `=== prefix || startsWith(prefix + '/')` clauses, so `/auth/callback-evil`
  passed a pin meant for `/auth/callback`. Existing tests only probed paths that
  did not share the string prefix, so CI stayed green.
- Rule: when writing any allow-list or prefix match, write the sibling case
  (`<pinned>-evil`, `<pinned>XYZ`) as a rejection test FIRST, then the sub-path
  acceptance, then the guard. A guard that is a strict superset of another
  clause in the same expression is a smell: delete the broad one.
- Rule: after an adversarial review, re-read every predicate that gates a
  security decision with the question "what string still satisfies this that
  the doc comment says it should not?"
