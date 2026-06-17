/** writeSurgicalBody — iskelet metot gövdesini gerçek kodla değiştirme,
 *  marker'ı koruma, filled imzası, sözleşme yeniden denetimi. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { readDeclaredSurface, writeSurgicalBody } from "../src/surgical.js";

const SKELETON = `import { Injectable } from "@nestjs/common";

class NotFoundException extends Error {}
class ConflictException extends Error {}

@Injectable()
export class UserService {
  constructor(private readonly userRepository: { findById(id: string): Promise<unknown> }) {}

  async getById(id: string): Promise<unknown> {
    // @solarch:surgical id=aaaa-1111#getById
    // Retrieves a user by id.
    // throws: NotFoundException
    // deps: userRepository
    throw new Error("NOT_IMPLEMENTED: UserService.getById");
  }
}
`;

function classOf(source: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("user.service.ts", source);
  return sf.getClassOrThrow("UserService");
}

describe("writeSurgicalBody", () => {
  it("gövdeyi değiştirir, marker'ı korur, filled imzası ekler, NOT_IMPLEMENTED'i kaldırır", () => {
    const cls = classOf(SKELETON);
    const body = `const user = await this.userRepository.findById(id);
if (!user) throw new NotFoundException();
return user;`;
    const res = writeSurgicalBody(cls, "getById", body, "2026-06-16T00:00:00Z");

    expect(res.ok).toBe(true);
    expect(res.violations ?? []).toEqual([]);

    const text = cls.getMethodOrThrow("getById").getText();
    expect(text).toContain("// @solarch:surgical id=aaaa-1111#getById"); // marker korundu
    expect(text).toContain("// throws: NotFoundException"); // kontrat korundu
    expect(text).toContain("// @solarch:filled by=ai at=2026-06-16T00:00:00Z"); // imza eklendi
    expect(text).toContain("this.userRepository.findById(id)"); // gerçek kod yazıldı
    expect(text).not.toContain("NOT_IMPLEMENTED"); // iskelet throw'u gitti
  });

  it("bildirilmemiş exception fırlatan gövde → sözleşme ihlali raporlar", () => {
    const cls = classOf(SKELETON);
    const res = writeSurgicalBody(cls, "getById", `throw new ConflictException();`, "2026-06-16T00:00:00Z");
    expect(res.ok).toBe(true);
    expect(res.violations?.some((v) => v.includes("ConflictException"))).toBe(true);
  });

  it("var olmayan region için hata döner", () => {
    const cls = classOf(SKELETON);
    const res = writeSurgicalBody(cls, "nope", "return 1;", "2026-06-16T00:00:00Z");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nope");
  });

  it("bildirilen throws gövdede gerçeklenmezse → ihlal (throws-realization)", () => {
    const cls = classOf(SKELETON); // throws: NotFoundException deklare
    // Gövde NotFoundException'ı hiç fırlatmıyor → eksik gerçekleme.
    const res = writeSurgicalBody(cls, "getById", `return await this.userRepository.findById(id);`, "2026-06-16T00:00:00Z");
    expect(res.ok).toBe(true);
    expect(res.violations?.some((v) => /never reached/.test(v) && v.includes("NotFoundException"))).toBe(true);
  });

  it("çağrı-İPUCU deps'i (this.http.post) → taban erişimini (this.http) bildirilmiş sayar", () => {
    // ExternalService emitter deps'i metot-yolu olarak yazar; gövde this.http.post(...) çağırır.
    const src = `import { Injectable } from "@nestjs/common";
class HttpService { post(u: string, b: unknown): Promise<unknown> { return Promise.resolve(b); } }
@Injectable()
export class EmailService {
  private readonly baseUrl = "http://x";
  constructor(private readonly http: HttpService) {}
  async sendEmail(to: string): Promise<void> {
    // @solarch:surgical id=bbbb-2222#sendEmail
    // POST /send.
    // deps: this.http.post, this.baseUrl
    throw new Error("NOT_IMPLEMENTED: EmailService.sendEmail");
  }
}`;
    const project = new Project({ useInMemoryFileSystem: true });
    const cls = project.createSourceFile("email.client.ts", src).getClassOrThrow("EmailService");
    const res = writeSurgicalBody(cls, "sendEmail", `await this.http.post(this.baseUrl + "/send", { to });`, "2026-06-16T00:00:00Z");
    expect(res.ok).toBe(true);
    expect(res.violations ?? []).toEqual([]); // this.http erişimi reddedilmemeli
  });

  it("LLM gövdeye prose sızdırırsa → ihlal döner ve gövdeyi YAZMAZ (iskelet korunur)", () => {
    const cls = classOf(SKELETON);
    // Gerçek regresyon: model gövdenin başına akıl-yürütme metni koydu.
    const leaked = `variable naming, etc. Use plain types. No method signature. So I'll output:

const user = await this.userRepository.findById(id);
return user;`;
    const res = writeSurgicalBody(cls, "getById", leaked, "2026-06-16T00:00:00Z");
    expect(res.ok).toBe(true);
    expect(res.violations?.some((v) => /not valid TypeScript|prose/i.test(v))).toBe(true);
    // Bozuk gövde YAZILMADI → iskelet throw'u yerinde, prose dosyaya sızmadı.
    const text = cls.getMethodOrThrow("getById").getText();
    expect(text).toContain("NOT_IMPLEMENTED");
    expect(text).not.toContain("So I'll output");
  });
});

describe("readDeclaredSurface (grounding)", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "sub"), { recursive: true });

  writeFileSync(
    join(dir, "sub", "user.repository.ts"),
    `export class UserRepository {
  async save(u: { id: string }): Promise<{ id: string }> { return u; }
  async findById(id: string): Promise<{ id: string } | null> { return null; }
}`,
  );
  writeFileSync(
    join(dir, "sub", "user-role.enum.ts"),
    `export enum UserRole { ADMIN = "admin", USER = "user" }`,
  );
  writeFileSync(
    join(dir, "sub", "not-found.exception.ts"),
    `export class NotFoundException extends Error { constructor() { super("nf"); } }`,
  );
  writeFileSync(
    join(dir, "sub", "complaint.entity.ts"),
    `import { Column, Entity, ManyToOne } from "typeorm";
import { Observable } from "rxjs";
class User {}
@Entity()
export class Complaint {
  @Column({ type: "uuid" })
  customerId!: string;
  @ManyToOne(() => User)
  customer?: User;
  fetchRemote(): Observable<string> { return null as never; }
}`,
  );
  writeFileSync(
    join(dir, "sub", "user.service.ts"),
    `import { UserRepository } from "./user.repository";
import { UserRole } from "./user-role.enum";
import { NotFoundException } from "./not-found.exception";
import { Complaint } from "./complaint.entity";
export class UserService {
  constructor(private readonly userRepository: UserRepository) {}
  async x(): Promise<Complaint | null> { throw new Error("NOT_IMPLEMENTED: x"); }
}`,
  );

  const surface = readDeclaredSurface(join(dir, "sub", "user.service.ts"));

  it("import edilen sınıfın gerçek metodlarını listeler (create yok, save var)", () => {
    expect(surface).toContain("class UserRepository");
    expect(surface).toContain("save(");
    expect(surface).toContain("findById(");
    expect(surface).not.toContain("create(");
  });
  it("enum üyelerini DEĞERLERİYLE verir", () => {
    expect(surface).toContain("enum UserRole");
    expect(surface).toContain('ADMIN = "admin"');
  });
  it("exception'ın sıfır-arg constructor'ını gösterir", () => {
    expect(surface).toMatch(/class NotFoundException \{ constructor\(\) \}/);
  });
  it("relation'ı (@ManyToOne) etiketler — AI flat alan (customerName) uydurmasın", () => {
    expect(surface).toMatch(/customer: User \(relation @ManyToOne/);
    expect(surface).toContain("customerId: string (fk scalar)");
  });
  it("Observable dönen metodu işaretler (firstValueFrom)", () => {
    expect(surface).toContain("Observable");
    expect(surface).toContain("firstValueFrom");
  });
});
