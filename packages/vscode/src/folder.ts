/** İzlenen klasör — hangi proje klasörünü Solarch takip ediyor.
 *
 *  Monorepo desteği: kullanıcı workspace İÇİNDEN bir alt klasör seçebilir;
 *  seçim workspaceState'e kalıcı yazılır. Seçim yoksa eski davranışa düşülür
 *  (solarch.json içeren ilk workspace klasörü). solarch.json ve tüm tarama
 *  bu köke göredir. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

const TRACKED_ROOT_KEY = "solarch.trackedRoot";
const SKIP = new Set(["node_modules", ".git", "dist", "out", "build", ".next", ".solarch"]);

/** İzlenen kök: kalıcı seçim (hâlâ varsa) → solarch.json'lu ilk workspace
 *  klasörü → undefined. */
export function resolveTrackedRoot(workspaceState: vscode.Memento): string | undefined {
  const saved = workspaceState.get<string>(TRACKED_ROOT_KEY);
  if (saved && existsSync(saved)) return saved;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (existsSync(join(folder.uri.fsPath, "solarch.json"))) return folder.uri.fsPath;
  }
  return undefined;
}

function saveTrackedRoot(workspaceState: vscode.Memento, dir: string): void {
  void workspaceState.update(TRACKED_ROOT_KEY, dir);
}

/** Proje gibi görünen klasörler: package.json veya solarch.json taşıyanlar,
 *  workspace köklerinden ≤2 derinlik (node_modules vb. atlanır). */
function discoverProjectDirs(): { dir: string; linked: boolean }[] {
  const found = new Map<string, boolean>(); // dir → solarch.json var mı
  const isProject = (dir: string): boolean =>
    existsSync(join(dir, "package.json")) || existsSync(join(dir, "solarch.json"));
  const visit = (dir: string, depth: number): void => {
    if (isProject(dir)) found.set(dir, existsSync(join(dir, "solarch.json")));
    if (depth >= 2) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP.has(name) || name.startsWith(".")) continue;
      const child = join(dir, name);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      visit(child, depth + 1);
    }
  };
  for (const folder of vscode.workspace.workspaceFolders ?? []) visit(folder.uri.fsPath, 0);
  return [...found.entries()].map(([dir, linked]) => ({ dir, linked }));
}

/** Workspace köküne göre okunur yol (tek köklü repoda klasör adı). */
function relLabel(dir: string): string {
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const base = f.uri.fsPath;
    if (dir === base) return f.name;
    if (dir.startsWith(base + "/")) return dir.slice(base.length + 1);
  }
  return dir;
}

/** İzlenecek klasörü seçtir + kalıcı yaz. Seçilirse yeni kökü, iptalde null döner. */
export async function selectFolderAction(workspaceState: vscode.Memento): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage("Solarch: open a folder first.");
    return null;
  }

  const current = resolveTrackedRoot(workspaceState);
  const items: (vscode.QuickPickItem & { dir?: string; browse?: boolean })[] = discoverProjectDirs()
    .sort((a, b) => relLabel(a.dir).localeCompare(relLabel(b.dir)))
    .map((p) => ({
      label: relLabel(p.dir),
      description: p.linked ? "linked" : undefined,
      detail: p.dir === current ? "current" : undefined,
      dir: p.dir,
    }));
  items.push({ label: "$(folder-opened) Browse…", browse: true });

  const pick = await vscode.window.showQuickPick(items, {
    title: "Solarch — folder to track",
    placeHolder: "Pick the project folder Solarch should track",
    ignoreFocusOut: true,
  });
  if (!pick) return null;

  let chosen = pick.dir;
  if (pick.browse) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: "Select the folder Solarch should track",
      defaultUri: folders[0]?.uri,
    });
    chosen = picked?.[0]?.fsPath;
  }
  if (!chosen) return null;

  saveTrackedRoot(workspaceState, chosen);
  void vscode.window.showInformationMessage(`Solarch: now tracking "${relLabel(chosen)}".`);
  return chosen;
}
