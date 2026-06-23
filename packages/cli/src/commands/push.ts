/** solarch push — writes code-side delta (new nodes/edges + list-property diffs)
 *  to Solarch Cloud.
 *
 *  Flow: fresh graph (revision R) → diff → show plan → confirm → single graph/apply
 *  (baseRevision=R). On 409 revision conflict: automatic re-pull + re-plan + one
 *  retry. Property updates via PATCH + expectedVersion; on node conflict
 *  interactive choice (keep cloud / write code / skip), no TTY → auto skip + report.
 *  Push is fully rejected when illegal edges exist. */

import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { nameOfNode } from "@solarch/ast-core";
import { ApiError, SolarchApi, type CloudEdge, type CloudGraph, type CloudNode, type RuleCatalog } from "../api.js";
import { readMatchCache, readProjectConfig, writeMatchCache } from "../config.js";
import { diffGraphs } from "../diff/engine.js";
import {
  buildPushPlan,
  planIsEmpty,
  toApplyPayload,
  type PushPlan,
  type PropertyUpdate,
} from "../push/planner.js";
import { runScan } from "./scan.js";

export interface PushOptions {
  rootDir: string;
  /** Onay sorma (CI). */
  yes?: boolean;
  /** Koddan silinen node/edge'leri cloud'dan da kaldır (yıkıcı — onaylı). */
  prune?: boolean;
}

const EMPTY_REMOVALS: { nodes: CloudNode[]; edges: CloudEdge[] } = { nodes: [], edges: [] };

const planHasAdds = (p: PushPlan): boolean => p.newNodes.length > 0 || p.newEdges.length > 0;

export async function pushCommand(opts: PushOptions): Promise<void> {
  const config = readProjectConfig(opts.rootDir);
  if (!config?.projectId) {
    console.error(pc.red("No linked project. Run `solarch link` first."));
    process.exitCode = 1;
    return;
  }
  const projectId = config.projectId;
  const api = SolarchApi.fromStoredCredentials();

  // 1. Fresh To-Be (revision R) + rules + As-Is.
  const [toBe, rules] = await Promise.all([api.getGraph(projectId), api.getRules()]);
  const asIs = runScan(opts.rootDir);

  // 2. Diff → update match cache → plan.
  const previousCache = readMatchCache(opts.rootDir);
  const diff = diffGraphs(asIs, toBe, rules, previousCache);
  writeMatchCache(opts.rootDir, diff.cache);
  // --prune: silme adaylarını İLK diff'ten sabitle. 409-retry yolunda map.json bu
  // noktada zaten silinen anahtarı düşürdüğü için replan onları yeniden bulamaz;
  // silmeler revizyondan bağımsız (ayrı DELETE çağrıları) olduğundan taşımak güvenli.
  const removals = opts.prune ? diff.removable : EMPTY_REMOVALS;
  let plan = buildPushPlan(asIs, toBe, rules, diff.cache, removals);

  // Illegal edges are NEVER pushed — errors printed, push refused.
  if (plan.illegalEdges.length > 0) {
    console.error(pc.red(pc.bold(`Push refused — ${plan.illegalEdges.length} illegal edge(s) in the code:`)));
    for (const ill of plan.illegalEdges) {
      console.error(pc.red(`  ✗ ${ill.edge.key} (${ill.edge.file}) — ${ill.message}`));
      if (ill.suggestion) console.error(pc.dim(`    → ${ill.suggestion}`));
    }
    process.exitCode = 1;
    return;
  }

  if (planIsEmpty(plan)) {
    console.log(pc.green("Already in sync — nothing to push."));
    // Silinmiş öğe var ama --prune verilmediyse doğru komutu hatırlat (additif push
    // bunlara dokunmaz; silme yıkıcı olduğu için opt-in).
    if (!opts.prune) {
      const n = diff.removable.nodes.length;
      const e = diff.removable.edges.length;
      if (n + e > 0) {
        console.log(
          pc.dim(
            `  ${n} node(s) and ${e} edge(s) were removed from the code — run \`solarch push --prune\` to delete them from the canvas too.`,
          ),
        );
      }
    }
    return;
  }

  // 3. Show plan + confirm.
  renderPlan(plan, toBe);
  const destructive = plan.nodesToRemove.length > 0 || plan.edgesToRemove.length > 0;
  if (!opts.yes) {
    const ok = await confirm(destructive ? "Push these changes (includes deletions)?" : "Push these changes?");
    if (!ok) {
      console.log(pc.dim("Aborted — nothing pushed."));
      return;
    }
  }

  // 4. Adds — single graph/apply (baseRevision=R); on 409 re-pull + one retry.
  let baseRevision = toBe.graphRevision;
  if (plan.newNodes.length > 0 || plan.newEdges.length > 0) {
    let applied = false;
    for (let attempt = 1; attempt <= 2 && !applied; attempt++) {
      try {
        const result = await api.applyGraph(projectId, toApplyPayload(plan, baseRevision));
        if (!result.success) {
          console.error(pc.red(pc.bold("Push rolled back by the Rules Engine:")));
          for (const v of result.violations) {
            console.error(pc.red(`  ✗ [${v.code}] ${v.message}`));
            if (v.suggestion) console.error(pc.dim(`    → ${v.suggestion}`));
          }
          process.exitCode = 1;
          return;
        }
        // idMap → map.json: new nodes are matched immediately.
        const cache = readMatchCache(opts.rootDir);
        for (const [key, tempId] of Object.entries(plan.tempIdByKey)) {
          const cloudId = result.idMap[tempId];
          if (cloudId) cache[key] = cloudId;
        }
        writeMatchCache(opts.rootDir, cache);
        baseRevision = result.graphRevision;
        console.log(
          pc.green(`✓ Added ${result.nodeCount} node(s), ${result.edgeCount} edge(s) — revision ${result.graphRevision}.`),
        );
        applied = true;
      } catch (e) {
        if (e instanceof ApiError && e.code === "ERR_GRAPH_REVISION_CONFLICT" && attempt === 1) {
          console.log(pc.yellow("Graph changed on the cloud since the plan was computed — re-pulling and retrying once..."));
          const { toBe: freshToBe, plan: freshPlan } = await replan(api, projectId, opts.rootDir, rules, removals);
          if (freshPlan.illegalEdges.length > 0) {
            console.error(pc.red("After re-pull the plan contains illegal edges — push refused."));
            process.exitCode = 1;
            return;
          }
          plan = freshPlan;
          baseRevision = freshToBe.graphRevision;
          // Yeni eklenecek bir şey kalmadıysa apply'ı atla — property/silme adımları
          // yine de çalışır (silmeler graph/apply kullanmaz).
          if (!planHasAdds(freshPlan)) {
            console.log(pc.green("After re-pull there is nothing left to add — continuing."));
            applied = true;
          }
          continue;
        }
        if (e instanceof ApiError && e.code === "ERR_GRAPH_REVISION_CONFLICT") {
          console.error(pc.red("The cloud graph keeps changing (revision conflict twice). Re-run `solarch push` when things settle."));
          process.exitCode = 1;
          return;
        }
        throw e;
      }
    }
  }

  // 5. Property updates — PATCH + expectedVersion, interactive on conflict.
  if (plan.propertyUpdates.length > 0) {
    const { updated, skipped } = await applyPropertyUpdates(api, projectId, plan.propertyUpdates, opts.yes ?? false);
    console.log(pc.green(`✓ Updated properties on ${updated} node(s)${skipped > 0 ? pc.yellow(` (${skipped} skipped)`) : ""}.`));
  }

  // 6. Removals (--prune) — additif adımlardan SONRA, tek tek DELETE. Önce edge'ler
  //    (yaşayan node'lar arası), sonra node'lar (DETACH kendi edge'lerini de siler).
  if (plan.edgesToRemove.length > 0 || plan.nodesToRemove.length > 0) {
    const { removed, missing } = await applyRemovals(api, projectId, plan);
    console.log(
      pc.green(`✓ Removed ${removed} item(s) from the canvas`) +
        (missing > 0 ? pc.dim(` (${missing} already gone)`) : "") +
        ".",
    );
  }

  console.log(pc.bold(pc.green("Push complete.")));
}

/* ── helpers ─────────────────────────────────────────────────────── */

async function replan(
  api: SolarchApi,
  projectId: string,
  rootDir: string,
  rules: RuleCatalog | null,
  removals: { nodes: CloudNode[]; edges: CloudEdge[] },
): Promise<{ toBe: CloudGraph; plan: PushPlan }> {
  const toBe = await api.getGraph(projectId);
  const asIs = runScan(rootDir);
  const diff = diffGraphs(asIs, toBe, rules, readMatchCache(rootDir));
  writeMatchCache(rootDir, diff.cache);
  return { toBe, plan: buildPushPlan(asIs, toBe, rules, diff.cache, removals) };
}

function renderPlan(plan: PushPlan, toBe: CloudGraph): void {
  const labelOf = new Map<string, string>();
  for (const n of toBe.nodes) labelOf.set(n.id, `${n.type} "${nameOfNode(n.type, n.properties) || n.id}"`);
  const describe = (id: string): string => labelOf.get(id) ?? id;

  console.log(pc.bold(`Push plan (against revision ${toBe.graphRevision}):`));
  if (plan.newNodes.length > 0) {
    console.log(pc.bold(`  Nodes to add (${plan.newNodes.length}):`));
    for (const n of plan.newNodes) console.log(pc.green(`    + ${n.kind} "${n.name}" ${pc.dim(`(${n.file})`)}`));
  }
  if (plan.newEdges.length > 0) {
    console.log(pc.bold(`  Edges to add (${plan.newEdges.length}):`));
    for (const e of plan.newEdges) console.log(pc.green(`    + ${e.edge.key} ${pc.dim(`(${e.edge.reason})`)}`));
  }
  if (plan.propertyUpdates.length > 0) {
    console.log(pc.bold(`  Property updates (${plan.propertyUpdates.length}) — code wins on list fields:`));
    for (const u of plan.propertyUpdates) {
      console.log(pc.cyan(`    ~ ${u.kind} "${u.name}" → ${u.changedFields.join(", ")}`));
    }
  }
  if (plan.edgesToRemove.length > 0) {
    console.log(pc.bold(pc.red(`  Edges to remove from the canvas (${plan.edgesToRemove.length}) — the dependency is gone from the code:`)));
    for (const e of plan.edgesToRemove) {
      console.log(pc.red(`    - ${describe(e.sourceNodeId)} -[${e.kind}]-> ${describe(e.targetNodeId)}`));
    }
  }
  if (plan.nodesToRemove.length > 0) {
    console.log(pc.bold(pc.red(`  Nodes to remove from the canvas (${plan.nodesToRemove.length}) — deleted from the code:`)));
    for (const n of plan.nodesToRemove) {
      console.log(pc.red(`    - ${n.type} "${nameOfNode(n.type, n.properties) || n.id}" ${pc.dim("(and its edges)")}`));
    }
  }
  console.log("");
}

/** 404 / not-found → öğe cloud'da zaten yok (canvas'tan elle silinmiş). Yıkıcı
 *  silmeyi idempotent kılar: "zaten gitmiş" hatayı patlatmaz, sayar. */
function isAlreadyGone(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    (e.status === 404 || e.code === "ERR_NODE_NOT_FOUND" || e.code === "ERR_EDGE_NOT_FOUND")
  );
}

/** --prune silmeleri: önce bağımsız edge'ler, sonra node'lar (DETACH). Her DELETE
 *  ayrı çağrı; cloud'da bu arada gitmiş öğe (404) "missing" olarak sayılır. */
async function applyRemovals(
  api: SolarchApi,
  projectId: string,
  plan: PushPlan,
): Promise<{ removed: number; missing: number }> {
  let removed = 0;
  let missing = 0;
  for (const e of plan.edgesToRemove) {
    try {
      await api.deleteEdge(projectId, e.id);
      removed++;
    } catch (err) {
      if (isAlreadyGone(err)) {
        missing++;
        continue;
      }
      throw err;
    }
  }
  for (const n of plan.nodesToRemove) {
    try {
      await api.deleteNode(projectId, n.id);
      removed++;
    } catch (err) {
      if (isAlreadyGone(err)) {
        missing++;
        continue;
      }
      throw err;
    }
  }
  return { removed, missing };
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(pc.yellow("Non-interactive session without --yes — aborting. Pass --yes to push in CI."));
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} (y/N): `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

/** Apply PATCHes in order. On ERR_VERSION_CONFLICT:
 *  TTY → keep cloud / write code / skip; no TTY (CI) → auto skip + report. */
async function applyPropertyUpdates(
  api: SolarchApi,
  projectId: string,
  updates: PropertyUpdate[],
  nonInteractive: boolean,
): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;

  for (const u of updates) {
    try {
      await api.patchNode(projectId, u.cloudId, { properties: u.properties, expectedVersion: u.expectedVersion });
      updated++;
      continue;
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "ERR_VERSION_CONFLICT") throw e;

      if (nonInteractive || !process.stdin.isTTY) {
        console.log(pc.yellow(`  ~ ${u.kind} "${u.name}": modified on the cloud in the meantime — skipped (resolve manually).`));
        skipped++;
        continue;
      }

      const choice = await askConflictChoice(u);
      if (choice === "cloud" || choice === "skip") {
        console.log(pc.dim(`    ${choice === "cloud" ? "Keeping the cloud version." : "Skipped."}`));
        skipped++;
        continue;
      }
      // "code": cloud changed in the meantime — force write with current version.
      const currentVersion = typeof e.details.currentVersion === "number" ? e.details.currentVersion : undefined;
      try {
        await api.patchNode(projectId, u.cloudId, { properties: u.properties, expectedVersion: currentVersion });
        updated++;
      } catch (e2) {
        console.log(pc.red(`    Failed to overwrite ${u.kind} "${u.name}": ${(e2 as Error).message} — skipped.`));
        skipped++;
      }
    }
  }
  return { updated, skipped };
}

async function askConflictChoice(u: PropertyUpdate): Promise<"cloud" | "code" | "skip"> {
  console.log(pc.yellow(`  ! ${u.kind} "${u.name}" was modified on the cloud while you were pushing.`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("    Keep (c)loud / write (k)ode / (s)kip? [c/k/s]: ")).trim().toLowerCase();
  rl.close();
  if (answer === "k" || answer === "kode" || answer === "code") return "code";
  if (answer === "s" || answer === "skip") return "skip";
  return "cloud";
}
