/** Project scanner — extracts the As-Is (current state) graph from the codebase.
 *
 *  Two passes:
 *  1. Node pass: each class/enum is classified, properties mapped to backend
 *     schema are extracted, class name → node registry.
 *  2. Edge pass: relationships derived from constructor injection, @Body/return
 *     types, @Module imports, TypeORM entity links, and throw expressions.
 *     Types not in the registry are skipped silently (third-party classes). */

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { ClassDeclaration, Project, SyntaxKind } from "ts-morph";
import { classifyClass } from "./classify.js";
import { readSurgicalMembers } from "./surgical.js";
import {
  constructorParamTypes,
  extractCache,
  extractController,
  extractDto,
  extractEnum,
  extractEventHandler,
  extractException,
  extractExternalService,
  extractMiddleware,
  extractModule,
  extractOrchestrator,
  extractRepository,
  extractService,
  extractTable,
  extractThrownExceptionNames,
  extractWorker,
} from "./extract.js";
import {
  type AsIsEdge,
  type AsIsGraph,
  type AsIsNode,
  type EdgeKind,
  type NodeKind,
  edgeKey,
  nodeKey,
} from "./types.js";

export interface ScanOptions {
  /** Taranacak proje kökü (solarch.json'ın olduğu yer). */
  rootDir: string;
  /** Açık tsconfig yolu; verilmezse rootDir/tsconfig.json denenir. */
  tsconfigPath?: string;
  /** Kaynak glob'ları (rootDir'e göre). Varsayılan: src içindeki .ts. */
  include?: string[];
  exclude?: string[];
}

const DEFAULT_INCLUDE = ["src/**/*.ts"];
const DEFAULT_EXCLUDE = [
  "!**/*.spec.ts",
  "!**/*.test.ts",
  "!**/node_modules/**",
  "!**/dist/**",
];

interface RegistryEntry {
  node: AsIsNode;
  cls: ClassDeclaration | null;
}

/** DI kaynağı/hedef kind çiftine göre edge tipi — Kurallar Matrisi'nin
 *  whitelist'iyle uyumlu eşleme. Listede olmayan çift: edge üretilmez. */
const DI_EDGE: Partial<Record<NodeKind, Partial<Record<NodeKind, EdgeKind>>>> = {
  Controller: { Service: "CALLS", Orchestrator: "CALLS" },
  Service: {
    Repository: "CALLS",
    Service: "CALLS",
    Cache: "CACHES_IN",
    ExternalService: "REQUESTS",
  },
  Worker: { Service: "CALLS" },
  EventHandler: { Service: "CALLS" },
  Orchestrator: { Service: "CALLS" },
  Middleware: {},
};

export function scanProject(opts: ScanOptions): AsIsGraph {
  const rootDir = opts.rootDir;
  const tsconfigPath = opts.tsconfigPath ?? join(rootDir, "tsconfig.json");
  const hasTsconfig = existsSync(tsconfigPath);

  const project = new Project(
    hasTsconfig
      ? { tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: true }
      : { compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } },
  );

  const include = (opts.include ?? DEFAULT_INCLUDE).map((g) => join(rootDir, g));
  const exclude = opts.exclude
    ? opts.exclude.map((g) => (g.startsWith("!") ? `!${join(rootDir, g.slice(1))}` : `!${join(rootDir, g)}`))
    : DEFAULT_EXCLUDE.map((g) => `!${join(rootDir, g.slice(1))}`);
  const sourceFiles = project.addSourceFilesAtPaths([...include, ...exclude]);

  const warnings: string[] = [];
  const registry = new Map<string, RegistryEntry>(); // className → entry
  const nodes: AsIsNode[] = [];
  const edges: AsIsEdge[] = [];
  const edgeSeen = new Set<string>();

  const relPath = (file: string) => relative(rootDir, file);

  const addNode = (node: AsIsNode, cls: ClassDeclaration | null) => {
    if (registry.has(node.name)) {
      warnings.push(`Duplicate declaration name "${node.name}" (${node.file}) — ilk bulunan kullanıldı.`);
      return;
    }
    registry.set(node.name, { node, cls });
    nodes.push(node);
  };

  const addEdge = (
    sourceKey: string,
    kind: EdgeKind,
    targetKey: string,
    file: string,
    reason: string,
  ) => {
    const key = edgeKey(sourceKey, kind, targetKey);
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ key, kind, sourceKey, targetKey, file, reason });
  };

  /* ── 1. geçiş: node'lar ─────────────────────────────────────── */

  // Ek bilgi taşıyıcıları (2. geçişte edge'e dönüşür)
  const dtoRefsOf = new Map<string, { uses: string[]; returns: string[] }>(); // className → DTO refs
  const nestedDtoOf = new Map<string, string[]>();
  const enumRefsOf = new Map<string, string[]>();
  const entityOfRepo = new Map<string, string | null>(); // repo className → entity className
  const moduleImportsOf = new Map<string, string[]>();
  const moduleExportsOf = new Map<string, string[]>();
  const tableRelationsOf = new Map<string, string[]>(); // entity className → related entity classNames

  for (const sf of sourceFiles) {
    const file = relPath(sf.getFilePath());

    for (const decl of sf.getDescendantsOfKind(SyntaxKind.EnumDeclaration)) {
      // Yalnız top-level export edilen enum'lar mimari node sayılır.
      if (!decl.isExported()) continue;
      const props = extractEnum(decl);
      addNode(
        {
          key: nodeKey("Enum", decl.getName()),
          kind: "Enum",
          name: decl.getName(),
          file,
          properties: props,
        },
        null,
      );
    }

    for (const cls of sf.getClasses()) {
      const kind = classifyClass(cls);
      if (!kind) continue;
      const name = cls.getName();
      if (!name) continue;

      let properties: Record<string, unknown>;
      switch (kind) {
        case "Table": {
          const r = extractTable(cls);
          properties = r.properties;
          tableRelationsOf.set(name, r.relations.map((rel) => rel.targetClassName));
          if (r.enumRefs.length > 0) enumRefsOf.set(name, r.enumRefs);
          break;
        }
        case "Controller": {
          const r = extractController(cls);
          properties = r.properties;
          dtoRefsOf.set(name, { uses: r.extras.requestDtoRefs, returns: r.extras.responseDtoRefs });
          break;
        }
        case "Service":
        case "Orchestrator": {
          const r = extractService(cls);
          properties = kind === "Orchestrator" ? extractOrchestrator(cls) : r.properties;
          dtoRefsOf.set(name, { uses: r.extras.paramDtoRefs, returns: r.extras.returnDtoRefs });
          break;
        }
        case "DTO": {
          const r = extractDto(cls);
          properties = r.properties;
          nestedDtoOf.set(name, r.extras.nestedDtoRefs);
          if (r.extras.enumRefs.length > 0) enumRefsOf.set(name, r.extras.enumRefs);
          break;
        }
        case "Module": {
          const r = extractModule(cls);
          properties = r.properties;
          moduleImportsOf.set(name, r.extras.importedModuleNames);
          moduleExportsOf.set(name, r.extras.exportedNames);
          break;
        }
        case "Repository": {
          const r = extractRepository(cls);
          properties = r.properties;
          entityOfRepo.set(name, r.extras.entityClassName);
          break;
        }
        case "Exception":
          properties = extractException(cls);
          break;
        case "Middleware":
          properties = extractMiddleware(cls);
          break;
        case "Worker":
          properties = extractWorker(cls);
          break;
        case "EventHandler":
          properties = extractEventHandler(cls);
          break;
        case "Cache":
          properties = extractCache(cls);
          break;
        case "ExternalService":
          properties = extractExternalService(cls);
          break;
        default:
          properties = { Description: `${name} (${kind})` };
          break;
      }

      // Codegen işaretleri: varsa node'a iliştir (implementasyon durumu katmanı).
      const surgical = readSurgicalMembers(cls);
      addNode(
        surgical.length > 0
          ? { key: nodeKey(kind, name), kind, name, file, properties, surgical }
          : { key: nodeKey(kind, name), kind, name, file, properties },
        cls,
      );
    }
  }

  /** Sınıf adından node çöz — kayıt defterinde yoksa null (3. parti tip). */
  const resolve = (className: string): AsIsNode | null => registry.get(className)?.node ?? null;

  // Repo EntityReference + Table FK ReferencesTable: sınıf adı → tablo adına çevir.
  for (const [repoName, entityName] of entityOfRepo) {
    const repo = resolve(repoName);
    const entity = entityName ? resolve(entityName) : null;
    if (repo && entity && entity.kind === "Table") {
      repo.properties.EntityReference = String(entity.properties.TableName ?? entityName);
    }
  }
  for (const entry of registry.values()) {
    const n = entry.node;
    if (n.kind !== "Table") continue;
    const fks = n.properties.ForeignKeys as { ReferencesTable: string }[] | undefined;
    if (!fks) continue;
    for (const fk of fks) {
      const target = resolve(fk.ReferencesTable);
      if (target?.kind === "Table") {
        fk.ReferencesTable = String(target.properties.TableName ?? fk.ReferencesTable);
      }
    }
  }

  /* ── 2. geçiş: edge'ler ─────────────────────────────────────── */

  for (const { node, cls } of registry.values()) {
    if (!cls) continue;

    // a) Constructor injection → DI_EDGE eşlemesi
    const diMap = DI_EDGE[node.kind];
    if (diMap) {
      for (const param of constructorParamTypes(cls)) {
        const target = resolve(param.typeName);
        if (!target) continue;
        const kind = diMap[target.kind];
        if (!kind) continue;
        addEdge(node.key, kind, target.key, node.file,
          `constructor injection: ${param.name}: ${param.typeName}`);
      }
    }

    // b) Repository → Table (yönettiği entity üstünden okur + yazar)
    if (node.kind === "Repository") {
      const entityName = entityOfRepo.get(node.name);
      const entity = entityName ? resolve(entityName) : null;
      if (entity?.kind === "Table") {
        addEdge(node.key, "QUERIES", entity.key, node.file, `manages entity ${entityName}`);
        addEdge(node.key, "WRITES", entity.key, node.file, `manages entity ${entityName}`);
      }
    }

    // c) Controller/Service → DTO (USES istek gövdesi/parametre, RETURNS dönüş)
    const dtoRefs = dtoRefsOf.get(node.name);
    if (dtoRefs && (node.kind === "Controller" || node.kind === "Service")) {
      for (const ref of dtoRefs.uses) {
        const dto = resolve(ref);
        if (dto?.kind === "DTO") {
          addEdge(node.key, "USES", dto.key, node.file, `parameter type ${ref}`);
        }
      }
      for (const ref of dtoRefs.returns) {
        const dto = resolve(ref);
        if (dto?.kind === "DTO") {
          addEdge(node.key, "RETURNS", dto.key, node.file, `return type ${ref}`);
        }
      }
    }

    // d) DTO → DTO (nested HAS) ve → Enum (USES)
    if (node.kind === "DTO") {
      for (const ref of nestedDtoOf.get(node.name) ?? []) {
        const dto = resolve(ref);
        if (dto?.kind === "DTO") addEdge(node.key, "HAS", dto.key, node.file, `nested field type ${ref}`);
      }
    }
    for (const ref of enumRefsOf.get(node.name) ?? []) {
      const en = resolve(ref);
      if (en?.kind === "Enum") addEdge(node.key, "USES", en.key, node.file, `enum reference ${ref}`);
    }

    // e) Module → Module (DEPENDS_ON) + Module → Service (USES, public API)
    if (node.kind === "Module") {
      for (const imp of moduleImportsOf.get(node.name) ?? []) {
        const m = resolve(imp);
        if (m?.kind === "Module") addEdge(node.key, "DEPENDS_ON", m.key, node.file, `@Module imports ${imp}`);
      }
      for (const exp of moduleExportsOf.get(node.name) ?? []) {
        const s = resolve(exp);
        if (s?.kind === "Service") addEdge(node.key, "USES", s.key, node.file, `@Module exports ${exp}`);
      }
    }

    // f) throw new XException(...) → THROWS
    if (node.kind === "Controller" || node.kind === "Service" || node.kind === "Repository") {
      for (const thrown of extractThrownExceptionNames(cls)) {
        const ex = resolve(thrown);
        if (ex?.kind === "Exception") addEdge(node.key, "THROWS", ex.key, node.file, `throw new ${thrown}()`);
      }
    }

    // g) Exception → Exception (EXTENDS)
    if (node.kind === "Exception") {
      const ext = cls.getExtends()?.getExpression().getText();
      if (ext) {
        const base = resolve(ext);
        if (base?.kind === "Exception") addEdge(node.key, "EXTENDS", base.key, node.file, `extends ${ext}`);
      }
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    rootDir,
    tsconfigPath: hasTsconfig ? tsconfigPath : null,
    fileCount: sourceFiles.length,
    nodes: nodes.sort((a, b) => a.key.localeCompare(b.key)),
    edges: edges.sort((a, b) => a.key.localeCompare(b.key)),
    warnings,
  };
}
