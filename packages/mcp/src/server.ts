/** MCP sunucu kurulumu — araç kayıtları.
 *
 *  Beş araç, üç rol:
 *  - Bağlam (read-only): get_architecture, get_rules — ajan kod yazmadan önce
 *    gerçek haritayı ve yasaları çeker.
 *  - Geri besleme: check_drift — ajan ürettiği kodu bitirmeden doğrular
 *    (ReAct self-correction halkası).
 *  - Güvenli mutasyon: create_node_safely, sync_properties — düz metin
 *    düzenlemek yerine kural denetimli motorlardan geçer. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EDGE_KINDS, NODE_KINDS } from "@solarch/ast-core";
import { ApiError } from "@solarch/cli/lib";
import { ContextError, resolveContext, type ToolContext } from "./context.js";
import {
  checkDrift,
  createNodeSafely,
  getArchitecture,
  getRules,
  getUnimplemented,
  syncPropertiesTool,
} from "./tools.js";

interface ToolResult {
  [key: string]: unknown; // SDK CallToolResult sözleşmesi
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const ok = (payload: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload,
});

/** Hata → ajanın işleyebileceği yapısal payload (exception fırlatmak yerine):
 *  code + message + suggestion üçlüsü self-correction'ın hammaddesi. */
const fail = (e: unknown): ToolResult => {
  const payload =
    e instanceof ContextError
      ? { code: "ERR_NOT_CONFIGURED", message: e.message, suggestion: e.suggestion }
      : e instanceof ApiError
        ? { code: e.code, message: e.message, ...e.details }
        : { code: "ERR_INTERNAL", message: (e as Error).message };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
};

export function buildServer(rootDir: string): McpServer {
  const server = new McpServer({ name: "solarch", version: "0.1.0" });

  /** Bağlam her çağrıda taze çözülür — kullanıcı sunucu açıkken login/link
   *  yapabilsin (lazy; eksikse araç anlaşılır hata döner, sunucu çökmez). */
  const withContext = async (fn: (ctx: ToolContext) => Promise<ToolResult> | ToolResult): Promise<ToolResult> => {
    try {
      return await fn(resolveContext(rootDir));
    } catch (e) {
      return fail(e);
    }
  };

  server.registerTool(
    "get_architecture",
    {
      title: "Get architecture (To-Be graph)",
      description:
        "Returns the project's current architecture graph from Solarch Cloud: every node (with id, type, name, " +
        "properties) and every edge (semantic kind, endpoints by name and id), plus the graph revision. " +
        "Call this BEFORE writing or modifying code so you reason from the real system map instead of guessing. " +
        "Node ids returned here are valid inputs for create_node_safely edges.",
      annotations: { readOnlyHint: true },
    },
    () => withContext(async (ctx) => ok({ ...(await getArchitecture(ctx)) })),
  );

  server.registerTool(
    "get_rules",
    {
      title: "Get architecture rules (Rules Matrix)",
      description:
        "Returns the Solarch Rules Matrix: whitelist (which source-edge-target combinations are legal) and " +
        "blacklist (forbidden anti-patterns with error codes and fix suggestions). Default deny — anything not " +
        "whitelisted is illegal. Consult this before wiring two components together in code or in the graph.",
      annotations: { readOnlyHint: true },
    },
    () => withContext(async (ctx) => ok({ ...(await getRules(ctx)) })),
  );

  server.registerTool(
    "check_drift",
    {
      title: "Check drift (code vs architecture)",
      description:
        "Scans the local codebase at the compiler level (TypeScript AST), compares it with the cloud architecture, " +
        "and returns structured findings: rule violations, components missing in code, unapproved additions, and " +
        "property drifts. Run this AFTER generating or editing code and BEFORE declaring the task done; if " +
        "`clean` is false, fix the error-level findings and re-check.",
      annotations: { readOnlyHint: true },
    },
    () => withContext(async (ctx) => ok({ ...(await checkDrift(ctx)) })),
  );

  server.registerTool(
    "get_unimplemented",
    {
      title: "Get unimplemented surgical regions (work queue)",
      description:
        "Scans the codebase for generated scaffolds and returns the method bodies that are still " +
        "NOT_IMPLEMENTED, each with its business description, the exceptions it must throw, the dependencies " +
        "it may use, and the exact file/line. This is your work queue when asked to implement the project: " +
        "fill ONLY these marked regions (keep the @solarch:surgical marker comment), then run check_drift to verify.",
      annotations: { readOnlyHint: true },
    },
    // Tamamen lokal (API'siz) — login/link olmadan da çalışır.
    () => {
      try {
        return ok({ ...getUnimplemented(rootDir) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_node_safely",
    {
      title: "Create a node in the architecture (rule-checked)",
      description:
        "Adds a new node (and optional edges to existing nodes) to the Solarch architecture graph. Every edge is " +
        "validated against the Rules Matrix locally AND by the server's Rules Engine inside one atomic " +
        "transaction — on any violation nothing is written and the violations (with suggestions) are returned. " +
        "Use node ids from get_architecture for edge endpoints. Properties must match the node type's schema.",
      inputSchema: {
        type: z.enum(NODE_KINDS).describe("Node type, e.g. Service, Table, Controller"),
        properties: z
          .record(z.string(), z.unknown())
          .describe('Node properties per its schema; the name field is required (e.g. {"ServiceName":"PaymentsService"})'),
        edges: z
          .array(
            z.object({
              kind: z.enum(EDGE_KINDS).describe("Semantic edge type, e.g. CALLS, QUERIES"),
              direction: z
                .enum(["outgoing", "incoming"])
                .describe("outgoing: new node → existing node; incoming: existing node → new node"),
              nodeId: z.string().describe("Existing node id (from get_architecture)"),
            }),
          )
          .optional()
          .describe("Connections between the new node and existing nodes"),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    (input) => withContext(async (ctx) => ok({ ...(await createNodeSafely(ctx, input)) })),
  );

  server.registerTool(
    "sync_properties",
    {
      title: "Sync properties between classes (safe AST injection)",
      description:
        "Copies property declarations from a source class (e.g. a TypeORM Entity) into a target class (e.g. a DTO) " +
        "using AST surgery instead of text editing: only property declarations are added (methods are never " +
        "touched), added fields carry a @solarch:bound marker, existing properties are never overwritten — type " +
        "mismatches are reported as conflicts. Class refs use the form \"path/to/file.ts#ClassName\".",
      inputSchema: {
        source: z.string().describe('Source class ref, e.g. "src/users/user.entity.ts#User"'),
        target: z.string().describe('Target class ref, e.g. "src/users/create-user.dto.ts#CreateUserDto"'),
        fields: z.array(z.string()).optional().describe("Only these fields (default: all syncable fields)"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    (input) => withContext((ctx) => ok({ ...syncPropertiesTool(ctx, input) })),
  );

  return server;
}
