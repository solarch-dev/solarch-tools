/** contextKeyForState — her menü/welcome when-clause'unu kapı tutan saf eşleme.
 *  ok (offline dahil) → "ok"; aksi halde hata gerekçesi birebir yansır. */

import { describe, expect, it } from "vitest";
import { contextKeyForState, type GraphState, type GraphStateOk } from "../src/shared.js";

const ok: GraphStateOk = {
  ok: true,
  projectName: "demo",
  graphRevision: 1,
  nodes: [],
  edges: [],
  findings: [],
  counts: { errors: 0, warns: 0, infos: 0 },
  implementation: { total: 0, filled: 0, filledAi: 0, skeletons: [], violations: [], lostMarkers: [] },
  generatedAt: "2026-06-15T00:00:00.000Z",
};

describe("contextKeyForState", () => {
  it("ok → 'ok'", () => {
    expect(contextKeyForState(ok)).toBe("ok");
  });

  it("offline ok hâlâ 'ok' — butonlar gizlenmez", () => {
    expect(contextKeyForState({ ...ok, offline: true })).toBe("ok");
  });

  it("her hata gerekçesi context anahtarı olarak yansır", () => {
    const reasons = ["notLinked", "notLoggedIn", "apiError", "scanError"] as const;
    for (const reason of reasons) {
      const state: GraphState = { ok: false, reason, message: "m", suggestion: "s" };
      expect(contextKeyForState(state)).toBe(reason);
    }
  });
});
