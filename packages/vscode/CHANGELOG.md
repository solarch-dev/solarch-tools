# Changelog

All notable changes to the Solarch VS Code extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.8.3] — 2026-06-16

### Fixed
Drift-to-zero pass 2 — two more representation mismatches resolved:
- **Nested DTOs** — a controller that uses an outer DTO (`OrderCreateRequest`) now
  satisfies the architecture's edge to a DTO nested inside it (`OrderItemRequest`)
  through the `HAS` chain, instead of reporting the nested DTO as unused.
- **Environment variables** — the scanner now extracts `process.env.X` references as
  EnvironmentVariable nodes, so the architecture's env vars match the code. Extra
  operational vars the diagram doesn't model (`NODE_ENV`, `LOG_LEVEL`, …) are treated as
  below the architecture's threshold rather than as drift, and a central config read
  satisfies any service's `READS_CONFIG` commitment for that var.

## [0.8.2] — 2026-06-16

### Fixed
Drift-to-zero pass — the deterministically-generated skeleton is now recognised
as conformant, so freshly generated code no longer drifts from its own architecture:
- **Exception contracts** — a service stub that declares `// throws: NotFoundException`
  in its surgical marker now satisfies the architecture's `THROWS` edge, even while the
  body is still an unimplemented placeholder. The stub keeps its `NOT_IMPLEMENTED`
  marker, so implementation-progress tracking is untouched.
- **Scaffolding** — generated NestJS `@Module` wiring and scaffold-marked guards are no
  longer reported as "in code but not in architecture"; they are codegen glue the
  architecture deliberately never models. The middleware routing they declare still
  matches.
- **Enum fields** — a DTO/Table field carrying an `EnumRef` in the architecture now
  satisfies the code's `USES → Enum` edge, instead of warning that the edge is absent
  from the diagram.

## [0.8.1] — 2026-06-16

### Fixed
Drift accuracy pass — several false positives no longer fire when the code
actually matches the architecture:
- **Table name** — drift no longer reports every Table as "missing in code" when
  the Entity class name differs from the table name (e.g. `class Reservation` /
  `@Entity("reservations")`). As-Is nodes now match the architecture by canonical
  name, not the class-name key.
- **Endpoint paths** — `/{id}` (OpenAPI) and `/:id` (NestJS) are now treated as
  the same route, so controller endpoints no longer drift on param syntax alone.
- **Controller → DTO verb** — an architecture `USES` edge to a response DTO is
  satisfied by the code's `RETURNS` edge (returning a DTO is a way of using it),
  instead of double-reporting the same relationship in both directions.
- **Middleware routing** — `configure(consumer).apply(Mw).forRoutes(Controller)`
  is now scanned, so `Middleware ROUTES_TO Controller` edges are no longer flagged
  as unimplemented. A global `forRoutes("*")` is matched as a wildcard that covers
  every controller without per-controller noise.

## [0.8.0] — 2026-06-15

### Added
- **Folder selection** — `Solarch: Select Folder to Track` picks which project
  folder Solarch tracks, including a subfolder of a monorepo (or Browse to any
  folder). The choice is remembered per workspace.
- **Switch Project** — a toolbar button (`⇄`) re-points the tracked folder at a
  different Solarch project without hand-editing `solarch.json`.
- **Generate prompt** — when a linked folder has no generated code yet, the view
  shows a prominent "Generate code from the architecture" action at the top.
- Onboarding now guides the order: Sign in → Choose a folder → Link a project
  (new `noFolder` welcome state).

## [0.7.0] — 2026-06-15

### Added
- **Live binding** — `Solarch: Bind Entity to DTO` and automatic field sync on
  save, mirroring `solarch watch`. Editing a bound Entity now updates its DTO in
  the editor.
- **Check Drift** is now a one-click toolbar button (rescan + reveal Problems),
  no longer Command Palette only.
- **Offline drift** — when the cloud is unreachable, the view falls back to the
  last pulled `.solarch/to-be.json` instead of going blank.
- A clickable **Retry** row when the API or scan fails.
- `.vscode/launch.json` for the F5 Extension Development Host loop.

### Fixed
- The packaged VSIX now actually contains the LICENSE file (the manifest
  previously pointed at a path outside the package root).
- The save-debounce timer is disposed on deactivate (no stray refresh after
  teardown).
- Clicking a finding whose file is missing now surfaces a warning instead of
  silently doing nothing.
- Cloud calls (refresh, pull, push plan, sign-in) now time out after 15s, so a
  hung request can no longer freeze the view or a progress notification.

### Changed
- The bundle is now minified — the packaged extension is roughly half the size.
- Added Marketplace metadata (repository, keywords, gallery banner) and
  `onStartupFinished` activation so the status-bar entry point appears proactively.

## [0.6.0]

- Architecture sidebar with revision timeline, drift findings in the Problems
  tab, push/pull/generate from the editor, and an implementation-progress
  section — the Solarch CLI engine embedded in VS Code.
