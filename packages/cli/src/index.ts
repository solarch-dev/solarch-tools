#!/usr/bin/env node
/** solarch — mimari drift bekçisi + live binding asistanı.
 *
 *  Akış: `solarch login` (API anahtarı) → `solarch link` (proje bağı) →
 *  `solarch scan|diff|watch|bind`. `diff --ci` GitHub annotation basar ve
 *  error'da exit 1 döner — mimariyi bozan kod merge edilemez. */

import { Command } from "commander";
import pc from "picocolors";
import { loginCommand } from "./commands/login.js";
import { linkCommand } from "./commands/link.js";
import { scanCommand } from "./commands/scan.js";
import { statusCommand } from "./commands/status.js";
import { diffCommand } from "./commands/diff.js";
import { pullCommand } from "./commands/pull.js";
import { pushCommand } from "./commands/push.js";
import { generateCommand } from "./commands/generate.js";
import { bindCommand } from "./commands/bind.js";
import { watchCommand } from "./commands/watch.js";

const program = new Command();

program
  .name("solarch")
  .description("Solarch CLI — keep your NestJS codebase in sync with its architecture")
  .version("0.1.0");

program
  .command("login")
  .description("Authenticate with a Solarch API key (Settings → API Keys)")
  .option("--api-url <url>", "Solarch API base URL (default: https://api.solarch.dev/api/v1)")
  .option("--key <key>", "API key (non-interactive, e.g. CI)")
  .action(async (opts: { apiUrl?: string; key?: string }) => {
    await loginCommand(opts);
  });

program
  .command("link")
  .description("Link this repository to a Solarch project (writes solarch.json)")
  .option("--project <id>", "Project id (skips interactive selection)")
  .action(async (opts: { project?: string }) => {
    await linkCommand({ project: opts.project, rootDir: process.cwd() });
  });

program
  .command("scan")
  .description("Extract the As-Is architecture graph from the code")
  .option("--json", "Machine-readable output")
  .action((opts: { json?: boolean }) => {
    scanCommand({ rootDir: process.cwd(), json: opts.json });
  });

program
  .command("status")
  .description("Implementation status: how much of the generated scaffold is actually filled in")
  .option("--json", "Machine-readable output")
  .option("--ci", "Exit 1 if any NOT_IMPLEMENTED member remains")
  .action((opts: { json?: boolean; ci?: boolean }) => {
    statusCommand({ rootDir: process.cwd(), ...opts });
  });

program
  .command("diff")
  .description("Drift check: compare the code (As-Is) with the Solarch architecture (To-Be)")
  .option("--json", "Machine-readable output")
  .option("--ci", "GitHub Actions annotation output (errors fail the job)")
  .option("--to-be <file>", "Offline mode: read the To-Be graph from a JSON file")
  .action(async (opts: { json?: boolean; ci?: boolean; toBe?: string }) => {
    await diffCommand({ rootDir: process.cwd(), ...opts });
  });

program
  .command("pull")
  .description("Download the To-Be graph (with its revision) to .solarch/to-be.json")
  .action(async () => {
    await pullCommand({ rootDir: process.cwd() });
  });

program
  .command("push")
  .description("Push code-side additions (nodes/edges) and list-property updates to Solarch Cloud")
  .option("--yes", "Skip the confirmation prompt (CI)")
  .action(async (opts: { yes?: boolean }) => {
    await pushCommand({ rootDir: process.cwd(), yes: opts.yes });
  });

program
  .command("generate")
  .description("Generate the deterministic code scaffold from the cloud graph into this repo")
  .option("--force", "Overwrite existing files (default: skip them)")
  .action(async (opts: { force?: boolean }) => {
    await generateCommand({ rootDir: process.cwd(), force: opts.force });
  });

program
  .command("bind")
  .description("Create a live binding between two classes (e.g. Entity → DTO)")
  .argument("<source>", 'Source ref: "src/users/user.entity.ts#User"')
  .argument("<target>", 'Target ref: "src/users/user.dto.ts#UserDto"')
  .option("--fields <list>", "Comma-separated field names (default: all)")
  .action((source: string, target: string, opts: { fields?: string }) => {
    bindCommand({ rootDir: process.cwd(), source, target, fields: opts.fields });
  });

program
  .command("watch")
  .description("Daemon: watch files, run live bindings and report drift on change")
  .option("--no-drift", "Disable drift summaries (bindings only)")
  .action(async (opts: { drift?: boolean }) => {
    await watchCommand({ rootDir: process.cwd(), noDrift: opts.drift === false });
  });

program.parseAsync(process.argv).catch((e: Error) => {
  console.error(pc.red(e.message));
  process.exitCode = 1;
});
