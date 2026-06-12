import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { SolarchApi } from "../api.js";
import { readProjectConfig, writeProjectConfig } from "../config.js";

export interface LinkOptions {
  project?: string; // proje id'si — verilmezse listeden seçtir
  rootDir: string;
}

/** Bulunduğun repo'yu bir Solarch projesine bağlar → solarch.json yazar. */
export async function linkCommand(opts: LinkOptions): Promise<void> {
  const api = SolarchApi.fromStoredCredentials();
  const projects = await api.listProjects();
  if (projects.length === 0) {
    console.error(pc.red("No projects in your Solarch account. Create one in the app first."));
    process.exitCode = 1;
    return;
  }

  let chosen = opts.project ? projects.find((p) => p.id === opts.project) : undefined;
  if (opts.project && !chosen) {
    console.error(pc.red(`Project ${opts.project} not found in your account.`));
    process.exitCode = 1;
    return;
  }

  if (!chosen) {
    console.log(pc.bold("Your Solarch projects:"));
    projects.forEach((p, i) => {
      console.log(`  ${pc.cyan(String(i + 1).padStart(2))}. ${p.name} ${pc.dim(`(${p.id})`)}`);
    });
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Link which project? (number): ")).trim();
    rl.close();
    const idx = Number.parseInt(answer, 10) - 1;
    chosen = projects[idx];
    if (!chosen) {
      console.error(pc.red("Invalid selection."));
      process.exitCode = 1;
      return;
    }
  }

  const existing = readProjectConfig(opts.rootDir);
  const path = writeProjectConfig(opts.rootDir, {
    projectId: chosen.id,
    projectName: chosen.name,
    include: existing?.include,
    exclude: existing?.exclude,
    bindings: existing?.bindings ?? [],
  });
  console.log(pc.green(`Linked to "${chosen.name}". Config written to ${path}`));
  console.log(`Next: ${pc.cyan("solarch scan")} (local graph) or ${pc.cyan("solarch diff")} (drift check)`);
}
