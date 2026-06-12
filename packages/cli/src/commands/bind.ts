import pc from "picocolors";
import { parseBindingRef, runBinding } from "@solarch/ast-core";
import { readProjectConfig, writeProjectConfig, type ProjectConfig } from "../config.js";

export interface BindOptions {
  rootDir: string;
  source: string;
  target: string;
  /** Virgülle ayrılmış alan listesi; verilmezse "all". */
  fields?: string;
}

/** Kalıcı bağ tanımla (solarch.json'a yaz) + ilk senkronu hemen çalıştır. */
export function bindCommand(opts: BindOptions): void {
  // Ref formatını erkenden doğrula — hata yarıda kesilen config yazımından iyi.
  parseBindingRef(opts.source);
  parseBindingRef(opts.target);

  const fields: "all" | string[] = opts.fields
    ? opts.fields.split(",").map((f) => f.trim()).filter(Boolean)
    : "all";

  const existing = readProjectConfig(opts.rootDir);
  const config: ProjectConfig = existing ?? { projectId: "", bindings: [] };

  const already = config.bindings.find(
    (b) => b.source === opts.source && b.target === opts.target,
  );
  if (already) {
    already.fields = fields;
  } else {
    config.bindings.push({ source: opts.source, target: opts.target, fields });
  }

  if (!existing) {
    console.log(pc.yellow("No solarch.json yet — writing one with bindings only (run `solarch link` to attach a project)."));
  }
  writeProjectConfig(opts.rootDir, config);
  console.log(pc.green(`Binding saved: ${opts.source} → ${opts.target}`));

  // İlk senkron — bağ kurulur kurulmaz hedef güncel olsun.
  const outcome = runBinding(opts.rootDir, opts.source, opts.target, fields);
  report(outcome.targetFile, outcome);
}

export function report(
  targetFile: string,
  outcome: { added: string[]; conflicts: { property: string; reason: string }[]; upToDate: string[] },
): void {
  if (outcome.added.length > 0) {
    console.log(pc.green(`  + ${targetFile}: injected ${outcome.added.join(", ")}`));
  }
  for (const c of outcome.conflicts) {
    console.log(pc.yellow(`  ! ${targetFile}: ${c.property} — ${c.reason}`));
  }
  if (outcome.added.length === 0 && outcome.conflicts.length === 0) {
    console.log(pc.dim(`  = ${targetFile}: already in sync (${outcome.upToDate.length} field(s))`));
  }
}
