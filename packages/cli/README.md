# @solarch/cli

The `solarch` command-line tool — the bridge between your codebase (As-Is) and
the architecture you draw in Solarch (To-Be). Drift guard, bidirectional sync,
and live binding in one binary.

```
Code ──scan──▶ As-Is graph ──diff──▶ drift report (blocks merge in CI)
                  │
                  └──push──▶ Solarch Cloud (missing nodes/edges + properties)
Cloud ──pull──▶ .solarch/to-be.json (offline reference)
Entity changed ──watch──▶ auto property sync to DTO (bind)
```

## Install & first run

```bash
npm install -g @solarch/cli

cd your-nestjs-repo
solarch connect

# Local backend (dev)
solarch connect --api-url http://localhost:4000/api/v1
```

**From source** (no npm registry):

```bash
cd solarch-tools && pnpm install:cli
```

`connect` prompts for an API key if you are not signed in, and picks a project if
`solarch.json` is missing. You can also run `solarch login` and `solarch link`
separately (CI / automation).

## Commands

### `solarch connect`

**Start here** — sign in + link the project in one flow. If already connected,
prints a status summary.

| Option | Description |
|---|---|
| `--api-url <url>` | API server (dev: `http://localhost:4000/api/v1`) |
| `--key <key>` | API key (CI / non-interactive) |
| `--project <id>` | Project UUID (skips the picker) |

### `solarch login`

Saves the API key to `~/.solarch/credentials` (mode 600).

| Option | Description |
|---|---|
| `--key <key>` | Pass the key on the command line (CI; no prompt) |
| `--api-url <url>` | Override default `https://app.solarch.dev/api/v1` |

### `solarch link`

Links the current repo to a Solarch project in your account → writes
`solarch.json`. Use `--project <id>` to skip the selection screen.

### `solarch scan`

Scans the codebase at compiler level (ts-morph), extracts the As-Is graph, and
prints a summary. `--json` dumps the full graph for machines.

### `solarch status`

Implementation dashboard: reads `@solarch:surgical` markers left by the codegen
engine and answers “how much of the generated scaffold is actually filled in?” —
per-node fill rate + pending member list (with job descriptions).

```
Implementation status — 12/40 member(s) implemented (30%)

  ● AccountsService (Service) 1/5 src/accounts/accounts.service.ts
      ✗ createAccount :12 — Opens a new account; balance starts at zero.
```

| Option | Description |
|---|---|
| `--ci` | **Exit 1** if skeletons, contract violations, or marker loss remain |
| `--report` | Push fill counters to the cloud (feeds canvas badges) |
| `--json` | Machine-readable report |

Extra checks (Surgical Assurance):

- **Contract violation:** Filled body uses `deps:` / `throws:` outside what the
  marker declares → reported in red (AST-based, `@solarch/ast-core/surgical`).
- **Marker loss:** A file listed in `.solarch/generated.json` no longer contains
  any `@solarch:surgical` → warning (someone deleted the comments; tracking is blind).

### `solarch diff`

Drift check: As-Is ↔ To-Be comparison.

| Finding | Severity | Meaning |
|---|---|---|
| `DRIFT_NODE_MISSING_IN_CODE` | error | In architecture, missing in code — commitment not met |
| `DRIFT_EDGE_MISSING_IN_CODE` | error | Diagram connection not wired in code |
| `DRIFT_ILLEGAL_EDGE` | error | Code connection violates the Rules Matrix (blacklist / not whitelisted) |
| `DRIFT_NODE_NOT_IN_CLOUD` | warn | In code, not in architecture — unapproved expansion |
| `DRIFT_EDGE_NOT_IN_CLOUD` | warn | Code connection not in the diagram |
| `DRIFT_PROPERTY` | info | Column/field/method list mismatch |

| Option | Description |
|---|---|
| `--ci` | GitHub annotation format; **exit 1 on errors** → merge blocked |
| `--json` | Machine-readable report |
| `--to-be <file>` | Offline: read To-Be graph from file (e.g. `.solarch/to-be.json`) |

### `solarch pull`

Downloads the To-Be graph **with revision number** to `.solarch/to-be.json`.
Fresh local copy for offline `diff --to-be` + reference before push.

### `solarch push`

Writes code-side delta to the cloud. Flow:

1. Fetch fresh graph (revision **R**) and build a plan: nodes to add, edges to add,
   list-properties to update.
2. Show plan, ask for confirmation (`--yes` skips for CI).
3. **Adds** go in one atomic `graph/apply` call (`baseRevision: R`). Edge endpoints:
   `tempId` on new nodes, cloud id on existing nodes.
4. **Property updates:** for list fields (Columns/Fields/Methods/Endpoints/Values)
   **code is source of truth** — other cloud properties are preserved; only the
   list field is replaced with code’s version and `PATCH`ed.
5. On success, `.solarch/map.json` is updated via `idMap` — new nodes are matched
   immediately; a second push is a **no-op** (idempotent).

Safety rules:

- **Push is rejected entirely when illegal edges exist** (exit 1) — fix the
  violating connection or approve it on the canvas first.
- **No deletes:** removing nodes from the cloud is canvas-only (`--prune` is
  intentionally absent).

Conflict handling (two layers):

| Situation | What happens |
|---|---|
| Graph revision stale (`ERR_GRAPH_REVISION_CONFLICT`, 409) | Automatic: re-fetch graph, recompute plan, **retry once**. Second 409 is left to the user. |
| Node changed in the meantime (`ERR_VERSION_CONFLICT`, 409) | Interactive: **keep cloud / write code / skip**. No TTY (CI) → auto skip + report. |

### `solarch generate`

Produces **deterministic code scaffold** from the cloud graph and writes it into
the repo (Constructor — no AI, same graph → byte-identical output). Method bodies
arrive with `@solarch:surgical` markers; track progress with `solarch status`.

| Option | Behavior |
|---|---|
| (default) | Write **new** files only — hand-filled or AI-filled code is never overwritten |
| `--force` | Overwrite existing files too (reset to fresh scaffold) |

Requires Build+ plan (`402 ERR_PLAN_AI`). Flow: `generate` → `status` →
(surgical AI / human fills in) → `diff` to validate architecture.

### `solarch bind <source> <target>`

Defines a persistent live binding (writes to `solarch.json`) and runs it once
immediately:

```bash
solarch bind "src/users/user.entity.ts#User" "src/users/create-user.dto.ts#CreateUserDto"
solarch bind ... --fields email,name     # specific fields only (default: all)
```

Entity columns → DTO properties (TS type + class-validator decorators). Added
fields carry a `// @solarch:bound` marker; hand-written properties are untouched;
type conflicts are not overwritten — they are reported.

### `solarch watch`

Daemon: watches file changes with chokidar; when a source file changes, runs linked
bindings + prints an incremental drift summary. `--no-drift` is binding-only mode.
Stop with Ctrl-C.

## Files

| File | Purpose | Commit? |
|---|---|---|
| `~/.solarch/credentials` | API key (machine-wide, mode 600) | no (in home dir) |
| `solarch.json` | Project link: `projectId`, `include`/`exclude` globs, `bindings[]` | **yes** |
| `.solarch/map.json` | Code-node ↔ cloud-node match cache | optional (recommended: yes — stable matching after renames) |
| `.solarch/to-be.json` | `pull` output: To-Be graph + revision | no (regenerable) |

Example `solarch.json`:

```json
{
  "projectId": "66bea437-…",
  "projectName": "my-api",
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.spec.ts"],
  "bindings": [
    { "source": "src/users/user.entity.ts#User", "target": "src/users/user.dto.ts#UserDto", "fields": "all" }
  ]
}
```

## CI integration

Ready-made GitHub Actions example: [`examples/github-action.yml`](examples/github-action.yml).
Summary: `solarch login --key "$SOLARCH_API_KEY"` → `solarch diff --ci`. Errors
fail the job. You can add `solarch push --yes` after merge to main for auto-sync.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean (or warn/info findings only) |
| 1 | Error-level drift, push with illegal edges, unresolved revision conflict, missing config |

## Internal layout

```
src/
├── index.ts          # commander definitions (binary entry)
├── lib.ts            # @solarch/cli/lib — side-effect-free library entry (@solarch/mcp consumes this)
├── config.ts         # credentials / solarch.json / map.json read-write
├── api.ts            # Solarch Cloud client (Bearer slk_…, envelope unwrap, ApiError)
├── commands/         # login, link, scan, diff, pull, push, bind, watch
├── diff/
│   ├── engine.ts     # matching + drift findings + legality (rules from cloud)
│   └── report.ts     # TTY / JSON / GitHub annotation output
└── push/
    └── planner.ts    # diff → apply payload + property merge plan
```

Tests: `pnpm test` — diff engine, push planner, and 409 retry flow (API mock) locked
with vitest.
