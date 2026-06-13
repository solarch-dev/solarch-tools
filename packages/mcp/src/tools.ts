/** MCP araç gövdeleri — saf fonksiyonlar (transport bilmez, test edilebilir).
 *
 *  Tasarım sözleşmesi (SOLARCH 2.0 Faz 3):
 *  - Okuma araçları ajana halüsinasyon panzehiri verir: gerçek graf + gerçek kurallar.
 *  - Mutasyon araçları CLI push ile AYNI motordan geçer: evaluateEdge ön-kontrolü,
 *    graph/apply + baseRevision, Rules Engine sunucu tarafında son söz sahibi.
 *  - check_drift ReAct self-correction halkasıdır: ajan kodu yazar → drift'e bakar →
 *    ihlal varsa düzeltir. Çıktı, LLM'in işleyebileceği yapısal bulgulardır. */

import {
  nameOfNode,
  runBinding,
  type EdgeKind,
  type NodeKind,
} from "@solarch/ast-core";
import {
  diffGraphs,
  evaluateEdge,
  readMatchCache,
  runScan,
  writeMatchCache,
  type ApplyEdge,
  type ApplyResult,
  type CloudGraph,
  type DriftFinding,
  type RuleCatalog,
} from "@solarch/cli/lib";
import type { ToolContext } from "./context.js";

/* ── get_architecture ────────────────────────────────────────────── */

export interface ArchitectureView {
  project: { id: string; name: string };
  graphRevision: number;
  nodes: { id: string; type: NodeKind; name: string; properties: Record<string, unknown> }[];
  edges: { kind: EdgeKind; source: string; target: string; sourceId: string; targetId: string }[];
  counts: { nodes: number; edges: number };
}

/** To-Be grafını ajan-dostu biçimde döndür: edge uçları isimle anlatılır
 *  (LLM UUID değil isim üzerinden akıl yürütür), id'ler mutasyon için durur. */
export async function getArchitecture(ctx: ToolContext): Promise<ArchitectureView> {
  const graph = await ctx.api.getGraph(ctx.projectId);
  const nameOf = new Map<string, string>();
  for (const n of graph.nodes) {
    nameOf.set(n.id, `${n.type} "${nameOfNode(n.type, n.properties) || n.id}"`);
  }
  return {
    project: graph.project,
    graphRevision: graph.graphRevision,
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      name: nameOfNode(n.type, n.properties) || n.id,
      properties: n.properties,
    })),
    edges: graph.edges.map((e) => ({
      kind: e.kind,
      source: nameOf.get(e.sourceNodeId) ?? e.sourceNodeId,
      target: nameOf.get(e.targetNodeId) ?? e.targetNodeId,
      sourceId: e.sourceNodeId,
      targetId: e.targetNodeId,
    })),
    counts: graph.counts,
  };
}

/* ── get_rules ───────────────────────────────────────────────────── */

/** Kurallar Matrisi olduğu gibi + ajan için kullanım notu. */
export async function getRules(ctx: ToolContext): Promise<RuleCatalog & { note: string }> {
  const rules = await ctx.api.getRules();
  return {
    ...rules,
    note:
      "Default deny: an edge is legal ONLY if it matches a whitelist entry and no blacklist entry. " +
      "Check edges against this catalog BEFORE writing code that wires two components together.",
  };
}

/* ── check_drift ─────────────────────────────────────────────────── */

export interface DriftReport {
  clean: boolean;
  counts: { errors: number; warns: number; infos: number };
  matched: number;
  findings: DriftFinding[];
  verdict: string;
}

/** Kodu tara, cloud ile karşılaştır, bulguları yapısal döndür.
 *  CLI `solarch diff` ile aynı motor + aynı map.json cache güncellemesi. */
export async function checkDrift(ctx: ToolContext): Promise<DriftReport> {
  const [graph, rules] = await Promise.all([ctx.api.getGraph(ctx.projectId), ctx.api.getRules()]);
  const asIs = runScan(ctx.rootDir);
  const result = diffGraphs(asIs, graph, rules, readMatchCache(ctx.rootDir));
  writeMatchCache(ctx.rootDir, result.cache);

  const clean = result.counts.errors === 0;
  return {
    clean,
    counts: result.counts,
    matched: result.matched,
    findings: result.findings,
    verdict: clean
      ? "No architecture violations. Safe to proceed."
      : `${result.counts.errors} error-level finding(s). Fix these BEFORE finishing: ` +
        "illegal edges must be removed from code; missing nodes/edges must be implemented or removed from the canvas.",
  };
}

/* ── create_node_safely ──────────────────────────────────────────── */

export interface CreateNodeInput {
  type: NodeKind;
  properties: Record<string, unknown>;
  /** Yeni node'un mevcut node'lara bağları (opsiyonel). */
  edges?: { kind: EdgeKind; direction: "outgoing" | "incoming"; nodeId: string }[];
}

export type CreateNodeResult =
  | { created: true; nodeId: string; graphRevision: number; edgeCount: number }
  | { created: false; reason: string; violations: { code: string; message: string; suggestion?: string }[] };

/** Yeni node'u önce lokal kural ön-kontrolünden, sonra sunucudaki Rules Engine'den
 *  geçirip atomik yazar. CLI push ile aynı yol: graph/apply + baseRevision —
 *  ajan asla kural-dışı bir şey commit'leyemez. */
export async function createNodeSafely(ctx: ToolContext, input: CreateNodeInput): Promise<CreateNodeResult> {
  const [graph, rules] = await Promise.all([ctx.api.getGraph(ctx.projectId), ctx.api.getRules()]);

  // Lokal ön-kontrol: hedef node'lar var mı, edge'ler legal mi? Sunucu zaten
  // reddederdi ama burada yakalamak ajana tek turda net gerekçe verir.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const violations: { code: string; message: string; suggestion?: string }[] = [];
  for (const e of input.edges ?? []) {
    const other = byId.get(e.nodeId);
    if (!other) {
      violations.push({
        code: "ERR_EDGE_NODE_NOT_FOUND",
        message: `Node ${e.nodeId} does not exist in the project graph.`,
        suggestion: "Call get_architecture and use a real node id.",
      });
      continue;
    }
    const [source, target] =
      e.direction === "outgoing" ? [input.type, other.type] : [other.type, input.type];
    const verdict = evaluateEdge(rules, source, e.kind, target);
    if (!verdict.allowed) {
      violations.push({
        code: "ERR_RULE_VIOLATION",
        message: `${source} -[${e.kind}]-> ${target}: ${verdict.message ?? "not allowed"}`,
        suggestion: verdict.suggestion,
      });
    }
  }
  if (violations.length > 0) {
    return { created: false, reason: "Pre-check failed — nothing was written.", violations };
  }

  const tempId = "t_new";
  const edges: ApplyEdge[] = (input.edges ?? []).map((e) =>
    e.direction === "outgoing"
      ? { sourceTempId: tempId, targetId: e.nodeId, edgeType: e.kind }
      : { sourceId: e.nodeId, targetTempId: tempId, edgeType: e.kind },
  );

  const result: ApplyResult = await ctx.api.applyGraph(ctx.projectId, {
    baseRevision: graph.graphRevision,
    mutations: { nodes: [{ tempId, type: input.type, properties: input.properties }], edges },
  });

  if (!result.success) {
    return {
      created: false,
      reason: result.message,
      violations: result.violations.map((v) => ({ code: v.code, message: v.message, suggestion: v.suggestion })),
    };
  }
  const nodeId = result.idMap[tempId];
  if (!nodeId) throw new Error("Server did not return an id for the new node.");
  return { created: true, nodeId, graphRevision: result.graphRevision, edgeCount: result.edgeCount };
}

/* ── sync_properties ─────────────────────────────────────────────── */

export interface SyncPropertiesInput {
  /** "src/users/user.entity.ts#User" */
  source: string;
  /** "src/users/create-user.dto.ts#CreateUserDto" */
  target: string;
  /** Alan adları; verilmezse tümü. */
  fields?: string[];
}

export interface SyncPropertiesResult {
  targetFile: string;
  added: string[];
  conflicts: { property: string; reason: string }[];
  upToDate: boolean;
  summary: string;
}

/** ast-core live binding: kaynaktan hedefe güvenli property enjeksiyonu.
 *  Yalnız property bildirimi ekler; metodlara ve elle yazılmış alanlara dokunmaz. */
export function syncPropertiesTool(ctx: ToolContext, input: SyncPropertiesInput): SyncPropertiesResult {
  const outcome = runBinding(ctx.rootDir, input.source, input.target, input.fields ?? "all");
  const summary =
    outcome.added.length > 0
      ? `Added ${outcome.added.length} propert${outcome.added.length === 1 ? "y" : "ies"} to ${outcome.targetFile}: ${outcome.added.join(", ")}.`
      : outcome.conflicts.length > 0
        ? `No properties added — ${outcome.conflicts.length} conflict(s). Existing properties are never overwritten.`
        : `${outcome.targetFile} is already in sync.`;
  return {
    targetFile: outcome.targetFile,
    added: outcome.added,
    conflicts: outcome.conflicts,
    upToDate: outcome.added.length === 0 && outcome.conflicts.length === 0,
    summary,
  };
}

/* ── get_unimplemented ───────────────────────────────────────────── */

export interface UnimplementedRegion {
  /** Diyagram node'unun kalıcı UUID'si (işaretten — kesin bağ). */
  nodeId: string;
  className: string;
  member: string;
  file: string;
  line: number;
  /** Doldururken uyulacak iş talimatı (codegen'in bıraktığı açıklama). */
  description?: string;
  /** Fırlatması beklenen Exception'lar. */
  throws?: string[];
  /** Kullanabileceği bağımlılıklar (DI alanları). */
  deps?: string[];
}

export interface ContractViolationReport {
  className: string;
  member: string;
  file: string;
  line: number;
  messages: string[];
}

export interface UnimplementedReport {
  totalMarked: number;
  implemented: number;
  remaining: UnimplementedRegion[];
  /** Dolu ama sözleşmeye aykırı bölgeler — ajan bunları da düzeltmeli. */
  violations: ContractViolationReport[];
  guidance: string;
}

/** Cerrahi AI'ın iş kuyruğu: doldurulmamış işaretli bölgeleri talimatlarıyla
 *  döndürür. Ajan akışı: get_unimplemented → bölgeyi doldur (imza bırak) →
 *  check_drift. Tamamen lokal çalışır (API gerekmez) — rootDir yeter. */
export function getUnimplemented(rootDir: string): UnimplementedReport {
  const asIs = runScan(rootDir);
  let totalMarked = 0;
  const remaining: UnimplementedRegion[] = [];
  const violations: ContractViolationReport[] = [];
  for (const node of asIs.nodes) {
    for (const m of node.surgical ?? []) {
      totalMarked += 1;
      if (m.violations && m.violations.length > 0) {
        violations.push({ className: node.name, member: m.member, file: node.file, line: m.line, messages: m.violations });
      }
      if (m.status !== "skeleton") continue;
      remaining.push({
        nodeId: m.nodeId,
        className: node.name,
        member: m.member,
        file: node.file,
        line: m.line,
        description: m.description,
        throws: m.throws,
        deps: m.deps,
      });
    }
  }

  const fillRules =
    "Fill ONLY the marked method bodies (replace the NOT_IMPLEMENTED throw). Keep the @solarch:surgical " +
    "marker comment intact, honor the description, throw only the listed exceptions, and use only the " +
    "listed deps. When you fill a body, add this signature line right after the marker comments: " +
    "`// @solarch:filled by=ai at=<current ISO timestamp>`. After filling, run check_drift to verify " +
    "you did not break the architecture.";

  return {
    totalMarked,
    implemented: totalMarked - remaining.length,
    remaining,
    violations,
    guidance:
      remaining.length === 0 && violations.length === 0
        ? "All surgical regions are implemented and within contract. Nothing to do."
        : violations.length > 0
          ? `FIX THE CONTRACT VIOLATIONS FIRST: a filled body uses dependencies or throws exceptions that were ` +
            `not declared in its marker. Either fix the body, or (if the new dep/throw is genuinely needed) ` +
            `update the architecture first. Then: ${fillRules}`
          : fillRules,
  };
}

/* ── yardımcı: CloudGraph özeti (sunucu loglarında kullanışlı) ────── */

export function describeGraph(graph: CloudGraph): string {
  return `${graph.project.name}: ${graph.counts.nodes} node(s), ${graph.counts.edges} edge(s), revision ${graph.graphRevision}`;
}
