# @solarch/ast-core

ts-morph tabanlı NestJS **AST okuma/yazma motoru** — `@solarch/cli`'ın ve
(Faz 3'te) `@solarch/mcp`'nin çekirdeği. Saf fonksiyonlardan oluşur; terminal,
dosya formatı veya HTTP bilmez — bu yüzden her iki tüketici de aynı motoru paylaşır.

## Ne yapar?

İki yönü var:

1. **Okuma (scan):** Kod tabanını TypeScript derleyicisinin gözünden okur ve
   Solarch graf taksonomisine map edilmiş bir **As-Is graf** çıkarır.
2. **Yazma (binding):** Kaynak sınıftan (örn. TypeORM Entity) property'leri
   çıkarıp hedef sınıfa (örn. DTO) güvenli şekilde enjekte eder.

Regex yok: sınıf rolleri dekoratörlerden, ilişkiler constructor injection /
dönüş tiplerinden / `@Module` metadata'sından çözülür — "derleyicinin gördüğü gibi".

## Taksonomi: cloud'un aynası

`src/types.ts` backend şemalarının birebir kopyasıdır — **yeni format icat
edilmez**, cloud'un diline çevrilir:

- **21 node tipi** (`NODE_KINDS`): Table, DTO, Model, Enum, View, Service,
  Worker, EventHandler, Controller, MessageQueue, Repository, Cache,
  ExternalService, FrontendApp, UIComponent, Middleware, EnvironmentVariable,
  Exception, Module, APIGateway, Orchestrator
- **16 edge tipi** (`EDGE_KINDS`): CALLS, REQUESTS, PUBLISHES, SUBSCRIBES,
  USES, HAS, EXTENDS, IMPLEMENTS, RETURNS, QUERIES, WRITES, CACHES_IN,
  DEPENDS_ON, READS_CONFIG, THROWS, ROUTES_TO

Eşleştirme kimliği: kodda UUID olmadığından `nodeKey(kind, isim)` kanonik
anahtarı kullanılır (`"UsersService"`, `"users-service"`, `"users_service"`
aynı anahtara düşer).

## Sınıflandırma kuralları (özet)

| Kod | Node tipi |
|---|---|
| `@Controller()` | Controller (+ `@Get/@Post/…` → Endpoints listesi) |
| `@Entity()` | Table (+ `@Column` → Columns listesi) |
| `@Injectable()` + isim/`Repository` kalıtımı | Repository |
| `@Injectable()` (diğer) | Service (+ public metodlar → Methods) |
| `class *Dto` + class-validator | DTO (+ Fields) |
| `@Module()` | Module (imports → DEPENDS_ON, exports → USES) |
| `enum` bildirimi | Enum (+ Values) |
| `@Cron` metodlu sınıf | Worker (Schedule + TaskToExecute) |
| `@OnEvent/@EventPattern` | EventHandler |
| `HttpException` alt sınıfı / `*Exception` | Exception (parent'tan HttpStatusCode tahmini) |
| Guard / `*Middleware` | Middleware |

Koddan çıkarılamayan zorunlu şema alanlarına (örn. Worker.TimeoutSeconds)
**şema-geçerli makul default** yazılır ki `solarch push` node'u cloud'a
ekleyebilsin — kullanıcı canvas'ta düzeltir. Sınıflandırılamayan/şüpheli
durumlar sessizce yutulmaz, `graph.warnings`'e düşer.

## API

```ts
import {
  scanProject,            // (ScanOptions) → AsIsGraph
  classifyClass,          // (ClassDeclaration) → NodeKind | null
  readSourceProperties,   // (ClassDeclaration) → SourceProperty[]
  syncProperties,         // (kaynak, hedef, fields) → { added, skipped, conflicts }
  runBinding,             // (rootDir, "dosya#Sınıf", "dosya#Sınıf", fields) → dosyayı yazar
  nameOfNode, nodeKey, edgeKey, canonicalName,
  NODE_KINDS, EDGE_KINDS, NAME_FIELD_BY_KIND,
} from "@solarch/ast-core";
```

### `scanProject(options)`

```ts
const graph = scanProject({
  rootDir: "/path/to/nestjs-app",
  include: ["src/**/*.ts"],          // varsayılan
  exclude: ["src/**/*.spec.ts"],
});
// → { nodes: AsIsNode[], edges: AsIsEdge[], warnings: string[], fileCount, … }
```

Her `AsIsEdge` bir **kanıt** taşır (`reason`: "constructor injection:
usersService: UsersService" gibi) — drift raporları bu kanıtı gösterir.

### `runBinding(rootDir, source, target, fields)`

Live binding'in dosya seviyesi sarmalayıcısı. Güvenlik sözleşmesi:

- **Yalnız property bildirimi** eklenir — metodlara/iş mantığına asla dokunulmaz.
- Eklenen her alan `// @solarch:bound from=User` marker'ı taşır; sonraki
  senkronlarda "bizim eklediğimiz" ile "kullanıcının yazdığı" ayrılır.
- Hedefte aynı isimli property varsa: tip uyuşuyorsa atlanır, **uyuşmuyorsa
  üzerine yazılmaz** — `conflicts[]` ile raporlanır.
- TypeORM ilişki alanları (`@ManyToOne` vb.) DTO'ya kopyalanmaz.
- Kolon tipi → TS tipi + class-validator dekoratörü eşlemesi otomatiktir
  (`string→IsString`, `number→IsNumber`, `Date→IsDate`, …).

## Test

```bash
pnpm test
```

- `fixtures/basic-app/` — gerçekçi mini NestJS uygulaması (entity, dto, service,
  controller, module, guard, worker, exception, enum…).
- `test/scan.test.ts` — fixture'dan çıkan graf **snapshot** ile kilitli;
  extractor değişiklikleri bilinçli snapshot güncellemesi gerektirir.
- `test/write.test.ts` — `syncProperties` birim testleri + round-trip
  (enjekte et → yeniden tara → graf eşleşmeli).
