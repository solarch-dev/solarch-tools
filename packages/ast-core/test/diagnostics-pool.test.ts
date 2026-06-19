/** DiagnosticsPool — tek sıcak program = havuz: tüm teşhisler buradan, bölgeye
 *  etiketli; gövde belleğe uygulanır + artımsal yeniden okunur; temiz değilse geri
 *  alınır; eksik import düzeltilir. Repair fazının tekrarlı soğuk tsc'sini değiştirir. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiagnosticsPool } from "../src/index.js";

let dir: string;
const ISO = "2026-06-19T00:00:00Z";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ast-pool-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "commonjs", strict: true, skipLibCheck: true } }),
  );
  writeFileSync(join(dir, "src", "user.entity.ts"), `export class User {\n  name!: string;\n}\n`);
  // stats.service.ts — getCount DOLU ama yanlış dönüş (TS2322); helper SURGICAL DEĞİL ama hatalı.
  writeFileSync(
    join(dir, "src", "stats.service.ts"),
    [
      `import { User } from "./user.entity";`,
      ``,
      `export class StatsService {`,
      `  async getCount(): Promise<number> {`,
      `    // @solarch:surgical id=p1#getCount`,
      `    // @solarch:filled by=ai at=2026-06-19T00:00:00Z`,
      `    return "five";`,
      `  }`,
      ``,
      `  nameOf(u: User): string {`,
      `    // @solarch:surgical id=p1#nameOf`,
      `    // @solarch:filled by=ai at=2026-06-19T00:00:00Z`,
      `    return u.name;`,
      `  }`,
      ``,
      `  helper(): number {`,
      `    return "not-a-number";`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("DiagnosticsPool", () => {
  it("problems(): dolu bölgedeki tip hatasını yakalar + bölgeye etiketler", () => {
    const pool = new DiagnosticsPool(dir);
    const probs = pool.problems();
    const getCount = probs.find((p) => p.member === "getCount");
    expect(getCount).toBeTruthy();
    expect(getCount!.code).toBe(2322); // string -> number
    expect(getCount!.className).toBe("StatsService");
  });

  it("problemsByRegion(): yalnız SURGICAL bölgeleri gruplar (helper bölge-dışı, hariç)", () => {
    const pool = new DiagnosticsPool(dir);
    const regions = pool.problemsByRegion();
    expect(regions.some((r) => r.member === "getCount")).toBe(true);
    expect(regions.some((r) => r.member === "helper")).toBe(false); // surgical değil
    // helper'ın hatası bölge-DIŞI havuzda olmalı (rapor edilir, fill düzeltmez)
    expect(pool.nonRegionProblems().some((p) => p.line >= 17)).toBe(true);
  });

  it("applyBody(): düzeltici gövde commit edilir, havuz ARTIMSAL küçülür", () => {
    const pool = new DiagnosticsPool(dir);
    expect(pool.problems().some((p) => p.member === "getCount")).toBe(true);
    const res = pool.applyBody("src/stats.service.ts", "StatsService", "getCount", "return 5;", ISO);
    expect(res.ok).toBe(true);
    expect(res.violations ?? []).toHaveLength(0);
    // aynı program, yeniden oku → getCount hatası GİTTİ (in-memory commit + artımsal)
    expect(pool.problems().some((p) => p.member === "getCount")).toBe(false);
  });

  it("applyBody(): temiz OLMAYAN gövde GERİ ALINIR — havuz tutarlı kalır", () => {
    const pool = new DiagnosticsPool(dir);
    const bad = pool.applyBody("src/stats.service.ts", "StatsService", "getCount", `return "still-string";`, ISO);
    expect((bad.violations ?? []).some((v) => /type error/.test(v))).toBe(true); // aday hatalı
    // commit edilmedi → bölge önceki (hatalı ama tutarlı) gövdesinde; program bozuk-yeni body taşımıyor
    expect(pool.regionBody("src/stats.service.ts", "StatsService", "getCount")).toContain(`return "five"`);
  });

  it("save(): yalnız commit edilen düzeltmeyi diske yazar", () => {
    const pool = new DiagnosticsPool(dir);
    pool.applyBody("src/stats.service.ts", "StatsService", "getCount", "return 5;", ISO);
    pool.save();
    const onDisk = readFileSync(join(dir, "src", "stats.service.ts"), "utf8");
    expect(onDisk).toContain("return 5;");
    expect(onDisk).not.toContain(`return "five"`);
  });

  it("fixImports(): kullanılan owned tipin eksik import'unu ekler", () => {
    // import'suz `new User()` kullanan dosya → fixImports User import'unu eklemeli.
    writeFileSync(
      join(dir, "src", "maker.service.ts"),
      [`export class MakerService {`, `  make(): unknown { return new User(); }`, `}`, ``].join("\n"),
    );
    const pool = new DiagnosticsPool(dir);
    pool.fixImports(["src/maker.service.ts"]);
    pool.save();
    expect(readFileSync(join(dir, "src", "maker.service.ts"), "utf8")).toMatch(/import \{ User \} from "\.\/user\.entity"/);
  });
});
