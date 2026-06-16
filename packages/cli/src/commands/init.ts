/** solarch init — brownfield import.
 *
 *  Takes an existing NestJS repo, scans its As-Is architecture graph, creates a
 *  fresh Solarch Cloud project from it, and writes solarch.json — the reverse of
 *  the usual draw-then-generate flow. The whole scanned graph is applied in one
 *  transaction against an empty project (everything is new; sentinel/wildcard
 *  edges have no real endpoints so the push planner drops them automatically). */

import { basename, resolve } from "node:path";
import pc from "picocolors";
import { SolarchApi, type CloudGraph } from "../api.js";
import { DEFAULT_API_URL, readCredentials, readProjectConfig, writeMatchCache, writeProjectConfig } from "../config.js";
import { buildPushPlan, planIsEmpty, toApplyPayload } from "../push/planner.js";
import { runScan } from "./scan.js";

export interface InitOptions {
  rootDir: string;
  /** Proje adı — verilmezse repo klasör adı. */
  name?: string;
  /** Zaten linkli olsa da yeni projeye import et. */
  force?: boolean;
}

/** API tabanından canvas URL'i türet: api.solarch.dev/api/v1 → app.solarch.dev/p/<id>. */
export function canvasUrl(apiUrl: string, projectId: string): string {
  try {
    const u = new URL(apiUrl);
    const host = u.hostname.startsWith("api.") ? `app.${u.hostname.slice(4)}` : u.hostname;
    return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}/p/${projectId}`;
  } catch {
    return `/p/${projectId}`;
  }
}

export async function initCommand(opts: InitOptions): Promise<void> {
  const existing = readProjectConfig(opts.rootDir);
  if (existing?.projectId && !opts.force) {
    console.error(pc.red(`Already linked to project ${existing.projectId} (solarch.json).`));
    console.error(pc.dim("Run `solarch push` to sync, or `solarch init --force` to import into a brand-new project."));
    process.exitCode = 1;
    return;
  }

  const api = SolarchApi.fromStoredCredentials();
  const name = opts.name?.trim() || basename(resolve(opts.rootDir));

  // 1. Scan the existing code into an As-Is graph.
  const asIs = runScan(opts.rootDir);
  if (asIs.nodes.length === 0) {
    console.error(pc.red("Scan found no architecture nodes — is this a NestJS project? (looked under src/**/*.ts)"));
    process.exitCode = 1;
    return;
  }

  // 2. Plan against an empty cloud → every node/edge is new. The planner drops
  //    edges whose endpoints aren't real nodes (forRoutes("*"), central config reads).
  const emptyCloud: CloudGraph = {
    project: { id: "", name },
    nodes: [],
    edges: [],
    counts: { nodes: 0, edges: 0 },
    graphRevision: 0,
  };
  const plan = buildPushPlan(asIs, emptyCloud, null, {});
  if (planIsEmpty(plan)) {
    console.error(pc.red("Nothing to import after planning."));
    process.exitCode = 1;
    return;
  }

  console.log(pc.bold(`Importing "${pc.cyan(name)}" — ${plan.newNodes.length} nodes, ${plan.newEdges.length} edges`));

  // 3. Create the project, then apply the whole graph in one transaction (baseRevision 0).
  const project = await api.createProject(name);
  const result = await api.applyGraph(project.id, toApplyPayload(plan, 0));
  if (!result.success) {
    console.error(pc.red(`Import rejected (${result.transactionStatus}): ${result.message}`));
    for (const v of result.violations) {
      console.error(pc.red(`  ✗ ${v.message}`));
      if (v.suggestion) console.error(pc.dim(`    → ${v.suggestion}`));
    }
    process.exitCode = 1;
    return;
  }

  // 4. Write solarch.json + seed the match cache from the returned tempId→cloudId map.
  const path = writeProjectConfig(opts.rootDir, { projectId: project.id, projectName: name, bindings: [] });
  const cache: Record<string, string> = {};
  for (const [key, tempId] of Object.entries(plan.tempIdByKey)) {
    const cloudId = result.idMap[tempId];
    if (cloudId) cache[key] = cloudId;
  }
  writeMatchCache(opts.rootDir, cache);

  // 5. Report + canvas URL.
  const apiUrl = readCredentials()?.apiUrl ?? DEFAULT_API_URL;
  console.log(pc.green(`Imported ${result.nodeCount} nodes, ${result.edgeCount} edges.`));
  console.log(pc.dim(`Config written to ${path}`));
  console.log(`Open the canvas: ${pc.cyan(canvasUrl(apiUrl, project.id))}`);
}
