/** buildImplementationReport — node bazında doluluk + bekleyen iş sıralaması. */

import { describe, expect, it } from "vitest";
import type { AsIsGraph, AsIsNode, SurgicalMember } from "@solarch/ast-core";
import { buildImplementationReport } from "../src/commands/status.js";

const member = (m: string, status: "skeleton" | "filled"): SurgicalMember => ({
  member: m,
  nodeId: "n-1",
  status,
  line: 10,
});

const node = (name: string, surgical?: SurgicalMember[]): AsIsNode => ({
  key: `Service:${name.toLowerCase()}`,
  kind: "Service",
  name,
  file: `src/${name.toLowerCase()}.service.ts`,
  properties: { ServiceName: name },
  ...(surgical ? { surgical } : {}),
});

const graph = (nodes: AsIsNode[]): AsIsGraph => ({
  scannedAt: "2026-06-13T00:00:00.000Z",
  rootDir: "/tmp/x",
  tsconfigPath: null,
  fileCount: nodes.length,
  nodes,
  edges: [],
  warnings: [],
});

describe("buildImplementationReport", () => {
  it("işaretsiz node'ları dışarıda bırakır, toplamları doğru toplar", () => {
    const report = buildImplementationReport(
      graph([
        node("Manual"), // işaretsiz — rapora girmez
        node("Half", [member("a", "filled"), member("b", "skeleton")]),
        node("Done", [member("c", "filled")]),
      ]),
    );
    expect(report.nodes.map((n) => n.name)).toEqual(["Half", "Done"]); // eksiği olan üstte
    expect(report.totals).toEqual({ members: 3, filled: 2, skeletons: 1, filledAi: 0, violations: 0 });
    expect(report.nodes[0]?.skeletons.map((s) => s.member)).toEqual(["b"]);
  });

  it("hiç işaret yoksa boş rapor döner", () => {
    const report = buildImplementationReport(graph([node("Manual")]));
    expect(report.nodes).toEqual([]);
    expect(report.totals.members).toBe(0);
  });
});
