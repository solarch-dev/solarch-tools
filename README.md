# solarch-tools

Solarch developer tools monorepo — **SOLARCH 2.0**: CLI drift guard, bidirectional
sync (pull/push), and live binding so code stays aligned with the architecture
you draw.

```
packages/
  ast-core/   @solarch/ast-core — ts-morph NestJS AST read/write engine
  cli/        @solarch/cli      — `solarch` binary (connect/scan/diff/pull/push/watch/bind)
  mcp/        @solarch/mcp      — `solarch-mcp` MCP server (context + safe mutations for AI agents)
  vscode/     solarch-vscode    — VS Code extension (revision timeline + drift, "architecture Git Graph")
```

Package docs: [`packages/ast-core/README.md`](packages/ast-core/README.md) ·
[`packages/cli/README.md`](packages/cli/README.md) ·
[`packages/mcp/README.md`](packages/mcp/README.md) ·
[`packages/vscode/README.md`](packages/vscode/README.md)

## What it does

You design the architecture in Solarch (To-Be). This CLI reads the codebase at
compiler level (As-Is) and keeps both sides in sync:

**Guard direction (diff):**

- **In code but not on the diagram** → warning ("unapproved expansion")
- **On the diagram but missing in code** → error ("commitment not met")
- **Rule violation** (e.g. Controller calling Repository directly) → error;
  Rules Matrix is fetched live from the cloud
- `solarch diff --ci` exits 1 on errors → merge is blocked in CI

**Sync direction (pull/push):**

- `solarch pull` downloads the To-Be graph with revision number to a local copy
- `solarch push` plans missing nodes/edges + property lists from code, asks for
  approval, and writes to the cloud in **one atomic request**. A second push is a
  no-op (idempotent); illegal connections are never pushed
- **Two-layer conflict protection:** stale graph revision → server returns 409
  without writing; CLI refreshes and retries once. Per-node conflicts → keep
  cloud / write code / skip

## Quick start

```bash
pnpm install && pnpm install:cli   # global `solarch` — no registry needed

# 1. Solarch app → Settings → API Keys → create a key
# 2. In your NestJS repo root:
solarch connect

# 3. Local graph / drift / implementation dashboard
solarch scan
solarch diff            # human-readable report
solarch diff --ci       # GitHub annotations + exit code
solarch diff --json     # machine-readable
solarch status          # how much of generated scaffolding is filled? (--ci fails if skeleton remains)
solarch status --report # push fill counters to cloud (canvas badges)

# 4. Bidirectional sync
solarch pull            # To-Be → .solarch/to-be.json (with revision)
solarch push            # code delta → cloud (plan + confirm; --yes for CI)

# 5. Live binding: Entity change → DTO auto-updates
solarch bind "src/users/user.entity.ts#User" "src/users/create-user.dto.ts#CreateUserDto"
solarch watch           # daemon: watches file changes

# 6. Wire an AI agent (MCP) — add to mcp.json:
#    { "command": "solarch-mcp", "args": ["--root", "/path/to/repo"] }
```

CI example: [`packages/cli/examples/github-action.yml`](packages/cli/examples/github-action.yml)

## Design contracts

- **Taxonomy mirrors the cloud:** 21 node kinds + 16 edge kinds match
  `solarch-backend` schemas exactly (`packages/ast-core/src/types.ts`). No new format.
- **AST, not regex:** class roles from decorators (@Controller, @Injectable,
  @Entity, @Module) and constructor injection — not file names.
- **Write safety:** live binding only adds property declarations, never touches
  methods. Added fields carry `@solarch:bound`; type conflicts are reported, not overwritten.
- **Stable matching:** code-node ↔ cloud-node via `(kind, canonical name)`;
  `.solarch/map.json` cache survives renames. Push `idMap` updates the cache.
- **No deletes via push:** push never removes nodes/edges from the cloud — delete
  only from the canvas.
- **One engine, two consumers:** MCP tools share CLI engines via `@solarch/cli/lib`
  — agent drift and CI drift never diverge.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | AST engine, scan/diff/watch/bind, API key infra | DONE |
| 2 | Graph revision + conflict resolution, `pull`/`push` | DONE |
| 3 | MCP server — 6 tools: context, drift, unimplemented queue, safe mutation | DONE |
| 3.5 | VS Code extension — revision timeline, drift list, Problems, status bar | DONE |
| 3.6 | Implementation layer — `@solarch:surgical`, `solarch status`, MCP queue | DONE |
| 3.7 | Surgical assurance — contract checks, manifest, `status --report`, canvas badges | DONE |

## Development

```bash
pnpm build   # all packages (topological order)
pnpm test    # vitest — fixture snapshots + diff engine + push planner + write round-trip
pnpm lint    # tsc --noEmit
```

`packages/ast-core/fixtures/basic-app` is a realistic mini NestJS app; scanner
graph output is locked with snapshot tests. Push flow is validated end-to-end
against local `solarch-backend` (first push adds, second push no-op).
