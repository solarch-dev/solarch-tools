/** Surgical fill LLM client — a thin fetch to an OpenAI-compatible chat endpoint.
 *
 *  Deliberately NOT LangChain: the filler only needs one chat completion per
 *  region, and pulling @langchain into the CLI would ~5x the bundled VS Code
 *  extension. DeepSeek (default) is OpenAI-compatible; any compatible endpoint
 *  works via env. Model `deepseek-v4-pro` does plain completion here (no tool
 *  calls), so its lack of tool-calling support is irrelevant. */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Env'den dolum LLM yapılandırması. SOLARCH_FILL_* önceliklidir, DeepSeek'e düşer. */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = env.SOLARCH_FILL_API_URL ?? env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
  const model = env.SOLARCH_FILL_MODEL ?? "deepseek-v4-pro";
  const apiKey = env.SOLARCH_FILL_API_KEY ?? env.DEEPSEEK_API_KEY ?? "";
  return { baseUrl, model, apiKey };
}

export type CompleteFn = (messages: ChatMessage[]) => Promise<string>;

/** OpenAI-uyumlu /chat/completions çağrısı → assistant içeriği (ham metin). */
export function createCompleter(config: LlmConfig, timeoutMs = 60_000): CompleteFn {
  return async (messages) => {
    if (!config.apiKey) {
      throw new Error(
        "No LLM API key. Set DEEPSEEK_API_KEY (or SOLARCH_FILL_API_KEY) in the environment.",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, temperature: 0, stream: false }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`LLM call failed (${res.status} ${config.model}): ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM returned an empty completion.");
    return content;
  };
}

/** ```ts … ``` markdown çitlerini soyup ham kod döndür (LLM sıklıkla sarar). */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```[\w]*\n([\s\S]*?)\n?```$/;
  const m = fence.exec(trimmed);
  return (m?.[1] ?? trimmed).trim();
}
