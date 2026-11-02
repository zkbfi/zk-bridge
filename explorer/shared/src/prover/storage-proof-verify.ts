import { fromRlp, hexToBigInt, keccak256, pad, size, type Hex } from "viem";
import { z } from "zod";

/**
 * Checks an `eth_getProof` answer against the state root of its block, the way the prover checks it (opening.rs). The
 * proof archive and the proof cache hold answers that anyone could have written, so a reader that wants to know whether
 * an archived answer is good runs it through here with a state root it got from a header it trusts.
 *
 * The state and the storage are Merkle Patricia tries keyed by `keccak256(address)` and `keccak256(slot)`. A proof is
 * the list of trie nodes from the root to the key. Each node referenced by hash must hash to that reference; a node of
 * under 32 bytes sits inside its parent. A proof can also show that a key is absent: the path ends at an empty branch
 * slot or at a leaf or extension of another path.
 */

/** The root of an empty trie: `keccak256(rlp(""))`. */
export const EMPTY_TRIE_ROOT: Hex = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421";

/** The code hash of an account without code: `keccak256("")`. */
export const EMPTY_CODE_HASH: Hex = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;

/** A proof that does not hold together. */
export class TrieProofError extends Error {
  override readonly name = "TrieProofError";
}

type RlpItem = Hex | readonly RlpItem[];

function nibblesOf(bytes: Hex): number[] {
  return [...bytes.slice(2)].map((digit) => Number.parseInt(digit, 16));
}

/** The hex-prefix encoding of a leaf or extension path (yellow paper, appendix C). */
function decodePath(encoded: Hex): { readonly leaf: boolean; readonly nibbles: number[] } {
  const all = nibblesOf(encoded);
  const flag = all[0];
  if (flag === undefined || flag > 3) throw new TrieProofError("a path with a bad prefix");
  return { leaf: flag >= 2, nibbles: all.slice(flag % 2 === 1 ? 1 : 2) };
}

function startsWith(path: readonly number[], prefix: readonly number[]): boolean {
  return prefix.length <= path.length && prefix.every((nibble, index) => path[index] === nibble);
}

/**
 * Follows a proof from `root` along `key` (the trie key itself: already hashed in a secure trie).
 *
 * @returns The value at the key (still RLP encoded as the trie holds it), or null when the proof shows the key absent.
 * @throws TrieProofError when a node does not match its reference, the proof ends early or has nodes left over.
 */
export function verifyTrieProof(root: Hex, key: Hex, proof: readonly Hex[]): Hex | null {
  if (proof.length === 0 && root.toLowerCase() === EMPTY_TRIE_ROOT) return null;
  const path = nibblesOf(key);
  let position = 0;
  let used = 0;
  let reference: RlpItem = root;

  const finish = (value: RlpItem | null): Hex | null => {
    if (used !== proof.length) throw new TrieProofError(`the proof has ${proof.length - used} node(s) after the key`);
    if (value === null || value === "0x") return null;
    if (typeof value !== "string") throw new TrieProofError("a value that is a list");
    return value;
  };

  for (;;) {
    let node: readonly RlpItem[];
    if (typeof reference === "string") {
      if (size(reference) !== 32) throw new TrieProofError(`a reference of ${size(reference)} bytes`);
      const encoded = proof[used];
      if (encoded === undefined) throw new TrieProofError("the proof ends before the key");
      if (keccak256(encoded) !== reference.toLowerCase()) throw new TrieProofError(`node ${used} does not match its hash`);
      used += 1;
      const decoded = fromRlp(encoded, "hex") as RlpItem;
      if (typeof decoded === "string") throw new TrieProofError(`node ${used - 1} is not a list`);
      node = decoded;
    } else {
      node = reference;
    }
    if (node.length === 17) {
      const nibble = path[position];
      if (nibble === undefined) return finish(node[16] as RlpItem);
      position += 1;
      const child = node[nibble] as RlpItem;
      if (child === "0x") return finish(null);
      reference = child;
    } else if (node.length === 2) {
      const { leaf, nibbles } = decodePath(node[0] as Hex);
      const rest = path.slice(position);
      if (leaf) return finish(rest.length === nibbles.length && startsWith(rest, nibbles) ? (node[1] as RlpItem) : null);
      if (!startsWith(rest, nibbles)) return finish(null);
      position += nibbles.length;
      reference = node[1] as RlpItem;
    } else {
      throw new TrieProofError(`a node of ${node.length} items`);
    }
  }
}

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/) as unknown as z.ZodType<Hex>;

/** The `eth_getProof` answer, as far as the check reads it. */
export const accountProofAnswerSchema = z.object({
  balance: hex,
  nonce: hex,
  codeHash: hex,
  storageHash: hex,
  accountProof: z.array(hex),
  storageProof: z.array(z.object({ key: hex, value: hex, proof: z.array(hex) })),
});

/** What the check says. */
export type StorageProofVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Input of {@link verifyAccountProof}. */
export interface AccountProofCheck {
  /** The state root of the block, from a header the caller trusts. */
  readonly stateRoot: Hex;
  readonly address: Hex;
  /** The storage keys the answer must prove. Each must be in the answer. */
  readonly storageKeys: readonly Hex[];
  /** The `eth_getProof` answer as the node sent it. */
  readonly answer: unknown;
}

/** A quantity of an `eth_getProof` answer as a number. "0x" is zero. */
export const hexQuantity = (value: Hex): bigint => (value === "0x" ? 0n : hexToBigInt(value));
const asNumber = hexQuantity;
const sameHash = (left: Hex, right: Hex): boolean => left.toLowerCase() === right.toLowerCase();

/**
 * Checks an `eth_getProof` answer: the account against the state root, and each requested storage key against the
 * storage root of the account. Never throws.
 */
export function verifyAccountProof(input: AccountProofCheck): StorageProofVerdict {
  const parsed = accountProofAnswerSchema.safeParse(input.answer);
  if (!parsed.success) return { ok: false, reason: "the answer is not an eth_getProof answer" };
  const answer = parsed.data;
  try {
    const account = verifyTrieProof(input.stateRoot, keccak256(input.address), answer.accountProof);
    if (account === null) {
      const empty =
        asNumber(answer.nonce) === 0n &&
        asNumber(answer.balance) === 0n &&
        [EMPTY_TRIE_ROOT, ZERO_HASH].some((root) => sameHash(root, answer.storageHash)) &&
        [EMPTY_CODE_HASH, ZERO_HASH].some((code) => sameHash(code, answer.codeHash));
      if (!empty) return { ok: false, reason: "the account is absent but the answer gives it fields" };
    } else {
      const fields = fromRlp(account, "hex") as RlpItem;
      if (typeof fields === "string" || fields.length !== 4) return { ok: false, reason: "the account is not four fields" };
      const [nonce, balance, storageRoot, codeHash] = fields as [Hex, Hex, Hex, Hex];
      if (asNumber(nonce) !== asNumber(answer.nonce)) return { ok: false, reason: "the nonce differs from the proof" };
      if (asNumber(balance) !== asNumber(answer.balance)) return { ok: false, reason: "the balance differs from the proof" };
      if (!sameHash(storageRoot, answer.storageHash)) return { ok: false, reason: "the storage hash differs from the proof" };
      if (!sameHash(codeHash, answer.codeHash)) return { ok: false, reason: "the code hash differs from the proof" };
    }
    const storageRoot = account === null ? EMPTY_TRIE_ROOT : answer.storageHash;
    for (const key of input.storageKeys) {
      const entry = answer.storageProof.find((item) => asNumber(item.key) === asNumber(key));
      if (entry === undefined) return { ok: false, reason: `the answer has no proof for key ${key}` };
      const stored = verifyTrieProof(storageRoot, keccak256(pad(key, { size: 32 })), entry.proof);
      const proven = stored === null ? 0n : asNumber(fromRlp(stored, "hex") as Hex);
      if (proven !== asNumber(entry.value)) return { ok: false, reason: `the value of key ${key} differs from the proof` };
    }
    return { ok: true };
  } catch (error) {
    // The trie walk throws TrieProofError, and viem throws its own errors on bad RLP or a key over 32 bytes.
    return { ok: false, reason: (error as Error).message };
  }
}
