# solarch-tools

Solarch geliştirici araçları monoreposu — **SOLARCH 2.0**: kodun mimariden
kopmasını (drift) engelleyen CLI, çift yönlü senkron (pull/push) ve canlı
bağlama (live binding) motoru.

```
packages/
  ast-core/   @solarch/ast-core — ts-morph tabanlı NestJS AST okuma/yazma motoru
  cli/        @solarch/cli      — `solarch` binary'si (login/link/scan/diff/pull/push/watch/bind)
  mcp/        @solarch/mcp      — `solarch-mcp` MCP sunucusu (AI ajanları için bağlam + güvenli mutasyon)
  vscode/     solarch-vscode    — VS Code eklentisi (yan sekmede revizyon çizelgesi + drift, "mimari Git Graph")
```

Paket detayları: [`packages/ast-core/README.md`](packages/ast-core/README.md) ·
[`packages/cli/README.md`](packages/cli/README.md) ·
[`packages/mcp/README.md`](packages/mcp/README.md) ·
[`packages/vscode/README.md`](packages/vscode/README.md)

## Ne işe yarıyor?

Solarch'ta mimariyi çizersin (To-Be). Bu CLI kod tabanını derleyici seviyesinde
okur (As-Is) ve ikisini iki yönde senkron tutar:

**Bekçi yönü (diff):**

- **Kodda olup diyagramda olmayan** parçalar → uyarı ("onaysız genişleme")
- **Diyagramda olup kodda olmayan** parçalar → hata ("taahhüt karşılanmadı")
- **Kural ihlali** (örn. Controller'ın Repository'yi direkt çağırması) → hata,
  Kurallar Matrisi cloud'dan canlı çekilir
- `solarch diff --ci` hata varsa exit 1 döner → CI'da merge fiziksel olarak bloklanır.

**Senkron yönü (pull/push — Faz 2):**

- `solarch pull` To-Be grafını revizyon numarasıyla yerel kopyaya indirir.
- `solarch push` koddaki eksikleri (yeni node/edge + kolon/method listeleri)
  plana döker, onay alır ve **tek atomik istek**le cloud'a yazar. İkinci push
  no-op'tur (idempotans); kurala aykırı bağlantı ASLA pushlanmaz.
- **İki katmanlı çatışma koruması:** graf revizyonu eskidiyse sunucu hiçbir şey
  yazmadan 409 döner, CLI taze grafı çekip planı yeniden hesaplar ve bir kez
  yeniden dener. Tek bir node bu arada değiştiyse interaktif seçim:
  cloud'u tut / kodu yaz / atla.

## Hızlı başlangıç

```bash
pnpm install && pnpm build

# 1. Solarch app → Settings → API Keys → anahtar üret
solarch login

# 2. NestJS repo'nun kökünde: projeye bağla (solarch.json yazar)
solarch link

# 3. Lokal grafı gör / drift kontrolü / implementasyon panosu
solarch scan
solarch diff            # insan-okur rapor
solarch diff --ci       # GitHub annotations + exit code
solarch diff --json     # makine-okur
solarch status          # üretilen iskeletin ne kadarı dolduruldu? (--ci: iskelet kaldıysa kır)

# 4. Çift yönlü senkron
solarch pull            # To-Be → .solarch/to-be.json (revizyonuyla)
solarch push            # koddaki delta → cloud (plan + onay; --yes CI için)

# 5. Canlı bağlama: Entity değişince DTO otomatik güncellensin
solarch bind "src/users/user.entity.ts#User" "src/users/create-user.dto.ts#CreateUserDto"
solarch watch           # daemon: dosya değişikliklerini izler

# 6. AI ajanına bağla (MCP) — mcp.json'a ekle:
#    { "command": "solarch-mcp", "args": ["--root", "/path/to/repo"] }
```

CI örneği: [`packages/cli/examples/github-action.yml`](packages/cli/examples/github-action.yml)

## Tasarım sözleşmeleri

- **Taksonomi cloud'un aynası:** 21 node tipi + 16 edge tipi `solarch-backend`
  şemalarıyla birebir (`packages/ast-core/src/types.ts`). Yeni format yok.
- **AST, regex değil:** sınıf rolleri dekoratörlerden (@Controller, @Injectable,
  @Entity, @Module) ve constructor injection'dan çıkarılır — dosya adından değil.
- **Yazma güvenliği:** live binding yalnız property bildirimi ekler, metodlara
  asla dokunmaz. Eklenen alanlar `@solarch:bound` marker'ı taşır; tip çatışmasında
  üzerine yazılmaz, raporlanır.
- **Eşleştirme kararlılığı:** kod-node ↔ cloud-node eşleşmesi `(kind, kanonik isim)`
  ile yapılır, `.solarch/map.json` cache'i yeniden adlandırmalarda eşleşmeyi korur.
  Push'un `idMap` çıktısı da bu cache'e işlenir — yeni node'lar anında eşleşmiş sayılır.
- **Silme yok:** push cloud'dan asla node/edge silmez (`--prune` bilinçli olarak yok) —
  silmek yalnız canvas'tan yapılır.
- **Tek motor, iki tüketici:** MCP araçları CLI'ın motorlarını `@solarch/cli/lib`
  (yan etkisiz kütüphane girişi) üzerinden paylaşır — ajanın gördüğü drift ile
  CI'ın gördüğü drift hiçbir zaman ayrışmaz.

## Faz durumu

| Faz | Kapsam | Durum |
|---|---|---|
| 1 | AST motoru, scan/diff/watch/bind, API anahtarı altyapısı | DONE |
| 2 | Graf revizyonu + çatışma çözümleme, `pull`/`push` | DONE |
| 3 | MCP sunucusu — 6 araç: bağlam (get_architecture, get_rules), geri besleme (check_drift), iş kuyruğu (get_unimplemented), güvenli mutasyon (create_node_safely, sync_properties) | DONE |
| 3.5 | VS Code eklentisi — yan sekmede revizyon zaman çizelgesi + update uyarısı + drift listesi, Problems entegrasyonu, status bar, kayıtta tazeleme | DONE |
| 3.6 | İmplementasyon katmanı — surgical marker okuma (`@solarch:surgical`), `solarch status`, eklentide Implementation bölümü, MCP iş kuyruğu | DONE |

## Geliştirme

```bash
pnpm build   # tüm paketler (topolojik sıra)
pnpm test    # vitest — fixture snapshot + diff motoru + push planner + write round-trip
pnpm lint    # tsc --noEmit
```

`packages/ast-core/fixtures/basic-app` gerçekçi bir mini NestJS uygulamasıdır;
tarayıcının çıkardığı graf snapshot testleriyle kilitlenmiştir. Push akışı
lokal `solarch-backend`'e karşı uçtan uca doğrulanmıştır (ilk push ekler,
ikinci push no-op).
