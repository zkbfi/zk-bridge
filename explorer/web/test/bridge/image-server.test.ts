import { beforeEach, describe, expect, it } from "vitest";
import { imageServerProblem, loadImageServer, saveImageServer } from "../../src/bridge/image-server";
import { DEFAULT_IMAGE_SERVER } from "../../src/bridge/image-source";

beforeEach(() => window.localStorage.clear());

describe("the image server setting", () => {
  it("starts on gib.show", () => {
    expect(loadImageServer()).toBe(DEFAULT_IMAGE_SERVER);
    expect(DEFAULT_IMAGE_SERVER).toBe("https://gib.show/image/{chainId}/{address}");
  });

  it("keeps a replacement, and goes back to the default on reset", () => {
    expect(saveImageServer("https://icons.example.org/{chainId}/{address}.png")).toBeNull();
    expect(loadImageServer()).toBe("https://icons.example.org/{chainId}/{address}.png");
    saveImageServer(null);
    expect(loadImageServer()).toBe(DEFAULT_IMAGE_SERVER);
  });

  it("refuses a template that is not https or lacks the placeholders", () => {
    expect(imageServerProblem("http://icons.example.org/{chainId}/{address}")).toMatch(/https/);
    expect(imageServerProblem("https://icons.example.org/{chainId}")).toMatch(/\{address\}/);
    expect(imageServerProblem("not a url {chainId} {address}")).toMatch(/not a URL/);
    expect(saveImageServer("http://x/{chainId}/{address}")).toMatch(/https/);
    expect(loadImageServer()).toBe(DEFAULT_IMAGE_SERVER);
  });

  it("ignores a stored value that is no longer valid", () => {
    window.localStorage.setItem("zk-bridge-explorer.image-server", "javascript:alert(1)");
    expect(loadImageServer()).toBe(DEFAULT_IMAGE_SERVER);
  });
});
