/** Durum sözleşmesi + aile renkleri — state.ts üretir, tree.ts gösterir.
 *  VSCode API'si import etmez; testler saf tüketir. */

/* ── aile renkleri (solarch-frontend/src/canvas/families.ts aynası) ── */

export type NodeFamily =
  | "data" | "business" | "access" | "infrastructure"
  | "client" | "security" | "configuration" | "structure";

const TYPE_FAMILY: Record<string, NodeFamily> = {
  Table: "data", DTO: "data", Model: "data", Enum: "data", View: "data",
  Service: "business", Worker: "business", EventHandler: "business", Orchestrator: "business",
  Controller: "access", APIGateway: "access", MessageQueue: "access",
  Repository: "infrastructure", Cache: "infrastructure", ExternalService: "infrastructure",
  FrontendApp: "client", UIComponent: "client",
  Middleware: "security",
  EnvironmentVariable: "configuration", Exception: "configuration",
  Module: "structure",
};

export const FAMILY_COLOR: Record<NodeFamily, string> = {
  data: "#3B82F6",
  business: "#10B981",
  access: "#F97316",
  infrastructure: "#0891B2",
  client: "#C026D3",
  security: "#8B5CF6",
  configuration: "#D97706",
  structure: "#6B7280",
};

export function familyOf(type: string): NodeFamily {
  return TYPE_FAMILY[type] ?? "structure";
}

export function colorOf(type: string): string {
  return FAMILY_COLOR[familyOf(type)];
}

/* ── graf durumu ─────────────────────────────────────────────────── */

/** Git Graph benzetmesi: synced = her iki tarafta, codeOnly = onaysız genişleme
 *  (sarı), cloudOnly = taahhüt karşılanmadı (kırmızı), illegal = kural ihlali. */
export type SyncStatus = "synced" | "codeOnly" | "cloudOnly";
export type EdgeStatus = SyncStatus | "illegal";

export interface StateNode {
  id: string;
  type: string;
  name: string;
  family: NodeFamily;
  status: SyncStatus;
  /** As-Is kanıt dosyası (repo köküne göre) — tıklayınca açılır. */
  file?: string;
}

export interface StateEdge {
  id: string;
  kind: string;
  source: string;
  target: string;
  status: EdgeStatus;
  file?: string;
  /** İhlal mesajı (illegal edge'de tooltip). */
  note?: string;
}

export interface StateFinding {
  severity: "error" | "warn" | "info";
  code: string;
  message: string;
  file?: string;
  suggestion?: string;
}

/** Doldurulmayı bekleyen surgical bölge (codegen iskeleti). */
export interface SkeletonMember {
  className: string;
  member: string;
  file: string;
  line: number;
  description?: string;
}

/** Dolu gövdenin sözleşme ihlali (beyan dışı dep/throw). */
export interface ContractViolation {
  className: string;
  member: string;
  file: string;
  line: number;
  messages: string[];
}

/** Üretilmiş dosyada artık hiç işaret yok — takip kör. */
export interface MarkerLossInfo {
  file: string;
  expected: number;
}

/** Codegen işaretlerinden türeyen implementasyon panosu. */
export interface ImplementationState {
  /** İşaretli üye toplamı (0 ise bu repoda scaffold yok — bölüm gizlenir). */
  total: number;
  filled: number;
  /** İmzaya göre AI'ın doldurduğu üye sayısı. */
  filledAi: number;
  skeletons: SkeletonMember[];
  violations: ContractViolation[];
  lostMarkers: MarkerLossInfo[];
}

export interface GraphStateOk {
  ok: true;
  projectName: string;
  graphRevision: number;
  nodes: StateNode[];
  edges: StateEdge[];
  findings: StateFinding[];
  counts: { errors: number; warns: number; infos: number };
  implementation: ImplementationState;
  generatedAt: string;
}

export interface GraphStateError {
  ok: false;
  reason: "notLinked" | "notLoggedIn" | "apiError" | "scanError";
  message: string;
  suggestion: string;
}

export type GraphState = GraphStateOk | GraphStateError;
