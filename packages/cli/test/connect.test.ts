import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { connectCommand } from "../src/commands/connect.js";
import * as config from "../src/config.js";
import * as login from "../src/commands/login.js";
import * as link from "../src/commands/link.js";

describe("connectCommand", () => {
  beforeEach(() => {
    vi.spyOn(config, "readCredentials").mockReturnValue(null);
    vi.spyOn(config, "readProjectConfig").mockReturnValue(null);
    vi.spyOn(login, "loginCommand").mockResolvedValue(undefined);
    vi.spyOn(link, "linkCommand").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("runs login then link when nothing is configured", async () => {
    vi.spyOn(config, "readCredentials")
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ apiUrl: "http://localhost:4000/api/v1", apiKey: "slk_test" });

    await connectCommand({ rootDir: "/tmp/repo" });

    expect(login.loginCommand).toHaveBeenCalledOnce();
    expect(link.linkCommand).toHaveBeenCalledWith({ project: undefined, rootDir: "/tmp/repo" });
  });

  it("skips login when credentials exist but still links", async () => {
    vi.spyOn(config, "readCredentials").mockReturnValue({
      apiUrl: "http://localhost:4000/api/v1",
      apiKey: "slk_test",
    });

    await connectCommand({ rootDir: "/tmp/repo" });

    expect(login.loginCommand).not.toHaveBeenCalled();
    expect(link.linkCommand).toHaveBeenCalledOnce();
  });

  it("shows status when already connected", async () => {
    vi.spyOn(config, "readCredentials").mockReturnValue({
      apiUrl: "http://localhost:4000/api/v1",
      apiKey: "slk_test",
    });
    vi.spyOn(config, "readProjectConfig").mockReturnValue({
      projectId: "p1",
      projectName: "My API",
      bindings: [],
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await connectCommand({ rootDir: "/tmp/repo" });

    expect(login.loginCommand).not.toHaveBeenCalled();
    expect(link.linkCommand).not.toHaveBeenCalled();
    expect(log.mock.calls.some((c) => String(c[0]).includes("Already connected"))).toBe(true);
  });
});
