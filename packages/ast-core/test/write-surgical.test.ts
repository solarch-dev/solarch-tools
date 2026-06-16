/** writeSurgicalBody — iskelet metot gövdesini gerçek kodla değiştirme,
 *  marker'ı koruma, filled imzası, sözleşme yeniden denetimi. */

import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { writeSurgicalBody } from "../src/surgical.js";

const SKELETON = `import { Injectable } from "@nestjs/common";

class NotFoundException extends Error {}
class ConflictException extends Error {}

@Injectable()
export class UserService {
  constructor(private readonly userRepository: { findById(id: string): Promise<unknown> }) {}

  async getById(id: string): Promise<unknown> {
    // @solarch:surgical id=aaaa-1111#getById
    // Retrieves a user by id.
    // throws: NotFoundException
    // deps: userRepository
    throw new Error("NOT_IMPLEMENTED: UserService.getById");
  }
}
`;

function classOf(source: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("user.service.ts", source);
  return sf.getClassOrThrow("UserService");
}

describe("writeSurgicalBody", () => {
  it("gövdeyi değiştirir, marker'ı korur, filled imzası ekler, NOT_IMPLEMENTED'i kaldırır", () => {
    const cls = classOf(SKELETON);
    const body = `const user = await this.userRepository.findById(id);
if (!user) throw new NotFoundException();
return user;`;
    const res = writeSurgicalBody(cls, "getById", body, "2026-06-16T00:00:00Z");

    expect(res.ok).toBe(true);
    expect(res.violations ?? []).toEqual([]);

    const text = cls.getMethodOrThrow("getById").getText();
    expect(text).toContain("// @solarch:surgical id=aaaa-1111#getById"); // marker korundu
    expect(text).toContain("// throws: NotFoundException"); // kontrat korundu
    expect(text).toContain("// @solarch:filled by=ai at=2026-06-16T00:00:00Z"); // imza eklendi
    expect(text).toContain("this.userRepository.findById(id)"); // gerçek kod yazıldı
    expect(text).not.toContain("NOT_IMPLEMENTED"); // iskelet throw'u gitti
  });

  it("bildirilmemiş exception fırlatan gövde → sözleşme ihlali raporlar", () => {
    const cls = classOf(SKELETON);
    const res = writeSurgicalBody(cls, "getById", `throw new ConflictException();`, "2026-06-16T00:00:00Z");
    expect(res.ok).toBe(true);
    expect(res.violations?.some((v) => v.includes("ConflictException"))).toBe(true);
  });

  it("var olmayan region için hata döner", () => {
    const cls = classOf(SKELETON);
    const res = writeSurgicalBody(cls, "nope", "return 1;", "2026-06-16T00:00:00Z");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nope");
  });
});
