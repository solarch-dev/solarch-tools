/** solarch status — implementation dashboard.
 *
 *  Reads surgical markers left by codegen and answers “how much of the architecture
 *  is live in code?” — per-node filled vs skeleton member counts + pending job list.
 *  Extra checks:
 *  - Contract violations: filled body uses deps/throws outside declaration (ast-core).
 *  - Marker loss: file listed in generate manifest no longer has any markers —
 *    someone deleted comments; tracking is blind.
 *  `--ci` exits 1 if skeletons OR violations OR marker loss remain.
 *  `--report` pushes fill counters to cloud (feeds canvas badges). */

import { existsSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { summarizeSurgical, type AsIsGraph, type SurgicalMember } from "@solarch/ast-core";
import { SolarchApi, type ImplementationEntry } from "../api.js";
import { readGeneratedManifest, readMatchCache, readProjectConfig, type GeneratedManifest } from "../config.js";
import { runScan } from "./scan.js";

export interface StatusOptions {
  rootDir: string;
  json?: boolean;
  ci?: boolean;
  report?: boolean;
}

export interface NodeImplementation {
  key: string;
  kind: string;
  name: string;
  file: string;
  total: number;
  filled: number;
  filledAi: number;
  skeletons: SurgicalMember[];
  /** Sözleşme ihlali taşıyan dolu üyeler. */
  violators: SurgicalMember[];
}

export interface MarkerLoss {
  file: string;
  /** Manifestoda kayıtlı işaret sayısı (üretim anında). */
  expected: number;
  nodeId?: string;
}

export interface ImplementationReport {
  nodes: NodeImplementation[];
  /** Dosya hâlâ var ama içinde tek işaret kalmamış. */
  lostMarkers: MarkerLoss[];
  totals: { members: number; filled: number; filledAi: number; skeletons: number; violations: number };
}

/** Graf + manifest → implementasyon raporu (saf — testler burayı vurur). */
export function buildImplementationReport(
  graph: AsIsGraph,
  manifest: GeneratedManifest = {},
  fileExists: (relPath: string) => boolean = (rel) => existsSync(join(graph.rootDir, rel)),
): ImplementationReport {
  const nodes: NodeImplementation[] = [];
  const markersByFile = new Map<string, number>();
  let members = 0;
  let filled = 0;
  let filledAi = 0;
  let violations = 0;

  for (const n of graph.nodes) {
    if (!n.surgical || n.surgical.length === 0) continue;
    markersByFile.set(n.file, (markersByFile.get(n.file) ?? 0) + n.surgical.length);
    const summary = summarizeSurgical(n.surgical);
    members += summary.total;
    filled += summary.filled;
    filledAi += summary.filledAi;
    violations += summary.violations;
    nodes.push({
      key: n.key,
      kind: n.kind,
      name: n.name,
      file: n.file,
      total: summary.total,
      filled: summary.filled,
      filledAi: summary.filledAi,
      skeletons: n.surgical.filter((m) => m.status === "skeleton"),
      violators: n.surgical.filter((m) => (m.violations?.length ?? 0) > 0),
    });
  }
  // En çok eksiği olan üstte — çalışılacak yer önce görünsün.
  nodes.sort((a, b) => (b.total - b.filled) - (a.total - a.filled));

  // İşaret kaybı: manifestte işaretli dosya diskte duruyor ama taramada hiç işaret çıkmadı.
  const lostMarkers: MarkerLoss[] = [];
  for (const [file, entry] of Object.entries(manifest)) {
    if (entry.markers <= 0) continue;
    if (!fileExists(file)) continue; // dosya silinmiş — bu zaten diff'in node bulgusu
    if ((markersByFile.get(file) ?? 0) === 0) {
      lostMarkers.push({ file, expected: entry.markers, nodeId: entry.nodeId });
    }
  }
  lostMarkers.sort((a, b) => a.file.localeCompare(b.file));

  return { nodes, lostMarkers, totals: { members, filled, filledAi, skeletons: members - filled, violations } };
}

/** Rapor → cloud'a gidecek node-bazlı sayaçlar (map.json eşlemesiyle). */
export function toImplementationEntries(
  report: ImplementationReport,
  matchCache: Record<string, string>,
): ImplementationEntry[] {
  const entries: ImplementationEntry[] = [];
  for (const n of report.nodes) {
    // Önce eşleştirme defteri; yoksa surgical işaretin içindeki nodeId (kesin bağ).
    const cloudId = matchCache[n.key] ?? n.skeletons[0]?.nodeId ?? n.violators[0]?.nodeId;
    if (!cloudId) continue;
    entries.push({ nodeId: cloudId, total: n.total, filled: n.filled, filledAi: n.filledAi });
  }
  return entries;
}

export async function statusCommand(opts: StatusOptions): Promise<void> {
  const graph = runScan(opts.rootDir);
  const report = buildImplementationReport(graph, readGeneratedManifest(opts.rootDir));

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    render(report);
  }

  if (opts.report) {
    const config = readProjectConfig(opts.rootDir);
    if (!config?.projectId) {
      console.error(pc.red("Cannot report: no linked project (run `solarch link`)."));
      process.exitCode = 1;
      return;
    }
    const entries = toImplementationEntries(report, readMatchCache(opts.rootDir));
    if (entries.length > 0) {
      const api = SolarchApi.fromStoredCredentials();
      await api.reportImplementation(config.projectId, entries);
      console.log(pc.dim(`Reported implementation status for ${entries.length} node(s) to Solarch Cloud.`));
    }
  }

  const blockers = report.totals.skeletons + report.totals.violations + report.lostMarkers.length;
  if (opts.ci && blockers > 0) {
    console.error(
      pc.red(
        `\n${report.totals.skeletons} unimplemented, ${report.totals.violations} contract violation(s), ` +
          `${report.lostMarkers.length} marker loss(es) — failing (--ci).`,
      ),
    );
    process.exitCode = 1;
  }
}

function render(report: ImplementationReport): void {
  const { totals } = report;
  if (totals.members === 0 && report.lostMarkers.length === 0) {
    console.log(pc.dim("No surgical markers found — this codebase has no generated scaffolds (or they were hand-rewritten)."));
    return;
  }

  const pct = totals.members > 0 ? Math.round((totals.filled / totals.members) * 100) : 0;
  console.log(
    pc.bold(`Implementation status`) +
      pc.dim(
        ` — ${totals.filled}/${totals.members} member(s) implemented (${pct}%)` +
          (totals.filledAi > 0 ? `, ${totals.filledAi} by AI` : ""),
      ),
  );
  console.log("");

  for (const n of report.nodes) {
    const done = n.filled === n.total && n.violators.length === 0;
    const bar = done ? pc.green("●") : n.violators.length > 0 ? pc.red("●") : n.filled === 0 ? pc.red("●") : pc.yellow("●");
    console.log(`  ${bar} ${pc.bold(n.name)} ${pc.dim(`(${n.kind})`)} ${n.filled}/${n.total} ${pc.dim(n.file)}`);
    for (const s of n.skeletons) {
      console.log(`      ${pc.red("✗")} ${s.member} ${pc.dim(`:${s.line}`)}${s.description ? pc.dim(` — ${s.description.split("\n")[0]}`) : ""}`);
    }
    for (const v of n.violators) {
      for (const msg of v.violations ?? []) {
        console.log(`      ${pc.red("✗")} contract: ${v.member} ${pc.dim(`:${v.line}`)} — ${msg}`);
      }
    }
  }

  if (report.lostMarkers.length > 0) {
    console.log("");
    console.log(pc.yellow(`Marker loss (${report.lostMarkers.length}):`));
    for (const l of report.lostMarkers) {
      console.log(pc.yellow(`  ! ${l.file} — generated with ${l.expected} marker(s), none found now. Tracking is blind here.`));
    }
  }

  console.log("");
  if (totals.skeletons > 0 || totals.violations > 0 || report.lostMarkers.length > 0) {
    const parts: string[] = [];
    if (totals.skeletons > 0) parts.push(`${totals.skeletons} member(s) waiting`);
    if (totals.violations > 0) parts.push(`${totals.violations} contract violation(s)`);
    if (report.lostMarkers.length > 0) parts.push(`${report.lostMarkers.length} file(s) with lost markers`);
    console.log(pc.yellow(parts.join(", ") + "."));
  } else {
    console.log(pc.green("All generated scaffolds are implemented and within contract."));
  }
}
