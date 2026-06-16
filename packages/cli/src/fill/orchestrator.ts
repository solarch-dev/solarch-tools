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
import { FILL_SYSTEM, buildFillUser } from "./prompt.js";
import { stripCodeFences, type LlmConfig } from "./llm.js";
import { runToolAgent, type AgentTool, type ChatTransport, type ToolResolver } from "./agent.js";
import { generateSpecForService, type SpecResult } from "./spec.js";
import { runTests, runTypecheck, type VerifyResult } from "./verify.js";

/** verify_fill tool şeması — model gövdeyi `code` ile verir; sistem validator'ları
 *  koşar (syntax + contract + throws-realization) ve temizse commit eder. */
const VERIFY_FILL_TOOL: AgentTool = {
  name: "verify_fill",
  description:
    "Validate and commit your method-body implementation. Pass the raw TypeScript statements that go inside the " +
    "method body (no signature, no braces, no fences). Returns {ok:true} when it passes every check (valid syntax, " +
    "honors the throws/deps contract, and realizes every declared exception), otherwise {ok:false, violations:[...]} " +
    "listing exactly what to fix. Call it again with corrected code until it returns ok.",
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "The method body statements (TypeScript)." } },
    required: ["code"],
    additionalProperties: false,
  },
};

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
  /** Tool-calling ajanının konuştuğu LLM (OpenAI-uyumlu endpoint). */
  llm: LlmConfig;
  /** Test/sahte transport — verilirse ağ yerine bu kullanılır (üretimde boş). */
  transport?: ChatTransport;
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

/** Tek bölgeyi doldur — izole, TOOL-CALLING ajanıyla. Model `verify_fill` çağırır;
 *  sistem deterministik validator'ları (syntax + contract + throws-realization)
 *  koşar ve YALNIZ temizse diske commit eder (ast-core dosyayı her çağrıda taze
 *  yükler → başarısız deneme stub'ı bozmaz). Ajan yeşile (ok) ya da tur-tavanına
 *  kadar döner. `feedback` (önceki tsc/kontrat turu) ajanın ilk mesajına tohumlanır. */
export async function fillRegion(target: RegionTarget, opts: FillOptions, feedback?: string[]): Promise<FillRegionResult> {
  const base = { nodeId: target.nodeId, member: target.member.member, file: target.file };
  const filePath = join(opts.rootDir, target.file);

  const parts = readFillContext(filePath, target.className, target.member.member);
  if (!parts) return { ...base, status: "error", attempts: 0, error: `region not found in ${target.file}` };
  // Grounding: import edilen tiplerin gerçek API yüzeyi (zemin gerçeği; tsc dayatır).
  const ctx = { className: target.className, ...parts, apiSurface: readDeclaredSurface(filePath) };

  let lastViolations: string[] | undefined;
  let toolError: string | undefined;
  const resolve: ToolResolver = async (call) => {
    const code = typeof call.args?.code === "string" ? call.args.code.trim() : "";
    if (!code) return { content: JSON.stringify({ ok: false, violations: ["empty code — pass the method body statements in `code`"] }) };
    const res = tryFillSurgicalBody(filePath, target.className, target.member.member, stripCodeFences(code), new Date().toISOString());
    if (!res.ok) {
      toolError = res.error;
      return { content: JSON.stringify({ ok: false, violations: [res.error] }) };
    }
    if ((res.violations?.length ?? 0) === 0) {
      return { content: JSON.stringify({ ok: true }), done: true, result: true };
    }
    lastViolations = res.violations;
    return { content: JSON.stringify({ ok: false, violations: res.violations }) };
  };

  let agent;
  try {
    agent = await runToolAgent({
      config: opts.llm,
      transport: opts.transport,
      system: FILL_SYSTEM,
      user: buildFillUser(target.member, ctx, feedback),
      tools: [VERIFY_FILL_TOOL],
      resolve,
      forceFirstTool: "verify_fill",
      maxRounds: opts.maxAttempts ?? 5,
    });
  } catch (e) {
    return { ...base, status: "error", attempts: 0, error: (e as Error).message };
  }

  if (agent.result === true) return { ...base, status: "filled", attempts: agent.rounds };
  if (toolError && !lastViolations) return { ...base, status: "error", attempts: agent.rounds, error: toolError };
  // Yeşile ulaşamadı → ast-core kaydetmedi (disk hâlâ iskelet stub).
  return { ...base, status: "violation", attempts: agent.rounds, violations: lastViolations };
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
    // ÖNCE eksik import'ları ekle: önceki turun yeniden-dolumları yeni yerel tip
    // (enum/entity) kullanmış olabilir; AI import ekleyemez (yalnız gövde yazar) →
    // bunu dil servisi yapar. Aksi halde TS2304 deterministik olmayan şekilde kalır.
    try {
      fixMissingImportsInFiles(opts.rootDir, filledFiles);
    } catch {
      /* en iyi çaba */
    }
    typecheck = runTypecheck(opts.rootDir);
    if (typecheck.ok) break;
    const errsByFile = tscErrorsByFile(opts.rootDir, typecheck.output);
    let repaired = 0;
    for (const [key, t] of byKey) {
      const r = results.get(key);
      if (r?.status !== "filled") continue; // yalnız başarılı dolumları onar
      // Import hatalarını (TS2304 Cannot find name) AI'a VERME — onları import-fix
      // kapatır; AI'a vermek boşa tur (gövde yazar, import ekleyemez).
      const fileErrs = (errsByFile.get(t.file) ?? []).filter((e) => !/Cannot find name/.test(e));
      if (fileErrs.length === 0) continue;
      const rr = await fillRegion(t, opts, [`tsc errors in ${t.file} — fix your method so the file compiles:`, ...fileErrs.slice(0, 12)]);
      results.set(key, rr);
      repaired++;
      opts.onProgress?.({ ...rr, member: `${rr.member} (repair r${round})` });
    }
    if (repaired === 0) break; // düzeltilebilir (import-dışı) hata kalmadı
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
      const sr = await generateSpecForService(opts.rootDir, f, opts.llm, { transport: opts.transport });
      report.specs.push(sr);
      opts.onProgress?.({
        nodeId: "",
        member: `spec ${f}${sr.status === "written" ? (sr.passed ? " (jest ✓)" : " (jest ✗ residual)") : ""}`,
        file: f,
        status: sr.status === "written" ? "filled" : "error",
        attempts: sr.rounds ?? 1,
        error: sr.error,
      });
    }
  }

  if (!opts.skipVerify) {
    report.typecheck = typecheck ?? runTypecheck(opts.rootDir);
    if (report.typecheck.ok || report.filled > 0) report.tests = runTests(opts.rootDir);
  }
  return report;
}
