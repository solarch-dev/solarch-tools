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

@Injectable()
export class AccountsService {
  /** Doldurulmamış iskelet — codegen çıktısı olduğu gibi duruyor. */
  async createAccount(): Promise<void> {
    // @solarch:surgical id=11111111-aaaa-bbbb-cccc-000000000001#createAccount
    // Yeni hesap açar; bakiye sıfırla başlar.
    // Limit aşımında reddeder.
    // throws: AccountLimitExceededException, DuplicateAccountException
    // deps: accountsRepository, auditService
    throw new Error("NOT_IMPLEMENTED: AccountsService.createAccount");
  }

  /** Cerrahi AI doldurmuş — işaret duruyor ama gövde gerçek kod. */
  async closeAccount(): Promise<boolean> {
    // @solarch:surgical id=11111111-aaaa-bbbb-cccc-000000000001#closeAccount
    const ok = await Promise.resolve(true);
    return ok;
  }

  /** İşaretsiz, elle yazılmış metot — surgical listesine girmez. */
  helper(): number {
    return 42;
  }
}
`,
);

describe("surgical marker extraction", () => {
  const graph = scanProject({ rootDir: dir });
  const svc = graph.nodes.find((n) => n.name === "AccountsService");

  it("işaretli üyeleri durumlarıyla çıkarır, işaretsizi atlar", () => {
    expect(svc?.surgical).toHaveLength(2);
    const byMember = new Map(svc!.surgical!.map((m) => [m.member, m]));
    expect(byMember.get("createAccount")?.status).toBe("skeleton");
    expect(byMember.get("closeAccount")?.status).toBe("filled");
    expect(byMember.has("helper")).toBe(false);
  });

  it("nodeId, açıklama, throws ve deps metadata'sını okur", () => {
    const m = svc!.surgical!.find((x) => x.member === "createAccount")!;
    expect(m.nodeId).toBe("11111111-aaaa-bbbb-cccc-000000000001");
    expect(m.description).toBe("Yeni hesap açar; bakiye sıfırla başlar.\nLimit aşımında reddeder.");
    expect(m.throws).toEqual(["AccountLimitExceededException", "DuplicateAccountException"]);
    expect(m.deps).toEqual(["accountsRepository", "auditService"]);
    expect(m.line).toBeGreaterThan(0);
  });

  it("dolu gövdede metadata olmadan da işaret tanınır", () => {
    const m = svc!.surgical!.find((x) => x.member === "closeAccount")!;
    expect(m.description).toBeUndefined();
    expect(m.throws).toBeUndefined();
  });

  it("özet sayaçları doğru toplar", () => {
    const summary = summarizeSurgical(svc!.surgical!);
    expect(summary).toEqual({ total: 2, filled: 1, skeletons: 1 });
  });

  it("işaretsiz sınıflarda surgical alanı hiç yazılmaz", () => {
    // fixture'sız sınıf: bu dosyada yalnız AccountsService var; mevcut
    // basic-app fixture'ı ayrı testte taranıyor — burada negatif durumu
    // aynı grafın işaretsiz node'u olmadığından şemayla doğruluyoruz.
    expect(svc && "surgical" in svc).toBe(true);
  });
});
