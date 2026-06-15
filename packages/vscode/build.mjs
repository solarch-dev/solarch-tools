/** Tek esbuild çıktısı: dist/extension.js — extension host (CJS, node).
 *  ESM olan @solarch/cli/lib ve ts-morph bundle'a gömülür; yalnız "vscode"
 *  modülü dışarıda kalır.
 *
 *  LICENSE: monorepo kökündeki tek LICENSE'ı paket köküne kopyalar — VSIX
 *  içine girmesi ve manifest'teki "SEE LICENSE IN LICENSE" referansının
 *  karşılığının bulunması için (vsce yalnız paket köküne göre dosya toplar). */

import { build, context } from "esbuild";
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
copyFileSync(join(here, "..", "..", "..", "LICENSE"), join(here, "LICENSE"));

const config = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  minify: true,
  sourcemap: true,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(config);
  await ctx.watch();
  console.log("[solarch-vscode] watching…");
} else {
  await build(config);
}
