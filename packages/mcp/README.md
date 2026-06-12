# @solarch/mcp

**Faz 3 placeholder** — Solarch MCP (Model Context Protocol) sunucusu burada yaşayacak.

Plan ([SOLARCH 2.0 yol haritası](../../README.md)):

| Araç | Tür | Ne yapar |
|------|-----|----------|
| `get_architecture` | read-only | Projenin güncel To-Be grafını ajana verir (halüsinasyon panzehiri) |
| `get_rules` | read-only | Kurallar Matrisi'ni (whitelist/blacklist) ajana verir |
| `sync_properties` | mutation | `@solarch/ast-core` `syncProperties` ile güvenli alan enjeksiyonu |
| `create_node_safely` | mutation | Yeni node'u önce kural motorundan geçirip cloud'a yazar |
| `check_drift` | feedback | Ajanın ürettiği kodu kaydetmeden önce drift-check'ten geçirir; ihlalde hata payload'ı döner (ReAct self-correction) |

Çekirdek hazır: `@solarch/ast-core` saf fonksiyonlar (`scanProject`, `syncProperties`) ve
CLI'daki `diffGraphs` motoru bu sunucunun araç gövdeleri olacak.
