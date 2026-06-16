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
import { ClassDeclaration, EnumDeclaration, MethodDeclaration, Project, SyntaxKind } from "ts-morph";

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
    const allowed = new Set(declaredDeps.map((d) => canon(d.replace(/^this\./, ""))));
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
  error?: string;
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

  const filledSig = `// @solarch:filled by=ai at=${filledAtIso}`;
  method.setBodyText([...markerLines, filledSig, "", bodyCode.trim()].join("\n"));

  const re = readMethodMarker(method, injectedDeps(cls));
  return { ok: true, member, violations: re?.violations };
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
  const fixed: string[] = [];
  for (const rel of relFiles) {
    const sf = project.getSourceFile(resolve(rootDir, rel));
    if (!sf) continue;
    try {
      // Çözülmeyen GÖRELİ import'ları (yanlış yol — örn. `../../` yerine `../`) kaldır;
      // ardından fixMissingImports doğru yolla yeniden ekler. Üçüncü-parti (./'sız) kalır.
      for (const imp of sf.getImportDeclarations()) {
        const spec = imp.getModuleSpecifierValue();
        if (spec.startsWith(".") && !imp.getModuleSpecifierSourceFile()) imp.remove();
      }
      sf.fixMissingImports();
      fixed.push(rel);
    } catch {
      /* dil servisi çözemezse atla */
    }
  }
  project.saveSync();
  return { fixed };
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
    .map((m) => {
      const params = m.getParameters().map((p) => `${p.getName()}: ${cleanType(p.getTypeNode()?.getText() ?? "unknown")}`).join(", ");
      return `${m.getName()}(${params}): ${cleanType(m.getReturnTypeNode()?.getText() ?? "void")}`;
    });
  const fields = cls
    .getProperties()
    .filter((p) => !p.isStatic() && p.getScope() !== "private")
    .map((p) => `${p.getName()}: ${cleanType(p.getTypeNode()?.getText() ?? "unknown")}`);
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
