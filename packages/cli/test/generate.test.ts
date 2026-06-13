/** writeGeneratedFiles — emek koruması (mevcut dosya atlanır) + force + yol güvenliği. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GeneratedFile } from "../src/api.js";
import { writeGeneratedFiles } from "../src/commands/generate.js";

const file = (path: string, content = "generated\n"): GeneratedFile => ({
  path,
  content,
  language: "typescript",
  surgicalMarkers: 0,
});

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeGeneratedFiles", () => {
  it("yeni dosyaları iç içe klasörlerle yazar", () => {
    dir = mkdtempSync(join(tmpdir(), "gen-"));
    const result = writeGeneratedFiles(dir, [file("src/users/users.service.ts"), file("package.json")]);
    expect(result.written.sort()).toEqual(["package.json", "src/users/users.service.ts"]);
    expect(readFileSync(join(dir, "src/users/users.service.ts"), "utf8")).toBe("generated\n");
  });

  it("mevcut dosyayı varsayılan atlar — elle yazılmış kod ezilmez", () => {
    dir = mkdtempSync(join(tmpdir(), "gen-"));
    writeFileSync(join(dir, "app.ts"), "hand-written\n");
    const result = writeGeneratedFiles(dir, [file("app.ts")]);
    expect(result.skipped).toEqual(["app.ts"]);
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe("hand-written\n");
  });

  it("force ile üzerine yazar ve ayrı raporlar", () => {
    dir = mkdtempSync(join(tmpdir(), "gen-"));
    writeFileSync(join(dir, "app.ts"), "old\n");
    const result = writeGeneratedFiles(dir, [file("app.ts"), file("new.ts")], { force: true });
    expect(result.overwritten).toEqual(["app.ts"]);
    expect(result.written).toEqual(["new.ts"]);
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe("generated\n");
  });

  it("kök dışına taşan path'leri reddeder", () => {
    dir = mkdtempSync(join(tmpdir(), "gen-"));
    const result = writeGeneratedFiles(dir, [file("../escape.ts")]);
    expect(result.skipped).toEqual(["../escape.ts"]);
    expect(existsSync(join(dir, "..", "escape.ts"))).toBe(false);
  });
});
