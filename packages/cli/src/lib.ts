/** @solarch/cli/lib — side-effect-free library entry.
 *
 *  `dist/index.js` is the commander binary (import triggers parse);
 *  this entry exposes the engines. Consumer: `@solarch/mcp` —
 *  MCP tools share the same API client, diff engine, and push planner as the
 *  CLI (single source, no behavior drift). */

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
  type ImplementationEntry,
  type ProjectSummary,
  type RuleCatalog,
} from "./api.js";

export { writeGeneratedFiles, type WriteResult } from "./commands/generate.js";

export {
  DEFAULT_API_URL,
  mergeGeneratedManifest,
  readCredentials,
  readGeneratedManifest,
  readMatchCache,
  readProjectConfig,
  writeCredentials,
  writeMatchCache,
  writeProjectConfig,
  type Credentials,
  type GeneratedManifest,
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
  toImplementationEntries,
  type ImplementationReport,
  type MarkerLoss,
  type NodeImplementation,
} from "./commands/status.js";

export {
  fillProject,
  fillRegion,
  selectSkeletons,
  type FillOptions,
  type FillRegionResult,
  type FillReport,
  type RegionTarget,
} from "./fill/orchestrator.js";

export { createCompleter, llmConfigFromEnv, type CompleteFn, type LlmConfig } from "./fill/llm.js";
