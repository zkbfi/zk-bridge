import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { pinAdapterFromEnvironment, PinError, signV4 } from "../src/pin.ts";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer };

const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

/** A local stand-in for the Filebase S3 endpoint. Nothing leaves this machine. */
async function fakeS3(answer: (seen: Seen, response: ServerResponse) => void): Promise<{ endpoint: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      const entry = { method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(parts) };
      seen.push(entry);
      answer(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const credentials = { FILEBASE_ACCESS_KEY: "AKIDTEST", FILEBASE_SECRET_KEY: "secret-value-123", FILEBASE_BUCKET: "releases" };
const car = new TextEncoder().encode("car bytes");
const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

describe("signV4", () => {
  it("matches the AWS example for a signed S3 GET", () => {
    const authorization = signV4({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      headers: { range: "bytes=0-9" },
      payloadSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      amzDate: "20130524T000000Z",
    });
    expect(authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date," +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});

describe("pinAdapterFromEnvironment", () => {
  it("returns no adapter when no provider is chosen", () => {
    expect(pinAdapterFromEnvironment({})).toBeNull();
  });

  it("refuses an unknown provider", () => {
    expect(() => pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "nowhere" })).toThrow(/no pinning adapter named nowhere/);
  });

  it("refuses filebase without every credential, and never names a secret value", () => {
    for (const missing of Object.keys(credentials)) {
      const environment: Record<string, string> = { RELEASE_PIN_PROVIDER: "filebase", ...credentials };
      delete environment[missing];
      let message = "";
      try {
        pinAdapterFromEnvironment(environment);
      } catch (error) {
        expect(error).toBeInstanceOf(PinError);
        message = (error as Error).message;
      }
      expect(message).toContain(missing);
      expect(message).not.toContain("secret-value-123");
    }
  });
});

describe("the Filebase adapter", () => {
  it("puts the archive with the CAR import flag, signed, and accepts the matching CID from the answer", async () => {
    const s3 = await fakeS3((_seen, response) => {
      response.writeHead(200, { "x-amz-meta-cid": cid });
      response.end();
    });
    const adapter = pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "filebase", ...credentials, FILEBASE_ENDPOINT: s3.endpoint })!;
    expect(adapter.name).toBe("filebase");
    await expect(adapter.pin({ objectKey: "1.0.0/dapp.car", carBytes: car, expectedCid: cid })).resolves.toBe(cid);
    const [put] = s3.seen;
    expect(put!.method).toBe("PUT");
    expect(put!.url).toBe("/releases/1.0.0/dapp.car");
    expect(put!.headers["x-amz-meta-import"]).toBe("car");
    expect(put!.headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(car).digest("hex"));
    expect(put!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/s3\/aws4_request,/);
    expect(put!.headers.authorization).toContain("x-amz-meta-import");
    expect(put!.body.equals(Buffer.from(car))).toBe(true);
  });

  it("reads the CID with HEAD when the PUT answer does not carry it", async () => {
    const s3 = await fakeS3((seen, response) => {
      response.writeHead(200, seen.method === "HEAD" ? { "x-amz-meta-cid": cid } : {});
      response.end();
    });
    const adapter = pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "filebase", ...credentials, FILEBASE_ENDPOINT: s3.endpoint })!;
    await expect(adapter.pin({ objectKey: "a(1).car", carBytes: car, expectedCid: cid })).resolves.toBe(cid);
    expect(s3.seen.map((entry) => entry.method)).toEqual(["PUT", "HEAD"]);
    expect(s3.seen.map((entry) => entry.url)).toEqual(["/releases/a%281%29.car", "/releases/a%281%29.car"]);
  });

  it("fails when Filebase reports another CID, reports none, or refuses the upload", async () => {
    let mode = "other";
    const s3 = await fakeS3((_seen, response) => {
      if (mode === "other") response.writeHead(200, { "x-amz-meta-cid": "bafkreiother" });
      else if (mode === "none") response.writeHead(200);
      else response.writeHead(403);
      response.end();
    });
    const adapter = pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "filebase", ...credentials, FILEBASE_ENDPOINT: s3.endpoint })!;
    const input = { objectKey: "a.car", carBytes: car, expectedCid: cid };
    await expect(adapter.pin(input)).rejects.toThrow(`Filebase reports bafkreiother for a.car, but the archive is ${cid}`);
    mode = "none";
    await expect(adapter.pin(input)).rejects.toThrow("Filebase reported no CID for a.car");
    mode = "refuse";
    await expect(adapter.pin(input)).rejects.toThrow("Filebase answered 403 to the upload of a.car");
  });

  it("uses the documented IPFS endpoint by default", () => {
    const adapter = pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "filebase", ...credentials })!;
    expect(adapter.endpoint).toBe("https://s3.filebase.com");
  });
});

const kuboAuth = "Bearer kubo-token-456";

/** A local stand-in for the kubo RPC API. `answer` gets the path without the query and the parsed query. */
async function fakeKubo(
  answer: (path: string, query: URLSearchParams, response: ServerResponse) => void,
): Promise<{ endpoint: string; seen: Seen[] }> {
  return fakeS3((seen, response) => {
    const url = new URL(seen.url, "http://kubo");
    answer(url.pathname, url.searchParams, response);
  });
}

/** The answers of a kubo node that imports and pins `root`, with `pinError` as the pin result of the import. */
function healthyKubo(root: string, pinError = "") {
  return (path: string, query: URLSearchParams, response: ServerResponse) => {
    if (path === "/api/v0/dag/import") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify({ Root: { Cid: { "/": root }, PinErrorMsg: pinError } })}\n`);
    } else if (path === "/api/v0/pin/ls" && query.get("arg") === root) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Keys: { [root]: { Type: "recursive" } } }));
    } else {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ Message: `not pinned: ${query.get("arg")}`, Code: 0, Type: "error" }));
    }
  };
}

const kuboInput = { objectKey: "1.0.0/dapp.car", carBytes: car, expectedCid: cid };

describe("the kubo adapter", () => {
  it("needs KUBO_API_URL, an http(s) URL without credentials in it", () => {
    expect(() => pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "kubo" })).toThrow("the kubo adapter needs KUBO_API_URL");
    for (const url of ["not a url", "ftp://127.0.0.1:5001", "unix:/run/kubo.sock"]) {
      expect(() => pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "kubo", KUBO_API_URL: url })).toThrow(
        "KUBO_API_URL must be an http or https URL",
      );
    }
    let message = "";
    try {
      pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "kubo", KUBO_API_URL: "http://user:hunter2@127.0.0.1:5001" });
    } catch (error) {
      expect(error).toBeInstanceOf(PinError);
      message = (error as Error).message;
    }
    expect(message).toBe("KUBO_API_URL must not carry credentials; put the Authorization header value in KUBO_API_AUTH");
    expect(message).not.toContain("hunter2");
  });

  it("imports the archive with its root pinned, then confirms the recursive pin", async () => {
    const kubo = await fakeKubo(healthyKubo(cid));
    const adapter = pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "kubo", KUBO_API_URL: `${kubo.endpoint}/` })!;
    expect(adapter.name).toBe("kubo");
    expect(adapter.endpoint).toBe(kubo.endpoint);
    await expect(adapter.pin(kuboInput)).resolves.toBe(cid);
    const [imported, listed] = kubo.seen;
    expect(imported!.method).toBe("POST");
    expect(imported!.url).toBe("/api/v0/dag/import?pin-roots=true&stats=false");
    expect(imported!.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(imported!.body.includes(Buffer.from('name="file"'))).toBe(true);
    expect(imported!.body.includes(Buffer.from(car))).toBe(true);
    expect(imported!.headers.authorization).toBeUndefined();
    expect(listed!.method).toBe("POST");
    expect(listed!.url).toBe(`/api/v0/pin/ls?arg=${cid}&type=recursive`);
  });

  it("sends KUBO_API_AUTH as the Authorization header of every call", async () => {
    const kubo = await fakeKubo(healthyKubo(cid));
    const adapter = pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "kubo", KUBO_API_URL: kubo.endpoint, KUBO_API_AUTH: kuboAuth })!;
    await adapter.pin(kuboInput);
    expect(kubo.seen.map((entry) => entry.headers.authorization)).toEqual([kuboAuth, kuboAuth]);
  });

  it("fails when the node imports another root, more than one root, or none", async () => {
    let roots: string[] = ["bafkreiother"];
    const kubo = await fakeKubo((_path, _query, response) => {
      response.writeHead(200);
      response.end(roots.map((root) => `${JSON.stringify({ Root: { Cid: { "/": root }, PinErrorMsg: "" } })}\n`).join(""));
    });
    const adapter = pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "kubo", KUBO_API_URL: kubo.endpoint })!;
    await expect(adapter.pin(kuboInput)).rejects.toThrow(`kubo imported bafkreiother for 1.0.0/dapp.car, but the archive is ${cid}`);
    roots = [cid, "bafkreiother"];
    await expect(adapter.pin(kuboInput)).rejects.toThrow("kubo reported 2 roots for 1.0.0/dapp.car, expected exactly one");
    roots = [];
    await expect(adapter.pin(kuboInput)).rejects.toThrow("kubo reported 0 roots for 1.0.0/dapp.car, expected exactly one");
  });

  it("fails when the node could not pin the root", async () => {
    const kubo = await fakeKubo(healthyKubo(cid, "blockstore full"));
    const adapter = pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "kubo", KUBO_API_URL: kubo.endpoint })!;
    await expect(adapter.pin(kuboInput)).rejects.toThrow("kubo could not pin 1.0.0/dapp.car: blockstore full");
  });

  it("fails when the pin list does not hold the root as a recursive pin", async () => {
    let listing: unknown = { Keys: {} };
    const kubo = await fakeKubo((path, _query, response) => {
      response.writeHead(200);
      if (path === "/api/v0/dag/import") response.end(JSON.stringify({ Root: { Cid: { "/": cid }, PinErrorMsg: "" } }));
      else response.end(typeof listing === "string" ? listing : JSON.stringify(listing));
    });
    const adapter = pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "kubo", KUBO_API_URL: kubo.endpoint })!;
    await expect(adapter.pin(kuboInput)).rejects.toThrow(`kubo holds no recursive pin of ${cid} after the import of 1.0.0/dapp.car`);
    listing = { Keys: { [cid]: { Type: "direct" } } };
    await expect(adapter.pin(kuboInput)).rejects.toThrow(`kubo holds no recursive pin of ${cid}`);
    listing = { Keys: "nope" };
    await expect(adapter.pin(kuboInput)).rejects.toThrow("kubo answered the pin list of 1.0.0/dapp.car in an unknown shape");
    listing = "<html>bad gateway</html>";
    await expect(adapter.pin(kuboInput)).rejects.toThrow("kubo answered the pin list of 1.0.0/dapp.car in an unknown shape");
  });

  it("fails on an error status, with the node's message but never the credentials", async () => {
    let status = 500;
    const kubo = await fakeKubo((_path, _query, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(status === 500 ? JSON.stringify({ Message: "file argument 'file' is required", Code: 1, Type: "error" }) : "Forbidden");
    });
    const adapter = pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "kubo", KUBO_API_URL: kubo.endpoint, KUBO_API_AUTH: kuboAuth })!;
    const failure = (await adapter.pin(kuboInput).catch((error: unknown) => error)) as Error;
    expect(failure).toBeInstanceOf(PinError);
    expect(failure.message).toBe("kubo answered 500 to the import of 1.0.0/dapp.car: file argument 'file' is required");
    status = 403;
    const refused = (await adapter.pin(kuboInput).catch((error: unknown) => error)) as Error;
    expect(refused.message).toBe("kubo answered 403 to the import of 1.0.0/dapp.car");
    for (const message of [failure.message, refused.message]) expect(message).not.toContain("kubo-token-456");
  });

  it("fails on an answer that is not the import NDJSON", async () => {
    let body = "this is not json\n";
    const kubo = await fakeKubo((_path, _query, response) => {
      response.writeHead(200);
      response.end(body);
    });
    const adapter = pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "kubo", KUBO_API_URL: kubo.endpoint })!;
    await expect(adapter.pin(kuboInput)).rejects.toThrow("kubo answered the import of 1.0.0/dapp.car in an unknown shape");
    body = `${JSON.stringify({ Root: { Cid: "flat" } })}\n`;
    await expect(adapter.pin(kuboInput)).rejects.toThrow("kubo answered the import of 1.0.0/dapp.car in an unknown shape");
    body = `${JSON.stringify({ Stats: { BlockCount: 3 } })}\n\n`;
    await expect(adapter.pin(kuboInput)).rejects.toThrow("kubo reported 0 roots for 1.0.0/dapp.car, expected exactly one");
  });

  it("fails clearly when the node cannot be reached, naming the address without the credentials", async () => {
    const kubo = await fakeKubo(healthyKubo(cid));
    servers.splice(0).forEach((server) => server.close());
    const adapter = pinAdapterFromEnvironment({ RELEASE_PIN_PROVIDER: "kubo", KUBO_API_URL: kubo.endpoint, KUBO_API_AUTH: kuboAuth })!;
    const failure = (await adapter.pin(kuboInput).catch((error: unknown) => error)) as Error;
    expect(failure).toBeInstanceOf(PinError);
    expect(failure.message).toBe(`could not reach the kubo API at ${kubo.endpoint} for the import of 1.0.0/dapp.car (is the SSH tunnel open?)`);
    expect(failure.message).not.toContain("kubo-token-456");
  });
});
