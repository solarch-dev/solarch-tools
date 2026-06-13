/** Sunucu entegrasyonu — gerçek MCP istemcisiyle (InMemoryTransport) uçtan uca:
 *  araç listesi, şema ve yapılandırma-eksik hatasının ajan-dostu payload'ı. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("solarch-mcp server", () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), "solarch-mcp-root-"));
  afterAll(() => rmSync(emptyRoot, { recursive: true, force: true }));

  async function connect() {
    const server = buildServer(emptyRoot);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("altı aracı doğru adlarla ilan eder", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_drift",
      "create_node_safely",
      "get_architecture",
      "get_rules",
      "get_unimplemented",
      "sync_properties",
    ]);
    const create = tools.find((t) => t.name === "create_node_safely");
    expect(create?.inputSchema.properties).toHaveProperty("type");
    expect(create?.inputSchema.properties).toHaveProperty("edges");
  });

  it("solarch.json yoksa araç çökmez — yapısal hata + öneri döner", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "get_architecture", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const payload = JSON.parse(text) as { code: string; suggestion: string };
    expect(payload.code).toBe("ERR_NOT_CONFIGURED");
    expect(payload.suggestion).toContain("solarch link");
  });

  it("geçersiz argüman SDK seviyesinde reddedilir (zod şeması)", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "create_node_safely",
      arguments: { type: "NotAKind", properties: {} },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).toContain("Invalid arguments"); // zod doğrulaması handler'a gelmeden kesti
  });
});
