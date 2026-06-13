/** Solarch graph taxonomy — mirror of backend `nodes/schemas` + `edges/schemas`
 *  definitions. CLI/MCP speak these types; no new format is invented, everything
 *  maps to the cloud schema. */

export const NODE_KINDS = [
  "Table", "DTO", "Model", "Enum", "View",
  "Service", "Worker", "EventHandler",
  "Controller", "MessageQueue",
  "Repository", "Cache", "ExternalService",
  "FrontendApp", "UIComponent",
  "Middleware",
  "EnvironmentVariable", "Exception",
  "Module",
  "APIGateway", "Orchestrator",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "CALLS", "REQUESTS", "PUBLISHES", "SUBSCRIBES",
  "USES", "HAS", "EXTENDS", "IMPLEMENTS", "RETURNS",
  "QUERIES", "WRITES", "CACHES_IN",
  "DEPENDS_ON", "READS_CONFIG", "THROWS", "ROUTES_TO",
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Kind → properties içindeki "isim" alanı. Backend şemalarıyla birebir —
 *  diff motoru To-Be node'larından kanonik ismi bu haritayla çeker. */
export const NAME_FIELD_BY_KIND: Record<NodeKind, string> = {
  Table: "TableName",
  DTO: "Name",
  Model: "ClassName",
  Enum: "Name",
  View: "ViewName",
  Service: "ServiceName",
  Worker: "WorkerName",
  EventHandler: "HandlerName",
  Controller: "ControllerName",
  MessageQueue: "QueueName",
  Repository: "RepositoryName",
  Cache: "CacheName",
  ExternalService: "ServiceName",
  FrontendApp: "AppName",
  UIComponent: "ComponentName",
  Middleware: "MiddlewareName",
  EnvironmentVariable: "Key",
  Exception: "ExceptionName",
  Module: "ModuleName",
  APIGateway: "GatewayName",
  Orchestrator: "OrchestratorName",
};

/** Bir node'un properties objesinden ismini çıkarır (kind'a göre doğru alan). */
export function nameOfNode(kind: NodeKind, properties: Record<string, unknown>): string {
  const field = NAME_FIELD_BY_KIND[kind];
  const v = properties[field];
  return typeof v === "string" ? v : "";
}

/** Kanonik isim — eşleştirme anahtarı: küçük harf + yalnız alfanumerik.
 *  "UsersService", "users-service" ve "users_service" aynı anahtara düşer. */
export function canonicalName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function nodeKey(kind: NodeKind, name: string): string {
  return `${kind}:${canonicalName(name)}`;
}

export function edgeKey(sourceKey: string, kind: EdgeKind, targetKey: string): string {
  return `${sourceKey} -[${kind}]-> ${targetKey}`;
}

/** Koddan çıkarılan node — backend node şekline en yakın properties + kaynak konumu. */
export interface AsIsNode {
  key: string;
  kind: NodeKind;
  /** Sınıf/bildirim adı, yazıldığı gibi (ör. UsersService). */
  name: string;
  /** Proje köküne göre dosya yolu. */
  file: string;
  /** Backend şemasına map edilmiş properties (best-effort). */
  properties: Record<string, unknown>;
  /** Codegen'in bıraktığı surgical işaretler (varsa) — implementasyon durumu. */
  surgical?: import("./surgical.js").SurgicalMember[];
}

/** Koddan çıkarılan edge — kaynağı AST kanıtıdır (constructor injection, @Body, ...). */
export interface AsIsEdge {
  key: string;
  kind: EdgeKind;
  sourceKey: string;
  targetKey: string;
  /** Çıkarımın yapıldığı dosya. */
  file: string;
  /** İnsan-okur kanıt: niçin bu edge var. */
  reason: string;
}

export interface AsIsGraph {
  scannedAt: string;
  rootDir: string;
  tsconfigPath: string | null;
  fileCount: number;
  nodes: AsIsNode[];
  edges: AsIsEdge[];
  /** Sınıflandırılamayan/şüpheli durumlar — sessizce yutulmaz, rapora girer. */
  warnings: string[];
}
