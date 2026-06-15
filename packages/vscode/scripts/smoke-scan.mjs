/** Bundle-integrity smoke test for `runScan`.
 *
 *  WHY: the extension's core feature (runScan = ts-morph AST tarama) is inlined
 *  by esbuild into a single dist/extension.js. ts-morph + the TypeScript compiler
 *  contain dynamic `require(...)` calls esbuild can't statically resolve; a green
 *  build does NOT prove the bundled scan works at runtime. This reproduces the
 *  real failure mode WITHOUT launching an Extension Development Host (F5).
 *
 *  WHAT: bundles a tiny entry that calls @solarch/cli/lib's `runScan` with the
 *  EXACT same esbuild config as build.mjs (bundle + platform:node + cjs +
 *  external:vscode), then runs that BUNDLE under node against a real NestJS repo.
 *
 *  Usage:
 *    node scripts/smoke-scan.mjs [targetDir]
 *  Default target: ../../../example_cli_project (the in-repo NestJS fixture).
 *
 *  Exit 0 + node/edge counts  → the packaged scan works.
 *  Exit 1 + error             → the bundle breaks runScan (see error above). */

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const target = resolve(process.argv[2] ?? join(pkgRoot, "..", "..", "..", "example_cli_project"));

if (!existsSync(join(target, "tsconfig.json"))) {
  console.error(`No tsconfig.json under ${target} — pass a NestJS project dir: node scripts/smoke-scan.mjs <dir>`);
  process.exit(2);
}

// Aynı zinciri (@solarch/cli/lib → ts-morph → typescript) bundle eden minik giriş.
const entry = `
import { runScan } from "@solarch/cli/lib";
const g = runScan(process.argv[2]);
console.log(JSON.stringify({
  nodes: g.nodes.length,
  edges: g.edges.length,
  files: g.fileCount,
  warnings: g.warnings.length,
}));
`;

const out = join(pkgRoot, "dist", "smoke-scan.cjs");

// build.mjs ile BİREBİR aynı bundling sözleşmesi — yalnız entry farklı.
await build({
  stdin: { contents: entry, resolveDir: pkgRoot, loader: "ts" },
  outfile: out,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  minify: true,
  logLevel: "info",
});

console.error(`\nRunning bundled runScan against: ${target}\n`);
const res = spawnSync(process.execPath, [out, target], { encoding: "utf8" });
process.stdout.write(res.stdout ?? "");
process.stderr.write(res.stderr ?? "");

if (res.status !== 0) {
  console.error(
    `\n❌ runScan FAILED inside the esbuild bundle (exit ${res.status}).\n` +
      "   The packaged extension's scan is broken — see the error above.\n" +
      "   Fix: externalize ts-morph + typescript instead of bundling them (see README/CHANGELOG notes).",
  );
  process.exit(1);
}
console.error("\n✅ runScan works in the esbuild bundle — the packaged scan is sound.");
