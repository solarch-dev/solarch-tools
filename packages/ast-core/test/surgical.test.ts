/** Surgical marker okuma — codegen formatındaki işaretlerin skeleton/filled
 *  sınıflandırması ve metadata (description/throws/deps) çıkarımı. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanProject, summarizeSurgical } from "../src/index.js";

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
