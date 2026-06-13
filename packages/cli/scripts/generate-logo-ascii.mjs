#!/usr/bin/env node
/**
 * brand/logo.svg → terminal ASCII (via @ascii-kit/svg).
 * Output is committed in src/logo.generated.ts — run when the SVG changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { svg2ascii } from "@ascii-kit/svg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const svgPath = join(pkgRoot, "../../../brand/logo.svg");
const outPath = join(pkgRoot, "src/logo.generated.ts");

const CHARS = " .,:;i1tfLCG08@";
const HEIGHT = 14;

const svg = readFileSync(svgPath, "utf8");
const raw = await svg2ascii(svg, { height: HEIGHT, fit: "height", chars: CHARS });
const lines = raw
  .split("\n")
  .map((line) => line.trimEnd())
  .filter((line) => line.trim().length > 0);

const body = lines.map((line) => `  ${JSON.stringify(line)},`).join("\n");

const source = `/** Auto-generated from brand/logo.svg — do not edit. Run: pnpm generate:logo */
export const LOGO_RAMP = ${JSON.stringify(CHARS)} as const;
export const LOGO_LINES = [
${body}
] as const;
`;

writeFileSync(outPath, source, "utf8");
console.log(`Wrote ${lines.length} lines → ${outPath}`);
