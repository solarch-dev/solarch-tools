# solarch-tools

Solarch geliştirici araçları monoreposu — **SOLARCH 2.0 Faz 1**: kodun mimariden
kopmasını (drift) engelleyen CLI + canlı bağlama (live binding) motoru.

```
packages/
  ast-core/   @solarch/ast-core — ts-morph tabanlı NestJS AST okuma/yazma motoru
  cli/        @solarch/cli      — `solarch` binary'si (login/link/scan/diff/watch/bind)
  mcp/        @solarch/mcp      — Faz 3 placeholder (MCP sunucusu)
```

## Ne işe yarıyor?

Solarch'ta mimariyi çizersin (To-Be). Bu CLI kod tabanını derleyici seviyesinde
okur (As-Is) ve ikisini karşılaştırır:

- **Kodda olup diyagramda olmayan** parçalar → uyarı ("onaysız genişleme")
- **Diyagramda olup kodda olmayan** parçalar → hata ("taahhüt karşılanmadı")
- **Kural ihlali** (örn. Controller'ın Repository'yi direkt çağırması) → hata,
  Kurallar Matrisi cloud'dan canlı çekilir

`solarch diff --ci` hata varsa exit 1 döner → CI'da merge fiziksel olarak bloklanır.

## Hızlı başlangıç

```bash
pnpm install && pnpm build

# 1. Solarch app → Settings → API Keys → anahtar üret
solarch login

# 2. NestJS repo'nun kökünde: projeye bağla (solarch.json yazar)
solarch link

# 3. Lokal grafı gör / drift kontrolü
solarch scan
solarch diff            # insan-okur rapor
solarch diff --ci       # GitHub annotations + exit code
solarch diff --json     # makine-okur

# 4. Canlı bağlama: Entity değişince DTO otomatik güncellensin
solarch bind "src/users/user.entity.ts#User" "src/users/create-user.dto.ts#CreateUserDto"
solarch watch           # daemon: dosya değişikliklerini izler
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

## Geliştirme

```bash
pnpm build   # tüm paketler (topolojik sıra)
pnpm test    # vitest — fixture snapshot + diff motoru + write round-trip
pnpm lint    # tsc --noEmit
```

`packages/ast-core/fixtures/basic-app` gerçekçi bir mini NestJS uygulamasıdır;
tarayıcının çıkardığı graf snapshot testleriyle kilitlenmiştir.
