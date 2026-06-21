/** Post-fill verification gates: TypeScript typecheck + the project's test suite.
 *  Both run in the TARGET project dir (the NestJS repo being filled), spawned
 *  synchronously. Heavy but high-signal — the "realistic graph" lesson is that a
 *  contract check alone misses tsc/DI errors that only surface at build time. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixMissingImportsInFiles } from "@solarch/ast-core";

export interface VerifyResult {
  ok: boolean;
  /** İnsan-okur çıktı (hata satırları) — retry'a beslenir / raporlanır. */
  output: string;
  /** Bu geçit uygulanamadı (örn. test script yok) → engelleyici sayma. */
  skipped?: boolean;
}

function run(cmd: string, args: string[], cwd: string): { code: number; output: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: false });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { code: r.status ?? (r.error ? 1 : 0), output };
}

/** Type-check komutunu (binary + args) çöz — SAF, spawn'sız (test edilebilir).
 *
 *  SOLARCH_USE_TSGO=1 ise TypeScript 7.0 native derleyici (`tsgo`, @typescript/native-preview)
 *  seçilir — tip-kontrol semantiği TS 6.0 ile BİREBİR aynı, ~9x daha hızlı (soğuk tam-proje geçidi).
 *  Çıktı formatı (`file(line,col): error TSxxxx`) + exit-code aynı → retry parse'i değişmez. tsgo
 *  `.bin` shim'i tsc gibi shell-wrapper; çağıran `run()` shell:false ile DOĞRUDAN spawn eder.
 *  tsgo istendi ama yoksa → yerel tsc'ye GÜVENLİ GERİ DÜŞÜŞ (geçit asla kırılmaz); pre-release
 *  olduğundan varsayılan tsc. tsgo TS 7.0 → tsconfig baseUrl'siz olmalı (scaffold TS7-uyumlu üretir). */
export function resolveTypecheckCommand(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[] } {
  const useTsgo = env.SOLARCH_USE_TSGO === "1";
  const localTsgo = join(rootDir, "node_modules", ".bin", "tsgo");
  const localTsc = join(rootDir, "node_modules", ".bin", "tsc");
  if (useTsgo && existsSync(localTsgo)) return { cmd: localTsgo, args: ["--noEmit"] };
  if (existsSync(localTsc)) return { cmd: localTsc, args: ["--noEmit"] }; // tsgo yoksa güvenli geri düşüş
  return { cmd: "npx", args: ["--no-install", useTsgo ? "tsgo" : "tsc", "--noEmit"] };
}

/** `<tsc|tsgo> --noEmit` — projenin yerel binary'si varsa onu, yoksa npx ile (bkz. resolveTypecheckCommand). */
export function runTypecheck(rootDir: string): VerifyResult {
  const { cmd, args } = resolveTypecheckCommand(rootDir);
  const { code, output } = run(cmd, args, rootDir);
  return { ok: code === 0, output: output || (code === 0 ? "typecheck clean" : "typecheck failed") };
}

/** Paket yöneticisini lock dosyasından tespit et. */
function detectPm(rootDir: string): "pnpm" | "yarn" | "npm" {
  if (existsSync(join(rootDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(rootDir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** Projenin `test` script'ini çalıştır — yoksa atlanır (engelleyici değil). */
export function runTests(rootDir: string): VerifyResult {
  const pkgPath = join(rootDir, "package.json");
  if (!existsSync(pkgPath)) return { ok: true, skipped: true, output: "no package.json — tests skipped" };
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return { ok: true, skipped: true, output: "unreadable package.json — tests skipped" };
  }
  if (!scripts.test || /no test specified/i.test(scripts.test)) {
    return { ok: true, skipped: true, output: "no test script — tests skipped" };
  }
  const pm = detectPm(rootDir);
  const { code, output } = run(pm, pm === "npm" ? ["test", "--silent"] : ["test"], rootDir);
  return { ok: code === 0, output: output || (code === 0 ? "tests passed" : "tests failed") };
}

/** Tek bir spec dosyasını jest ile koş (spec-repair için). */
export function runJestFile(rootDir: string, specRelFile: string): VerifyResult {
  const localJest = join(rootDir, "node_modules", ".bin", "jest");
  const { code, output } = existsSync(localJest)
    ? run(localJest, [specRelFile, "--silent"], rootDir)
    : run("npx", ["--no-install", "jest", specRelFile, "--silent"], rootDir);
  return { ok: code === 0, output: output || (code === 0 ? "spec passed" : "spec failed") };
}

/** Spec'i diske yaz → import'ları düzelt (relative + jest-global'leri node:test'ten
 *  söker) → o spec'i jest ile koş. run_tests tool'unun tek-adım doğrulayıcısı. */
export function writeSpecAndRun(rootDir: string, specRelFile: string, content: string): VerifyResult {
  writeFileSync(join(rootDir, specRelFile), content);
  try {
    fixMissingImportsInFiles(rootDir, [specRelFile]);
  } catch {
    /* en iyi çaba — dil servisi çözemezse spec yine koşulur */
  }
  return runJestFile(rootDir, specRelFile);
}
