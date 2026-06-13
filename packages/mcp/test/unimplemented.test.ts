/** get_unimplemented — cerrahi AI iş kuyruğu: yalnız skeleton'lar, talimatlarıyla. */

import { describe, expect, it, vi } from "vitest";
import type { AsIsGraph } from "@solarch/ast-core";

const asIsGraph: AsIsGraph = {
  nodes: [
    {
      key: "Service:accountsservice",
      kind: "Service",
      name: "AccountsService",
      file: "src/accounts/accounts.service.ts",
      properties: { ServiceName: "AccountsService" },
      surgical: [
        {
          member: "createAccount",
          nodeId: "node-uuid-1",
          status: "skeleton",
          description: "Yeni hesap açar.",
          throws: ["DuplicateAccountException"],
          deps: ["accountsRepository"],
          line: 12,
        },
        { member: "closeAccount", nodeId: "node-uuid-1", status: "filled", line: 30 },
      ],
    },
    {
      key: "Service:manualservice",
      kind: "Service",
      name: "ManualService",
      file: "src/manual.service.ts",
      properties: { ServiceName: "ManualService" },
    },
  ],
  edges: [],
  warnings: [],
  fileCount: 2,
  scannedAt: "2026-06-13T00:00:00.000Z",
  rootDir: "/tmp/app",
  tsconfigPath: null,
};

vi.mock("@solarch/cli/lib", async (importOriginal) => {
  const original = await importOriginal<typeof import("@solarch/cli/lib")>();
  return { ...original, runScan: vi.fn(() => asIsGraph) };
});

const { getUnimplemented } = await import("../src/tools.js");

describe("getUnimplemented", () => {
  it("yalnız skeleton bölgeleri, talimat metadata'sıyla döner", () => {
    const report = getUnimplemented("/tmp/app");
    expect(report.totalMarked).toBe(2);
    expect(report.implemented).toBe(1);
    expect(report.remaining).toHaveLength(1);
    expect(report.remaining[0]).toMatchObject({
      nodeId: "node-uuid-1",
      className: "AccountsService",
      member: "createAccount",
      file: "src/accounts/accounts.service.ts",
      line: 12,
      description: "Yeni hesap açar.",
      throws: ["DuplicateAccountException"],
      deps: ["accountsRepository"],
    });
    expect(report.guidance).toContain("check_drift");
  });
});
