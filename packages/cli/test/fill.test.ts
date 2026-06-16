/** Surgical fill — pure helpers + orchestrator contract loop with a mock LLM
 *  (no network, no tsc/test gates). */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { llmConfigFromEnv, stripCodeFences } from "../src/fill/llm.js";
import { buildFillPrompt } from "../src/fill/prompt.js";
import { fillRegion, selectSkeletons } from "../src/fill/orchestrator.js";
import type { SurgicalMember } from "@solarch/ast-core";

describe("stripCodeFences", () => {
  it("```ts fence'i soyar", () => {
    expect(stripCodeFences("```ts\nreturn 1;\n```")).toBe("return 1;");
  });
  it("düz metni olduğu gibi bırakır", () => {
    expect(stripCodeFences("return 1;")).toBe("return 1;");
  });
});

describe("llmConfigFromEnv", () => {
  it("DeepSeek varsayılanlarına düşer", () => {
    const c = llmConfigFromEnv({ DEEPSEEK_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(c.model).toBe("deepseek-v4-pro");
    expect(c.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(c.apiKey).toBe("k");
  });
  it("SOLARCH_FILL_* override eder", () => {
    const c = llmConfigFromEnv({ SOLARCH_FILL_MODEL: "claude", SOLARCH_FILL_API_KEY: "x", SOLARCH_FILL_API_URL: "https://h/v1" } as NodeJS.ProcessEnv);
    expect(c.model).toBe("claude");
    expect(c.apiKey).toBe("x");
    expect(c.baseUrl).toBe("https://h/v1");
  });
});

describe("buildFillPrompt", () => {
  const region = { member: "getById", nodeId: "n1", status: "skeleton", throws: ["NotFoundException"], deps: ["userRepository"], description: "Find a user" } as SurgicalMember;
  const ctx = { className: "UserService", signature: "async getById(id: string): Promise<User>", constructorText: "constructor(private readonly userRepository: Repo) {}", imports: "import { Repo } from './repo';" };
  it("kontratı + imzayı içerir", () => {
    const user = buildFillPrompt(region, ctx)[1]!;
    expect(user.content).toContain("NotFoundException");
    expect(user.content).toContain("userRepository");
    expect(user.content).toContain("async getById");
  });
  it("önceki sorunları (kontrat/tsc) geri besler", () => {
    const user = buildFillPrompt(region, ctx, ['throws undeclared "ConflictException"'])[1]!;
    expect(user.content).toContain("had these problems");
    expect(user.content).toContain("ConflictException");
  });

  it("API yüzeyini prompt'a gömer (grounding)", () => {
    const user = buildFillPrompt(region, { ...ctx, apiSurface: "class UserRepository { constructor() }\n  methods: save(u: User): Promise<User>" })[1]!;
    expect(user.content).toContain("API surface");
    expect(user.content).toContain("save(u: User)");
  });
});

describe("fillRegion (mock LLM)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fill-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src"), { recursive: true });

  const FILE = `import { Injectable } from "@nestjs/common";
class NotFoundException extends Error {}
class ConflictException extends Error {}

@Injectable()
export class UserService {
  constructor(private readonly userRepository: { findById(id: string): Promise<unknown> }) {}

  async getById(id: string): Promise<unknown> {
    // @solarch:surgical id=n1#getById
    // Find a user by id.
    // throws: NotFoundException
    // deps: userRepository
    throw new Error("NOT_IMPLEMENTED: UserService.getById");
  }
}
`;

  it("kontrata uyan gövdeyi yazar ve kaydeder", async () => {
    writeFileSync(join(dir, "src", "user.service.ts"), FILE);
    const target = selectSkeletons(dir)[0]!;
    const r = await fillRegion(target, {
      rootDir: dir,
      complete: async () => "const u = await this.userRepository.findById(id);\nif (!u) throw new NotFoundException();\nreturn u;",
      skipVerify: true,
    });
    expect(r.status).toBe("filled");
    const out = readFileSync(join(dir, "src", "user.service.ts"), "utf8");
    expect(out).not.toContain("NOT_IMPLEMENTED");
    expect(out).toContain("@solarch:filled by=ai");
    expect(out).toContain("findById(id)");
  });

  it("sözleşme ihlali → kaydetmez (stub korunur)", async () => {
    writeFileSync(join(dir, "src", "user.service.ts"), FILE);
    const target = selectSkeletons(dir)[0]!;
    const r = await fillRegion(target, {
      rootDir: dir,
      complete: async () => "throw new ConflictException();", // bildirilmemiş
      maxAttempts: 2,
      skipVerify: true,
    });
    expect(r.status).toBe("violation");
    expect(r.attempts).toBe(2);
    const out = readFileSync(join(dir, "src", "user.service.ts"), "utf8");
    expect(out).toContain("NOT_IMPLEMENTED"); // stub korundu
  });
});
