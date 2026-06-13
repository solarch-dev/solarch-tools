/** Durum motoru — scan + cloud fetch + diff → GraphState.
 *
 *  İki katman:
 *  - `buildGraphState` SAF: As-Is + Cloud + kurallar + diff sonucundan birleşik
 *    görsel graf üretir (testler burayı vurur).
 *  - `StateEngine` kabuk: config/credentials okur, cloud yanıtını cache'ler
 *    (60sn TTL), hataları yönlendirme önerili GraphStateError'a çevirir. */

import { nameOfNode, type AsIsGraph, type NodeKind } from "@solarch/ast-core";
import {
  ApiError,
  SolarchApi,
  diffGraphs,
  evaluateEdge,
  readMatchCache,
  readProjectConfig,
  runScan,
  writeMatchCache,
  type CloudGraph,
  type DiffResult,
  type RuleCatalog,
} from "@solarch/cli/lib";
import {
  familyOf,
  type GraphState,
  type GraphStateOk,
  type ImplementationState,
  type StateEdge,
  type StateNode,
} from "./shared.js";

/** Codegen işaretlerinden implementasyon panosu çıkar. */
function buildImplementation(asIs: AsIsGraph): ImplementationState {
  let total = 0;
  let filled = 0;
  const skeletons: ImplementationState["skeletons"] = [];
  for (const node of asIs.nodes) {
    for (const m of node.surgical ?? []) {
      total += 1;
      if (m.status === "filled") {
        filled += 1;
      } else {
        skeletons.push({
          className: node.name,
          member: m.member,
          file: node.file,
          line: m.line,
          description: m.description,
        });
      }
    }
  }
  return { total, filled, skeletons };
}

/* ── saf birleştirme ─────────────────────────────────────────────── */

/** Cloud + As-Is grafını diff'in eşleştirme cache'i üzerinden tek görsel grafta
 *  birleştirir. Kimlikler: eşleşen/cloud node'lar cloud id, yalnız-kod node'ları
 *  kod key'i taşır. */
export function buildGraphState(
  asIs: AsIsGraph,
  cloud: CloudGraph,
  rules: RuleCatalog | null,
  diff: DiffResult,
): GraphStateOk {
  const codeKeyToCloudId = new Map(Object.entries(diff.cache));
  const cloudIdToCodeKey = new Map([...codeKeyToCloudId].map(([k, v]) => [v, k]));
  const asIsByKey = new Map(asIs.nodes.map((n) => [n.key, n]));

  const nodes: StateNode[] = [];
  for (const c of cloud.nodes) {
    const codeKey = cloudIdToCodeKey.get(c.id);
    const asIsNode = codeKey ? asIsByKey.get(codeKey) : undefined;
    nodes.push({
      id: c.id,
      type: c.type,
      name: nameOfNode(c.type, c.properties) || c.id,
      family: familyOf(c.type),
      status: codeKey ? "synced" : "cloudOnly",
      file: asIsNode?.file,
    });
  }
  for (const n of asIs.nodes) {
    if (codeKeyToCloudId.has(n.key)) continue;
    nodes.push({
      id: n.key,
      type: n.kind,
      name: n.name,
      family: familyOf(n.kind),
      status: "codeOnly",
      file: n.file,
    });
  }

  // Görsel node id'si: cloud id ya da (eşleşmemişse) kod key'i.
  const visualId = (codeKey: string): string => codeKeyToCloudId.get(codeKey) ?? codeKey;

  const asIsEdgeSet = new Set(asIs.edges.map((e) => `${e.sourceKey}|${e.kind}|${e.targetKey}`));
  const cloudEdgeSet = new Set<string>();
  for (const e of cloud.edges) {
    const srcKey = cloudIdToCodeKey.get(e.sourceNodeId);
    const tgtKey = cloudIdToCodeKey.get(e.targetNodeId);
    if (srcKey && tgtKey) cloudEdgeSet.add(`${srcKey}|${e.kind}|${tgtKey}`);
  }

  const edges: StateEdge[] = [];
  const seen = new Set<string>();
  for (const e of cloud.edges) {
    const srcKey = cloudIdToCodeKey.get(e.sourceNodeId);
    const tgtKey = cloudIdToCodeKey.get(e.targetNodeId);
    const inCode = srcKey && tgtKey ? asIsEdgeSet.has(`${srcKey}|${e.kind}|${tgtKey}`) : false;
    const id = `${e.sourceNodeId}|${e.kind}|${e.targetNodeId}`;
    seen.add(id);
    edges.push({ id, kind: e.kind, source: e.sourceNodeId, target: e.targetNodeId, status: inCode ? "synced" : "cloudOnly" });
  }
  for (const e of asIs.edges) {
    const srcKey = e.sourceKey;
    const tgtKey = e.targetKey;
    const id = `${visualId(srcKey)}|${e.kind}|${visualId(tgtKey)}`;
    if (seen.has(id)) continue; // cloud'da zaten çizildi (synced)
    // Cloud'da olmayan kod edge'i — legal mi?
    const kindOfKey = (key: string): NodeKind => (key.split(":")[0] ?? "") as NodeKind;
    const verdict = rules
      ? evaluateEdge(rules, kindOfKey(srcKey), e.kind, kindOfKey(tgtKey))
      : { allowed: true as const };
    edges.push({
      id,
      kind: e.kind,
      source: visualId(srcKey),
      target: visualId(tgtKey),
      status: verdict.allowed ? "codeOnly" : "illegal",
      file: e.file,
      note: verdict.allowed ? undefined : verdict.message,
    });
  }

  return {
    ok: true,
    projectName: cloud.project.name,
    graphRevision: cloud.graphRevision,
    nodes,
    edges,
    findings: diff.findings.map((f) => ({
      severity: f.severity,
      code: f.code,
      message: f.message,
      file: f.file,
      suggestion: f.suggestion,
    })),
    counts: diff.counts,
    implementation: buildImplementation(asIs),
    generatedAt: new Date().toISOString(),
  };
}

/* ── kabuk: cache'li yenileme döngüsü ────────────────────────────── */

const CLOUD_TTL_MS = 60_000;

export class StateEngine {
  private cloud: CloudGraph | null = null;
  private rules: RuleCatalog | null = null;
  private cloudFetchedAt = 0;

  constructor(private readonly rootDir: string) {}

  /** Tam yenileme. `forceCloud` panel açılışı / manuel refresh içindir;
   *  kayıt-tetiklemeli çağrılar TTL içinde cloud'u yeniden çekmez. */
  async refresh(opts: { forceCloud?: boolean } = {}): Promise<GraphState> {
    // Önce kimlik (login butonu), sonra proje bağı (link butonu) — welcome
    // ekranı kullanıcıyı bu sırayla yönlendirir.
    let api: SolarchApi;
    try {
      api = SolarchApi.fromStoredCredentials();
    } catch (e) {
      return {
        ok: false,
        reason: "notLoggedIn",
        message: (e as Error).message,
        suggestion: "Sign in with an API key from Solarch → Settings → API Keys.",
      };
    }

    const config = readProjectConfig(this.rootDir);
    if (!config?.projectId) {
      return {
        ok: false,
        reason: "notLinked",
        message: "This workspace is not linked to a Solarch project.",
        suggestion: "Link this repository to a Solarch project.",
      };
    }

    const stale = Date.now() - this.cloudFetchedAt > CLOUD_TTL_MS;
    if (opts.forceCloud || stale || !this.cloud) {
      try {
        [this.cloud, this.rules] = await Promise.all([api.getGraph(config.projectId), api.getRules()]);
        this.cloudFetchedAt = Date.now();
      } catch (e) {
        const msg = e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message;
        return {
          ok: false,
          reason: "apiError",
          message: msg,
          suggestion: "Check that the Solarch API is reachable and your API key is still valid.",
        };
      }
    }

    let asIs: AsIsGraph;
    try {
      asIs = runScan(this.rootDir);
    } catch (e) {
      return {
        ok: false,
        reason: "scanError",
        message: (e as Error).message,
        suggestion: "Make sure the workspace root contains a valid TypeScript project (tsconfig.json).",
      };
    }

    const diff = diffGraphs(asIs, this.cloud, this.rules, readMatchCache(this.rootDir));
    writeMatchCache(this.rootDir, diff.cache);
    return buildGraphState(asIs, this.cloud, this.rules, diff);
  }
}
