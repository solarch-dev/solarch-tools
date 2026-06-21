/** Codebase keşif araçları (read/grep/glob) — opencode formatına uyarlı, salt-okunur,
 *  rootDir/src'e kapsamlı. Path-traversal reddi + format kilidi. */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { read, grep, glob } from "../src/fill/fs-tools.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fstools-"));
  mkdirSync(join(dir, "src", "video", "entities"), { recursive: true });
  mkdirSync(join(dir, "src", "video", "dto"), { recursive: true });
  writeFileSync(
    join(dir, "src", "video", "entities", "video.entity.ts"),
    `export class Video {\n  id!: string;\n  @Column({ nullable: true })\n  videoUrl?: string;\n}\n`,
  );
  writeFileSync(
    join(dir, "src", "video", "dto", "video.dto.ts"),
    `export class VideoDto {\n  id!: string;\n  videoUrl!: string;\n}\n`,
  );
  writeFileSync(
    join(dir, "src", "video", "video.service.ts"),
    `export class VideoService {\n  build() {\n    const v = this.videoRepository.save(new Video());\n    return v;\n  }\n}\n`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("read", () => {
  it("dosyayı `<line>: <content>` formatında satır-numaralı okur", () => {
    const out = read(dir, "src/video/entities/video.entity.ts");
    expect(out).toContain("1: export class Video {");
    expect(out).toContain("videoUrl?: string");
    expect(out).toMatch(/lines 1-\d+ of \d+/);
  });
  it("offset/limit ile bölüm okur", () => {
    const out = read(dir, "src/video/entities/video.entity.ts", 2, 1);
    expect(out).toContain("2: ");
    expect(out).not.toContain("1: export class");
  });
  it("path-traversal REDDEDİLİR (src dışı)", () => {
    expect(read(dir, "../../../etc/passwd")).toMatch(/path must be a project-relative/);
  });
  it("olmayan dosyada benzer-ad önerir (miss)", () => {
    const out = read(dir, "src/video/entities/video.ent.ts");
    expect(out).toMatch(/file not found/);
  });
});

describe("grep", () => {
  it("regex ile içerik arar, `Found N matches` + dosya-gruplu döner", () => {
    const out = grep(dir, "videoRepository\\.save");
    expect(out).toMatch(/Found \d+ match/);
    expect(out).toContain("video.service.ts:");
    expect(out).toMatch(/Line \d+:/);
  });
  it("include filtresi dosyaları kısıtlar (*.entity.ts)", () => {
    const out = grep(dir, "videoUrl", "*.entity.ts");
    expect(out).toContain("video.entity.ts");
    expect(out).not.toContain("video.dto.ts"); // dto include dışı
  });
  it("eşleşme yoksa net mesaj", () => {
    expect(grep(dir, "zzzNotThere")).toMatch(/No matches/);
  });
});

describe("glob", () => {
  it("**/*.entity.ts deseni eşleşen yolları döndürür", () => {
    const out = glob(dir, "**/*.entity.ts");
    expect(out).toContain("src/video/entities/video.entity.ts");
    expect(out).not.toContain("video.dto.ts");
  });
  it("*.dto.ts deseni DTO'ları bulur", () => {
    expect(glob(dir, "**/*.dto.ts")).toContain("video.dto.ts");
  });
  it("eşleşme yoksa net mesaj", () => {
    expect(glob(dir, "**/*.python")).toMatch(/No files matching/);
  });
});
