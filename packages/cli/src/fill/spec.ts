/** Layer 4 — behavioral test generation.
 *
 *  After the method bodies are filled, the generated .spec.ts files are still
 *  stubs asserting NOT_IMPLEMENTED (they break once filled) with incomplete mocks.
 *  This replaces a filled service's spec with a REAL jest spec: mock every injected
 *  dependency, test each method's happy path and its declared error paths against
 *  the contract — so the filled code is verified, not assumed. The spec is grounded
 *  in the same API surface as the fill, so the test cannot invent dep methods. */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fixMissingImportsInFiles, readDeclaredSurface } from "@solarch/ast-core";
import type { ChatMessage, CompleteFn } from "./llm.js";
import { stripCodeFences } from "./llm.js";
import { runJestFile } from "./verify.js";

const SYSTEM = [
  "You are a senior NestJS engineer writing a JEST unit test (.spec.ts) for the service shown below.",
  "Return ONLY the complete .spec.ts file content — no markdown fences, no prose.",
  "Rules (strict):",
  "  - JEST GLOBALS: describe, it, expect, beforeEach, jest are GLOBAL — NEVER import them",
  "    (no `import ... from \"node:test\"`, no `import ... from \"@jest/globals\"`). Just use them.",
  "  - IMPORTS: import the service class from its path; for every OTHER symbol you reference, COPY the",
  "    exact import line from the service file above — do NOT invent or guess a path, and do NOT import",
  "    any type the service file does not import. If a symbol is not imported by the service, do not use it.",
  "  - Mock EVERY injected constructor dependency. For each dependency create an object whose",
  "    methods are jest.fn(); include ONLY methods that appear in the API surface — never invent one.",
  "  - Construct the service directly: `new ServiceName(mockDepA as any, mockDepB as any)`.",
  "  - For EACH public method write a `describe` with: (1) a happy-path `it` that arranges the mocks",
  "    to succeed, calls the method, and asserts the returned value's shape AND that the right",
  "    dependency methods were called; (2) one `it` per exception in the method's `// throws:` contract",
  "    that arranges the triggering condition and asserts `await expect(promise).rejects.toThrow(XException)`.",
  "  - Test the BEHAVIOUR in the `// <description>` and `// throws:` markers — do not merely mirror the impl.",
  "    Use the EXACT method names, parameter shapes, enum VALUES and exception classes from the API surface.",
  "  - TEST DATA: build input objects as plain valid objects — every field gets a value of the correct type.",
  "    For an enum-typed field use the EXACT enum VALUE string from the API surface (e.g. \"in_progress\", NOT",
  "    \"IN_PROGRESS\" and NOT an invented value like \"electrical\"). Never use an `as SomeDto` cast to force an",
  "    invalid shape — construct a fully valid object instead.",
  "  - The spec MUST compile under tsc strict and pass jest with no real DB/network.",
].join("\n");

export function buildSpecPrompt(
  serviceFileContent: string,
  apiSurface: string,
  importPath: string,
  priorJestError?: string,
): ChatMessage[] {
  const lines = [
    `Service file (import the class from "${importPath}"):`,
    "```ts",
    serviceFileContent,
    "```",
    "",
    "API surface — the ONLY methods/enum values/exception constructors that exist:",
    apiSurface || "(none resolved)",
  ];
  if (priorJestError) {
    lines.push(
      "",
      "Your previous spec FAILED jest. Fix it (often a wrong import path or importing jest from node:test):",
      priorJestError.slice(0, 1500),
    );
  }
  lines.push("", "Write the complete .spec.ts now.");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}

export interface SpecResult {
  file: string; // üretilen .spec.ts (göreli)
  status: "written" | "error";
  /** jest'i geçti mi (spec-repair sonrası). */
  passed?: boolean;
  attempts?: number;
  error?: string;
}

/** Dolu bir servis için gerçek davranış spec'i üret + stub'ı ez; jest'e karşı
 *  ≤maxAttempts kez onar (hata geri beslenir). skipRun=true → yalnız yaz (testte mock). */
export async function generateSpecForService(
  rootDir: string,
  serviceRelFile: string,
  complete: CompleteFn,
  opts: { maxAttempts?: number; skipRun?: boolean } = {},
): Promise<SpecResult> {
  const specRel = serviceRelFile.replace(/\.ts$/, ".spec.ts");
  const maxAttempts = opts.maxAttempts ?? 2;
  let content: string;
  let surface: string;
  try {
    content = readFileSync(join(rootDir, serviceRelFile), "utf8");
    surface = readDeclaredSurface(join(rootDir, serviceRelFile));
  } catch (e) {
    return { file: specRel, status: "error", error: (e as Error).message };
  }
  const importPath = `./${basename(serviceRelFile).replace(/\.ts$/, "")}`;

  let priorError: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let spec: string;
    try {
      spec = stripCodeFences(await complete(buildSpecPrompt(content, surface, importPath, priorError)));
    } catch (e) {
      return { file: specRel, status: "error", attempts: attempt, error: (e as Error).message };
    }
    writeFileSync(join(rootDir, specRel), spec);
    // Yanlış/eksik import'ları TS dil servisiyle düzelt (AI yol derinliğini şaşırabilir).
    if (!opts.skipRun) {
      try {
        fixMissingImportsInFiles(rootDir, [specRel]);
      } catch {
        /* en iyi çaba */
      }
    }
    if (opts.skipRun) return { file: specRel, status: "written", attempts: attempt };
    const v = runJestFile(rootDir, specRel);
    if (v.ok) return { file: specRel, status: "written", passed: true, attempts: attempt };
    priorError = v.output;
  }
  return { file: specRel, status: "written", passed: false, attempts: maxAttempts, error: priorError?.slice(0, 400) };
}
