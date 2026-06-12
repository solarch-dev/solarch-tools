/** @solarch/mcp — Faz 3 iskeleti.
 *
 *  Burada Solarch MCP (Model Context Protocol) sunucusu yaşayacak:
 *  - Salt-okunur araçlar: get_architecture, get_rules — ajan kod yazmadan önce
 *    projenin güncel haritasını ve kurallarını buradan çeker.
 *  - Güvenli mutasyonlar: sync_properties, create_node_safely — ajan dosyayı
 *    düz metin olarak değiştirmek yerine ast-core'un AST motorundan geçer.
 *  - Drift geri besleme döngüsü: ajanın ürettiği kod kaydedilmeden önce
 *    drift-check'ten geçirilir; ihlalde ajan hata payload'ı ile düzeltmeye zorlanır.
 *
 *  ast-core API'si bilinçli olarak saf fonksiyonlar halinde tasarlandı
 *  (scanProject, syncProperties, diffGraphs) — bu sunucu onları stdio MCP
 *  araçları olarak sarmalayacak. */

export const MCP_PHASE = 3;
export const NOT_IMPLEMENTED =
  "@solarch/mcp is a Phase 3 placeholder — the MCP server lands after the CLI core (Phase 1) and the public API (Phase 2) ship.";
