/** Güvenli AST yazma — live binding'in çekirdeği.
 *
 *  Kaynak sınıftan (Entity/DTO) property'leri çıkarıp hedef sınıfa enjekte eder.
 *  Sözleşme:
 *  - YALNIZ property bildirimleri eklenir; metodlara/iş mantığına dokunulmaz.
 *  - Eklenen her property `@solarch:bound` marker yorumu taşır — sonraki
 *    senkronlarda "bizim eklediğimiz" ile "kullanıcının yazdığı" ayrılır.
 *  - Hedefte aynı isimli property zaten varsa: tip uyuşuyorsa atlanır,
 *    uyuşmuyorsa ÜZERİNE YAZILMAZ — çatışma raporlanır. */

import { ClassDeclaration, IndentationText, Project, PropertyDeclaration, SourceFile } from "ts-morph";
import { cleanTypeText, unwrapTypeName } from "./extract.js";

export const BOUND_MARKER = "@solarch:bound";

/* ── kaynak property modeli ──────────────────────────────────────── */

export interface SourceProperty {
  name: string;
  /** Hedefe yazılacak TS tipi (Entity kolon tipi → TS karşılığı). */
  tsType: string;
  optional: boolean;
  /** class-validator dekoratörü (hedef DTO ise eklenir): ör. "IsString". */
  validator: string | null;
}

/** TypeORM kolon tipinden TS tipi + class-validator dekoratörü türet. */
function columnToTs(prop: PropertyDeclaration): { tsType: string; validator: string | null } {
  const typeText = cleanTypeText(prop.getTypeNode()?.getText() ?? "string");
  const core = unwrapTypeName(typeText);
  switch (core) {
    case "string":
      return { tsType: "string", validator: "IsString" };
    case "number":
      return { tsType: "number", validator: "IsNumber" };
    case "boolean":
      return { tsType: "boolean", validator: "IsBoolean" };
    case "Date":
      return { tsType: "Date", validator: "IsDate" };
    default:
      // Enum/nested tip — tipi koru, validator'ı bilemeyiz.
      return { tsType: typeText, validator: null };
  }
}

const COLUMN_DECORATORS = new Set([
  "Column", "PrimaryColumn", "PrimaryGeneratedColumn",
  "CreateDateColumn", "UpdateDateColumn", "DeleteDateColumn", "VersionColumn",
]);
const RELATION_DECORATORS = new Set(["ManyToOne", "OneToOne", "OneToMany", "ManyToMany", "JoinColumn"]);

/** Kaynak sınıfın senkronlanabilir property'leri.
 *  Entity'de: kolon dekoratörlü alanlar (ilişkiler hariç).
 *  Düz sınıf/DTO'da: tüm instance property'leri. */
export function readSourceProperties(cls: ClassDeclaration): SourceProperty[] {
  const out: SourceProperty[] = [];
  for (const prop of cls.getProperties()) {
    if (prop.isStatic()) continue;
    const decs = prop.getDecorators().map((d) => d.getName());
    if (decs.some((d) => RELATION_DECORATORS.has(d))) continue; // ilişki alanı DTO'ya kopyalanmaz
    const isColumn = decs.some((d) => COLUMN_DECORATORS.has(d));
    const isEntity = cls.getDecorator("Entity") !== undefined;
    if (isEntity && !isColumn) continue; // entity'de dekoratörsüz alan kolon değildir

    const { tsType, validator } = columnToTs(prop);
    const nullable = prop.hasQuestionToken() ||
      prop.getDecorators().some((d) => {
        const arg = d.getArguments()[0];
        return arg?.getText().includes("nullable: true") ?? false;
      });
    out.push({ name: prop.getName(), tsType, optional: nullable, validator });
  }
  return out;
}

/* ── senkron sonucu ──────────────────────────────────────────────── */

export interface SyncConflict {
  property: string;
  reason: string;
}

export interface SyncResult {
  /** Hedefe yeni eklenen property adları. */
  added: string[];
  /** Tip uyuşmazlığı nedeniyle DOKUNULMAYAN property'ler. */
  conflicts: SyncConflict[];
  /** Zaten senkron (değişiklik gerekmedi). */
  upToDate: string[];
  /** Dosya değişti mi (çağıran save eder). */
  changed: boolean;
}

/** Hedef sınıfta class-validator kullanımı var mı — varsa eklenen property'lere
 *  de validator dekoratörü yazılır (dosyanın mevcut diline uy). */
function targetUsesValidators(target: ClassDeclaration): boolean {
  return target.getProperties().some((p) => p.getDecorators().length > 0);
}

function ensureValidatorImport(file: SourceFile, validator: string): void {
  const existing = file.getImportDeclaration((d) => d.getModuleSpecifierValue() === "class-validator");
  if (!existing) {
    file.addImportDeclaration({ moduleSpecifier: "class-validator", namedImports: [validator] });
    return;
  }
  if (!existing.getNamedImports().some((n) => n.getName() === validator)) {
    existing.addNamedImport(validator);
  }
}

/** Kaynak sınıftaki property'leri hedef sınıfa enjekte et (eksik olanları).
 *  Kullanıcının elle yazdığı üyelere asla dokunulmaz. */
export function syncProperties(
  source: ClassDeclaration,
  target: ClassDeclaration,
  fields: "all" | string[] = "all",
): SyncResult {
  const wanted = readSourceProperties(source).filter(
    (p) => fields === "all" || fields.includes(p.name),
  );
  const sourceName = source.getName() ?? "unknown";
  const useValidators = targetUsesValidators(target);

  const added: string[] = [];
  const conflicts: SyncConflict[] = [];
  const upToDate: string[] = [];

  for (const want of wanted) {
    const existing = target.getProperty(want.name);
    if (existing) {
      const existingType = cleanTypeText(existing.getTypeNode()?.getText() ?? "");
      if (existingType === want.tsType || existingType === "") {
        upToDate.push(want.name);
      } else {
        conflicts.push({
          property: want.name,
          reason: `target has type "${existingType}", source expects "${want.tsType}" — left untouched`,
        });
      }
      continue;
    }

    const prop = target.addProperty({
      name: want.name,
      type: want.tsType,
      hasQuestionToken: want.optional,
    });
    // Marker: bu alanı Solarch ekledi — kaynaktan türedi, elle düzenleme
    // sonraki senkronda çatışma olarak raporlanır.
    prop.addJsDoc(`${BOUND_MARKER} from=${sourceName}`);
    if (useValidators && want.validator) {
      prop.addDecorator({ name: want.validator, arguments: [] });
      if (want.optional) prop.addDecorator({ name: "IsOptional", arguments: [] });
      ensureValidatorImport(target.getSourceFile(), want.validator);
      if (want.optional) ensureValidatorImport(target.getSourceFile(), "IsOptional");
    }
    added.push(want.name);
  }

  return { added, conflicts, upToDate, changed: added.length > 0 };
}

/* ── dosya-seviyesi binding API'si (CLI watch/bind bunu çağırır) ── */

export interface BindingTarget {
  /** "src/x.ts#ClassName" biçimi. */
  filePath: string;
  className: string;
}

export function parseBindingRef(ref: string): BindingTarget {
  const [filePath, className] = ref.split("#");
  if (!filePath || !className) {
    throw new Error(`Invalid binding ref "${ref}" — expected "path/to/file.ts#ClassName".`);
  }
  return { filePath, className };
}

export interface BindingSyncOutcome extends SyncResult {
  sourceClass: string;
  targetClass: string;
  targetFile: string;
}

/** Bir binding'i çalıştır: kaynak dosya → hedef dosya property senkronu.
 *  Değişiklik varsa hedef dosya DISKE YAZILIR. */
export function runBinding(
  rootDir: string,
  sourceRef: string,
  targetRef: string,
  fields: "all" | string[] = "all",
): BindingSyncOutcome {
  const src = parseBindingRef(sourceRef);
  const tgt = parseBindingRef(targetRef);

  const project = new Project({
    compilerOptions: { experimentalDecorators: true },
    manipulationSettings: { indentationText: IndentationText.TwoSpaces },
  });
  const sourceFile = project.addSourceFileAtPath(`${rootDir}/${src.filePath}`);
  const targetFile = project.addSourceFileAtPath(`${rootDir}/${tgt.filePath}`);

  const sourceClass = sourceFile.getClass(src.className);
  const targetClass = targetFile.getClass(tgt.className);
  if (!sourceClass) throw new Error(`Class ${src.className} not found in ${src.filePath}`);
  if (!targetClass) throw new Error(`Class ${tgt.className} not found in ${tgt.filePath}`);

  const result = syncProperties(sourceClass, targetClass, fields);
  if (result.changed) targetFile.saveSync();

  return {
    ...result,
    sourceClass: src.className,
    targetClass: tgt.className,
    targetFile: tgt.filePath,
  };
}

/** Hedefteki Solarch-bound property'leri say — rapor/teşhis için. */
export function countBoundProperties(cls: ClassDeclaration): number {
  return cls.getProperties().filter((p) =>
    p.getJsDocs().some((d) => d.getInnerText().includes(BOUND_MARKER)),
  ).length;
}
