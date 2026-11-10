import { describe, expect, it } from "vitest";
import { checkSvg, rasterKind } from "../../src/bridge/svg-check";

describe("rasterKind", () => {
  it("names PNG, JPEG and WebP by their magic bytes and nothing else", () => {
    expect(rasterKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("png");
    expect(rasterKind(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe("jpg");
    expect(rasterKind(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("webp");
    expect(rasterKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x00]))).toBeNull();
    expect(rasterKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBe("png");
    expect(rasterKind(Uint8Array.from([0x89, 0x50]))).toBeNull();
    expect(rasterKind(Uint8Array.from([0x89, 0x51, 0, 0]))).toBeNull();
    expect(rasterKind(Uint8Array.from([0xff, 0x00]))).toBeNull();
    expect(rasterKind(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x00]))).toBeNull();
    expect(rasterKind(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0x57, 0x45, 0x00, 0x50]))).toBeNull();
    expect(rasterKind(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0x57, 0x00, 0x42, 0x50]))).toBeNull();
    expect(rasterKind(new Uint8Array(0))).toBeNull();
  });
});

describe("checkSvg, the rest of the walk", () => {
  it("accepts a byte order mark and an XML declaration, comments, titles with text, single quotes and self-closing tags", () => {
    expect(checkSvg('﻿<?xml version="1.0"?><!-- a --><svg xmlns=\'http://www.w3.org/2000/svg\'><title>Icon</title><g><path d="M0 0"/></g></svg>')).toBeNull();
  });
  it("refuses text outside a title, a malformed close, mismatched nesting, a second root, unclosed tags and non-SVG text", () => {
    expect(checkSvg("<svg>words</svg>")).toBe("it has text outside a title");
    expect(checkSvg("<svg></ svg>")).toBe("a closing tag is malformed");
    expect(checkSvg("<svg><g></svg></g>")).toBe("the tags do not nest");
    expect(checkSvg("<svg></svg><svg></svg>")).toBe("it is not a single SVG");
    expect(checkSvg("<g></g>")).toBe("it is not a single SVG");
    expect(checkSvg("<svg><g>")).toBe("a tag is not closed");
    expect(checkSvg("just words")).toBe("it has text outside a title");
    expect(checkSvg("")).toBe("it is not an SVG");
    expect(checkSvg("<svg <>")).toBe("a tag is malformed");
    expect(checkSvg("<svg")).toBe("a tag is malformed");
    expect(checkSvg("<1svg></1svg>")).toBe("a tag is malformed");
    expect(checkSvg("<svg><!x></svg>")).toBe("it has a markup declaration");
    expect(checkSvg("<svg>&nbsp;</svg>")).toBe("it uses a character reference");
  });
  it("refuses attributes: unknown, a foreign namespace, an outside link, an outside url(), an escape", () => {
    expect(checkSvg('<svg data-x="1"></svg>')).toMatch(/is not allowed/);
    expect(checkSvg('<svg xmlns="http://evil.example"></svg>')).toMatch(/namespace/);
    expect(checkSvg('<svg><linearGradient xlink:href="https://x.example/a"/></svg>')).toBe("a link points outside the file");
    expect(checkSvg('<svg><rect fill="url(https://x.example/a)"/></svg>')).toBe("a url() points outside the file");
    expect(checkSvg('<svg><rect fill="url( \'#ok\' )"/></svg>')).toBeNull();
    expect(checkSvg('<svg><rect fill="red\\"/></svg>')).toBe("a value carries an escape or code");
    expect(checkSvg('<svg><rect fill="javascript:x"/></svg>')).toBe("a value carries an escape or code");
    expect(checkSvg('<svg><rect fill=""/></svg>')).toBeNull();
  });
});
