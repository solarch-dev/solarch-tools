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
import { completeType, DiagnosticsPool, formatTypeShape, readDeclaredSurface, readExpectedTypeHeaders, readFillContext, readProjectCatalog, tryFillSurgicalBody, type CompleteTypeResult, type SurgicalMember, type WriteBodyResult } from "@solarch/ast-core";
import { read as readProjectFile, grep as grepProjectCode, glob as globProjectFiles } from "./fs-tools.js";
import { runScan } from "../commands/scan.js";
import { FILL_SYSTEM, buildFillUser, type FillContext } from "./prompt.js";
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
    "Look up the EXACT shape of an owned (project) type before you reference or construct it — never guess. " +
    "Pass a class/enum/exception/DTO name from the API surface (e.g. User, VideoDto, OrderStatus, NotFoundException). " +
    "Returns each field with its TYPE and NULLABILITY (e.g. `videoUrl: string`, `description?: string | undefined`), " +
    "method signatures, enum literals, or the exception constructor; 'not an owned type' if third-party/out of scope. " +
    "Use this to see whether a field is required or optional so you can bridge nullability (default or throw) instead of " +
    "assigning a nullable value to a required field.",
  parameters: {
    type: "object",
    properties: { type: { type: "string", description: "An owned class/enum/exception name from the API surface." } },
    required: ["type"],
    additionalProperties: false,
  },
};

/* ── CODEBASE KEŞİF ARAÇLARI (opencode / Claude Code'a BİREBİR uyarlı: read/grep/glob) ──
 * Model yazmadan ÖNCE gerçek kodu incelesin: entity/DTO tanımını TAM okusun, benzer bir
 * metodun nasıl yazıldığını görsün, kullanım pattern'i arasın. Kapalı bağlam (apiSurface)
 * karmaşık entity-inşa vakalarında yetmiyordu — model "Video'yu başka yerde nasıl kuruyorlar"
 * diye bakamıyordu. İsim/format opencode ile aynı (model eğitiminden tanır). Salt-okunur,
 * `done` döndürmez → loop devam eder; yollar proje-göreli (src/ ağacı). */
const READ_TOOL: AgentTool = {
  name: "read",
  description:
    "Read a project source file in full to see exactly how something is defined or implemented — an entity with its " +
    "decorators/nullability, a DTO, an enum, or a similar method already written in another service. The filePath is " +
    "project-relative (e.g. 'src/video/entities/video.entity.ts'). Contents are returned with each line prefixed by its " +
    "number as `<line>: <content>`. Entity/DTO/enum files are small — read the whole file at once; do not page through " +
    "in tiny slices. By default returns up to 2000 lines; use offset/limit only for genuinely large files. If unsure " +
    "of the path, use glob/grep first. Read the real code before constructing entities or mapping DTOs.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Project-relative file path, e.g. src/video/dto/video.dto.ts" },
      offset: { type: "number", description: "Line number to start from (1-indexed). Optional." },
      limit: { type: "number", description: "Max lines to read (default 2000). Optional." },
    },
    required: ["filePath"],
    additionalProperties: false,
  },
};
const GREP_TOOL: AgentTool = {
  name: "grep",
  description:
    "Fast content search across the project's src/ tree using a regular expression (full regex syntax). Returns file " +
    "paths and line numbers with the matching lines. Use it to find REAL usage patterns before you write — e.g. how " +
    "`videoRepository.save(` is called elsewhere, examples of `new Video()` construction, or where an enum value is " +
    'used. Filter files with the include parameter (e.g. "*.entity.ts", "*.{ts,tsx}").',
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regex pattern to search for in file contents." },
      include: { type: "string", description: 'Optional file pattern to include (e.g. "*.entity.ts", "*.dto.ts").' },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};
const GLOB_TOOL: AgentTool = {
  name: "glob",
  description:
    "Fast file pattern matching across the project's src/ tree. Supports glob patterns like '**/*.entity.ts' or " +
    "'video/*.ts'. Returns matching project-relative file paths. Use it to discover what exists (which entities, DTOs, " +
    "services, repositories) and find the right file to read.",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string", description: "The glob pattern to match files against, e.g. **/*.dto.ts" } },
    required: ["pattern"],
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
  /** Başarısız bölgede modelin son teşhisi ("hangi tip/üye bloketti") — exhausted
   *  turunda model'den alınır; repair feedback + kullanıcı raporu için. */
  diagnosis?: string;
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
  // İlk dolum grounding: TAZE projeler (ilk pas paralel → izole gerekli). Doğrulama +
  // lookup da taze proje. Grounding: (1) import yüzeyi, (2) ChatLSP beklenen-tip header'ları,
  // (3) Aider repo-map kataloğu (lookup_members için).
  const ctx: FillContext = {
    className: target.className,
    ...parts,
    apiSurface: readDeclaredSurface(filePath),
    expectedTypes: readExpectedTypeHeaders(filePath, target.className, target.member.member),
    catalog: opts.projectCatalog ?? readProjectCatalog(opts.rootDir),
  };
  return runRegionAgent(
    target,
    opts,
    feedback,
    ctx,
    (typeName) => completeType(filePath, typeName),
    (body) =>
      tryFillSurgicalBody(filePath, target.className, target.member.member, body, new Date().toISOString(), {
        rootDir: opts.rootDir,
        checkTypes: true,
      }),
  );
}

/** Onarım yolu: grounding + doğrulama + lookup HEPSİ DiagnosticsPool'un SICAK programından
 *  → repair'de taze proje AÇMA yok; in-memory düzeltmeler de görünür (disk-staleness yok). */
async function repairRegionInPool(
  target: RegionTarget,
  opts: FillOptions,
  pool: DiagnosticsPool,
  feedback: string[],
): Promise<FillRegionResult> {
  const base = { nodeId: target.nodeId, member: target.member.member, file: target.file };
  const parts = pool.fillContext(target.file, target.className, target.member.member);
  if (!parts) return { ...base, status: "error", attempts: 0, error: `region not found in ${target.file}` };
  const ctx: FillContext = {
    className: target.className,
    ...parts,
    apiSurface: pool.declaredSurface(target.file),
    expectedTypes: pool.expectedTypeHeaders(target.file, target.className, target.member.member),
    catalog: opts.projectCatalog ?? "",
  };
  return runRegionAgent(
    target,
    opts,
    feedback,
    ctx,
    (typeName) => pool.completeType(target.file, typeName),
    (body) => pool.applyBody(target.file, target.className, target.member.member, body, new Date().toISOString()),
  );
}

/** Bölge doldurma AJAN ÇEKİRDEĞİ — tool-calling loop TEK kaynaktan. ctx (grounding),
 *  lookup (lookup_members), apply (doğrula+commit) arka uçları dışarıdan verilir → ilk
 *  dolum (taze proje) ve onarım (sıcak havuz) aynı loop/feedback/sonuç-eşlemeyi paylaşır. */
async function runRegionAgent(
  target: RegionTarget,
  opts: FillOptions,
  feedback: string[] | undefined,
  ctx: FillContext,
  lookup: (typeName: string) => CompleteTypeResult,
  apply: (body: string) => WriteBodyResult,
): Promise<FillRegionResult> {
  const base = { nodeId: target.nodeId, member: target.member.member, file: target.file };

  let lastViolations: string[] | undefined;
  let toolError: string | undefined;
  let filledBody: string | undefined; // doğrulanmış gövde (kalıcı sakla)
  let exploreBytes = 0; // KEŞİF EKONOMİSİ: tool çıktısı birikimi (context-patlamasını önle)
  let prevViolSig: string | null = null; // THRASH: aynı başarısız gövdeyi tekrar etme tespiti
  let thrash = 0;
  const EXPLORE_BUDGET = 128_000; // bu eşik aşılınca keşif kapanır, verify_fill'e yönlendirilir
  const explore = (content: string): { content: string } => {
    exploreBytes += content.length;
    return { content };
  };
  const resolve: ToolResolver = async (call) => {
    // BİLİNMEYEN TOOL guard: model var olmayan bir araç (ör. list_files) halüsine ederse
    // sessizce verify_fill'e düşüp yanıltıcı "empty code" üretmesin — açıkça söyle.
    const KNOWN = new Set(["verify_fill", "lookup_members", "read", "grep", "glob"]);
    if (!KNOWN.has(call.name)) {
      return { content: JSON.stringify({ error: `unknown tool "${call.name}". Available: verify_fill, lookup_members, read, grep, glob.` }) };
    }
    // lookup_members (IntelliSense, salt-okunur): GERÇEK üyeleri döndür, loop devam eder.
    if (call.name === "lookup_members") {
      const typeName = typeof call.args?.type === "string" ? call.args.type.trim() : "";
      if (!typeName) return { content: JSON.stringify({ error: "pass an owned type name in `type`" }) };
      // Alanları TİP + nullability ile sun (videoUrl: string, description?: string | undefined) →
      // AI yazmadan önce kesin nullability'yi görür. İsim-yalnız liste nullable'ı gizlerdi.
      return { content: formatTypeShape(typeName, lookup(typeName)) };
    }
    // CODEBASE KEŞİF (read/grep/glob — salt-okunur, loop devam eder) — model gerçek kodu incelesin.
    // KEŞİF BÜTÇESİ: birikim eşiği aşıldıysa daha fazla keşif yok → verify_fill'e yönlendir
    // (yeterli bağlam toplandı; aksi halde 14-tur birikimi context-limit'i patlatabilir).
    if (call.name === "read" || call.name === "grep" || call.name === "glob") {
      if (exploreBytes > EXPLORE_BUDGET) {
        return { content: JSON.stringify({ error: "exploration budget exhausted — you have enough context now. Write the body and call verify_fill." }) };
      }
      if (call.name === "read") {
        const p = typeof call.args?.filePath === "string" ? call.args.filePath : "";
        const offset = typeof call.args?.offset === "number" ? call.args.offset : undefined;
        const limit = typeof call.args?.limit === "number" ? call.args.limit : undefined;
        return explore(readProjectFile(opts.rootDir, p, offset, limit));
      }
      if (call.name === "grep") {
        const pat = typeof call.args?.pattern === "string" ? call.args.pattern : "";
        const inc = typeof call.args?.include === "string" ? call.args.include : undefined;
        return explore(grepProjectCode(opts.rootDir, pat, inc));
      }
      const pat = typeof call.args?.pattern === "string" ? call.args.pattern : "";
      return explore(globProjectFiles(opts.rootDir, pat));
    }
    // verify_fill: doğrula (apply) + temizse commit.
    const code = typeof call.args?.code === "string" ? call.args.code.trim() : "";
    if (!code) return { content: JSON.stringify({ ok: false, violations: ["empty code — pass the method body statements in `code`"] }) };
    const body = stripCodeFences(code);
    const res = apply(body);
    if (!res.ok) {
      toolError = res.error;
      return { content: JSON.stringify({ ok: false, violations: [res.error] }) };
    }
    const corrected = res.corrections && res.corrections.length > 0 ? { corrected: res.corrections } : {};
    if ((res.violations?.length ?? 0) === 0) {
      filledBody = (res.body ?? body).trim();
      return { content: JSON.stringify({ ok: true, ...corrected }), done: true, result: true };
    }
    lastViolations = res.violations;
    // THRASH freni: aynı gövde aynı ihlallerle TEKRAR gelirse model döngüde — yaklaşımı
    // değiştirmesi için sertçe uyar (aksi halde maxRounds'a kadar aynı hatayı tekrarlar).
    const sig = (res.violations ?? []).join("|").replace(/\s+/g, " ");
    const extra: string[] = [];
    if (sig === prevViolSig) {
      thrash++;
      extra.push(
        thrash >= 2
          ? "You have now submitted the SAME failing body multiple times. Stop. Re-read the failing types with read/lookup_members and write a DIFFERENT body — do not resubmit this."
          : "This is the SAME body that already failed with the SAME errors. Do not resubmit it — change your approach (inspect the real types, bridge nullability, fix the construction).",
      );
    } else {
      thrash = 0;
    }
    prevViolSig = sig;
    return { content: JSON.stringify({ ok: false, violations: [...(res.violations ?? []), ...extra] }) };
  };

  // ZORLUK sinyali: owned beklenen-tip VAR ya da declared throws/deps VAR → karmaşık bölge.
  // Zor bölgede round 1'de verify_fill'i GİZLE → model keşfi (read/grep/glob/lookup) yapısal
  // olarak ÖNCE yapar (prose-ricasını kısıta çevirir); round≥2'de tüm araçlar. Basit bölge
  // tüm araçları her zaman görür (gereksiz keşif turu harcamaz).
  const hard = (ctx.expectedTypes?.trim().length ?? 0) > 0 || (target.member.throws?.length ?? 0) + (target.member.deps?.length ?? 0) > 0;
  const ALL_TOOLS = [VERIFY_FILL_TOOL, LOOKUP_MEMBERS_TOOL, READ_TOOL, GREP_TOOL, GLOB_TOOL];
  const EXPLORE_ONLY = [READ_TOOL, GREP_TOOL, GLOB_TOOL, LOOKUP_MEMBERS_TOOL];

  let agent;
  try {
    agent = await runToolAgent({
      config: opts.llm,
      transport: opts.transport,
      system: FILL_SYSTEM,
      user: buildFillUser(target.member, ctx, feedback),
      tools: hard ? (round: number) => (round === 1 ? EXPLORE_ONLY : ALL_TOOLS) : ALL_TOOLS,
      resolve,
      // forceFirstTool YOK: verify_fill bitirmenin TEK yolu (prompt). Zor bölgede keşif
      // round-aware tool setiyle yapısal zorlanır. maxRounds keşif+deneme için cömert.
      maxRounds: opts.maxAttempts ?? 14,
    });
  } catch (e) {
    return { ...base, status: "error", attempts: 0, error: (e as Error).message };
  }

  if (agent.result === true) return { ...base, status: "filled", attempts: agent.rounds, body: filledBody };
  if (toolError && !lastViolations) return { ...base, status: "error", attempts: agent.rounds, error: toolError, diagnosis: agent.finalText };
  // Yeşile ulaşamadı → commit edilmedi (disk/havuz önceki gövdeyi tutar).
  return { ...base, status: "violation", attempts: agent.rounds, violations: lastViolations, diagnosis: agent.finalText };
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

  // Dolan gövdeler yerel tip kullanıp import ekleyemez (yalnız gövde yazılır).
  const filledFiles = [...new Set([...results.values()].filter((r) => r.status === "filled").map((r) => r.file))];

  // ── REPAIR FAZI — TEK SICAK HAVUZ (DiagnosticsPool) ─────────────────────────
  // Eskiden her tur SOĞUKTAN: tsc spawn (tüm proje + node_modules baştan) + tam
  // fixMissingImports yükleme + paralel per-bölge tip-denetimi → CPU spike. Artık
  // projeyi BİR KEZ yükleyen tek sıcak programdan okuyup, düzeltmeleri belleğe yazıp
  // ARTIMSAL yeniden okuyoruz (yalnız değişen dosya + bağımlıları yeniden bağlanır).
  let typecheck: VerifyResult | undefined;
  if (filledFiles.length > 0) {
    const pool = new DiagnosticsPool(opts.rootDir);
    pool.fixImports(filledFiles); // import-fix sıcak programda (reload/save yok)
    opts.onPhase?.({ kind: "imports", files: filledFiles.length });

    if (!opts.skipVerify) {
      const maxRepairRounds = 3;
      let prevCount = Infinity;
      for (let round = 1; round <= maxRepairRounds; round++) {
        // HAVUZ: yalnız DOLU surgical bölgelere düşen sorunlar düzeltilebilir; bölge-dışı
        // (entity codegen bug'ı) raporlanır, fill'in işi değil. İlk okuma tam, sonra artımsal.
        const regionProblems = pool
          .problemsByRegion()
          .filter((rp) => results.get(`${rp.file}#${rp.member}`)?.status === "filled");
        const count = regionProblems.reduce((n, rp) => n + rp.problems.length, 0);
        opts.onPhase?.({ kind: "verify", round, ok: count === 0, errorCount: count });
        if (count === 0) break;
        if (count >= prevCount) break; // küçülmüyor → thrash'i durdur
        prevCount = count;

        // Bölgeleri SIRAYLA onar: tek sıcak program tek-iş parçacıklı → paralel
        // tip-denetleyici spike'ı YOK. Her düzeltme belleğe commit + sonraki okuma görür.
        const changed = new Set<string>();
        for (const rp of regionProblems) {
          const target = byKey.get(`${rp.file}#${rp.member}`);
          if (!target) continue;
          const feedback = [
            `tsc errors in ${rp.file} — fix your method so the file compiles:`,
            ...rp.problems.slice(0, 12).map((p) => `${p.message} (TS${p.code})`),
            // 12'den fazla varsa modele KAÇ tane kaldığını söyle (yoksa erken pes/yanlış öncelik).
            ...(rp.problems.length > 12 ? [`… and ${rp.problems.length - 12} more error(s)`] : []),
          ];
          const rr = await repairRegionInPool(target, opts, pool, feedback);
          results.set(`${rp.file}#${rp.member}`, rr);
          changed.add(rp.file);
          opts.onPhase?.({ kind: "repair", round, file: rr.file, member: rr.member });
          opts.onProgress?.(rr);
        }
        pool.fixImports([...changed]); // bu turun düzeltmeleri yeni yerel tip kullanmış olabilir
      }
    }
    pool.save(); // kirli dosyaları diske yaz (yalnız değişenler — ucuz I/O, type-check değil)
  }

  // FINAL OTORİTER GEÇİT — bir kez gerçek tsc (ts-morph/tsc parite farkını mühürler;
  // bölge-dışı codegen hatalarını da rapora taşır). report.typecheck bunu yeniden kullanır.
  if (!opts.skipVerify) {
    typecheck = runTypecheck(opts.rootDir);
    const errorCount = (typecheck.output.match(/error TS/g) ?? []).length;
    opts.onPhase?.({ kind: "verify", round: 0, ok: typecheck.ok, errorCount });
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
