import { relative, resolve } from "node:path";
import chokidar from "chokidar";
import pc from "picocolors";
import { runBinding } from "@solarch/ast-core";
import { SolarchApi, type CloudGraph, type RuleCatalog } from "../api.js";
import { readMatchCache, readProjectConfig, writeMatchCache } from "../config.js";
import { diffGraphs } from "../diff/engine.js";
import { report } from "./bind.js";
import { runScan } from "./scan.js";

export interface WatchOptions {
  rootDir: string;
  /** Drift özetini kapat — yalnız live binding çalışsın. */
  noDrift?: boolean;
}

const DEBOUNCE_MS = 400;

/** Watcher daemon: dosya değişti → (1) kaynağı binding'lerde ara, hedefe senkron;
 *  (2) artımlı yeniden tarama + drift özeti. Ctrl-C ile durur. */
export async function watchCommand(opts: WatchOptions): Promise<void> {
  const rootDir = resolve(opts.rootDir);
  const config = readProjectConfig(rootDir);

  // To-Be graf + kurallar bir kez çekilir (daemon ömrü boyunca referans).
  let toBe: CloudGraph | null = null;
  let rules: RuleCatalog | null = null;
  if (!opts.noDrift && config?.projectId) {
    try {
      const api = SolarchApi.fromStoredCredentials();
      [toBe, rules] = await Promise.all([api.getGraph(config.projectId), api.getRules()]);
      console.log(pc.dim(`To-Be graph loaded: ${toBe.counts.nodes} node(s), ${toBe.counts.edges} edge(s).`));
    } catch (e) {
      console.log(pc.yellow(`Drift check disabled — ${(e as Error).message}`));
    }
  }

  const bindings = config?.bindings ?? [];
  console.log(
    pc.bold(`solarch watch`) +
      pc.dim(` — ${bindings.length} binding(s), drift ${toBe ? "on" : "off"}. Ctrl-C to stop.`),
  );

  /** Değişen kaynak dosyalara bağlı binding'leri çalıştır. */
  const syncBindingsFor = (changedRel: string): void => {
    for (const b of bindings) {
      const sourceFile = b.source.split("#")[0];
      if (sourceFile !== changedRel) continue;
      try {
        const outcome = runBinding(rootDir, b.source, b.target, b.fields);
        if (outcome.added.length > 0 || outcome.conflicts.length > 0) {
          console.log(pc.cyan(`bind ${b.source} → ${b.target}`));
          report(outcome.targetFile, outcome);
        }
      } catch (e) {
        console.log(pc.red(`bind ${b.source} → ${b.target} failed: ${(e as Error).message}`));
      }
    }
  };

  const runDrift = (): void => {
    if (!toBe) return;
    const asIs = runScan(rootDir);
    const cache = readMatchCache(rootDir);
    const result = diffGraphs(asIs, toBe, rules, cache);
    writeMatchCache(rootDir, result.cache);
    const { errors, warns } = result.counts;
    if (errors === 0 && warns === 0) {
      console.log(pc.green(`✓ drift: clean (${result.matched} matched)`));
    } else {
      console.log(
        (errors > 0 ? pc.red(`✗ drift: ${errors} error(s)`) : pc.yellow(`drift: ${warns} warning(s)`)) +
          pc.dim(` — run \`solarch diff\` for details`),
      );
    }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<string>();

  const onChange = (path: string): void => {
    const rel = relative(rootDir, path);
    if (!rel.endsWith(".ts") || rel.includes("node_modules") || rel.includes(".solarch")) return;
    pending.add(rel);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const changed = [...pending];
      pending.clear();
      console.log(pc.dim(`changed: ${changed.join(", ")}`));
      for (const rel of changed) syncBindingsFor(rel);
      runDrift();
    }, DEBOUNCE_MS);
  };

  const watcher = chokidar.watch(rootDir, {
    ignored: (p: string) =>
      p.includes("node_modules") || p.includes("/.git") || p.includes("/dist") || p.includes("/.solarch"),
    ignoreInitial: true,
    persistent: true,
  });
  watcher.on("change", onChange);
  watcher.on("add", onChange);

  // İlk durum: açılışta bir kez drift bas.
  runDrift();

  await new Promise<void>((resolveWait) => {
    const stop = () => {
      void watcher.close().then(() => resolveWait());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  console.log(pc.dim("\nwatcher stopped."));
}
