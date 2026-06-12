/** Drift raporu çıktıları: renkli TTY tablosu, --json, --ci (GitHub annotations). */

import pc from "picocolors";
import type { DiffResult, DriftFinding, Severity } from "./engine.js";

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

function sorted(findings: DriftFinding[]): DriftFinding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function renderTty(result: DiffResult): string {
  const lines: string[] = [];
  const { errors, warns, infos } = result.counts;

  if (result.findings.length === 0) {
    lines.push(pc.green("✓ No drift — the code matches the architecture."));
    lines.push(pc.dim(`  ${result.matched} node(s) matched.`));
    return lines.join("\n");
  }

  const badge = (s: Severity): string =>
    s === "error" ? pc.red("ERROR") : s === "warn" ? pc.yellow("WARN ") : pc.dim("INFO ");

  for (const f of sorted(result.findings)) {
    lines.push(`${badge(f.severity)} ${pc.dim(f.code)}`);
    lines.push(`      ${f.message}`);
    if (f.suggestion) lines.push(pc.dim(`      → ${f.suggestion}`));
  }

  lines.push("");
  const counts: string[] = [];
  if (errors > 0) counts.push(pc.red(`${errors} error(s)`));
  if (warns > 0) counts.push(pc.yellow(`${warns} warning(s)`));
  if (infos > 0) counts.push(pc.dim(`${infos} info`));
  lines.push(`${counts.join(", ")} — ${result.matched} node(s) matched.`);
  if (errors > 0) {
    lines.push(pc.red("Architecture drift detected. Fix the errors above (or update the canvas) before merging."));
  }
  return lines.join("\n");
}

export function renderJson(result: DiffResult): string {
  return JSON.stringify(
    { counts: result.counts, matched: result.matched, findings: result.findings },
    null,
    2,
  );
}

/** GitHub Actions annotation formatı — PR diff'inde satır içi görünür. */
export function renderCi(result: DiffResult): string {
  const lines: string[] = [];
  for (const f of sorted(result.findings)) {
    const level = f.severity === "error" ? "error" : f.severity === "warn" ? "warning" : "notice";
    const fileAttr = f.file ? `file=${f.file},` : "";
    const msg = f.suggestion ? `${f.message} → ${f.suggestion}` : f.message;
    // ::error file=app.ts,title=DRIFT_X::mesaj
    lines.push(`::${level} ${fileAttr}title=${f.code}::${msg.replace(/\n/g, " ")}`);
  }
  const { errors, warns, infos } = result.counts;
  lines.push(`Drift check: ${errors} error(s), ${warns} warning(s), ${infos} info — ${result.matched} matched.`);
  return lines.join("\n");
}
