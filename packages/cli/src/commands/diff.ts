import { readFileSync } from "node:fs";
import pc from "picocolors";
import { SolarchApi, type CloudGraph, type RuleCatalog } from "../api.js";
import { readMatchCache, readProjectConfig, writeMatchCache } from "../config.js";
import { diffGraphs } from "../diff/engine.js";
import { renderCi, renderJson, renderSarif, renderTty } from "../diff/report.js";
import { runScan } from "./scan.js";

export interface DiffOptions {
  rootDir: string;
  json?: boolean;
  ci?: boolean;
  /** SARIF 2.1.0 output → GitHub code-scanning. */
  sarif?: boolean;
  /** Offline mode: read To-Be graph from file instead of API. */
  toBe?: string;
}

export async function diffCommand(opts: DiffOptions): Promise<void> {
  // 1. To-Be (expected) graph — cloud or file.
  let toBe: CloudGraph;
  let rules: RuleCatalog | null = null;

  if (opts.toBe) {
    const raw = JSON.parse(readFileSync(opts.toBe, "utf8")) as CloudGraph | { data: CloudGraph };
    toBe = "nodes" in raw ? raw : raw.data;
    // Offline: still try rules catalog — legality checks run when logged in.
    try {
      rules = await SolarchApi.fromStoredCredentials().getRules();
    } catch {
      console.error(pc.dim("(offline: rules catalog unavailable — legality checks skipped)"));
    }
  } else {
    const config = readProjectConfig(opts.rootDir);
    if (!config?.projectId) {
      console.error(pc.red("No linked project. Run `solarch link` first (or pass --to-be <graph.json>)."));
      process.exitCode = 1;
      return;
    }
    const api = SolarchApi.fromStoredCredentials();
    [toBe, rules] = await Promise.all([api.getGraph(config.projectId), api.getRules()]);
  }

  // 2. As-Is graph — local code.
  const asIs = runScan(opts.rootDir);

  // 3. Diff + update match cache.
  const cache = readMatchCache(opts.rootDir);
  const result = diffGraphs(asIs, toBe, rules, cache);
  writeMatchCache(opts.rootDir, result.cache);

  // 4. Output + exit code (errors → 1 → CI blocks merge).
  if (opts.json) console.log(renderJson(result));
  else if (opts.sarif) console.log(renderSarif(result));
  else if (opts.ci) console.log(renderCi(result));
  else console.log(renderTty(result));

  if (result.counts.errors > 0) process.exitCode = 1;
}
