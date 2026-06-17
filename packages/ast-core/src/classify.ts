/** Class → architecture role classifier.
 *
 *  Decision comes from AST, NOT file names: decorators (@Controller,
 *  @Injectable, @Entity, @Module), heritage (extends/implements), and as a last
 *  resort naming conventions. No regex/text scanning — whatever structure the
 *  compiler sees is the role (deterministic). */

import { ClassDeclaration } from "ts-morph";
import type { NodeKind } from "./types.js";

/** class-validator decorators — if a property has one, the class is a DTO candidate. */
const CLASS_VALIDATOR_DECORATORS = new Set([
  "IsString", "IsNumber", "IsInt", "IsBoolean", "IsDate", "IsEmail", "IsUrl",
  "IsUUID", "IsEnum", "IsArray", "IsObject", "IsOptional", "IsNotEmpty",
  "IsPositive", "IsNegative", "Min", "Max", "MinLength", "MaxLength",
  "Matches", "Length", "ValidateNested", "IsDefined", "IsIn",
]);

function hasDecorator(cls: ClassDeclaration, name: string): boolean {
  return cls.getDecorator(name) !== undefined;
}

function extendsClass(cls: ClassDeclaration, baseNames: string[]): boolean {
  const ext = cls.getExtends();
  if (!ext) return false;
  const text = ext.getExpression().getText();
  return baseNames.some((b) => text === b || text.endsWith(`.${b}`));
}

function implementsInterface(cls: ClassDeclaration, names: string[]): boolean {
  return cls.getImplements().some((impl) => {
    const text = impl.getExpression().getText();
    return names.some((n) => text === n || text.endsWith(`.${n}`));
  });
}

function hasMethodDecorator(cls: ClassDeclaration, decoratorNames: string[]): boolean {
  return cls.getMethods().some((m) =>
    m.getDecorators().some((d) => decoratorNames.includes(d.getName())),
  );
}

function hasClassValidatorProps(cls: ClassDeclaration): boolean {
  return cls.getProperties().some((p) =>
    p.getDecorators().some((d) => CLASS_VALIDATOR_DECORATORS.has(d.getName())),
  );
}

/** Constructor param tip adlarından enjekte edilen istemci tipini ara. */
function injectsType(cls: ClassDeclaration, typeNames: string[]): boolean {
  const ctor = cls.getConstructors()[0];
  if (!ctor) return false;
  return ctor.getParameters().some((p) => {
    const t = p.getTypeNode()?.getText() ?? "";
    return typeNames.some((n) => t === n || t.endsWith(`.${n}`) || t.startsWith(`${n}<`) || t.startsWith(`${n} `));
  });
}

/** @Inject(CACHE_MANAGER) — cache-manager kanonik enjeksiyonu (kesin Cache kanıtı). */
function injectsCacheManager(cls: ClassDeclaration): boolean {
  const ctor = cls.getConstructors()[0];
  if (!ctor) return false;
  return ctor.getParameters().some((p) =>
    p.getDecorators().some((d) => d.getName() === "Inject" && /CACHE_MANAGER/.test(d.getText())),
  );
}

/** Sınıfı 21'lik Solarch taksonomisine oturt. null → mimari node değil
 *  (yardımcı sınıf, plain class vb.) — sessizce atlanır. */
export function classifyClass(cls: ClassDeclaration): NodeKind | null {
  const name = cls.getName();
  if (!name) return null;

  // 1. Kesin dekoratör kanıtları — öncelik sırası önemli.
  if (hasDecorator(cls, "Controller")) return "Controller";
  if (hasDecorator(cls, "Module")) return "Module";
  if (hasDecorator(cls, "Entity")) return "Table";
  // BullMQ tüketici: @Processor / WorkerHost bir kuyruğu işler → EventHandler.
  // (@Injectable taşımayabilir; aşağıdaki @Injectable bloğuna düşmeden yakala.)
  if (hasDecorator(cls, "Processor") || extendsClass(cls, ["WorkerHost"])) return "EventHandler";

  // Exception: HttpException zinciri veya isim sözleşmesi (dekoratör gerekmez).
  if (
    extendsClass(cls, [
      "HttpException", "BadRequestException", "NotFoundException",
      "UnauthorizedException", "ForbiddenException", "ConflictException",
      "InternalServerErrorException", "Error",
    ]) &&
    /(Exception|Error)$/.test(name)
  ) {
    return "Exception";
  }

  if (hasDecorator(cls, "Injectable")) {
    // Middleware: NestMiddleware sözleşmesi dekoratörden daha kesin kanıt.
    if (implementsInterface(cls, ["NestMiddleware"]) || /Middleware$/.test(name)) return "Middleware";
    // Guard/Interceptor/Pipe — Solarch taksonomisinde Middleware ailesine düşer.
    if (implementsInterface(cls, ["CanActivate", "NestInterceptor", "PipeTransform"])) return "Middleware";
    // Repository: TypeORM Repository kalıtımı veya isim sözleşmesi.
    if (extendsClass(cls, ["Repository", "AbstractRepository"]) || /Repository$/.test(name)) return "Repository";
    // Worker: @Cron/@Interval/@Timeout metodlu sınıf (zamanlanmış iş).
    if (hasMethodDecorator(cls, ["Cron", "Interval", "Timeout"])) return "Worker";
    // EventHandler: @OnEvent/@EventPattern/@MessagePattern dinleyicileri.
    if (hasMethodDecorator(cls, ["OnEvent", "EventPattern", "MessagePattern"])) return "EventHandler";
    if (/(Handler|Listener|Consumer|Subscriber)$/.test(name)) return "EventHandler";
    if (/(Orchestrator|Saga)$/.test(name)) return "Orchestrator";
    // Cache: cache-manager (@Inject(CACHE_MANAGER)) / Redis-Memcached istemcisi ya da isim.
    // (DI_EDGE'deki Service→Cache=CACHES_IN satırını aktive eder — eskiden ölü kod.)
    if (injectsCacheManager(cls) || injectsType(cls, ["Cache", "Redis", "RedisClient", "Cluster", "Memcached"]) || /Cache$/.test(name)) return "Cache";
    // ExternalService: HttpService (@nestjs/axios) sarmalayıcısı ya da isim (Repository değil).
    // (DI_EDGE'deki Service→ExternalService=REQUESTS satırını aktive eder.)
    if (injectsType(cls, ["HttpService"]) || /(ApiClient|Client|ExternalService)$/.test(name)) return "ExternalService";
    // Varsayılan @Injectable → Service.
    return "Service";
  }

  // DTO: isim sözleşmesi veya class-validator dekoratörlü property'ler.
  if (/(Dto|DTO)$/.test(name) || hasClassValidatorProps(cls)) return "DTO";

  return null;
}
