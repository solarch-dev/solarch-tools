/** Solarch eklenti girişi — yan sekme (Activity Bar) TreeView modeli.
 *
 *  Akış: aktivasyon (workspace'te solarch.json) → ilk tarama → yan sekme listesi
 *  + status bar + Problems. Her .ts kaydı 500ms debounce ile yeniden tarar;
 *  cloud 60sn'de bir yoklanır (revizyon arttıysa "Update available"). */

import * as vscode from "vscode";
import { readCredentials } from "@solarch/cli/lib";
import { generateAction, linkAction, loginAction, pullAction, pushAction } from "./actions.js";
import { bindAction, syncBindingsForSavedFile } from "./binding.js";
import { resolveTrackedRoot, selectFolderAction } from "./folder.js";
import { StateEngine } from "./state.js";
import { RevisionLog, StateTreeProvider } from "./tree.js";
import { contextKeyForState, type GraphState } from "./shared.js";

const DEBOUNCE_MS = 500;
const POLL_MS = 60_000;

export function activate(context: vscode.ExtensionContext): void {
  // Teşhis kanalı — View → Output → "Solarch". Her yenileme özetini yazar.
  const log = vscode.window.createOutputChannel("Solarch");
  context.subscriptions.push(log);
  log.appendLine(`[activate] solarch-vscode ${context.extension?.packageJSON?.version ?? "?"}`);

  // TreeView KOŞULSUZ kaydedilir — yoksa görünüm "no data provider" hatası
  // gösterir. Bağlı repo yoksa liste yönlendirme mesajı taşır.
  let rootDir = resolveTrackedRoot(context.workspaceState);
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
  context.subscriptions.push(tree, treeView, diagnostics, statusBar);

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
        rootDir = resolveTrackedRoot(context.workspaceState);
        engine = rootDir ? new StateEngine(rootDir) : null;
      }
      let state: GraphState;
      if (!engine) {
        // Kök yok: giriş yapılmadıysa önce "Sign in", yapıldıysa "klasör seç".
        state = readCredentials()
          ? {
              ok: false,
              reason: "noFolder",
              message: "No project folder selected to track.",
              suggestion: "Choose the folder Solarch should track.",
            }
          : {
              ok: false,
              reason: "notLoggedIn",
              message: "Not signed in.",
              suggestion: "Sign in with an API key from Solarch → Settings → API Keys.",
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
      void vscode.commands.executeCommand("setContext", "solarch.status", contextKeyForState(state));
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
      if (!rootDir) return;
      const uri = vscode.Uri.joinPath(vscode.Uri.file(rootDir), file);
      void vscode.window
        .showTextDocument(uri, {
          preview: true,
          ...(line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {}),
        })
        .then(undefined, (e: unknown) => {
          void vscode.window.showWarningMessage(
            `Solarch: couldn't open ${file} — ${e instanceof Error ? e.message : "file not found"}. ` +
              "It may exist only in the cloud graph (not yet in code).",
          );
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
      if (await pullAction(rootDir)) await refresh(true);
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
    vscode.commands.registerCommand("solarch.bind", async () => {
      if (!rootDir) {
        void vscode.window.showWarningMessage("Solarch: open a linked folder first.");
        return;
      }
      if (await bindAction(rootDir)) await refresh(false);
    }),
    vscode.commands.registerCommand("solarch.selectFolder", async () => {
      const chosen = await selectFolderAction(context.workspaceState);
      if (chosen) {
        engine = null; // izlenen kök değişti — yeniden çözülsün
        await refresh(true);
      }
    }),
    vscode.commands.registerCommand("solarch.switchProject", async () => {
      if (!rootDir) {
        void vscode.window.showWarningMessage("Solarch: select a folder to track first.");
        return;
      }
      // link akışı klasörü tekrar sormaz — aynı kökte projeyi yeniden seçtirir.
      if (await linkAction(rootDir)) {
        engine = null;
        await refresh(true);
      }
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
      // Canlı binding: kaydedilen Entity'ye bağlı DTO'ları senkronla (watch aynası).
      if (isTs && rootDir) syncBindingsForSavedFile(rootDir, doc.fileName);
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(isLink), DEBOUNCE_MS);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      engine = null; // kök değişmiş olabilir — sıradaki refresh yeniden bulur
      void refresh(true);
    }),
  );
  // Bekleyen debounce timer'ı teardown'da iptal et — listener dispose edilse de
  // ≤500ms önce kurulmuş bir timer fire edip yok edilmiş nesnelere dokunabilir.
  context.subscriptions.push({ dispose: () => { if (timer) clearTimeout(timer); } });

  // Periyodik cloud yoklaması — başka biri canvas'ta değişiklik yaptıysa
  // revizyon artar, yan sekme "Update available" gösterir.
  const poll = setInterval(() => void refresh(true), POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });

  void refresh(true);
}

export function deactivate(): void {
  // Tüm tek-tek kaynaklar (output channel, treeView, diagnostics, statusBar,
  // komutlar, save listener, poll interval ve debounce timer) context.subscriptions
  // üzerinden dispose ediliyor — burada ek temizlik gerekmiyor.
}

/* ── yardımcılar ─────────────────────────────────────────────────── */

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
      : `$(type-hierarchy) Solarch: ${errors}E ${warns}W`) +
    implSuffix +
    (state.offline ? "  $(debug-disconnect)" : "");
  statusBar.tooltip =
    `${state.projectName} — revision ${state.graphRevision}\n${errors} error(s), ${warns} warning(s).` +
    (impl.total > 0 ? `\n${impl.filled}/${impl.total} generated member(s) implemented.` : "") +
    (state.offline ? `\nOffline — drift computed against the last pulled graph; rule checks paused.` : "") +
    `\nClick to open the Solarch view.`;
  statusBar.backgroundColor = errors > 0 ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
}
