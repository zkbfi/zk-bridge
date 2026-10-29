/** Content-addressed archives (CAR files) of a site directory, as IPFS stores them. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { CarReader, CarWriter } from "@ipld/car";
import { MemoryBlockstore } from "blockstore-core";
import { exporter, recursive, type UnixFSFile } from "ipfs-unixfs-exporter";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import type { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

/** Thrown when a directory cannot be packed or an archive is damaged. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/** Fixed chunks of 256 KiB, the IPFS default, so the same files always give the same blocks. */
const CHUNK_BYTES = 262_144;

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

async function carBytesOf(root: CID, blocks: { cid: CID; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create([root]);
  const parts: Uint8Array[] = [];
  const collect = (async () => {
    for await (const part of out) parts.push(part);
  })();
  for (const block of blocks) await writer.put(block);
  await writer.close();
  await collect;
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * Packs a directory as UnixFS (CID version 1, raw leaves, fixed chunker) into one archive.
 * Files are added in sorted order and blocks are written sorted by CID, so the same files give the same bytes.
 * @throws ArchiveError when the directory holds no file.
 */
export async function packDirectory(directory: string): Promise<{ cid: string; carBytes: Uint8Array }> {
  const files = await listFiles(directory);
  if (files.length === 0) throw new ArchiveError(`${directory} holds no file to pack`);
  const blockstore = new MemoryBlockstore();
  const source = files.map((path) => ({ path, content: readFile(join(directory, path)).then((bytes) => new Uint8Array(bytes)) }));
  const candidates = (async function* () {
    for (const file of source) yield { path: file.path, content: await file.content };
  })();
  let root: CID | undefined;
  for await (const entry of importer(candidates, blockstore, {
    cidVersion: 1,
    rawLeaves: true,
    wrapWithDirectory: true,
    chunker: fixedSize({ chunkSize: CHUNK_BYTES }),
  })) {
    root = entry.cid;
  }
  const blocks: { cid: CID; bytes: Uint8Array }[] = [];
  for await (const pair of blockstore.getAll()) {
    const parts: Uint8Array[] = [];
    for await (const part of pair.bytes) parts.push(part);
    blocks.push({ cid: pair.cid, bytes: new Uint8Array(Buffer.concat(parts)) });
  }
  blocks.sort((a, b) => (a.cid.toString() < b.cid.toString() ? -1 : 1));
  return { cid: root!.toString(), carBytes: await carBytesOf(root!, blocks) };
}

/** An archive whose every block has been checked against its content address. */
export type Archive = { root: CID; blockCount: number; blockstore: MemoryBlockstore };

/**
 * Reads an archive and checks it: exactly one root, every block hashed with SHA-256 to its CID.
 * @throws ArchiveError naming the first problem found.
 */
export async function readArchive(carBytes: Uint8Array): Promise<Archive> {
  let reader: CarReader;
  try {
    reader = await CarReader.fromBytes(carBytes);
  } catch (error) {
    throw new ArchiveError(`not a CAR archive: ${(error as Error).message}`);
  }
  const roots = await reader.getRoots();
  if (roots.length !== 1) throw new ArchiveError(`the archive must name exactly one root, it names ${roots.length}`);
  const blockstore = new MemoryBlockstore();
  let blockCount = 0;
  for await (const block of reader.blocks()) {
    if (block.cid.multihash.code !== sha256.code) throw new ArchiveError(`block ${block.cid} is not SHA-256`);
    const digest = await sha256.digest(block.bytes);
    if (Buffer.compare(Buffer.from(digest.bytes), Buffer.from(block.cid.multihash.bytes)) !== 0) {
      throw new ArchiveError(`block ${block.cid} does not match its content address`);
    }
    await blockstore.put(block.cid, block.bytes);
    blockCount += 1;
  }
  return { root: roots[0]!, blockCount, blockstore };
}

/**
 * Writes the files of an archive under `directory` and returns the root CID.
 * @throws ArchiveError when the archive is damaged or its root is not a directory.
 */
export async function unpackCar(carBytes: Uint8Array, directory: string): Promise<string> {
  const archive = await readArchive(carBytes);
  const top = await exporter(archive.root, archive.blockstore);
  if (top.type !== "directory") throw new ArchiveError("the archive root is not a directory");
  for await (const entry of recursive(archive.root, archive.blockstore)) {
    const node = await exporter(entry.cid, archive.blockstore);
    const path = join(directory, ...entry.path.split("/").slice(1));
    if (node.type === "directory") {
      await mkdir(path, { recursive: true });
      continue;
    }
    // packDirectory writes only UnixFS directories and files, and readArchive has checked every block.
    const parts: Uint8Array[] = [];
    for await (const part of (node as UnixFSFile).content()) parts.push(part as Uint8Array);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.concat(parts));
  }
  return archive.root.toString();
}
