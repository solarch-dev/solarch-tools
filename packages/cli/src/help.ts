/** Custom --help output — grouped commands, readable, branded layout. */

import { Command, Help } from "commander";
import pc from "picocolors";
import { brand, muted, renderBanner } from "./brand.js";
import { cliVersion } from "./version.js";

const defaultHelp = new Help();

interface CommandGroup {
  title: string;
  commands: { name: string; args?: string; description: string }[];
}

const GROUPS: CommandGroup[] = [
  {
    title: "Getting started",
    commands: [
      { name: "connect", description: "Sign in + link this repo (start here)" },
      { name: "login", description: "Sign in with API key only" },
      { name: "link", description: "Link folder to a Solarch project" },
    ],
  },
  {
    title: "Code ↔ diagram",
    commands: [
      { name: "scan", description: "Read NestJS codebase → As-Is graph" },
      { name: "diff", args: "[--ci]", description: "Drift check: code vs cloud architecture" },
      { name: "pull", description: "Download To-Be graph → .solarch/to-be.json" },
      { name: "push", args: "[--yes]", description: "Push code-side nodes/edges to cloud" },
    ],
  },
  {
    title: "Build & implementation",
    commands: [
      { name: "generate", args: "[--force]", description: "Scaffold code from cloud graph" },
      { name: "status", args: "[--report] [--ci]", description: "Surgical fill rate + contract checks" },
    ],
  },
  {
    title: "Live binding",
    commands: [
      { name: "bind", args: "<source> <target>", description: "Entity → DTO property sync" },
      { name: "watch", args: "[--no-drift]", description: "Watch files; run bindings + drift" },
    ],
  },
];

const GLOBAL_OPTS = [
  { flags: "-V, --version", desc: "Show version" },
  { flags: "-h, --help", desc: "Show help" },
];

function padCommand(name: string, args?: string): string {
  const full = args ? `${name} ${args}` : name;
  return full.padEnd(28);
}

export function renderRootHelp(): string {
  const lines: string[] = [
    renderBanner({ version: cliVersion() }),
    "",
    muted("  Usage:"),
    `    ${brand("solarch")} ${muted("<command>")} ${muted("[options]")}`,
    "",
  ];

  for (const group of GROUPS) {
    lines.push(`  ${pc.bold(group.title)}`);
    for (const cmd of group.commands) {
      const left = padCommand(cmd.name, cmd.args);
      lines.push(`    ${brand(left)}${cmd.description}`);
    }
    lines.push("");
  }

  lines.push(`  ${pc.bold("Global")}`);
  for (const opt of GLOBAL_OPTS) {
    lines.push(`    ${pc.cyan(opt.flags.padEnd(20))}${opt.desc}`);
  }
  lines.push("");
  lines.push(`  ${muted("Run")} ${brand("solarch <command> --help")} ${muted("for command details.")}`);
  lines.push(`  ${muted("Docs:")} ${muted("https://solarch.dev")}`);

  return lines.join("\n");
}

/** Subcommand help — short brand strip + commander’s default detail. */
export function renderSubcommandHeader(cmd: Command): string {
  const name = cmd.name();
  const desc = cmd.description() ?? "";
  return [
    brand(`solarch ${name}`) + muted(" — ") + desc,
    muted("─".repeat(Math.min(60, 12 + name.length + desc.length))),
    "",
  ].join("\n");
}

export function configureProgramHelp(program: Command): void {
  program.configureHelp({
    formatHelp: (cmd, helper) => {
      const isRoot = cmd.parent == null && cmd.name() === "solarch";
      if (isRoot) return renderRootHelp();
      return renderSubcommandHeader(cmd) + defaultHelp.formatHelp(cmd, helper);
    },
  });
}
