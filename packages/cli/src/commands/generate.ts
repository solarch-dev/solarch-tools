/** solarch generate — cloud'daki graftan deterministik kod iskeleti üret ve
 *  çalışma dizinine yaz.
 *
 *  Yazma politikası (emek koruması):
 *  - Yeni dosya → yazılır.
 *  - Mevcut dosya → varsayılan ATLANIR (elle/AI ile doldurulmuş kod ezilmez);
 *    `--force` hepsinin üzerine yazar.
 *  Üretim deterministiktir (aynı graf → bayt-aynı çıktı), bu yüzden değişmemiş
 *  iskelet dosyalarının üzerine yazmak zararsızdır — ama "değişti mi"yi
 *  kestirmek yerine kullanıcı kararına bırakıyoruz. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import pc from "picocolors";
import { SolarchApi, type GeneratedFile } from "../api.js";
import { readProjectConfig } from "../config.js";

export interface GenerateOptions {
  rootDir: string;
  /** Mevcut dosyaların üzerine de yaz. */
  force?: boolean;
}

export interface WriteResult {
  written: string[];
  skipped: string[];
  /** force ile üzerine yazılanlar (written'ın alt kümesi değil — ayrı liste). */
  overwritten: string[];
}

/** Üretilen dosyaları diske uygula — saf yazma katmanı (eklenti de kullanır). */
export function writeGeneratedFiles(
  rootDir: string,
  files: GeneratedFile[],
  opts: { force?: boolean } = {},
): WriteResult {
  const root = resolve(rootDir);
  const result: WriteResult = { written: [], skipped: [], overwritten: [] };
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
  }
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
