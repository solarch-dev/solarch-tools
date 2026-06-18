export * from "./types.js";
export { classifyClass } from "./classify.js";
export { scanProject, type ScanOptions } from "./scan.js";
export {
  readSurgicalMembers,
  readFillContext,
  readDeclaredSurface,
  completeType,
  fixMissingImportsInFiles,
  summarizeSurgical,
  tryFillSurgicalBody,
  writeSurgicalBody,
  type CompleteTypeResult,
  type FilledBy,
  type SurgicalFillContext,
  type SurgicalMember,
  type SurgicalStatus,
  type SurgicalSummary,
  type WriteBodyResult,
} from "./surgical.js";
export { cleanTypeText, unwrapTypeName } from "./extract.js";
export {
  BOUND_MARKER,
  parseBindingRef,
  readSourceProperties,
  runBinding,
  syncProperties,
  type BindingSyncOutcome,
  type SourceProperty,
  type SyncConflict,
  type SyncResult,
} from "./write.js";
