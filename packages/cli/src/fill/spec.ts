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
import { readDeclaredSurface } from "@solarch/ast-core";
import type { ChatMessage, CompleteFn } from "./llm.js";
import { stripCodeFences } from "./llm.js";

const SYSTEM = [
  "You are a senior NestJS engineer writing a jest unit test (.spec.ts) for the service shown below.",
  "Return ONLY the complete .spec.ts file content — no markdown fences, no prose.",
  "Rules (strict):",
  "  - Mock EVERY injected constructor dependency. For each dependency create an object whose",
  "    methods are jest.fn(); include ONLY methods that appear in the API surface — never invent one.",
  "  - Construct the service directly: `new ServiceName(mockDepA as any, mockDepB as any)`.",
  "  - For EACH public method write a `describe` with: (1) a happy-path `it` that arranges the mocks",
  "    to succeed, calls the method, and asserts the returned value's shape AND that the right",
  "    dependency methods were called; (2) one `it` per exception in the method's `// throws:` contract",
  "    that arranges the triggering condition and asserts `await expect(promise).rejects.toThrow(XException)`.",
  "  - Test the BEHAVIOUR described in the `// <description>` and `// throws:` markers — do not merely mirror",
  "    the implementation. Use the EXACT method names, parameter shapes, enum VALUES and exception classes",
  "    from the API surface. Import the service, DTOs, entities, enums and exceptions from their real",
  "    relative paths (same paths the service file imports them from).",
  "  - The spec MUST compile under tsc strict and pass jest with no real DB/network.",
].join("\n");

export function buildSpecPrompt(serviceFileContent: string, apiSurface: string, importPath: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [
        `Service file (import the class from "${importPath}"):`,
        "```ts",
        serviceFileContent,
        "```",
        "",
        "API surface — the ONLY methods/enum values/exception constructors that exist:",
        apiSurface || "(none resolved)",
        "",
        "Write the complete .spec.ts now.",
      ].join("\n"),
    },
  ];
}

export interface SpecResult {
  file: string; // üretilen .spec.ts (göreli)
  status: "written" | "error";
  error?: string;
}

/** Dolu bir servis dosyası için gerçek davranış spec'i üret + stub'ı ez. */
export async function generateSpecForService(
  rootDir: string,
  serviceRelFile: string,
  complete: CompleteFn,
): Promise<SpecResult> {
  const specRel = serviceRelFile.replace(/\.ts$/, ".spec.ts");
  try {
    const content = readFileSync(join(rootDir, serviceRelFile), "utf8");
    const surface = readDeclaredSurface(join(rootDir, serviceRelFile));
    const importPath = `./${basename(serviceRelFile).replace(/\.ts$/, "")}`;
    const raw = await complete(buildSpecPrompt(content, surface, importPath));
    writeFileSync(join(rootDir, specRel), stripCodeFences(raw));
    return { file: specRel, status: "written" };
  } catch (e) {
    return { file: specRel, status: "error", error: (e as Error).message };
  }
}
