import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { describePair } from "@zk-bridge/shared";
import {
  bridgedSupply,
  releaseEvents,
  escrow,
  gateEvents,
  headUpdates,
  registryObservations,
  tokens,
} from "../../ponder.schema";
import { registerStateRoutes } from "../../src/api/routes/state";
import { pair } from "../../src/lib/pair";
import { calls, publicClients, respondWith, type QueryCall } from "./support/fake-api";
import { addressOf, hashOf } from "./support/handler-fixtures";

type Tables = Map<unknown, unknown[]>;

const app = new Hono();
registerStateRoutes(app);

const get = async (path: string) => {
  const response = await app.request(path);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

/** Answers a query with the rows of its table. A test adds rows for the tables it uses. */
const serve = (tables: Tables, extra: (call: QueryCall) => unknown[] | undefined = () => undefined) =>
  respondWith((call) => extra(call) ?? (tables.get(call.table) as unknown[] | undefined) ?? []);

const nativeToken = addressOf("aa");
const copyToken = addressOf("bb");
const tokenRows = [
  {
    chainId: 1,
    address: nativeToken,
    name: "Tether",
    symbol: "USDT",
    decimals: 6,
    metadataRead: true,
    isBridgedCopy: false,
    homeChainId: 1,
    homeToken: nativeToken,
    registeredTransactionHash: null,
    registeredBlockNumber: null,
    registeredTimestamp: null,
  },
  {
    chainId: 369,
    address: copyToken,
    name: "Tether",
    symbol: "USDT",
    decimals: 6,
    metadataRead: true,
    isBridgedCopy: true,
    homeChainId: 1,
    homeToken: nativeToken,
    registeredTransactionHash: hashOf("cc"),
    registeredBlockNumber: 12n,
    registeredTimestamp: 120n,
  },
];

beforeEach(() => {
  for (const key of Object.keys(publicClients)) delete publicClients[key];
  serve(new Map());
});

describe("GET /api/pair", () => {
  it("describes the pair and shows no endpoint, because an endpoint URL can carry a key", async () => {
    const { status, body } = await get("/api/pair");
    expect(status).toBe(200);
    expect(body).toEqual(JSON.parse(JSON.stringify(describePair(pair))));
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  });
});

describe("GET /api/heads", () => {
  it("answers one head view for each side of the pair", async () => {
    const { body } = await get("/api/heads");
    expect(body.heads.map((head: { chainId: number }) => head.chainId)).toEqual([1, 369]);
  });
});

describe("GET /api/head-updates", () => {
  const row = {
    chainId: 369,
    slot: 500n,
    headerRoot: hashOf("11"),
    executionBlockHash: hashOf("22"),
    executionBlockNumber: 4_000n,
    transactionHash: hashOf("aa"),
    blockNumber: 100n,
    timestamp: 1_000n,
    gasUsed: 21_000n,
    effectiveGasPrice: 3n,
    costWei: 63_000n,
    poster: addressOf("f0"),
  };

  it("shows numbers for blocks, slots and times and strings for gas, price and cost", async () => {
    serve(new Map([[headUpdates, [row]]]));
    const { body } = await get("/api/head-updates");
    expect(body.items).toEqual([
      {
        chainId: 369,
        slot: 500,
        headerRoot: hashOf("11"),
        executionBlockHash: hashOf("22"),
        executionBlockNumber: 4_000,
        transactionHash: hashOf("aa"),
        blockNumber: 100,
        timestamp: 1_000,
        gasUsed: "21000",
        effectiveGasPrice: "3",
        costWei: "63000",
        poster: addressOf("f0"),
      },
    ]);
  });

  it("filters by no chain and no slot, and limits to 50, when the request names none", async () => {
    await get("/api/head-updates");
    expect(calls[0]?.whereValues).toEqual([]);
    expect(calls[0]?.limit).toBe(50);
  });

  it("sends the chain and the slot of the request to the query", async () => {
    await get("/api/head-updates?chainId=369&before=500&limit=10");
    expect(calls[0]?.whereValues).toEqual([369, 500n]);
    expect(calls[0]?.limit).toBe(10);
  });

  it.each([
    ["500", 500],
    ["1", 1],
    ["0", 50],
    ["501", 50],
    ["1.5", 50],
    ["abc", 50],
  ])("reads limit=%s as %i", async (text, expected) => {
    await get(`/api/head-updates?limit=${text}`);
    expect(calls[0]?.limit).toBe(expected);
  });
});

describe("GET /api/light-client-costs", () => {
  it("answers the totals per chain and per poster from two queries grouped in the database", async () => {
    const perChain = [{ chainId: 369, updates: 2, gasUsed: "42000", costWei: "126000" }];
    const perPoster = [{ chainId: 369, poster: addressOf("f0"), updates: 2, gasUsed: "42000", costWei: "126000" }];
    serve(new Map(), (call) => (call.fields !== undefined && "poster" in call.fields ? perPoster : perChain));
    const { body } = await get("/api/light-client-costs");
    expect(body).toEqual({ perChain, perPoster });
    expect(calls.every((call) => call.grouped && call.table === headUpdates)).toBe(true);
  });
});

describe("GET /api/gate", () => {
  it("answers the sides and the events, newest first, with the limit of the request", async () => {
    const row = {
      chainId: 369,
      kind: "sealed",
      epoch: null,
      version: "0x05000000",
      slot: 900n,
      canary: null,
      transactionHash: hashOf("aa"),
      blockNumber: 100n,
      timestamp: 1_000n,
    };
    serve(new Map([[gateEvents, [row]]]));
    const { body } = await get("/api/gate?limit=7");
    expect(body.sides.map((side: { chainId: number }) => side.chainId)).toEqual([1, 369]);
    expect(body.events).toEqual([
      {
        chainId: 369,
        kind: "sealed",
        epoch: null,
        version: "0x05000000",
        slot: 900,
        canary: null,
        transactionHash: hashOf("aa"),
        blockNumber: 100,
        timestamp: 1_000,
      },
    ]);
    expect(calls.find((call) => call.table === gateEvents)?.limit).toBe(7);
  });
});

describe("GET /api/registry", () => {
  it("answers the observations as numbers and hashes", async () => {
    serve(
      new Map([
        [registryObservations, [{ chainId: 369, version: "0x04000000", slot: 77n, transactionHash: hashOf("aa"), blockNumber: 100n, timestamp: 1_000n }]],
      ]),
    );
    const { body } = await get("/api/registry");
    expect(body).toEqual({
      observations: [{ chainId: 369, version: "0x04000000", slot: 77, transactionHash: hashOf("aa"), blockNumber: 100, timestamp: 1_000 }],
    });
  });
});

describe("GET /api/tokens", () => {
  it("shows each token with its facts and its registration, and null where it has none", async () => {
    serve(new Map([[tokens, tokenRows]]));
    const { body } = await get("/api/tokens");
    expect(body.tokens).toEqual([
      expect.objectContaining({ chainId: 1, address: nativeToken, symbol: "USDT", registeredTransactionHash: null, registeredBlockNumber: null, registeredTimestamp: null }),
      expect.objectContaining({ chainId: 369, address: copyToken, isBridgedCopy: true, registeredTransactionHash: hashOf("cc"), registeredBlockNumber: 12, registeredTimestamp: 120 }),
    ]);
  });
});

describe("GET /api/audit", () => {
  const escrowRow = (token: string, balance: bigint) => ({
    chainId: 1,
    token,
    balance,
    updatedBlockNumber: 9n,
    updatedTimestamp: 90n,
  });
  const supplyRow = {
    chainId: 369,
    token: copyToken,
    nativeToken,
    homeChainId: 1,
    minted: 80n,
    burned: 20n,
    supply: 60n,
    updatedBlockNumber: 9n,
    updatedTimestamp: 90n,
  };
  /** Answers the two pending sums: the forward query has `sourceIsNative = true` first, the backward one `false`. */
  const pending = (forward: string | null | "none", backward: string | null | "none") => (call: QueryCall) => {
    if (call.fields === undefined || !("total" in call.fields)) return undefined;
    const total = call.whereValues[0] === true ? forward : backward;
    return total === "none" ? [] : [{ total }];
  };

  it("adds the bridged supply to the pending amounts and compares the sum with the escrow", async () => {
    serve(new Map<unknown, unknown[]>([[tokens, tokenRows], [escrow, [escrowRow(nativeToken, 100n)]], [bridgedSupply, [supplyRow]]]), pending("30", "10"));
    const { body } = await get("/api/audit");
    expect(body.tokens).toEqual([
      {
        token: expect.objectContaining({ chainId: 1, address: nativeToken }),
        bridgedToken: expect.objectContaining({ chainId: 369, address: copyToken }),
        escrow: "100",
        bridgedSupply: "60",
        pendingForward: "30",
        pendingBackward: "10",
        expectedEscrow: "100",
        difference: "0",
        mismatch: false,
      },
    ]);
    expect(body.generatedNote).toContain("recheck a mismatch once");
  });

  it("reports a mismatch with the signed difference when the escrow holds more than is owed", async () => {
    serve(new Map<unknown, unknown[]>([[escrow, [escrowRow(nativeToken, 130n)]], [bridgedSupply, [supplyRow]]]), pending("30", "10"));
    const { body } = await get("/api/audit");
    expect(body.tokens[0]).toMatchObject({ difference: "30", mismatch: true });
  });

  it("asks the forward sum for the token on its home chain and the backward sum for the copy side", async () => {
    serve(new Map<unknown, unknown[]>([[escrow, [escrowRow(nativeToken, 100n)]], [bridgedSupply, [supplyRow]]]), pending("30", "10"));
    await get("/api/audit");
    const sums = calls.filter((call) => call.fields !== undefined && "total" in call.fields);
    expect(sums.map((call) => call.whereValues.slice(0, 3))).toEqual([
      [true, 1, nativeToken],
      [false, 1, nativeToken],
    ]);
  });

  it("counts no copy, no pending row and a null sum as zero", async () => {
    serve(new Map<unknown, unknown[]>([[escrow, [escrowRow(nativeToken, 5n)]]]), pending("none", null));
    const { body } = await get("/api/audit");
    expect(body.tokens[0]).toMatchObject({
      bridgedToken: null,
      bridgedSupply: "0",
      pendingForward: "0",
      pendingBackward: "0",
      expectedEscrow: "0",
      difference: "5",
      mismatch: true,
    });
  });

  it("does not take a copy of another home chain or another native token for the copy of this token", async () => {
    const stranger = [
      { ...supplyRow, homeChainId: 369 },
      { ...supplyRow, nativeToken: addressOf("dd") },
    ];
    serve(new Map<unknown, unknown[]>([[escrow, [escrowRow(nativeToken, 5n)]], [bridgedSupply, stranger]]), pending("0", "0"));
    const { body } = await get("/api/audit");
    expect(body.tokens[0]).toMatchObject({ bridgedToken: null, bridgedSupply: "0" });
  });

  it("answers an empty list when no native token has an escrow", async () => {
    const { body } = await get("/api/audit");
    expect(body.tokens).toEqual([]);
  });
});

describe("GET /api/escrow", () => {
  it("shows the escrow and the bridged supply with their tokens", async () => {
    serve(
      new Map<unknown, unknown[]>([
        [tokens, tokenRows],
        [escrow, [{ chainId: 1, token: nativeToken, balance: 100n, updatedBlockNumber: 9n, updatedTimestamp: 90n }]],
        [bridgedSupply, [{ chainId: 369, token: copyToken, nativeToken, homeChainId: 1, minted: 80n, burned: 20n, supply: 60n, updatedBlockNumber: 9n, updatedTimestamp: 90n }]],
      ]),
    );
    const { body } = await get("/api/escrow");
    expect(body.escrow).toEqual([expect.objectContaining({ chainId: 1, balance: "100", token: expect.objectContaining({ symbol: "USDT" }) })]);
    expect(body.bridgedSupply).toEqual([expect.objectContaining({ chainId: 369, minted: "80", burned: "20", supply: "60", homeChainId: 1 })]);
  });
});

describe("GET /api/release-events", () => {
  const event = {
    id: "e1",
    chainId: 369,
    kind: "release_failed",
    token: copyToken,
    account: addressOf("55"),
    value: 10n,
    messageId: hashOf("ab"),
    transactionHash: hashOf("aa"),
    blockNumber: 9n,
    timestamp: 90n,
  };

  it("shows the recent failed releases and callback failures when no address is named", async () => {
    serve(new Map<unknown, unknown[]>([[tokens, tokenRows], [releaseEvents, [event]]]));
    const { status, body } = await get("/api/release-events");
    expect(status).toBe(200);
    expect(body).toEqual({
      events: [
        {
          chainId: 369,
          kind: "release_failed",
          token: copyToken,
          account: addressOf("55"),
          value: "10",
          messageId: hashOf("ab"),
          transactionHash: hashOf("aa"),
          timestamp: 90,
        },
      ],
    });
    expect(calls.find((call) => call.table === releaseEvents)?.whereValues).toEqual([]);
  });

  it("sends the address of the request to the query in lowercase", async () => {
    await get("/api/release-events?address=0x70997970C51812dc3A010C7d01b50e0d17dc79C8&limit=4");
    const query = calls.find((call) => call.table === releaseEvents);
    expect(query?.whereValues).toEqual(["0x70997970c51812dc3a010c7d01b50e0d17dc79c8"]);
    expect(query?.limit).toBe(4);
  });

  it("refuses an address that is not an address, and runs no query", async () => {
    const { status, body } = await get("/api/release-events?address=nope");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "invalid address: nope" });
    expect(calls).toEqual([]);
  });

  it("no longer serves the claimables route, because the mediator keeps no claim records", async () => {
    expect((await app.request("/api/claimables")).status).toBe(404);
  });
});
