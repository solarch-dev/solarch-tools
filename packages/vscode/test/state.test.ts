/** buildGraphState — diff motorunun gerçek çıktısıyla (mock yok) birleşik
 *  görsel grafın durum boyamasını doğrular. */

import { describe, expect, it } from "vitest";
import type { AsIsGraph } from "@solarch/ast-core";
import { diffGraphs, type CloudGraph, type RuleCatalog } from "@solarch/cli/lib";
import { buildGraphState } from "../src/state.js";

const RULES: RuleCatalog = {
  whitelist: [
    { source: "Controller", edge: "CALLS", target: "Service", layer: "app" },
    { source: "Repository", edge: "QUERIES", target: "Table", layer: "data" },
  ],
  blacklist: [
    {
      code: "ERR_002",
      source: "Controller",
      edge: "QUERIES",
      target: "Table",
      message: "Controllers must not query tables directly.",
      suggestion: "Route through a Service.",
    },
  ],
};

const asIs: AsIsGraph = {
  nodes: [
    {
      key: "Service:usersservice",
      kind: "Service",
      name: "UsersService",
      file: "src/users/users.service.ts",
      properties: { ServiceName: "UsersService" },
      surgical: [
        { member: "create", nodeId: "n-svc", status: "skeleton", description: "Kullanıcı açar.", line: 12 },
        { member: "findAll", nodeId: "n-svc", status: "filled", line: 30 },
      ],
    },
    { key: "Controller:userscontroller", kind: "Controller", name: "UsersController", file: "src/users/users.controller.ts", properties: { ControllerName: "UsersController" } },
    { key: "Table:audit_log", kind: "Table", name: "audit_log", file: "src/audit/audit.entity.ts", properties: { TableName: "audit_log" } },
  ],
  edges: [
    {
      key: "Controller:userscontroller-[CALLS]->Service:usersservice",
      sourceKey: "Controller:userscontroller",
      targetKey: "Service:usersservice",
      kind: "CALLS",
      file: "src/users/users.controller.ts",
      reason: "constructor injection",
    },
    {
      key: "Controller:userscontroller-[QUERIES]->Table:audit_log",
      sourceKey: "Controller:userscontroller",
      targetKey: "Table:audit_log",
      kind: "QUERIES",
      file: "src/users/users.controller.ts",
      reason: "direct repository access",
    },
  ],
  warnings: [],
  fileCount: 3,
  scannedAt: "2026-06-12T00:00:00.000Z",
  rootDir: "/tmp/test-app",
  tsconfigPath: null,
};

const cloud: CloudGraph = {
  project: { id: "p1", name: "demo" },
  nodes: [
    { id: "n-svc", type: "Service", projectId: "p1", version: 1, properties: { ServiceName: "UsersService" } },
    { id: "n-ctrl", type: "Controller", projectId: "p1", version: 1, properties: { ControllerName: "UsersController" } },
    { id: "n-cache", type: "Cache", projectId: "p1", version: 1, properties: { CacheName: "SessionCache" } },
  ],
  edges: [
    { id: "e1", kind: "CALLS", sourceNodeId: "n-ctrl", targetNodeId: "n-svc", properties: {} },
    { id: "e2", kind: "CACHES_IN", sourceNodeId: "n-svc", targetNodeId: "n-cache", properties: {} },
  ],
  counts: { nodes: 3, edges: 2 },
  graphRevision: 4,
};

function build() {
  const diff = diffGraphs(asIs, cloud, RULES, {});
  return buildGraphState(asIs, cloud, RULES, diff);
}

describe("buildGraphState", () => {
  it("node durumlarını boyar: synced / cloudOnly / codeOnly", () => {
    const state = build();
    const byName = new Map(state.nodes.map((n) => [n.name, n]));

    expect(byName.get("UsersService")?.status).toBe("synced");
    expect(byName.get("UsersService")?.id).toBe("n-svc"); // eşleşen node cloud id taşır
    expect(byName.get("UsersService")?.file).toBe("src/users/users.service.ts"); // tıkla-zıpla

    expect(byName.get("SessionCache")?.status).toBe("cloudOnly"); // kodda yok
    expect(byName.get("audit_log")?.status).toBe("codeOnly"); // diyagramda yok
    expect(byName.get("audit_log")?.family).toBe("data");
  });

  it("edge durumlarını boyar: synced / cloudOnly / illegal", () => {
    const state = build();
    const byKind = new Map(state.edges.map((e) => [`${e.kind}:${e.status}`, e]));

    // Controller CALLS Service — iki tarafta da var.
    expect(byKind.has("CALLS:synced")).toBe(true);
    // Service CACHES_IN Cache — diyagramda var, kodda yok.
    expect(byKind.has("CACHES_IN:cloudOnly")).toBe(true);
    // Controller QUERIES Table — kodda var ve blacklist ihlali.
    const illegal = byKind.get("QUERIES:illegal");
    expect(illegal).toBeDefined();
    expect(illegal?.note).toContain("ERR_002");
    // Eşleşen uç cloud id'ye, eşleşmeyen uç kod key'ine bağlanır.
    expect(illegal?.source).toBe("n-ctrl");
    expect(illegal?.target).toBe("Table:audit_log");
  });

  it("bulgu sayaçlarını ve revizyonu taşır", () => {
    const state = build();
    expect(state.graphRevision).toBe(4);
    expect(state.projectName).toBe("demo");
    // error: SessionCache kodda yok + illegal QUERIES. (CACHES_IN ayrıca
    // sayılmaz — ucu eşleşmeyen edge için motor yalnız node bulgusu verir.)
    expect(state.counts.errors).toBe(2);
    expect(state.findings.some((f) => f.code === "DRIFT_ILLEGAL_EDGE")).toBe(true);
  });

  it("implementasyon panosunu surgical işaretlerden kurar", () => {
    const state = build();
    expect(state.implementation.total).toBe(2);
    expect(state.implementation.filled).toBe(1);
    expect(state.implementation.skeletons).toEqual([
      {
        className: "UsersService",
        member: "create",
        file: "src/users/users.service.ts",
        line: 12,
        description: "Kullanıcı açar.",
      },
    ]);
  });

  it("tüm node'lar görselde benzersiz id taşır (edge uçları çözülebilir)", () => {
    const state = build();
    const ids = new Set(state.nodes.map((n) => n.id));
    expect(ids.size).toBe(state.nodes.length);
    for (const e of state.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });
});
