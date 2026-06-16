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

async function chatWithTools(
  config: LlmConfig,
  messages: RawMessage[],
  tools: AgentTool[],
  timeoutMs: number,
  forceTool?: string,
): Promise<RawMessage> {
  const toolDefs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

  const post = async (toolChoice: unknown): Promise<{ status: number; detail: string; msg?: RawMessage }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, temperature: 0, stream: false, tools: toolDefs, tool_choice: toolChoice }),
      });
      if (!res.ok) return { status: res.status, detail: (await res.text().catch(() => "")).slice(0, 300) };
      const data = (await res.json()) as { choices?: { message?: RawMessage }[] };
      return { status: 200, detail: "", msg: data.choices?.[0]?.message };
    } finally {
      clearTimeout(timer);
    }
  };

  // forceTool: tool çağrısını GARANTİLE (deterministik). Ama "thinking" modeller
  // (deepseek-v4-pro) zorunlu tool_choice'u reddeder (400) — o durumda "auto"'ya
  // şeffafça düş. Böylece hem reasoning hem non-reasoning modeller çalışır.
  let r = await post(forceTool ? { type: "function", function: { name: forceTool } } : "auto");
  if (r.status === 400 && forceTool && /tool_choice|thinking mode/i.test(r.detail)) {
    r = await post("auto");
  }
  if (r.status !== 200) throw new Error(`LLM call failed (${r.status} ${config.model}): ${r.detail}`);
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
  tools: AgentTool[];
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
  const messages: RawMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];

  for (let round = 1; round <= maxRounds; round++) {
    const force = round === 1 ? opts.forceFirstTool : undefined;
    const msg = await transport(messages, opts.tools, force);
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
      const call: ToolInvocation = { id: tc.id, name: tc.function.name, args: parseArgs(tc.function.arguments) };
      const r = await opts.resolve(call);
      messages.push({ role: "tool", tool_call_id: tc.id, content: r.content });
      if (r.done) {
        gotDone = true;
        doneResult = r.result;
      }
    }
    if (gotDone) return { rounds: round, result: doneResult };
  }
  return { rounds: maxRounds, exhausted: true };
}
