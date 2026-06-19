/** Surgical fill orchestrator.
 *
 *  Per region (isolated): load the file fresh → build a contract-aware prompt →
 *  LLM → writeSurgicalBody → checkContract → retry feeding violations back, up to
 *  maxAttempts. A contract-passing fill is saved to disk; a region that never
 *  passes leaves its NOT_IMPLEMENTED stub untouched (failures never persist).
 *  After all regions: tsc + test gates over the whole project (the heavy,
 *  high-signal verification the user asked for).
 *
 *  DETERMINISM (IntelliSense-style): the AI writes SEMANTICS (control flow, which
 *  member/dep/exception it means); the SYSTEM resolves IDENTITY of owned (src/)
 *  types. Two mechanisms, both reusing ast-core's closed-world type resolution:
 *    - lookup_members(type): on-demand generator (completeType) the agent queries
 *      for the EXACT members/enum-literals/exception-ctor before referencing them.
 *    - autoCorrectMembers (in writeSurgicalBody): snaps a unique near-miss
 *      (user.id → user.Id) to the real member BEFORE validation. Ambiguous/invented
 *      members are left for checkMemberAccess to reject. The model never invents an
 *      owned identifier; library (node_modules) members + arity stay tsc's job.
 *
 *  FUTURE (parked, self-hosted-only): grammar/logit-constrained decoding — make an
 *  invalid identifier physically un-emittable. Blocked by the hosted DeepSeek
 *  /chat/completions transport (no logit_bias/grammar/response_format; see agent.ts);
 *  would need vLLM/llama.cpp with allowedMembersForReceiver (membersOf) as the mask.
 *  Not built; the closed-world member set is already computed for the two paths above. */

import { join } from "node:path";
import { completeType, fixMissingImportsInFiles, readDeclaredSurface, readExpectedTypeHeaders, readFillContext, readProjectCatalog, tryFillSurgicalBody, type SurgicalMember } from "@solarch/ast-core";
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

/** lookup_members tool — IntelliSense: salt-okunur. Bir owned (proje) tip ADINI
 *  verince GERÇEK üyelerini / metot imzalarını / enum literal'lerini / exception
 *  ctor'unu döndürür. Model bir üye/enum/exception yazımından EMİN DEĞİLSE bunu
 *  çağırır, uydurmaz. `done` döndürmez → agent loop devam eder. */
const LOOKUP_MEMBERS_TOOL: AgentTool = {
  name: "lookup_members",
  description:
    "Look up the EXACT members of an owned (project) type before you reference them — never guess an identifier. " +
    "Pass a class/enum/exception name from the API surface (e.g. User, OrderStatus, NotFoundException). Returns its " +
    "real members/method signatures (class), literals (enum), or constructor (exception); {kind:'unknown'} if the " +
    "type is third-party/not in scope. Use the returned spelling/casing verbatim.",
  parameters: {
    type: "object",
    properties: { type: { type: "string", description: "An owned class/enum/exception name from the API surface." } },
    required: ["type"],
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
  /** Diske yazılan (doğrulanmış) gövde — status="filled" iken dolu. Sunucu bunu
   *  bölge-bazında kalıcı saklar (re-open'da dolu görünsün, re-fill kaldığı yerden). */
  body?: string;
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

/** Doğrulama/onarım fazı olayları — bölge-dışı (proje geneli) ilerleme. UI/SSE
 *  "tsc koştu → N hata → şu bölgeyi onarıyorum → testler" akışını canlı göstersin
 *  diye yayınlanır (kullanıcı "yapılan işlemde output ne geliyor incelensin" dedi). */
export type FillPhase =
  | { kind: "imports"; files: number }
  | { kind: "verify"; round: number; ok: boolean; errorCount: number }
  | { kind: "repair"; round: number; file: string; member: string }
  | { kind: "tests"; ok: boolean; skipped: boolean };

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
  /** Eşzamanlı doldurulacak DOSYA sayısı (varsayılan 1 = sıralı). Aynı dosyanın
   *  bölgeleri her zaman tek worker'da sıralı kalır (ts-morph saveSync race'i yok). */
  concurrency?: number;
  /** Projedeki tüm owned tiplerin kataloğu (whole-codebase farkındalığı). fillProject
   *  BİR KEZ kurar (readProjectCatalog) ve tüm bölge işlerine taşır — her fillRegion
   *  tüm src'yi yeniden yüklemesin. Tek-bölge çağrılarında boş kalabilir. */
  projectCatalog?: string;
  /** Bölge tamamlandığında çağrılır (ilerleme). */
  onProgress?: (r: FillRegionResult) => void;
  /** Doğrulama/onarım fazı ilerlemesi (proje geneli) — opsiyonel. */
  onPhase?: (p: FillPhase) => void;
}

/** Bölge dolum işlerini DOSYA-bazında paralel koştur: gruplar paralel (concurrency
 *  cap), grup içi sıralı. Aynı dosya tek worker'da kalır → iki paralel saveSync ile
 *  birbirini ezme yok. concurrency<=1 → tamamen sıralı (eski davranış). */
async function runFillJobs(
  jobs: { target: RegionTarget; feedback?: string[] }[],
  opts: FillOptions,
  onResult: (key: string, r: FillRegionResult) => void,
): Promise<void> {
  const byFile = new Map<string, { target: RegionTarget; feedback?: string[] }[]>();
  for (const j of jobs) (byFile.get(j.target.file) ?? byFile.set(j.target.file, []).get(j.target.file)!).push(j);
  const groups = [...byFile.values()];
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, groups.length || 1));

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= groups.length) return;
      for (const j of groups[i]!) {
        const r = await fillRegion(j.target, opts, j.feedback);
        onResult(`${j.target.file}#${j.target.member.member}`, r);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
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
  // Grounding (whole-codebase farkındalığı): (1) dosyanın import yüzeyi, (2) ChatLSP
  // "headers" — metodun üretmesi/tüketmesi gereken tiplerin gerçek şekli (dönüş+param,
  // transitif), (3) Aider repo-map — projenin tüm owned tip kataloğu (lookup_members için).
  const ctx = {
    className: target.className,
    ...parts,
    apiSurface: readDeclaredSurface(filePath),
    expectedTypes: readExpectedTypeHeaders(filePath, target.className, target.member.member),
    catalog: opts.projectCatalog ?? readProjectCatalog(opts.rootDir),
  };

  let lastViolations: string[] | undefined;
  let toolError: string | undefined;
  let filledBody: string | undefined; // diske yazılan doğrulanmış gövde (kalıcı sakla)
  const resolve: ToolResolver = async (call) => {
    // lookup_members (IntelliSense, salt-okunur): GERÇEK üyeleri döndür, loop devam eder.
    if (call.name === "lookup_members") {
      const typeName = typeof call.args?.type === "string" ? call.args.type.trim() : "";
      if (!typeName) return { content: JSON.stringify({ error: "pass an owned type name in `type`" }) };
      return { content: JSON.stringify(completeType(filePath, typeName)) };
    }
    // verify_fill (varsayılan): doğrula + temizse commit.
    const code = typeof call.args?.code === "string" ? call.args.code.trim() : "";
    if (!code) return { content: JSON.stringify({ ok: false, violations: ["empty code — pass the method body statements in `code`"] }) };
    const body = stripCodeFences(code);
    // checkTypes: bölge-bazında tip teşhisi (diagnostics-in-loop) — AST temizse dil-
    // servisiyle cast/null/yanlış-dönüş/arity'yi ANINDA denetle; model kendi bölgesini
    // tam bağlamla gördüğü bu döngüde düzeltsin (tsc'nin sondaki topluca turunu beklemeden).
    const res = tryFillSurgicalBody(filePath, target.className, target.member.member, body, new Date().toISOString(), {
      rootDir: opts.rootDir,
      checkTypes: true,
    });
    if (!res.ok) {
      toolError = res.error;
      return { content: JSON.stringify({ ok: false, violations: [res.error] }) };
    }
    // Deterministik snap'leri (user.id -> user.Id) agent'a BİLGİ olarak ekle (ihlal değil).
    const corrected = res.corrections && res.corrections.length > 0 ? { corrected: res.corrections } : {};
    if ((res.violations?.length ?? 0) === 0) {
      // Snap SONRASI gövdeyi sakla (disk düzeltilmiş; re-inject'te de doğru kalsın).
      filledBody = (res.body ?? body).trim();
      return { content: JSON.stringify({ ok: true, ...corrected }), done: true, result: true };
    }
    lastViolations = res.violations;
    return { content: JSON.stringify({ ok: false, violations: res.violations, ...corrected }) };
  };

  let agent;
  try {
    agent = await runToolAgent({
      config: opts.llm,
      transport: opts.transport,
      system: FILL_SYSTEM,
      user: buildFillUser(target.member, ctx, feedback),
      tools: [VERIFY_FILL_TOOL, LOOKUP_MEMBERS_TOOL],
      resolve,
      forceFirstTool: "verify_fill",
      maxRounds: opts.maxAttempts ?? 5,
    });
  } catch (e) {
    return { ...base, status: "error", attempts: 0, error: (e as Error).message };
  }

  if (agent.result === true) return { ...base, status: "filled", attempts: agent.rounds, body: filledBody };
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
  // Proje tip kataloğunu BİR KEZ kur (whole-codebase farkındalığı) → tüm bölgelere
  // taşı; her fillRegion src'yi yeniden yüklemesin (per-bölge maliyet yok).
  opts = { ...opts, projectCatalog: opts.projectCatalog ?? readProjectCatalog(opts.rootDir) };
  const targets = selectSkeletons(opts.rootDir, opts.region);
  const byKey = new Map<string, RegionTarget>();
  for (const t of targets) byKey.set(`${t.file}#${t.member.member}`, t);

  const results = new Map<string, FillRegionResult>();
  // İlk dolum — dosya-bazında paralel (grup içi sıralı; aynı dosya tek worker'da).
  await runFillJobs(
    targets.map((t) => ({ target: t })),
    opts,
    (key, r) => {
      results.set(key, r);
      opts.onProgress?.(r);
    },
  );

  // Dolan gövdeler yerel tip kullanıp import ekleyemez → eksik import'ları topluca ekle.
  const filledFiles = [...new Set([...results.values()].filter((r) => r.status === "filled").map((r) => r.file))];
  if (filledFiles.length > 0) {
    try {
      fixMissingImportsInFiles(opts.rootDir, filledFiles);
    } catch {
      /* en iyi çaba */
    }
    opts.onPhase?.({ kind: "imports", files: filledFiles.length });
  }

  // Katman 3 — tsc onarım döngüsü: tsc patlarsa, hatalı dosyadaki dolu bölgeleri
  // o dosyanın derleyici hatalarını geri besleyerek yeniden doldur. ≤3 tur
  // (gerçek projede her tur hatayı ~yarıya indiriyor: 21→8→3→~0).
  let typecheck: VerifyResult | undefined;
  const maxRepairRounds = opts.skipVerify ? 0 : 3;
  let lastRepaired = 0;
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
    const errorCount = (typecheck.output.match(/error TS/g) ?? []).length;
    opts.onPhase?.({ kind: "verify", round, ok: typecheck.ok, errorCount });
    lastRepaired = 0;
    if (typecheck.ok) break;
    const errsByFile = tscErrorsByFile(opts.rootDir, typecheck.output);
    // Onarılacak işleri topla: yalnız başarılı dolumlar + (import-dışı) tsc hatası olan dosyalar.
    const repairJobs: { target: RegionTarget; feedback: string[] }[] = [];
    for (const [key, t] of byKey) {
      const r = results.get(key);
      if (r?.status !== "filled") continue;
      // Import hatalarını (TS2304 Cannot find name) AI'a VERME — onları import-fix
      // kapatır; AI'a vermek boşa tur (gövde yazar, import ekleyemez).
      const fileErrs = (errsByFile.get(t.file) ?? []).filter((e) => !/Cannot find name/.test(e));
      if (fileErrs.length === 0) continue;
      repairJobs.push({ target: t, feedback: [`tsc errors in ${t.file} — fix your method so the file compiles:`, ...fileErrs.slice(0, 12)] });
    }
    if (repairJobs.length === 0) break; // düzeltilebilir (import-dışı) hata kalmadı
    // Onarımlar da dosya-bazında paralel.
    await runFillJobs(repairJobs, opts, (key, rr) => {
      results.set(key, rr);
      opts.onPhase?.({ kind: "repair", round, file: rr.file, member: rr.member });
      // Region event TEMİZ kalsın (nodeId#member + body keylenir); onarım bilgisi phase'de.
      opts.onProgress?.(rr);
    });
    lastRepaired = repairJobs.length;
  }
  // Son turun onarımları henüz ÖLÇÜLMEDİYSE bir kez daha doğrula → report.typecheck
  // GERÇEK final durumu yansıtsın (aksi halde son-tur onarımları rapora geçmez).
  if (lastRepaired > 0 && !opts.skipVerify) {
    try {
      fixMissingImportsInFiles(opts.rootDir, filledFiles);
    } catch {
      /* en iyi çaba */
    }
    typecheck = runTypecheck(opts.rootDir);
    const errorCount = (typecheck.output.match(/error TS/g) ?? []).length;
    opts.onPhase?.({ kind: "verify", round: maxRepairRounds + 1, ok: typecheck.ok, errorCount });
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
    if (report.typecheck.ok || report.filled > 0) {
      report.tests = runTests(opts.rootDir);
      opts.onPhase?.({ kind: "tests", ok: report.tests.ok, skipped: report.tests.skipped ?? false });
    }
  }
  return report;
}
