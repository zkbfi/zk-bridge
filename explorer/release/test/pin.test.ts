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
