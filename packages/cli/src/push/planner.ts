/** Push planlayıcısı — As-Is (kod) ile To-Be (cloud) arasındaki delta'yı
 *  `graph/apply` payload'ına ve property PATCH listesine çevirir.
 *
 *  Sözleşme (Faz 2 planı):
 *  - Eklenecekler: cloud'da olmayan node'lar + cloud'da olmayan edge'ler.
 *    Edge uçları: yeni node'larda tempId, eşleşen node'larda cloud id.
 *  - Illegal edge'ler (Rules Engine reddi) ASLA pushlanmaz — plana ayrı listede
 *    girer, çağıran error basıp exit 1 yapar.
 *  - Property güncellemeleri: eşleşen node'larda liste-alanlarında kod kaynak
 *    kabul edilir — cloud properties korunur, yalnız liste alanı kodunkiyle
 *    değiştirilir; PATCH expectedVersion ile gider. */

import {
  nameOfNode,
  type AsIsEdge,
  type AsIsGraph,
  type AsIsNode,
  type NodeKind,
} from "@solarch/ast-core";
import type { ApplyEdge, ApplyPayload, CloudGraph, RuleCatalog } from "../api.js";
import type { MatchCache } from "../config.js";
import { evaluateEdge, listFieldDrift } from "../diff/engine.js";

export interface PlannedEdge {
  edge: AsIsEdge;
  source: { tempId?: string; id?: string };
  target: { tempId?: string; id?: string };
}

export interface IllegalEdge {
  edge: AsIsEdge;
  message: string;
  suggestion?: string;
}

export interface PropertyUpdate {
  cloudId: string;
  nodeKey: string;
  kind: NodeKind;
  name: string;
  /** Cloud node'un push planı anındaki versiyonu — PATCH expectedVersion. */
  expectedVersion: number;
  /** Cloud properties + kodun liste alanı (merge edilmiş TAM properties). */
  properties: Record<string, unknown>;
  /** Değiştirilen liste alanı adları (rapor için). */
  changedFields: string[];
}

export interface PushPlan {
  newNodes: AsIsNode[];
  newEdges: PlannedEdge[];
  propertyUpdates: PropertyUpdate[];
  illegalEdges: IllegalEdge[];
  /** Yeni node key → apply tempId (idMap'i map.json'a geri yazmak için). */
  tempIdByKey: Record<string, string>;
}

export function planIsEmpty(plan: PushPlan): boolean {
  return plan.newNodes.length === 0 && plan.newEdges.length === 0 && plan.propertyUpdates.length === 0;
}

const kindOfKey = (key: string): NodeKind => key.split(":")[0] as NodeKind;

/** Node key → deterministik tempId ("Table:users" → "t_table_users"). */
function tempIdOf(key: string): string {
  return `t_${key.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

export function buildPushPlan(
  asIs: AsIsGraph,
  toBe: CloudGraph,
  rules: RuleCatalog | null,
  matched: MatchCache,
): PushPlan {
  // Eşleşme yalnız cloud'da hâlâ yaşayan id'lerle geçerli.
  const cloudById = new Map(toBe.nodes.map((n) => [n.id, n]));
  const matchedKeyToId = new Map<string, string>();
  for (const [key, id] of Object.entries(matched)) {
    if (cloudById.has(id)) matchedKeyToId.set(key, id);
  }

  // 1. Yeni node'lar — kodda var, cloud'da eşleşmesi yok.
  const newNodes = asIs.nodes.filter((n) => !matchedKeyToId.has(n.key));
  const tempIdByKey: Record<string, string> = {};
  for (const n of newNodes) tempIdByKey[n.key] = tempIdOf(n.key);

  // Cloud'daki mevcut edge'ler (eşleşen uçlar üzerinden) — tekrar pushlamayalım.
  const cloudIdToKey = new Map<string, string>();
  for (const [key, id] of matchedKeyToId) cloudIdToKey.set(id, key);
  const cloudEdgeSet = new Set<string>();
  for (const e of toBe.edges) {
    const srcKey = cloudIdToKey.get(e.sourceNodeId);
    const tgtKey = cloudIdToKey.get(e.targetNodeId);
    if (srcKey && tgtKey) cloudEdgeSet.add(`${srcKey}|${e.kind}|${tgtKey}`);
  }

  // 2. Edge'ler — illegal'ler ayrılır, cloud'da olanlar atlanır.
  const newEdges: PlannedEdge[] = [];
  const illegalEdges: IllegalEdge[] = [];
  for (const edge of asIs.edges) {
    if (rules) {
      const verdict = evaluateEdge(rules, kindOfKey(edge.sourceKey), edge.kind, kindOfKey(edge.targetKey));
      if (!verdict.allowed) {
        illegalEdges.push({ edge, message: verdict.message ?? "Rules Engine denied.", suggestion: verdict.suggestion });
        continue;
      }
    }
    if (cloudEdgeSet.has(`${edge.sourceKey}|${edge.kind}|${edge.targetKey}`)) continue;

    const source = resolveEndpoint(edge.sourceKey, matchedKeyToId, tempIdByKey);
    const target = resolveEndpoint(edge.targetKey, matchedKeyToId, tempIdByKey);
    // Uç ne eşleşmiş ne yeni — scan'in üretmediği bir referans; sessizce atla
    // (node bulgusu diff'te zaten raporlanır).
    if (!source || !target) continue;
    newEdges.push({ edge, source, target });
  }

  // 3. Property güncellemeleri — eşleşen çiftlerde liste alanı farkı.
  const asIsByKey = new Map(asIs.nodes.map((n) => [n.key, n]));
  const propertyUpdates: PropertyUpdate[] = [];
  for (const [key, cloudId] of matchedKeyToId) {
    const asIsNode = asIsByKey.get(key);
    const cloudNode = cloudById.get(cloudId);
    if (!asIsNode || !cloudNode) continue;
    const drift = listFieldDrift(asIsNode, cloudNode);
    if (!drift) continue;
    propertyUpdates.push({
      cloudId,
      nodeKey: key,
      kind: asIsNode.kind,
      name: nameOfNode(cloudNode.type, cloudNode.properties) || asIsNode.name,
      expectedVersion: cloudNode.version,
      // Kod kaynak: yalnız liste alanı değişir, kalan cloud property'leri korunur.
      properties: { ...cloudNode.properties, [drift.listField]: asIsNode.properties[drift.listField] ?? [] },
      changedFields: [drift.listField],
    });
  }

  return { newNodes, newEdges, propertyUpdates, illegalEdges, tempIdByKey };
}

function resolveEndpoint(
  key: string,
  matchedKeyToId: Map<string, string>,
  tempIdByKey: Record<string, string>,
): { tempId?: string; id?: string } | null {
  const cloudId = matchedKeyToId.get(key);
  if (cloudId) return { id: cloudId };
  const tempId = tempIdByKey[key];
  if (tempId) return { tempId };
  return null;
}

/** Plan → tek `graph/apply` çağrısının gövdesi. */
export function toApplyPayload(plan: PushPlan, baseRevision: number): ApplyPayload {
  const nodes = plan.newNodes.map((n) => ({
    tempId: plan.tempIdByKey[n.key] ?? tempIdOf(n.key),
    type: n.kind,
    properties: n.properties,
  }));
  const edges: ApplyEdge[] = plan.newEdges.map((e) => ({
    ...(e.source.tempId ? { sourceTempId: e.source.tempId } : { sourceId: e.source.id }),
    ...(e.target.tempId ? { targetTempId: e.target.tempId } : { targetId: e.target.id }),
    edgeType: e.edge.kind,
  }));
  return { baseRevision, mutations: { nodes, edges } };
}
