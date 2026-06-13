# @solarch/ast-core

ts-morph based NestJS **AST read/write engine** — the core of `@solarch/cli` and
(in Phase 3) `@solarch/mcp`. Pure functions only; it knows nothing about terminals,
file formats, or HTTP — so every consumer shares the same engine.

## What it does

Two directions:

1. **Read (scan):** Reads the codebase through the TypeScript compiler lens and
   produces an **As-Is graph** mapped to the Solarch graph taxonomy.
2. **Write (binding):** Extracts properties from a source class (e.g. TypeORM
   Entity) and safely injects them into a target class (e.g. DTO).

No regex: class roles come from decorators; relationships from constructor
injection / return types / `@Module` metadata — “what the compiler sees”.

## Taxonomy: mirror of the cloud

`src/types.ts` is a direct copy of backend schemas — **no new format is invented**,
everything is translated into the cloud’s language:

- **21 node kinds** (`NODE_KINDS`): Table, DTO, Model, Enum, View, Service,
  Worker, EventHandler, Controller, MessageQueue, Repository, Cache,
  ExternalService, FrontendApp, UIComponent, Middleware, EnvironmentVariable,
  Exception, Module, APIGateway, Orchestrator
- **16 edge kinds** (`EDGE_KINDS`): CALLS, REQUESTS, PUBLISHES, SUBSCRIBES,
  USES, HAS, EXTENDS, IMPLEMENTS, RETURNS, QUERIES, WRITES, CACHES_IN,
  DEPENDS_ON, READS_CONFIG, THROWS, ROUTES_TO

Matching identity: there is no UUID in code, so `nodeKey(kind, name)` is the
canonical key (`"UsersService"`, `"users-service"`, `"users_service"` collapse
to the same key).

## Classification rules (summary)

| Code | Node kind |
|---|---|
| `@Controller()` | Controller (+ `@Get/@Post/…` → Endpoints list) |
| `@Entity()` | Table (+ `@Column` → Columns list) |
| `@Injectable()` + name/`Repository` inheritance | Repository |
| `@Injectable()` (other) | Service (+ public methods → Methods) |
| `class *Dto` + class-validator | DTO (+ Fields) |
| `@Module()` | Module (imports → DEPENDS_ON, exports → USES) |
| `enum` declaration | Enum (+ Values) |
| class with `@Cron` methods | Worker (Schedule + TaskToExecute) |
| `@OnEvent/@EventPattern` | EventHandler |
| `HttpException` subclass / `*Exception` | Exception (HttpStatusCode inferred from parent) |
| Guard / `*Middleware` | Middleware |

Required schema fields that cannot be inferred from code (e.g.
Worker.TimeoutSeconds) get **schema-valid sensible defaults** so `solarch push`
can add the node to the cloud — the user fixes details on the canvas.
Unclassified/ambiguous cases are not swallowed silently; they land in
`graph.warnings`.

## API

```ts
import {
  scanProject,            // (ScanOptions) → AsIsGraph
  classifyClass,          // (ClassDeclaration) → NodeKind | null
  readSourceProperties,   // (ClassDeclaration) → SourceProperty[]
  syncProperties,         // (source, target, fields) → { added, skipped, conflicts }
  runBinding,             // (rootDir, "file#Class", "file#Class", fields) → writes file
  nameOfNode, nodeKey, edgeKey, canonicalName,
  NODE_KINDS, EDGE_KINDS, NAME_FIELD_BY_KIND,
} from "@solarch/ast-core";
```

### `scanProject(options)`

```ts
const graph = scanProject({
  rootDir: "/path/to/nestjs-app",
  include: ["src/**/*.ts"],          // default
  exclude: ["src/**/*.spec.ts"],
});
// → { nodes: AsIsNode[], edges: AsIsEdge[], warnings: string[], fileCount, … }
```

Every `AsIsEdge` carries **evidence** (`reason`: e.g. "constructor injection:
usersService: UsersService") — drift reports surface this evidence.

### `runBinding(rootDir, source, target, fields)`

File-level wrapper for live binding. Safety contract:

- **Property declarations only** — never touches methods or business logic.
- Every added field carries `// @solarch:bound from=User`; later syncs distinguish
  “ours” from “user-written”.
- If the target already has a property with the same name: skip when types match;
  **do not overwrite on mismatch** — reported via `conflicts[]`.
- TypeORM relation fields (`@ManyToOne`, etc.) are not copied to DTOs.
- Column type → TS type + class-validator decorator mapping is automatic
  (`string→IsString`, `number→IsNumber`, `Date→IsDate`, …).

## Tests

```bash
pnpm test
```

- `fixtures/basic-app/` — realistic mini NestJS app (entity, dto, service,
  controller, module, guard, worker, exception, enum…).
- `test/scan.test.ts` — graph from fixture **snapshot**-locked; extractor changes
  require an intentional snapshot update.
- `test/write.test.ts` — `syncProperties` unit tests + round-trip
  (inject → rescan → graph must match).
- `test/surgical.test.ts` — `@solarch:surgical` / `@solarch:filled` reading,
  skeleton vs filled classification, AST-based contract checks (deps/throws).

### Surgical module (`src/surgical.ts`)

Reads marker regions left by codegen:

```ts
import { readSurgicalMembers, summarizeSurgical } from "@solarch/ast-core";

const members = readSurgicalMembers(classDecl);
// → [{ member, nodeId, status: "skeleton"|"filled", filledBy?, deps?, throws?, violations? }]
const summary = summarizeSurgical(members);
// → { total, filled, filledAi, skeletons, violations }
```

- **skeleton:** body still throws `NOT_IMPLEMENTED`
- **filled:** converted to real code; `@solarch:filled by=ai|human` records the source
- **violations:** filled body uses dependencies or exceptions outside the declaration
