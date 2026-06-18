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
}

export const FILL_SYSTEM = [
  "You implement ONE method body inside an existing NestJS + TypeScript service.",
  "You have a tool `verify_fill`: call it with the raw statements that go INSIDE the method body",
  "(no method signature, no surrounding braces, no markdown fences — just TypeScript statements).",
  "verify_fill validates your code and returns either ok, or a list of violations. The ONLY way to finish",
  "is a verify_fill call that returns ok — never answer in prose. Read each violation, fix it, call again.",
  "The 'API surface' block in the task is the ground truth of what actually exists (dependency methods and",
  "their arity, enum members, exception constructors, DTO fields). Anything you reference must come from it;",
  "the type-checker will reject invented methods, wrong arity, or bad enum members and you will see those errors.",
  "Use async/await for Promise return types.",
  "When the API surface marks a method as [generic] (it has a <T> type parameter), you MUST pass a concrete",
  "type argument that matches what you return — e.g. `cache.get<Category>()` not `cache.get()`. A bare call",
  "leaves T unresolved ({}), which the type-checker rejects.",
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
