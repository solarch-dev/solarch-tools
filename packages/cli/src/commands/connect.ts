/** solarch connect — first-run setup wizard.
 *
 *  One command for a “normal CLI” feel: login if unsigned in, link if no project
 *  binding, otherwise show connected status. `login` + `link` remain available
 *  separately (CI / automation). */

import pc from "picocolors";
import { readCredentials, readProjectConfig } from "../config.js";
import { loginCommand } from "./login.js";
import { linkCommand } from "./link.js";

export interface ConnectOptions {
  rootDir: string;
  apiUrl?: string;
  key?: string;
  project?: string;
}

export async function connectCommand(opts: ConnectOptions): Promise<void> {
  let creds = readCredentials();

  if (!creds) {
    console.log(pc.bold("Step 1/2 — Sign in to Solarch"));
    await loginCommand({ apiUrl: opts.apiUrl, key: opts.key });
    if (process.exitCode === 1) return;
    creds = readCredentials();
    if (!creds) return;
    console.log("");
  }

  const config = readProjectConfig(opts.rootDir);
  if (!config?.projectId) {
    console.log(pc.bold("Step 2/2 — Link this folder to a project"));
    await linkCommand({ project: opts.project, rootDir: opts.rootDir });
    return;
  }

  // Already connected — status summary.
  console.log(pc.green("Already connected."));
  console.log(`  Project  ${pc.bold(config.projectName ?? config.projectId)} ${pc.dim(`(${config.projectId})`)}`);
  console.log(`  API      ${pc.dim(creds.apiUrl)}`);
  console.log(`  Config   ${pc.dim("solarch.json")}`);
  console.log("");
  console.log(`Try: ${pc.cyan("solarch scan")} · ${pc.cyan("solarch diff")} · ${pc.cyan("solarch generate")}`);
}
