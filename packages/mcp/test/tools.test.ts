import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ApplyPayload, ApplyResult, CloudGraph, RuleCatalog } from "@solarch/cli/lib";
import type { ApiClient, ToolContext } from "../src/context.js";
import { createNodeSafely, getArchitecture, syncPropertiesTool } from "../src/tools.js";

/* ── ortak test verisi ───────────────────────────────────────────── */

const RULES: RuleCatalog = {
  whitelist: [
    { source: "Service", edge: "QUERIES", target: "Table", layer: "data" },
    { source: "Controller", edge: "CALLS", target: "Service", layer: "app" },
  ],
  blacklist: [
    {
      code: "ERR_002",
      source: "Controller",
      edge: "QUERIES",
      target: "Table",
      message: "Controllers must not query tables directly.",
      suggestion: "Route the call through a Service.",
    },
  ],
};

const GRAPH: CloudGraph = {
  project: { id: "p1", name: "demo" },
  nodes: [
    { id: "n-table", type: "Table", projectId: "p1", version: 1, properties: { TableName: "users" } },
    { id: "n-svc", type: "Service", projectId: "p1", version: 1, properties: { ServiceName: "UsersService" } },
  ],
  edges: [{ id: "e1", kind: "QUERIES", sourceNodeId: "n-svc", targetNodeId: "n-table", properties: {} }],
  counts: { nodes: 2, edges: 1 },
  graphRevision: 7,
};

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getGraph: vi.fn(async () => GRAPH),
    getRules: vi.fn(async () => RULES),
    applyGraph: vi.fn(async (): Promise<ApplyResult> => ({
      success: true,
      idMap: { t_new: "n-created" },
      nodeCount: 1,
      edgeCount: 1,
      graphRevision: 8,
    })),
    ...overrides,
  };
}

const ctxWith = (api: ApiClient, rootDir = "/tmp/unused"): ToolContext => ({ rootDir, projectId: "p1", api });

/* ── get_architecture ────────────────────────────────────────────── */

describe("getArchitecture", () => {
  it("edge uçlarını isimle anlatır, id'leri korur, revizyonu taşır", async () => {
    const view = await getArchitecture(ctxWith(makeApi()));
    expect(view.graphRevision).toBe(7);
    expect(view.nodes.map((n) => n.name)).toEqual(["users", "UsersService"]);
    expect(view.edges[0]).toMatchObject({
      kind: "QUERIES",
      source: 'Service "UsersService"',
      target: 'Table "users"',
      sourceId: "n-svc",
      targetId: "n-table",
    });
  });
});

/* ── create_node_safely ──────────────────────────────────────────── */

describe("createNodeSafely", () => {
  it("legal edge'li node'u baseRevision ile uygular ve yeni id döner", async () => {
    const api = makeApi();
    const result = await createNodeSafely(ctxWith(api), {
      type: "Controller",
      properties: { ControllerName: "UsersController" },
      edges: [{ kind: "CALLS", direction: "outgoing", nodeId: "n-svc" }],
    });

    expect(result).toMatchObject({ created: true, nodeId: "n-created", graphRevision: 8 });
    const payload = (api.applyGraph as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as ApplyPayload;
    expect(payload.baseRevision).toBe(7);
    expect(payload.mutations.edges[0]).toEqual({ sourceTempId: "t_new", targetId: "n-svc", edgeType: "CALLS" });
  });

  it("incoming yön: mevcut node kaynak, yeni node hedef olur", async () => {
    const api = makeApi();
    await createNodeSafely(ctxWith(api), {
      type: "Table",
      properties: { TableName: "orders" },
      edges: [{ kind: "QUERIES", direction: "incoming", nodeId: "n-svc" }],
    });
    const payload = (api.applyGraph as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as ApplyPayload;
    expect(payload.mutations.edges[0]).toEqual({ sourceId: "n-svc", targetTempId: "t_new", edgeType: "QUERIES" });
  });

  it("blacklist ihlalinde hiçbir şey yazmadan ihlali döner (ön-kontrol)", async () => {
    const api = makeApi();
    const result = await createNodeSafely(ctxWith(api), {
      type: "Controller",
      properties: { ControllerName: "BadController" },
      edges: [{ kind: "QUERIES", direction: "outgoing", nodeId: "n-table" }],
    });

    expect(result.created).toBe(false);
    if (!result.created) {
      expect(result.violations[0]?.message).toContain("ERR_002");
      expect(result.violations[0]?.suggestion).toContain("Service");
    }
    expect(api.applyGraph).not.toHaveBeenCalled();
  });

  it("var olmayan node id'sinde anlaşılır hata döner", async () => {
    const result = await createNodeSafely(ctxWith(makeApi()), {
      type: "Service",
      properties: { ServiceName: "X" },
      edges: [{ kind: "CALLS", direction: "outgoing", nodeId: "ghost" }],
    });
    expect(result.created).toBe(false);
    if (!result.created) expect(result.violations[0]?.code).toBe("ERR_EDGE_NODE_NOT_FOUND");
  });

  it("sunucu rollback'inde violations payload'ını aynen taşır", async () => {
    const api = makeApi({
      applyGraph: vi.fn(async (): Promise<ApplyResult> => ({
        success: false,
        transactionStatus: "ROLLED_BACK",
        message: "Rules engine rejected the batch.",
        violations: [{ tempId: "t_new", code: "ERR_SCHEMA_INVALID", message: "ServiceName is required." }],
      })),
    });
    const result = await createNodeSafely(ctxWith(api), { type: "Service", properties: {} });
    expect(result.created).toBe(false);
    if (!result.created) expect(result.violations[0]?.code).toBe("ERR_SCHEMA_INVALID");
  });
});

/* ── sync_properties (gerçek dosyalarla, temp dizinde) ───────────── */

describe("syncPropertiesTool", () => {
  const dir = mkdtempSync(join(tmpdir(), "solarch-mcp-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("entity kolonlarını DTO'ya marker'lı enjekte eder", () => {
    writeFileSync(
      join(dir, "user.entity.ts"),
      `export function Entity(): ClassDecorator { return () => {}; }
export function Column(): PropertyDecorator { return () => {}; }
@Entity()
export class User {
  @Column() email!: string;
  @Column() age!: number;
}
`,
    );
    writeFileSync(join(dir, "user.dto.ts"), `export class UserDto {\n}\n`);

    const result = syncPropertiesTool(ctxWith(makeApi(), dir), {
      source: "user.entity.ts#User",
      target: "user.dto.ts#UserDto",
    });

    expect(result.added).toEqual(["email", "age"]);
    expect(result.conflicts).toEqual([]);
    const written = readFileSync(join(dir, "user.dto.ts"), "utf8");
    expect(written).toContain("@solarch:bound from=User");
    expect(written).toContain("email");
  });

  it("ikinci çağrı up-to-date döner (idempotans)", () => {
    const result = syncPropertiesTool(ctxWith(makeApi(), dir), {
      source: "user.entity.ts#User",
      target: "user.dto.ts#UserDto",
    });
    expect(result.upToDate).toBe(true);
    expect(result.added).toEqual([]);
  });
});
