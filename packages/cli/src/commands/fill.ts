/** solarch fill — surgical AI body filler.
 *
 *  Replaces NOT_IMPLEMENTED skeleton bodies with real implementations that honor
 *  each region's surgical contract (throws/deps/signature). Per region: LLM →
 *  write → contract check → retry; then tsc + test gates over the project.
 *  Only contract-passing fills are saved; failures keep their stub. */

import pc from "picocolors";
import { createCompleter, llmConfigFromEnv } from "../fill/llm.js";
import { fillProject, type FillRegionResult } from "../fill/orchestrator.js";

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
  if (!opts.region && !opts.all) {
    console.error(pc.red("Nothing selected. Use --all, or --region <nodeId#member>."));
    process.exitCode = 1;
    return;
  }
  const config = llmConfigFromEnv();
  if (!config.apiKey) {
    console.error(pc.red("No LLM API key. Set DEEPSEEK_API_KEY (or SOLARCH_FILL_API_KEY) in the environment."));
    process.exitCode = 1;
    return;
  }
  console.log(pc.dim(`Filling skeletons with ${config.model}`));

  const report = await fillProject({
    rootDir: opts.rootDir,
    complete: createCompleter(config),
    region: opts.region,
    maxAttempts: opts.attempts,
    skipVerify: opts.skipVerify,
    onProgress: printRegion,
  });

  if (report.regions.length === 0) {
    console.log(pc.green("No skeleton regions to fill — everything is already implemented."));
    return;
  }

  console.log("");
  console.log(pc.bold(`Filled ${report.filled} · contract failures ${report.violations} · errors ${report.errors}`));
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
