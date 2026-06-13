import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pc from "picocolors";
import { SolarchApi, type CloudGraph } from "../api.js";
import { readProjectConfig } from "../config.js";

export interface PullOptions {
  rootDir: string;
}

export function toBePath(rootDir: string): string {
  return join(resolve(rootDir), ".solarch", "to-be.json");
}

/** Download To-Be graph with revision to disk — fresh local copy for offline
 *  `diff --to-be` + reference before push. */
export async function pullCommand(opts: PullOptions): Promise<CloudGraph | null> {
  const config = readProjectConfig(opts.rootDir);
  if (!config?.projectId) {
    console.error(pc.red("No linked project. Run `solarch link` first."));
    process.exitCode = 1;
    return null;
  }

  const api = SolarchApi.fromStoredCredentials();
  const graph = await api.getGraph(config.projectId);

  const p = toBePath(opts.rootDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(graph, null, 2) + "\n");

  console.log(
    pc.green(
      `Pulled "${graph.project.name}" — ${graph.counts.nodes} node(s), ${graph.counts.edges} edge(s), revision ${graph.graphRevision}.`,
    ),
  );
  console.log(pc.dim(`Saved to ${p}`));
  return graph;
}
