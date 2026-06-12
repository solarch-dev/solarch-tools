import { readFileSync } from "node:fs";
import pc from "picocolors";
import { SolarchApi, type CloudGraph, type RuleCatalog } from "../api.js";
import { readMatchCache, readProjectConfig, writeMatchCache } from "../config.js";
import { diffGraphs } from "../diff/engine.js";
import { renderCi, renderJson, renderTty } from "../diff/report.js";
import { runScan } from "./scan.js";

export interface DiffOptions {
  rootDir: string;
  json?: boolean;
  ci?: boolean;
  /** Offline mod: To-Be grafiği API yerine dosyadan oku. */
  toBe?: string;
}

export async function diffCommand(opts: DiffOptions): Promise<void> {
  // 1. To-Be (olması gereken) graf — cloud veya dosya.
  let toBe: CloudGraph;
  let rules: RuleCatalog | null = null;

  if (opts.toBe) {
    const raw = JSON.parse(readFileSync(opts.toBe, "utf8")) as CloudGraph | { data: CloudGraph };
    toBe = "nodes" in raw ? raw : raw.data;
    // Offline'da da kural kataloğunu dene — login varsa legalite kontrolü çalışır.
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

  // 2. As-Is graf — lokal kod.
  const asIs = runScan(opts.rootDir);

  // 3. Diff + eşleştirme cache'i güncelle.
  const cache = readMatchCache(opts.rootDir);
  const result = diffGraphs(asIs, toBe, rules, cache);
  writeMatchCache(opts.rootDir, result.cache);

  // 4. Çıktı + exit code (error varsa 1 → CI merge'i bloklar).
  if (opts.json) console.log(renderJson(result));
  else if (opts.ci) console.log(renderCi(result));
  else console.log(renderTty(result));

  if (result.counts.errors > 0) process.exitCode = 1;
}
