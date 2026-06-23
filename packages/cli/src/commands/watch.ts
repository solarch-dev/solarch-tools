import { relative, resolve } from "node:path";
import chokidar from "chokidar";
import pc from "picocolors";
import { runBinding } from "@solarch/ast-core";
import { SolarchApi, type CloudGraph, type RuleCatalog } from "../api.js";
import { readMatchCache, readProjectConfig, writeMatchCache } from "../config.js";
import { diffGraphs } from "../diff/engine.js";
import { report } from "./bind.js";
import { pushCommand } from "./push.js";
import { runScan } from "./scan.js";

export interface WatchOptions {
  rootDir: string;
  /** Disable drift summary — live binding only. */
  noDrift?: boolean;
  /** Push code-side additions to the cloud on each change (additive only — never prunes). */
  autoPush?: boolean;
}

const DEBOUNCE_MS = 400;

/** Watcher daemon: file changed → (1) find source in bindings, sync target;
 *  (2) incremental rescan + drift summary. Stop with Ctrl-C. */
export async function watchCommand(opts: WatchOptions): Promise<void> {
  const rootDir = resolve(opts.rootDir);
  const config = readProjectConfig(rootDir);

  // Fetch To-Be graph + rules once (reference for daemon lifetime).
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

  /** Run bindings tied to changed source files. */
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

  const projectId = config?.projectId;

  const runDrift = async (): Promise<void> => {
    if (!toBe) return;
    const asIs = runScan(rootDir);
    const cache = readMatchCache(rootDir);
    const result = diffGraphs(asIs, toBe, rules, cache);
    writeMatchCache(rootDir, result.cache);
    const { errors, warns, infos } = result.counts;
    if (errors === 0 && warns === 0) {
      console.log(pc.green(`✓ drift: clean (${result.matched} matched)`));
    } else {
      console.log(
        (errors > 0 ? pc.red(`✗ drift: ${errors} error(s)`) : pc.yellow(`drift: ${warns} warning(s)`)) +
          pc.dim(` — run \`solarch diff\` for details`),
      );
    }

    // --auto-push: yalnız additif drift (kod fazlası node/edge ya da liste-property
    // farkı) ve HATA YOKKEN pushla. Hata varsa (illegal edge / kodda-eksik) push
    // reddeder ya da silme gerektirir — watch ASLA prune etmez, additif kalır.
    if (opts.autoPush && projectId && errors === 0 && (warns > 0 || infos > 0)) {
      console.log(pc.dim("auto-push: syncing code-side additions to the cloud…"));
      try {
        await pushCommand({ rootDir, yes: true });
        // toBe artık eskidi (yeni node'lar cloud'a gitti) — tazele ki bir sonraki
        // tur aynı eklemeleri tekrar drift sanıp pushlamasın.
        toBe = await SolarchApi.fromStoredCredentials().getGraph(projectId);
      } catch (e) {
        console.log(pc.red(`auto-push failed: ${(e as Error).message}`));
      }
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
      runDrift().catch((e) => console.log(pc.red(`drift failed: ${(e as Error).message}`)));
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

  // Initial state: print drift once on startup.
  await runDrift().catch((e) => console.log(pc.red(`drift failed: ${(e as Error).message}`)));

  await new Promise<void>((resolveWait) => {
    const stop = () => {
      void watcher.close().then(() => resolveWait());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  console.log(pc.dim("\nwatcher stopped."));
}
