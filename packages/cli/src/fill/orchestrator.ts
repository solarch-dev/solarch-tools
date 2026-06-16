/** Surgical fill orchestrator.
 *
 *  Per region (isolated): load the file fresh → build a contract-aware prompt →
 *  LLM → writeSurgicalBody → checkContract → retry feeding violations back, up to
 *  maxAttempts. A contract-passing fill is saved to disk; a region that never
 *  passes leaves its NOT_IMPLEMENTED stub untouched (failures never persist).
 *  After all regions: tsc + test gates over the whole project (the heavy,
 *  high-signal verification the user asked for). */

import { join } from "node:path";
import { readFillContext, tryFillSurgicalBody, type SurgicalMember } from "@solarch/ast-core";
import { runScan } from "../commands/scan.js";
import { buildFillPrompt } from "./prompt.js";
import { stripCodeFences, type CompleteFn } from "./llm.js";
import { runTests, runTypecheck, type VerifyResult } from "./verify.js";

export interface RegionTarget {
  nodeId: string;
  className: string;
  file: string; // proje köküne göreli
  member: SurgicalMember;
}

export interface FillRegionResult {
  nodeId: string;
  member: string;
  file: string;
  status: "filled" | "violation" | "error";
  attempts: number;
  violations?: string[];
  error?: string;
}

export interface FillReport {
  regions: FillRegionResult[];
  filled: number;
  violations: number;
  errors: number;
  typecheck?: VerifyResult;
  tests?: VerifyResult;
}

export interface FillOptions {
  rootDir: string;
  complete: CompleteFn;
  /** Tek bölge: "<nodeId>#<member>" veya yalnız "<member>". Yoksa tüm iskeletler. */
  region?: string;
  maxAttempts?: number;
  /** tsc + test geçitlerini atla (yalnız kontrat). */
  skipVerify?: boolean;
  /** Bölge tamamlandığında çağrılır (ilerleme). */
  onProgress?: (r: FillRegionResult) => void;
}

/** Taranan graftan doldurulacak iskelet bölgeleri seç. */
export function selectSkeletons(rootDir: string, region?: string): RegionTarget[] {
  const asIs = runScan(rootDir);
  const targets: RegionTarget[] = [];
  for (const node of asIs.nodes) {
    for (const m of node.surgical ?? []) {
      if (m.status !== "skeleton") continue;
      if (region && region !== `${m.nodeId}#${m.member}` && region !== m.member) continue;
      targets.push({ nodeId: m.nodeId, className: node.name, file: node.file, member: m });
    }
  }
  return targets;
}

/** Tek bölgeyi doldur — izole. ast-core her denemede dosyayı taze yükler ve yalnız
 *  sözleşmeye uyan dolumu diske yazar; başarısız denemeler stub'ı bozmaz. */
export async function fillRegion(target: RegionTarget, opts: FillOptions): Promise<FillRegionResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const base = { nodeId: target.nodeId, member: target.member.member, file: target.file };
  const filePath = join(opts.rootDir, target.file);

  const parts = readFillContext(filePath, target.className, target.member.member);
  if (!parts) return { ...base, status: "error", attempts: 0, error: `region not found in ${target.file}` };
  const ctx = { className: target.className, ...parts };

  let violations: string[] | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let body: string;
    try {
      body = stripCodeFences(await opts.complete(buildFillPrompt(target.member, ctx, violations)));
    } catch (e) {
      return { ...base, status: "error", attempts: attempt, error: (e as Error).message };
    }
    const res = tryFillSurgicalBody(filePath, target.className, target.member.member, body, new Date().toISOString());
    if (!res.ok) return { ...base, status: "error", attempts: attempt, error: res.error };
    violations = res.violations;
    if ((violations?.length ?? 0) === 0) return { ...base, status: "filled", attempts: attempt };
  }
  // Sözleşme hiç tutmadı → ast-core kaydetmedi (disk hâlâ iskelet stub).
  return { ...base, status: "violation", attempts: maxAttempts, violations };
}

/** Tüm seçili iskeletleri doldur + tsc/test geçitleri. */
export async function fillProject(opts: FillOptions): Promise<FillReport> {
  const targets = selectSkeletons(opts.rootDir, opts.region);
  const regions: FillRegionResult[] = [];
  for (const t of targets) {
    const r = await fillRegion(t, opts);
    regions.push(r);
    opts.onProgress?.(r);
  }

  const report: FillReport = {
    regions,
    filled: regions.filter((r) => r.status === "filled").length,
    violations: regions.filter((r) => r.status === "violation").length,
    errors: regions.filter((r) => r.status === "error").length,
  };

  // Geçitler — yalnız en az bir bölge dolduysa ve atlanmadıysa.
  if (!opts.skipVerify && report.filled > 0) {
    report.typecheck = runTypecheck(opts.rootDir);
    report.tests = runTests(join(opts.rootDir));
  }
  return report;
}
