/** Graph diff (drift) engine — compares As-Is (scanned from code) with To-Be
 *  (Solarch Cloud) graph.
 *
 *  Matching: no UUID on AST side, so nodes match on `(kind, canonical name)`;
 *  matches are written to map.json cache so they stay stable until cloud rename
 *  (if cached cloud id still lives, match survives name change).
 *
 *  Severity levels:
 *  - error: rule violation (blacklist / non-whitelisted edge) AND in cloud but
 *    missing in code (architecture commitment not met).
 *  - warn: in code but not in cloud (unapproved expansion).
 *  - info: property-level diffs (columns/fields).  */

import {
  nameOfNode,
  nodeKey,
  WILDCARD_CONTROLLER_KEY,
  WILDCARD_SERVICE_KEY,
  type AsIsEdge,
  type AsIsGraph,
  type AsIsNode,
  type EdgeKind,
  type NodeKind,
} from "@solarch/ast-core";
import type { CloudEdge, CloudGraph, CloudNode, RuleCatalog } from "../api.js";
import type { MatchCache } from "../config.js";

export type Severity = "error" | "warn" | "info";

export interface DriftFinding {
  severity: Severity;
  code:
    | "DRIFT_NODE_MISSING_IN_CODE"
    | "DRIFT_NODE_NOT_IN_CLOUD"
    | "DRIFT_EDGE_MISSING_IN_CODE"
    | "DRIFT_EDGE_NOT_IN_CLOUD"
    | "DRIFT_ILLEGAL_EDGE"
    | "DRIFT_PROPERTY";
  message: string;
  /** As-Is tarafında kanıt dosyası (varsa) — CI annotation'ları için. */
  file?: string;
  suggestion?: string;
}

export interface DiffResult {
  findings: DriftFinding[];
  matched: number;
  counts: { errors: number; warns: number; infos: number };
  /** Güncellenmiş eşleştirme cache'i — çağıran map.json'a yazar. */
  cache: MatchCache;
  /** `push --prune` adayları: koddan SİLİNDİĞİ KESİN olan, cloud'da hâlâ duran
   *  öğeler. Node: bir önceki taramada eşleşmişti (cache'te vardı), şimdi yok —
   *  rename'i dışlar (rename'de cloud id yeni anahtar altında yeniden eşleşir).
   *  Edge: iki ucu da eşleşen (kodda yaşayan) node'lar arası, kodda karşılığı
   *  olmayan bağımlılık. "Henüz-çizilmiş-ama-yapılmamış" öğe içermez. */
  removable: { nodes: CloudNode[]; edges: CloudEdge[] };
}

/* ── kural değerlendirme ─────────────────────────────────────────── */

const toArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);
const matches = (pattern: string | string[], value: string): boolean =>
  toArray(pattern).some((p) => p === "*" || p === value);

/** As-Is edge'in legalliği — önce blacklist (keskin yasak), sonra whitelist
 *  (default deny). Backend RulesEngine ile aynı sıra. Push planner da kullanır
 *  (illegal edge ASLA pushlanmaz). */
export function evaluateEdge(
  rules: RuleCatalog,
  source: NodeKind,
  edge: EdgeKind,
  target: NodeKind,
): { allowed: boolean; message?: string; suggestion?: string } {
  for (const deny of rules.blacklist) {
    if (matches(deny.source, source) && matches(deny.edge, edge) && matches(deny.target, target)) {
      return { allowed: false, message: `${deny.code}: ${deny.message}`, suggestion: deny.suggestion };
    }
  }
  const allowed = rules.whitelist.some(
    (rule) =>
      toArray(rule.source).includes(source) &&
      toArray(rule.edge).includes(edge) &&
      toArray(rule.target).includes(target),
  );
  return allowed
    ? { allowed: true }
    : {
        allowed: false,
        message: `${source} -[${edge}]-> ${target} is not in the whitelist (default deny).`,
        suggestion: "Add this connection in the Solarch canvas first, or remove it from the code.",
      };
}

/* ── property karşılaştırma (info seviyesi) ──────────────────────── */

function listNames(
  properties: Record<string, unknown>,
  listField: string,
  nameField: string,
  normalize: (v: string) => string = (v) => v.toLowerCase(),
): Set<string> {
  const list = properties[listField];
  if (!Array.isArray(list)) return new Set();
  return new Set(
    list
      .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>)[nameField] ?? "") : ""))
      .filter(Boolean)
      .map(normalize),
  );
}

/** Endpoint yolunu kanonikleştir: OpenAPI `{param}` ile NestJS `:param` aynı
 *  yola işaret eder; parametre adı geliştiricinin tercihi olduğundan yer
 *  tutucuya indirgenir. `/orders/{id}` ve `/orders/:orderId` → `/orders/:p`. */
function canonicalRoute(route: string): string {
  return route
    .replace(/\{[^}]+\}/g, ":p")
    .replace(/:[A-Za-z0-9_]+/g, ":p")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Kind → liste-alanı tanımı. Diff bu alanlarda info-seviyesi drift raporlar;
 *  push'ta bu alanlarda **kod kaynak kabul edilir** (cloud listesi kodunkiyle
 *  değiştirilir, diğer cloud property'leri korunur). */
export const LIST_FIELD_SPEC: Partial<
  Record<NodeKind, { listField: string; nameField: string; label: string; normalize?: (v: string) => string }>
> = {
  Table: { listField: "Columns", nameField: "Name", label: "column" },
  DTO: { listField: "Fields", nameField: "Name", label: "field" },
  Service: { listField: "Methods", nameField: "MethodName", label: "method" },
  Controller: { listField: "Endpoints", nameField: "Route", label: "endpoint", normalize: canonicalRoute },
  Enum: { listField: "Values", nameField: "Key", label: "value" },
};

/** Eşleşen node çiftinde liste-alanı farkı (yapılandırılmış) — yoksa null. */
export function listFieldDrift(
  asIs: AsIsNode,
  cloud: CloudNode,
): { listField: string; label: string; missing: string[]; extra: string[] } | null {
  const s = LIST_FIELD_SPEC[asIs.kind];
  if (!s) return null;
  const inCode = listNames(asIs.properties, s.listField, s.nameField, s.normalize);
  const inCloud = listNames(cloud.properties, s.listField, s.nameField, s.normalize);
  const missing = [...inCloud].filter((n) => !inCode.has(n));
  const extra = [...inCode].filter((n) => !inCloud.has(n));
  if (missing.length === 0 && extra.length === 0) return null;
  return { listField: s.listField, label: s.label, missing, extra };
}

/** Tablo kolonları / DTO alanları gibi liste-property farkları (insan-okur). */
function propertyDrift(asIs: AsIsNode, cloud: CloudNode): string[] {
  const drift = listFieldDrift(asIs, cloud);
  if (!drift) return [];
  const drifts: string[] = [];
  if (drift.missing.length > 0) drifts.push(`${drift.label}(s) in cloud but not in code: ${drift.missing.join(", ")}`);
  if (drift.extra.length > 0) drifts.push(`${drift.label}(s) in code but not in cloud: ${drift.extra.join(", ")}`);
  return drifts;
}

/* ── edge-kind kapsama (subsumption) ─────────────────────────────── */

/** Mimari daha genel bir fiil çizip kod onu daha özel bir fiille
 *  gerçekleştirdiğinde drift sayılmaz. Controller bir response DTO'sunu
 *  "kullanır" (USES) — kodda onu "döndürmek" (RETURNS) bu taahhüdü karşılar. */
const EDGE_KIND_SUBSUMES: Partial<Record<EdgeKind, EdgeKind[]>> = {
  USES: ["RETURNS"],
};

/** Bir bulut edge-kind'ını koddaki hangi kind'lar karşılar (kendisi + alt türleri). */
function codeKindsSatisfying(cloudKind: EdgeKind): EdgeKind[] {
  return [cloudKind, ...(EDGE_KIND_SUBSUMES[cloudKind] ?? [])];
}

/** Bir kod edge-kind'ını bulutta hangi kind'lar kapsar (kendisi + üst türleri). */
function cloudKindsCovering(codeKind: EdgeKind): EdgeKind[] {
  const supers = (Object.keys(EDGE_KIND_SUBSUMES) as EdgeKind[]).filter((k) =>
    (EDGE_KIND_SUBSUMES[k] ?? []).includes(codeKind),
  );
  return [codeKind, ...supers];
}

/* ── ana diff ────────────────────────────────────────────────────── */

export function diffGraphs(
  asIs: AsIsGraph,
  toBe: CloudGraph,
  rules: RuleCatalog | null,
  previousCache: MatchCache,
): DiffResult {
  const findings: DriftFinding[] = [];
  const cache: MatchCache = {};

  // Cloud node'ları kanonik anahtara ve id'ye indeksle.
  const cloudById = new Map<string, CloudNode>();
  const cloudByKey = new Map<string, CloudNode>();
  for (const n of toBe.nodes) {
    cloudById.set(n.id, n);
    const name = nameOfNode(n.type, n.properties);
    if (name) cloudByKey.set(nodeKey(n.type, name), n);
  }

  // Eşleştirme: önce cache (cloud id hâlâ var mı), sonra kanonik anahtar.
  const codeKeyToCloudId = new Map<string, string>();
  const matchedCloudIds = new Set<string>();
  for (const node of asIs.nodes) {
    const cachedId = previousCache[node.key];
    const cached = cachedId ? cloudById.get(cachedId) : undefined;
    // Eşleştirme anahtarını node.key (sınıf adı) yerine kanonik isimden (nameOfNode)
    // türet → Table'da sınıf adı (Reservation) ≠ TableName (reservations) olduğunda
    // cloud anahtarıyla (TableName) hizalanır. nameOfNode boşsa sınıf adına düşer.
    const matchKey = nodeKey(node.kind, nameOfNode(node.kind, node.properties) || node.name);
    const found = cached && cached.type === node.kind ? cached : cloudByKey.get(matchKey);
    if (found && !matchedCloudIds.has(found.id)) {
      codeKeyToCloudId.set(node.key, found.id);
      matchedCloudIds.add(found.id);
      cache[node.key] = found.id;
    }
  }

  // Node farkları.
  for (const cloud of toBe.nodes) {
    if (matchedCloudIds.has(cloud.id)) continue;
    const name = nameOfNode(cloud.type, cloud.properties) || cloud.id;
    findings.push({
      severity: "error",
      code: "DRIFT_NODE_MISSING_IN_CODE",
      message: `${cloud.type} "${name}" exists in the architecture but not in the code.`,
      suggestion: "Implement it, or remove it from the Solarch canvas if it is obsolete.",
    });
  }
  for (const node of asIs.nodes) {
    if (codeKeyToCloudId.has(node.key)) continue;
    // EnvironmentVariable: altyapı konfigürasyonu, mimarinin kürasyon eşiğinin altında.
    // Yalnız cloud'un açıkça modellediği env var'lar drift sayılır; kod NODE_ENV/LOG_LEVEL
    // gibi fazladan env var kullansa da bunlar gürültü değildir.
    if (node.kind === "EnvironmentVariable") continue;
    findings.push({
      severity: "warn",
      code: "DRIFT_NODE_NOT_IN_CLOUD",
      message: `${node.kind} "${node.name}" (${node.file}) exists in the code but not in the architecture.`,
      file: node.file,
      suggestion: "Add it to the Solarch canvas so the architecture stays the single source of truth.",
    });
  }

  // Edge farkları — yalnız iki ucu da eşleşen node'lar üzerinde konuşulabilir.
  const cloudIdToCodeKey = new Map<string, string>();
  for (const [codeKey, cloudId] of codeKeyToCloudId) cloudIdToCodeKey.set(cloudId, codeKey);

  const asIsEdgeSet = new Map<string, AsIsEdge>();
  for (const e of asIs.edges) asIsEdgeSet.set(`${e.sourceKey}|${e.kind}|${e.targetKey}`, e);

  const asIsByKey = new Map<string, AsIsNode>();
  for (const n of asIs.nodes) asIsByKey.set(n.key, n);

  // Bir cloud THROWS edge'i (Service -> Exception), koddaki iskelet stub'ın surgical
  // `// throws: X` kontratıyla karşılanır. Stub gövdesi hâlâ NOT_IMPLEMENTED Error atar
  // (iskelet/dolu ayrımı korunur) ama "X fırlatacak" taahhüdü beyan edildiği için
  // mimari taahhüt sahte kod üretmeden doğrulanır.
  const throwsDeclaredInSkeleton = (srcKey: string, tgtKey: string): boolean =>
    !!asIsByKey.get(srcKey)?.surgical?.some((m) => (m.throws ?? []).some((t) => nodeKey("Exception", t) === tgtKey));

  const cloudEdgeSet = new Set<string>();
  const describeCloudNode = (id: string): string => {
    const n = cloudById.get(id);
    if (!n) return id;
    return `${n.type} "${nameOfNode(n.type, n.properties) || n.id}"`;
  };

  for (const edge of toBe.edges) {
    const srcKey = cloudIdToCodeKey.get(edge.sourceNodeId);
    const tgtKey = cloudIdToCodeKey.get(edge.targetNodeId);
    if (srcKey && tgtKey) cloudEdgeSet.add(`${srcKey}|${edge.kind}|${tgtKey}`);
  }

  // Alan-düzeyi referans = edge taahhüdü. Cloud bir DTO/Table alanında EnumRef taşıyorsa
  // kod bunu USES->Enum ile, NestedDTORef taşıyorsa HAS->DTO ile gerçekleştirir; cloud'da
  // edge çizilmemiş olsa da alan taahhüdü karşılar (EDGE_KIND_SUBSUMES'in alan-düzeyi hâli).
  const addFieldDerivedEdge = (srcKey: string, refKind: NodeKind, edgeKind: EdgeKind, ref: unknown): void => {
    if (typeof ref !== "string" || !ref) return;
    const refCloud = cloudByKey.get(nodeKey(refKind, ref));
    const tgtKey = refCloud && cloudIdToCodeKey.get(refCloud.id);
    if (tgtKey) cloudEdgeSet.add(`${srcKey}|${edgeKind}|${tgtKey}`);
  };
  for (const cloud of toBe.nodes) {
    const srcKey = cloudIdToCodeKey.get(cloud.id);
    if (!srcKey) continue;
    const listField = cloud.type === "DTO" ? "Fields" : cloud.type === "Table" ? "Columns" : null;
    if (!listField) continue;
    const items = (cloud.properties as Record<string, unknown>)[listField];
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const field = it as Record<string, unknown>;
      addFieldDerivedEdge(srcKey, "Enum", "USES", field.EnumRef);
      if (cloud.type === "DTO") addFieldDerivedEdge(srcKey, "DTO", "HAS", field.NestedDTORef);
    }
  }

  // Nested-DTO geçişliliği: cloud Controller/Service -USES-> DtoX, kodda kaynak DtoP'yi
  // (USES/RETURNS) kullanıp DtoP -HAS-> ... -> DtoX zinciriyle DtoX'e ulaşıyorsa karşılanır.
  // (OrderController OrderCreateRequest'i kullanır; o da OrderItemRequest'i nest'ler.)
  const directDtoTargets = new Map<string, Set<string>>();
  const hasChildren = new Map<string, Set<string>>();
  for (const e of asIs.edges) {
    if ((e.kind === "USES" || e.kind === "RETURNS") && e.targetKey.startsWith("DTO:")) {
      (directDtoTargets.get(e.sourceKey) ?? directDtoTargets.set(e.sourceKey, new Set()).get(e.sourceKey)!).add(e.targetKey);
    }
    if (e.kind === "HAS") {
      (hasChildren.get(e.sourceKey) ?? hasChildren.set(e.sourceKey, new Set()).get(e.sourceKey)!).add(e.targetKey);
    }
  }
  const usesSatisfiedViaNesting = (srcKey: string, tgtKey: string): boolean => {
    if (!tgtKey.startsWith("DTO:")) return false;
    const start = directDtoTargets.get(srcKey);
    if (!start) return false;
    const seen = new Set(start);
    const queue = [...start];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === tgtKey) return true;
      for (const child of hasChildren.get(cur) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    return false;
  };

  // `push --prune`: iki ucu da eşleşen ama kodda karşılığı olmayan cloud edge'leri
  // (kaldırılmış bağımlılıklar). Bu döngü zaten yalnız iki-ucu-eşleşen edge'leri
  // değerlendirdiğinden, silinen node'lara değen edge'ler buraya hiç girmez
  // (onları node DETACH temizler) — küme kendiliğinden ayrık.
  const removableEdges: CloudEdge[] = [];
  for (const edge of toBe.edges) {
    const srcKey = cloudIdToCodeKey.get(edge.sourceNodeId);
    const tgtKey = cloudIdToCodeKey.get(edge.targetNodeId);
    if (!srcKey || !tgtKey) continue; // ucu eksikse node bulgusu zaten verildi
    const satisfiedInCode =
      codeKindsSatisfying(edge.kind).some((k) => asIsEdgeSet.has(`${srcKey}|${k}|${tgtKey}`)) ||
      // Global middleware joker'i: forRoutes("*") o kaynaktan tüm controller'lara routes_to taahhüdünü karşılar.
      (edge.kind === "ROUTES_TO" && asIsEdgeSet.has(`${srcKey}|ROUTES_TO|${WILDCARD_CONTROLLER_KEY}`)) ||
      // İskelet stub'ın surgical `throws:` kontratı THROWS taahhüdünü karşılar.
      (edge.kind === "THROWS" && throwsDeclaredInSkeleton(srcKey, tgtKey)) ||
      // Controller/Service nested DTO'yu, dıştaki DTO'yu kullanıp nesting üstünden karşılar.
      (edge.kind === "USES" && usesSatisfiedViaNesting(srcKey, tgtKey)) ||
      // Merkezi config okuması joker'i: process.env.X merkezde okunduğunda, herhangi bir
      // Service READS_CONFIG X taahhüdü karşılanır (servisler ConfigService inject eder).
      (edge.kind === "READS_CONFIG" && asIsEdgeSet.has(`${WILDCARD_SERVICE_KEY}|READS_CONFIG|${tgtKey}`));
    if (!satisfiedInCode) {
      removableEdges.push(edge);
      findings.push({
        severity: "error",
        code: "DRIFT_EDGE_MISSING_IN_CODE",
        message: `${describeCloudNode(edge.sourceNodeId)} -[${edge.kind}]-> ${describeCloudNode(edge.targetNodeId)} is in the architecture but not implemented in code.`,
        suggestion: "Wire this dependency in the code (constructor injection / call), or remove the edge from the canvas.",
      });
    }
  }

  const kindOfKey = (key: string): NodeKind => key.split(":")[0] as NodeKind;

  for (const edge of asIs.edges) {
    const bothMatched = codeKeyToCloudId.has(edge.sourceKey) && codeKeyToCloudId.has(edge.targetKey);
    const inCloud = cloudKindsCovering(edge.kind).some((k) =>
      cloudEdgeSet.has(`${edge.sourceKey}|${k}|${edge.targetKey}`),
    );

    // Legalite — cloud'da olsun olmasın koddaki her edge kurala uymalı.
    if (rules) {
      const verdict = evaluateEdge(rules, kindOfKey(edge.sourceKey), edge.kind, kindOfKey(edge.targetKey));
      if (!verdict.allowed) {
        findings.push({
          severity: "error",
          code: "DRIFT_ILLEGAL_EDGE",
          message: `${edge.key} (${edge.file}: ${edge.reason}) — ${verdict.message}`,
          file: edge.file,
          suggestion: verdict.suggestion,
        });
        continue; // illegal edge için ayrıca "not in cloud" uyarısı gürültü olur
      }
    }

    if (bothMatched && !inCloud) {
      findings.push({
        severity: "warn",
        code: "DRIFT_EDGE_NOT_IN_CLOUD",
        message: `${edge.key} (${edge.file}: ${edge.reason}) exists in the code but not in the architecture.`,
        file: edge.file,
        suggestion: "Add this connection on the Solarch canvas to keep the diagram truthful.",
      });
    }
  }

  // Property seviyesi (info) — eşleşen node çiftlerinde.
  for (const [codeKey, cloudId] of codeKeyToCloudId) {
    const asIsNode = asIs.nodes.find((n) => n.key === codeKey);
    const cloudNode = cloudById.get(cloudId);
    if (!asIsNode || !cloudNode) continue;
    for (const drift of propertyDrift(asIsNode, cloudNode)) {
      findings.push({
        severity: "info",
        code: "DRIFT_PROPERTY",
        message: `${asIsNode.kind} "${asIsNode.name}": ${drift}`,
        file: asIsNode.file,
      });
    }
  }

  const counts = {
    errors: findings.filter((f) => f.severity === "error").length,
    warns: findings.filter((f) => f.severity === "warn").length,
    infos: findings.filter((f) => f.severity === "info").length,
  };

  // `push --prune`: önceki taramada eşleşmiş (cache'te id'si olan) ama bu sefer
  // eşleşmeyen, cloud'da hâlâ yaşayan node'lar = koddan silindiği KESİN olanlar.
  // matchedCloudIds testi rename'i dışlar (rename'de aynı id yeni anahtarla
  // yeniden eşleşir → matchedCloudIds'de olur → silme adayı sayılmaz).
  const removableNodes: CloudNode[] = [];
  const removableSeen = new Set<string>();
  for (const cloudId of Object.values(previousCache)) {
    if (removableSeen.has(cloudId)) continue;
    if (matchedCloudIds.has(cloudId)) continue;
    const cloudNode = cloudById.get(cloudId);
    if (!cloudNode) continue; // cloud'dan zaten gitmiş
    removableSeen.add(cloudId);
    removableNodes.push(cloudNode);
  }

  return {
    findings,
    matched: codeKeyToCloudId.size,
    counts,
    cache,
    removable: { nodes: removableNodes, edges: removableEdges },
  };
}
