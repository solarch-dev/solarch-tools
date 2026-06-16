/** Post-fill verification gates: TypeScript typecheck + the project's test suite.
 *  Both run in the TARGET project dir (the NestJS repo being filled), spawned
 *  synchronously. Heavy but high-signal — the "realistic graph" lesson is that a
 *  contract check alone misses tsc/DI errors that only surface at build time. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

/** `tsc --noEmit` — projenin yerel tsc'si varsa onu, yoksa npx ile. */
export function runTypecheck(rootDir: string): VerifyResult {
  const localTsc = join(rootDir, "node_modules", ".bin", "tsc");
  const { code, output } = existsSync(localTsc)
    ? run(localTsc, ["--noEmit"], rootDir)
    : run("npx", ["--no-install", "tsc", "--noEmit"], rootDir);
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
