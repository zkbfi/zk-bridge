import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_IMAGE_SERVER } from "../../src/bridge/image-source";
import { loadImageServer, saveImageServer } from "../../src/bridge/image-server";

afterEach(() => vi.restoreAllMocks());

describe("the image server when the browser's storage fails", () => {
  it("uses the default when storage throws on read", () => {
    expect(loadImageServer({ getItem: () => { throw new Error("denied"); } })).toBe(DEFAULT_IMAGE_SERVER);
  });

  it("uses the default and keeps the choice for this visit only when the browser has no storage at all", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadImageServer()).toBe(DEFAULT_IMAGE_SERVER);
    expect(saveImageServer("https://img.example/{chainId}/{address}.png")).toBeNull();
  });

  it("does not fail when storage throws on write", () => {
    const storage = { setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("full"); } };
    expect(saveImageServer("https://img.example/{chainId}/{address}.png", storage)).toBeNull();
    expect(saveImageServer(null, storage)).toBeNull();
  });
});
