/** Surgical marker okuma — codegen formatındaki işaretlerin skeleton/filled
 *  sınıflandırması ve metadata (description/throws/deps) çıkarımı. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { completeType, formatTypeShape, fixMissingImportsInFiles, readDeclaredSurface, readExpectedTypeHeaders, readProjectCatalog, scanProject, summarizeSurgical, tryFillSurgicalBody } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "ast-surgical-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

mkdirSync(join(dir, "src"), { recursive: true });
writeFileSync(
  join(dir, "src", "accounts.service.ts"),
  `import { Injectable } from "@nestjs/common";

class DuplicateAccountException extends Error {}
class UnknownBillingException extends Error {}

@Injectable()
export class AccountsService {
  constructor(
    private readonly accountsRepository: { save(): Promise<void> },
    private readonly auditService: { log(): void },
    private readonly mailService: { send(): void },
  ) {}

  /** Doldurulmamış iskelet — codegen çıktısı olduğu gibi duruyor. */
  async createAccount(): Promise<void> {
    // @solarch:surgical id=11111111-aaaa-bbbb-cccc-000000000001#createAccount
    // Yeni hesap açar; bakiye sıfırla başlar.
    // Limit aşımında reddeder.
    // throws: AccountLimitExceededException, DuplicateAccountException
    // deps: accountsRepository, auditService
    throw new Error("NOT_IMPLEMENTED: AccountsService.createAccount");
  }

  /** Cerrahi AI doldurmuş — imzalı, sözleşmeye uygun. */
  async closeAccount(): Promise<boolean> {
    // @solarch:surgical id=11111111-aaaa-bbbb-cccc-000000000001#closeAccount
    // throws: DuplicateAccountException
    // deps: accountsRepository
    // @solarch:filled by=ai at=2026-06-13T01:00:00Z
    await this.accountsRepository.save();
    this.validate();
    if (!this.accountsRepository) throw new DuplicateAccountException();
    return true;
  }

  /** İnsan doldurmuş (imzasız) — beyan dışı dep + beyan dışı throw kullanıyor. */
  async suspendAccount(): Promise<void> {
    // @solarch:surgical id=11111111-aaaa-bbbb-cccc-000000000001#suspendAccount
    // throws: DuplicateAccountException
    // deps: accountsRepository
    this.mailService.send();
    throw new UnknownBillingException();
  }

  /** İşaretsiz, elle yazılmış metot — surgical listesine girmez. */
  helper(): number {
    return 42;
  }

  private validate(): void {}
}
`,
);

describe("surgical marker extraction", () => {
  const graph = scanProject({ rootDir: dir });
  const svc = graph.nodes.find((n) => n.name === "AccountsService");
  const byMember = new Map(svc!.surgical!.map((m) => [m.member, m]));

  it("işaretli üyeleri durumlarıyla çıkarır, işaretsizi atlar", () => {
    expect(svc?.surgical).toHaveLength(3);
    expect(byMember.get("createAccount")?.status).toBe("skeleton");
    expect(byMember.get("closeAccount")?.status).toBe("filled");
    expect(byMember.has("helper")).toBe(false);
  });

  it("nodeId, açıklama, throws ve deps metadata'sını okur", () => {
    const m = byMember.get("createAccount")!;
    expect(m.nodeId).toBe("11111111-aaaa-bbbb-cccc-000000000001");
    expect(m.description).toBe("Yeni hesap açar; bakiye sıfırla başlar.\nLimit aşımında reddeder.");
    expect(m.throws).toEqual(["AccountLimitExceededException", "DuplicateAccountException"]);
    expect(m.deps).toEqual(["accountsRepository", "auditService"]);
    expect(m.line).toBeGreaterThan(0);
  });

  it("imzayı okur: damgalı = ai, damgasız dolu = human", () => {
    expect(byMember.get("closeAccount")?.filledBy).toBe("ai");
    expect(byMember.get("closeAccount")?.filledAt).toBe("2026-06-13T01:00:00Z");
    expect(byMember.get("suspendAccount")?.filledBy).toBe("human");
    expect(byMember.get("createAccount")?.filledBy).toBeUndefined(); // iskelette imza olmaz
  });

  it("sözleşmeye uyan dolu gövdede ihlal üretmez (kendi yardımcıları serbest)", () => {
    // closeAccount: beyan edilen dep + beyan edilen throw + this.validate() (kendi metodu).
    expect(byMember.get("closeAccount")?.violations).toBeUndefined();
  });

  it("beyan dışı dep ve throw + gerçeklenmeyen throws ihlal olarak raporlanır", () => {
    const v = byMember.get("suspendAccount")?.violations ?? [];
    expect(v).toHaveLength(3);
    expect(v.some((x) => x.includes('this.mailService'))).toBe(true); // beyan dışı dep
    expect(v.some((x) => x.includes("UnknownBillingException"))).toBe(true); // beyan dışı throw
    // DuplicateAccountException deklare ama gövdede fırlatılmıyor → throws-realization ihlali
    expect(v.some((x) => /never reached/.test(x) && x.includes("DuplicateAccountException"))).toBe(true);
  });

  it("özet sayaçları doğru toplar", () => {
    const summary = summarizeSurgical(svc!.surgical!);
    expect(summary).toEqual({ total: 3, filled: 2, skeletons: 1, filledAi: 1, violations: 1 });
  });
});

describe("readDeclaredSurface — generic metot type-param'ı GÖSTERİR (fill parametrelesin)", () => {
  const gdir = mkdtempSync(join(tmpdir(), "ast-surface-"));
  afterAll(() => rmSync(gdir, { recursive: true, force: true }));
  mkdirSync(join(gdir, "src"), { recursive: true });
  writeFileSync(
    join(gdir, "src", "thing.cache.ts"),
    `export class ThingCache {\n  async get<T>(): Promise<T | null> { return null; }\n  async set<T>(value: T): Promise<void> {}\n  async del(): Promise<void> {}\n}\n`,
  );
  writeFileSync(
    join(gdir, "src", "thing.service.ts"),
    `import { ThingCache } from "./thing.cache";\nexport class ThingService {\n  constructor(private readonly cache: ThingCache) {}\n}\n`,
  );

  it("generic get<T> imzada `<T>` + [generic ...] hint ile görünür; çıplak değil", () => {
    const surface = readDeclaredSurface(join(gdir, "src", "thing.service.ts"));
    // Type-param görünür (eskiden `get(): Promise<T|null>` -> AI T'yi gizem sanıyordu).
    expect(surface).toMatch(/get<T>\(\): Promise<T \| null>/);
    expect(surface).toContain("[generic");
    // del generic DEĞİL -> hint yok.
    expect(surface).toMatch(/del\(\): Promise<void>/);
    expect(surface).not.toMatch(/del<.*>\(/);
  });
});

describe("completeType + autoCorrectMembers — IntelliSense üretici/snap (LLM'siz, gerçek ast-core)", () => {
  const cdir = mkdtempSync(join(tmpdir(), "ast-complete-"));
  afterAll(() => rmSync(cdir, { recursive: true, force: true }));
  mkdirSync(join(cdir, "src"), { recursive: true });
  const svcPath = join(cdir, "src", "user.service.ts");
  writeFileSync(
    join(cdir, "src", "user.entity.ts"),
    `import { OrderStatus } from "./order-status.enum";\nexport class User {\n  Id!: string;\n  fullName!: string;\n  email!: string;\n  status!: OrderStatus;\n}\n`,
  );
  writeFileSync(
    join(cdir, "src", "order-status.enum.ts"),
    `export enum OrderStatus {\n  PENDING = "pending",\n  SHIPPED = "shipped",\n}\n`,
  );
  writeFileSync(
    join(cdir, "src", "not-found.exception.ts"),
    `export class NotFoundException extends Error {\n  constructor(message?: string) {\n    super(message);\n  }\n}\n`,
  );
  writeFileSync(
    svcPath,
    [
      `import { User } from "./user.entity";`,
      `import { OrderStatus } from "./order-status.enum";`,
      `import { NotFoundException } from "./not-found.exception";`,
      ``,
      `export class UserService {`,
      `  getProfile(user: User): string {`,
      `    // @solarch:surgical id=aaaa1111-2222-3333-4444-555566667777#getProfile`,
      `    throw new Error("NOT_IMPLEMENTED: UserService.getProfile");`,
      `  }`,
      ``,
      `  getName(user: User): string {`,
      `    // @solarch:surgical id=aaaa1111-2222-3333-4444-555566667778#getName`,
      `    throw new Error("NOT_IMPLEMENTED: UserService.getName");`,
      `  }`,
      ``,
      `  markStatus(user: User): void {`,
      `    // @solarch:surgical id=aaaa1111-2222-3333-4444-555566667780#markStatus`,
      `    throw new Error("NOT_IMPLEMENTED: UserService.markStatus");`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );

  it("completeType: class -> gerçek public üyeler + metot imzaları", () => {
    const r = completeType(svcPath, "User");
    expect(r.kind).toBe("class");
    expect(r.members).toEqual(expect.arrayContaining(["Id", "fullName", "email"]));
  });

  it("completeType: enum -> tüm literal'ler (ad + değer)", () => {
    const r = completeType(svcPath, "OrderStatus");
    expect(r.kind).toBe("enum");
    expect(r.enumLiterals).toEqual(
      expect.arrayContaining([
        { name: "PENDING", value: "pending" },
        { name: "SHIPPED", value: "shipped" },
      ]),
    );
  });

  it("completeType: exception -> kind:'exception' + ctor imzası", () => {
    const r = completeType(svcPath, "NotFoundException");
    expect(r.kind).toBe("exception");
    expect(r.ctor).toContain("message");
  });

  it("completeType: import edilmemiş / owned-dışı tip -> kind:'unknown' (üye sunulmaz)", () => {
    expect(completeType(svcPath, "Repository").kind).toBe("unknown");
  });

  it("SNAP: yanlış-case üye (user.id) gerçek üyeye (user.Id) çevrilir + kaydedilir", () => {
    const r = tryFillSurgicalBody(svcPath, "UserService", "getProfile", "return user.id;", "2026-06-18T00:00:00Z");
    expect(r.ok).toBe(true);
    expect(r.violations ?? []).toHaveLength(0); // snap sonrası ihlal yok
    expect(r.corrections).toContain("user.id -> user.Id");
    expect(readFileSync(svcPath, "utf8")).toContain("user.Id"); // diske düzeltilmiş yazıldı
  });

  it("UYDURMA: tek-aday olmayan üye (user.username) snap'lenmez -> violation + KAYDEDİLMEZ", () => {
    const before = readFileSync(svcPath, "utf8");
    const r = tryFillSurgicalBody(svcPath, "UserService", "getName", "return user.username;", "2026-06-18T00:00:00Z");
    expect(r.ok).toBe(true);
    expect((r.violations ?? []).length).toBeGreaterThan(0); // hâlâ ihlal
    expect(r.corrections ?? []).toHaveLength(0); // snap yok
    expect(readFileSync(svcPath, "utf8")).toBe(before); // diske YAZILMADI
  });

  it("ENUM-SNAP: owned enum'a atanan string (user.status = \"PENDING\") gerçek üyeye çevrilir", () => {
    const r = tryFillSurgicalBody(svcPath, "UserService", "markStatus", 'user.status = "PENDING";', "2026-06-18T00:00:00Z");
    expect(r.ok).toBe(true);
    expect(r.violations ?? []).toHaveLength(0);
    expect(r.corrections).toContain('"PENDING" -> OrderStatus.PENDING');
    const out = readFileSync(svcPath, "utf8");
    expect(out).toContain("user.status = OrderStatus.PENDING");
    expect(out).not.toContain('user.status = "PENDING"');
  });
});

describe("readExpectedTypeHeaders — ChatLSP 'headers': metodun ÜRETMESİ/TÜKETMESİ gereken tiplerin gerçek şekli", () => {
  const hdir = mkdtempSync(join(tmpdir(), "ast-headers-"));
  afterAll(() => rmSync(hdir, { recursive: true, force: true }));
  mkdirSync(join(hdir, "src"), { recursive: true });
  writeFileSync(
    join(hdir, "src", "role.dto.ts"),
    `export class RoleDto {\n  code!: string;\n  label!: string;\n}\n`,
  );
  writeFileSync(
    join(hdir, "src", "account-status.enum.ts"),
    `export enum AccountStatus {\n  ACTIVE = "active",\n  BANNED = "banned",\n}\n`,
  );
  writeFileSync(
    join(hdir, "src", "profile.dto.ts"),
    `import { RoleDto } from "./role.dto";\nexport class ProfileDto {\n  Id!: string;\n  displayName!: string;\n  avatarUrl?: string;\n  role!: RoleDto;\n}\n`,
  );
  const svcPath = join(hdir, "src", "account.service.ts");
  writeFileSync(
    svcPath,
    [
      `import { ProfileDto } from "./profile.dto";`,
      `import { AccountStatus } from "./account-status.enum";`,
      ``,
      `export class AccountService {`,
      `  async getProfile(status: AccountStatus): Promise<ProfileDto> {`,
      `    // @solarch:surgical id=hhhh1111-2222-3333-4444-555566667777#getProfile`,
      `    throw new Error("NOT_IMPLEMENTED: AccountService.getProfile");`,
      `  }`,
      ``,
      `  async ping(): Promise<void> {`,
      `    // @solarch:surgical id=hhhh1111-2222-3333-4444-555566667778#ping`,
      `    throw new Error("NOT_IMPLEMENTED: AccountService.ping");`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );

  it("dönüş tipini (Promise<ProfileDto>) sarmalı açıp GERÇEK alanlarıyla verir", () => {
    const h = readExpectedTypeHeaders(svcPath, "AccountService", "getProfile");
    expect(h).toContain("class ProfileDto");
    expect(h).toContain("displayName");
  });

  it("BİR sıçrama transitif: ProfileDto.role -> RoleDto'nun alanlarını da getirir", () => {
    const h = readExpectedTypeHeaders(svcPath, "AccountService", "getProfile");
    expect(h).toContain("class RoleDto");
    expect(h).toMatch(/code.*label|label.*code/s);
  });

  it("NULLABILITY proaktif: optional alan ilk prompt'ta `?` ile görünür (zorunlu alan `?`'siz)", () => {
    const h = readExpectedTypeHeaders(svcPath, "AccountService", "getProfile");
    expect(h).toContain("avatarUrl?: string"); // nullable → ? ile (köprü gerektiğini önceden görür)
    expect(h).toMatch(/displayName: string/); // zorunlu → ? yok
    expect(h).not.toContain("avatarUrl: string"); // ?'siz hâli OLMAMALI
  });

  it("parametre tipini (owned enum) describe eder", () => {
    const h = readExpectedTypeHeaders(svcPath, "AccountService", "getProfile");
    expect(h).toContain("enum AccountStatus");
  });

  it("dönüş/param owned değilse (Promise<void>) boş döner", () => {
    expect(readExpectedTypeHeaders(svcPath, "AccountService", "ping").trim()).toBe("");
  });
});

describe("readProjectCatalog — Aider repo-map: projedeki TÜM owned tipler (whole-codebase farkındalığı)", () => {
  const pdir = mkdtempSync(join(tmpdir(), "ast-catalog-"));
  afterAll(() => rmSync(pdir, { recursive: true, force: true }));
  mkdirSync(join(pdir, "src"), { recursive: true });
  writeFileSync(join(pdir, "src", "user.entity.ts"), `export class User {\n  Id!: string;\n}\n`);
  writeFileSync(join(pdir, "src", "order.entity.ts"), `export class Order {\n  Id!: string;\n}\n`);
  writeFileSync(join(pdir, "src", "order-status.enum.ts"), `export enum OrderStatus {\n  NEW = "new",\n  DONE = "done",\n}\n`);
  writeFileSync(join(pdir, "src", "not-found.exception.ts"), `export class NotFoundException extends Error {}\n`);

  it("sınıfları, enum'ları ve exception'ları ayrı ayrı listeler", () => {
    const cat = readProjectCatalog(pdir);
    expect(cat).toMatch(/classes:.*\bUser\b/);
    expect(cat).toMatch(/classes:.*\bOrder\b/);
    expect(cat).toMatch(/enums:.*OrderStatus/);
    expect(cat).toMatch(/exceptions:.*NotFoundException/);
    // exception class'lar genel "classes" listesine düşmez
    expect(cat).not.toMatch(/classes:[^\n]*NotFoundException/);
  });
});

describe("diagnostics-in-loop — bölge-bazında tip teşhisi (checkTypes): 'Problems paneli' döngüde", () => {
  const ddir = mkdtempSync(join(tmpdir(), "ast-diag-"));
  afterAll(() => rmSync(ddir, { recursive: true, force: true }));
  mkdirSync(join(ddir, "src"), { recursive: true });
  // Strict tsconfig — bölge teşhisleri gerçek tsc ile aynı olsun (null-safety yakalansın).
  writeFileSync(
    join(ddir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "commonjs", strict: true, skipLibCheck: true } }),
  );
  writeFileSync(join(ddir, "src", "user.entity.ts"), `export class User {\n  name!: string;\n}\n`);
  writeFileSync(join(ddir, "src", "foo.entity.ts"), `export class Foo {\n  n!: number;\n}\n`);
  const svcPath = join(ddir, "src", "stats.service.ts");
  const SKEL = [
    `import { User } from "./user.entity";`,
    ``,
    `export class StatsService {`,
    `  async getCount(): Promise<number> {`,
    `    // @solarch:surgical id=dddd1111-2222-3333-4444-555566660001#getCount`,
    `    throw new Error("NOT_IMPLEMENTED: StatsService.getCount");`,
    `  }`,
    ``,
    `  nameOf(u: User | null): string {`,
    `    // @solarch:surgical id=dddd1111-2222-3333-4444-555566660002#nameOf`,
    `    throw new Error("NOT_IMPLEMENTED: StatsService.nameOf");`,
    `  }`,
    ``,
    `  async compute(): Promise<number> {`,
    `    // @solarch:surgical id=dddd1111-2222-3333-4444-555566660003#compute`,
    `    throw new Error("NOT_IMPLEMENTED: StatsService.compute");`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
  const reset = () => writeFileSync(svcPath, SKEL);
  const iso = "2026-06-19T00:00:00Z";

  it("YANLIŞ DÖNÜŞ tipi (Promise<number>'a string) → tip-hatası ihlali + KAYDEDİLMEZ", () => {
    reset();
    const r = tryFillSurgicalBody(svcPath, "StatsService", "getCount", `return "five";`, iso, { rootDir: ddir, checkTypes: true });
    expect(r.ok).toBe(true);
    expect((r.violations ?? []).some((v) => /type error/.test(v))).toBe(true);
    expect(readFileSync(svcPath, "utf8")).toContain("NOT_IMPLEMENTED: StatsService.getCount"); // kaydedilmedi
  });

  it("DOĞRU dönüş (return 5) → ihlal yok, KAYDEDİLİR", () => {
    reset();
    const r = tryFillSurgicalBody(svcPath, "StatsService", "getCount", `return 5;`, iso, { rootDir: ddir, checkTypes: true });
    expect(r.ok).toBe(true);
    expect(r.violations ?? []).toHaveLength(0);
    expect(readFileSync(svcPath, "utf8")).toContain("return 5;");
  });

  it("STRICT NULL (u possibly null) → tip-hatası ihlali + KAYDEDİLMEZ (tsconfig strict yüklendi)", () => {
    reset();
    const r = tryFillSurgicalBody(svcPath, "StatsService", "nameOf", `return u.name;`, iso, { rootDir: ddir, checkTypes: true });
    expect(r.ok).toBe(true);
    expect((r.violations ?? []).some((v) => /type error/.test(v))).toBe(true);
    expect(readFileSync(svcPath, "utf8")).toContain("NOT_IMPLEMENTED: StatsService.nameOf");
  });

  it("checkTypes KAPALI → aynı null-unsafe gövde tip-denetlenmez (opt-in kanıtı)", () => {
    reset();
    const r = tryFillSurgicalBody(svcPath, "StatsService", "nameOf", `return u.name;`, iso, { rootDir: ddir, checkTypes: false });
    expect(r.ok).toBe(true);
    expect(r.violations ?? []).toHaveLength(0); // AST geçer, tip-denetim kapalı
  });

  it("'Cannot find name' (import edilmemiş owned tip) BLOKLAMAZ → import-fix'in işi, kaydedilir", () => {
    reset();
    // `new Foo()` → Foo import edilmemiş → TS2304 Cannot find name (elenir); return 5 doğru → kaydedilir.
    const r = tryFillSurgicalBody(svcPath, "StatsService", "compute", `const f = new Foo(); return 5;`, iso, { rootDir: ddir, checkTypes: true });
    expect(r.ok).toBe(true);
    expect(r.violations ?? []).toHaveLength(0);
    expect(readFileSync(svcPath, "utf8")).toContain("const f = new Foo();");
  });

  it("OBJECT-LITERAL CAST owned tipe (`{...} as User`) → ihlal + KAYDEDİLMEZ (tsc mutlu olsa bile)", () => {
    reset();
    // { name } User'a ŞEKİLCE uyar → tsc TS2352 vermez; ama cast deseni yasak:
    // uydurma entity inşası, import çözülünce kırılabilir. AST geçidi yakalar.
    const r = tryFillSurgicalBody(svcPath, "StatsService", "compute", `const u = { name: "x" } as User; return 5;`, iso, { rootDir: ddir, checkTypes: true });
    expect(r.ok).toBe(true);
    expect((r.violations ?? []).some((v) => /object literal to "User"/.test(v))).toBe(true);
    expect(readFileSync(svcPath, "utf8")).toContain("NOT_IMPLEMENTED: StatsService.compute"); // kaydedilmedi
  });

  it("owned-DIŞI tipe object-literal cast (`{} as Record<...>`) → ihlal YOK (tsc'nin işi)", () => {
    reset();
    const r = tryFillSurgicalBody(svcPath, "StatsService", "compute", `const m = {} as Record<string, number>; return 5;`, iso, { rootDir: ddir, checkTypes: true });
    expect(r.ok).toBe(true);
    expect((r.violations ?? []).some((v) => /object literal to/.test(v))).toBe(false);
  });
});

describe("fixMissingImportsInFiles — isim çakışması: owned entity node_modules'a TERCİH edilir", () => {
  const idir = mkdtempSync(join(tmpdir(), "ast-import-"));
  afterAll(() => rmSync(idir, { recursive: true, force: true }));
  mkdirSync(join(idir, "src", "like", "entities"), { recursive: true });
  writeFileSync(
    join(idir, "src", "like", "entities", "like.entity.ts"),
    `export class Like {\n  userId!: string;\n  tweetId!: string;\n}\n`,
  );
  const svc = join(idir, "src", "like", "like.service.ts");
  writeFileSync(
    svc,
    [
      `import { Like } from "typeorm";`, // YANLIŞ kaynak — typeorm'un Like sorgu-operatörü (auto-import çakışması)
      `export class LikeService {`,
      `  make(): Like {`,
      `    const l = new Like();`,
      `    l.userId = "x";`,
      `    return l;`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );

  it("`new Like()` → typeorm import'u sökülür, owned entity relatif import edilir (TS2554/TS7009 önlenir)", () => {
    fixMissingImportsInFiles(idir, ["src/like/like.service.ts"]);
    const out = readFileSync(svc, "utf8");
    expect(out).not.toMatch(/from "typeorm"/); // yanlış kaynak gitti
    expect(out).toMatch(/import \{ Like \} from "\.\/entities\/like\.entity"/); // owned relatif kazandı
  });
});

describe("SoT nullability grounding — completeType alan tipi + reaktif tip-hata zenginleştirme", () => {
  const sdir = mkdtempSync(join(tmpdir(), "ast-sot-"));
  afterAll(() => rmSync(sdir, { recursive: true, force: true }));
  mkdirSync(join(sdir, "src"), { recursive: true });
  writeFileSync(
    join(sdir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "commonjs", strict: true, skipLibCheck: true } }),
  );
  // Diyagram çelişkisi simülasyonu: entity.videoUrl NULLABLE, dto.videoUrl REQUIRED.
  writeFileSync(join(sdir, "src", "video.entity.ts"), `export class Video {\n  id!: string;\n  videoUrl?: string;\n}\n`);
  writeFileSync(join(sdir, "src", "video.dto.ts"), `export class VideoDto {\n  id!: string;\n  videoUrl!: string;\n}\n`);
  const svcPath = join(sdir, "src", "video.service.ts");
  const SKEL = [
    `import { Video } from "./video.entity";`,
    `import { VideoDto } from "./video.dto";`,
    ``,
    `export class VideoService {`,
    `  async getVideo(id: string): Promise<VideoDto> {`,
    `    // @solarch:surgical id=ssss1111-2222-3333-4444-555566660001#getVideo`,
    `    throw new Error("NOT_IMPLEMENTED: VideoService.getVideo");`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
  const reset = () => writeFileSync(svcPath, SKEL);
  const iso = "2026-06-20T00:00:00Z";
  reset(); // svcPath'i kur (completeType import'ları buradan çözer)

  it("completeType: alanları TİP + nullability ile döndürür (videoUrl required vs nullable)", () => {
    const dto = completeType(svcPath, "VideoDto");
    const ent = completeType(svcPath, "Video");
    const dtoUrl = (dto.fields ?? []).find((f) => f.name === "videoUrl");
    const entUrl = (ent.fields ?? []).find((f) => f.name === "videoUrl");
    expect(dtoUrl).toMatchObject({ name: "videoUrl", optional: false }); // DTO: zorunlu
    expect(entUrl).toMatchObject({ name: "videoUrl", optional: true }); // entity: nullable
  });

  it("formatTypeShape: nullable alanı `?` ile gösterir", () => {
    const shape = formatTypeShape("Video", completeType(svcPath, "Video"));
    expect(shape).toContain("videoUrl?: string");
    expect(shape).toContain("id: string");
  });

  it("REAKTİF: nullable kaynağı zorunlu hedefe atayınca → tip hatası + AUTHORITATIVE TYPES (Video şekli) feedback'i + KAYDEDİLMEZ", () => {
    reset();
    // v.videoUrl (string | undefined) → VideoDto.videoUrl (string, zorunlu) köprüsüz atanıyor.
    const body = `const v = new Video(); v.id = id; const dto: VideoDto = { id: v.id, videoUrl: v.videoUrl }; return dto;`;
    const r = tryFillSurgicalBody(svcPath, "VideoService", "getVideo", body, iso, { rootDir: sdir, checkTypes: true });
    expect(r.ok).toBe(true);
    const vis = r.violations ?? [];
    expect(vis.some((v) => /type error/.test(v))).toBe(true); // TS2322 yakalandı
    expect(vis.some((v) => /AUTHORITATIVE TYPES/.test(v))).toBe(true); // SoT şekilleri eklendi
    expect(vis.some((v) => /videoUrl\?: string/.test(v))).toBe(true); // kaynak entity nullable görünüyor
    expect(readFileSync(svcPath, "utf8")).toContain("NOT_IMPLEMENTED"); // kaydedilmedi
  });

  it("KÖPRÜLÜ gövde (?? '') → tip hatası yok, KAYDEDİLİR", () => {
    reset();
    const body = `const v = new Video(); v.id = id; const dto: VideoDto = { id: v.id, videoUrl: v.videoUrl ?? '' }; return dto;`;
    const r = tryFillSurgicalBody(svcPath, "VideoService", "getVideo", body, iso, { rootDir: sdir, checkTypes: true });
    expect(r.ok).toBe(true);
    expect((r.violations ?? []).some((v) => /type error/.test(v))).toBe(false);
    expect(readFileSync(svcPath, "utf8")).toContain("videoUrl: v.videoUrl ?? ''");
  });
});
