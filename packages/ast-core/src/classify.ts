/** Sınıf → mimari rol sınıflandırıcısı.
 *
 *  Karar dosya adından DEĞİL, AST'den verilir: dekoratörler (@Controller,
 *  @Injectable, @Entity, @Module), heritage (extends/implements) ve son çare
 *  olarak isim sözleşmeleri. Regex/metin taraması yok — derleyicinin gördüğü
 *  yapı neyse rol odur (deterministik). */

import { ClassDeclaration } from "ts-morph";
import type { NodeKind } from "./types.js";

/** class-validator dekoratörleri — bir property'de bunlardan biri varsa sınıf DTO adayıdır. */
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

/** Sınıfı 21'lik Solarch taksonomisine oturt. null → mimari node değil
 *  (yardımcı sınıf, plain class vb.) — sessizce atlanır. */
export function classifyClass(cls: ClassDeclaration): NodeKind | null {
  const name = cls.getName();
  if (!name) return null;

  // 1. Kesin dekoratör kanıtları — öncelik sırası önemli.
  if (hasDecorator(cls, "Controller")) return "Controller";
  if (hasDecorator(cls, "Module")) return "Module";
  if (hasDecorator(cls, "Entity")) return "Table";

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
    // Varsayılan @Injectable → Service.
    return "Service";
  }

  // DTO: isim sözleşmesi veya class-validator dekoratörlü property'ler.
  if (/(Dto|DTO)$/.test(name) || hasClassValidatorProps(cls)) return "DTO";

  return null;
}
