/** Surgical fill — pure helpers + the tool-calling agent loop driven by a SCRIPTED
 *  transport (no network). Correctness lives in the validators (ast-core) and real
 *  tsc/jest; here we test the agent mechanics + the prompt context, offline. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { llmConfigFromEnv, stripCodeFences } from "../src/fill/llm.js";
import { buildFillUser, FILL_SYSTEM } from "../src/fill/prompt.js";
import { runToolAgent, type AgentMessage, type ChatTransport, type ToolResolver } from "../src/fill/agent.js";
import { fillProject, fillRegion, selectSkeletons } from "../src/fill/orchestrator.js";
import { generateSpecForService, SPEC_SYSTEM } from "../src/fill/spec.js";
import type { SurgicalMember } from "@solarch/ast-core";

const DUMMY_LLM = { baseUrl: "https://x/v1", model: "test", apiKey: "k" };

/** Her turda sıradaki `code`'u verilen tool adıyla çağıran sahte transport.
 *  Liste biterse son code'u tekrarlar (yeşilleşmeyen denemeyi simüle eder). */
function scriptedTransport(codes: string[], toolName: string): ChatTransport {
  let i = 0;
  return async (): Promise<AgentMessage> => {
    const code = codes[Math.min(i, codes.length - 1)] ?? "";
    i += 1;
    return { role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: toolName, arguments: JSON.stringify({ code }) } }] };
  };
}

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

describe("buildFillUser", () => {
  const region = { member: "getById", nodeId: "n1", status: "skeleton", throws: ["NotFoundException"], deps: ["userRepository"], description: "Find a user" } as SurgicalMember;
  const ctx = { className: "UserService", signature: "async getById(id: string): Promise<User>", constructorText: "constructor(private readonly userRepository: Repo) {}", imports: "import { Repo } from './repo';" };
  it("kontratı + imzayı + API yüzeyini içerir", () => {
    const user = buildFillUser(region, { ...ctx, apiSurface: "class UserRepository { constructor() }\n  methods: save(u: User): Promise<User>" });
    expect(user).toContain("NotFoundException");
    expect(user).toContain("userRepository");
    expect(user).toContain("async getById");
    expect(user).toContain("save(u: User)");
  });
  it("önceki doğrulama turunu geri besler", () => {
    const user = buildFillUser(region, ctx, ['throws undeclared "ConflictException"']);
    expect(user).toContain("previous verification round");
    expect(user).toContain("ConflictException");
  });
  it("system prompt prose değil tool-kullanımı söyler", () => {
    expect(FILL_SYSTEM).toContain("verify_fill");
    expect(FILL_SYSTEM.toLowerCase()).toContain("never answer in prose");
  });
});

describe("runToolAgent (scripted transport)", () => {
  const tool = { name: "verify", description: "v", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } };

  it("violations'ta döner, done'da durup result verir", async () => {
    let calls = 0;
    const resolve: ToolResolver = async (call) => {
      calls += 1;
      const code = String(call.args?.code ?? "");
      if (code === "good") return { content: '{"ok":true}', done: true, result: code };
      return { content: '{"ok":false,"violations":["bad"]}' };
    };
    const r = await runToolAgent({
      transport: scriptedTransport(["bad", "still-bad", "good"], "verify"),
      system: "s", user: "u", tools: [tool], resolve, forceFirstTool: "verify", maxRounds: 5,
    });
    expect(r.result).toBe("good");
    expect(calls).toBe(3); // bad, still-bad, good
    expect(r.rounds).toBe(3);
  });

  it("hiç yeşilleşmezse tur-tavanında exhausted döner", async () => {
    const resolve: ToolResolver = async () => ({ content: '{"ok":false,"violations":["nope"]}' });
    const r = await runToolAgent({
      transport: scriptedTransport(["bad"], "verify"),
      system: "s", user: "u", tools: [tool], resolve, maxRounds: 3,
    });
    expect(r.result).toBeUndefined();
    expect(r.exhausted).toBe(true);
    expect(r.rounds).toBe(3);
  });
});

describe("fillRegion (scripted transport)", () => {
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

  it("validator'ları geçen gövdeyi yazar ve kaydeder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fill-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "user.service.ts"), FILE);
    const target = selectSkeletons(dir)[0]!;
    const r = await fillRegion(target, {
      rootDir: dir,
      llm: DUMMY_LLM,
      transport: scriptedTransport(["const u = await this.userRepository.findById(id);\nif (!u) throw new NotFoundException();\nreturn u;"], "verify_fill"),
      skipVerify: true,
    });
    expect(r.status).toBe("filled");
    const out = readFileSync(join(dir, "src", "user.service.ts"), "utf8");
    expect(out).not.toContain("NOT_IMPLEMENTED");
    expect(out).toContain("@solarch:filled by=ai");
    expect(out).toContain("findById(id)");
    rmSync(dir, { recursive: true, force: true });
  });

  it("validator ihlali → kaydetmez (stub korunur)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fill-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "user.service.ts"), FILE);
    const target = selectSkeletons(dir)[0]!;
    const r = await fillRegion(target, {
      rootDir: dir,
      llm: DUMMY_LLM,
      transport: scriptedTransport(["throw new ConflictException();"], "verify_fill"), // beyan dışı + NotFound gerçeklenmiyor
      maxAttempts: 2,
      skipVerify: true,
    });
    expect(r.status).toBe("violation");
    expect(r.attempts).toBe(2);
    const out = readFileSync(join(dir, "src", "user.service.ts"), "utf8");
    expect(out).toContain("NOT_IMPLEMENTED"); // stub korundu
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("lookup_members + deterministik snap (scripted transport)", () => {
  function fixture(dir: string): void {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "user.entity.ts"), `export class User {\n  Id!: string;\n  fullName!: string;\n  email!: string;\n}\n`);
    writeFileSync(
      join(dir, "src", "user.service.ts"),
      [
        `import { Injectable } from "@nestjs/common";`,
        `import { User } from "./user.entity";`,
        ``,
        `@Injectable()`,
        `export class UserService {`,
        `  getName(user: User): string {`,
        `    // @solarch:surgical id=u1#getName`,
        `    throw new Error("NOT_IMPLEMENTED: UserService.getName");`,
        `  }`,
        `}`,
        ``,
      ].join("\n"),
    );
  }

  it("lookup_members owned tipin GERÇEK üyelerini döndürür; agent sonra verify_fill ile geçer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lm-"));
    fixture(dir);
    const target = selectSkeletons(dir)[0]!;
    let lookupResponse = "";
    let i = 0;
    // 2 turlu transport: önce lookup_members(User), sonra verify_fill(doğru gövde).
    const transport: ChatTransport = async (messages) => {
      i += 1;
      if (i === 1) {
        return { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup_members", arguments: JSON.stringify({ type: "User" }) } }] };
      }
      const toolMsg = messages.filter((m) => m.role === "tool").pop();
      lookupResponse = String(toolMsg?.content ?? "");
      return { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "verify_fill", arguments: JSON.stringify({ code: "return user.fullName;" }) } }] };
    };
    const r = await fillRegion(target, { rootDir: dir, llm: DUMMY_LLM, transport, skipVerify: true });
    expect(r.status).toBe("filled");
    // lookup_members owned User'ın gerçek üyelerini TİPLERİYLE döndürdü (uydurma değil).
    expect(lookupResponse).toContain("User {");
    expect(lookupResponse).toContain("fullName: string"); // alan adı + tip (nullability görünür)
    rmSync(dir, { recursive: true, force: true });
  });

  it("yanlış-case üye (user.id) tek turda snap'lenir (user.Id) ve YEŞİL geçer; saklanan gövde düzeltilmiş", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-"));
    fixture(dir);
    const target = selectSkeletons(dir)[0]!;
    const r = await fillRegion(target, { rootDir: dir, llm: DUMMY_LLM, transport: scriptedTransport(["return user.id;"], "verify_fill"), skipVerify: true });
    expect(r.status).toBe("filled"); // snap sonrası ihlal yok → tek tur yeşil
    expect(r.body).toContain("user.Id"); // saklanan gövde düzeltilmiş (re-inject güvenli)
    const out = readFileSync(join(dir, "src", "user.service.ts"), "utf8");
    expect(out).toContain("user.Id"); // disk düzeltilmiş
    expect(out).not.toContain("user.id;"); // ham yanlış-case kalmadı
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("fillProject — paralel (per-file), scripted transport", () => {
  function svc(cls: string, methods: { name: string; node: string }[]): string {
    const body = methods
      .map(
        (m) => `  async ${m.name}(): Promise<unknown> {
    // @solarch:surgical id=${m.node}#${m.name}
    // Does ${m.name}.
    throw new Error("NOT_IMPLEMENTED: ${cls}.${m.name}");
  }`,
      )
      .join("\n\n");
    return `import { Injectable } from "@nestjs/common";\n@Injectable()\nexport class ${cls} {\n${body}\n}\n`;
  }

  it("birden çok dosyayı paralel doldurur; aynı dosyanın bölgeleri birbirini EZMEZ", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fillp-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    // a.service.ts: AYNI dosyada İKİ bölge (per-file sıralı kalmalı → ikisi de dolu).
    writeFileSync(join(dir, "src", "a.service.ts"), svc("AService", [{ name: "doA1", node: "a1" }, { name: "doA2", node: "a2" }]));
    writeFileSync(join(dir, "src", "b.service.ts"), svc("BService", [{ name: "doB", node: "b1" }]));

    const report = await fillProject({
      rootDir: dir,
      llm: DUMMY_LLM,
      transport: scriptedTransport(["return 1;"], "verify_fill"),
      concurrency: 4, // dosyalar paralel; aynı dosya tek worker'da
      skipVerify: true,
    });

    expect(report.filled).toBe(3);
    const a = readFileSync(join(dir, "src", "a.service.ts"), "utf8");
    const b = readFileSync(join(dir, "src", "b.service.ts"), "utf8");
    // Aynı dosyadaki iki bölge de dolu → paralelde clobber yok (per-file sıralı).
    expect(a).not.toContain("NOT_IMPLEMENTED");
    expect(b).not.toContain("NOT_IMPLEMENTED");
    expect(a.match(/@solarch:filled/g)?.length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("DiagnosticsPool entegrasyonu: dolan gövdenin eksik owned import'unu havuz ekler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fillp-pool-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "widget.entity.ts"), `export class Widget {\n  id!: string;\n}\n`);
    writeFileSync(join(dir, "src", "w.service.ts"), svc("WService", [{ name: "make", node: "w1" }]));

    // Gövde owned `Widget`'ı kullanır ama import edemez (yalnız gövde yazılır) →
    // repair fazının TEK SICAK HAVUZU (DiagnosticsPool.fixImports) import'u eklemeli.
    const report = await fillProject({
      rootDir: dir,
      llm: DUMMY_LLM,
      transport: scriptedTransport(["return new Widget();"], "verify_fill"),
      skipVerify: true,
    });

    expect(report.filled).toBe(1);
    const w = readFileSync(join(dir, "src", "w.service.ts"), "utf8");
    expect(w).toContain("new Widget()"); // gövde yazıldı
    expect(w).toMatch(/import \{ Widget \} from "\.\/widget\.entity"/); // havuz eksik import'u ekledi
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("SPEC_SYSTEM (davranış-testi kuralları)", () => {
  it("round-trip / üretici→tüketici invariant testini ister (sahte JWT'yi yakalar)", () => {
    expect(SPEC_SYSTEM.toLowerCase()).toContain("round-trip");
    // Tüketiciyi mock'lama / hatayı yutma yasağı (round-trip gerçek olmalı).
    expect(SPEC_SYSTEM.toLowerCase()).toMatch(/do not mock the consumer|swallow/);
  });
  it("şekil değil DEĞER assertion'ı ister (hardcoded/placeholder değeri yakalar)", () => {
    expect(SPEC_SYSTEM.toLowerCase()).toMatch(/concrete value|not just the shape|shape-only/);
  });
});

describe("generateSpecForService (scripted transport, jest yok)", () => {
  it("mock spec'i <servis>.spec.ts olarak yazar, jest geçmezse passed:false raporlar", async () => {
    const d = mkdtempSync(join(tmpdir(), "spec-"));
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, "src", "order.service.ts"), `import { Injectable } from "@nestjs/common";\n@Injectable()\nexport class OrderService { async list(): Promise<number[]> { return []; } }\n`);
    const r = await generateSpecForService(d, "src/order.service.ts", DUMMY_LLM, {
      maxAttempts: 1,
      transport: scriptedTransport(["```ts\ndescribe('OrderService', () => { it('works', () => expect(true).toBe(true)); });\n```"], "run_tests"),
    });
    expect(r.status).toBe("written");
    expect(r.file).toBe("src/order.service.spec.ts");
    expect(r.passed).toBe(false); // tmp dir'de jest yok → koşamaz
    const spec = readFileSync(join(d, "src", "order.service.spec.ts"), "utf8");
    expect(spec).toContain("describe('OrderService'");
    expect(spec).not.toContain("```"); // çitler soyuldu
    rmSync(d, { recursive: true, force: true });
  });
});
