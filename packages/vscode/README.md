# Solarch for VS Code

Like Git Graph, but for your architecture: a side-bar **revision timeline** of
your Solarch project, an **"Update available"** alert when the diagram changes
in the cloud, and every spot where the code has drifted from the design — all
in a native VS Code list, no extra pages or panels. The Solarch CLI engine is
embedded in the extension: **login, link, pull and push run from buttons**,
no terminal required.

## The side bar (Activity Bar → Solarch)

```
● In sync — rev 12                    my-api
▾ Revisions
  ● rev 12   just now · 17n 18e  ← current
  ● rev 11   2h ago · 16n 17e (+1n +1e)
  ● rev 10   1d ago · 16n 16e
▾ Drift                               3 finding(s)
  ● Table "products" exists in the architecture but not in the code.
  ● Service "MailService" exists in the code but not in the architecture.
  ● Controller -[QUERIES]-> Table … (ERR_002)
```

- **Status row:** green = in sync, yellow/red = drift, blue ⬆ = **the
  architecture changed in the cloud** (someone edited the canvas — the
  revision is ahead of the last one you acknowledged). Click to acknowledge.
- **Revisions:** every revision the extension has observed, with first-seen
  time, node/edge counts and deltas — persisted per workspace (last 30).
- **Drift:** findings sorted by severity; red = missing in code / rule
  violation, yellow = unapproved addition, blue = property drift. Click a
  finding to jump to the evidence file.
- **Implementation** (appears in repos with generated scaffolds): how much of
  the generated code is actually filled in — `12/40 implemented (30%)` — plus
  the list of `NOT_IMPLEMENTED` members with their business description.
  Click one to jump straight to the marked line. The same counter is shown in
  the status bar.

## Buttons — the CLI runs in the background, no terminal

- **Welcome screen:** if you're not signed in, a "Sign in with API Key" button
  appears (masked input + server picker: Solarch Cloud / self-hosted). If the
  workspace isn't linked, a "Link a Project" button lists the projects on your
  account and writes `solarch.json` for you.
- **View title bar:** Push (⇡), Pull (⇣) and Refresh (↻) icons.
  - **Push:** the exact CLI push flow with a native UI — a plan is built, a
    modal shows the summary (new nodes/edges/property updates), then it is
    applied atomically. Rule violations block the push and are listed with fix
    suggestions; on a revision conflict the plan is rebuilt and retried once;
    nodes changed in the cloud meanwhile are skipped and reported.
  - **Pull:** downloads the To-Be graph to `.solarch/to-be.json` and reports
    a summary toast.
- Identity and the project link are the same files the CLI uses
  (`~/.solarch/credentials`, `solarch.json`) — fully interchangeable with
  `solarch login` / `solarch link` in a terminal.

## Other surfaces

- **Problems tab:** every finding as a diagnostic attached to its file.
- **Status bar:** `✓ Solarch: in sync` / `Solarch: 2E 5W` — click to open the side bar.
- **Refresh on save:** saving a `.ts` file rescans with a 500ms debounce.
- **Cloud polling:** the revision is checked every 60s — the source of the
  update alert.
- **Command palette:** `Solarch: Sign in` · `Link Project` · `Push` · `Pull` ·
  `Refresh` · `Check Drift`.

## Install

No prerequisites — signing in and linking are done from inside the extension
(running `solarch login` + `solarch link` in a terminal works just as well).
Click the Solarch logo in the Activity Bar and the welcome screen guides you.

Packaging / installing:

```bash
pnpm --filter solarch-vscode package      # → solarch-vscode-<version>.vsix
code --install-extension solarch-vscode-<version>.vsix
```

Development: open the repo in VS Code → `pnpm --filter solarch-vscode build`
→ F5 (Extension Development Host).

## Architecture

```
src/
├── extension.ts     # activate: TreeView, commands, save listener + 60s poll,
│                    # Problems, status bar, viewsWelcome context
├── actions.ts       # login / link / pull / push — CLI engine in-process, native UI
├── state.ts         # StateEngine: scan + cloud fetch (60s cache) + diff → GraphState
├── revision-log.ts  # timeline + "update available" decision (workspaceState, pure)
├── tree.ts          # TreeDataProvider — status / Revisions / Drift sections
└── shared.ts        # GraphState types + family colors
```

The engine comes from `@solarch/cli/lib` (`runScan`, `diffGraphs`,
`SolarchApi`, `evaluateEdge`) — the same pattern as the MCP server: the drift
this extension shows is byte-for-byte the drift CI blocks on.

Tests (`pnpm test`): `buildGraphState` status painting (against the real diff
engine output) and `RevisionLog` update decision/persistence (with a fake
Memento).

Build: a single esbuild CJS bundle — everything including ts-morph is inlined,
only the `vscode` module stays external.
