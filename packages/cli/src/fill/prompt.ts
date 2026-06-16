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
}

const SYSTEM = [
  "You are a senior NestJS + TypeScript engineer implementing ONE method body inside an existing service.",
  "Return ONLY the statements that go inside the method body — no method signature, no surrounding braces,",
  "no comments about the marker, and NO markdown code fences. Just raw TypeScript statements.",
  "Honor the contract exactly:",
  "  - You MAY throw ONLY the exceptions listed under 'throws'. Throwing any other *Exception is forbidden.",
  "  - You MAY use ONLY the injected dependencies listed under 'deps', accessed via `this.<name>`.",
  "    Using any other injected dependency is forbidden. The class's own private fields/helpers are allowed.",
  "  - Match the given signature (parameters and return type). Use async/await where the return type is a Promise.",
  "Write idiomatic, production-quality code that implements the described behavior. Prefer clarity over cleverness.",
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
      "Your previous attempt VIOLATED the contract. Fix these and try again:",
      ...priorViolations.map((v) => `  - ${v}`),
    );
  }
  lines.push("", "Return ONLY the method body statements.");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}
