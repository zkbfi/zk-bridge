import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSvg } from "../../src/bridge/svg-check";

const shipped = (file: string): string => readFileSync(join(process.cwd(), "public", "icons", file), "utf8");

describe("checkSvg: what it accepts", () => {
  it("accepts the icons the release ships", () => {
    expect(checkSvg(shipped("1.svg"))).toBeNull();
    expect(checkSvg(shipped("11155111.svg"))).toBeNull();
  });

  it("accepts a local gradient and clip path by #fragment", () => {
    expect(checkSvg('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="1" height="1"/></clipPath></defs><g clip-path="url(#c)"><rect fill="url(#g)" width="1" height="1"/></g></svg>')).toBeNull();
  });
});

describe("checkSvg: every bypass class is refused", () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ["a script", "<svg><script>alert(1)</script></svg>"],
    ["an event attribute", '<svg onload="x()"></svg>'],
    ["an event attribute in odd case", '<svg OnLoAd="x()"></svg>'],
    ["an entity-encoded event name", '<svg><rect o&#110;load="x()"/></svg>'],
    ["an entity-encoded href", '<svg><linearGradient href="&#106;avascript:x"/></svg>'],
    ["a DOCTYPE with an entity", '<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>'],
    ["CDATA", "<svg><title><![CDATA[<script>x</script>]]></title></svg>"],
    ["a processing instruction", '<svg><?xml-stylesheet href="https://evil.example/s.css"?></svg>'],
    ["an external <use>", '<svg><use href="https://evil.example/s.svg#a"/></svg>'],
    ["a <use> even to a fragment", '<svg><use href="#a"/></svg>'],
    ["a style attribute with url()", '<svg><rect style="fill:url(https://evil.example/a)"/></svg>'],
    ["a <style> element", "<svg><style>@import url(https://evil.example/s.css);</style></svg>"],
    ["an external url() in fill", '<svg><rect fill="url(https://evil.example/a#g)"/></svg>'],
    ["an <animate> that rewrites href", '<svg><a><animate attributeName="href" to="javascript:alert(1)"/></a></svg>'],
    ["a <set> that rewrites href", '<svg><set attributeName="href" to="javascript:x"/></svg>'],
    ["a foreignObject", "<svg><foreignObject><div/></foreignObject></svg>"],
    ["a namespaced foreignObject", '<svg xmlns:h="http://www.w3.org/1999/xhtml"><h:script>x</h:script></svg>'],
    ["an <image>", '<svg><image href="https://evil.example/x.png"/></svg>'],
    ["an external xlink:href on a gradient", '<svg><linearGradient xlink:href="https://evil.example/g.svg#g"/></svg>'],
    ["a foreign xmlns", '<svg xmlns="http://www.w3.org/1999/xhtml"></svg>'],
    ["text outside a title", "<svg>hello</svg>"],
    ["two roots", "<svg></svg><svg></svg>"],
    ["something that is not an SVG", "not an svg"],
  ];
  for (const [name, text] of refused) {
    it(`refuses ${name}`, () => {
      expect(checkSvg(text)).not.toBeNull();
    });
  }
});
