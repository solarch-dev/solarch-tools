import pc from "picocolors";
import { scanProject, type AsIsGraph, type NodeKind } from "@solarch/ast-core";
import { readProjectConfig } from "../config.js";

export interface ScanOptions {
  rootDir: string;
  json?: boolean;
}

/** Uses include/exclude from solarch.json when present; otherwise defaults. */
export function runScan(rootDir: string): AsIsGraph {
  const config = readProjectConfig(rootDir);
  return scanProject({
    rootDir,
    include: config?.include,
    exclude: config?.exclude,
  });
}

export function scanCommand(opts: ScanOptions): void {
  const graph = runScan(opts.rootDir);

  if (opts.json) {
    console.log(JSON.stringify(graph, null, 2));
    return;
  }

  const byKind = new Map<NodeKind, number>();
  for (const n of graph.nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);

  console.log(pc.bold(`As-Is graph — ${graph.fileCount} file(s) scanned`));
  console.log("");
  for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pc.cyan(kind.padEnd(20))} ${count}`);
  }
  console.log("");
  console.log(`  ${pc.bold(String(graph.nodes.length))} node(s), ${pc.bold(String(graph.edges.length))} edge(s)`);

  if (graph.warnings.length > 0) {
    console.log("");
    console.log(pc.yellow(`Warnings (${graph.warnings.length}):`));
    for (const w of graph.warnings) console.log(pc.yellow(`  ! ${w}`));
  }
}
