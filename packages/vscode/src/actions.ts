/** Eklenti aksiyonları — CLI motoru doğrudan arka planda çalışır, terminal yok.
 *
 *  login  → InputBox (maskeli anahtar) + doğrulama → ~/.solarch/credentials
 *  link   → QuickPick (hesaptaki projeler) → solarch.json
 *  pull   → To-Be grafını .solarch/to-be.json'a indir
 *  push   → CLI push'un birebir akışı (plan → onay → atomik apply → property
 *           PATCH), arayüzü VSCode-native: modal onay + progress + toast.
 *           Illegal edge varsa push reddedilir; revizyon çatışmasında bir kez
 *           otomatik yeniden denenir — CLI ile aynı sözleşme. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as vscode from "vscode";
import {
  ApiError,
  DEFAULT_API_URL,
  SolarchApi,
  buildPushPlan,
  diffGraphs,
  planIsEmpty,
  readCredentials,
  readMatchCache,
  readProjectConfig,
  runScan,
  toApplyPayload,
  toBePath,
  writeCredentials,
  writeGeneratedFiles,
  writeMatchCache,
  writeProjectConfig,
  type PushPlan,
} from "@solarch/cli/lib";

/* ── login ───────────────────────────────────────────────────────── */

export async function loginAction(): Promise<boolean> {
  const key = await vscode.window.showInputBox({
    title: "Solarch — Sign in",
    prompt: "Paste an API key (Solarch → Settings → API Keys)",
    placeHolder: "slk_…",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().startsWith("slk_") ? undefined : "Solarch API keys start with slk_"),
  });
  if (!key) return false;

  // API URL: kayıtlı değer varsa koru; yoksa Cloud / özel sunucu seçtir.
  let apiUrl = readCredentials()?.apiUrl;
  if (!apiUrl) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Solarch Cloud", description: DEFAULT_API_URL, url: DEFAULT_API_URL },
        { label: "Custom server…", description: "self-hosted / local backend", url: null },
      ],
      { title: "Solarch API server", ignoreFocusOut: true },
    );
    if (!choice) return false;
    apiUrl =
      choice.url ??
      (await vscode.window.showInputBox({
        title: "Solarch API URL",
        value: "http://localhost:4000/api/v1",
        ignoreFocusOut: true,
      }));
    if (!apiUrl) return false;
  }

  const creds = { apiUrl, apiKey: key.trim() };
  try {
    const projects = await new SolarchApi(creds).listProjects();
    writeCredentials(creds);
    void vscode.window.showInformationMessage(
      `Solarch: signed in — ${projects.length} project(s) on your account.`,
    );
    return true;
  } catch (e) {
    void vscode.window.showErrorMessage(`Solarch: sign-in failed — ${(e as Error).message}`);
    return false;
  }
}

/* ── link ────────────────────────────────────────────────────────── */

export async function linkAction(rootDir: string): Promise<boolean> {
  let api: SolarchApi;
  try {
    api = SolarchApi.fromStoredCredentials();
  } catch {
    const ok = await loginAction();
    if (!ok) return false;
    api = SolarchApi.fromStoredCredentials();
  }

  const projects = await api.listProjects().catch((e: Error) => {
    void vscode.window.showErrorMessage(`Solarch: could not list projects — ${e.message}`);
    return null;
  });
  if (!projects) return false;
  if (projects.length === 0) {
    void vscode.window.showWarningMessage("Solarch: your account has no projects yet — create one in the Solarch app first.");
    return false;
  }

  const pick = await vscode.window.showQuickPick(
    projects.map((p) => ({
      label: p.name,
      description: p.counts ? `${p.counts.nodes} node(s), ${p.counts.edges} edge(s)` : undefined,
      id: p.id,
    })),
    { title: "Link this workspace to a Solarch project", ignoreFocusOut: true },
  );
  if (!pick) return false;

  const existing = readProjectConfig(rootDir);
  writeProjectConfig(rootDir, {
    projectId: pick.id,
    projectName: pick.label,
    include: existing?.include,
    exclude: existing?.exclude,
    bindings: existing?.bindings ?? [],
  });
  void vscode.window.showInformationMessage(`Solarch: linked to "${pick.label}".`);
  return true;
}

/* ── pull ────────────────────────────────────────────────────────── */

export async function pullAction(rootDir: string): Promise<void> {
  const config = readProjectConfig(rootDir);
  if (!config?.projectId) {
    void vscode.window.showWarningMessage("Solarch: link a project first.");
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Solarch: pulling To-Be graph…" },
    async () => {
      const api = SolarchApi.fromStoredCredentials();
      const graph = await api.getGraph(config.projectId);
      const p = toBePath(rootDir);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(graph, null, 2) + "\n");
      void vscode.window.showInformationMessage(
        `Solarch: pulled "${graph.project.name}" — ${graph.counts.nodes} node(s), ${graph.counts.edges} edge(s), rev ${graph.graphRevision}.`,
      );
    },
  ).then(undefined, (e: Error) => {
    void vscode.window.showErrorMessage(`Solarch: pull failed — ${e.message}`);
  });
}

/* ── generate ────────────────────────────────────────────────────── */

/** Cloud'daki graftan deterministik kod iskeletini üretip workspace'e yazar.
 *  Emek koruması: mevcut dosyalar varsayılan atlanır; kullanıcı modal'da
 *  "Overwrite all" derse üzerine yazılır. */
export async function generateAction(rootDir: string): Promise<boolean> {
  const config = readProjectConfig(rootDir);
  if (!config?.projectId) {
    void vscode.window.showWarningMessage("Solarch: link a project first.");
    return false;
  }
  let api: SolarchApi;
  try {
    api = SolarchApi.fromStoredCredentials();
  } catch (e) {
    void vscode.window.showWarningMessage(`Solarch: ${(e as Error).message}`);
    return false;
  }

  try {
    const project = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Solarch: generating code from the architecture…" },
      () => api.generateCode(config.projectId),
    );

    const markers = project.files.reduce((acc, f) => acc + f.surgicalMarkers, 0);
    const choice = await vscode.window.showInformationMessage(
      `Apply ${project.files.length} generated file(s) to this workspace?`,
      {
        modal: true,
        detail:
          `${markers} surgical marker(s) will be waiting in the Implementation section.\n\n` +
          `"Only new files" keeps every existing file untouched (your implemented code is safe).\n` +
          `"Overwrite all" resets existing files to the fresh scaffold.` +
          (project.warnings.length > 0 ? `\n\nWarnings:\n${project.warnings.map((w) => `• ${w}`).join("\n")}` : ""),
      },
      "Only new files",
      "Overwrite all",
    );
    if (!choice) return false;

    const result = writeGeneratedFiles(rootDir, project.files, { force: choice === "Overwrite all" });
    const applied = result.written.length + result.overwritten.length;
    void vscode.window.showInformationMessage(
      `Solarch: ${applied} file(s) applied` +
        (result.skipped.length > 0 ? `, ${result.skipped.length} existing skipped` : "") +
        ". Check the Implementation section for what to fill in.",
    );
    return applied > 0;
  } catch (e) {
    const msg =
      e instanceof ApiError && e.code === "ERR_PLAN_AI"
        ? "code generation requires a Build plan — upgrade in the Solarch app."
        : (e as Error).message;
    void vscode.window.showErrorMessage(`Solarch: generate failed — ${msg}`);
    return false;
  }
}

/* ── push ────────────────────────────────────────────────────────── */

interface PreparedPush {
  plan: PushPlan;
  baseRevision: number;
}

async function preparePlan(api: SolarchApi, rootDir: string, projectId: string): Promise<PreparedPush> {
  const [graph, rules] = await Promise.all([api.getGraph(projectId), api.getRules()]);
  const asIs = runScan(rootDir);
  const diff = diffGraphs(asIs, graph, rules, readMatchCache(rootDir));
  writeMatchCache(rootDir, diff.cache);
  return { plan: buildPushPlan(asIs, graph, rules, diff.cache), baseRevision: graph.graphRevision };
}

function describePlan(plan: PushPlan): string {
  const parts: string[] = [];
  if (plan.newNodes.length > 0) {
    const names = plan.newNodes.slice(0, 6).map((n) => `${n.kind} "${n.name}"`);
    if (plan.newNodes.length > 6) names.push(`+${plan.newNodes.length - 6} more`);
    parts.push(`New nodes (${plan.newNodes.length}): ${names.join(", ")}`);
  }
  if (plan.newEdges.length > 0) {
    parts.push(`New edges (${plan.newEdges.length}): ${plan.newEdges.slice(0, 4).map((e) => e.edge.key).join(", ")}${plan.newEdges.length > 4 ? ", …" : ""}`);
  }
  if (plan.propertyUpdates.length > 0) {
    parts.push(`Property updates (${plan.propertyUpdates.length}): ${plan.propertyUpdates.map((u) => `${u.name} (${u.changedFields.join(", ")})`).join(", ")}`);
  }
  return parts.join("\n\n");
}

export async function pushAction(rootDir: string): Promise<boolean> {
  const config = readProjectConfig(rootDir);
  if (!config?.projectId) {
    void vscode.window.showWarningMessage("Solarch: link a project first.");
    return false;
  }
  let api: SolarchApi;
  try {
    api = SolarchApi.fromStoredCredentials();
  } catch (e) {
    void vscode.window.showWarningMessage(`Solarch: ${(e as Error).message}`);
    return false;
  }

  try {
    let { plan, baseRevision } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Solarch: building push plan…" },
      () => preparePlan(api, rootDir, config.projectId),
    );

    // İllegal edge'ler push'u komple bloklar — CLI ile aynı sözleşme.
    if (plan.illegalEdges.length > 0) {
      const detail = plan.illegalEdges
        .map((i) => `• ${i.edge.key}\n  ${i.message}${i.suggestion ? `\n  Fix: ${i.suggestion}` : ""}`)
        .join("\n\n");
      void vscode.window.showErrorMessage(
        `Solarch: push blocked — ${plan.illegalEdges.length} rule violation(s) in code.`,
        { modal: true, detail },
      );
      return false;
    }

    if (planIsEmpty(plan)) {
      void vscode.window.showInformationMessage("Solarch: already in sync — nothing to push.");
      return false;
    }

    const summary = `${plan.newNodes.length} node(s), ${plan.newEdges.length} edge(s), ${plan.propertyUpdates.length} property update(s)`;
    const choice = await vscode.window.showInformationMessage(
      `Push to "${config.projectName ?? "Solarch"}"? (${summary})`,
      { modal: true, detail: describePlan(plan) },
      "Push",
    );
    if (choice !== "Push") return false;

    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Solarch: pushing…" },
      async () => {
        // Ekleme: atomik apply; revizyon eskidiyse bir kez re-plan + retry.
        if (plan.newNodes.length > 0 || plan.newEdges.length > 0) {
          let result = await api.applyGraph(config.projectId, toApplyPayload(plan, baseRevision)).catch(async (e: unknown) => {
            if (e instanceof ApiError && e.code === "ERR_GRAPH_REVISION_CONFLICT") {
              ({ plan, baseRevision } = await preparePlan(api, rootDir, config.projectId));
              if (plan.illegalEdges.length > 0 || planIsEmpty(plan)) return null;
              return api.applyGraph(config.projectId, toApplyPayload(plan, baseRevision));
            }
            throw e;
          });
          if (result === null) {
            void vscode.window.showInformationMessage("Solarch: graph changed meanwhile — replanned; nothing left to push.");
            return false;
          }
          if (!result.success) {
            const detail = result.violations.map((v) => `• ${v.code}: ${v.message}`).join("\n");
            void vscode.window.showErrorMessage("Solarch: server rejected the push (rolled back).", { modal: true, detail });
            return false;
          }
          // idMap → map.json: yeni node'lar anında eşleşmiş sayılır.
          const cache = readMatchCache(rootDir);
          for (const [key, tempId] of Object.entries(plan.tempIdByKey)) {
            const cloudId = result.idMap[tempId];
            if (cloudId) cache[key] = cloudId;
          }
          writeMatchCache(rootDir, cache);
        }

        // Property güncellemeleri — çatışan node atlanır ve raporlanır.
        const skipped: string[] = [];
        for (const u of plan.propertyUpdates) {
          try {
            await api.patchNode(config.projectId, u.cloudId, {
              properties: u.properties,
              expectedVersion: u.expectedVersion,
            });
          } catch (e) {
            if (e instanceof ApiError && e.code === "ERR_VERSION_CONFLICT") skipped.push(u.name);
            else throw e;
          }
        }

        const done = `${plan.newNodes.length} node(s), ${plan.newEdges.length} edge(s), ${plan.propertyUpdates.length - skipped.length} property update(s) pushed.`;
        if (skipped.length > 0) {
          void vscode.window.showWarningMessage(
            `Solarch: ${done} Skipped (changed in cloud meanwhile): ${skipped.join(", ")} — resolve on the canvas.`,
          );
        } else {
          void vscode.window.showInformationMessage(`Solarch: ${done}`);
        }
        return true;
      },
    );
  } catch (e) {
    void vscode.window.showErrorMessage(`Solarch: push failed — ${(e as Error).message}`);
    return false;
  }
}
