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
import { ClassDeclaration, EnumDeclaration, ImportDeclaration, MethodDeclaration, Node, Project, SourceFile, SyntaxKind, ts, Type } from "ts-morph";

export type SurgicalStatus = "skeleton" | "filled";
export type FilledBy = "ai" | "human" | "codegen";

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

function singleOrNull<T>(arr: T[]): T | null {
  return arr.length === 1 ? arr[0]! : null;
}

/** Bir tipin (contextual) owned (src/) enum BİLDİRİMİNİ döndürür — enum'un kendisi
 *  ya da enum-literal birleşimi (TableStatus.A | TableStatus.B) olabilir. Owned
 *  değilse / enum değilse null. autoCorrectEnumLiterals için. */
function ownedEnumDecl(t: Type): EnumDeclaration | null {
  const fromSym = (sym: ReturnType<Type["getSymbol"]>): EnumDeclaration | null => {
    for (const d of sym?.getDeclarations() ?? []) {
      if (d.getKind() === SyntaxKind.EnumDeclaration) return d as EnumDeclaration;
      if (d.getKind() === SyntaxKind.EnumMember) {
        const e = d.getFirstAncestorByKind(SyntaxKind.EnumDeclaration);
        if (e) return e;
      }
    }
    return null;
  };
  let en = fromSym(t.getSymbol()) ?? fromSym(t.getAliasSymbol());
  if (!en && t.isUnion()) {
    for (const u of t.getUnionTypes()) {
      en = fromSym(u.getSymbol()) ?? fromSym(u.getAliasSymbol());
      if (en) break;
    }
  }
  if (!en) return null;
  if (!/[/\\]src[/\\]/.test(en.getSourceFile().getFilePath())) return null;
  return en;
}

/** ENUM-LITERAL SNAP (snap'in enum hâli). Owned bir enum'a atanan STRING literal'i
 *  gerçek üyeye çevirir: `x.status = "AVAILABLE"` → `x.status = TableStatus.AVAILABLE`
 *  (tsc TS2820). Yalnız beklenen tip (contextual) owned bir enum VE string benzersiz
 *  bir üyeyle (önce AD, sonra DEĞER) eşleşiyorsa; aksi halde DOKUNMAZ. Enum import
 *  edilmemişse repair'in import-fix'i ekler (TableStatus → import). */
function autoCorrectEnumLiterals(method: MethodDeclaration): string[] {
  const body = method.getBody();
  if (!body) return [];
  const pending: { lit: Node; from: string; to: string }[] = [];
  for (const lit of body.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    let ctx;
    try {
      ctx = lit.getContextualType();
    } catch {
      continue;
    }
    if (!ctx) continue;
    const en = ownedEnumDecl(ctx);
    if (!en) continue;
    const value = lit.getLiteralValue();
    const members = en.getMembers();
    const match =
      members.find((m) => m.getName() === value) ??
      singleOrNull(members.filter((m) => m.getName().toLowerCase() === value.toLowerCase())) ??
      members.find((m) => String(m.getValue()) === value);
    if (!match) continue;
    pending.push({ lit, from: lit.getText(), to: `${en.getName()}.${match.getName()}` });
  }
  const fixed: string[] = [];
  for (const p of pending) {
    p.lit.replaceWithText(p.to);
    fixed.push(`${p.from} -> ${p.to}`);
  }
  return fixed;
}

/** YASAK CAST geçidi (forbidden-moves). İki sınıf:
 *
 *  (a) TİP-GİZLEYEN cast `x as any` / `x as unknown` — hem kapalı-dünya üye denetimini
 *      (any/unknown ATLANIR — checkMemberAccess satır ~174) hem tsc'yi kör eder → AI var
 *      olmayan bir alana erişip (audit: `(user as any).password`; User'da `password` yok,
 *      `passwordHash` var) bug'ı GİZLER. Çift-cast `as unknown as T`'nin `as unknown` kısmı
 *      da yakalanır (kaçış kapısı).
 *
 *  (b) OWNED tipe OBJECT-LITERAL cast `{...} as Entity` — AI'ın uydurma entity/DTO inşa
 *      deseni (audit: `{ title, uploader: { id }, ... } as Video`). Cast eksik/uyumsuz
 *      alanları GİZLER ve hata YALNIZ import çözülünce (TS2352) çıkar — fill bunu geç
 *      görür çünkü tip henüz çözülmemişken cast yalnız "Cannot find name" üretir (elenir).
 *      Bunu ilk-dolumda yakalamak için: SAF AST (Project/tip-çözümü gerektirmez → izole
 *      kontrolde ve draft'ta da çalışır). Owned = relative-import edilmiş tip; kütüphane/
 *      global tipler (`{} as Record<...>`) tsc'nin işi, dokunulmaz. */
function checkForbiddenCasts(method: MethodDeclaration): string[] {
  const body = method.getBody();
  if (!body) return [];
  const violations: string[] = [];
  const seen = new Set<string>();

  // Owned (relative-import edilmiş) tip adları — kütüphane/global tiplerden ayırt etmek için.
  const ownedImported = new Set<string>();
  for (const imp of method.getSourceFile().getImportDeclarations()) {
    if (!imp.getModuleSpecifierValue().startsWith(".")) continue; // yalnız relative = owned
    for (const n of imp.getNamedImports()) ownedImported.add(n.getName());
    const def = imp.getDefaultImport();
    if (def) ownedImported.add(def.getText());
  }

  for (const as of body.getDescendantsOfKind(SyntaxKind.AsExpression)) {
    const typeText = (as.getTypeNode()?.getText() ?? "").trim();

    // (a) tip-gizleyen cast: as any / as unknown
    if (/^(any|unknown)\b/.test(typeText)) {
      const snippet = as.getText().replace(/\s+/g, " ").slice(0, 50);
      if (seen.has(snippet)) continue;
      seen.add(snippet);
      violations.push(
        `type-dodging cast "as ${typeText}" is not allowed — it hides real type errors ` +
          `(e.g. reading a field the type does not have). Use the real types from the API surface; if a ` +
          `value genuinely lacks the member you need, that is a contract problem to surface, not cast away.`,
      );
      continue;
    }

    // (b) owned tipe object-literal cast: `{...} as Entity`
    let operand = as.getExpression();
    const paren = operand.asKind(SyntaxKind.ParenthesizedExpression);
    if (paren) operand = paren.getExpression();
    if (!operand.asKind(SyntaxKind.ObjectLiteralExpression)) continue;
    const baseName = typeText.replace(/<[\s\S]*$/, "").replace(/\[\]$/, "").trim();
    if (!ownedImported.has(baseName)) continue; // kütüphane/global tip → tsc'nin işi
    if (seen.has(`objlit:${baseName}`)) continue;
    seen.add(`objlit:${baseName}`);
    violations.push(
      `do not cast an object literal to "${baseName}" ("{...} as ${baseName}"). A cast hides missing or ` +
        `mismatched fields and only fails once the import resolves. Build it properly instead: for a TypeORM ` +
        `entity use the repository — "this.<entity>Repository.create({...})" (it accepts a partial); for a DTO/` +
        `plain object, annotate the target ("const x: ${baseName} = {...}") or return it directly so the real type is checked.`,
    );
  }
  return violations;
}

/** BÖLGE-BAZINDA TİP TEŞHİSLERİ (diagnostics-in-loop — "Problems paneli"). Dolan
 *  metodun gövdesini, tsc'yi EN SONDA topluca koşmak yerine, dil-servisiyle ANINDA
 *  tip-denetler ve YALNIZ bu metodun satır aralığındaki semantik hataları döndürür
 *  (cast/null-safety/yanlış-dönüş/arity — AST geçitlerinin kaçırdığı tip sınıfı).
 *  Dosyanın import'ları dil-servisi tarafından diskten tembel çözülür; kayıt yapılmaz
 *  (in-memory gövde denetlenir). "Cannot find name" ELENİR: o, eksik import'tur ve
 *  fixMissingImportsInFiles kapatır — AI yalnız gövde yazar, import ekleyemez.
 *
 *  Strict-null gibi gerçek-tsc kurallarının yansıması için, çağıran (tryFillSurgicalBody)
 *  Project'i projenin tsconfig DERLEYİCİ SEÇENEKLERİYLE kurmalı; aksi halde gevşek
 *  varsayılanlar null-safety'yi kaçırır. */
export function methodTypeDiagnostics(method: MethodDeclaration): string[] {
  const sf = method.getSourceFile();
  const start = method.getStartLineNumber();
  const end = method.getEndLineNumber();
  let diags: readonly ts.Diagnostic[];
  try {
    diags = sf.getProject().getLanguageService().compilerObject.getSemanticDiagnostics(sf.getFilePath());
  } catch {
    return []; // dil-servisi çözemezse güvenli atla (tsc son geçit yine koşar)
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of diags) {
    if (d.start == null || !d.file) continue;
    const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
    if (/Cannot find name/.test(msg)) continue; // eksik import → import-fix'in işi
    const line = d.file.getLineAndCharacterOfPosition(d.start).line + 1;
    if (line < start || line > end) continue; // yalnız bu metodun aralığı
    const key = `${d.code}:${msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`type error (TS${d.code}): ${msg}`);
  }
  return out;
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
    const by = filledMatch?.[1];
    // codegen: Constructor'ın deterministik olarak tam ürettiği bölge (ör. queue producer)
    // — "AI ya da insan doldurdu" değil "sistem üretti". UI dolu (yeşil) gösterir; fill atlar.
    member.filledBy = by === "ai" ? "ai" : by === "codegen" ? "codegen" : "human";
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
  checkTypes = false,
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
  // user.Id) + owned-enum'a atanan string literal'leri ("AVAILABLE" → TableStatus.
  // AVAILABLE) checkMemberAccess'TEN ÖNCE gerçek kimliğe çevir. Tek-aday yoksa dokunmaz.
  // Snap'ler ihlal değildir; agent'a bilgi döner.
  const corrections = [...autoCorrectMembers(method), ...autoCorrectEnumLiterals(method)];

  const re = readMethodMarker(method, injectedDeps(cls));
  // Sözleşme (deps/throws) + KAPALI-DÜNYA üye denetimi: gövde, ürettiğimiz tiplerin
  // var olmayan üyelerine erişmemeli (halüsinasyon geçidi — gerçek üye listesi döner).
  const violations = [
    ...(re?.violations ?? []),
    ...checkMemberAccess(method),
    ...checkForbiddenCasts(method),
  ];
  // DIAGNOSTICS-IN-LOOP: AST geçitleri temizse, dil-servisiyle bölge-bazında tip-denetle
  // (cast/null-safety/yanlış-dönüş/arity). Hatayı tsc'nin EN SONDAKİ topluca turuna
  // bırakmak yerine, model kendi bölgesini tam bağlamla GÖRDÜĞÜ döngüde düzeltsin. AST
  // ihlali varken koşmaz (çift-raporlama/kaskad gürültüsü olmasın — önce onları düzelt).
  if (checkTypes && violations.length === 0) {
    const typeDiags = methodTypeDiagnostics(method);
    violations.push(...typeDiags);
    // REAKTİF GROUNDING: tip hatası varsa, etkileşilen owned tiplerin GERÇEK şekillerini
    // (tip + nullability) ekle → AI tahmin etmesin, SoT'a göre köprülesin (nullable→required).
    if (typeDiags.length > 0) {
      const shapes = ownedTypeShapesInMethod(method);
      if (shapes.length > 0) {
        violations.push(
          "AUTHORITATIVE TYPES (Source of Truth — conform exactly; if a source field is optional/nullable " +
            "and the target is required, bridge it explicitly with a default or throw): " + shapes.join(" | "),
        );
      }
    }
  }
  return {
    ok: true,
    member,
    body: bodyStatements(method.getBodyText() ?? ""),
    violations: violations.length > 0 ? violations : undefined,
    corrections: corrections.length > 0 ? corrections : undefined,
  };
}

/** Projedeki owned (src/) sınıf adı → bildirim dosyası haritası. İsim çakışmasında
 *  (owned `Like` vs typeorm `Like` operatörü) owned'ı tercih etmek için. fixMissingImports
 *  pas'ı ve DiagnosticsPool ortak kullanır. */
export function buildOwnedClassMap(project: Project): Map<string, SourceFile> {
  const map = new Map<string, SourceFile>();
  for (const osf of project.getSourceFiles()) {
    if (!/[/\\]src[/\\]/.test(osf.getFilePath())) continue;
    for (const c of osf.getClasses()) {
      const n = c.getName();
      if (n && !map.has(n)) map.set(n, osf);
    }
  }
  return map;
}

/** TEK bir SourceFile'da eksik import'ları düzelt — IN-MEMORY (KAYDETMEZ). Çağıran
 *  (disk pas'ı ya da DiagnosticsPool) ister kaydeder → aynı mantık hem soğuk-disk hem
 *  sıcak-program yolunda tek kaynaktan. */
export function fixImportsInSourceFile(
  sf: SourceFile,
  ownedClassByName: Map<string, SourceFile>,
  srcRoot: string,
): void {
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    // (a) Çözülmeyen GÖRELİ import (yanlış yol) → kaldır, fixMissingImports doğrusuyla ekler.
    if (spec.startsWith(".") && !imp.getModuleSpecifierSourceFile()) {
      imp.remove();
      continue;
    }
    // (b) baseUrl-köklü YEREL import: tsc çözer ama jest çözemez → relative tercihiyle yeniden.
    const target = imp.getModuleSpecifierSourceFile();
    if (!spec.startsWith(".") && target && target.getFilePath().startsWith(srcRoot)) {
      imp.remove();
      continue;
    }
    // (c) jest global'leri ASLA import edilmez (@types/jest global verir).
    if (spec === "node:test" || spec === "@jest/globals") {
      imp.remove();
      continue;
    }
  }
  // İSİM ÇAKIŞMASI: `new X()` hedefi owned bir sınıfsa, owned kaynağı node_modules'a TERCİH et.
  const newedNames = new Set<string>();
  for (const ne of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const callee = ne.getExpression();
    if (callee.getKind() === SyntaxKind.Identifier) newedNames.add(callee.getText());
  }
  for (const name of newedNames) {
    const ownerSf = ownedClassByName.get(name);
    if (!ownerSf || ownerSf === sf) continue;
    let hasOwnedRel = false;
    for (const imp of sf.getImportDeclarations()) {
      const ni = imp.getNamedImports().find((n) => n.getName() === name);
      if (!ni) continue;
      const spec = imp.getModuleSpecifierValue();
      if (spec.startsWith(".") && imp.getModuleSpecifierSourceFile() === ownerSf) {
        hasOwnedRel = true;
        continue;
      }
      if (!spec.startsWith(".")) {
        if (imp.getNamedImports().length === 1 && !imp.getDefaultImport() && !imp.getNamespaceImport()) imp.remove();
        else ni.remove();
      }
    }
    if (!hasOwnedRel) {
      sf.addImportDeclaration({ moduleSpecifier: sf.getRelativePathAsModuleSpecifierTo(ownerSf), namedImports: [name] });
    }
  }
  sf.fixMissingImports(undefined, { importModuleSpecifierPreference: "relative" });
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (spec === "node:test" || spec === "@jest/globals") imp.remove();
  }
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
  const ownedClassByName = buildOwnedClassMap(project);
  const fixed: string[] = [];
  for (const rel of relFiles) {
    const sf = project.getSourceFile(resolve(rootDir, rel));
    if (!sf) continue;
    try {
      fixImportsInSourceFile(sf, ownedClassByName, srcRoot);
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
  /** Class/exception: public alanlar TİP + NULLABILITY ile (videoUrl: string,
   *  description?: string | undefined). nullable kaynağı zorunlu hedefe köprülerken
   *  AI'ın kesin nullability'yi görmesi için — isim-yalnız `members` yetmez. */
  fields?: { name: string; type: string; optional: boolean }[];
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
  return completeTypeFromSf(sf, typeName);
}

/** Bir CompleteTypeResult'ı TEK SATIR insan/agent-okunur şekle çevirir — hem lookup_members
 *  tool çıktısı hem reaktif tip-hata feedback'i AYNI biçimi kullansın diye. Alanlar tip +
 *  nullability ile: "VideoDto { id: string; videoUrl: string; description?: string }". */
export function formatTypeShape(name: string, r: CompleteTypeResult): string {
  if (r.kind === "unknown") return `${name}: not an owned type (its shape is out of scope — do not guess its members)`;
  if (r.kind === "enum") return `enum ${name} { ${(r.enumLiterals ?? []).map((l) => l.name).join(", ")} }`;
  const fieldStr = (r.fields ?? []).map((f) => `${f.name}${f.optional ? "?" : ""}: ${f.type}`).join("; ");
  const methodStr = (r.signatures ?? []).join("; ");
  const ctorStr = r.ctor ? `constructor(${r.ctor})` : "";
  const body = [fieldStr, methodStr, ctorStr].filter(Boolean).join("  ");
  return `${r.kind === "exception" ? "exception " : ""}${name} { ${body} }`;
}

/** completeType çekirdeği — verilen SourceFile (taze ya da SICAK havuz programı)
 *  üstünden tipi çözer. DiagnosticsPool.completeType bunu warm programla çağırır. */
export function completeTypeFromSf(sf: SourceFile, typeName: string): CompleteTypeResult {
  let cls = sf.getClass(typeName);
  let en = sf.getEnum(typeName);
  if (!cls && !en) {
    for (const imp of sf.getImportDeclarations()) {
      if (!imp.getModuleSpecifierValue().startsWith(".")) continue; // yalnız yerel (owned)
      if (!imp.getNamedImports().some((ni) => ni.getName() === typeName)) continue;
      const depSf = resolveImportedSf(imp, sf.getProject());
      if (!depSf) continue;
      cls = depSf.getClass(typeName);
      en = depSf.getEnum(typeName);
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
    const publicProps = cls.getProperties().filter((p) => !p.isStatic() && p.getScope() !== "private");
    const members = publicProps.map((p) => p.getName());
    // Alan TİP + nullability: optional = `?` (varsayılan nullable kolon) VEYA tip undefined içerir.
    // Tip metni önce DECLARED annotation (cleanType), yoksa çözülmüş tip. AI bunu okuyup
    // nullable kaynağı (description?: string) zorunlu hedefe (videoUrl: string) köprüler.
    const fields = publicProps.map((p) => {
      const declared = p.getTypeNode()?.getText();
      const type = cleanType(declared ?? p.getType().getText(p));
      const optional = p.hasQuestionToken() || /\b(undefined|null)\b/.test(type);
      return { name: p.getName(), type, optional };
    });
    const signatures = cls
      .getMethods()
      .filter((m) => m.getScope() !== "private" && m.getScope() !== "protected")
      .map(methodSignature);
    const extendsText = cls.getExtends()?.getText() ?? "";
    const isException = /Exception$/.test(typeName) || /Exception|Error/.test(extendsText);
    return { kind: isException ? "exception" : "class", members, fields, signatures, ctor: ctorText };
  }
  return { kind: "unknown" };
}

/** node_modules/global jenerik kapsayıcıları — owned tip olarak sunulmaz (zaten
 *  completeTypeFromSf 'unknown' der, ama erken eleyip gereksiz çözümü atlarız). */
const GENERIC_BUILTINS = new Set([
  "Promise", "Array", "ReadonlyArray", "Map", "Set", "Record", "Partial", "Pick", "Omit",
  "Date", "Object", "Function", "Observable", "Buffer",
]);

/** REAKTİF GROUNDING: bir metodun ETKİLEŞTİĞİ owned tiplerin GERÇEK şekillerini
 *  (formatTypeShape, tip + nullability ile) toplar — dönüş tipi + yerel değişken tipleri +
 *  parametre tipleri (Promise/Array/union AÇILMIŞ). Tip hatası çıkınca retry feedback'ine
 *  eklenir → AI hem hedef DTO (videoUrl: string, zorunlu) hem kaynak entity (videoUrl?:
 *  string, nullable) yüzeyini görüp köprüyü (default ya da throw) doğru yazar. Tip çözümü
 *  gerektirir (çağıran Project'i tsconfig'le kurmalı); çözülemezse boş döner. */
export function ownedTypeShapesInMethod(method: MethodDeclaration): string[] {
  const sf = method.getSourceFile();
  const names = new Set<string>();
  const collect = (t: Type, depth = 0): void => {
    if (depth > 4) return;
    for (const sub of t.isUnion() ? t.getUnionTypes() : [t]) {
      const x = sub.getNonNullableType();
      if (x.isArray()) {
        const el = x.getArrayElementType();
        if (el) collect(el, depth + 1);
        continue;
      }
      for (const a of x.getTypeArguments()) collect(a, depth + 1); // Promise<T>, Map<K,V>…
      const nm = (x.getSymbol() ?? x.getAliasSymbol())?.getName();
      if (nm && /^[A-Z]/.test(nm) && !GENERIC_BUILTINS.has(nm)) names.add(nm);
    }
  };
  try {
    collect(method.getReturnType());
    for (const v of method.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) collect(v.getType());
    for (const p of method.getParameters()) collect(p.getType());
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of [...names].sort()) {
    const r = completeTypeFromSf(sf, n);
    if (r.kind !== "unknown") out.push(formatTypeShape(n, r));
  }
  return out;
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
  return fillContextFromSf(sf, className, member);
}

/** readFillContext çekirdeği — verilen SourceFile üstünden (taze ya da SICAK havuz). */
export function fillContextFromSf(sf: SourceFile, className: string, member: string): SurgicalFillContext | null {
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

/** Bir import'u hedef SourceFile'ına çöz — HEM sıcak program (hepsi yüklü → doğrudan)
 *  HEM taze proje (yalnız bir dosya → diskten lazy ekle) için. Grounding fonksiyonları
 *  böylece DiagnosticsPool'un warm programından da, disk pas'ının taze projesinden de
 *  beslenir (tek kaynak). */
function resolveImportedSf(imp: ImportDeclaration, project: Project): SourceFile | null {
  const direct = imp.getModuleSpecifierSourceFile();
  if (direct) return direct; // sıcak: zaten yüklü
  const resolved = resolveLocalImport(dirname(imp.getSourceFile().getFilePath()), imp.getModuleSpecifierValue());
  if (!resolved) return null;
  try {
    return project.addSourceFileAtPath(resolved); // taze: diskten ekle
  } catch {
    return null;
  }
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
  return declaredSurfaceFromSf(sf);
}

/** readDeclaredSurface çekirdeği — verilen SourceFile üstünden (taze ya da SICAK havuz). */
export function declaredSurfaceFromSf(sf: SourceFile): string {
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const imp of sf.getImportDeclarations()) {
    if (!imp.getModuleSpecifierValue().startsWith(".")) continue; // yalnız yerel tipler
    const depSf = resolveImportedSf(imp, sf.getProject());
    if (!depSf) continue;
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

/** ChatLSP "headers" (beklenen-tip grounding). Doldurulacak metodun ÜRETMESİ
 *  (dönüş tipi) ve TÜKETMESİ (parametreler) gereken owned tiplerin GERÇEK yüzeyini
 *  döndürür — Promise/Observable/Array sarmalı açılır, BİR sıçrama transitif (dönüş
 *  DTO'sunun alanlarındaki owned tipler de). readDeclaredSurface yalnız dosyanın
 *  import'larını verir; bu, "AuthResponseDto döndürmeliyim ama şekli ne?" boşluğunu
 *  kapatır → model serbest-tahmin yerine gerçek alan adlarını görür (ChatLSP'nin en
 *  yüksek-etkili sinyali: tip-header'ları test başarısını ~3x katlıyor). */
export function readExpectedTypeHeaders(filePath: string, className: string, member: string): string {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  let sf;
  try {
    sf = project.addSourceFileAtPath(filePath);
  } catch {
    return "";
  }
  return expectedTypeHeadersFromSf(sf, className, member);
}

/** readExpectedTypeHeaders çekirdeği — verilen SourceFile üstünden (taze ya da SICAK havuz). */
export function expectedTypeHeadersFromSf(sf: SourceFile, className: string, member: string): string {
  const method = sf.getClass(className)?.getMethod(member);
  if (!method) return "";
  const blocks: string[] = [];
  const seen = new Set<string>();

  const describeOwned = (t: Type, depth: number): void => {
    if (depth > 1) return; // yalnız bir sıçrama transitif (gürültü/sonsuz döngü guard'ı)
    let core = t.getNonNullableType();
    if (core.isArray()) core = core.getArrayElementType() ?? core;
    // Promise<T> / Observable<T> sarmalını aç → asıl payload tipi.
    const symName = core.getSymbol()?.getName();
    const targs = core.getTypeArguments();
    if ((symName === "Promise" || symName === "Observable") && targs.length === 1) {
      describeOwned(targs[0]!, depth);
      return;
    }
    // Owned bildirimi ÖNCE çöz: bir enum, TS'de literal-union olarak temsil edilir
    // (isUnion()=true) ama getSymbol() yine enum'a işaret eder — bu yüzden union/any
    // guard'larından ÖNCE bakılır, yoksa enum parametreler elenir. Owned class/enum
    // değilse (gerçek union / any / primitive / node_modules) sessizce atlanır.
    const sym = core.getSymbol() ?? core.getAliasSymbol();
    const ownDecl = (sym?.getDeclarations() ?? []).find((d) => /[/\\]src[/\\]/.test(d.getSourceFile().getFilePath()));
    if (!ownDecl) return;
    const name = sym!.getName();
    if (seen.has(name)) return;
    seen.add(name);
    if (ownDecl.getKind() === SyntaxKind.ClassDeclaration) {
      const cls = ownDecl as ClassDeclaration;
      blocks.push(describeClass(cls));
      for (const p of cls.getProperties()) {
        try {
          describeOwned(p.getType(), depth + 1); // transitif: alan tiplerini de aç
        } catch {
          /* çözülemedi → atla */
        }
      }
    } else if (ownDecl.getKind() === SyntaxKind.EnumDeclaration) {
      blocks.push(describeEnum(ownDecl as EnumDeclaration));
    }
    // Diğer (TypeParameter, Interface, TypeAlias) → describe edilmez; tsc'nin işi.
  };

  try {
    describeOwned(method.getReturnType(), 0);
  } catch {
    /* atla */
  }
  for (const p of method.getParameters()) {
    try {
      describeOwned(p.getType(), 0);
    } catch {
      /* atla */
    }
  }
  return blocks.join("\n");
}

/** Aider-tarzı repo-map (tüm-codebase farkındalığı). Projedeki TÜM owned (src/)
 *  tiplerin SIKIŞIK kataloğu: sınıflar, enum'lar (üyeleriyle), exception'lar. Model
 *  yalnız dosyanın import'larına değil, kod tabanının tamamına haberdar olur → ihtiyaç
 *  duyduğu bir tipi `lookup_members` ile çekebilir. BİR KEZ kurulur (fillProject),
 *  tüm bölgelere paylaşılır (per-bölge tüm src'yi yeniden yükleme maliyeti yok). */
export function readProjectCatalog(rootDir: string): string {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  try {
    project.addSourceFilesAtPaths(join(rootDir, "src/**/*.ts"));
  } catch {
    return "";
  }
  const classes = new Set<string>();
  const enums = new Set<string>();
  const exceptions = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    if (/\.(spec|test)\.ts$/.test(sf.getFilePath())) continue;
    for (const cls of sf.getClasses()) {
      const n = cls.getName();
      if (!n) continue;
      const ext = cls.getExtends()?.getText() ?? "";
      if (/Exception$/.test(n) || /Exception|Error/.test(ext)) exceptions.add(n);
      else classes.add(n);
    }
    for (const en of sf.getEnums()) {
      const n = en.getName();
      if (n) enums.add(`${n}(${en.getMembers().map((m) => m.getName()).join("|")})`);
    }
  }
  const parts: string[] = [];
  if (classes.size) parts.push(`classes: ${[...classes].sort().join(", ")}`);
  if (enums.size) parts.push(`enums: ${[...enums].sort().join(", ")}`);
  if (exceptions.size) parts.push(`exceptions: ${[...exceptions].sort().join(", ")}`);
  return parts.join("\n");
}

/** Dosyayı taze yükle, gövdeyi yaz, sözleşmeyi denetle; YALNIZ ihlal yoksa kaydet.
 *  Her çağrı bağımsızdır — başarısız bir deneme diske yazılmadığından sonraki
 *  denemeyi (taze yüklenen dosyayı) kirletmez. */
export interface TryFillOptions {
  /** Proje kökü — checkTypes için tsconfig DERLEYİCİ SEÇENEKLERİNİ (strict vb.) yükler
   *  ki bölge-bazında teşhisler gerçek tsc ile aynı olsun (null-safety kaçmasın). */
  rootDir?: string;
  /** Bölge-bazında tip teşhisleri AÇ (diagnostics-in-loop). AST temizse dil-servisiyle
   *  cast/null/yanlış-dönüş/arity denetle; hata varsa kaydetme → model döngüde düzeltir. */
  checkTypes?: boolean;
}

export function tryFillSurgicalBody(
  filePath: string,
  className: string,
  member: string,
  bodyCode: string,
  filledAtIso: string,
  opts?: TryFillOptions,
): WriteBodyResult {
  // checkTypes: Project'i projenin tsconfig DERLEYİCİ SEÇENEKLERİYLE kur (skipAdding…
  // → tüm dosyaları yüklemeden; import'lar tembel çözülür) ki teşhisler strict olsun.
  const tsconfig = opts?.rootDir ? join(opts.rootDir, "tsconfig.json") : null;
  const project =
    opts?.checkTypes && tsconfig && existsSync(tsconfig)
      ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true })
      : new Project({ skipAddingFilesFromTsConfig: true });
  let sf;
  try {
    sf = project.addSourceFileAtPath(filePath);
  } catch (e) {
    return { ok: false, member, error: `cannot read ${filePath}: ${(e as Error).message}` };
  }
  const cls = sf.getClass(className);
  if (!cls) return { ok: false, member, error: `class ${className} not found in ${filePath}` };
  const res = writeSurgicalBody(cls, member, bodyCode, filledAtIso, opts?.checkTypes ?? false);
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
