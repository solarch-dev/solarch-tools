import { describe, expect, it } from "vitest";
import { renderSarif } from "../src/diff/report.js";
import type { DiffResult } from "../src/diff/engine.js";

const result: DiffResult = {
  counts: { errors: 1, warns: 1, infos: 1 },
  matched: 3,
  cache: {},
  removable: { nodes: [], edges: [] },
  findings: [
    {
      code: "DRIFT_ILLEGAL_EDGE",
      severity: "error",
      message: "Controller cannot touch the Repository directly.",
      suggestion: "Go through a Service.",
      file: "src/users/users.controller.ts",
    },
    {
      code: "DRIFT_NODE_NOT_IN_CLOUD",
      severity: "warn",
      message: "RogueService exists in code but not in the architecture.",
      file: "src/rogue.service.ts",
    },
    { code: "DRIFT_PROPERTY", severity: "info", message: "Method 'list' is missing." },
  ],
};

describe("renderSarif", () => {
  it("emits valid SARIF 2.1.0 with level mapping, locations and rules", () => {
    const sarif = JSON.parse(renderSarif(result));

    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);
    const run = sarif.runs[0];
    expect(run.tool.driver.name).toBe("Solarch");

    // rules = unique codes
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id).sort()).toEqual([
      "DRIFT_ILLEGAL_EDGE",
      "DRIFT_NODE_NOT_IN_CLOUD",
      "DRIFT_PROPERTY",
    ]);

    // results: 3, errors first
    expect(run.results).toHaveLength(3);
    expect(run.results[0].level).toBe("error");

    const byRule = new Map<string, { level: string; message: { text: string }; locations?: unknown[] }>(
      run.results.map((r: { ruleId: string }) => [r.ruleId, r]),
    );
    // severity → SARIF level
    expect(byRule.get("DRIFT_NODE_NOT_IN_CLOUD")!.level).toBe("warning");
    expect(byRule.get("DRIFT_PROPERTY")!.level).toBe("note");
    // location uri = file; suggestion folded into the message
    const illegal = byRule.get("DRIFT_ILLEGAL_EDGE")! as {
      message: { text: string };
      locations: { physicalLocation: { artifactLocation: { uri: string } } }[];
    };
    expect(illegal.locations[0]!.physicalLocation.artifactLocation.uri).toBe("src/users/users.controller.ts");
    expect(illegal.message.text).toContain("→");
    // finding with no file → no locations
    expect(byRule.get("DRIFT_PROPERTY")!.locations).toBeUndefined();
  });
});
