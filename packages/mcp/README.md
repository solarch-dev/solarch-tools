# @solarch/mcp

Solarch MCP (Model Context Protocol) sunucusu — AI kodlama ajanlarına
(Claude Desktop, Cursor, Cline…) **gerçek mimari bağlamı ve kural denetimli
mutasyon** verir. Ajan artık mimariyi tahmin etmez: haritayı buradan okur,
yasaları buradan öğrenir, eklediği her şey Rules Engine'den geçer.

## Araçlar

| Araç | Tür | Ne yapar |
|------|-----|----------|
| `get_architecture` | read-only | Projenin güncel To-Be grafını ajana verir: node'lar (id, tip, isim, property), edge'ler (isimle anlatılır — LLM UUID değil isim üzerinden akıl yürütür), graf revizyonu. Halüsinasyon panzehiri. |
| `get_rules` | read-only | Kurallar Matrisi: whitelist (legal kombinasyonlar) + blacklist (anti-pattern'ler, hata kodu ve düzeltme önerisiyle). Default deny notu payload'da. |
| `check_drift` | feedback | Kodu AST seviyesinde tarar, cloud ile karşılaştırır, yapısal bulgular döner. Ajan ürettiği kodu bitirmeden doğrular; `clean: false` ise verdict "düzelt ve tekrar dene" der (ReAct self-correction). |
| `get_unimplemented` | read-only | **Cerrahi AI'ın iş kuyruğu:** codegen'in bıraktığı `@solarch:surgical` işaretlerinden hâlâ `NOT_IMPLEMENTED` olan bölgeleri döner — iş açıklaması, fırlatılacak Exception'lar, kullanılabilir bağımlılıklar ve dosya/satır ile. Yanıtta **sözleşme ihlalleri** de listelenir (dolu gövde beyan dışı dep/throw kullanıyorsa). Doldururken `@solarch:filled by=ai` imzası bırak. Akış: get_unimplemented → bölgeyi doldur → check_drift. Tamamen lokal, login gerektirmez. |
| `create_node_safely` | mutation | Yeni node + mevcut node'lara opsiyonel edge'ler. Önce lokal kural ön-kontrolü (tek turda net gerekçe), sonra sunucuda `graph/apply` + `baseRevision` — atomik, idempotent, kural-dışı bağlantı ASLA yazılmaz. |
| `sync_properties` | mutation | `@solarch/ast-core` live binding: Entity → DTO güvenli property enjeksiyonu. Yalnız property bildirimi ekler, `@solarch:bound` marker'lı, mevcut alanların üzerine yazmaz — çatışmaları raporlar. |

Hata sözleşmesi: araçlar exception fırlatmaz; `{ code, message, suggestion }`
payload'ı döner — ajan öneriden kendi kendini düzeltir. Kimlik/link eksikse
`ERR_NOT_CONFIGURED` + hangi CLI komutunun çalıştırılacağı söylenir.

## Kurulum

Kimlik ve proje bağı CLI ile paylaşılır — önce bir kez:

```bash
solarch login    # Settings → API Keys → anahtar (→ ~/.solarch/credentials)
solarch link     # repo kökünde, solarch.json yazar
```

Sonra MCP istemcisine kaydet (örn. Cursor `mcp.json` / Claude Desktop config):

```json
{
  "mcpServers": {
    "solarch": {
      "command": "solarch-mcp",
      "args": ["--root", "/path/to/your/nestjs-repo"]
    }
  }
}
```

`--root` verilmezse process'in çalışma dizini kullanılır. Sunucu stdio
üzerinden konuşur; loglar yalnız stderr'e yazılır. Bağlam her araç çağrısında
taze çözülür — sunucu açıkken `solarch login`/`link` yapılabilir, restart gerekmez.

## Mimarinin paylaşımı

```
@solarch/ast-core ──┐
                    ├── @solarch/cli  (binary: dist/index.js)
                    │        └── lib girişi: @solarch/cli/lib (yan etkisiz)
                    └── @solarch/mcp ──┘
```

MCP araç gövdeleri CLI ile **aynı motorları** kullanır: `SolarchApi` istemcisi,
`diffGraphs` drift motoru, `evaluateEdge` kural değerlendirmesi ve
`~/.solarch` + `solarch.json` yapılandırması `@solarch/cli/lib`'den gelir.
Tek kaynak — CLI'ın gördüğü drift ile ajanın gördüğü drift hiçbir zaman ayrışmaz.

```
src/
├── index.ts     # bin: --root parse + stdio bootstrap
├── server.ts    # McpServer kurulumu, araç kayıtları, hata zarfı
├── context.ts   # ToolContext: rootDir + projectId + ApiClient (lazy çözülür)
└── tools.ts     # 5 araç gövdesi — saf fonksiyonlar, transport bilmez
```

## Test

```bash
pnpm test    # 12 test
```

- `test/tools.test.ts` — araç gövdeleri mock API ile: isim-bazlı graf görünümü,
  edge yön eşlemesi (outgoing/incoming → tempId/cloudId), blacklist ön-kontrolü,
  sunucu rollback taşıması, gerçek dosyalarla sync_properties idempotansı.
- `test/server.test.ts` — gerçek MCP istemcisiyle (InMemoryTransport) uçtan uca:
  araç ilanı, zod şema reddi, yapılandırma-eksik hatasının ajan-dostu payload'ı.
- `test/drift.test.ts` — check_drift: bulgular, verdict, map.json cache yazımı.

Uçtan uca smoke (lokal backend + Neo4j ile doğrulandı): boş proje → Table
oluştur → Repository + QUERIES edge (revizyon 1→2) → Controller-QUERIES->Table
ERR_002 ile bloklandı → sync_properties DTO'ya alan ekledi → check_drift yeni
node'ları "kodda eksik" diye raporladı.
