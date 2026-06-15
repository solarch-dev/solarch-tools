/** Live binding — Entity/Model → DTO alan senkronu, IDE-native.
 *
 *  CLI'daki `solarch bind` + `solarch watch` sözleşmesinin birebir karşılığı:
 *  - bindAction: kaynak/hedef/alan seçtiren QuickPick akışı → solarch.json'a
 *    BindingConfig yazar + ilk senkronu hemen çalıştırır.
 *  - syncBindingsForSavedFile: kaydedilen .ts dosyasına bağlı binding'leri
 *    çalıştırır (watch.syncBindingsFor aynası) — hedef DTO diske güncellenir.
 *
 *  Motor (runBinding/parseBindingRef) @solarch/ast-core'dan; CLI ile tek kaynak. */

import { relative } from "node:path";
import * as vscode from "vscode";
import { parseBindingRef, runBinding } from "@solarch/ast-core";
import { readProjectConfig, runScan, writeProjectConfig } from "@solarch/cli/lib";

/* ── ortak rapor ─────────────────────────────────────────────────── */

interface BindingOutcome {
  targetFile: string;
  added: string[];
  conflicts: { property: string; reason: string }[];
}

function reportBinding(outcome: BindingOutcome): void {
  const { targetFile, added, conflicts } = outcome;
  if (added.length > 0) {
    void vscode.window.showInformationMessage(`Solarch: ${targetFile} — synced ${added.join(", ")}.`);
  }
  if (conflicts.length > 0) {
    void vscode.window.showWarningMessage(
      `Solarch: ${targetFile} — ${conflicts.length} field(s) left untouched: ` +
        conflicts.map((c) => `${c.property} (${c.reason})`).join("; "),
    );
  }
  if (added.length === 0 && conflicts.length === 0) {
    void vscode.window.showInformationMessage(`Solarch: ${targetFile} — already in sync.`);
  }
}

/** Kaynak node'un alan adlarını best-effort çıkar (Columns/Fields/Properties).
 *  Bulamazsa boş döner → çağıran "all" binding'e düşer. */
function sourceFieldNames(node: { properties: Record<string, unknown> }): string[] {
  const props = node.properties;
  const arr = (props.Columns ?? props.Fields ?? props.Properties) as Array<{ Name?: unknown }> | undefined;
  if (!Array.isArray(arr)) return [];
  return arr.map((c) => c.Name).filter((n): n is string => typeof n === "string");
}

/* ── interactive bind ────────────────────────────────────────────── */

/** Entity/Model → DTO binding tanımla + ilk senkronu çalıştır. */
export async function bindAction(rootDir: string): Promise<boolean> {
  let asIs;
  try {
    asIs = runScan(rootDir);
  } catch (e) {
    void vscode.window.showErrorMessage(`Solarch: scan failed — ${(e as Error).message}`);
    return false;
  }

  const sources = asIs.nodes.filter((n) => n.kind === "Table" || n.kind === "Model");
  const targets = asIs.nodes.filter((n) => n.kind === "DTO");
  if (sources.length === 0) {
    void vscode.window.showWarningMessage("Solarch: no Entity/Model classes found to bind from.");
    return false;
  }
  if (targets.length === 0) {
    void vscode.window.showWarningMessage("Solarch: no DTO classes found to bind to.");
    return false;
  }

  const sourcePick = await vscode.window.showQuickPick(
    sources.map((n) => ({ label: n.name, description: n.file, detail: n.kind, node: n })),
    { title: "Bind — source (Entity/Model)", placeHolder: "Class whose fields drive the sync", ignoreFocusOut: true },
  );
  if (!sourcePick) return false;

  const targetPick = await vscode.window.showQuickPick(
    targets.map((n) => ({ label: n.name, description: n.file, node: n })),
    { title: "Bind — target (DTO)", placeHolder: "DTO that should receive the fields", ignoreFocusOut: true },
  );
  if (!targetPick) return false;

  const sourceRef = `${sourcePick.node.file}#${sourcePick.node.name}`;
  const targetRef = `${targetPick.node.file}#${targetPick.node.name}`;

  // Alan seçimi: tümü mü, belirli alanlar mı.
  const scope = await vscode.window.showQuickPick(
    [
      { label: "All fields", value: "all" as const },
      { label: "Pick fields…", value: "pick" as const },
    ],
    { title: "Bind — which fields?", ignoreFocusOut: true },
  );
  if (!scope) return false;

  let fields: "all" | string[] = "all";
  if (scope.value === "pick") {
    const names = sourceFieldNames(sourcePick.node);
    if (names.length === 0) {
      void vscode.window.showWarningMessage("Solarch: couldn't read fields from the source — binding all fields.");
    } else {
      const picks = await vscode.window.showQuickPick(
        names.map((f) => ({ label: f })),
        { title: "Bind — fields to sync", canPickMany: true, ignoreFocusOut: true },
      );
      if (!picks || picks.length === 0) return false;
      fields = picks.map((p) => p.label);
    }
  }

  // Ref formatını erken doğrula (yarım yazılmış config'ten iyidir).
  try {
    parseBindingRef(sourceRef);
    parseBindingRef(targetRef);
  } catch (e) {
    void vscode.window.showErrorMessage(`Solarch: ${(e as Error).message}`);
    return false;
  }

  // Binding'i solarch.json'a yaz (varsa alanlarını güncelle).
  const existing = readProjectConfig(rootDir);
  const config = existing ?? { projectId: "", bindings: [] };
  const already = config.bindings.find((b) => b.source === sourceRef && b.target === targetRef);
  if (already) already.fields = fields;
  else config.bindings.push({ source: sourceRef, target: targetRef, fields });
  writeProjectConfig(rootDir, config);

  // İlk senkron — binding kurulur kurulmaz hedef güncel olsun.
  try {
    reportBinding(runBinding(rootDir, sourceRef, targetRef, fields));
  } catch (e) {
    void vscode.window.showErrorMessage(`Solarch: binding saved, but first sync failed — ${(e as Error).message}`);
  }
  return true;
}

/* ── on-save sync (watch aynası) ─────────────────────────────────── */

/** Kaydedilen kaynak dosyaya bağlı binding'leri çalıştır — hedef DTO diske
 *  güncellenir. watch.syncBindingsFor ile aynı eşleştirme (source dosya yolu). */
export function syncBindingsForSavedFile(rootDir: string, savedAbsPath: string): void {
  const config = readProjectConfig(rootDir);
  const bindings = config?.bindings ?? [];
  if (bindings.length === 0) return;

  // Binding ref'leri posix göreli yol taşır; kaydedilen mutlak yolu eşle.
  const rel = relative(rootDir, savedAbsPath).replace(/\\/g, "/");
  for (const b of bindings) {
    const sourceFile = b.source.split("#")[0];
    if (sourceFile !== rel) continue;
    try {
      const outcome = runBinding(rootDir, b.source, b.target, b.fields);
      if (outcome.added.length > 0 || outcome.conflicts.length > 0) reportBinding(outcome);
    } catch (e) {
      void vscode.window.showWarningMessage(
        `Solarch: bind ${b.source} → ${b.target} failed — ${(e as Error).message}`,
      );
    }
  }
}
