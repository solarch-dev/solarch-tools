/** Surgical fill orchestrator.
 *
 *  Per region (isolated): load the file fresh → build a contract-aware prompt →
 *  LLM → writeSurgicalBody → checkContract → retry feeding violations back, up to
 *  maxAttempts. A contract-passing fill is saved to disk; a region that never
 *  passes leaves its NOT_IMPLEMENTED stub untouched (failures never persist).
 *  After all regions: tsc + test gates over the whole project (the heavy,
 *  high-signal verification the user asked for). */

import { join } from "node:path";
import { fixMissingImportsInFiles, readDeclaredSurface, readFillContext, tryFillSurgicalBody, type SurgicalMember } from "@solarch/ast-core";
import { runScan } from "../commands/scan.js";
import { buildFillPrompt } from "./prompt.js";
import { stripCodeFences, type CompleteFn } from "./llm.js";
import { generateSpecForService, type SpecResult } from "./spec.js";
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
  /** Layer 4 — üretilen davranış spec'leri (--with-tests). */
  specs?: SpecResult[];
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
  /** Layer 4 — dolu servisler için gerçek davranış spec'i üret (stub'ı ezer). */
  withTests?: boolean;
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
 *  sözleşmeye uyan dolumu diske yazar; başarısız denemeler stub'ı bozmaz.
 *  `feedback` (önceki tur tsc/kontrat hataları) ilk denemeye tohumlanır (onarım). */
export async function fillRegion(target: RegionTarget, opts: FillOptions, feedback?: string[]): Promise<FillRegionResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const base = { nodeId: target.nodeId, member: target.member.member, file: target.file };
  const filePath = join(opts.rootDir, target.file);

  const parts = readFillContext(filePath, target.className, target.member.member);
  if (!parts) return { ...base, status: "error", attempts: 0, error: `region not found in ${target.file}` };
  // Grounding: import edilen tiplerin gerçek API yüzeyi (halüsinasyonu keser).
  const ctx = { className: target.className, ...parts, apiSurface: readDeclaredSurface(filePath) };

  let violations: string[] | undefined = feedback;
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

/** tsc --noEmit çıktısını dosya yoluna göre hatalara böl (göreli yola normalize). */
function tscErrorsByFile(rootDir: string, output: string): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const m = /^(.+?\.ts)\(\d+,\d+\):\s*(error.*)$/.exec(line.trim());
    if (!m) continue;
    const rel = m[1]!.replace(`${rootDir}/`, "").replace(/^\.\//, "");
    (byFile.get(rel) ?? byFile.set(rel, []).get(rel)!).push(m[2]!.trim());
  }
  return byFile;
}

/** Tüm seçili iskeletleri doldur → tsc-repair turları → test geçidi. */
export async function fillProject(opts: FillOptions): Promise<FillReport> {
  const targets = selectSkeletons(opts.rootDir, opts.region);
  const byKey = new Map<string, RegionTarget>();
  for (const t of targets) byKey.set(`${t.file}#${t.member.member}`, t);

  const results = new Map<string, FillRegionResult>();
  for (const t of targets) {
    const r = await fillRegion(t, opts);
    results.set(`${t.file}#${t.member.member}`, r);
    opts.onProgress?.(r);
  }

  // Dolan gövdeler yerel tip kullanıp import ekleyemez → eksik import'ları topluca ekle.
  const filledFiles = [...new Set([...results.values()].filter((r) => r.status === "filled").map((r) => r.file))];
  if (filledFiles.length > 0) {
    try {
      fixMissingImportsInFiles(opts.rootDir, filledFiles);
    } catch {
      /* en iyi çaba */
    }
  }

  // Katman 3 — tsc onarım döngüsü: tsc patlarsa, hatalı dosyadaki dolu bölgeleri
  // o dosyanın derleyici hatalarını geri besleyerek yeniden doldur. ≤2 tur.
  let typecheck: VerifyResult | undefined;
  const maxRepairRounds = opts.skipVerify ? 0 : 2;
  for (let round = 1; round <= maxRepairRounds; round++) {
    typecheck = runTypecheck(opts.rootDir);
    if (typecheck.ok) break;
    const errsByFile = tscErrorsByFile(opts.rootDir, typecheck.output);
    let repaired = 0;
    for (const [key, t] of byKey) {
      const r = results.get(key);
      if (r?.status !== "filled") continue; // yalnız başarılı dolumları onar
      const fileErrs = errsByFile.get(t.file);
      if (!fileErrs || fileErrs.length === 0) continue;
      const rr = await fillRegion(t, opts, [`tsc errors in ${t.file} — fix your method so the file compiles:`, ...fileErrs.slice(0, 12)]);
      results.set(key, rr);
      repaired++;
      opts.onProgress?.({ ...rr, member: `${rr.member} (repair r${round})` });
    }
    if (repaired === 0) break; // hatalı dosyalarda dolu bölge yok → AI düzeltemez
  }

  const regions = [...results.values()];
  const report: FillReport = {
    regions,
    filled: regions.filter((r) => r.status === "filled").length,
    violations: regions.filter((r) => r.status === "violation").length,
    errors: regions.filter((r) => r.status === "error").length,
  };

  // Layer 4 — dolu servisler için gerçek davranış spec'i üret (NOT_IMPLEMENTED stub'ını ezer).
  // Jest geçidi artık dolu kodu DOĞRULAR (assume etmez).
  if (opts.withTests && report.filled > 0) {
    const serviceFiles = [
      ...new Set(regions.filter((r) => r.status === "filled" && r.file.endsWith(".service.ts")).map((r) => r.file)),
    ];
    report.specs = [];
    for (const f of serviceFiles) {
      const sr = await generateSpecForService(opts.rootDir, f, opts.complete);
      report.specs.push(sr);
      opts.onProgress?.({ nodeId: "", member: `spec ${f}`, file: f, status: sr.status === "written" ? "filled" : "error", attempts: 1, error: sr.error });
    }
    const written = report.specs.filter((s) => s.status === "written").map((s) => s.file);
    if (written.length > 0) {
      try {
        fixMissingImportsInFiles(opts.rootDir, written);
      } catch {
        /* en iyi çaba */
      }
    }
  }

  if (!opts.skipVerify) {
    report.typecheck = typecheck ?? runTypecheck(opts.rootDir);
    if (report.typecheck.ok || report.filled > 0) report.tests = runTests(opts.rootDir);
  }
  return report;
}
