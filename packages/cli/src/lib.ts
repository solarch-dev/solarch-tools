/** @solarch/cli/lib — yan etkisiz kütüphane girişi.
 *
 *  `dist/index.js` commander binary'sidir (import edilince parse çalışır);
 *  bu giriş ise motorları dışarı açar. Tüketici: `@solarch/mcp` —
 *  MCP araçları aynı API istemcisini, diff motorunu ve push planner'ını
 *  CLI ile birebir paylaşır (tek kaynak, davranış sapması yok). */

export {
  ApiError,
  SolarchApi,
  type ApplyEdge,
  type ApplyNode,
  type ApplyPayload,
  type ApplyResult,
  type ApplyViolation,
  type CloudEdge,
  type CloudGraph,
  type CloudNode,
  type GeneratedFile,
  type GeneratedProject,
  type ProjectSummary,
  type RuleCatalog,
} from "./api.js";

export { writeGeneratedFiles, type WriteResult } from "./commands/generate.js";

export {
  DEFAULT_API_URL,
  readCredentials,
  readMatchCache,
  readProjectConfig,
  writeCredentials,
  writeMatchCache,
  writeProjectConfig,
  type Credentials,
  type MatchCache,
  type ProjectConfig,
} from "./config.js";

export { toBePath } from "./commands/pull.js";

export {
  diffGraphs,
  evaluateEdge,
  listFieldDrift,
  LIST_FIELD_SPEC,
  type DiffResult,
  type DriftFinding,
  type Severity,
} from "./diff/engine.js";

export {
  buildPushPlan,
  planIsEmpty,
  toApplyPayload,
  type PushPlan,
} from "./push/planner.js";

export { runScan } from "./commands/scan.js";

export {
  buildImplementationReport,
  type ImplementationReport,
  type NodeImplementation,
} from "./commands/status.js";
