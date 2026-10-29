import { describe, expect, it } from "vitest";
import { packDirectory } from "../src/car.ts";
import { assetReferences, siteLoadProblems } from "../src/site.ts";
import { sampleSite, temporaryDirectory, writeTree } from "./helpers.ts";

describe("siteLoadProblems", () => {
  it("each site loads from its archive under /ipfs/<cid>/ with no failed asset", async () => {
    const site = await temporaryDirectory();
    await writeTree(site, sampleSite);
    const { carBytes } = await packDirectory(site);
    expect(await siteLoadProblems(carBytes)).toEqual([]);
  });

  it("names every asset that fails: a root path, a missing file, a directory, a missing index.html", async () => {
    const site = await temporaryDirectory();
    await writeTree(site, {
      "index.html": `<script src="/assets/main.js"></script><link href="./missing.css"><img src="./assets"><a href="./">home</a>`,
      "assets/main.js": "",
    });
    expect(await siteLoadProblems((await packDirectory(site)).carBytes)).toEqual([
      "/assets/main.js gave 404",
      "./missing.css gave 404",
      "./assets gave 404",
    ]);
    const bare = await temporaryDirectory();
    await writeTree(bare, { "readme.txt": "x" });
    expect(await siteLoadProblems((await packDirectory(bare)).carBytes)).toEqual(["index.html gave 404"]);
  });
});

describe("assetReferences", () => {
  it("keeps local src and href values and drops links, anchors and data", () => {
    expect(assetReferences(sampleSite["index.html"]!)).toEqual(["./assets/style.css", "./assets/main.js"]);
    expect(assetReferences(`<a href='mailto:x'></a><img src="//cdn.example/x.png"><img src='./a.png?v=1#x'>`)).toEqual([
      "./a.png?v=1#x",
    ]);
  });
});
