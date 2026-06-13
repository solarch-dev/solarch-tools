export * from "./types.js";
export { classifyClass } from "./classify.js";
export { scanProject, type ScanOptions } from "./scan.js";
export {
  readSurgicalMembers,
  summarizeSurgical,
  type SurgicalMember,
  type SurgicalStatus,
  type SurgicalSummary,
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
