/** Surgical marker reader — extracts marked regions left by codegen, reads
 *  signatures, and audits filled bodies against the contract.
 *
 *  The backend scaffold generator (solarch-backend/src/codegen/surgical.ts)
 *  leaves a machine-parseable marker on every method body:
 *
 *    // @solarch:surgical id=<nodeId>#<member>
 *    // <job description>                        (optional, may span lines)
 *    // throws: ExceptionA, ExceptionB         (optional)
 *    // deps: dep1, dep2                       (optional)
 *    throw new Error("NOT_IMPLEMENTED: Class.member");
 *
 *  Whoever fills the region (surgical AI / human) may leave a signature below:
 *
 *    // @solarch:filled by=ai at=2026-06-13T00:00:00Z
 *
 *  States:
 *  - skeleton : body still throws NOT_IMPLEMENTED (not filled)
 *  - filled   : converted to real code; no signature → assumed human-written
 *
 *  Contract audit (filled members only, via AST):
 *  - accesses an injected dependency (`this.x`) from constructor but not in
 *    `deps:` declaration → violation
 *  - `throw new XException(...)` but not in `throws:` declaration → violation
 *  - if declaration line is missing, that check is skipped (no contract = free)
 *  - access to the class’s OWN helpers/fields is allowed — only DI dependencies
 *    are audited (avoids false positives). */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ClassDeclaration, EnumDeclaration, MethodDeclaration, Node, Project, SyntaxKind, ts, Type } from "ts-morph";

export type SurgicalStatus = "skeleton" | "filled";
export type FilledBy = "ai" | "human";

export interface SurgicalMember {
  /** Metot/üye adı (işaretten; yoksa bildirimden). */
  member: string;
  /** İşaretteki cloud node UUID'si. */
  nodeId: string;
  status: SurgicalStatus;
  /** Dolduranın imzası — damga yoksa "human" (yalnız filled'da anlamlı). */
  filledBy?: FilledBy;
  /** İmzadaki zaman damgası (varsa). */
  filledAt?: string;
  /** İş açıklaması — cerrahi AI'ın doldururken kullanacağı talimat. */
  description?: string;
  /** Fırlatması beklenen Exception node Name'leri. */
  throws?: string[];
  /** Erişebileceği bağımlılıklar (DI alanları / repo / servis Name'leri). */
  deps?: string[];
  /** Sözleşme ihlalleri (yalnız filled + beyan varsa; insan-okur). */
  violations?: string[];
  /** Metodun dosyadaki başlangıç satırı (1-tabanlı). */
  line: number;
}

const MARKER_RE = /@solarch:surgical\s+id=([^\s#]+)#(\S+)/;
const FILLED_RE = /@solarch:filled\s+by=(\w+)(?:\s+at=(\S+))?/;
const NOT_IMPLEMENTED_RE = /throw\s+new\s+Error\(\s*["'`]NOT_IMPLEMENTED:/;

/** Kanonik karşılaştırma — "accountsRepository" ↔ "AccountsRepository" eşleşir. */
const canon = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Object/Function üzerinde HER tipte bulunan üyeler — üye-denetiminde yanlış
 *  pozitif vermesinler (ör. `ClassName.name`, `x.toString`). */
const BUILTIN_MEMBERS = new Set([
  "name", "constructor", "prototype", "length", "call", "apply", "bind",
  "hasOwnProperty", "toString", "valueOf", "isPrototypeOf",
  "propertyIsEnumerable", "toLocaleString", "then", "catch", "finally",
]);

/** Bir tipin GERÇEK (sahip olduğumuz) üye adları — apparent type'ın property'leri,
 *  dahili (__) ve Object/Promise built-in'leri elenmiş. checkMemberAccess (ihlal
 *  listesi), completeType (tamamlama) ve autoCorrectMembers (snap) TEK KAYNAKtan
 *  beslensin diye burada. */
function membersOf(t: Type): string[] {
  return t
    .getApparentType()
    .getProperties()
    .map((p) => p.getName())
    .filter((m) => !m.startsWith("__") && !BUILTIN_MEMBERS.has(m));
}

/* ── sözleşme denetimi ───────────────────────────────────────────── */

/** Sınıfın constructor'ından enjekte edilen parametre-property adları. */
function injectedDeps(cls: ClassDeclaration): Set<string> {
  const out = new Set<string>();
  for (const ctor of cls.getConstructors()) {
    for (const p of ctor.getParameters()) {
      if (p.isParameterProperty()) out.add(p.getName());
    }
  }
  return out;
}

function checkContract(
  method: MethodDeclaration,
  injected: Set<string>,
  declaredDeps: string[] | undefined,
  declaredThrows: string[] | undefined,
): string[] {
  const violations: string[] = [];
  const body = method.getBody();
  if (!body) return violations;

  // deps: this.<x> erişimleri — yalnız DI bağımlılıkları denetlenir.
  // Beyan "this.ordersRepository" ya da "ordersRepository" biçiminde olabilir
  // (emitter this. önekiyle yazar) — önek düşürülerek karşılaştırılır.
  if (declaredDeps) {
    // Beyan bir çağrı-İPUCU olabilir (örn. ExternalService emitter "this.http.post,
    // this.baseUrl" yazar). deps sözleşmesi HANGİ enjekte bağımlılık'ı kapsar — metodu
    // değil; kök tanımlayıcıyı al (`this.http.post` → `http`, `this.authHeaders()` →
    // `authHeaders`) ki gövdenin `this.http.post(...)` çağrısı (taban erişimi `this.http`)
    // bildirilmiş sayılsın.
    const allowed = new Set(declaredDeps.map((d) => canon(d.replace(/^this\./, "").split(/[.([]/)[0]!)));
    const used = new Set<string>();
    for (const access of body.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (access.getExpression().getKind() !== SyntaxKind.ThisKeyword) continue;
      const name = access.getName();
      if (injected.has(name)) used.add(name);
    }
    for (const name of used) {
      if (!allowed.has(canon(name))) {
        violations.push(`uses undeclared dependency "this.${name}" — declared deps: ${declaredDeps.join(", ")}`);
      }
    }
  }

  // throws: yalnız *Exception sınıfları denetlenir (düz Error serbest).
  if (declaredThrows) {
    const allowed = new Set(declaredThrows.map(canon));
    const thrown = new Set<string>();
    for (const t of body.getDescendantsOfKind(SyntaxKind.ThrowStatement)) {
      const expr = t.getExpression();
      if (!expr || expr.getKind() !== SyntaxKind.NewExpression) continue;
      const name = expr.asKind(SyntaxKind.NewExpression)?.getExpression().getText() ?? "";
      if (name.endsWith("Exception")) thrown.add(name);
    }
    for (const name of thrown) {
      if (!allowed.has(canon(name))) {
        violations.push(`throws undeclared "${name}" — declared throws: ${declaredThrows.join(", ")}`);
      }
    }
    // throws-realization: bildirilen her exception için gövdede erişilebilir bir
    // `throw new X` olmalı. Deklare edilip hiç fırlatılmayan = eksik gerçekleme
    // (örn. `throws: DatabaseException` deklare edip repo çağrısını try/catch'e
    // sarmadan ham hata sızdırmak). Bu kural ESKİDEN prompt'taydı → artık koddan.
    const thrownCanon = new Set([...thrown].map(canon));
    for (const decl of declaredThrows) {
      if (canon(decl).length === 0) continue;
      if (!thrownCanon.has(canon(decl))) {
        violations.push(`declared throw "${decl}" is never reached — add the code path that throws it (e.g. wrap the dependency/repository call in try/catch and rethrow ${decl})`);
      }
    }
  }

  return violations;
}

/** KAPALI-DÜNYA üye denetimi (halüsinasyon geçidi). Gövdedeki her `recv.member`
 *  erişimi için: `recv` BİZİM ürettiğimiz YEREL bir tipe (kaynağı `src/` altında —
 *  entity/DTO/servis) çözülüyorsa ve `member` o tipte YOKSA → ihlal + GERÇEK üye
 *  listesi geri verilir. Böylece AI `customer.username` uyduramaz; tsc'ye gerek
 *  kalmadan, taslak yolunda bile (import'lar diskten lazy çözülür, node_modules
 *  gerekmez) yakalanır.
 *
 *  SAĞLAM (yanlış-pozitif YOK): tip any/unknown/union/type-param/statik-yan
 *  (`typeof X`) ya da kaynağı dışsal (node_modules — 3. parti) ise ATLA — onları
 *  tip denetimi (tsc) yakalar. Yalnız tam-çözülen, sahip olduğumuz tipler denetlenir. */
function checkMemberAccess(method: MethodDeclaration): string[] {
  const body = method.getBody();
  if (!body) return [];
  const violations: string[] = [];
  const reported = new Set<string>();
  for (const access of body.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const name = access.getName();
    if (BUILTIN_MEMBERS.has(name)) continue;
    let t;
    try {
      t = access.getExpression().getType().getNonNullableType();
    } catch {
      continue; // tip çözülemedi → güvenli atla
    }
    if (t.isAny() || t.isUnknown() || t.isUnion() || t.isIntersection() || t.isTypeParameter()) continue;
    if (t.getText().startsWith("typeof ")) continue; // statik/constructor yan (Function.name vb.)
    const sym = t.getSymbol() ?? t.getAliasSymbol();
    const decls = sym?.getDeclarations() ?? [];
    // YALNIZ kendi ürettiğimiz tipler (en az bir bildirimi src/ altında). 3. parti
    // (node_modules) tiplerini denetleme — onları tsc kapsar.
    const isOwn = decls.length > 0 && decls.some((d) => /[/\\]src[/\\]/.test(d.getSourceFile().getFilePath()));
    if (!isOwn) continue;
    const apparent = t.getApparentType();
    if (apparent.getProperty(name)) continue; // üye gerçek → OK
    const key = `${t.getText()}.${name}`;
    if (reported.has(key)) continue;
    reported.add(key);
    const allowed = membersOf(t);
    violations.push(
      `property "${name}" does not exist on type "${cleanType(t.getText())}" — use ONLY its real members: ${allowed.join(", ")} (do not invent member names)`,
    );
  }
  return violations;
}

/** Bir owned-tip kaçırmasını GERÇEK üyeye eşleyebilir miyiz? Yalnız tam BİR aday
 *  varsa döndür (muhafazakâr — anlamı asla sessizce değiştirmesin):
 *    (a) case-insensitive: `id` → `Id`, `fullname` → `fullName`
 *    (b) canon (snake/camel, alfanümerik): `full_name` → `fullName`
 *  Çoğul/tekil eşleme (`orders`↔`order`) bilerek ERTELENDİ (en yüksek belirsizlik
 *  riski; gerçek fill trace'leri görülünce aynı unique-guard'la eklenecek). */
function uniqueMemberMatch(name: string, members: string[]): string | null {
  let cands = members.filter((m) => m.toLowerCase() === name.toLowerCase());
  if (cands.length === 1) return cands[0]!;
  if (cands.length > 1) return null;
  cands = members.filter((m) => canon(m) === canon(name));
  if (cands.length === 1) return cands[0]!;
  return null;
}

/** DETERMİNİSTİK SNAP (IntelliSense'in "doğrusunu doldur" hâli). Gövdedeki her
 *  `recv.member` için: recv BİZİM (src/) bir tipe çözülüyor ve `member` o tipte YOK
 *  ama GERÇEK üyeye tam-bir-adayla eşleşiyorsa (case/canon), düğümü yerinde gerçek
 *  ada çevir (`user.id` → `user.Id`). 0 veya 2+ aday → DOKUNMA (checkMemberAccess
 *  yine ihlal verir, lookup_members yönlendirir). Düzeltilenleri "recv.eski ->
 *  recv.yeni" olarak döndürür. checkMemberAccess ile AYNI yürüyüş/owned-kapı. */
function autoCorrectMembers(method: MethodDeclaration): string[] {
  const body = method.getBody();
  if (!body) return [];
  // İKİ GEÇİŞ: önce eşleşmeleri topla (mutasyonsuz), sonra uygula — array snapshot'taki
  // sonraki düğümler geçersizleşmesin (her name-node bağımsız; replaceWithText yerel).
  const pending: { nameNode: Node; recv: string; from: string; to: string }[] = [];
  for (const access of body.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const name = access.getName();
    if (BUILTIN_MEMBERS.has(name)) continue;
    let t;
    try {
      t = access.getExpression().getType().getNonNullableType();
    } catch {
      continue;
    }
    if (t.isAny() || t.isUnknown() || t.isUnion() || t.isIntersection() || t.isTypeParameter()) continue;
    if (t.getText().startsWith("typeof ")) continue;
    const sym = t.getSymbol() ?? t.getAliasSymbol();
    const decls = sym?.getDeclarations() ?? [];
    const isOwn = decls.length > 0 && decls.some((d) => /[/\\]src[/\\]/.test(d.getSourceFile().getFilePath()));
    if (!isOwn) continue;
    if (t.getApparentType().getProperty(name)) continue; // zaten gerçek
    const real = uniqueMemberMatch(name, membersOf(t));
    if (!real || real === name) continue;
    pending.push({ nameNode: access.getNameNode(), recv: access.getExpression().getText(), from: name, to: real });
  }
  const fixed: string[] = [];
  for (const p of pending) {
    p.nameNode.replaceWithText(p.to);
    fixed.push(`${p.recv}.${p.from} -> ${p.recv}.${p.to}`);
  }
  return fixed;
}

/** TİP-GİZLEYEN CAST yasağı (forbidden-moves geçidi). `x as any` / `x as unknown`
 *  hem kapalı-dünya üye denetimini (any/unknown ATLANIR — checkMemberAccess satır
 *  ~174) hem tsc'yi kör eder → AI var olmayan bir alana erişip (audit: `(user as
 *  any).password`; User'da `password` yok, `passwordHash` var) bug'ı GİZLER. Bu
 *  cast'leri ihlal say → AI gerçek tipleri (API yüzeyinden) kullanmaya zorlanır.
 *  Çift-cast `as unknown as T`'nin `as unknown` kısmı da yakalanır (kaçış kapısı). */
function checkForbiddenCasts(method: MethodDeclaration): string[] {
  const body = method.getBody();
  if (!body) return [];
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const as of body.getDescendantsOfKind(SyntaxKind.AsExpression)) {
    const typeText = (as.getTypeNode()?.getText() ?? "").trim();
    if (!/^(any|unknown)\b/.test(typeText)) continue;
    const snippet = as.getText().replace(/\s+/g, " ").slice(0, 50);
    if (seen.has(snippet)) continue;
    seen.add(snippet);
    violations.push(
      `type-dodging cast "as ${typeText}" is not allowed — it hides real type errors ` +
        `(e.g. reading a field the type does not have). Use the real types from the API surface; if a ` +
        `value genuinely lacks the member you need, that is a contract problem to surface, not cast away.`,
    );
  }
  return violations;
}

/* ── işaret okuma ────────────────────────────────────────────────── */

/** Tek metodun gövdesinden işaret çıkar — işaret yoksa null. */
function readMethodMarker(method: MethodDeclaration, injected: Set<string>): SurgicalMember | null {
  const bodyText = method.getBody()?.getFullText();
  if (!bodyText) return null;

  const markerMatch = MARKER_RE.exec(bodyText);
  if (!markerMatch) return null;

  const [, nodeId, markedMember] = markerMatch;

  // İşaret satırını izleyen yorum satırlarından açıklama/throws/deps topla.
  const lines = bodyText.split("\n").map((l) => l.trim());
  const markerIdx = lines.findIndex((l) => MARKER_RE.test(l));
  const description: string[] = [];
  let throws: string[] | undefined;
  let deps: string[] | undefined;
  for (let i = markerIdx + 1; i >= 0 && i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("//")) break; // yorum bloku bitti
    const text = line.replace(/^\/\/\s?/, "");
    if (text.startsWith("throws:")) {
      throws = text.slice("throws:".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (text.startsWith("deps:")) {
      deps = text.slice("deps:".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (FILLED_RE.test(line)) {
      // imza description'a karışmasın
    } else if (text.length > 0) {
      description.push(text);
    }
  }

  const status: SurgicalStatus = NOT_IMPLEMENTED_RE.test(bodyText) ? "skeleton" : "filled";

  const member: SurgicalMember = {
    member: markedMember ?? method.getName(),
    nodeId: nodeId ?? "",
    status,
    description: description.length > 0 ? description.join("\n") : undefined,
    throws,
    deps,
    line: method.getStartLineNumber(),
  };

  if (status === "filled") {
    const filledMatch = FILLED_RE.exec(bodyText);
    member.filledBy = filledMatch?.[1] === "ai" ? "ai" : "human";
    if (filledMatch?.[2]) member.filledAt = filledMatch[2];

    const violations = checkContract(method, injected, deps, throws);
    if (violations.length > 0) member.violations = violations;
  }

  return member;
}

/** Sınıftaki tüm işaretli üyeler — işaret yoksa boş dizi. */
export function readSurgicalMembers(cls: ClassDeclaration): SurgicalMember[] {
  const injected = injectedDeps(cls);
  const out: SurgicalMember[] = [];
  for (const method of cls.getMethods()) {
    const marker = readMethodMarker(method, injected);
    if (marker) out.push(marker);
  }
  return out;
}

/* ── özet ────────────────────────────────────────────────────────── */

/** Graf geneli özet — status komutu ve eklenti durum satırı için. */
export interface SurgicalSummary {
  /** İşaretli üye toplamı (skeleton + filled). */
  total: number;
  filled: number;
  skeletons: number;
  /** İmzaya göre AI'ın doldurduğu üye sayısı. */
  filledAi: number;
  /** Sözleşme ihlali taşıyan üye sayısı. */
  violations: number;
}

/* ── gövde yazımı (cerrahi AI) ───────────────────────────────────── */

export interface WriteBodyResult {
  ok: boolean;
  member: string;
  /** Yazımdan sonra yeniden denetlenen sözleşme ihlalleri (varsa). */
  violations?: string[];
  /** Deterministik snap'lerin denetim izi ("user.id -> user.Id"). İhlal DEĞİL —
   *  kaydı engellemez; agent'a bilgi olarak geri verilir (loop içinde öğrenir). */
  corrections?: string[];
  /** Diske yazılan GERÇEK gövde statements'ı (snap SONRASI). Re-inject edildiğinde
   *  de doğru kalsın diye marker/imza bloğu soyulmuş hâl — çağıran bunu saklamalı. */
  body?: string;
  error?: string;
}

/** Gövde metninden (getBodyText) baştaki marker/imza/boş satırları soyup gerçek
 *  statements'ı döndürür — re-inject için saklanacak hâl. */
function bodyStatements(bodyText: string): string {
  const lines = bodyText.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i]!.trim() === "" || lines[i]!.trim().startsWith("//"))) i++;
  return lines.slice(i).join("\n").trim();
}

/** Gövde kodu geçerli bir TS deyim-bloğu mu? Değilse ilk sözdizimi hatasının
 *  mesajını döner (yoksa null). Yalnız SÖZDİZİMİ denetlenir: `await`/`this`
 *  geçerli sayılsın diye async fonksiyona sarılır; tanımsız ad (NotFoundException
 *  vb.) burada hata DEĞİLDİR — onu tip denetimi yakalar. Amaç: LLM'in gövdeye
 *  sızdırdığı prose'u ("So I'll output:") yazımdan önce reddetmek. */
function bodySyntaxError(bodyCode: string): string | null {
  const src = ts.createSourceFile("_probe.ts", `async function _f() {\n${bodyCode}\n}`, ts.ScriptTarget.Latest, false);
  const diags = (src as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diags.length === 0) return null;
  const d = diags[0]!;
  return ts.flattenDiagnosticMessageText(d.messageText, "\n");
}

/** İşaretli bir iskelet metodun gövdesini `bodyCode` ile değiştir.
 *
 *  - Marker yorum bloğunu (`// @solarch:surgical` + açıklama/throws/deps) KORUR.
 *  - Hemen altına `// @solarch:filled by=ai at=<iso>` imzası ekler.
 *  - `throw new Error("NOT_IMPLEMENTED…")` yerine gerçek kodu koyar.
 *  - Yazımdan sonra sözleşmeyi (throws/deps) yeniden denetler.
 *
 *  In-memory çalışır (SourceFile'ı kaydetmez) — çağıran kaydeder. */
export function writeSurgicalBody(
  cls: ClassDeclaration,
  member: string,
  bodyCode: string,
  filledAtIso: string,
): WriteBodyResult {
  const method = cls.getMethods().find((m) => {
    const txt = m.getBody()?.getFullText() ?? "";
    const mk = MARKER_RE.exec(txt);
    return mk ? mk[2] === member : m.getName() === member;
  });
  if (!method) return { ok: false, member, error: `no surgical region "${member}" in ${cls.getName() ?? "class"}` };
  if (!method.getBody()) return { ok: false, member, error: `region "${member}" has no body` };

  // Marker yorum bloğunu çıkar: gövdenin başındaki // satırları (ilk kod satırına kadar).
  const inner = method.getBodyText() ?? "";
  const markerLines: string[] = [];
  for (const raw of inner.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("//")) {
      if (!FILLED_RE.test(l)) markerLines.push(l); // eski filled imzasını düşür (idempotent)
      continue;
    }
    break; // ilk kod satırı (NOT_IMPLEMENTED throw veya önceki dolum) → blok bitti
  }
  if (markerLines.length === 0) return { ok: false, member, error: `region "${member}" has no surgical marker` };

  // LLM bazen gövdeye akıl-yürütme/önyazı sızdırır ("So I'll output:") → geçersiz TS.
  // Gövdeyi YAZMADAN önce sözdizimini doğrula; bozuksa ihlal olarak dön (çağıran retry
  // eder, başarısız deneme stub'ı bozmaz). Yalnız SÖZDİZİMİ — tip çözümü yok (await/this
  // geçerli olsun diye async fonksiyona sarılır; tanımsız adlar burada hata değildir).
  const syntaxErr = bodySyntaxError(bodyCode.trim());
  if (syntaxErr) return { ok: true, member, violations: [`generated body is not valid TypeScript (the model leaked prose — output raw statements only): ${syntaxErr}`] };

  const filledSig = `// @solarch:filled by=ai at=${filledAtIso}`;
  method.setBodyText([...markerLines, filledSig, "", bodyCode.trim()].join("\n"));

  // DETERMİNİSTİK SNAP (IntelliSense): owned-tip üye yakın-kaçırmalarını (user.id →
  // user.Id) checkMemberAccess'TEN ÖNCE gerçek ada çevir. Tek-aday yoksa dokunmaz →
  // checkMemberAccess yine ihlal verir. Snap'ler ihlal değildir; agent'a bilgi döner.
  const corrections = autoCorrectMembers(method);

  const re = readMethodMarker(method, injectedDeps(cls));
  // Sözleşme (deps/throws) + KAPALI-DÜNYA üye denetimi: gövde, ürettiğimiz tiplerin
  // var olmayan üyelerine erişmemeli (halüsinasyon geçidi — gerçek üye listesi döner).
  const violations = [
    ...(re?.violations ?? []),
    ...checkMemberAccess(method),
    ...checkForbiddenCasts(method),
  ];
  return {
    ok: true,
    member,
    body: bodyStatements(method.getBodyText() ?? ""),
    violations: violations.length > 0 ? violations : undefined,
    corrections: corrections.length > 0 ? corrections : undefined,
  };
}

/** Dolan gövdeler yerel tipler (örn. bir entity) kullanıp dosya başına import
 *  EKLEYEMEZ (yalnız gövde yazılır). Bu pas, projenin tamamını yükleyip her dolu
 *  dosyada eksik import'ları TS dil servisiyle ekler (`new Complaint()` → import). */
export function fixMissingImportsInFiles(rootDir: string, relFiles: string[]): { fixed: string[] } {
  const tsconfig = join(rootDir, "tsconfig.json");
  const project = existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig })
    : new Project({ skipAddingFilesFromTsConfig: true });
  if (!existsSync(tsconfig)) {
    try {
      project.addSourceFilesAtPaths(join(rootDir, "src/**/*.ts"));
    } catch {
      return { fixed: [] };
    }
  }
  const srcRoot = resolve(rootDir, "src");
  const fixed: string[] = [];
  for (const rel of relFiles) {
    const sf = project.getSourceFile(resolve(rootDir, rel));
    if (!sf) continue;
    try {
      for (const imp of sf.getImportDeclarations()) {
        const spec = imp.getModuleSpecifierValue();
        // (a) Çözülmeyen GÖRELİ import (yanlış yol, örn. `../../` vs `../`) → kaldır,
        //     fixMissingImports doğrusuyla ekler.
        if (spec.startsWith(".") && !imp.getModuleSpecifierSourceFile()) {
          imp.remove();
          continue;
        }
        // (b) baseUrl-köklü YEREL import (örn. `src/common/...`): tsc çözer ama jest
        //     çözemez ve dosya geri kalanı göreli. Kaldır → relative tercihiyle yeniden eklensin.
        const target = imp.getModuleSpecifierSourceFile();
        if (!spec.startsWith(".") && target && target.getFilePath().startsWith(srcRoot)) {
          imp.remove();
          continue;
        }
        // (c) jest global'leri (describe/it/expect/jest/beforeEach) ASLA import edilmez —
        //     @types/jest onları global verir. fixMissingImports bunları `node:test`'ten
        //     çekmeye meyleder; çekerse jest "0 test" görür + TAP üretir. Bu import'ları sök.
        if (spec === "node:test" || spec === "@jest/globals") {
          imp.remove();
          continue;
        }
      }
      // Yeni import'lar GÖRELİ yolla eklensin (jest ts-jest baseUrl'i onurlandırmaz).
      sf.fixMissingImports(undefined, { importModuleSpecifierPreference: "relative" });
      // fixMissingImports yine node:test çekmiş olabilir → son bir süpürme.
      for (const imp of sf.getImportDeclarations()) {
        const spec = imp.getModuleSpecifierValue();
        if (spec === "node:test" || spec === "@jest/globals") imp.remove();
      }
      fixed.push(rel);
    } catch {
      /* dil servisi çözemezse atla */
    }
  }
  project.saveSync();
  return { fixed };
}

/* ── completeType: IntelliSense üreticisi (lookup_members tool'unun kaynağı) ── */

export interface CompleteTypeResult {
  /** Çözülen tipin türü; owned (src/) değilse 'unknown' — üye SUNULMAZ. */
  kind: "class" | "exception" | "enum" | "unknown";
  /** Class/exception: public alan adları (gerçek üyeler). */
  members?: string[];
  /** Class/exception: public metot imzaları (ad + arity + generic). */
  signatures?: string[];
  /** Enum: üye adı + değeri. */
  enumLiterals?: { name: string; value: string | number | undefined }[];
  /** Class/exception: constructor parametre imzası. */
  ctor?: string;
}

/** Bir owned (src/) tip ADINI verince GERÇEK yüzeyini döndürür: sınıf üyeleri/metot
 *  imzaları, enum literal'leri, exception ctor'u. Tip ÖNCE dosyanın kendisinde,
 *  sonra YEREL import'larında aranır (3. parti/node_modules çözülmez → 'unknown').
 *  checkMemberAccess ile AYNI kapalı-dünya: yalnız sahip olduğumuz tipler sunulur,
 *  böylece agent uydurma değil GERÇEK üyeden seçer. lookup_members tool'u bunu sarar. */
export function completeType(filePath: string, typeName: string): CompleteTypeResult {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  let sf;
  try {
    sf = project.addSourceFileAtPath(filePath);
  } catch {
    return { kind: "unknown" };
  }
  let cls = sf.getClass(typeName);
  let en = sf.getEnum(typeName);
  if (!cls && !en) {
    const fromDir = dirname(filePath);
    for (const imp of sf.getImportDeclarations()) {
      const spec = imp.getModuleSpecifierValue();
      if (!spec.startsWith(".")) continue; // yalnız yerel tipler (owned)
      if (!imp.getNamedImports().some((ni) => ni.getName() === typeName)) continue;
      const resolved = resolveLocalImport(fromDir, spec);
      if (!resolved) continue;
      try {
        const depSf = project.addSourceFileAtPath(resolved);
        cls = depSf.getClass(typeName);
        en = depSf.getEnum(typeName);
      } catch {
        continue;
      }
      if (cls || en) break;
    }
  }
  if (en) {
    return {
      kind: "enum",
      enumLiterals: en.getMembers().map((m) => ({ name: m.getName(), value: m.getValue() })),
    };
  }
  if (cls) {
    const ctor = cls.getConstructors()[0];
    const ctorText = ctor
      ? ctor.getParameters().map((p) => `${p.getName()}: ${cleanType(p.getTypeNode()?.getText() ?? "unknown")}`).join(", ")
      : "";
    const members = cls
      .getProperties()
      .filter((p) => !p.isStatic() && p.getScope() !== "private")
      .map((p) => p.getName());
    const signatures = cls
      .getMethods()
      .filter((m) => m.getScope() !== "private" && m.getScope() !== "protected")
      .map(methodSignature);
    const extendsText = cls.getExtends()?.getText() ?? "";
    const isException = /Exception$/.test(typeName) || /Exception|Error/.test(extendsText);
    return { kind: isException ? "exception" : "class", members, signatures, ctor: ctorText };
  }
  return { kind: "unknown" };
}

/* ── dosya-düzeyi fill köprüsü (ts-morph ast-core'da kapsüllü) ────── */

export interface SurgicalFillContext {
  /** Doldurulacak metodun imzası (gövde hariç, tek satır). */
  signature: string;
  /** Sınıfın constructor'ı — enjekte bağımlılıklar + tipleri. */
  constructorText: string;
  /** Dosyanın import satırları. */
  imports: string;
}

function methodSignatureText(method: MethodDeclaration): string {
  const text = method.getText();
  const brace = text.indexOf("{");
  return text.slice(0, brace === -1 ? text.length : brace).replace(/\s+/g, " ").trim();
}

/** İşaretli bir bölge için prompt bağlamı (imza + constructor + import'lar). */
export function readFillContext(filePath: string, className: string, member: string): SurgicalFillContext | null {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  let sf;
  try {
    sf = project.addSourceFileAtPath(filePath);
  } catch {
    return null;
  }
  const cls = sf.getClass(className);
  const method = cls?.getMethod(member);
  if (!cls || !method) return null;
  return {
    signature: methodSignatureText(method),
    constructorText: cls.getConstructors()[0]?.getText() ?? "",
    imports: sf.getImportDeclarations().map((d) => d.getText()).join("\n"),
  };
}

/* ── bağımlılık-yüzeyi (grounding — halüsinasyonu engeller) ──────── */

function cleanType(t: string): string {
  return t.replace(/import\([^)]*\)\./g, "").replace(/\s+/g, " ").trim();
}

/** Tek public metodun grounding imzası: ad + generic `<T>` + paramlar + dönüş +
 *  Observable/generic ipuçları. describeClass ve completeType TEK KAYNAKtan alsın. */
function methodSignature(m: MethodDeclaration): string {
  // GENERIC type param'ları (`<T>`) İMZADA göster — yoksa AI `get(): Promise<T|null>`'i
  // görüp T'yi gizem sanır, çıplak `get()` çağırır → T={} → tsc TS2740.
  const tps = m.getTypeParameters().map((tp) => tp.getText());
  const generic = tps.length > 0 ? `<${tps.join(", ")}>` : "";
  const params = m.getParameters().map((p) => `${p.getName()}: ${cleanType(p.getTypeNode()?.getText() ?? "unknown")}`).join(", ");
  const ret = cleanType(m.getReturnTypeNode()?.getText() ?? "void");
  // RxJS Observable dönüşü → AI'a unwrap'ı hatırlat (firstValueFrom/lastValueFrom).
  const obs = /\bObservable\s*</.test(ret) ? " [Observable — unwrap with firstValueFrom]" : "";
  // Generic metot: tip argümanı VERİLMELİ (get<Category>()) yoksa T çözülmez.
  const genericHint = generic ? ` [generic — pass a type argument matching what you return, e.g. ${m.getName()}<YourType>(...)]` : "";
  return `${m.getName()}${generic}(${params}): ${ret}${obs}${genericHint}`;
}

/** Bir sınıfın çağrılabilir yüzeyi: constructor arity, public metod imzaları,
 *  public alanlar. AI'ın var olmayan metod/arity uydurmasını engeller. */
function describeClass(cls: ClassDeclaration): string {
  const name = cls.getName() ?? "?";
  const ctor = cls.getConstructors()[0];
  const ctorParams = ctor
    ? ctor.getParameters().map((p) => `${p.getName()}: ${cleanType(p.getTypeNode()?.getText() ?? "unknown")}`).join(", ")
    : "";
  const methods = cls
    .getMethods()
    .filter((m) => m.getScope() !== "private" && m.getScope() !== "protected")
    .map(methodSignature);
  const RELATION_DECOS = new Set(["ManyToOne", "OneToMany", "OneToOne", "ManyToMany"]);
  const fields = cls
    .getProperties()
    .filter((p) => !p.isStatic() && p.getScope() !== "private")
    .map((p) => {
      const pname = p.getName();
      const type = cleanType(p.getTypeNode()?.getText() ?? "unknown");
      const decos = p.getDecorators().map((d) => d.getName());
      const rel = decos.find((d) => RELATION_DECOS.has(d));
      if (rel) {
        // İLİŞKİ: alt-alanlarına relation ÜZERİNDEN erişilir; düz `customerName` UYDURMA.
        // Hedef tipin GERÇEK üyelerini çöz ve LİSTELE (generic `.name` ipucu YANLIŞ
        // olabilir — ör. User'da `name` yok, `fullName` var). AI tam isimleri görür.
        let allowed = "";
        try {
          let tt = p.getType().getNonNullableType();
          if (tt.isArray()) tt = tt.getArrayElementType() ?? tt;
          const members = tt
            .getApparentType()
            .getProperties()
            .map((m) => m.getName())
            .filter((m) => !m.startsWith("__") && !BUILTIN_MEMBERS.has(m));
          if (members.length) allowed = ` — access ONLY these: ${members.join(", ")}`;
        } catch {
          /* çözülemedi → generic etiket */
        }
        return `${pname}: ${type} (relation @${rel} — read via ${pname}.<field>${allowed}; do NOT invent a flat ${pname}Name/${pname}Id)`;
      }
      if (/Id$/.test(pname) && /\bstring\b/.test(type)) return `${pname}: ${type} (fk scalar)`;
      return `${pname}: ${type}`;
    });
  const lines = [`class ${name} { constructor(${ctorParams}) }`];
  if (methods.length) lines.push(`  methods: ${methods.join("; ")}`);
  if (fields.length) lines.push(`  fields: ${fields.join(", ")}`);
  return lines.join("\n");
}

/** Bir enum'un üyeleri + değerleri (state/transition mantığı değer üstünden kurulsun diye). */
function describeEnum(en: EnumDeclaration): string {
  const members = en.getMembers().map((m) => {
    const v = m.getValue();
    return v === undefined ? m.getName() : `${m.getName()} = ${JSON.stringify(v)}`;
  });
  return `enum ${en.getName() ?? "?"} { ${members.join(", ")} }`;
}

function resolveLocalImport(fromDir: string, spec: string): string | null {
  for (const cand of [`${spec}.ts`, join(spec, "index.ts")]) {
    const p = resolve(fromDir, cand);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Dolan dosyanın yerel import'larından çağrılabilir API yüzeyini çıkar:
 *  her import edilen sınıf/enum için imzalar/üyeler. Prompt'a gömülür ki AI
 *  metod/arity/exception-ctor/enum-değeri UYDURMASIN, gerçeğini kullansın. */
export function readDeclaredSurface(filePath: string): string {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  let sf;
  try {
    sf = project.addSourceFileAtPath(filePath);
  } catch {
    return "";
  }
  const fromDir = dirname(filePath);
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!spec.startsWith(".")) continue; // yalnız yerel tipler (3. parti değil)
    const resolved = resolveLocalImport(fromDir, spec);
    if (!resolved) continue;
    let depSf;
    try {
      depSf = project.addSourceFileAtPath(resolved);
    } catch {
      continue;
    }
    for (const named of imp.getNamedImports()) {
      const n = named.getName();
      if (seen.has(n)) continue;
      const cls = depSf.getClass(n);
      const en = depSf.getEnum(n);
      if (cls) {
        blocks.push(describeClass(cls));
        seen.add(n);
      } else if (en) {
        blocks.push(describeEnum(en));
        seen.add(n);
      }
    }
  }
  return blocks.join("\n");
}

/** Dosyayı taze yükle, gövdeyi yaz, sözleşmeyi denetle; YALNIZ ihlal yoksa kaydet.
 *  Her çağrı bağımsızdır — başarısız bir deneme diske yazılmadığından sonraki
 *  denemeyi (taze yüklenen dosyayı) kirletmez. */
export function tryFillSurgicalBody(
  filePath: string,
  className: string,
  member: string,
  bodyCode: string,
  filledAtIso: string,
): WriteBodyResult {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  let sf;
  try {
    sf = project.addSourceFileAtPath(filePath);
  } catch (e) {
    return { ok: false, member, error: `cannot read ${filePath}: ${(e as Error).message}` };
  }
  const cls = sf.getClass(className);
  if (!cls) return { ok: false, member, error: `class ${className} not found in ${filePath}` };
  const res = writeSurgicalBody(cls, member, bodyCode, filledAtIso);
  if (res.ok && (res.violations?.length ?? 0) === 0) sf.saveSync();
  return res;
}

export function summarizeSurgical(members: SurgicalMember[]): SurgicalSummary {
  const filled = members.filter((m) => m.status === "filled");
  return {
    total: members.length,
    filled: filled.length,
    skeletons: members.length - filled.length,
    filledAi: filled.filter((m) => m.filledBy === "ai").length,
    violations: members.filter((m) => (m.violations?.length ?? 0) > 0).length,
  };
}
