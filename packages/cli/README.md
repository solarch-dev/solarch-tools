# @solarch/cli

`solarch` komut satırı aracı — kod tabanı (As-Is) ile Solarch'ta çizilen mimari
(To-Be) arasındaki köprü. Drift bekçisi, çift yönlü senkron ve canlı bağlama
(live binding) tek binary'de.

```
Kod ──scan──▶ As-Is graf ──diff──▶ drift raporu (CI'da merge bloklar)
                  │
                  └──push──▶ Solarch Cloud (eksik node/edge + property)
Cloud ──pull──▶ .solarch/to-be.json (offline referans)
Entity değişti ──watch──▶ DTO'ya otomatik property senkronu (bind)
```

## Kurulum ve ilk ayar

```bash
npm install -g @solarch/cli      # veya monorepo içinde: pnpm build

solarch login                    # Solarch app → Settings → API Keys → anahtar üret
solarch link                     # repo'yu bir Solarch projesine bağla (solarch.json yazar)
```

## Komutlar

### `solarch login`

API anahtarını `~/.solarch/credentials` dosyasına (600 izinli) kaydeder.

| Seçenek | Açıklama |
|---|---|
| `--key <key>` | Anahtarı argümanla ver (CI için, interaktif sormaz) |
| `--api-url <url>` | Varsayılan `https://api.solarch.dev/api/v1` yerine başka sunucu |

### `solarch link`

Bulunduğun repo'yu hesabındaki bir Solarch projesine bağlar → `solarch.json`
yazar. `--project <id>` ile seçim ekranını atlayabilirsin.

### `solarch scan`

Kodu derleyici seviyesinde (ts-morph) tarar, As-Is grafı çıkarır ve özet basar.
`--json` makine-okur tam graf döker.

### `solarch status`

İmplementasyon panosu: kod üretim motorunun bıraktığı `@solarch:surgical`
işaretlerini okur ve "üretilen iskeletin ne kadarı gerçekten dolduruldu?"
sorusunu cevaplar — node bazında doluluk + bekleyen üye listesi (iş
açıklamasıyla).

```
Implementation status — 12/40 member(s) implemented (30%)

  ● AccountsService (Service) 1/5 src/accounts/accounts.service.ts
      ✗ createAccount :12 — Yeni hesap açar; bakiye sıfırla başlar.
```

| Seçenek | Açıklama |
|---|---|
| `--ci` | Doldurulmamış üye kaldıysa **exit 1** — "boş gövdeyle release çıkılmaz" kapısı |
| `--json` | Makine-okur rapor |

### `solarch diff`

Drift kontrolü: As-Is ↔ To-Be karşılaştırması.

| Bulgu | Önem | Anlamı |
|---|---|---|
| `DRIFT_NODE_MISSING_IN_CODE` | error | Mimaride var, kodda yok — taahhüt karşılanmadı |
| `DRIFT_EDGE_MISSING_IN_CODE` | error | Mimarideki bağlantı kodda kurulmamış |
| `DRIFT_ILLEGAL_EDGE` | error | Koddaki bağlantı Kurallar Matrisi'ne aykırı (blacklist / whitelist dışı) |
| `DRIFT_NODE_NOT_IN_CLOUD` | warn | Kodda var, mimaride yok — onaysız genişleme |
| `DRIFT_EDGE_NOT_IN_CLOUD` | warn | Koddaki bağlantı diyagramda yok |
| `DRIFT_PROPERTY` | info | Kolon/alan/method listesi farkı |

| Seçenek | Açıklama |
|---|---|
| `--ci` | GitHub annotation formatı; **error varsa exit 1** → merge bloklanır |
| `--json` | Makine-okur rapor |
| `--to-be <file>` | Offline mod: To-Be grafı API yerine dosyadan oku (örn. `.solarch/to-be.json`) |

### `solarch pull`

To-Be grafını **revizyon numarasıyla** `.solarch/to-be.json`'a indirir.
Offline `diff --to-be` için taze yerel kopya + push öncesi referans.

### `solarch push`

Koddaki delta'yı cloud'a yazar. Akış:

1. Taze graf çekilir (revizyon **R**) ve plan çıkarılır: eklenecek node'lar,
   eklenecek edge'ler, güncellenecek liste-property'leri.
2. Plan gösterilir, onay istenir (`--yes` CI için atlar).
3. **Ekleme** tek atomik `graph/apply` çağrısıyla gider (`baseRevision: R`).
   Edge uçları: yeni node'larda `tempId`, mevcut node'larda cloud id.
4. **Property güncelleme**: liste alanlarında (Columns/Fields/Methods/
   Endpoints/Values) **kod kaynak kabul edilir** — cloud'un diğer property'leri
   korunur, yalnız liste alanı kodunkiyle değiştirilip `PATCH` edilir.
5. Başarıda `idMap` ile `.solarch/map.json` güncellenir — yeni node'lar anında
   eşleşmiş sayılır; ikinci push **no-op**'tur (idempotans).

Güvenlik kuralları:

- **Illegal edge varken push komple reddedilir** (exit 1) — önce kuralı ihlal
  eden bağlantıyı düzelt ya da canvas'tan onaylat.
- **Silme yok**: cloud'dan node silmek yalnız canvas'tan yapılır (`--prune` bilinçli olarak yok).

Çatışma çözümü (iki katman):

| Durum | Ne olur |
|---|---|
| Graf revizyonu eskidi (`ERR_GRAPH_REVISION_CONFLICT`, 409) | Otomatik: taze graf çekilir, plan yeniden hesaplanır, **bir kez** yeniden denenir. İkinci 409'da kullanıcıya bırakılır. |
| Node bu arada değişti (`ERR_VERSION_CONFLICT`, 409) | İnteraktif seçim: **cloud'u tut / kodu yaz / atla**. TTY yoksa (CI) otomatik "atla" + rapor. |

### `solarch generate`

Cloud'daki graftan **deterministik kod iskeletini** üretir ve repoya yazar
(Constructor — AI'sız, aynı graf → bayt-aynı çıktı). Metot gövdeleri
`@solarch:surgical` işaretli gelir; sonrası `solarch status` ile takip edilir.

| Seçenek | Davranış |
|---|---|
| (varsayılan) | Yalnız **yeni** dosyalar yazılır — elle/AI ile doldurulmuş kod asla ezilmez |
| `--force` | Mevcut dosyaların da üzerine yazar (taze iskelete sıfırlama) |

Build+ plan gerektirir (`402 ERR_PLAN_AI`). Akış: `generate` → `status` →
(cerrahi AI / insan doldurur) → `diff` ile mimari doğrulama.

### `solarch bind <kaynak> <hedef>`

Kalıcı canlı bağ tanımlar (`solarch.json`'a yazar) ve hemen bir kez çalıştırır:

```bash
solarch bind "src/users/user.entity.ts#User" "src/users/create-user.dto.ts#CreateUserDto"
solarch bind ... --fields email,name     # yalnız belirli alanlar (varsayılan: all)
```

Entity kolonları → DTO property'leri (TS tipi + class-validator dekoratörü).
Eklenen alanlar `// @solarch:bound` marker'ı taşır; elle yazılmış property'lere
dokunulmaz, tip çatışmasında üzerine yazılmaz — raporlanır.

### `solarch watch`

Daemon: chokidar ile dosya değişikliklerini izler; kaynak dosya değişince
bağlı binding'leri çalıştırır + artımlı drift özeti basar. `--no-drift` yalnız
binding modu. Ctrl-C ile durur.

## Dosyalar

| Dosya | Ne | Commit'lenir mi? |
|---|---|---|
| `~/.solarch/credentials` | API anahtarı (makine geneli, 600 izinli) | hayır (home'da) |
| `solarch.json` | Proje bağı: `projectId`, `include`/`exclude` glob'ları, `bindings[]` | **evet** |
| `.solarch/map.json` | Kod-node ↔ cloud-node eşleştirme cache'i | isteğe bağlı (önerilir: evet — yeniden adlandırmada eşleşme kararlı kalır) |
| `.solarch/to-be.json` | `pull` çıktısı: To-Be graf + revizyon | hayır (üretilebilir) |

`solarch.json` örneği:

```json
{
  "projectId": "66bea437-…",
  "projectName": "my-api",
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.spec.ts"],
  "bindings": [
    { "source": "src/users/user.entity.ts#User", "target": "src/users/user.dto.ts#UserDto", "fields": "all" }
  ]
}
```

## CI entegrasyonu

Hazır GitHub Actions örneği: [`examples/github-action.yml`](examples/github-action.yml).
Özet: `solarch login --key "$SOLARCH_API_KEY"` → `solarch diff --ci`. Error
seviyesinde drift job'ı kırar. İstersen `solarch push --yes` ile main'e merge
sonrası otomatik senkron da eklenebilir.

## Exit code sözleşmesi

| Kod | Anlamı |
|---|---|
| 0 | Temiz (veya yalnız warn/info bulgular) |
| 1 | Error seviyesinde drift, illegal edge'li push, çözülemeyen revizyon çatışması, yapılandırma eksiği |

## İç mimari

```
src/
├── index.ts          # commander tanımları (binary girişi)
├── lib.ts            # @solarch/cli/lib — yan etkisiz kütüphane girişi (@solarch/mcp tüketir)
├── config.ts         # credentials / solarch.json / map.json okuma-yazma
├── api.ts            # Solarch Cloud istemcisi (Bearer slk_…, zarf açma, ApiError)
├── commands/         # login, link, scan, diff, pull, push, bind, watch
├── diff/
│   ├── engine.ts     # eşleştirme + drift bulguları + legalite (kurallar cloud'dan)
│   └── report.ts     # TTY / JSON / GitHub annotation çıktıları
└── push/
    └── planner.ts    # diff → apply payload + property merge planı
```

Test: `pnpm test` — diff motoru, push planner'ı ve 409 retry akışı (API mock)
vitest ile kilitli.
