import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { syncProperties, readSourceProperties, BOUND_MARKER } from "../src/write.js";
import { classifyClass } from "../src/classify.js";

const ENTITY = `
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

@Entity("products")
export class Product {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ length: 200 })
  title: string;

  @Column()
  price: number;

  @Column({ nullable: true })
  description?: string;

  @ManyToOne(() => Category)
  category: Category;
}
class Category {}
`;

const DTO = `
import { IsString } from "class-validator";

export class ProductDto {
  @IsString()
  title: string;

  /** kullanıcının elle yazdığı özel alan — Solarch dokunmaz */
  displayLabel: string;
}
`;

function setup(dtoSource = DTO) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { experimentalDecorators: true } });
  const entityFile = project.createSourceFile("product.entity.ts", ENTITY);
  const dtoFile = project.createSourceFile("product.dto.ts", dtoSource);
  return {
    project,
    entity: entityFile.getClassOrThrow("Product"),
    dto: dtoFile.getClassOrThrow("ProductDto"),
    dtoFile,
  };
}

describe("readSourceProperties", () => {
  it("reads entity columns, skips relations", () => {
    const { entity } = setup();
    const props = readSourceProperties(entity);
    expect(props.map((p) => p.name)).toEqual(["id", "title", "price", "description"]);
    expect(props.find((p) => p.name === "price")).toMatchObject({ tsType: "number", validator: "IsNumber" });
    expect(props.find((p) => p.name === "description")).toMatchObject({ optional: true });
  });
});

describe("syncProperties (live binding çekirdeği)", () => {
  it("injects missing properties with marker + validators, leaves custom logic alone", () => {
    const { entity, dto, dtoFile } = setup();
    const result = syncProperties(entity, dto);

    expect(result.added.sort()).toEqual(["description", "id", "price"]);
    expect(result.upToDate).toEqual(["title"]);
    expect(result.conflicts).toEqual([]);

    const text = dtoFile.getFullText();
    // Marker yorumu eklenen her property'de var.
    expect(text).toContain(`${BOUND_MARKER} from=Product`);
    // Validator dili korunur: hedef class-validator kullanıyordu → yeni alanlara da eklendi.
    expect(text).toContain("@IsNumber()");
    expect(text).toContain("@IsOptional()");
    // import güncellendi.
    expect(text).toMatch(/from "class-validator"/);
    // Kullanıcının elle yazdığı alan duruyor.
    expect(text).toContain("displayLabel: string");
  });

  it("round-trip: ikinci senkron hiçbir şey değiştirmez (idempotent)", () => {
    const { entity, dto } = setup();
    syncProperties(entity, dto);
    const second = syncProperties(entity, dto);
    expect(second.added).toEqual([]);
    expect(second.changed).toBe(false);
    expect(second.upToDate.sort()).toEqual(["description", "id", "price", "title"]);
  });

  it("tip uyuşmazlığında üzerine yazmaz, çatışma raporlar", () => {
    const conflictDto = `
export class ProductDto {
  /** kullanıcı price'ı bilerek string tutuyor */
  price: string;
}
`;
    const { entity, dto } = setup(conflictDto);
    const result = syncProperties(entity, dto);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ property: "price" });
    // price hâlâ string — dokunulmadı.
    expect(dto.getPropertyOrThrow("price").getTypeNode()?.getText()).toBe("string");
  });

  it("fields listesi verilirse yalnız o alanlar senkronlanır", () => {
    const { entity, dto } = setup();
    const result = syncProperties(entity, dto, ["id"]);
    expect(result.added).toEqual(["id"]);
    expect(dto.getProperty("price")).toBeUndefined();
  });

  it("round-trip: enjekte edilen DTO yeniden taranınca alanlar grafa girer", () => {
    const { entity, dto } = setup();
    syncProperties(entity, dto);
    // classify hâlâ DTO diyor ve alanlar okunuyor — yazma okuma ile uyumlu.
    expect(classifyClass(dto)).toBe("DTO");
    const names = dto.getProperties().map((p) => p.getName()).sort();
    expect(names).toEqual(["description", "displayLabel", "id", "price", "title"]);
  });
});
