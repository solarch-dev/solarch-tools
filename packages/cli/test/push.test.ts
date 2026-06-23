import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AsIsGraph } from "@solarch/ast-core";
import { ApiError, SolarchApi, type ApplyPayload, type CloudGraph, type RuleCatalog } from "../src/api.js";
import { buildPushPlan, planIsEmpty, toApplyPayload } from "../src/push/planner.js";

// runScan gerçek dosya sistemi tarar — push testlerinde sentetik graf döndür.
const runScanMock = vi.fn<(rootDir: string) => AsIsGraph>();
vi.mock("../src/commands/scan.js", () => ({
  runScan: (rootDir: string) => runScanMock(rootDir),
  scanCommand: vi.fn(),
}));

/* ── sentetik graf kurucuları ────────────────────────────────────── */

function asIs(partial?: Partial<AsIsGraph>): AsIsGraph {
  return {
    scannedAt: "t",
    rootDir: "/repo",
    tsconfigPath: null,
    fileCount: 1,
    nodes: [
      {
        key: "Service:usersservice",
        kind: "Service",
        name: "UsersService",
        file: "src/users/users.service.ts",
        properties: { ServiceName: "UsersService", Methods: [{ MethodName: "create" }, { MethodName: "list" }] },
      },
      {
        key: "Repository:usersrepository",
        kind: "Repository",
        name: "UsersRepository",
        file: "src/users/users.repository.ts",
        properties: { RepositoryName: "UsersRepository" },
      },
    ],
    edges: [
      {
        key: "Service:usersservice -[CALLS]-> Repository:usersrepository",
        kind: "CALLS",
        sourceKey: "Service:usersservice",
        targetKey: "Repository:usersrepository",
        file: "src/users/users.service.ts",
        reason: "constructor injection",
      },
    ],
    warnings: [],
    ...partial,
  };
}

function toBe(partial?: Partial<CloudGraph>): CloudGraph {
  return {
    project: { id: "p1", name: "Demo" },
    nodes: [
      { id: "n1", type: "Service", projectId: "p1", version: 1, properties: { ServiceName: "UsersService", Methods: [{ MethodName: "create" }, { MethodName: "list" }] } },
      { id: "n2", type: "Repository", projectId: "p1", version: 1, properties: { RepositoryName: "UsersRepository" } },
    ],
    edges: [{ id: "e1", kind: "CALLS", sourceNodeId: "n1", targetNodeId: "n2", properties: {} }],
    counts: { nodes: 2, edges: 1 },
    graphRevision: 1,
    ...partial,
  };
}

const RULES: RuleCatalog = {
  whitelist: [
    { source: "Service", edge: "CALLS", target: ["Repository", "Service"], layer: "business" },
    { source: "Controller", edge: "CALLS", target: "Service", layer: "presentation" },
  ],
  blacklist: [
    {
      code: "ERR_001",
      source: "Controller",
      edge: "*",
      target: "Repository",
      message: "Controller cannot touch the Repository directly.",
      suggestion: "Go through a Service.",
    },
  ],
};

const FULL_MATCH = {
  "Service:usersservice": "n1",
  "Repository:usersrepository": "n2",
};

/* ── planner ─────────────────────────────────────────────────────── */

describe("buildPushPlan", () => {
  it("tam eşleşmede plan boş (idempotans)", () => {
    const plan = buildPushPlan(asIs(), toBe(), RULES, FULL_MATCH);
    expect(planIsEmpty(plan)).toBe(true);
    expect(plan.illegalEdges).toEqual([]);
  });

  it("yeni node + karışık uçlu edge: yeni uçta tempId, eşleşen uçta cloud id", () => {
    const code = asIs();
    code.nodes.push({
      key: "Controller:userscontroller",
      kind: "Controller",
      name: "UsersController",
      file: "src/users/users.controller.ts",
      properties: { ControllerName: "UsersController" },
    });
    code.edges.push({
      key: "Controller:userscontroller -[CALLS]-> Service:usersservice",
      kind: "CALLS",
      sourceKey: "Controller:userscontroller",
      targetKey: "Service:usersservice",
      file: "src/users/users.controller.ts",
      reason: "constructor injection",
    });

    const plan = buildPushPlan(code, toBe(), RULES, FULL_MATCH);
    expect(plan.newNodes.map((n) => n.key)).toEqual(["Controller:userscontroller"]);
    expect(plan.newEdges).toHaveLength(1);
    expect(plan.newEdges[0]!.source).toEqual({ tempId: "t_controller_userscontroller" });
    expect(plan.newEdges[0]!.target).toEqual({ id: "n1" });

    const payload = toApplyPayload(plan, 1);
    expect(payload.baseRevision).toBe(1);
    expect(payload.mutations.nodes).toEqual([
      { tempId: "t_controller_userscontroller", type: "Controller", properties: { ControllerName: "UsersController" } },
    ]);
    expect(payload.mutations.edges).toEqual([
      { sourceTempId: "t_controller_userscontroller", targetId: "n1", edgeType: "CALLS" },
    ]);
  });

  it("illegal edge plana girmez — ayrı listede raporlanır", () => {
    const code = asIs();
    code.nodes.push({
      key: "Controller:userscontroller",
      kind: "Controller",
      name: "UsersController",
      file: "src/users/users.controller.ts",
      properties: { ControllerName: "UsersController" },
    });
    // ERR_001: Controller → Repository.
    code.edges.push({
      key: "Controller:userscontroller -[CALLS]-> Repository:usersrepository",
      kind: "CALLS",
      sourceKey: "Controller:userscontroller",
      targetKey: "Repository:usersrepository",
      file: "src/users/users.controller.ts",
      reason: "constructor injection",
    });

    const plan = buildPushPlan(code, toBe(), RULES, FULL_MATCH);
    expect(plan.newEdges).toEqual([]);
    expect(plan.illegalEdges).toHaveLength(1);
    expect(plan.illegalEdges[0]!.message).toContain("ERR_001");
  });

  it("iki ucu da eşleşen ve cloud'da var olan edge pushlanmaz", () => {
    const plan = buildPushPlan(asIs(), toBe(), RULES, FULL_MATCH);
    expect(plan.newEdges).toEqual([]);
  });

  it("property merge: cloud properties korunur, yalnız liste alanı kodunkiyle değişir", () => {
    const code = asIs();
    // Kodda yeni method: "remove". Cloud'da olmayan Description cloud'dan korunmalı.
    (code.nodes[0]!.properties as Record<string, unknown>).Methods = [
      { MethodName: "create" },
      { MethodName: "list" },
      { MethodName: "remove" },
    ];
    const cloud = toBe();
    cloud.nodes[0]!.version = 7;
    cloud.nodes[0]!.properties = {
      ServiceName: "UsersService",
      Description: "cloud'da elle yazılmış açıklama",
      IsTransactionScoped: true,
      Methods: [{ MethodName: "create" }, { MethodName: "list" }],
    };

    const plan = buildPushPlan(code, cloud, RULES, FULL_MATCH);
    expect(plan.propertyUpdates).toHaveLength(1);
    const u = plan.propertyUpdates[0]!;
    expect(u.cloudId).toBe("n1");
    expect(u.expectedVersion).toBe(7);
    expect(u.changedFields).toEqual(["Methods"]);
    // Liste alanı kodunki; kalan cloud property'leri aynen duruyor.
    expect(u.properties.Methods).toEqual([
      { MethodName: "create" },
      { MethodName: "list" },
      { MethodName: "remove" },
    ]);
    expect(u.properties.Description).toBe("cloud'da elle yazılmış açıklama");
    expect(u.properties.IsTransactionScoped).toBe(true);
  });

  it("cache'te ölü cloud id varsa eşleşme düşer ve node yeniden eklenecekler listesine girer", () => {
    const plan = buildPushPlan(asIs(), toBe({ nodes: [toBe().nodes[0]!], edges: [], counts: { nodes: 1, edges: 0 } }), RULES, FULL_MATCH);
    // n2 cloud'dan silinmiş → Repository yeni node olarak planlanır.
    expect(plan.newNodes.map((n) => n.key)).toEqual(["Repository:usersrepository"]);
  });

  it("removals verilmezse plan hiçbir şey silmez (varsayılan additif-güvenli)", () => {
    const plan = buildPushPlan(asIs(), toBe(), RULES, FULL_MATCH);
    expect(plan.nodesToRemove).toEqual([]);
    expect(plan.edgesToRemove).toEqual([]);
  });

  it("removals iletilince plana iliştirilir; yalnız silme varsa plan boş değildir", () => {
    const cloudNode = toBe().nodes[1]!; // n2 Repository
    const cloudEdge = toBe().edges[0]!; // e1
    const plan = buildPushPlan(asIs(), toBe(), RULES, FULL_MATCH, { nodes: [cloudNode], edges: [cloudEdge] });
    expect(plan.nodesToRemove.map((n) => n.id)).toEqual(["n2"]);
    expect(plan.edgesToRemove.map((e) => e.id)).toEqual(["e1"]);
    expect(planIsEmpty(plan)).toBe(false);
  });
});

/* ── push retry akışı (API mock) ─────────────────────────────────── */

describe("pushCommand — revizyon çatışması retry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "solarch-push-"));
    writeFileSync(join(dir, "solarch.json"), JSON.stringify({ projectId: "p1", bindings: [] }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("409 ERR_GRAPH_REVISION_CONFLICT → re-pull + yeni baseRevision ile tek retry", async () => {
    // Kod: cloud'da olmayan bir Controller içerir → push planı dolu.
    const code = asIs();
    code.nodes.push({
      key: "Controller:userscontroller",
      kind: "Controller",
      name: "UsersController",
      file: "src/users/users.controller.ts",
      properties: { ControllerName: "UsersController" },
    });

    runScanMock.mockReturnValue(code);

    let revision = 1;
    const applyCalls: ApplyPayload[] = [];
    const fakeApi = {
      getGraph: vi.fn(async () => toBe({ graphRevision: revision })),
      getRules: vi.fn(async () => RULES),
      applyGraph: vi.fn(async (_pid: string, payload: ApplyPayload) => {
        applyCalls.push(payload);
        if (applyCalls.length === 1) {
          revision = 2; // bu arada başka istemci yazdı
          throw new ApiError("revision stale", "ERR_GRAPH_REVISION_CONFLICT", 409, { currentRevision: 2 });
        }
        return { success: true as const, idMap: { t_controller_userscontroller: "n9" }, nodeCount: 1, edgeCount: 0, graphRevision: 3 };
      }),
      patchNode: vi.fn(),
    };
    vi.spyOn(SolarchApi, "fromStoredCredentials").mockReturnValue(fakeApi as unknown as SolarchApi);

    const { pushCommand } = await import("../src/commands/push.js");
    await pushCommand({ rootDir: dir, yes: true });

    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[0]!.baseRevision).toBe(1);
    expect(applyCalls[1]!.baseRevision).toBe(2);
    expect(process.exitCode ?? 0).toBe(0);

    // idMap → map.json: yeni node eşleşmiş sayılır.
    const { readMatchCache } = await import("../src/config.js");
    expect(readMatchCache(dir)["Controller:userscontroller"]).toBe("n9");
  });

  it("ikinci 409'da pes eder ve exit 1 bırakır", async () => {
    const code = asIs();
    code.nodes.push({
      key: "Controller:userscontroller",
      kind: "Controller",
      name: "UsersController",
      file: "src/users/users.controller.ts",
      properties: { ControllerName: "UsersController" },
    });
    runScanMock.mockReturnValue(code);

    const fakeApi = {
      getGraph: vi.fn(async () => toBe()),
      getRules: vi.fn(async () => RULES),
      applyGraph: vi.fn(async () => {
        throw new ApiError("revision stale", "ERR_GRAPH_REVISION_CONFLICT", 409, { currentRevision: 99 });
      }),
      patchNode: vi.fn(),
    };
    vi.spyOn(SolarchApi, "fromStoredCredentials").mockReturnValue(fakeApi as unknown as SolarchApi);

    const { pushCommand } = await import("../src/commands/push.js");
    await pushCommand({ rootDir: dir, yes: true });

    expect(fakeApi.applyGraph).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // diğer testleri etkilemesin
  });

  it("illegal edge varken push tamamen reddedilir (apply çağrılmaz)", async () => {
    const code = asIs();
    code.nodes.push({
      key: "Controller:userscontroller",
      kind: "Controller",
      name: "UsersController",
      file: "src/users/users.controller.ts",
      properties: { ControllerName: "UsersController" },
    });
    code.edges.push({
      key: "Controller:userscontroller -[CALLS]-> Repository:usersrepository",
      kind: "CALLS",
      sourceKey: "Controller:userscontroller",
      targetKey: "Repository:usersrepository",
      file: "src/users/users.controller.ts",
      reason: "constructor injection",
    });
    runScanMock.mockReturnValue(code);

    const fakeApi = {
      getGraph: vi.fn(async () => toBe()),
      getRules: vi.fn(async () => RULES),
      applyGraph: vi.fn(),
      patchNode: vi.fn(),
    };
    vi.spyOn(SolarchApi, "fromStoredCredentials").mockReturnValue(fakeApi as unknown as SolarchApi);

    const { pushCommand } = await import("../src/commands/push.js");
    await pushCommand({ rootDir: dir, yes: true });

    expect(fakeApi.applyGraph).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

/* ── push --prune (silme yayılımı) ───────────────────────────────── */

describe("pushCommand — --prune silme yayılımı", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "solarch-prune-"));
    writeFileSync(join(dir, "solarch.json"), JSON.stringify({ projectId: "p1", bindings: [] }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Önceki koşudan iki node da map.json'da; kod artık yalnız Service → Repository silinmiş. */
  async function seedDeletedRepository(): Promise<void> {
    const { writeMatchCache } = await import("../src/config.js");
    writeMatchCache(dir, { "Service:usersservice": "n1", "Repository:usersrepository": "n2" });
    runScanMock.mockReturnValue(asIs({ nodes: [asIs().nodes[0]!], edges: [] }));
  }

  it("--prune ile koddan silinen node cloud'dan da silinir (deleteNode çağrılır)", async () => {
    await seedDeletedRepository();
    const fakeApi = {
      getGraph: vi.fn(async () => toBe()),
      getRules: vi.fn(async () => RULES),
      applyGraph: vi.fn(),
      patchNode: vi.fn(),
      deleteNode: vi.fn(async () => undefined),
      deleteEdge: vi.fn(async () => undefined),
    };
    vi.spyOn(SolarchApi, "fromStoredCredentials").mockReturnValue(fakeApi as unknown as SolarchApi);

    const { pushCommand } = await import("../src/commands/push.js");
    await pushCommand({ rootDir: dir, yes: true, prune: true });

    expect(fakeApi.deleteNode).toHaveBeenCalledTimes(1);
    expect(fakeApi.deleteNode).toHaveBeenCalledWith("p1", "n2");
    expect(fakeApi.deleteEdge).not.toHaveBeenCalled(); // edge node DETACH ile gider
    expect(fakeApi.applyGraph).not.toHaveBeenCalled(); // eklenecek yok
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("--prune olmadan hiçbir şey silinmez (varsayılan additif, deleteNode çağrılmaz)", async () => {
    await seedDeletedRepository();
    const fakeApi = {
      getGraph: vi.fn(async () => toBe()),
      getRules: vi.fn(async () => RULES),
      applyGraph: vi.fn(),
      patchNode: vi.fn(),
      deleteNode: vi.fn(async () => undefined),
      deleteEdge: vi.fn(async () => undefined),
    };
    vi.spyOn(SolarchApi, "fromStoredCredentials").mockReturnValue(fakeApi as unknown as SolarchApi);

    const { pushCommand } = await import("../src/commands/push.js");
    await pushCommand({ rootDir: dir, yes: true }); // prune yok

    expect(fakeApi.deleteNode).not.toHaveBeenCalled();
    expect(fakeApi.deleteEdge).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("cloud'da zaten gitmiş öğe (404) silme akışını patlatmaz — idempotent", async () => {
    await seedDeletedRepository();
    const fakeApi = {
      getGraph: vi.fn(async () => toBe()),
      getRules: vi.fn(async () => RULES),
      applyGraph: vi.fn(),
      patchNode: vi.fn(),
      deleteNode: vi.fn(async () => {
        throw new ApiError("gone", "ERR_NODE_NOT_FOUND", 404);
      }),
      deleteEdge: vi.fn(async () => undefined),
    };
    vi.spyOn(SolarchApi, "fromStoredCredentials").mockReturnValue(fakeApi as unknown as SolarchApi);

    const { pushCommand } = await import("../src/commands/push.js");
    await pushCommand({ rootDir: dir, yes: true, prune: true });

    expect(fakeApi.deleteNode).toHaveBeenCalledWith("p1", "n2");
    expect(process.exitCode ?? 0).toBe(0); // 404 yutuldu, hata değil
  });
});
