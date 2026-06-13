/** solarch status — implementasyon panosu.
 *
 *  Codegen'in bıraktığı surgical işaretleri okur ve "mimari yüzde kaç hayata
 *  geçti" sorusunu cevaplar: node bazında doldurulmuş / iskelet kalmış üye
 *  sayıları + bekleyen iş listesi. `--ci` iskelet kalmışsa exit 1 döner —
 *  "boş gövdeyle release çıkılmaz" kuralı kapıya bağlanabilir. */

import pc from "picocolors";
import { summarizeSurgical, type AsIsGraph, type SurgicalMember } from "@solarch/ast-core";
import { runScan } from "./scan.js";

export interface StatusOptions {
  rootDir: string;
  json?: boolean;
  ci?: boolean;
}

export interface NodeImplementation {
  key: string;
  kind: string;
  name: string;
  file: string;
  total: number;
  filled: number;
  skeletons: SurgicalMember[];
}

export interface ImplementationReport {
  nodes: NodeImplementation[];
  totals: { members: number; filled: number; skeletons: number };
}

/** Graf → implementasyon raporu (saf — testler burayı vurur). */
export function buildImplementationReport(graph: AsIsGraph): ImplementationReport {
  const nodes: NodeImplementation[] = [];
  let members = 0;
  let filled = 0;
  for (const n of graph.nodes) {
    if (!n.surgical || n.surgical.length === 0) continue;
    const summary = summarizeSurgical(n.surgical);
    members += summary.total;
    filled += summary.filled;
    nodes.push({
      key: n.key,
      kind: n.kind,
      name: n.name,
      file: n.file,
      total: summary.total,
      filled: summary.filled,
      skeletons: n.surgical.filter((m) => m.status === "skeleton"),
    });
  }
  // En çok eksiği olan üstte — çalışılacak yer önce görünsün.
  nodes.sort((a, b) => (b.total - b.filled) - (a.total - a.filled));
  return { nodes, totals: { members, filled, skeletons: members - filled } };
}

export function statusCommand(opts: StatusOptions): void {
  const graph = runScan(opts.rootDir);
  const report = buildImplementationReport(graph);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    render(report);
  }

  if (opts.ci && report.totals.skeletons > 0) {
    console.error(pc.red(`\n${report.totals.skeletons} unimplemented member(s) remain — failing (--ci).`));
    process.exitCode = 1;
  }
}

function render(report: ImplementationReport): void {
  const { totals } = report;
  if (totals.members === 0) {
    console.log(pc.dim("No surgical markers found — this codebase has no generated scaffolds (or they were hand-rewritten)."));
    return;
  }

  const pct = Math.round((totals.filled / totals.members) * 100);
  console.log(
    pc.bold(`Implementation status`) +
      pc.dim(` — ${totals.filled}/${totals.members} member(s) implemented (${pct}%)`),
  );
  console.log("");

  for (const n of report.nodes) {
    const done = n.filled === n.total;
    const bar = done ? pc.green("●") : n.filled === 0 ? pc.red("●") : pc.yellow("●");
    console.log(`  ${bar} ${pc.bold(n.name)} ${pc.dim(`(${n.kind})`)} ${n.filled}/${n.total} ${pc.dim(n.file)}`);
    for (const s of n.skeletons) {
      console.log(`      ${pc.red("✗")} ${s.member} ${pc.dim(`:${s.line}`)}${s.description ? pc.dim(` — ${s.description.split("\n")[0]}`) : ""}`);
    }
  }

  if (totals.skeletons > 0) {
    console.log("");
    console.log(pc.yellow(`${totals.skeletons} member(s) waiting to be implemented.`));
  } else {
    console.log("");
    console.log(pc.green("All generated scaffolds are implemented."));
  }
}
