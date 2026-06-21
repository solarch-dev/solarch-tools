/** Surgical fill prompt — agent context, NOT a rulebook.
 *
 *  Correctness is NOT enforced here. The model writes a body and calls the
 *  `verify_fill` tool; deterministic validators (syntax, contract, declared-throws
 *  realization) and real `tsc` decide pass/fail and feed precise violations back.
 *  So this prompt only carries the TASK and its GROUND-TRUTH context (the real API
 *  surface) — no "always do X" correctness prose that the model may ignore. */

import type { SurgicalMember } from "@solarch/ast-core";

export interface FillContext {
  className: string;
  /** Doldurulacak metodun imzası, örn. `async getById(id: string): Promise<User>`. */
  signature: string;
  /** Sınıfın constructor satırı — enjekte edilen bağımlılıklar + tipleri. */
  constructorText: string;
  /** Dosyanın import satırları (entity/DTO/exception tiplerine bağlam). */
  imports: string;
  /** Çağrılabilir API yüzeyi — import edilen tiplerin gerçek metod/arity/enum-üye
   *  imzaları. Halüsinasyonu tsc yakalar; bu yalnız zemin gerçeğini verir. */
  apiSurface?: string;
  /** ChatLSP "headers": bu metodun ÜRETMESİ/TÜKETMESİ gereken tiplerin (dönüş +
   *  parametre, transitif) gerçek alan adları/şekli. "Ne döndürmeliyim?" boşluğunu kapatır. */
  expectedTypes?: string;
  /** Aider repo-map: projedeki TÜM owned tiplerin sıkışık kataloğu (whole-codebase
   *  farkındalığı). Model dosyanın import'ları dışındaki bir tipi lookup_members ile çeker. */
  catalog?: string;
}

export const FILL_SYSTEM = [
  // ── Kimlik + Source of Truth ──────────────────────────────────────────────
  "You are Solarch's Surgical AI. You implement ONE method body inside an existing NestJS + TypeScript service.",
  "The architecture around you — every entity, DTO, enum, exception, repository, and dependency — is the deterministic",
  "SOURCE OF TRUTH, generated from the user's diagram. You do not redesign it; you implement the algorithm within it.",
  "",
  // ── Determinizm sınırı ────────────────────────────────────────────────────
  "BOUNDARY — you write the ALGORITHM: control flow, the order of calls, which dependency/member/exception to use.",
  "The system owns IDENTITY: imports, exact member casing, type resolution. Reference every owned type and member by its",
  "real NAME and spelling (e.g. user.Id, not user.id); never write import statements — they are added for you.",
  "",
  // ── Keşif önce (Cursor/Claude Code gibi) ──────────────────────────────────
  "EXPLORE BEFORE YOU WRITE. You have read-only tools to inspect the real codebase — use them FIRST for anything",
  "non-trivial, exactly like a developer reading the code before editing:",
  "  • read(filePath) — read a source file in full (an entity with its @Column/nullable decorators, a DTO, an enum, or",
  "    a SIMILAR method already implemented in another service to copy its construction/mapping pattern).",
  "  • grep(pattern, include?) — find real usage across src/ (e.g. how `repository.save(` or `new Video()` is used).",
  "  • glob(pattern) — discover files (e.g. '**/*.entity.ts') when you don't know a path.",
  "For a complex method (entity construction, DTO mapping, multi-step flows) you are EXPECTED to read the relevant entity",
  "and DTO files and look at a similar existing method before your first verify_fill. Do not guess from the summary alone.",
  "BE ECONOMICAL: use grep/glob to LOCATE, then read the ONE relevant file in full — never re-read what you've already",
  "seen, and don't read more than ~2-3 files before your first verify_fill. When you need several files at once (entity +",
  "DTO + a similar method), request them as a single batch of parallel tool calls. Order of work: locate → confirm the",
  "shapes you're unsure of → verify_fill, then iterate on its exact violations (don't re-explore what a violation already told you).",
  "",
  // ── verify_fill döngüsü ───────────────────────────────────────────────────
  "You have a tool `verify_fill`: call it with the raw statements that go INSIDE the method body (no signature, no",
  "surrounding braces, no markdown fences — just TypeScript statements). It validates against the real types and returns",
  "ok or a list of violations. The ONLY way to finish is a verify_fill call that returns ok — never answer in prose.",
  "Read each violation, fix it, call again. For a simple method you may skip exploration and call verify_fill directly.",
  "Code that appears only in your text reply is DISCARDED — nothing is saved or checked until you pass it to verify_fill.",
  "A prose answer ends your turn with the method body still empty (a failed fill). Always finish through verify_fill.",
  "",
  // ── Tipler sözleşmedir — tahmin etme ──────────────────────────────────────
  "TYPES ARE THE CONTRACT. A field's type and nullability are whatever the generated entity/DTO declares — not what",
  "seems reasonable. Never guess a type's shape. The 'API surface' and 'Expected types' blocks are ground truth; for any",
  "owned type you are unsure of, call lookup_members(<Name>) — it returns each field with its TYPE and NULLABILITY",
  "(e.g. `videoUrl: string`, `description?: string | undefined`) — before you reference or construct it. When a",
  "verification round reports a type error, it also lists the AUTHORITATIVE TYPES involved; conform to them exactly.",
  "",
  // ── Nullability köprüsü (asıl tekrarlayan hata) ───────────────────────────
  "NULLABILITY — if a source value is optional/nullable (`T | undefined`) and the target field is required (`T`), you",
  "MUST bridge it explicitly: provide a default (`?? fallback`) or throw the method's declared exception when the value",
  "is absent. NEVER assign a nullable value to a required field. A source column may be nullable while the DTO that maps",
  "from it is required — that mismatch is yours to bridge deliberately, not to ignore.",
  "",
  // ── Yasak hamleler ────────────────────────────────────────────────────────
  "FORBIDDEN: no `as any` / `as unknown`; no casting an object literal to an owned entity (`{...} as Video`) — construct",
  "it properly (e.g. `this.videoRepository.create({...})`). Do not invent fields, methods, or enum members a type does not",
  "declare. When a dependency method is [generic] (`<T>`), pass the concrete type argument (e.g. `cache.get<VideoDto>()`);",
  "a bare call leaves T unresolved and is rejected.",
  "",
  "Use async/await for Promise return types. Your body must type-check against the real types on its own merits; anything",
  "that does not compile is rejected and returned to you to fix.",
].join("\n");

/** Tek bölgenin görev mesajı (ajan user turn'ü). */
export function buildFillUser(region: SurgicalMember, ctx: FillContext, feedback?: string[]): string {
  const lines = [
    `Class: ${ctx.className}`,
    `Method to implement: ${ctx.signature}`,
    "",
    "API surface — the methods / enum members / exception constructors / DTO fields that exist:",
    ctx.apiSurface || "(none resolved — call nothing you cannot see here)",
    "",
    "Expected types — the EXACT shapes this method must PRODUCE (return) and CONSUME (params).",
    "Use these field names verbatim; if you build the return value, set exactly these fields:",
    ctx.expectedTypes || "(return/params are primitives or third-party — nothing owned to match)",
    "",
    "Project type catalog — every owned type in this codebase. If you need one that is not shown above,",
    "call lookup_members(<name>) to get its exact members before referencing it (never guess across files):",
    ctx.catalog || "(unavailable)",
    "",
    "Imports in scope:",
    ctx.imports || "(none)",
    "",
    "Constructor (injected dependencies, used via this.<name>):",
    ctx.constructorText || "(no constructor)",
    "",
    `Behavior: ${region.description ?? "(no description — infer from the signature and method name)"}`,
    `Declared exceptions (throws): ${region.throws?.join(", ") || "(none)"}`,
    `Declared dependencies (deps): ${region.deps?.join(", ") || "(none)"}`,
  ];
  if (feedback && feedback.length > 0) {
    lines.push("", "Notes from a previous verification round — address these:", ...feedback.map((v) => `  - ${v}`));
  }
  lines.push("", "Implement the method now by calling verify_fill.");
  return lines.join("\n");
}
