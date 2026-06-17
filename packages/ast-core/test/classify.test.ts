import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { classifyClass } from "../src/classify.js";

function firstClass(src: string) {
  const p = new Project({ useInMemoryFileSystem: true });
  return p.createSourceFile("c.ts", src).getClasses()[0]!;
}

describe("classifyClass — BullMQ tüketici (Processor / WorkerHost) → EventHandler", () => {
  it("@Processor dekoratörlü sınıf (@Injectable taşımasa da) EventHandler", () => {
    const cls = firstClass(`
import { Processor, WorkerHost } from "@nestjs/bullmq";
@Processor("ComplaintAnalysisQueue")
export class ComplaintAnalysisHandler extends WorkerHost {
  async process(): Promise<void> {}
}`);
    expect(classifyClass(cls)).toBe("EventHandler");
  });

  it("WorkerHost extend eden sınıf (Processor'sız) da EventHandler", () => {
    const cls = firstClass(`
import { WorkerHost } from "@nestjs/bullmq";
export class FooConsumer extends WorkerHost {
  async process(): Promise<void> {}
}`);
    expect(classifyClass(cls)).toBe("EventHandler");
  });

  it("@Controller hâlâ Controller (regresyon)", () => {
    const cls = firstClass(`
import { Controller } from "@nestjs/common";
@Controller("x")
export class XController {}`);
    expect(classifyClass(cls)).toBe("Controller");
  });
});
