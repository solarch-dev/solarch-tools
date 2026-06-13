/** check_drift — runScan mock'lanır (gerçek AST taraması scan testlerinin işi),
 *  diff motoru + cache yazımı + ajan-dostu verdict gerçek çalışır. */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AsIsGraph } from "@solarch/ast-core";
import type { CloudGraph, RuleCatalog } from "@solarch/cli/lib";

const asIsGraph: AsIsGraph = {
  nodes: [
    {
      key: "Service:usersservice",
      kind: "Service",
      name: "UsersService",
      file: "src/users/users.service.ts",
      properties: { ServiceName: "UsersService" },
    },
  ],
  edges: [],
  warnings: [],
  fileCount: 1,
};

vi.mock("@solarch/cli/lib", async (importOriginal) => {
  const original = await importOriginal<typeof import("@solarch/cli/lib")>();
  return { ...original, runScan: vi.fn(() => asIsGraph) };
});

const { checkDrift } = await import("../src/tools.js");

const RULES: RuleCatalog = { whitelist: [], blacklist: [] };

const cloudGraph: CloudGraph = {
  project: { id: "p1", name: "demo" },
  nodes: [
    { id: "n-svc", type: "Service", projectId: "p1", version: 1, properties: { ServiceName: "UsersService" } },
    { id: "n-table", type: "Table", projectId: "p1", version: 1, properties: { TableName: "users" } },
  ],
  edges: [],
  counts: { nodes: 2, edges: 0 },
  graphRevision: 3,
};

describe("checkDrift", () => {
  const dir = mkdtempSync(join(tmpdir(), "solarch-mcp-drift-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("kodda eksik node'u error olarak raporlar, cache'i yazar, verdict üretir", async () => {
    const report = await checkDrift({
      rootDir: dir,
      projectId: "p1",
      api: {
        getGraph: vi.fn(async () => cloudGraph),
        getRules: vi.fn(async () => RULES),
        applyGraph: vi.fn(),
      },
    });

    expect(report.clean).toBe(false);
    expect(report.counts.errors).toBe(1); // Table "users" kodda yok
    expect(report.matched).toBe(1); // UsersService eşleşti
    expect(report.findings.some((f) => f.code === "DRIFT_NODE_MISSING_IN_CODE")).toBe(true);
    expect(report.verdict).toContain("Fix these BEFORE finishing");
    expect(existsSync(join(dir, ".solarch", "map.json"))).toBe(true);
  });
});
