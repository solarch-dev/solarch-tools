/** İşaret kaybı tespiti + cloud rapor girdileri (toImplementationEntries). */

import { describe, expect, it } from "vitest";
import type { AsIsGraph, AsIsNode, SurgicalMember } from "@solarch/ast-core";
import { buildImplementationReport, toImplementationEntries } from "../src/commands/status.js";
import type { GeneratedManifest } from "../src/config.js";

const member = (m: string, status: "skeleton" | "filled", extra: Partial<SurgicalMember> = {}): SurgicalMember => ({
  member: m,
  nodeId: "uuid-svc",
  status,
  line: 10,
  ...extra,
});

const node = (name: string, file: string, surgical?: SurgicalMember[]): AsIsNode => ({
  key: `Service:${name.toLowerCase()}`,
  kind: "Service",
  name,
  file,
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

describe("marker loss", () => {
  const manifest: GeneratedManifest = {
    "src/orders.service.ts": { nodeId: "uuid-svc", markers: 2 },
    "src/mail.service.ts": { nodeId: "uuid-mail", markers: 1 },
    "src/deleted.service.ts": { nodeId: "uuid-del", markers: 1 },
  };

  it("dosya duruyor + işaret sıfır → kayıp; taramada işaret varsa kayıp değil; silinen dosya diff'in işi", () => {
    const report = buildImplementationReport(
      graph([
        node("Orders", "src/orders.service.ts", [member("a", "filled")]), // işaret hâlâ var
        node("Mail", "src/mail.service.ts"), // işaretler silinmiş ama dosya duruyor
      ]),
      manifest,
      (rel) => rel !== "src/deleted.service.ts", // deleted.service.ts diskte yok
    );
    expect(report.lostMarkers).toEqual([
      { file: "src/mail.service.ts", expected: 1, nodeId: "uuid-mail" },
    ]);
  });
});

describe("toImplementationEntries", () => {
  it("önce map.json eşlemesi, yoksa işaretteki nodeId kullanılır", () => {
    const report = buildImplementationReport(
      graph([
        node("Orders", "src/o.ts", [member("a", "filled", { filledBy: "ai" }), member("b", "skeleton")]),
        node("Unmatched", "src/u.ts", [member("c", "skeleton", { nodeId: "uuid-marker" })]),
      ]),
    );
    const entries = toImplementationEntries(report, { "Service:orders": "uuid-from-map" });
    expect(entries).toEqual([
      { nodeId: "uuid-from-map", total: 2, filled: 1, filledAi: 1 },
      { nodeId: "uuid-marker", total: 1, filled: 0, filledAi: 0 },
    ]);
  });
});
