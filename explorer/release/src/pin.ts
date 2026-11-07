/**
 * Pinning adapters: each uploads an archive to a pinning service and checks that the service holds the same CID.
 * The adapter is chosen by RELEASE_PIN_PROVIDER. Credentials come only from the environment and are never printed.
 *
 * Filebase (checked against filebase.com/docs/ipfs/pinning/pinning-files, 2026-10-28): an object PUT into an IPFS
 * bucket through the S3 endpoint `https://s3.filebase.com` (region us-east-1) with the metadata `import=car`, that is
 * the header `x-amz-meta-import: car`, is imported as a CAR. The CID comes back in the header `x-amz-meta-cid`, on the
 * upload answer or on a HEAD of the object.
 *
 * kubo: the RPC API of a self-hosted IPFS node. See kuboAdapter.
 */
import { createHash, createHmac } from "node:crypto";

/** Thrown when an adapter is not configured or a service does not hold what was sent. */
export class PinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinError";
  }
}

/** One pinning service. `pin` resolves to the CID the service reports, which equals `expectedCid`. */
export type PinAdapter = {
  name: string;
  endpoint: string;
  pin(input: { objectKey: string; carBytes: Uint8Array; expectedCid: string }): Promise<string>;
};

const hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const hmac = (key: Uint8Array | string, text: string) => createHmac("sha256", key).update(text).digest();

/** Encodes each segment of an S3 object path as AWS Signature Version 4 requires (slashes kept). */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/**
 * The `Authorization` header of AWS Signature Version 4 for an S3 request with no query string.
 * `path` is already encoded (see encodePath), as it goes on the wire.
 * It signs `host`, `x-amz-content-sha256`, `x-amz-date` and every header in `headers` (lower-case names).
 */
export function signV4(input: {
  method: string;
  host: string;
  path: string;
  headers: Record<string, string>;
  payloadSha256: string;
  accessKey: string;
  secretKey: string;
  region: string;
  amzDate: string;
}): string {
  const all: Record<string, string> = {
    ...input.headers,
    host: input.host,
    "x-amz-content-sha256": input.payloadSha256,
    "x-amz-date": input.amzDate,
  };
  const names = Object.keys(all).sort();
  const signedHeaders = names.join(";");
  const canonical = [
    input.method,
    input.path,
    "",
    ...names.map((name) => `${name}:${all[name]!.trim()}`),
    "",
    signedHeaders,
    input.payloadSha256,
  ].join("\n");
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretKey}`, day), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
}

const FILEBASE_ENDPOINT = "https://s3.filebase.com";
const FILEBASE_REGION = "us-east-1";
const EMPTY_SHA256 = hex("");

function filebaseAdapter(environment: Record<string, string | undefined>): PinAdapter {
  const required = ["FILEBASE_ACCESS_KEY", "FILEBASE_SECRET_KEY", "FILEBASE_BUCKET"] as const;
  const missing = required.filter((name) => !environment[name]);
  if (missing.length > 0) throw new PinError(`the filebase adapter needs ${missing.join(", ")}`);
  const accessKey = environment.FILEBASE_ACCESS_KEY!;
  const secretKey = environment.FILEBASE_SECRET_KEY!;
  const bucket = environment.FILEBASE_BUCKET!;
  // FILEBASE_ENDPOINT exists for the tests, which point it at a local fake. A release uses the documented endpoint.
  const endpoint = environment.FILEBASE_ENDPOINT ?? FILEBASE_ENDPOINT;

  async function send(method: "PUT" | "HEAD", objectKey: string, body: Uint8Array | null): Promise<Response> {
    const url = new URL(`${endpoint}${encodePath(`/${bucket}/${objectKey}`)}`);
    const payloadSha256 = body === null ? EMPTY_SHA256 : hex(body);
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers: Record<string, string> = method === "PUT" ? { "x-amz-meta-import": "car" } : {};
    const authorization = signV4({
      method,
      host: url.host,
      path: url.pathname,
      headers,
      payloadSha256,
      accessKey,
      secretKey,
      region: FILEBASE_REGION,
      amzDate,
    });
    return fetch(url, {
      method,
      headers: { ...headers, "x-amz-content-sha256": payloadSha256, "x-amz-date": amzDate, authorization },
      body: body === null ? null : (body as BodyInit),
    });
  }

  return {
    name: "filebase",
    endpoint,
    async pin({ objectKey, carBytes, expectedCid }) {
      const put = await send("PUT", objectKey, carBytes);
      await put.arrayBuffer();
      if (!put.ok) throw new PinError(`Filebase answered ${put.status} to the upload of ${objectKey}`);
      let reported = put.headers.get("x-amz-meta-cid");
      if (!reported) {
        const head = await send("HEAD", objectKey, null);
        reported = head.headers.get("x-amz-meta-cid");
      }
      if (!reported) throw new PinError(`Filebase reported no CID for ${objectKey}`);
      if (reported !== expectedCid) {
        throw new PinError(`Filebase reports ${reported} for ${objectKey}, but the archive is ${expectedCid}`);
      }
      return reported;
    },
  };
}

/** How long the import of one archive may take. A site archive is a few megabytes. */
const KUBO_IMPORT_TIMEOUT_MILLISECONDS = 300_000;
/** How long the pin list may take. */
const KUBO_LIST_TIMEOUT_MILLISECONDS = 30_000;

/** One line of the answer of `dag/import`: a root, or the statistics (off here, but tolerated). */
type KuboImportLine = { Root?: { Cid?: { "/"?: unknown }; PinErrorMsg?: unknown } };

/** Parses the NDJSON answer of `dag/import` into its roots, or null when a line is not the known shape. */
function kuboRoots(text: string): { cid: string; pinError: string }[] | null {
  const roots: { cid: string; pinError: string }[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: KuboImportLine;
    try {
      parsed = JSON.parse(line) as KuboImportLine;
    } catch {
      return null;
    }
    if (parsed.Root === undefined) continue;
    const cid = parsed.Root.Cid?.["/"];
    const pinError = parsed.Root.PinErrorMsg ?? "";
    if (typeof cid !== "string" || typeof pinError !== "string") return null;
    roots.push({ cid, pinError });
  }
  return roots;
}

/**
 * kubo (checked against docs.ipfs.tech/reference/kubo/rpc, 2026-10-29): the RPC API takes only POST. `dag/import` with
 * `pin-roots=true` imports a CAR sent as the multipart field `file` and pins its root; it answers one JSON line per
 * root, `{"Root":{"Cid":{"/":"…"},"PinErrorMsg":""}}`. `pin/ls` with `type=recursive` answers
 * `{"Keys":{"<cid>":{"Type":"recursive"}}}`, or an error when the CID is not pinned. The API has no login of its own:
 * keep it on 127.0.0.1 and reach it through an SSH tunnel. KUBO_API_AUTH, when set, is the Authorization header value
 * that `API.Authorizations` of the node accepts.
 *
 * Every release stays addressable by version, so old versions stay hosted until someone unpins them on purpose. The
 * object key is `<version>/<site>.car`. After the checks the adapter names the pin `zkbfi-<site>-<version>`
 * (`pin/add` with `name`) and files the archive in MFS at `/releases/<version>/<site>` (`files/mkdir`, then
 * `files/cp /ipfs/<cid>`). An archive filed earlier at that one path is replaced; nothing else is removed or unpinned.
 */
/** An RPC call to the kubo node: see kuboCaller. */
type KuboCall = {
  (path: string, what: string, body: FormData | null, timeout: number): Promise<string>;
  (path: string, what: string, body: FormData | null, timeout: number, tolerate: string): Promise<string | null>;
};

/**
 * The kubo RPC address and a caller for it, from KUBO_API_URL and the optional KUBO_API_AUTH. Each call POSTs, and every
 * failure names the call and the address, never the credentials. With `tolerate`, an error answer whose message holds
 * that text resolves to null instead of failing.
 * @throws PinError when KUBO_API_URL is missing, not http(s), or carries credentials.
 */
function kuboCaller(environment: Record<string, string | undefined>): { endpoint: string; call: KuboCall } {
  if (!environment.KUBO_API_URL) throw new PinError("the kubo adapter needs KUBO_API_URL");
  let url: URL;
  try {
    url = new URL(environment.KUBO_API_URL);
  } catch {
    throw new PinError("KUBO_API_URL must be an http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PinError("KUBO_API_URL must be an http or https URL");
  if (url.username !== "" || url.password !== "") {
    throw new PinError("KUBO_API_URL must not carry credentials; put the Authorization header value in KUBO_API_AUTH");
  }
  const endpoint = url.href.replace(/\/+$/, "");
  const headers: Record<string, string> = environment.KUBO_API_AUTH ? { authorization: environment.KUBO_API_AUTH } : {};

  async function call(path: string, what: string, body: FormData | null, timeout: number, tolerate?: string): Promise<string | null> {
    let answer: Response;
    try {
      answer = await fetch(`${endpoint}${path}`, { method: "POST", headers, body, signal: AbortSignal.timeout(timeout) });
    } catch {
      throw new PinError(`could not reach the kubo API at ${endpoint} for ${what} (is the SSH tunnel open?)`);
    }
    const text = await answer.text();
    if (!answer.ok) {
      let message = "";
      try {
        const parsed = JSON.parse(text) as { Message?: unknown };
        if (typeof parsed.Message === "string") message = `: ${parsed.Message.slice(0, 200)}`;
      } catch {
        // A proxy page or plain text: the status says enough.
      }
      if (tolerate !== undefined && message.includes(tolerate)) return null;
      throw new PinError(`kubo answered ${answer.status} to ${what}${message}`);
    }
    return text;
  }
  return { endpoint, call: call as KuboCall };
}

function kuboAdapter(environment: Record<string, string | undefined>): PinAdapter {
  const { endpoint, call } = kuboCaller(environment);

  return {
    name: "kubo",
    endpoint,
    async pin({ objectKey, carBytes, expectedCid }) {
      const parts = /^([0-9A-Za-z._+-]+)\/([0-9A-Za-z_-]+)\.car$/.exec(objectKey);
      if (parts === null || /^\.+$/.test(parts[1] as string)) {
        throw new PinError(`the kubo adapter needs an object key <version>/<site>.car of plain characters, not ${objectKey}`);
      }
      const [, version, site] = parts as unknown as [string, string, string];
      const form = new FormData();
      form.append("file", new Blob([carBytes as BlobPart], { type: "application/vnd.ipld.car" }), objectKey.split("/").pop());
      const imported = await call(
        "/api/v0/dag/import?pin-roots=true&stats=false",
        `the import of ${objectKey}`,
        form,
        KUBO_IMPORT_TIMEOUT_MILLISECONDS,
      );
      const roots = kuboRoots(imported);
      if (roots === null) throw new PinError(`kubo answered the import of ${objectKey} in an unknown shape`);
      if (roots.length !== 1) throw new PinError(`kubo reported ${roots.length} roots for ${objectKey}, expected exactly one`);
      const [root] = roots as [{ cid: string; pinError: string }];
      if (root.cid !== expectedCid) throw new PinError(`kubo imported ${root.cid} for ${objectKey}, but the archive is ${expectedCid}`);
      if (root.pinError !== "") throw new PinError(`kubo could not pin ${objectKey}: ${root.pinError.slice(0, 200)}`);

      const listed = await call(
        `/api/v0/pin/ls?${new URLSearchParams({ arg: expectedCid, type: "recursive" })}`,
        `the pin list of ${objectKey}`,
        null,
        KUBO_LIST_TIMEOUT_MILLISECONDS,
      );
      let keys: unknown;
      try {
        keys = (JSON.parse(listed) as { Keys?: unknown }).Keys;
      } catch {
        keys = undefined;
      }
      if (typeof keys !== "object" || keys === null) throw new PinError(`kubo answered the pin list of ${objectKey} in an unknown shape`);
      const entry = (keys as Record<string, { Type?: unknown } | undefined>)[expectedCid];
      if (entry?.Type !== "recursive") {
        throw new PinError(`kubo holds no recursive pin of ${expectedCid} after the import of ${objectKey}`);
      }

      // Keep the release addressable by version: a named pin, and a path in the /releases index.
      const name = `zkbfi-${site}-${version}`;
      const directory = `/releases/${version}`;
      const target = `${directory}/${site}`;
      const query = (pairs: Record<string, string> | string[][]) => new URLSearchParams(pairs).toString();
      await call(`/api/v0/pin/add?${query({ arg: expectedCid, name })}`, `naming the pin ${name}`, null, KUBO_LIST_TIMEOUT_MILLISECONDS);
      await call(
        `/api/v0/files/mkdir?${query({ arg: directory, parents: "true" })}`,
        `the creation of ${directory}`,
        null,
        KUBO_LIST_TIMEOUT_MILLISECONDS,
      );
      const existing = await call(`/api/v0/files/stat?${query({ arg: target })}`, `the lookup of ${target}`, null, KUBO_LIST_TIMEOUT_MILLISECONDS, "does not exist");
      if (existing !== null) {
        await call(
          `/api/v0/files/rm?${query({ arg: target, recursive: "true" })}`,
          `the removal of the old ${target}`,
          null,
          KUBO_LIST_TIMEOUT_MILLISECONDS,
        );
      }
      await call(
        `/api/v0/files/cp?${query([["arg", `/ipfs/${expectedCid}`], ["arg", target]])}`,
        `filing ${objectKey} at ${target}`,
        null,
        KUBO_IMPORT_TIMEOUT_MILLISECONDS,
      );
      return root.cid;
    },
  };
}

const ADAPTERS: Record<string, (environment: Record<string, string | undefined>) => PinAdapter> = {
  filebase: filebaseAdapter,
  kubo: kuboAdapter,
};

/**
 * The adapter RELEASE_PIN_PROVIDER names, built from the environment.
 * @returns null when no provider is chosen.
 * @throws PinError for an unknown provider or a missing credential (named, never its value).
 */
export function pinAdapterFromEnvironment(environment: Record<string, string | undefined>): PinAdapter | null {
  const provider = environment.RELEASE_PIN_PROVIDER;
  if (!provider) return null;
  const make = Object.hasOwn(ADAPTERS, provider) ? ADAPTERS[provider] : undefined;
  if (!make) throw new PinError(`no pinning adapter named ${provider} (known: ${Object.keys(ADAPTERS).join(", ")})`);
  return make(environment);
}

/** How long pinning one CID from the network may take before it counts as unavailable. */
const KUBO_REPIN_TIMEOUT_MILLISECONDS = 600_000;

/** Asks the kubo node about pins by CID, and pins a CID it can fetch from the network. Used by the repin helper. */
export type KuboPins = {
  endpoint: string;
  /** True when the node holds a recursive pin of the CID. */
  isPinned(cid: string): Promise<boolean>;
  /** Pins the CID recursively under `name`; the node fetches what it lacks from the network. */
  pin(cid: string, name: string): Promise<void>;
};

/**
 * The pin queries of the kubo node named by KUBO_API_URL (and KUBO_API_AUTH, never printed), as the kubo adapter reaches it.
 * @throws PinError when KUBO_API_URL is missing, not http(s), or carries credentials.
 */
export function kuboPinsFromEnvironment(environment: Record<string, string | undefined>): KuboPins {
  const { endpoint, call } = kuboCaller(environment);
  const query = (pairs: Record<string, string>) => new URLSearchParams(pairs).toString();
  return {
    endpoint,
    async isPinned(cid) {
      const listed = await call(`/api/v0/pin/ls?${query({ arg: cid, type: "recursive" })}`, `the pin list of ${cid}`, null, KUBO_LIST_TIMEOUT_MILLISECONDS, "not pinned");
      if (listed === null) return false;
      let keys: unknown;
      try {
        keys = (JSON.parse(listed) as { Keys?: unknown }).Keys;
      } catch {
        keys = undefined;
      }
      if (typeof keys !== "object" || keys === null) throw new PinError(`kubo answered the pin list of ${cid} in an unknown shape`);
      return (keys as Record<string, { Type?: unknown } | undefined>)[cid]?.Type === "recursive";
    },
    async pin(cid, name) {
      await call(`/api/v0/pin/add?${query({ arg: cid, name, recursive: "true", progress: "false" })}`, `pinning ${cid}`, null, KUBO_REPIN_TIMEOUT_MILLISECONDS);
    },
  };
}
