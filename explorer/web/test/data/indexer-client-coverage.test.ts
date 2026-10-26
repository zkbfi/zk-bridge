import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndexerClient, NOT_FOUND } from "../../src/data/indexer-client";
import { IndexerResponseError } from "../../src/data/json";

const MESSAGE_ID = `0x${"ab".repeat(32)}` as const;
const TRANSACTION = `0x${"CD".repeat(32)}` as const;

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (response: Partial<Response> & { readonly status: number }) => {
  const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) => response as Response);
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
};

describe("the default requester of the indexer client", () => {
  it("gets the message route with a timeout and no body, and returns the parsed json", async () => {
    const fetchStub = stubFetch({ status: 200, ok: true, json: async () => ({ marker: 1 }) });
    const client = createIndexerClient({ baseUrl: "http://indexer.test/" });
    await expect(client.message(MESSAGE_ID)).rejects.toThrow(IndexerResponseError);
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe(`http://indexer.test/api/messages/${MESSAGE_ID}`);
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("posts the query as json to the graphql route and reads the identifier of the first item", async () => {
    const fetchStub = stubFetch({ status: 200, ok: true, json: async () => ({ data: { messagess: { items: [{ messageId: MESSAGE_ID }, { messageId: "0xother" }] } } }) });
    const found = await createIndexerClient({ baseUrl: "http://indexer.test" }).findMessageByTransaction(TRANSACTION);
    expect(found).toBe(MESSAGE_ID);
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe("http://indexer.test/graphql");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init?.body as string).query).toContain(`"${TRANSACTION.toLowerCase()}"`);
  });

  it("turns a 404 answer into the not found marker, so the client gives null", async () => {
    stubFetch({ status: 404, ok: false });
    const client = createIndexerClient({ baseUrl: "http://indexer.test" });
    expect(await client.message(MESSAGE_ID)).toBeNull();
    expect(await client.findMessageByTransaction(TRANSACTION)).toBeNull();
  });

  it("rejects any other bad status with the status and the path, never the query string or the host", async () => {
    stubFetch({ status: 503, ok: false });
    await expect(createIndexerClient({ baseUrl: "http://indexer.test:9/base" }).message(MESSAGE_ID)).rejects.toThrow(
      new IndexerResponseError(`The indexer answered 503 for /base/api/messages/${MESSAGE_ID}.`),
    );
  });

  it("exposes a unique not found marker", () => {
    expect(NOT_FOUND.toString()).toBe("Symbol(not found)");
  });
});

describe("the graphql lookup answer is a trust boundary", () => {
  const lookup = (answer: unknown) => createIndexerClient({ baseUrl: "http://indexer.test", request: async () => answer }).findMessageByTransaction(TRANSACTION);

  it("refuses an answer of the wrong shape and names the part", async () => {
    await expect(lookup(null)).rejects.toThrow("The graphql answer is not an object.");
    await expect(lookup({})).rejects.toThrow("The graphql data is not an object.");
    await expect(lookup({ data: {} })).rejects.toThrow("The messagess is not an object.");
    await expect(lookup({ data: { messagess: {} } })).rejects.toThrow("The items is not a list.");
    await expect(lookup({ data: { messagess: { items: [5] } } })).rejects.toThrow("The item is not an object.");
  });
});
