/** Yan sekme TreeView — Git Graph hissiyatı, native VSCode listesiyle.
 *
 *  Üç bölüm:
 *  1. Durum satırı: senkron / update var (cloud revizyonu son görülenden ileri).
 *  2. Revisions: gözlemlenen revizyonların zaman çizelgesi (nokta + zaman) —
 *     kalıcılık `RevisionLog`'da (revision-log.ts).
 *  3. Drift: bulgular renkli noktalarla (kırmızı = kodda eksik / ihlal,
 *     sarı = yalnız kodda, mavi = property farkı). Tıklayınca kanıt dosyası açılır. */

import * as vscode from "vscode";
import type { RevisionLog } from "./revision-log.js";
import type { GraphState, StateFinding } from "./shared.js";

export { RevisionLog } from "./revision-log.js";

/* ── tree provider ───────────────────────────────────────────────── */

type Item = vscode.TreeItem;

const dot = (color: string): vscode.ThemeIcon =>
  new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(color));

export class StateTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private state: GraphState | null = null;
  private hasUpdate = false;

  constructor(
    private readonly log: RevisionLog,
    private readonly trace: (msg: string) => void = () => {},
  ) {}

  setState(state: GraphState): void {
    this.state = state;
    if (state.ok) {
      this.hasUpdate = this.log.observe(state.graphRevision, state.nodes.length, state.edges.length);
    }
    this.changed.fire(undefined);
  }

  acknowledge(): void {
    if (this.state?.ok) {
      this.log.ack(this.state.graphRevision);
      this.hasUpdate = false;
      this.changed.fire(undefined);
    }
  }

  getTreeItem(item: Item): Item {
    return item;
  }

  getChildren(parent?: Item): Item[] {
    try {
      const items = this.children(parent);
      this.trace(`[tree] getChildren(${parent ? String(parent.label) : "root"}) → ${items.length} item(s)`);
      return items;
    } catch (e) {
      this.trace(`[tree] getChildren FAILED: ${(e as Error).stack ?? (e as Error).message}`);
      return [info(`Solarch view error: ${(e as Error).message}`, "error")];
    }
  }

  private children(parent?: Item): Item[] {
    if (parent && (!this.state || !this.state.ok)) return [];
    if (!this.state) return [info("Loading…", "loading~spin")];
    if (!this.state.ok) {
      // Login/link eksikse liste BOŞ döner — package.json'daki viewsWelcome
      // (butonlu karşılama) devreye girer. Diğer hatalarda mesaj listede kalır.
      if (this.state.reason === "notLoggedIn" || this.state.reason === "notLinked") return [];
      const err = new vscode.TreeItem(this.state.message);
      err.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
      err.tooltip = this.state.suggestion;
      const hint = new vscode.TreeItem(this.state.suggestion);
      hint.iconPath = new vscode.ThemeIcon("lightbulb");
      return [err, hint];
    }

    if (!parent) return this.rootItems(this.state);
    const section = (parent as Item & { sectionId?: string }).sectionId;
    if (section === "revisions") return this.revisionItems(this.state);
    if (section === "drift") return this.driftItems(this.state);
    if (section === "implementation") return this.implementationItems(this.state);
    return [];
  }

  private rootItems(state: Extract<GraphState, { ok: true }>): Item[] {
    const { errors, warns } = state.counts;

    const status = new vscode.TreeItem(
      this.hasUpdate
        ? `Update available — rev ${state.graphRevision}`
        : errors === 0 && warns === 0
          ? `In sync — rev ${state.graphRevision}`
          : `rev ${state.graphRevision} · ${errors} error(s), ${warns} warning(s)`,
    );
    status.iconPath = this.hasUpdate
      ? new vscode.ThemeIcon("arrow-circle-up", new vscode.ThemeColor("charts.blue"))
      : errors > 0
        ? dot("charts.red")
        : warns > 0
          ? dot("charts.yellow")
          : dot("charts.green");
    status.description = state.projectName;
    status.tooltip = this.hasUpdate
      ? "The architecture changed in Solarch since you last looked. Expand Revisions to see when."
      : `${state.nodes.length} node(s), ${state.edges.length} edge(s)`;
    status.command = { command: "solarch.acknowledge", title: "Acknowledge" };

    const revisions = new vscode.TreeItem("Revisions", vscode.TreeItemCollapsibleState.Expanded);
    (revisions as Item & { sectionId?: string }).sectionId = "revisions";
    revisions.iconPath = new vscode.ThemeIcon("history");

    const drift = new vscode.TreeItem(
      "Drift",
      errors + warns > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    (drift as Item & { sectionId?: string }).sectionId = "drift";
    drift.iconPath = new vscode.ThemeIcon("git-compare");
    drift.description = errors + warns === 0 ? "clean" : `${errors + warns} finding(s)`;

    const items = [status, revisions, drift];

    // Implementation bölümü yalnız scaffold'lu repolarda görünür.
    const impl = state.implementation;
    if (impl.total > 0) {
      const section = new vscode.TreeItem(
        "Implementation",
        impl.skeletons.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      (section as Item & { sectionId?: string }).sectionId = "implementation";
      section.iconPath = new vscode.ThemeIcon("tools");
      const pct = Math.round((impl.filled / impl.total) * 100);
      section.description = `${impl.filled}/${impl.total} implemented (${pct}%)`;
      items.push(section);
    }

    return items;
  }

  private revisionItems(state: Extract<GraphState, { ok: true }>): Item[] {
    const entries = this.log.entries();
    if (entries.length === 0) return [info("No revisions observed yet", "circle-outline")];
    return entries.map((e, i) => {
      const current = e.revision === state.graphRevision;
      const prev = entries[i + 1];
      const deltaN = prev ? e.nodes - prev.nodes : 0;
      const deltaE = prev ? e.edges - prev.edges : 0;
      const delta =
        prev && (deltaN !== 0 || deltaE !== 0)
          ? ` (${deltaN >= 0 ? "+" : ""}${deltaN}n ${deltaE >= 0 ? "+" : ""}${deltaE}e)`
          : "";
      const item = new vscode.TreeItem(`rev ${e.revision}`);
      item.description = `${timeAgo(e.seenAt)} · ${e.nodes}n ${e.edges}e${delta}${current ? "  ← current" : ""}`;
      item.iconPath = current
        ? new vscode.ThemeIcon("git-commit", new vscode.ThemeColor("charts.green"))
        : new vscode.ThemeIcon("git-commit", new vscode.ThemeColor("disabledForeground"));
      item.tooltip = `First seen ${new Date(e.seenAt).toLocaleString()}\n${e.nodes} node(s), ${e.edges} edge(s)`;
      return item;
    });
  }

  private driftItems(state: Extract<GraphState, { ok: true }>): Item[] {
    if (state.findings.length === 0) return [info("Code and architecture match", "check")];
    const order: Record<StateFinding["severity"], number> = { error: 0, warn: 1, info: 2 };
    return [...state.findings]
      .sort((a, b) => order[a.severity] - order[b.severity])
      .map((f) => {
        const item = new vscode.TreeItem(f.message);
        item.iconPath = findingIcon(f);
        const tip = new vscode.MarkdownString();
        tip.appendMarkdown(`**${f.code}**\n\n${f.message}`);
        if (f.suggestion) tip.appendMarkdown(`\n\n$(lightbulb) ${f.suggestion}`);
        tip.supportThemeIcons = true;
        item.tooltip = tip;
        if (f.file) {
          item.description = f.file;
          item.command = {
            command: "solarch.openFinding",
            title: "Open file",
            arguments: [f.file],
          };
        }
        return item;
      });
  }

  private implementationItems(state: Extract<GraphState, { ok: true }>): Item[] {
    const impl = state.implementation;
    if (impl.skeletons.length === 0) return [info("All generated scaffolds are implemented", "check")];
    return impl.skeletons.map((s) => {
      const item = new vscode.TreeItem(`${s.className}.${s.member}`);
      item.iconPath = new vscode.ThemeIcon("circle-large-outline", new vscode.ThemeColor("charts.orange"));
      item.description = `${s.file}:${s.line}`;
      item.tooltip = s.description
        ? `NOT_IMPLEMENTED — what it should do:\n\n${s.description}`
        : "NOT_IMPLEMENTED — generated scaffold waiting to be filled in.";
      item.command = {
        command: "solarch.openFinding",
        title: "Open",
        arguments: [s.file, s.line],
      };
      return item;
    });
  }
}

/* ── küçük yardımcılar ───────────────────────────────────────────── */

/** Bulgu tipi → anlamlı ikon (rengi önem derecesinden). */
function findingIcon(f: StateFinding): vscode.ThemeIcon {
  const color = new vscode.ThemeColor(
    f.severity === "error" ? "charts.red" : f.severity === "warn" ? "charts.yellow" : "charts.blue",
  );
  const icon =
    f.code === "DRIFT_ILLEGAL_EDGE"
      ? "error"
      : f.code === "DRIFT_NODE_MISSING_IN_CODE" || f.code === "DRIFT_EDGE_MISSING_IN_CODE"
        ? "cloud"
        : f.code === "DRIFT_NODE_NOT_IN_CLOUD" || f.code === "DRIFT_EDGE_NOT_IN_CLOUD"
          ? "file-code"
          : "diff";
  return new vscode.ThemeIcon(icon, color);
}

function info(label: string, icon: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label);
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function timeAgo(iso: string): string {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
