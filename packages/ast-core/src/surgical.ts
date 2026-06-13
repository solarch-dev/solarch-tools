/** Surgical marker okuyucu — codegen'in bıraktığı işaretli bölgeleri çıkarır.
 *
 *  Backend'in scaffold üreticisi (solarch-backend/src/codegen/surgical.ts)
 *  her metot gövdesine makinece ayrıştırılabilir bir işaret bırakır:
 *
 *    // @solarch:surgical id=<nodeId>#<member>
 *    // <iş açıklaması>                        (opsiyonel, çok satır olabilir)
 *    // throws: ExceptionA, ExceptionB         (opsiyonel)
 *    // deps: dep1, dep2                       (opsiyonel)
 *    throw new Error("NOT_IMPLEMENTED: Class.member");
 *
 *  Bu modül o işaretleri OKUR ve durumlarını sınıflandırır:
 *  - skeleton : işaret var, gövde hâlâ NOT_IMPLEMENTED fırlatıyor (doldurulmadı)
 *  - filled   : işaret var ama gövde gerçek koda dönüşmüş
 *
 *  İşaretin içindeki id, cloud node'unun KALICI UUID'sidir — isimden bağımsız,
 *  kesin bir kod ↔ diyagram bağı sağlar. */

import { ClassDeclaration, MethodDeclaration } from "ts-morph";

export type SurgicalStatus = "skeleton" | "filled";

export interface SurgicalMember {
  /** Metot/üye adı (işaretten; yoksa bildirimden). */
  member: string;
  /** İşaretteki cloud node UUID'si. */
  nodeId: string;
  status: SurgicalStatus;
  /** İş açıklaması — cerrahi AI'ın doldururken kullanacağı talimat. */
  description?: string;
  /** Fırlatması beklenen Exception node Name'leri. */
  throws?: string[];
  /** Erişebileceği bağımlılıklar (DI alanları / repo / servis Name'leri). */
  deps?: string[];
  /** Metodun dosyadaki başlangıç satırı (1-tabanlı). */
  line: number;
}

const MARKER_RE = /@solarch:surgical\s+id=([^\s#]+)#(\S+)/;
const NOT_IMPLEMENTED_RE = /throw\s+new\s+Error\(\s*["'`]NOT_IMPLEMENTED:/;

/** Tek metodun gövdesinden işaret çıkar — işaret yoksa null. */
function readMethodMarker(method: MethodDeclaration): SurgicalMember | null {
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
    } else if (text.length > 0) {
      description.push(text);
    }
  }

  return {
    member: markedMember ?? method.getName(),
    nodeId: nodeId ?? "",
    status: NOT_IMPLEMENTED_RE.test(bodyText) ? "skeleton" : "filled",
    description: description.length > 0 ? description.join("\n") : undefined,
    throws,
    deps,
    line: method.getStartLineNumber(),
  };
}

/** Sınıftaki tüm işaretli üyeler — işaret yoksa boş dizi. */
export function readSurgicalMembers(cls: ClassDeclaration): SurgicalMember[] {
  const out: SurgicalMember[] = [];
  for (const method of cls.getMethods()) {
    const marker = readMethodMarker(method);
    if (marker) out.push(marker);
  }
  return out;
}

/** Graf geneli özet — status komutu ve eklenti durum satırı için. */
export interface SurgicalSummary {
  /** İşaretli üye toplamı (skeleton + filled). */
  total: number;
  filled: number;
  skeletons: number;
}

export function summarizeSurgical(members: SurgicalMember[]): SurgicalSummary {
  const filled = members.filter((m) => m.status === "filled").length;
  return { total: members.length, filled, skeletons: members.length - filled };
}
