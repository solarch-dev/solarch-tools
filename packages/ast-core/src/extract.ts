/** Class → closest backend node schema `properties` extraction.
 *
 *  Each extractor uses field names from the backend Zod schema
 *  (TableName, Columns, Endpoints, Methods, Fields, ...). Unknown fields
 *  (human inputs like Description) get sensible defaults — the diff engine
 *  compares these at "info" level, not as errors. */

import {
  ClassDeclaration,
  Decorator,
  EnumDeclaration,
  Node as TsNode,
  PropertyDeclaration,
  SyntaxKind,
} from "ts-morph";

/* ── ortak yardımcılar ──────────────────────────────────────────── */

/** Dekoratörün ilk string argümanı: @Controller("users") → "users". */
function firstStringArg(dec: Decorator | undefined): string | undefined {
  const arg = dec?.getArguments()[0];
  if (!arg) return undefined;
  if (TsNode.isStringLiteral(arg) || TsNode.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.getLiteralText();
  }
  return undefined;
}

/** Dekoratörün obje-literal argümanından alan oku: @Column({ type: "varchar" }). */
function objectArgProp(dec: Decorator | undefined, prop: string): string | undefined {
  const arg = dec?.getArguments()[0];
  if (!arg || !TsNode.isObjectLiteralExpression(arg)) return undefined;
  const p = arg.getProperty(prop);
  if (!p || !TsNode.isPropertyAssignment(p)) return undefined;
  const init = p.getInitializer();
  if (!init) return undefined;
  if (TsNode.isStringLiteral(init)) return init.getLiteralText();
  return init.getText();
}

/** import("...")./Promise<> gürültüsünden arınmış kısa tip metni. */
export function cleanTypeText(text: string): string {
  return text
    .replace(/import\([^)]*\)\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Promise<X> → X; X[] → X; Array<X> → X. Ref çözümü için çekirdek tip adı. */
export function unwrapTypeName(text: string): string {
  let t = cleanTypeText(text);
  const promise = t.match(/^Promise<(.+)>$/);
  if (promise?.[1]) t = promise[1].trim();
  const arr = t.match(/^Array<(.+)>$/);
  if (arr?.[1]) t = arr[1].trim();
  if (t.endsWith("[]")) t = t.slice(0, -2).trim();
  return t;
}

function pascalToSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/* ── Table (TypeORM @Entity) ───────────────────────────────────── */

const TYPEORM_TO_SOLARCH: Record<string, string> = {
  varchar: "VARCHAR", "character varying": "VARCHAR", char: "VARCHAR",
  text: "TEXT", longtext: "TEXT", mediumtext: "TEXT",
  int: "INT", integer: "INT", int4: "INT", smallint: "INT",
  bigint: "BIGINT", int8: "BIGINT",
  boolean: "BOOLEAN", bool: "BOOLEAN",
  timestamp: "DATETIME", timestamptz: "DATETIME", datetime: "DATETIME",
  date: "DATE",
  uuid: "UUID",
  float: "FLOAT", real: "FLOAT", double: "FLOAT",
  decimal: "DECIMAL", numeric: "DECIMAL",
  json: "JSON", jsonb: "JSON",
  enum: "ENUM",
};

/** TS property tipinden SQL tipi tahmini (dekoratörde type yoksa). */
function tsTypeToSql(typeText: string): string {
  const t = unwrapTypeName(typeText).toLowerCase();
  if (t === "string") return "VARCHAR";
  if (t === "number") return "INT";
  if (t === "boolean") return "BOOLEAN";
  if (t === "date") return "DATETIME";
  return "VARCHAR";
}

const COLUMN_DECORATORS = new Set([
  "Column", "PrimaryColumn", "PrimaryGeneratedColumn",
  "CreateDateColumn", "UpdateDateColumn", "DeleteDateColumn", "VersionColumn",
]);

const RELATION_DECORATORS = new Set(["ManyToOne", "OneToOne", "OneToMany", "ManyToMany"]);

export interface EntityRelation {
  /** İlişkinin hedef sınıf adı: @ManyToOne(() => User) → "User". */
  targetClassName: string;
  relation: string;
  propertyName: string;
  joinColumn?: string;
}

/** @ManyToOne(() => User) ok-fonksiyonundan hedef sınıf adını çöz. */
function relationTarget(dec: Decorator): string | undefined {
  const arg = dec.getArguments()[0];
  if (!arg) return undefined;
  if (TsNode.isArrowFunction(arg)) {
    const body = arg.getBody();
    if (TsNode.isIdentifier(body)) return body.getText();
    if (TsNode.isPropertyAccessExpression(body)) return body.getName();
  }
  if (TsNode.isIdentifier(arg)) return arg.getText();
  return undefined;
}

export function extractTable(cls: ClassDeclaration): {
  properties: Record<string, unknown>;
  relations: EntityRelation[];
  enumRefs: string[];
} {
  const className = cls.getName() ?? "UnknownEntity";
  const tableName = firstStringArg(cls.getDecorator("Entity")) ?? pascalToSnake(className);

  const columns: Record<string, unknown>[] = [];
  const relations: EntityRelation[] = [];
  const enumRefs: string[] = [];

  for (const prop of cls.getProperties()) {
    const decs = prop.getDecorators();
    const colDec = decs.find((d) => COLUMN_DECORATORS.has(d.getName()));
    const relDec = decs.find((d) => RELATION_DECORATORS.has(d.getName()));

    if (relDec) {
      const target = relationTarget(relDec);
      if (target) {
        const joinDec = decs.find((d) => d.getName() === "JoinColumn");
        relations.push({
          targetClassName: target,
          relation: relDec.getName(),
          propertyName: prop.getName(),
          joinColumn: objectArgProp(joinDec, "name") ?? undefined,
        });
      }
      continue;
    }
    if (!colDec) continue;

    const decName = colDec.getName();
    const typeText = prop.getTypeNode()?.getText() ?? prop.getType().getText(prop);
    // @Column("varchar") veya @Column({ type: "varchar" }) → SQL tipi.
    const rawSqlType =
      firstStringArg(colDec) ??
      objectArgProp(colDec, "type") ??
      undefined;
    let dataType = rawSqlType
      ? (TYPEORM_TO_SOLARCH[rawSqlType.toLowerCase()] ?? "VARCHAR")
      : tsTypeToSql(typeText);

    const isPkGenerated = decName === "PrimaryGeneratedColumn";
    const isPk = isPkGenerated || decName === "PrimaryColumn";
    if (isPkGenerated) {
      // @PrimaryGeneratedColumn("uuid") → UUID; argümansız → INT autoincrement.
      dataType = firstStringArg(colDec) === "uuid" ? "UUID" : "INT";
    }
    if (decName === "CreateDateColumn" || decName === "UpdateDateColumn" || decName === "DeleteDateColumn") {
      dataType = "DATETIME";
    }

    const enumRef = dataType === "ENUM" ? unwrapTypeName(typeText) : undefined;
    if (enumRef) enumRefs.push(enumRef);

    const nullable = objectArgProp(colDec, "nullable") === "true" || prop.hasQuestionToken();
    const lengthStr = objectArgProp(colDec, "length");
    const length = lengthStr ? Number.parseInt(lengthStr, 10) : undefined;

    columns.push({
      Name: prop.getName(),
      DataType: dataType,
      ...(length && Number.isFinite(length) ? { Length: length } : {}),
      IsPrimaryKey: isPk,
      IsNotNull: !nullable,
      IsUnique: objectArgProp(colDec, "unique") === "true",
      AutoIncrement: isPkGenerated && dataType !== "UUID",
      ...(enumRef ? { EnumRef: enumRef } : {}),
    });
  }

  // İlişkilerden FK sentezi — ReferencesTable hedef sınıfın table adıdır;
  // hedef adı scan aşamasında sınıf kayıt defterinden çözülür (placeholder: sınıf adı).
  const foreignKeys = relations
    .filter((r) => r.relation === "ManyToOne" || r.relation === "OneToOne")
    .map((r) => ({
      Columns: [r.joinColumn ?? `${r.propertyName}Id`],
      ReferencesTable: r.targetClassName, // scan'de tablo adına çevrilir
      ReferencesColumns: ["id"],
      OnDelete: "NO_ACTION",
      OnUpdate: "NO_ACTION",
    }));

  return {
    properties: {
      TableName: tableName,
      Description: `${className} entity`,
      Columns: columns,
      ForeignKeys: foreignKeys,
      UniqueConstraints: [],
      CheckConstraints: [],
      Indexes: [],
    },
    relations,
    enumRefs,
  };
}

/* ── Controller ─────────────────────────────────────────────────── */

const HTTP_DECORATORS: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE", Patch: "PATCH",
};

export interface ControllerExtras {
  /** @Body() parametre tiplerinden DTO referansları. */
  requestDtoRefs: string[];
  /** Dönüş tiplerinden DTO referansları. */
  responseDtoRefs: string[];
}

export function extractController(cls: ClassDeclaration): {
  properties: Record<string, unknown>;
  extras: ControllerExtras;
} {
  const className = cls.getName() ?? "UnknownController";
  const baseRoute = firstStringArg(cls.getDecorator("Controller")) ?? "/";
  const classHasGuard = cls.getDecorator("UseGuards") !== undefined;

  const endpoints: Record<string, unknown>[] = [];
  const requestDtoRefs: string[] = [];
  const responseDtoRefs: string[] = [];

  for (const method of cls.getMethods()) {
    const httpDec = method.getDecorators().find((d) => HTTP_DECORATORS[d.getName()]);
    if (!httpDec) continue;

    const route = firstStringArg(httpDec) ?? "/";
    const bodyParam = method.getParameters().find((p) =>
      p.getDecorators().some((d) => d.getName() === "Body"),
    );
    const requestDto = bodyParam
      ? unwrapTypeName(bodyParam.getTypeNode()?.getText() ?? "")
      : undefined;
    if (requestDto) requestDtoRefs.push(requestDto);

    const returnText = method.getReturnTypeNode()?.getText()
      ?? method.getReturnType().getText(method);
    const responseDto = unwrapTypeName(returnText);
    if (responseDto && /(Dto|DTO|Response)$/.test(responseDto)) responseDtoRefs.push(responseDto);

    const pathParams = method.getParameters()
      .filter((p) => p.getDecorators().some((d) => d.getName() === "Param"))
      .map((p) => ({
        Name: p.getName(),
        Type: cleanTypeText(p.getTypeNode()?.getText() ?? "string"),
      }));
    const queryParams = method.getParameters()
      .filter((p) => p.getDecorators().some((d) => d.getName() === "Query"))
      .map((p) => ({
        Name: p.getName(),
        Type: cleanTypeText(p.getTypeNode()?.getText() ?? "string"),
        Required: !p.hasQuestionToken(),
      }));

    endpoints.push({
      HttpMethod: HTTP_DECORATORS[httpDec.getName()],
      Route: route.startsWith("/") ? route : `/${route}`,
      ...(requestDto ? { RequestDTORef: requestDto } : {}),
      ...(responseDto && /(Dto|DTO|Response)$/.test(responseDto) ? { ResponseDTORef: responseDto } : {}),
      RequiresAuth: classHasGuard || method.getDecorator("UseGuards") !== undefined,
      RequiredRoles: [],
      PathParams: pathParams,
      QueryParams: queryParams,
      StatusCodes: [],
      MiddlewareRefs: [],
    });
  }

  return {
    properties: {
      ControllerName: className,
      Description: `${className} HTTP controller`,
      BaseRoute: baseRoute.startsWith("/") ? baseRoute : `/${baseRoute}`,
      Endpoints: endpoints,
    },
    extras: { requestDtoRefs, responseDtoRefs },
  };
}

/* ── Service (ve Worker/EventHandler/Orchestrator gövdeleri) ───── */

export interface ServiceExtras {
  /** Metod parametre/dönüş tiplerinden DTO referansları. */
  paramDtoRefs: string[];
  returnDtoRefs: string[];
}

function isDtoish(name: string): boolean {
  return /(Dto|DTO)$/.test(name);
}

export function extractService(cls: ClassDeclaration): {
  properties: Record<string, unknown>;
  extras: ServiceExtras;
} {
  const className = cls.getName() ?? "UnknownService";
  const methods: Record<string, unknown>[] = [];
  const paramDtoRefs: string[] = [];
  const returnDtoRefs: string[] = [];

  for (const method of cls.getMethods()) {
    if (method.getScope() === "private" || method.getScope() === "protected") continue;

    const params = method.getParameters().map((p) => {
      const typeText = cleanTypeText(p.getTypeNode()?.getText() ?? p.getType().getText(p));
      const core = unwrapTypeName(typeText);
      if (isDtoish(core)) paramDtoRefs.push(core);
      return {
        Name: p.getName(),
        Type: typeText,
        Optional: p.hasQuestionToken() || p.hasInitializer(),
        ...(isDtoish(core) ? { DtoRef: core } : {}),
      };
    });

    const returnText = cleanTypeText(
      method.getReturnTypeNode()?.getText() ?? method.getReturnType().getText(method),
    );
    const returnCore = unwrapTypeName(returnText);
    if (isDtoish(returnCore)) returnDtoRefs.push(returnCore);

    methods.push({
      MethodName: method.getName(),
      Visibility: "public",
      Parameters: params,
      ReturnType: returnText || "void",
      ...(isDtoish(returnCore) ? { ReturnDtoRef: returnCore } : {}),
      IsAsync: method.isAsync() || /^Promise</.test(returnText),
      Throws: [],
    });
  }

  return {
    properties: {
      ServiceName: className,
      Description: `${className} business logic`,
      IsTransactionScoped: false,
      Methods: methods,
    },
    extras: { paramDtoRefs, returnDtoRefs },
  };
}

/* ── DTO ────────────────────────────────────────────────────────── */

export interface DtoExtras {
  nestedDtoRefs: string[];
  enumRefs: string[];
}

function propIsOptional(prop: PropertyDeclaration): boolean {
  if (prop.hasQuestionToken()) return true;
  return prop.getDecorators().some((d) => d.getName() === "IsOptional");
}

export function extractDto(cls: ClassDeclaration): {
  properties: Record<string, unknown>;
  extras: DtoExtras;
} {
  const className = cls.getName() ?? "UnknownDto";
  const fields: Record<string, unknown>[] = [];
  const nestedDtoRefs: string[] = [];
  const enumRefs: string[] = [];

  for (const prop of cls.getProperties()) {
    if (prop.isStatic()) continue;
    const typeText = cleanTypeText(prop.getTypeNode()?.getText() ?? prop.getType().getText(prop));
    const core = unwrapTypeName(typeText);
    const isArray = typeText.endsWith("[]") || /^Array</.test(typeText);

    const isEnumRef = prop.getDecorators().some((d) => d.getName() === "IsEnum");
    if (isEnumRef) enumRefs.push(core);
    const isNested = isDtoish(core) && core !== className;
    if (isNested) nestedDtoRefs.push(core);

    fields.push({
      Name: prop.getName(),
      DataType: core,
      IsRequired: !propIsOptional(prop),
      IsArray: isArray,
      ValidationRules: [],
      ...(isNested ? { NestedDTORef: core } : {}),
      ...(isEnumRef ? { EnumRef: core } : {}),
    });
  }

  return {
    properties: {
      Name: className,
      Description: `${className} data transfer object`,
      Fields: fields,
    },
    extras: { nestedDtoRefs, enumRefs },
  };
}

/* ── Module ─────────────────────────────────────────────────────── */

export interface ModuleExtras {
  importedModuleNames: string[];
  exportedNames: string[];
}

/** @Module({ imports: [...], exports: [...] }) metadata'sındaki identifier listesi. */
function moduleMetaIdentifiers(cls: ClassDeclaration, field: string): string[] {
  const dec = cls.getDecorator("Module");
  const arg = dec?.getArguments()[0];
  if (!arg || !TsNode.isObjectLiteralExpression(arg)) return [];
  const prop = arg.getProperty(field);
  if (!prop || !TsNode.isPropertyAssignment(prop)) return [];
  const init = prop.getInitializer();
  if (!init || !TsNode.isArrayLiteralExpression(init)) return [];
  const names: string[] = [];
  for (const el of init.getElements()) {
    if (TsNode.isIdentifier(el)) names.push(el.getText());
    // forwardRef(() => XModule) / DynamicModule çağrıları: ilk identifier'ı al.
    else {
      const id = el.getFirstDescendantByKind(SyntaxKind.Identifier);
      if (id) names.push(id.getText());
    }
  }
  return names;
}

export function extractModule(cls: ClassDeclaration): {
  properties: Record<string, unknown>;
  extras: ModuleExtras;
} {
  const className = cls.getName() ?? "UnknownModule";
  const importedModuleNames = moduleMetaIdentifiers(cls, "imports").filter((n) => /Module$/.test(n));
  const exportedNames = moduleMetaIdentifiers(cls, "exports");

  return {
    properties: {
      ModuleName: className,
      Description: `${className} bounded context`,
      StrictBoundaries: false,
      ExposedServices: exportedNames.filter((n) => /Service$/.test(n)),
      Dependencies: importedModuleNames,
    },
    extras: { importedModuleNames, exportedNames },
  };
}

/* ── Repository ─────────────────────────────────────────────────── */

export interface RepositoryExtras {
  /** Yönettiği entity sınıf adı (extends Repository<X> veya @InjectRepository(X)). */
  entityClassName: string | null;
}

export function extractRepository(cls: ClassDeclaration): {
  properties: Record<string, unknown>;
  extras: RepositoryExtras;
} {
  const className = cls.getName() ?? "UnknownRepository";
  let entityClassName: string | null = null;

  // extends Repository<User> → User
  const ext = cls.getExtends();
  const typeArg = ext?.getTypeArguments()[0];
  if (typeArg) entityClassName = unwrapTypeName(typeArg.getText());

  // constructor(@InjectRepository(User) ...) → User
  if (!entityClassName) {
    for (const ctor of cls.getConstructors()) {
      for (const param of ctor.getParameters()) {
        const inject = param.getDecorators().find((d) => d.getName() === "InjectRepository");
        const arg = inject?.getArguments()[0];
        if (arg && TsNode.isIdentifier(arg)) {
          entityClassName = arg.getText();
          break;
        }
      }
    }
  }

  const customQueries = cls.getMethods()
    .filter((m) => m.getScope() !== "private")
    .map((m) => ({
      QueryName: m.getName(),
      QueryType: "custom",
      Parameters: m.getParameters().map((p) => ({
        Name: p.getName(),
        Type: cleanTypeText(p.getTypeNode()?.getText() ?? "unknown"),
      })),
      ReturnType: cleanTypeText(m.getReturnTypeNode()?.getText() ?? m.getReturnType().getText(m)) || "void",
    }));

  return {
    properties: {
      RepositoryName: className,
      Description: `${className} data access`,
      EntityReference: entityClassName ?? "", // scan'de tablo adına çevrilir
      IsCached: false,
      CustomQueries: customQueries,
    },
    extras: { entityClassName },
  };
}

/* ── Enum ───────────────────────────────────────────────────────── */

export function extractEnum(decl: EnumDeclaration): Record<string, unknown> {
  return {
    Name: decl.getName(),
    Description: `${decl.getName()} enumeration`,
    Values: decl.getMembers().map((m) => ({ Key: m.getName() })),
  };
}

/* ── Sınıf gövdesinden throw edilen Exception sınıfları ─────────── */

export function extractThrownExceptionNames(cls: ClassDeclaration): string[] {
  const names = new Set<string>();
  for (const throwStmt of cls.getDescendantsOfKind(SyntaxKind.ThrowStatement)) {
    const newExpr = throwStmt.getFirstDescendantByKind(SyntaxKind.NewExpression);
    const ident = newExpr?.getExpression();
    if (ident && TsNode.isIdentifier(ident)) names.add(ident.getText());
  }
  return [...names];
}

/* ── Basit Exception / Middleware / Worker / EventHandler props ── */

/** Backend şemaları strict + zorunlu alanlı — koddan çıkarılamayan alanlara
 *  şema-geçerli makul default yazılır ki `solarch push` node'ları cloud'a
 *  ekleyebilsin (kullanıcı canvas'ta düzeltir). */
export function extractException(cls: ClassDeclaration): Record<string, unknown> {
  const className = cls.getName() ?? "UnknownException";
  // Nest'in yerleşik HttpException alt sınıflarından status tahmini.
  const parent = cls.getExtends()?.getExpression().getText() ?? "";
  const statusByParent: Record<string, number> = {
    BadRequestException: 400,
    UnauthorizedException: 401,
    ForbiddenException: 403,
    NotFoundException: 404,
    ConflictException: 409,
  };
  return {
    ExceptionName: className,
    Description: `${className} error type`,
    HttpStatusCode: statusByParent[parent] ?? 500,
    LogSeverity: "Error",
  };
}

export function extractMiddleware(cls: ClassDeclaration): Record<string, unknown> {
  const className = cls.getName() ?? "UnknownMiddleware";
  return {
    MiddlewareName: className,
    Description: `${className} request pipeline step`,
    AppliesTo: "Global",
    ExecutionOrder: 0,
    MiddlewareType: /auth|guard/i.test(className) ? "Auth" : "Custom",
    Config: [],
  };
}

export function extractWorker(cls: ClassDeclaration): Record<string, unknown> {
  const className = cls.getName() ?? "UnknownWorker";
  // @Cron("0 * * * *") ifadesinden zamanlama + görev metodu çek.
  let schedule = "";
  let task = "";
  for (const m of cls.getMethods()) {
    const cron = m.getDecorator("Cron");
    if (cron) {
      schedule = firstStringArg(cron) ?? "";
      task = m.getName();
      break;
    }
  }
  return {
    WorkerName: className,
    Description: `${className} scheduled job`,
    Schedule: schedule || "manual",
    TaskToExecute: task || "run",
    TimeoutSeconds: 300,
    RetryPolicy: { MaxRetries: 0 },
    IsEnabled: true,
  };
}

export function extractEventHandler(cls: ClassDeclaration): Record<string, unknown> {
  const className = cls.getName() ?? "UnknownHandler";
  let eventName = "";
  for (const m of cls.getMethods()) {
    const dec = m.getDecorators().find((d) => ["OnEvent", "EventPattern", "MessagePattern"].includes(d.getName()));
    if (dec) {
      eventName = firstStringArg(dec) ?? "";
      break;
    }
  }
  return {
    HandlerName: className,
    Description: `${className} event consumer`,
    EventName: eventName || "unknown",
    IsAsync: true,
  };
}

export function extractOrchestrator(cls: ClassDeclaration): Record<string, unknown> {
  const className = cls.getName() ?? "UnknownOrchestrator";
  return {
    OrchestratorName: className,
    Description: `${className} saga coordinator`,
    Pattern: "Saga",
    Steps: [],
  };
}

/** Constructor parametreleri: ad + tip adı (DI bağımlılık çözümü için). */
export function constructorParamTypes(cls: ClassDeclaration): { name: string; typeName: string }[] {
  const out: { name: string; typeName: string }[] = [];
  for (const ctor of cls.getConstructors()) {
    for (const param of ctor.getParameters()) {
      const typeText = param.getTypeNode()?.getText();
      if (!typeText) continue;
      out.push({ name: param.getName(), typeName: unwrapTypeName(typeText) });
    }
  }
  return out;
}
