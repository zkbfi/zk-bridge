import { describe, expect, it, vi } from "vitest";
import { BoardReadError, postJsonResponse, readBoardMessages, type BoardJsonFetcher } from "../src/msgboard/board-http.js";
import { word } from "./support/prover-builders.js";

const category = word(0x31);
const other = word(0x32);
const message = (kind: string, seed: number) => ({ category: kind, data: "0xaa", hash: word(seed) });

const answering = (body: unknown, status = 200): BoardJsonFetcher => vi.fn(async () => ({ status, body }));

describe("readBoardMessages", () => {
  it("readBoardMessages reads msgboard_content over HTTP and keeps only the category", async () => {
    const fetchJson = answering({ jsonrpc: "2.0", id: 1, result: { [category]: [message(category, 1)], [other]: [message(other, 2)] } });
    const messages = await readBoardMessages({ boardUrl: "wss://board.example.org/rpc", category, fetchJson });
    expect(messages).toEqual([message(category, 1)]);
    const [url, init] = vi.mocked(fetchJson).mock.calls[0]!;
    expect(url).toBe("https://board.example.org/rpc");
    expect(JSON.parse(init!.body)).toEqual({ jsonrpc: "2.0", id: 1, method: "msgboard_content", params: [{ category }] });
  });

  it("compares the category without regard to letter case", async () => {
    const upper = category.replace("0x", "0x").toUpperCase().replace("0X", "0x");
    const fetchJson = answering({ result: { a: [message(upper, 1)] } });
    expect(await readBoardMessages({ boardUrl: "http://127.0.0.1:1", category, fetchJson })).toHaveLength(1);
  });

  it("changes a plain socket scheme to a plain request scheme", async () => {
    const fetchJson = answering({ result: {} });
    await readBoardMessages({ boardUrl: "ws://127.0.0.1:1/x", category, fetchJson });
    expect(vi.mocked(fetchJson).mock.calls[0]![0]).toBe("http://127.0.0.1:1/x");
  });

  it.each([
    ["a status that is not a success", answering({}, 502), "status 502"],
    ["an answer that is not an object", answering(null), "not a JSON object"],
    ["a JSON-RPC error", answering({ error: { message: "no" } }), "refused msgboard_content"],
    ["no result object", answering({ result: 5 }), "no result object"],
    ["a null result", answering({ result: null }), "no result object"],
    ["a message of an unknown shape", answering({ result: { a: [{ category, data: 5, hash: word(1) }] } }), "unknown shape"],
    ["a message that is not an object", answering({ result: { a: [7] } }), "unknown shape"],
    ["a null message", answering({ result: { a: [null] } }), "unknown shape"],
  ])("refuses %s", async (_name, fetchJson, text) => {
    await expect(readBoardMessages({ boardUrl: "https://board.example.org", category, fetchJson })).rejects.toThrow(BoardReadError);
    await expect(readBoardMessages({ boardUrl: "https://board.example.org", category, fetchJson })).rejects.toThrow(text);
  });
});

describe("postJsonResponse", () => {
  it("posts the body and returns the status with the parsed answer", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const answer = await postJsonResponse("https://board.example.org", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(answer).toEqual({ status: 200, body: { ok: 1 } });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST", body: "{}" });
    vi.unstubAllGlobals();
  });

  it("gives a null body for an answer that is not JSON, and sends a plain request without an init", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await postJsonResponse("https://board.example.org")).toEqual({ status: 500, body: null });
    expect(fetchMock.mock.calls[0]![1]).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
