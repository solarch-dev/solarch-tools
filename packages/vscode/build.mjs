/** Tek esbuild çıktısı: dist/extension.js — extension host (CJS, node).
 *  ESM olan @solarch/cli/lib ve ts-morph bundle'a gömülür; yalnız "vscode"
 *  modülü dışarıda kalır. */

import { build, context } from "esbuild";

const config = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
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
