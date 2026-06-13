#!/usr/bin/env node
/** solarch-mcp — Solarch MCP sunucusu (stdio).
 *
 *  AI ajan istemcileri (Claude Desktop, Cursor, Cline…) bu process'i spawn eder;
 *  JSON-RPC stdin/stdout üzerinden akar. stdout transport kanalıdır — loglar
 *  YALNIZ stderr'e yazılır.
 *
 *  Kullanım (mcp.json):
 *    { "command": "solarch-mcp", "args": ["--root", "/path/to/nestjs-repo"] }
 *  --root verilmezse process cwd'si kullanılır. Kimlik: `solarch login`,
 *  proje bağı: `solarch link` (CLI ile paylaşılan ~/.solarch + solarch.json). */

import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

function parseRoot(argv: string[]): string {
  const i = argv.indexOf("--root");
  const value = i >= 0 ? argv[i + 1] : undefined;
  return resolve(value ?? process.cwd());
}

async function main(): Promise<void> {
  const rootDir = parseRoot(process.argv.slice(2));
  const server = buildServer(rootDir);
  await server.connect(new StdioServerTransport());
  console.error(`[solarch-mcp] ready on stdio — root: ${rootDir}`);
}

main().catch((e: Error) => {
  console.error(`[solarch-mcp] fatal: ${e.message}`);
  process.exit(1);
});
