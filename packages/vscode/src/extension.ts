/** Solarch eklenti girişi — yan sekme (Activity Bar) TreeView modeli.
 *
 *  Akış: aktivasyon (workspace'te solarch.json) → ilk tarama → yan sekme listesi
 *  + status bar + Problems. Her .ts kaydı 500ms debounce ile yeniden tarar;
 *  cloud 60sn'de bir yoklanır (revizyon arttıysa "Update available"). */

import { accessSync } from "node:fs";
import * as vscode from "vscode";
import { generateAction, linkAction, loginAction, pullAction, pushAction } from "./actions.js";
import { StateEngine } from "./state.js";
import { RevisionLog, StateTreeProvider } from "./tree.js";
import type { GraphState } from "./shared.js";

const DEBOUNCE_MS = 500;
const POLL_MS = 60_000;

export function activate(context: vscode.ExtensionContext): void {
  // Teşhis kanalı — View → Output → "Solarch". Her yenileme özetini yazar.
  const log = vscode.window.createOutputChannel("Solarch");
  context.subscriptions.push(log);
  log.appendLine(`[activate] solarch-vscode ${context.extension?.packageJSON?.version ?? "?"}`);

  // TreeView KOŞULSUZ kaydedilir — yoksa görünüm "no data provider" hatası
  // gösterir. Bağlı repo yoksa liste yönlendirme mesajı taşır.
  let rootDir = findRoot();
  let engine: StateEngine | null = rootDir ? new StateEngine(rootDir) : null;
  log.appendLine(`[activate] rootDir: ${rootDir ?? "(none)"}`);

  const tree = new StateTreeProvider(new RevisionLog(context.workspaceState), (msg) => log.appendLine(msg));
  const treeView = vscode.window.createTreeView("solarchState", { treeDataProvider: tree });
  log.appendLine(`[activate] tree view registered (visible: ${treeView.visible})`);

  const diagnostics = vscode.languages.createDiagnosticCollection("solarch");
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "solarchState.focus";
  statusBar.text = "$(type-hierarchy) Solarch";
  statusBar.show();
  context.subscriptions.push(treeView, diagnostics, statusBar);

  let refreshing = false;
  let queued = false;

  /** Tek uçuş kuralı: yenileme sürerken gelen istek kuyruklanır (en fazla 1). */
  async function refresh(forceCloud: boolean): Promise<void> {
    if (refreshing) {
      queued = true;
      return;
    }
    refreshing = true;
    try {
      // Kök her seferinde yeniden denenir — kullanıcı sonradan `solarch link`
      // çalıştırırsa eklenti restart istemeden toparlar.
      if (!engine) {
        rootDir = findRoot();
        engine = rootDir ? new StateEngine(rootDir) : null;
      }
      let state: GraphState;
      if (!engine) {
        state = {
          ok: false,
          reason: "notLinked",
          message: "No solarch.json found in this workspace.",
          suggestion: "Link this repository to a Solarch project.",
        };
      } else {
        // Beklenmedik hata görünmez kalmasın — listede gerekçesiyle gösterilir.
        state = await engine.refresh({ forceCloud }).catch((e: Error) => ({
          ok: false as const,
          reason: "scanError" as const,
          message: e.message,
          suggestion: "Run the Solarch: Refresh command to retry.",
        }));
      }
      log.appendLine(
        state.ok
          ? `[refresh] ok — rev ${state.graphRevision}, ${state.nodes.length} node(s), ${state.findings.length} finding(s)`
          : `[refresh] ${state.reason}: ${state.message}`,
      );
      tree.setState(state);
      // viewsWelcome (login/link butonları) hangi durumda görüneceğini buradan öğrenir.
      void vscode.commands.executeCommand("setContext", "solarch.status", state.ok ? "ok" : state.reason);
      publish(state, rootDir ?? "", diagnostics, statusBar);
    } finally {
      refreshing = false;
      if (queued) {
        queued = false;
        void refresh(false);
      }
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("solarch.refresh", () => void refresh(true)),
    vscode.commands.registerCommand("solarch.checkDrift", async () => {
      await refresh(true);
      await vscode.commands.executeCommand("workbench.actions.view.problems");
    }),
    vscode.commands.registerCommand("solarch.acknowledge", () => tree.acknowledge()),
    vscode.commands.registerCommand("solarch.openFinding", (file: string, line?: number) => {
      void vscode.window.showTextDocument(vscode.Uri.file(`${rootDir}/${file}`), {
        preview: true,
        ...(line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {}),
      });
    }),
    // CLI motoru doğrudan arka planda — terminal yok, native arayüz.
    vscode.commands.registerCommand("solarch.login", async () => {
      if (await loginAction()) await refresh(true);
    }),
    vscode.commands.registerCommand("solarch.link", async () => {
      const target = rootDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!target) {
        void vscode.window.showWarningMessage("Solarch: open a folder first.");
        return;
      }
      if (await linkAction(target)) {
        engine = null; // solarch.json yeni yazıldı — kök yeniden çözülsün
        await refresh(true);
      }
    }),
    vscode.commands.registerCommand("solarch.pull", async () => {
      if (!rootDir) return;
      await pullAction(rootDir);
      await refresh(true);
    }),
    vscode.commands.registerCommand("solarch.push", async () => {
      if (!rootDir) return;
      if (await pushAction(rootDir)) await refresh(true);
    }),
    vscode.commands.registerCommand("solarch.generate", async () => {
      if (!rootDir) {
        void vscode.window.showWarningMessage("Solarch: open a linked folder first.");
        return;
      }
      if (await generateAction(rootDir)) await refresh(false);
    }),
  );

  // Kayıtta debounce'lu yeniden tarama — yalnız bu repo'nun .ts dosyaları.
  // solarch.json kaydı da yakalanır (link sonrası ilk senkron).
  let timer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const isTs = doc.fileName.endsWith(".ts") && rootDir !== undefined && doc.fileName.startsWith(rootDir);
      const isLink = doc.fileName.endsWith("solarch.json");
      if (!isTs && !isLink) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(isLink), DEBOUNCE_MS);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      engine = null; // kök değişmiş olabilir — sıradaki refresh yeniden bulur
      void refresh(true);
    }),
  );

  // Periyodik cloud yoklaması — başka biri canvas'ta değişiklik yaptıysa
  // revizyon artar, yan sekme "Update available" gösterir.
  const poll = setInterval(() => void refresh(true), POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });

  void refresh(true);
}

export function deactivate(): void {
  // subscriptions üzerinden temizleniyor
}

/* ── yardımcılar ─────────────────────────────────────────────────── */

/** solarch.json içeren ilk workspace klasörü. */
function findRoot(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = vscode.Uri.joinPath(folder.uri, "solarch.json");
    try {
      // Multi-root'ta solarch.json içeren ilk klasör kazanır.
      accessSync(candidate.fsPath);
      return folder.uri.fsPath;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** GraphState'i Problems + status bar'a yay (yan sekmeyi tree.setState besledi). */
function publish(
  state: GraphState,
  rootDir: string,
  diagnostics: vscode.DiagnosticCollection,
  statusBar: vscode.StatusBarItem,
): void {
  if (!state.ok) {
    diagnostics.clear();
    statusBar.text = "$(type-hierarchy) Solarch: —";
    statusBar.tooltip = `${state.message}\n${state.suggestion}`;
    statusBar.backgroundColor = undefined;
    return;
  }

  // Problems: dosyası olan bulgular ilgili dosyaya, kalanlar solarch.json'a.
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const f of state.findings) {
    const severity =
      f.severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : f.severity === "warn"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
    const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), f.message, severity);
    d.source = "solarch";
    d.code = f.code;
    const file = f.file ? `${rootDir}/${f.file}` : `${rootDir}/solarch.json`;
    const list = byFile.get(file) ?? [];
    list.push(d);
    byFile.set(file, list);
  }
  diagnostics.clear();
  for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(file), list);

  const { errors, warns } = state.counts;
  const impl = state.implementation;
  const implSuffix = impl.total > 0 ? `  $(tools) ${impl.filled}/${impl.total}` : "";
  statusBar.text =
    (errors === 0 && warns === 0
      ? "$(check) Solarch: in sync"
      : `$(type-hierarchy) Solarch: ${errors}E ${warns}W`) + implSuffix;
  statusBar.tooltip =
    `${state.projectName} — revision ${state.graphRevision}\n${errors} error(s), ${warns} warning(s).` +
    (impl.total > 0 ? `\n${impl.filled}/${impl.total} generated member(s) implemented.` : "") +
    `\nClick to open the Solarch view.`;
  statusBar.backgroundColor = errors > 0 ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
}
