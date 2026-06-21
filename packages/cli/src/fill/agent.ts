/** Tool-calling agent runtime — düz fetch ile çok-turlu /chat/completions döngüsü.
 *
 *  Doğruluk PROMPT'ta değil, DETERMİNİSTİK validator'larda ve GERÇEK çalıştırmada
 *  (tsc/jest) yaşar. Model bir ajandır: kod önerir → bir tool (verify_fill /
 *  run_tests) çağırıp sonucu GÖRÜR → düzeltir → yeşile kadar döner. Kuralları tool
 *  handler dayatır (yeşil değilse `done` olmaz). LangChain DEĞİL — filler tek
 *  endpoint'e konuşur, bundle ince kalır. */

import type { LlmConfig } from "./llm.js";

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema (parameters). */
  parameters: Record<string, unknown>;
}

export interface ToolInvocation {
  id: string;
  name: string;
  /** Ayrıştırılmış argümanlar; ayrıştırılamazsa null. */
  args: Record<string, unknown> | null;
}

/** Bir tool çağrısını işle. `content` modele geri beslenir. `done:true` →
 *  ajan durur ve `result`'ı döndürür (örn. yeşil kod/spec). */
export type ToolResolver = (call: ToolInvocation) => Promise<{ content: string; done?: boolean; result?: unknown }>;

export interface AgentResult {
  rounds: number;
  /** done:true dönen tool'un result'ı (yeşile ulaşıldıysa). */
  result?: unknown;
  /** Model tool çağırmadan bitirdiyse son metni (teşhis için). */
  finalText?: string;
  /** Tur tavanına ulaşıldı ve hiç done olmadı. */
  exhausted?: boolean;
}

export interface AgentMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** Bir /chat turunu yürüten transport — varsayılan fetch tabanlıdır; testler
 *  scripted yanıt veren sahte bir transport enjekte edebilir (ağ yok). */
export type ChatTransport = (messages: AgentMessage[], tools: AgentTool[], forceTool?: string) => Promise<AgentMessage>;

type RawMessage = AgentMessage;

/** Varsayılan fetch tabanlı transport (OpenAI-uyumlu /chat/completions). */
export function fetchTransport(config: LlmConfig, timeoutMs = 90_000): ChatTransport {
  return (messages, tools, forceTool) => chatWithTools(config, messages, tools, timeoutMs, forceTool);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Geçici (retryable) HTTP durumları — kapasite/ağ kaynaklı; backoff ile tekrar denenir.
 *  401/403/404/413/422 ve thinking-mode dışı 400 KALICIDIR (retry edilmez). */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 2;

async function chatWithTools(
  config: LlmConfig,
  messages: RawMessage[],
  tools: AgentTool[],
  timeoutMs: number,
  forceTool?: string,
): Promise<RawMessage> {
  const toolDefs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

  // Tek POST — durum + (retryable ise) Retry-After saniyesini taşır. AbortError (timeout)/
  // ağ hatası status=0 olarak işaretlenir (retryable). Yanıt parse hatası 200 ama msg yok.
  const post = async (toolChoice: unknown): Promise<{ status: number; detail: string; retryAfter?: number; msg?: RawMessage }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, temperature: 0, stream: false, tools: toolDefs, tool_choice: toolChoice }),
      });
      if (!res.ok) {
        const ra = Number(res.headers.get("retry-after"));
        return { status: res.status, detail: (await res.text().catch(() => "")).slice(0, 300), retryAfter: Number.isFinite(ra) ? ra : undefined };
      }
      const data = (await res.json()) as { choices?: { message?: RawMessage }[] };
      return { status: 200, detail: "", msg: data.choices?.[0]?.message };
    } catch (e) {
      // AbortError (timeout) / network → geçici, retry edilebilir (status 0).
      return { status: 0, detail: (e as Error).message || "network/timeout" };
    } finally {
      clearTimeout(timer);
    }
  };

  // forceTool: tool çağrısını GARANTİLE. Ama "thinking" modeller (deepseek-v4-pro) zorunlu
  // tool_choice'u reddeder (400) → "auto"'ya şeffafça düş (hem reasoning hem non-reasoning çalışır).
  const call = async (): Promise<{ status: number; detail: string; retryAfter?: number; msg?: RawMessage }> => {
    let r = await post(forceTool ? { type: "function", function: { name: forceTool } } : "auto");
    if (r.status === 400 && forceTool && /tool_choice|thinking mode/i.test(r.detail)) r = await post("auto");
    return r;
  };

  // GEÇİCİ HATA RETRY: 429/5xx/timeout/ağ → Retry-After ya da jitter'lı backoff ile 2 tekrar.
  // Kalıcı hatalar (auth/4xx) anında fırlar. Eskiden tek fetch → tek 503 dalgası bölgeyi öldürüyordu.
  let r = await call();
  for (let attempt = 1; attempt <= MAX_RETRIES && (r.status === 0 || RETRYABLE_STATUS.has(r.status)); attempt++) {
    const backoff = r.retryAfter != null ? r.retryAfter * 1000 : Math.min(500 * 2 ** attempt * (0.8 + Math.random() * 0.4), 10_000);
    await sleep(backoff);
    r = await call();
  }
  if (r.status !== 200) throw new Error(`LLM call failed (${r.status || "network"} ${config.model}): ${r.detail}`);
  if (!r.msg) throw new Error("LLM returned no message.");
  return r.msg;
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Tool-calling ajanı: model bir tool çağırana ve `done` dönülene (ya da tur
 *  tavanına) kadar döner. İlk turda tool kullanımı ZORLANIR (forceFirstTool) —
 *  böylece model prose'la kaçamaz, doğrudan doğrulamaya girer. */
export async function runToolAgent(opts: {
  /** LLM yapılandırması — `transport` verilmezse fetchTransport bundan kurulur. */
  config?: LlmConfig;
  /** Enjekte transport (test/sahte için); yoksa config'ten fetchTransport. */
  transport?: ChatTransport;
  system: string;
  user: string;
  /** Araç seti SABİT dizi VEYA tur-bilinçli fabrika (zor bölgede round 1'de keşfi
   *  yapısal zorlamak için: round 1 = yalnız keşif araçları, round≥2 = hepsi). */
  tools: AgentTool[] | ((round: number) => AgentTool[]);
  resolve: ToolResolver;
  /** İlk /chat çağrısında zorunlu kılınacak tool adı (genelde tek verify tool'u). */
  forceFirstTool?: string;
  maxRounds?: number;
  timeoutMs?: number;
}): Promise<AgentResult> {
  const maxRounds = opts.maxRounds ?? 5;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const transport = opts.transport ?? (opts.config ? fetchTransport(opts.config, timeoutMs) : undefined);
  if (!transport) throw new Error("runToolAgent needs either `config` or `transport`.");
  const toolsFor = (round: number): AgentTool[] => (typeof opts.tools === "function" ? opts.tools(round) : opts.tools);
  const messages: RawMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];

  for (let round = 1; round <= maxRounds; round++) {
    const force = round === 1 ? opts.forceFirstTool : undefined;
    const msg = await transport(messages, toolsFor(round), force);
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Model tool çağırmadı → ya bitirdi ya prose yazdı. Bir kez dürt, sonra bırak.
      if (round < maxRounds) {
        messages.push({ role: "user", content: "Call the verification tool with your code — do not answer in prose. Iterate until it reports ok." });
        continue;
      }
      return { rounds: round, finalText: msg.content ?? undefined, exhausted: true };
    }

    let doneResult: unknown;
    let gotDone = false;
    for (const tc of msg.tool_calls) {
      // BOZUK tool-JSON'ı AÇIKÇA bildir: boş args = zero-arg toleransı ({}), boş-olmayan ama
      // geçersiz JSON → araç-bazlı yanıltıcı mesaj ("empty code") yerine asıl sebebi söyle.
      const raw = tc.function.arguments ?? "";
      const args = raw.trim() === "" ? {} : parseArgs(raw);
      if (args === null) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: "arguments were not valid JSON — resend as a single JSON object", received: raw.slice(0, 200) }),
        });
        continue;
      }
      const call: ToolInvocation = { id: tc.id, name: tc.function.name, args };
      let r: { content: string; done?: boolean; result?: unknown };
      try {
        r = await opts.resolve(call);
      } catch (e) {
        // resolve içi throw (ör. ts-morph completeType/applyBody) TÜM bölgeyi öldürmesin —
        // tool-error olarak modele dön, loop devam etsin.
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: `tool "${call.name}" failed: ${(e as Error).message}` }) });
        continue;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: r.content });
      if (r.done) {
        gotDone = true;
        doneResult = r.result;
      }
    }
    if (gotDone) return { rounds: round, result: doneResult };
  }

  // EXHAUSTED + tool çağrıları boyunca hiç done olmadı → son bir TEŞHİS turu (force YOK,
  // araç YOK → model prose ile cevaplar): neyin bloketttiğini özetlet, finalText'e taşı.
  // Yalnız başarısız bölgelerde 1 ekstra çağrı; repair feedback + kullanıcı raporu zenginleşir.
  let diagnosis: string | undefined;
  try {
    const d = await transport(
      [...messages, { role: "user", content: "You did not complete the fill. In ONE sentence: which owned type or member blocked you, and what did you try? No tool call — just the sentence." }],
      [],
    );
    diagnosis = d.content ?? undefined;
  } catch {
    /* teşhis en iyi çaba — başarısızlığı bozmaz */
  }
  return { rounds: maxRounds, exhausted: true, finalText: diagnosis };
}
