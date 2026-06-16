/** solarch fill — surgical AI body filler.
 *
 *  Replaces NOT_IMPLEMENTED skeleton bodies with real implementations that honor
 *  each region's surgical contract (throws/deps/signature). Per region: LLM →
 *  write → contract check → retry; then tsc + test gates over the project.
 *  Only contract-passing fills are saved; failures keep their stub. */

import pc from "picocolors";
import { llmConfigFromEnv } from "../fill/llm.js";
import { fillProject, selectSkeletons, type FillRegionResult } from "../fill/orchestrator.js";

export interface FillCommandOptions {
  rootDir: string;
  /** Tek bölge: "<nodeId>#<member>" veya "<member>". */
  region?: string;
  /** Tüm iskeletleri doldur. */
  all?: boolean;
  /** Bölge başına kontrat-retry tavanı (varsayılan 3). */
  attempts?: number;
  /** tsc + test geçitlerini atla. */
  skipVerify?: boolean;
  /** Dolu servisler için gerçek davranış spec'i üret (Layer 4). */
  withTests?: boolean;
  /** Makine-okur NDJSON ilerleme (renkli metin yerine). Sunucu fill servisi bunu
   *  parse edip SSE'ye çevirir: bölge başına bir satır + sonda bir `report`. */
  json?: boolean;
}

function printRegion(r: FillRegionResult): void {
  if (r.status === "filled") {
    console.log(`  ${pc.green("✓")} ${r.member} ${pc.dim(`(${r.attempts} attempt${r.attempts > 1 ? "s" : ""})`)}`);
  } else if (r.status === "violation") {
    console.log(`  ${pc.yellow("⚠")} ${r.member} — contract not met after ${r.attempts}: ${r.violations?.join("; ")}`);
  } else {
    console.log(`  ${pc.red("✗")} ${r.member} — ${r.error}`);
  }
}

export async function fillCommand(opts: FillCommandOptions): Promise<void> {
  const emit = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify(o) + "\n");
  if (!opts.region && !opts.all) {
    if (opts.json) emit({ event: "fatal", message: "Nothing selected. Use --all or --region." });
    else console.error(pc.red("Nothing selected. Use --all, or --region <nodeId#member>."));
    process.exitCode = 1;
    return;
  }
  const config = llmConfigFromEnv();
  if (!config.apiKey) {
    if (opts.json) emit({ event: "fatal", message: "No LLM API key (DEEPSEEK_API_KEY / SOLARCH_FILL_API_KEY)." });
    else console.error(pc.red("No LLM API key. Set DEEPSEEK_API_KEY (or SOLARCH_FILL_API_KEY) in the environment."));
    process.exitCode = 1;
    return;
  }
  if (!opts.json) console.log(pc.dim(`Filling skeletons with ${config.model}`));

  // json: gerçek doldurulacak bölge sayısını BAŞTA bildir — UI sayacının paydası
  // bu olsun (surgical-marker sayısı ≠ skeleton-bölge sayısı olabilir).
  if (opts.json) {
    try {
      emit({ event: "begin", total: selectSkeletons(opts.rootDir, opts.region).length });
    } catch {
      /* tarama başarısızsa begin atlanır; UI marker sayısına düşer */
    }
  }

  const report = await fillProject({
    rootDir: opts.rootDir,
    llm: config,
    region: opts.region,
    maxAttempts: opts.attempts,
    skipVerify: opts.skipVerify,
    withTests: opts.withTests,
    onProgress: opts.json
      ? (r) => emit({ event: "region", status: r.status, member: r.member, file: r.file, attempts: r.attempts, violations: r.violations, error: r.error })
      : printRegion,
  });

  if (opts.json) {
    emit({
      event: "report",
      filled: report.filled,
      violations: report.violations,
      errors: report.errors,
      specs: report.specs?.map((s) => ({ file: s.file, status: s.status, passed: s.passed })),
      typecheck: report.typecheck ? { ok: report.typecheck.ok } : undefined,
      tests: report.tests ? { ok: report.tests.ok, skipped: report.tests.skipped } : undefined,
    });
    if (report.violations > 0 || report.errors > 0 || (report.typecheck && !report.typecheck.ok)) process.exitCode = 1;
    return;
  }

  if (report.regions.length === 0) {
    console.log(pc.green("No skeleton regions to fill — everything is already implemented."));
    return;
  }

  console.log("");
  console.log(pc.bold(`Filled ${report.filled} · contract failures ${report.violations} · errors ${report.errors}`));
  if (report.specs && report.specs.length > 0) {
    const ok = report.specs.filter((s) => s.status === "written").length;
    console.log(pc.bold(`Generated ${ok}/${report.specs.length} behavioural specs`));
  }
  if (report.typecheck) {
    console.log(report.typecheck.ok ? pc.green("✓ typecheck clean") : pc.red(`✗ typecheck failed:\n${report.typecheck.output}`));
  }
  if (report.tests && !report.tests.skipped) {
    console.log(report.tests.ok ? pc.green("✓ tests passed") : pc.red(`✗ tests failed:\n${report.tests.output}`));
  } else if (report.tests?.skipped) {
    console.log(pc.dim(`tests: ${report.tests.output}`));
  }

  const gateFailed =
    report.violations > 0 ||
    report.errors > 0 ||
    (report.typecheck && !report.typecheck.ok) ||
    (report.tests && !report.tests.ok && !report.tests.skipped);
  if (gateFailed) process.exitCode = 1;
}
