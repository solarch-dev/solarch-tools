import { describe, expect, it } from "vitest";
import { canvasUrl } from "../src/commands/init.js";

describe("canvasUrl", () => {
  it("prod api host'unu app host'una çevirip /p/<id> ekler", () => {
    expect(canvasUrl("https://api.solarch.dev/api/v1", "abc-123")).toBe("https://app.solarch.dev/p/abc-123");
  });

  it("api. öneki olmayan host'u olduğu gibi bırakır (localhost/dev)", () => {
    expect(canvasUrl("http://localhost:3001/api/v1", "p1")).toBe("http://localhost:3001/p/p1");
  });

  it("geçersiz URL'de göreli path'e düşer", () => {
    expect(canvasUrl("not a url", "p1")).toBe("/p/p1");
  });
});
