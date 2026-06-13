/** solarch generate — produce deterministic code scaffold from cloud graph and
 *  write into the working directory.
 *
 *  Write policy (protects effort):
 *  - New file → written.
 *  - Existing file → skipped by default (hand/AI-filled code is never overwritten);
 *    `--force` overwrites all.
 *  Generation is deterministic (same graph → byte-identical output), so overwriting
 *  unchanged scaffold files would be harmless — but we leave “changed or not” to
 *  the user instead of guessing. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import pc from "picocolors";
import { SolarchApi, type GeneratedFile } from "../api.js";
import { mergeGeneratedManifest, readProjectConfig, type GeneratedManifest } from "../config.js";

export interface GenerateOptions {
  rootDir: string;
  /** Overwrite existing files too. */
  force?: boolean;
}

export interface WriteResult {
  written: string[];
  skipped: string[];
  /** Overwritten via force (not a subset of written — separate list). */
  overwritten: string[];
}

/** Apply generated files to disk — pure write layer (extension uses this too).
 *  Marked files are recorded in `.solarch/generated.json` manifest —
 *  status detects “marker loss” (file exists but markers were removed) from here. */
export function writeGeneratedFiles(
  rootDir: string,
  files: GeneratedFile[],
  opts: { force?: boolean } = {},
): WriteResult {
  const root = resolve(rootDir);
  const result: WriteResult = { written: [], skipped: [], overwritten: [] };
  const manifest: GeneratedManifest = {};
  for (const f of files) {
    // Yol güvenliği: kök dışına taşan path'ler (../ vb.) reddedilir.
    const target = resolve(join(root, f.path));
    if (!target.startsWith(root + sep)) {
      result.skipped.push(f.path);
      continue;
    }
    const exists = existsSync(target);
    if (exists && !opts.force) {
      result.skipped.push(f.path);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
    if (exists) result.overwritten.push(f.path);
    else result.written.push(f.path);
    if (f.surgicalMarkers > 0) {
      manifest[f.path] = { nodeId: f.nodeId, markers: f.surgicalMarkers };
    }
  }
  if (Object.keys(manifest).length > 0) mergeGeneratedManifest(rootDir, manifest);
  return result;
}

export async function generateCommand(opts: GenerateOptions): Promise<void> {
  const config = readProjectConfig(opts.rootDir);
  if (!config?.projectId) {
    console.error(pc.red("No linked project. Run `solarch link` first."));
    process.exitCode = 1;
    return;
  }

  const api = SolarchApi.fromStoredCredentials();
  const project = await api.generateCode(config.projectId);

  const markers = project.files.reduce((acc, f) => acc + f.surgicalMarkers, 0);
  console.log(
    pc.bold(`Constructor output`) +
      pc.dim(` — ${project.files.length} file(s), ${markers} surgical marker(s) to implement.`),
  );

  const result = writeGeneratedFiles(opts.rootDir, project.files, { force: opts.force });

  for (const p of result.written) console.log(`  ${pc.green("+")} ${p}`);
  for (const p of result.overwritten) console.log(`  ${pc.yellow("~")} ${p} ${pc.dim("(overwritten)")}`);
  if (result.skipped.length > 0) {
    console.log(pc.dim(`  ${result.skipped.length} existing file(s) skipped — use --force to overwrite.`));
  }
  for (const w of project.warnings) console.log(pc.yellow(`  ! ${w}`));

  console.log("");
  console.log(
    pc.green(`${result.written.length + result.overwritten.length} file(s) applied.`) +
      pc.dim(" Next: `solarch status` to see what needs implementing."),
  );
}
