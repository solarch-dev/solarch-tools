/** Araç bağlamı — her MCP aracının ihtiyacı olan üçlü: repo kökü, proje bağı,
 *  API istemcisi. API erişimi tüketicinin mock'layabilmesi için dar bir
 *  arayüz üzerinden geçer (testlerde gerçek HTTP yok). */

import { SolarchApi, readProjectConfig, type ApplyPayload, type ApplyResult, type CloudGraph, type RuleCatalog } from "@solarch/cli/lib";

/** SolarchApi'nin araçların kullandığı alt kümesi — testte mock'lanır. */
export interface ApiClient {
  getGraph(projectId: string): Promise<CloudGraph>;
  getRules(): Promise<RuleCatalog>;
  applyGraph(projectId: string, payload: ApplyPayload): Promise<ApplyResult>;
}

export interface ToolContext {
  rootDir: string;
  projectId: string;
  api: ApiClient;
}

export class ContextError extends Error {
  constructor(
    message: string,
    /** Ajanın kendi kendine düzeltebilmesi için eylem önerisi. */
    readonly suggestion: string,
  ) {
    super(message);
  }
}

/** Lazy bağlam: sunucu kimlik/link olmadan da ayağa kalkar; eksikse araç
 *  çağrısı anında anlaşılır hata + öneriyle döner (ajan kullanıcıya iletir). */
export function resolveContext(rootDir: string): ToolContext {
  const config = readProjectConfig(rootDir);
  if (!config?.projectId) {
    throw new ContextError(
      `No Solarch project is linked at ${rootDir} (solarch.json missing or has no projectId).`,
      "Run `solarch link` in the repository root first.",
    );
  }
  let api: SolarchApi;
  try {
    api = SolarchApi.fromStoredCredentials();
  } catch (e) {
    throw new ContextError((e as Error).message, "Run `solarch login` with an API key from Settings → API Keys.");
  }
  return { rootDir, projectId: config.projectId, api };
}
