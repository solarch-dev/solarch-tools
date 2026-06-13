/** Solarch Cloud API istemcisi — backend'in `{ success, data }` zarfını açar.
 *  Kimlik: Authorization: Bearer slk_... (API anahtarı). */

import type { EdgeKind, NodeKind } from "@solarch/ast-core";
import { readCredentials, type Credentials } from "./config.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /** Hata zarfındaki ek alanlar (örn. currentRevision, currentVersion). */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/* ── Cloud graf tipleri (backend ProjectGraph yanıtının aynası) ── */

export interface CloudNode {
  id: string;
  type: NodeKind;
  projectId: string;
  /** Optimistic locking — PATCH expectedVersion bu değerle gider. */
  version: number;
  properties: Record<string, unknown>;
}

export interface CloudEdge {
  id: string;
  kind: EdgeKind;
  sourceNodeId: string;
  targetNodeId: string;
  properties: Record<string, unknown>;
}

export interface CloudGraph {
  project: { id: string; name: string };
  nodes: CloudNode[];
  edges: CloudEdge[];
  counts: { nodes: number; edges: number };
  /** Graf revizyonu — push'un baseRevision çatışma kontrolü bu değere dayanır. */
  graphRevision: number;
}

/* ── graph/apply (push köprüsü) ── */

export interface ApplyNode {
  tempId: string;
  type: NodeKind;
  properties: Record<string, unknown>;
}

/** Uçlar: tempId (batch içi yeni node) veya id (mevcut cloud node) — tam biri. */
export interface ApplyEdge {
  sourceTempId?: string;
  sourceId?: string;
  targetTempId?: string;
  targetId?: string;
  edgeType: EdgeKind;
  label?: string;
}

export interface ApplyPayload {
  baseRevision?: number;
  mutations: { nodes: ApplyNode[]; edges: ApplyEdge[] };
}

export interface ApplyViolation {
  tempId?: string;
  edgeIndex?: number;
  code: string;
  message: string;
  suggestion?: string;
}

export type ApplyResult =
  | { success: true; idMap: Record<string, string>; nodeCount: number; edgeCount: number; graphRevision: number }
  | { success: false; transactionStatus: "ROLLED_BACK"; message: string; violations: ApplyViolation[] };

export interface RuleCatalog {
  whitelist: {
    source: NodeKind | NodeKind[];
    edge: EdgeKind | EdgeKind[];
    target: NodeKind | NodeKind[];
    layer: string;
    note?: string;
  }[];
  blacklist: {
    code: string;
    source: string | string[];
    edge: string | string[];
    target: string | string[];
    message: string;
    suggestion: string;
  }[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  counts?: { nodes: number; edges: number };
}

export class SolarchApi {
  constructor(private readonly creds: Credentials) {}

  /** ~/.solarch/credentials'tan istemci kur; yoksa anlaşılır hata. */
  static fromStoredCredentials(): SolarchApi {
    const creds = readCredentials();
    if (!creds) {
      throw new ApiError(
        "Not logged in. Run `solarch login` first (create a key at Settings → API Keys).",
        "ERR_NOT_LOGGED_IN",
        0,
      );
    }
    return new SolarchApi(creds);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.creds.apiUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.creds.apiKey}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
      });
    } catch (e) {
      throw new ApiError(
        `Cannot reach Solarch API at ${this.creds.apiUrl} — ${(e as Error).message}`,
        "ERR_NETWORK",
        0,
      );
    }
    const body = (await res.json().catch(() => null)) as
      | { success: true; data: T }
      | { success: false; error: { code: string; message: string } }
      | null;
    if (!res.ok || !body || body.success !== true) {
      const error = body && "error" in body ? (body.error as Record<string, unknown>) : null;
      const code = typeof error?.code === "string" ? error.code : "ERR_UNKNOWN";
      const message = typeof error?.message === "string" ? error.message : `HTTP ${res.status}`;
      throw new ApiError(message, code, res.status, error ?? {});
    }
    return body.data;
  }

  /** Kimlik doğrulama testi — login sonrası anahtarın çalıştığını kanıtlar. */
  async listProjects(): Promise<ProjectSummary[]> {
    const data = await this.request<{ projects: ProjectSummary[] }>("/projects");
    return data.projects;
  }

  getGraph(projectId: string): Promise<CloudGraph> {
    return this.request<CloudGraph>(`/projects/${projectId}/graph`);
  }

  getRules(): Promise<RuleCatalog> {
    return this.request<RuleCatalog>("/rules");
  }

  /** Toplu ekleme (push) — yeni node'lar + tempId/cloudId karışık edge'ler,
   *  tek atomik transaction. Revizyon eskidiyse 409 ERR_GRAPH_REVISION_CONFLICT. */
  applyGraph(projectId: string, payload: ApplyPayload): Promise<ApplyResult> {
    return this.request<ApplyResult>(`/projects/${projectId}/graph/apply`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /** Node property güncelleme — expectedVersion ile optimistic locking.
   *  Cloud'da bu arada değiştiyse 409 ERR_VERSION_CONFLICT. */
  patchNode(
    projectId: string,
    nodeId: string,
    body: { properties: Record<string, unknown>; expectedVersion?: number },
  ): Promise<CloudNode> {
    return this.request<CloudNode>(`/projects/${projectId}/nodes/${nodeId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }
}
