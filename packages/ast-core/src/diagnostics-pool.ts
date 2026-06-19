/** DiagnosticsPool — TEK SICAK PROGRAM = hata havuzu (IDE'nin "Problems paneli" modeli).
 *
 *  Repair fazı eskiden tip bilgisini SOĞUKTAN, defalarca hesaplıyordu: her turda `tsc`
 *  spawn'ı (tüm proje + node_modules baştan), her turda fixMissingImports tam yükleme,
 *  her paralel düzeltme kendi ts-morph projesi. = CPU spike.
 *
 *  Bu sınıf projeyi BİR KEZ yükler (warm program) ve onu tek kaynak yapar:
 *   - problems()         → programdaki TÜM semantik teşhisler (havuz), bölgeye etiketli
 *   - problemsByRegion() → düzeltilebilir surgical bölgelere düşen sorunlar
 *   - applyBody()        → gövdeyi BELLEKTE uygula + bölge-bazında doğrula (warm LS)
 *   - fixImports()       → eksik import düzelt (warm program, reload yok)
 *   - save()             → kirli dosyaları diske yaz (yalnız değişenler)
 *
 *  Bir düzenlemeden sonra yeniden okuma ARTIMSAL: TS dil-servisi programı yeniden
 *  kullanır, yalnız değişen dosya + bağımlıları yeniden bağlanır (cold tsc değil). */

import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ClassDeclaration, MethodDeclaration, Project, SourceFile, ts } from "ts-morph";
import {
  buildOwnedClassMap,
  completeTypeFromSf,
  declaredSurfaceFromSf,
  expectedTypeHeadersFromSf,
  fillContextFromSf,
  fixImportsInSourceFile,
  writeSurgicalBody,
  type CompleteTypeResult,
  type SurgicalFillContext,
  type WriteBodyResult,
} from "./surgical.js";

const MARKER_RE = /@solarch:surgical\s+id=([^\s#]+)#(\S+)/;

export interface PooledProblem {
  /** Proje köküne göreli dosya. */
  file: string;
  /** Sorunun düştüğü surgical bölgenin sınıfı/üyesi (varsa; yoksa bölge-dışı). */
  className?: string;
  member?: string;
  line: number;
  code: number;
  message: string;
}

export interface RegionProblems {
  file: string;
  className: string;
  member: string;
  problems: PooledProblem[];
}

export class DiagnosticsPool {
  private project: Project;
  private rootDir: string;
  private srcRoot: string;
  private owned: Map<string, SourceFile>;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.srcRoot = resolve(rootDir, "src");
    const tsconfig = join(rootDir, "tsconfig.json");
    this.project = existsSync(tsconfig)
      ? new Project({ tsConfigFilePath: tsconfig })
      : new Project({ compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } });
    if (!existsSync(tsconfig)) {
      try {
        this.project.addSourceFilesAtPaths(join(this.srcRoot, "**/*.ts"));
      } catch {
        /* boş proje */
      }
    }
    this.owned = buildOwnedClassMap(this.project);
  }

  /** HAVUZ: programdaki TÜM semantik teşhisler, düştükleri surgical bölgeye etiketli.
   *  "Cannot find name" ELENİR (eksik import = fixImports'un işi). İlk çağrı programı
   *  tam bağlar; sonraki çağrılar (düzenleme sonrası) ARTIMSAL. */
  problems(): PooledProblem[] {
    const ls = this.project.getLanguageService().compilerObject;
    const out: PooledProblem[] = [];
    for (const sf of this.project.getSourceFiles()) {
      const fp = sf.getFilePath();
      if (!fp.startsWith(this.srcRoot)) continue;
      if (/[/\\]node_modules[/\\]/.test(fp) || /\.(spec|test)\.ts$/.test(fp)) continue;
      let diags: readonly ts.Diagnostic[];
      try {
        diags = ls.getSemanticDiagnostics(fp);
      } catch {
        continue;
      }
      for (const d of diags) {
        if (d.start == null || !d.file) continue;
        const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
        if (/Cannot find name/.test(message)) continue; // import-fixer'ın işi
        const line = d.file.getLineAndCharacterOfPosition(d.start).line + 1;
        const reg = this.regionAt(sf, line);
        out.push({ file: relative(this.rootDir, fp), className: reg?.className, member: reg?.member, line, code: d.code, message });
      }
    }
    return out;
  }

  /** Bir SURGICAL bölgeye düşen sorunlar (fill düzeltebilir). Bölge-dışı sorunlar (entity
   *  codegen bug'ı gibi) dışlanır — fill'in işi değil; final tsc raporlar. */
  problemsByRegion(): RegionProblems[] {
    const byKey = new Map<string, RegionProblems>();
    for (const p of this.problems()) {
      if (!p.member || !p.className) continue;
      const k = `${p.file}#${p.member}`;
      let r = byKey.get(k);
      if (!r) {
        r = { file: p.file, className: p.className, member: p.member, problems: [] };
        byKey.set(k, r);
      }
      r.problems.push(p);
    }
    return [...byKey.values()];
  }

  /** Bölge-DIŞI (surgical olmayan) sorunlar — yalnız rapor (entity/DTO codegen tarafı). */
  nonRegionProblems(): PooledProblem[] {
    return this.problems().filter((p) => !p.member);
  }

  /** Gövdeyi sıcak programa BELLEKTE uygula + bölge-bazında doğrula (warm LS, artımsal).
   *  Temizse commit (programda kalır); ihlal/tip-hatası varsa ÖNCEKİ gövdeye GERİ AL
   *  (program yalnız temiz commit tutar) ama teşhisleri döndür → ajan retry'da görür. */
  applyBody(file: string, className: string, member: string, body: string, iso: string): WriteBodyResult {
    const sf = this.project.getSourceFile(resolve(this.rootDir, file));
    if (!sf) return { ok: false, member, error: `pool: ${file} not loaded` };
    const cls = sf.getClass(className);
    if (!cls) return { ok: false, member, error: `pool: class ${className} not in ${file}` };
    const prior = this.surgicalMethod(cls, member)?.getBodyText() ?? null;
    const res = writeSurgicalBody(cls, member, body, iso, true); // checkTypes → warm program LS
    if ((!res.ok || (res.violations?.length ?? 0) > 0) && prior != null) {
      this.surgicalMethod(cls, member)?.setBodyText(prior); // geri al (yeniden bul: node değişmiş olabilir)
    }
    return res;
  }

  /** Sıcak programda eksik import'ları düzelt (reload YOK, save YOK). */
  fixImports(relFiles: string[]): void {
    for (const rel of relFiles) {
      const sf = this.project.getSourceFile(resolve(this.rootDir, rel));
      if (!sf) continue;
      try {
        fixImportsInSourceFile(sf, this.owned, this.srcRoot);
      } catch {
        /* atla */
      }
    }
  }

  /** Bölgenin mevcut (committed) gövde metni — onarımı raporlamak/saklamak için. */
  regionBody(file: string, className: string, member: string): string | null {
    const cls = this.project.getSourceFile(resolve(this.rootDir, file))?.getClass(className);
    return cls ? this.surgicalMethod(cls, member)?.getBodyText() ?? null : null;
  }

  /** Kirli dosyaları diske yaz (yalnız değişenler — ucuz I/O; type-check değil). */
  save(): void {
    this.project.saveSync();
  }

  /* ── GROUNDING (sıcak programdan — repair'de taze proje açma yok) ──────────
   *  Aynı çekirdekler (fillContextFromSf vb.) hem disk pas'ında hem burada; fark:
   *  bunlar WARM program SourceFile'ını kullanır (hepsi yüklü+bağlı + in-memory
   *  düzeltmeler görünür → disk-staleness yok). */

  /** Bölgenin imza+constructor+import bağlamı (warm programdan). */
  fillContext(file: string, className: string, member: string): SurgicalFillContext | null {
    const sf = this.sourceFile(file);
    return sf ? fillContextFromSf(sf, className, member) : null;
  }

  /** Dosyanın import yüzeyi — owned tiplerin metod/üye imzaları (warm programdan). */
  declaredSurface(file: string): string {
    const sf = this.sourceFile(file);
    return sf ? declaredSurfaceFromSf(sf) : "";
  }

  /** ChatLSP "headers" — metodun üret/tüket tiplerinin gerçek şekli (warm programdan). */
  expectedTypeHeaders(file: string, className: string, member: string): string {
    const sf = this.sourceFile(file);
    return sf ? expectedTypeHeadersFromSf(sf, className, member) : "";
  }

  /** lookup_members — bir owned tipin gerçek yüzeyi (warm programdan; taze proje yok). */
  completeType(file: string, typeName: string): CompleteTypeResult {
    const sf = this.sourceFile(file);
    return sf ? completeTypeFromSf(sf, typeName) : { kind: "unknown" };
  }

  private sourceFile(file: string): SourceFile | undefined {
    return this.project.getSourceFile(resolve(this.rootDir, file));
  }

  private surgicalMethod(cls: ClassDeclaration, member: string): MethodDeclaration | undefined {
    return cls.getMethods().find((m) => {
      const mk = MARKER_RE.exec(m.getBody()?.getFullText() ?? "");
      return mk ? mk[2] === member : m.getName() === member;
    });
  }

  /** Bir satır hangi surgical bölgede (marker'lı metot)? Marker yoksa null (elle
   *  yazılmış / codegen-tam / bölge-dışı). */
  private regionAt(sf: SourceFile, line: number): { className: string; member: string } | null {
    for (const cls of sf.getClasses()) {
      const cn = cls.getName();
      if (!cn) continue;
      for (const m of cls.getMethods()) {
        if (line < m.getStartLineNumber() || line > m.getEndLineNumber()) continue;
        const mk = MARKER_RE.exec(m.getBody()?.getFullText() ?? "");
        return mk ? { className: cn, member: mk[2]! } : null;
      }
    }
    return null;
  }
}
