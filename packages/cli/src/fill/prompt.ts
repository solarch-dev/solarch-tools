/** Surgical fill prompt — turns a marked region's contract + class context into a
 *  chat prompt that asks for ONLY the method body statements (no signature, no
 *  marker, no fences). The orchestrator wraps the result back into the region. */

import type { SurgicalMember } from "@solarch/ast-core";
import type { ChatMessage } from "./llm.js";

export interface FillContext {
  className: string;
  /** Doldurulacak metodun imzası, örn. `async getById(id: string): Promise<User>`. */
  signature: string;
  /** Sınıfın constructor satırı — enjekte edilen bağımlılıklar + tipleri. */
  constructorText: string;
  /** Dosyanın import satırları (entity/DTO/exception tiplerine bağlam). */
  imports: string;
  /** Çağrılabilir API yüzeyi — import edilen tiplerin gerçek metod/arity/enum-değer
   *  imzaları. Halüsinasyonu (olmayan metodu çağırmayı) engeller. */
  apiSurface?: string;
}

const SYSTEM = [
  "You are a senior NestJS + TypeScript engineer implementing ONE method body inside an existing service.",
  "Return ONLY the statements that go inside the method body — no method signature, no surrounding braces,",
  "no comments about the marker, and NO markdown code fences. Just raw TypeScript statements.",
  "GROUNDING — this is strict and overrides any convention you assume:",
  "  - Call ONLY methods/properties that appear in the 'API surface' block below. Do NOT invent methods.",
  "    If a dependency has no method for what you need, do the work inline with the methods that DO exist",
  "    (e.g. if a repository exposes save() but not create(), construct the entity and call save()).",
  "  - Exception classes: use the EXACT constructor arity shown in the API surface. Most take ZERO args —",
  "    then write `throw new XException()` and never pass a message. Put any dynamic context in a comment, not the ctor.",
  "  - For enum/state logic, compare against the enum VALUES shown in the API surface (e.g. \"open\"), never the",
  "    member names, and never invent members that are not listed.",
  "  - Under strict TypeScript a `catch (error)` binds `error: unknown` — narrow it before use:",
  "    `error instanceof Error ? error.message : String(error)`. Never access `error.message` directly.",
  "Honor the contract exactly:",
  "  - You MAY throw ONLY the exceptions listed under 'throws'. Throwing any other *Exception is forbidden.",
  "  - You MAY use ONLY the injected dependencies listed under 'deps', accessed via `this.<name>`.",
  "    Using any other injected dependency is forbidden. The class's own private fields/helpers are allowed.",
  "  - Match the given signature (parameters and return type). Use async/await where the return type is a Promise.",
  "Write idiomatic, production-quality code that implements the described behavior. The code MUST compile under tsc strict.",
].join("\n");

export function buildFillPrompt(
  region: SurgicalMember,
  ctx: FillContext,
  priorViolations?: string[],
): ChatMessage[] {
  const lines = [
    `Class: ${ctx.className}`,
    `Method to implement: ${ctx.signature}`,
    "",
    "API surface — the ONLY methods/properties/enum values/exception constructors you may call:",
    ctx.apiSurface || "(none resolved — be conservative, call nothing you cannot see)",
    "",
    "Imports in scope:",
    ctx.imports || "(none)",
    "",
    "Constructor (available injected dependencies):",
    ctx.constructorText || "(no constructor)",
    "",
    `Behavior: ${region.description ?? "(no description — infer from the signature and method name)"}`,
    `throws (allowed exceptions): ${region.throws?.join(", ") || "(none — do not throw *Exception types)"}`,
    `deps (allowed this.* dependencies): ${region.deps?.join(", ") || "(none)"}`,
  ];
  if (priorViolations && priorViolations.length > 0) {
    lines.push(
      "",
      "Your previous attempt had these problems — fix them and try again:",
      ...priorViolations.map((v) => `  - ${v}`),
    );
  }
  lines.push("", "Return ONLY the method body statements.");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}
