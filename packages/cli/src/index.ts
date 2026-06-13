#!/usr/bin/env node
/** solarch — architecture drift guard + live binding assistant. */

import { Command } from "commander";
import pc from "picocolors";
import { configureProgramHelp, renderRootHelp } from "./help.js";
import { renderVersionScreen } from "./brand.js";
import { connectCommand } from "./commands/connect.js";
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
import { cliVersion } from "./version.js";

const rootDir = () => process.cwd();
const argv = process.argv.slice(2);

const SUBCOMMANDS = new Set([
  "connect", "login", "link", "scan", "status", "diff", "pull", "push", "generate", "bind", "watch",
]);

// Bare `solarch` → branded help (no subcommand).
if (argv.length === 0) {
  console.log(renderRootHelp());
  process.exit(0);
}

// Branded root --version only (not `solarch diff --version`).
const wantsVersion = argv.includes("-V") || argv.includes("--version");
const subcommand = argv.find((a) => !a.startsWith("-") && SUBCOMMANDS.has(a));
if (wantsVersion && !subcommand) {
  console.log(renderVersionScreen(cliVersion()));
  process.exit(0);
}

const program = new Command();

program
  .name("solarch")
  .description("Solarch CLI — keep your NestJS codebase in sync with its architecture")
  .version(cliVersion(), "-V, --version", "Show version");

configureProgramHelp(program);

program
  .command("connect")
  .description("Connect this repo to Solarch (sign in + link project — start here)")
  .option("--api-url <url>", "Solarch API base URL (default: https://app.solarch.dev/api/v1)")
  .option("--key <key>", "API key (non-interactive)")
  .option("--project <id>", "Project id (skips interactive selection)")
  .action(async (opts: { apiUrl?: string; key?: string; project?: string }) => {
    await connectCommand({ rootDir: rootDir(), ...opts });
  });

program
  .command("login")
  .description("Sign in with an API key only (Settings → API Keys)")
  .option("--api-url <url>", "Solarch API base URL (default: https://app.solarch.dev/api/v1)")
  .option("--key <key>", "API key (non-interactive, e.g. CI)")
  .action(async (opts: { apiUrl?: string; key?: string }) => {
    await loginCommand(opts);
  });

program
  .command("link")
  .description("Link this folder to a Solarch project (requires login)")
  .option("--project <id>", "Project id (skips interactive selection)")
  .action(async (opts: { project?: string }) => {
    await linkCommand({ project: opts.project, rootDir: rootDir() });
  });

program
  .command("scan")
  .description("Extract the As-Is architecture graph from the code")
  .option("--json", "Machine-readable output")
  .action((opts: { json?: boolean }) => {
    scanCommand({ rootDir: rootDir(), json: opts.json });
  });

program
  .command("status")
  .description("Implementation status: scaffold fill rate, contract violations, marker losses")
  .option("--json", "Machine-readable output")
  .option("--ci", "Exit 1 if anything is unimplemented, in violation, or untracked")
  .option("--report", "Push the per-node counters to Solarch Cloud (canvas badges)")
  .action(async (opts: { json?: boolean; ci?: boolean; report?: boolean }) => {
    await statusCommand({ rootDir: rootDir(), ...opts });
  });

program
  .command("diff")
  .description("Drift check: compare the code (As-Is) with the Solarch architecture (To-Be)")
  .option("--json", "Machine-readable output")
  .option("--ci", "GitHub Actions annotation output (errors fail the job)")
  .option("--to-be <file>", "Offline mode: read the To-Be graph from a JSON file")
  .action(async (opts: { json?: boolean; ci?: boolean; toBe?: string }) => {
    await diffCommand({ rootDir: rootDir(), ...opts });
  });

program
  .command("pull")
  .description("Download the To-Be graph (with its revision) to .solarch/to-be.json")
  .action(async () => {
    await pullCommand({ rootDir: rootDir() });
  });

program
  .command("push")
  .description("Push code-side additions (nodes/edges) and list-property updates to Solarch Cloud")
  .option("--yes", "Skip the confirmation prompt (CI)")
  .action(async (opts: { yes?: boolean }) => {
    await pushCommand({ rootDir: rootDir(), yes: opts.yes });
  });

program
  .command("generate")
  .description("Generate the deterministic code scaffold from the cloud graph into this repo")
  .option("--force", "Overwrite existing files (default: skip them)")
  .action(async (opts: { force?: boolean }) => {
    await generateCommand({ rootDir: rootDir(), force: opts.force });
  });

program
  .command("bind")
  .description("Create a live binding between two classes (e.g. Entity → DTO)")
  .argument("<source>", 'Source ref: "src/users/user.entity.ts#User"')
  .argument("<target>", 'Target ref: "src/users/user.dto.ts#UserDto"')
  .option("--fields <list>", "Comma-separated field names (default: all)")
  .action((source: string, target: string, opts: { fields?: string }) => {
    bindCommand({ rootDir: rootDir(), source, target, fields: opts.fields });
  });

program
  .command("watch")
  .description("Daemon: watch files, run live bindings and report drift on change")
  .option("--no-drift", "Disable drift summaries (bindings only)")
  .action(async (opts: { drift?: boolean }) => {
    await watchCommand({ rootDir: rootDir(), noDrift: opts.drift === false });
  });

program.parseAsync(process.argv).catch((e: Error) => {
  console.error(pc.red(e.message));
  process.exitCode = 1;
});
