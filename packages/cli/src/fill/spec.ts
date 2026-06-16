/** Layer 4 — behavioral test generation, verification-driven.
 *
 *  After the bodies are filled, the stub .spec.ts files (NOT_IMPLEMENTED asserts +
 *  incomplete mocks) break. This replaces a filled service's spec with a REAL jest
 *  spec that the model VERIFIES by running it: the model calls the `run_tests` tool,
 *  the system runs jest on the spec and feeds the actual failures back, and the model
 *  iterates until jest is green. No "write a good test" prose — the running test is
 *  the judge. The spec is grounded in the same API surface as the fill, so it cannot
 *  invent dependency methods or enum members. */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readDeclaredSurface } from "@solarch/ast-core";
import type { LlmConfig } from "./llm.js";
import { stripCodeFences } from "./llm.js";
import { runToolAgent, type AgentTool, type ChatTransport, type ToolResolver } from "./agent.js";
import { writeSpecAndRun } from "./verify.js";

const SPEC_SYSTEM = [
  "You write a JEST unit test (.spec.ts) for the service shown, then VERIFY it with the run_tests tool.",
  "Call run_tests with the COMPLETE .spec.ts file content; it runs jest and returns {ok:true} or the jest",
  "failure output. The ONLY way to finish is a run_tests that returns ok — never answer in prose. Read the",
  "jest output, fix the spec, and call run_tests again.",
  "Structure: import the service from its path; mock EVERY injected constructor dependency (each used method a",
  "jest.fn()); construct the service directly with `new ServiceName(mockA as any, mockB as any)`; write one",
  "happy-path test per public method (assert the returned value's shape AND that the right dependency methods",
  "were called), plus one test per exception in that method's `// throws:` contract.",
  "describe / it / expect / jest / beforeEach are GLOBAL — never import them (no node:test, no @jest/globals).",
  "The API surface block is the ground truth for method names, enum members and exception classes; jest will",
  "reject anything invented. When a test targets a specific error, arrange the mocks and input so execution",
  "actually REACHES that error — if you assert the wrong exception, the jest output shows which one was really",
  "thrown, so use it to fix the precondition.",
].join("\n");

function buildSpecUser(serviceFileContent: string, apiSurface: string, importPath: string): string {
  return [
    `Service file (import the class from "${importPath}"):`,
    "```ts",
    serviceFileContent,
    "```",
    "",
    "API surface — the ONLY methods / enum members / exception constructors that exist:",
    apiSurface || "(none resolved)",
    "",
    "Write the .spec.ts and verify it by calling run_tests.",
  ].join("\n");
}

const RUN_TESTS_TOOL: AgentTool = {
  name: "run_tests",
  description:
    "Write the given .spec.ts content to disk and run jest on it. Returns {ok:true} when every test passes, " +
    "otherwise {ok:false, jest:'<failure output>'}. Fix the spec from the failure output and call again.",
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "The complete .spec.ts file content." } },
    required: ["code"],
    additionalProperties: false,
  },
};

export interface SpecResult {
  file: string; // üretilen .spec.ts (göreli)
  status: "written" | "error";
  /** jest'i geçti mi (ajan yeşile ulaştı mı). */
  passed?: boolean;
  rounds?: number;
  error?: string;
}

/** Dolu bir servis için gerçek davranış spec'i üret + jest'le DOĞRULA (ajan döngüsü).
 *  Model run_tests çağırır; sistem spec'i yazıp jest koşar, hatayı geri besler; yeşile
 *  ya da tur-tavanına kadar döner. Son yazılan spec diskte kalır (dürüst residüel). */
export async function generateSpecForService(
  rootDir: string,
  serviceRelFile: string,
  llm: LlmConfig,
  opts: { maxAttempts?: number; transport?: ChatTransport } = {},
): Promise<SpecResult> {
  const specRel = serviceRelFile.replace(/\.ts$/, ".spec.ts");
  let content: string;
  let surface: string;
  try {
    content = readFileSync(join(rootDir, serviceRelFile), "utf8");
    surface = readDeclaredSurface(join(rootDir, serviceRelFile));
  } catch (e) {
    return { file: specRel, status: "error", error: (e as Error).message };
  }
  const importPath = `./${basename(serviceRelFile).replace(/\.ts$/, "")}`;

  let passed = false;
  const resolve: ToolResolver = async (call) => {
    const code = typeof call.args?.code === "string" ? call.args.code : "";
    if (!code.trim()) return { content: JSON.stringify({ ok: false, jest: "empty spec — pass the full .spec.ts content in `code`" }) };
    // Spec'i yaz + eksik/yanlış import'ları (relative + node:test-strip) düzelt + jest koş.
    const v = writeSpecAndRun(rootDir, specRel, stripCodeFences(code));
    if (v.ok) {
      passed = true;
      return { content: JSON.stringify({ ok: true }), done: true, result: specRel };
    }
    return { content: JSON.stringify({ ok: false, jest: v.output.slice(0, 2500) }) };
  };

  let agent;
  try {
    agent = await runToolAgent({
      config: llm,
      transport: opts.transport,
      system: SPEC_SYSTEM,
      user: buildSpecUser(content, surface, importPath),
      tools: [RUN_TESTS_TOOL],
      resolve,
      forceFirstTool: "run_tests",
      maxRounds: opts.maxAttempts ?? 4,
      timeoutMs: 120_000,
    });
  } catch (e) {
    return { file: specRel, status: "error", error: (e as Error).message };
  }
  return { file: specRel, status: "written", passed, rounds: agent.rounds };
}
