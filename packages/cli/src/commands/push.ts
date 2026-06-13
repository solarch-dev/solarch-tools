/** solarch push — koddaki delta'yı (yeni node/edge + liste-property farkları)
 *  Solarch Cloud'a yazar.
 *
 *  Akış: taze graf (revizyon R) → diff → plan göster → onay → tek graph/apply
 *  (baseRevision=R). 409 revizyon çatışmasında otomatik re-pull + re-plan + tek
 *  retry. Property güncellemeleri PATCH + expectedVersion ile gider; node
 *  çatışmasında interaktif seçim (cloud'u tut / kodu yaz / atla), TTY yoksa
 *  otomatik atla + raporla. Illegal edge varken push tamamen reddedilir. */

import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { ApiError, SolarchApi, type CloudGraph, type RuleCatalog } from "../api.js";
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
}

export async function pushCommand(opts: PushOptions): Promise<void> {
  const config = readProjectConfig(opts.rootDir);
  if (!config?.projectId) {
    console.error(pc.red("No linked project. Run `solarch link` first."));
    process.exitCode = 1;
    return;
  }
  const projectId = config.projectId;
  const api = SolarchApi.fromStoredCredentials();

  // 1. Taze To-Be (revizyon R) + kurallar + As-Is.
  const [toBe, rules] = await Promise.all([api.getGraph(projectId), api.getRules()]);
  const asIs = runScan(opts.rootDir);

  // 2. Diff → eşleştirme cache'i güncelle → plan.
  const previousCache = readMatchCache(opts.rootDir);
  const diff = diffGraphs(asIs, toBe, rules, previousCache);
  writeMatchCache(opts.rootDir, diff.cache);
  let plan = buildPushPlan(asIs, toBe, rules, diff.cache);

  // Illegal edge'ler ASLA pushlanmaz — error basılır, push reddedilir.
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
    return;
  }

  // 3. Planı göster + onay.
  renderPlan(plan, toBe.graphRevision);
  if (!opts.yes) {
    const ok = await confirm("Push these changes?");
    if (!ok) {
      console.log(pc.dim("Aborted — nothing pushed."));
      return;
    }
  }

  // 4. Ekleme — tek graph/apply (baseRevision=R); 409'da re-pull + tek retry.
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
        // idMap → map.json: yeni node'lar anında eşleşmiş sayılır.
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
          const { toBe: freshToBe, plan: freshPlan } = await replan(api, projectId, opts.rootDir, rules);
          if (freshPlan.illegalEdges.length > 0 || planIsEmpty(freshPlan)) {
            if (planIsEmpty(freshPlan)) {
              console.log(pc.green("After re-pull there is nothing left to add — continuing."));
              plan = freshPlan;
              baseRevision = freshToBe.graphRevision;
              applied = true;
              continue;
            }
            console.error(pc.red("After re-pull the plan contains illegal edges — push refused."));
            process.exitCode = 1;
            return;
          }
          plan = freshPlan;
          baseRevision = freshToBe.graphRevision;
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

  // 5. Property güncellemeleri — PATCH + expectedVersion, çatışmada interaktif.
  if (plan.propertyUpdates.length > 0) {
    const { updated, skipped } = await applyPropertyUpdates(api, projectId, plan.propertyUpdates, opts.yes ?? false);
    console.log(pc.green(`✓ Updated properties on ${updated} node(s)${skipped > 0 ? pc.yellow(` (${skipped} skipped)`) : ""}.`));
  }

  console.log(pc.bold(pc.green("Push complete.")));
}

/* ── yardımcılar ─────────────────────────────────────────────────── */

async function replan(
  api: SolarchApi,
  projectId: string,
  rootDir: string,
  rules: RuleCatalog | null,
): Promise<{ toBe: CloudGraph; plan: PushPlan }> {
  const toBe = await api.getGraph(projectId);
  const asIs = runScan(rootDir);
  const diff = diffGraphs(asIs, toBe, rules, readMatchCache(rootDir));
  writeMatchCache(rootDir, diff.cache);
  return { toBe, plan: buildPushPlan(asIs, toBe, rules, diff.cache) };
}

function renderPlan(plan: PushPlan, revision: number): void {
  console.log(pc.bold(`Push plan (against revision ${revision}):`));
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
  console.log("");
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

/** PATCH'leri sırayla uygula. ERR_VERSION_CONFLICT'te:
 *  TTY → cloud'u tut / kodu yaz / atla; TTY yok (CI) → otomatik atla + raporla. */
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
      // "code": cloud bu arada değişti — güncel versiyonla zorla yaz.
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
