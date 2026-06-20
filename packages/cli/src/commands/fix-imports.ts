/** solarch fix-imports — DETERMİNİSTİK import çözücü (AI YOK, tsc YOK).
 *
 *  SINIR: Surgical AI yalnız metot GÖVDESİNİ (algoritmayı) yazar, tipleri ADLA referans
 *  eder; import EKLEYEMEZ (yalnız gövde yazılır). Import'lar SİSTEMİN işidir — bu komut
 *  onları deterministik olarak bağlar. codegen.generate kayıtlı gövdeleri taze iskelete
 *  re-inject ettiğinde import'lar düşer (yalnız gövde saklanır) → her üretim sonrası bu
 *  komut çalışır, "Cannot find name" kalmaz. ast-core fixMissingImportsInFiles'ı sarar
 *  (owned tip/operatör + isim-çakışması owned-tercihi tek kaynaktan). */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import { fixMissingImportsInFiles } from "@solarch/ast-core";

export interface FixImportsOptions {
  rootDir: string;
  /** Makine-okur NDJSON çıktısı (sunucu spawn'ı için). */
  json?: boolean;
}

/** src altındaki @solarch:filled içeren .ts dosyaları (spec hariç). Yalnız DOLU dosyalar
 *  owned tip/operatör referans edebilir; iskelet-yalnız dosyalar zaten import'lu/derlenir. */
function filledFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (e !== "node_modules" && e !== "dist") walk(p);
        continue;
      }
      if (!p.endsWith(".ts") || p.endsWith(".spec.ts") || p.endsWith(".test.ts")) continue;
      try {
        if (readFileSync(p, "utf8").includes("@solarch:filled")) out.push(relative(rootDir, p));
      } catch {
        /* atla */
      }
    }
  };
  walk(join(rootDir, "src"));
  return out;
}

export async function fixImportsCommand(opts: FixImportsOptions): Promise<void> {
  const emit = (o: Record<string, unknown>): boolean => process.stdout.write(JSON.stringify(o) + "\n");
  const files = filledFiles(opts.rootDir);
  if (files.length === 0) {
    if (opts.json) emit({ event: "fixed", files: [] });
    else console.log(pc.dim("No filled files — nothing to resolve."));
    return;
  }
  let fixed: string[] = [];
  try {
    fixed = fixMissingImportsInFiles(opts.rootDir, files).fixed;
  } catch (e) {
    if (opts.json) emit({ event: "fatal", message: (e as Error).message });
    else console.error(pc.red(`fix-imports failed: ${(e as Error).message}`));
    return;
  }
  if (opts.json) emit({ event: "fixed", files: fixed });
  else console.log(`${pc.green("✓")} resolved imports in ${pc.bold(String(fixed.length))} file(s)`);
}
