import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsView, STORAGE_WARNING, connectionTargets, withUserUrl, withoutUserUrl } from "../../src/views/ConnectionsView";
import { CONNECTION_STORAGE_KEY, loadUserConnections } from "../../src/config/connection-storage";
import { disconnectedWallet, walletWrapper } from "../app/support";
import { renderPage } from "../render";
import { FIRST_CHAIN, SECOND_CHAIN, fallbackStatus, liveServices } from "../support/live";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";

const SECRET = "FAKEKEY1234567890";
const SECRET_URL = `https://rpc.example.org/v2/${SECRET}`;

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

/** Makes `fetch` answer the RPC call with a chain identifier. */
const stubChain = (chainId: number) => {
  const fetchStub = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${chainId.toString(16)}` }), { status: 200 }));
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
};

const renderLive = (options: Parameters<typeof liveServices>[0] = {}, props: Parameters<typeof ConnectionsView>[0] = {}) => {
  const services = liveServices(options);
  const result = render(<ConnectionsView {...props} />, { wrapper: walletWrapper({ wallet: disconnectedWallet(), services }) });
  return { services, ...result };
};

const region = (name: string) => within(screen.getByRole("region", { name }));

const typeInto = async (regionName: string, text: string) => {
  const input = region(regionName).getByLabelText(`New ${regionName}`);
  await userEvent.click(input);
  await userEvent.paste(text);
  return input;
};

const attributeValues = (): string[] => Array.from(document.body.querySelectorAll("*")).flatMap((element) => Array.from(element.attributes).map((attribute) => attribute.value));

describe("the connections page of a live page", () => {
  it("shows each URL in force in masked form with its source, for the indexer and for each chain", () => {
    renderLive({ variables: { VITE_EXPLORER_RPC_URL_1: SECRET_URL } });
    expect(region("Indexer URL").getByText(/http:\/\/localhost:42069/)).toHaveTextContent("(default)");
    expect(region("Ethereum RPC URL").getByText(/rpc\.example\.org/)).toHaveTextContent("(from the environment)");
    expect(region("PulseChain RPC URL").getByText(/registry\.example\.org/)).toHaveTextContent("(default)");
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("always warns that the browser keeps the URLs in clear text and that a key should be replaceable", () => {
    renderLive();
    expect(screen.getByText(STORAGE_WARNING)).toBeInTheDocument();
    expect(STORAGE_WARNING).toMatch(/clear text/);
    expect(STORAGE_WARNING).toMatch(/can replace/);
  });

  it("hides what the user types: the field is a password field with autocomplete off", () => {
    renderLive();
    const input = region("Ethereum RPC URL").getByLabelText("New Ethereum RPC URL");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
  });

  it("keeps Test and Save off until something is typed, and Forget off until the user set a URL", () => {
    renderLive();
    const row = region("Ethereum RPC URL");
    expect(row.getByRole("button", { name: "Test" })).toBeDisabled();
    expect(row.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(row.getByRole("button", { name: "Forget my setting" })).toBeDisabled();
  });

  it("tests a URL without saving it, and says the chain that the node reports", async () => {
    const fetchStub = stubChain(FIRST_CHAIN);
    const { services } = renderLive();
    await typeInto("Ethereum RPC URL", "https://eth.example.org");
    await userEvent.click(region("Ethereum RPC URL").getByRole("button", { name: "Test" }));
    expect(await screen.findByText("The node reports chain 1.")).toBeInTheDocument();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(CONNECTION_STORAGE_KEY)).toBeNull();
    expect(services.connection?.user().rpcUrls).toEqual({});
  });

  it("saves an RPC URL only after the test passes, then keeps it in storage and puts it in use", async () => {
    stubChain(FIRST_CHAIN);
    const { services } = renderLive();
    await typeInto("Ethereum RPC URL", SECRET_URL);
    await userEvent.click(region("Ethereum RPC URL").getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved. The page uses this URL now.")).toBeInTheDocument();
    expect(loadUserConnections(window.localStorage).rpcUrls).toEqual({ [FIRST_CHAIN]: SECRET_URL });
    expect(services.connection?.resolved().rpcUrls[FIRST_CHAIN]).toEqual({ value: SECRET_URL, source: "user" });
    expect(services.fake.inputs).toHaveLength(2);
    expect(region("Ethereum RPC URL").getByText(/rpc\.example\.org/)).toHaveTextContent("(set by you)");
    expect(region("Ethereum RPC URL").getByLabelText("New Ethereum RPC URL")).toHaveValue("");
    expect(region("Ethereum RPC URL").getByRole("button", { name: "Forget my setting" })).toBeEnabled();
  });

  it("refuses to save a URL of another chain, says why, and saves nothing", async () => {
    stubChain(SECOND_CHAIN);
    const { services } = renderLive();
    await typeInto("Ethereum RPC URL", SECRET_URL);
    await userEvent.click(region("Ethereum RPC URL").getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Not saved. The node is on chain 369, not chain 1.")).toBeInTheDocument();
    expect(window.localStorage.getItem(CONNECTION_STORAGE_KEY)).toBeNull();
    expect(services.connection?.user().rpcUrls).toEqual({});
    expect(services.fake.inputs).toHaveLength(1);
  });

  it("refuses to save a URL that does not answer, and keeps the key out of the message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError(`fetch failed for ${SECRET_URL}`))));
    renderLive();
    await typeInto("Ethereum RPC URL", SECRET_URL);
    await userEvent.click(region("Ethereum RPC URL").getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^Not saved\. eth_chainId did not complete/);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(window.localStorage.getItem(CONNECTION_STORAGE_KEY)).toBeNull();
  });

  it("refuses a malformed URL before any request", async () => {
    const fetchStub = stubChain(FIRST_CHAIN);
    renderLive();
    await typeInto("Ethereum RPC URL", "ftp://eth.example.org");
    await userEvent.click(region("Ethereum RPC URL").getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The RPC URL must start with http:// or https://.");
    expect(fetchStub).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(CONNECTION_STORAGE_KEY)).toBeNull();
  });

  it("says that a malformed URL fails the test, with the same message", async () => {
    renderLive();
    await typeInto("Ethereum RPC URL", "not a url");
    await userEvent.click(region("Ethereum RPC URL").getByRole("button", { name: "Test" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The RPC URL must not hold a space, a quote or a backslash.");
  });

  it("forgets a user setting: the storage drops it and the next source returns", async () => {
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ indexerUrl: null, rpcUrls: { 369: "https://mine.example.org/pls" } }));
    const { services } = renderLive();
    expect(region("PulseChain RPC URL").getByText(/mine\.example\.org/)).toHaveTextContent("(set by you)");
    await userEvent.click(region("PulseChain RPC URL").getByRole("button", { name: "Forget my setting" }));
    expect(loadUserConnections(window.localStorage).rpcUrls).toEqual({});
    expect(services.connection?.resolved().rpcUrls[SECOND_CHAIN]?.source).toBe("default");
    expect(region("PulseChain RPC URL").getByText(/registry\.example\.org/)).toHaveTextContent("(default)");
  });

  it("keeps the other entries when it forgets one", async () => {
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ indexerUrl: "https://mine.example.org", rpcUrls: { 1: "https://eth.example.org", 369: "https://pls.example.org" } }));
    renderLive();
    await userEvent.click(region("Ethereum RPC URL").getByRole("button", { name: "Forget my setting" }));
    expect(loadUserConnections(window.localStorage)).toEqual({ indexerUrl: "https://mine.example.org", rpcUrls: { 369: "https://pls.example.org" } });
  });

  it("saves an indexer URL after the form check, and does not need the indexer to answer", async () => {
    const fetchStub = stubChain(1);
    const { services } = renderLive();
    await typeInto("Indexer URL", "https://indexer.example.org/");
    await userEvent.click(region("Indexer URL").getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved. The page uses this URL now.")).toBeInTheDocument();
    expect(services.connection?.user().indexerUrl).toBe("https://indexer.example.org");
    expect(loadUserConnections(window.localStorage).indexerUrl).toBe("https://indexer.example.org");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses a malformed indexer URL", async () => {
    renderLive();
    await typeInto("Indexer URL", "nonsense");
    await userEvent.click(region("Indexer URL").getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The indexer URL is not a URL.");
  });

  it("tests an indexer URL against its heads route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ heads: [] }), { status: 200 })));
    renderLive();
    await typeInto("Indexer URL", "https://indexer.example.org");
    await userEvent.click(region("Indexer URL").getByRole("button", { name: "Test" }));
    expect(await screen.findByText("The indexer answers /api/heads.")).toBeInTheDocument();
  });

  it("shows which source answers, follows a change of source, and checks the indexer on request", async () => {
    const { services } = renderLive();
    expect(screen.getByText("Using: indexer")).toBeInTheDocument();
    services.fake.setStatus(fallbackStatus("indexer unreachable"));
    expect(await screen.findByText("Using: RPC fallback: indexer unreachable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check the indexer now" }));
    await waitFor(() => expect(services.fake.made[0]?.checkNow).toHaveBeenCalledTimes(1));
  });

  it("asks the newest connection to check, after the settings changed", async () => {
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ indexerUrl: null, rpcUrls: { 369: "https://mine.example.org/pls" } }));
    const { services } = renderLive();
    await userEvent.click(region("PulseChain RPC URL").getByRole("button", { name: "Forget my setting" }));
    await userEvent.click(screen.getByRole("button", { name: "Check the indexer now" }));
    await waitFor(() => expect(services.fake.made[1]?.checkNow).toHaveBeenCalledTimes(1));
    expect(services.fake.made[0]?.checkNow).not.toHaveBeenCalled();
  });
});

describe("a storage that fails", () => {
  const failingStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("blocked");
    },
  };

  it("warns that the setting works only until the page closes, and still uses the setting", async () => {
    stubChain(FIRST_CHAIN);
    const { services } = renderLive({ storage: failingStorage }, { storage: failingStorage });
    expect(screen.queryByText(/works only until the page closes/)).toBeNull();
    await typeInto("Ethereum RPC URL", "https://eth.example.org");
    await userEvent.click(region("Ethereum RPC URL").getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The browser did not keep your setting. It works only until the page closes.")).toBeInTheDocument();
    expect(services.connection?.resolved().rpcUrls[FIRST_CHAIN]?.source).toBe("user");
  });

  it("takes the warning away after a save that works", async () => {
    stubChain(FIRST_CHAIN);
    let broken = true;
    const flaky = {
      getItem: () => null,
      setItem: () => {
        if (broken) throw new Error("blocked");
      },
    };
    renderLive({ storage: flaky }, { storage: flaky });
    await typeInto("Ethereum RPC URL", "https://eth.example.org");
    await userEvent.click(region("Ethereum RPC URL").getByRole("button", { name: "Save" }));
    await screen.findByText(/works only until the page closes/);
    broken = false;
    await userEvent.click(region("Ethereum RPC URL").getByRole("button", { name: "Forget my setting" }));
    await waitFor(() => expect(screen.queryByText(/works only until the page closes/)).toBeNull());
  });

  it("warns when the page has no storage at all", async () => {
    renderLive({ storage: null }, { storage: null });
    await typeInto("Indexer URL", "https://indexer.example.org");
    await userEvent.click(region("Indexer URL").getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/works only until the page closes/)).toBeInTheDocument();
  });
});

describe("the secret never shows", () => {
  it("shows no part of a key in any text or attribute, after the URL is saved", async () => {
    stubChain(FIRST_CHAIN);
    renderLive();
    await typeInto("Ethereum RPC URL", SECRET_URL);
    await userEvent.click(region("Ethereum RPC URL").getByRole("button", { name: "Save" }));
    await screen.findByText("Saved. The page uses this URL now.");
    expect(region("Ethereum RPC URL").getByText(/rpc\.example\.org/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(attributeValues().filter((value) => value.includes(SECRET))).toEqual([]);
    expect(attributeValues().filter((value) => value.includes("1234567890"))).toEqual([]);
  });

  it("shows no part of a key of an indexer URL either, in a failure message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError(`fetch failed for https://indexer.example.org/${SECRET}`))));
    renderLive();
    await typeInto("Indexer URL", `https://indexer.example.org/${SECRET}`);
    await userEvent.click(region("Indexer URL").getByRole("button", { name: "Test" }));
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toContain(SECRET);
  });
});

describe("a fixture page", () => {
  it("says that sample data uses no connections, and offers no field", () => {
    renderPage(<ConnectionsView />);
    expect(screen.getByText("Sample data uses no connections.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByLabelText(/New /)).toBeNull();
  });
});

describe("the pure rules of the page", () => {
  const user = { indexerUrl: "https://i.example.org", rpcUrls: { 1: "https://a.example.org", 369: "https://b.example.org" } };
  const [indexer, first] = connectionTargets(FIXTURE_PAIR);

  it("lists the indexer first and then each chain by name", () => {
    expect(connectionTargets(FIXTURE_PAIR).map((target) => target.label)).toEqual(["Indexer URL", "Ethereum RPC URL", "PulseChain RPC URL"]);
  });

  it("sets and removes one entry and keeps the others", () => {
    expect(withUserUrl(user, first!, "https://c.example.org").rpcUrls).toEqual({ 1: "https://c.example.org", 369: "https://b.example.org" });
    expect(withUserUrl(user, indexer!, "https://d.example.org").indexerUrl).toBe("https://d.example.org");
    expect(withoutUserUrl(user, first!).rpcUrls).toEqual({ 369: "https://b.example.org" });
    expect(withoutUserUrl(user, indexer!)).toEqual({ ...user, indexerUrl: null });
  });
});
