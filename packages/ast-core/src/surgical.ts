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

import { ClassDeclaration, MethodDeclaration, SyntaxKind } from "ts-morph";

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
