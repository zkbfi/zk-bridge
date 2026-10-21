"""Generates synthetic receipt-trie fixtures for the hardened vault tests.

Run: python3 -I test/hardened/fixtures/generate_receipts.py
Writes: test/hardened/utils/ReceiptFixtures.sol and test/hardened/fixtures/receipts.json
Pure Python, no dependencies. Keccak-256 is implemented below (hashlib has only NIST SHA-3).
"""
import json
import os

# ---------------------------------------------------------------- keccak-256
RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
    0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
    0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
    0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
M64 = (1 << 64) - 1


def rol(x, n):
    n %= 64
    return ((x << n) | (x >> (64 - n))) & M64 if n else x


def keccak_f(a):
    for rnd in range(24):
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = rol(a[x][y], ROT[x][y])
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= RC[rnd]
    return a


def keccak256(data: bytes) -> bytes:
    rate = 136
    padded = bytearray(data) + b"\x01"
    while len(padded) % rate:
        padded += b"\x00"
    padded[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(padded), rate):
        block = padded[off:off + rate]
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        a = keccak_f(a)
    out = b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out


assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"

# ---------------------------------------------------------------- rlp


class Raw:
    def __init__(self, data):
        self.data = data


def rlp(item):
    if isinstance(item, Raw):
        return item.data
    if isinstance(item, int):
        item = item.to_bytes((item.bit_length() + 7) // 8, "big") if item else b""
    if isinstance(item, (bytes, bytearray)):
        item = bytes(item)
        if len(item) == 1 and item[0] < 0x80:
            return item
        return length_prefix(len(item), 0x80) + item
    body = b"".join(rlp(i) for i in item)
    return length_prefix(len(body), 0xC0) + body


def length_prefix(length, offset):
    if length < 56:
        return bytes([offset + length])
    size = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([offset + 55 + len(size)]) + size


# ---------------------------------------------------------------- merkle patricia trie


def nibbles(data):
    out = []
    for byte in data:
        out += [byte >> 4, byte & 15]
    return out


def hex_prefix(path, leaf):
    flag = 2 if leaf else 0
    if len(path) % 2:
        first = [flag + 1, path[0]]
        rest = path[1:]
    else:
        first = [flag, 0]
        rest = path
    nibs = first + rest
    return bytes(nibs[i] * 16 + nibs[i + 1] for i in range(0, len(nibs), 2))


def reference(encoded):
    return Raw(encoded) if len(encoded) < 32 else keccak256(encoded)


def build(items, depth, store):
    """items: list of (nibble list, value). Returns encoded node. store: dict hash -> encoded node."""
    if len(items) == 1:
        path, value = items[0]
        node = rlp([hex_prefix(path[depth:], True), value])
        store[keccak256(node)] = node
        return node
    first = items[0][0]
    shared = 0
    while all(len(k) > depth + shared and k[depth + shared] == first[depth + shared] for k, _ in items):
        shared += 1
    if shared:
        child = build(items, depth + shared, store)
        node = rlp([hex_prefix(first[depth:depth + shared], False), reference(child)])
        store[keccak256(node)] = node
        return node
    children = [b""] * 16
    value = b""
    for nib in range(16):
        group = [(k, v) for k, v in items if len(k) > depth and k[depth] == nib]
        if group:
            children[nib] = reference(build(group, depth + 1, store))
    for k, v in items:
        if len(k) == depth:
            value = v
    node = rlp(children + [value])
    store[keccak256(node)] = node
    return node


def prove(root_node, key, store):
    """Returns the list of encoded nodes from the root to the leaf, hashed nodes only (as geth does)."""
    proof = []
    node = root_node
    path = nibbles(key)
    index = 0
    while True:
        proof.append(node)
        decoded = decode(node)
        if len(decoded) == 17:
            if index == len(path):
                return proof
            child = decoded[path[index]]
            index += 1
        else:
            prefix = decoded[0][0] >> 4
            shared = len(decoded[0]) * 2 - (1 if prefix % 2 else 2)
            if prefix in (2, 3):
                return proof
            index += shared
            child = decoded[1]
        assert len(child) == 32, "embedded nodes are not used by these fixtures"
        node = store[child]


def decode(data):
    item, rest = decode_item(data)
    assert not rest
    return item


def decode_item(data):
    first = data[0]
    if first < 0x80:
        return data[:1], data[1:]
    if first < 0xB8:
        n = first - 0x80
        return data[1:1 + n], data[1 + n:]
    if first < 0xC0:
        ll = first - 0xB7
        n = int.from_bytes(data[1:1 + ll], "big")
        return data[1 + ll:1 + ll + n], data[1 + ll + n:]
    if first < 0xF8:
        n = first - 0xC0
        body, rest = data[1:1 + n], data[1 + n:]
    else:
        ll = first - 0xF7
        n = int.from_bytes(data[1:1 + ll], "big")
        body, rest = data[1 + ll:1 + ll + n], data[1 + ll + n:]
    items = []
    while body:
        item, body = decode_item(body)
        items.append(item)
    return items, rest


# ---------------------------------------------------------------- fixtures
def address(byte):
    return bytes([byte]) * 20


REMOTE_VAULT = address(0x11)
REMOTE_TOKEN = address(0x22)
# The vault on the destination chain that may pay these deposits. The tests deploy their vault at this address.
DESTINATION_VAULT = address(0x77)
OTHER_DESTINATION_VAULT = address(0x88)
# The token that the destination vault pays for REMOTE_TOKEN. The tests deploy their token on the destination chain here.
DESTINATION_TOKEN = address(0x99)
OTHER_EMITTER = address(0x33)
UNREGISTERED_TOKEN = address(0x44)
SENDER = address(0x55)
RECIPIENT = address(0x66)
TARGET_CHAIN = 369
DEPOSIT_TOPIC = keccak256(b"DepositInitiated(address,address,address,uint256,bytes32,uint64,address,address)")
OTHER_TOPIC = keccak256(b"Unrelated(uint256)")


def word(value):
    return value.to_bytes(32, "big")


def pad_address(a):
    return b"\x00" * 12 + a


def deposit_log(emitter, token, amount, nonce, target, destination=DESTINATION_VAULT, destination_token=DESTINATION_TOKEN):
    return [emitter, [DEPOSIT_TOPIC, pad_address(token), pad_address(SENDER), pad_address(RECIPIENT)],
            word(amount) + nonce + word(target) + pad_address(destination) + pad_address(destination_token)]


def other_log(emitter):
    return [emitter, [OTHER_TOPIC], word(7)]


def receipt(kind, success, logs):
    body = rlp([b"\x01" if success else b"", 21000 * 3, b"\x00" * 256, logs])
    return body if kind == 0 else bytes([kind]) + body


def nonce(label):
    return keccak256(b"nonce:" + label.encode())


NAMED = []  # dicts: label, index, kind, logIndex, amount, nonce, success, note
receipts = {}


def add(label, index, kind, success, logs, deposit_log_index, amount, note):
    n = nonce(label)
    receipts[index] = receipt(kind, success, logs(n) if callable(logs) else logs)
    NAMED.append(dict(label=label, index=index, kind=kind, success=success, logIndex=deposit_log_index,
                      amount=amount, nonce=n, note=note))


E18 = 10 ** 18
add("LEGACY", 0, 0, True, lambda n: [deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 1 * E18, n, TARGET_CHAIN)], 0, 1 * E18, "legacy receipt, key 0x80")
add("ACCESS_LIST", 1, 1, True, lambda n: [deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 2 * E18, n, TARGET_CHAIN)], 0, 2 * E18, "type 1 receipt")
add("TYPE2", 2, 2, True, lambda n: [deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 3 * E18, n, TARGET_CHAIN)], 0, 3 * E18, "type 2 receipt")
n_a, n_b = nonce("TWO_A"), nonce("TWO_B")
receipts[3] = receipt(2, True, [other_log(REMOTE_VAULT),
                                deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 4 * E18, n_a, TARGET_CHAIN),
                                deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 5 * E18, n_b, TARGET_CHAIN)])
NAMED.append(dict(label="TWO_A", index=3, kind=2, success=True, logIndex=1, amount=4 * E18, nonce=n_a, note="first deposit of a receipt with two; log 0 is another event"))
NAMED.append(dict(label="TWO_B", index=3, kind=2, success=True, logIndex=2, amount=5 * E18, nonce=n_b, note="second deposit of the same receipt"))
add("FAILED", 4, 2, False, lambda n: [deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 6 * E18, n, TARGET_CHAIN)], 0, 6 * E18, "status 0 receipt with a deposit-looking log")
add("OTHER_EMITTER", 5, 2, True, lambda n: [deposit_log(OTHER_EMITTER, REMOTE_TOKEN, 7 * E18, n, TARGET_CHAIN)], 0, 7 * E18, "deposit log from a contract that is not the remote vault")
add("WRONG_TARGET", 6, 2, True, lambda n: [deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 8 * E18, n, 56)], 0, 8 * E18, "deposit that targets chain 56")
add("UNREGISTERED", 7, 2, True, lambda n: [deposit_log(REMOTE_VAULT, UNREGISTERED_TOKEN, 9 * E18, n, TARGET_CHAIN)], 0, 9 * E18, "deposit of a token that is not registered")
add("HIGH_INDEX", 130, 2, True, lambda n: [deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 10 * E18, n, TARGET_CHAIN)], 0, 10 * E18, "transaction index 130, key 0x8182")
add("TYPE3", 8, 3, True, lambda n: [deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 11 * E18, n, TARGET_CHAIN)], 0, 11 * E18, "type 3 (blob) receipt")
add("TYPE4", 9, 4, True, lambda n: [deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 12 * E18, n, TARGET_CHAIN)], 0, 12 * E18, "type 4 (set code) receipt")
add("TYPE5", 10, 5, True, lambda n: [deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 13 * E18, n, TARGET_CHAIN)], 0, 13 * E18, "receipt with an unsupported type byte 5")
add("TYPE0_PREFIXED", 11, 0, True, lambda n: [deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 14 * E18, n, TARGET_CHAIN)], 0, 14 * E18, "receipt with an explicit 0x00 prefix, which no client writes")
receipts[11] = b"\x00" + receipts[11]
add("WRONG_DESTINATION", 12, 2, True, lambda n: [deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 15 * E18, n, TARGET_CHAIN, OTHER_DESTINATION_VAULT)], 0, 15 * E18, "deposit addressed to another vault of the destination chain")
# 64 logs: the deposit is log 40. The vendored list reader panics from 33 items on.
add("MANY_LOGS", 13, 2, True, lambda n: [other_log(OTHER_EMITTER) for _ in range(40)] + [deposit_log(REMOTE_VAULT, REMOTE_TOKEN, 16 * E18, n, TARGET_CHAIN)] + [other_log(OTHER_EMITTER) for _ in range(23)], 40, 16 * E18, "64 logs; the deposit is log 40")
TOTAL = 140
for index in range(TOTAL):
    if index not in receipts:
        receipts[index] = receipt(2, True, [other_log(OTHER_EMITTER)])

keys = {i: rlp(i) for i in range(TOTAL)}
items = sorted(((nibbles(keys[i]), receipts[i]) for i in range(TOTAL)), key=lambda kv: kv[0])
store = {}
root_node = build(items, 0, store)
root = keccak256(root_node)
store[root] = root_node

named_proofs = {}
for entry in NAMED:
    i = entry["index"]
    if i not in named_proofs:
        proof = prove(root_node, keys[i], store)
        named_proofs[i] = proof
        # self check: the last node holds the receipt value
        leaf = decode(proof[-1])
        assert leaf[1] == receipts[i]

here = os.path.dirname(os.path.abspath(__file__))
out_json = {
    "receiptsRoot": "0x" + root.hex(),
    "constants": {"remoteVault": "0x" + REMOTE_VAULT.hex(), "remoteToken": "0x" + REMOTE_TOKEN.hex(),
                  "destinationVault": "0x" + DESTINATION_VAULT.hex(), "destinationToken": "0x" + DESTINATION_TOKEN.hex(), "otherDestinationVault": "0x" + OTHER_DESTINATION_VAULT.hex(),
                  "otherEmitter": "0x" + OTHER_EMITTER.hex(), "unregisteredToken": "0x" + UNREGISTERED_TOKEN.hex(),
                  "sender": "0x" + SENDER.hex(), "recipient": "0x" + RECIPIENT.hex(), "targetChainId": TARGET_CHAIN,
                  "depositTopic": "0x" + DEPOSIT_TOPIC.hex()},
    "receipts": [dict(label=e["label"], transactionIndex=e["index"], type=e["kind"], success=e["success"],
                      logIndex=e["logIndex"], amount=str(e["amount"]), nonce="0x" + e["nonce"].hex(), note=e["note"],
                      proof=["0x" + n.hex() for n in named_proofs[e["index"]]]) for e in NAMED],
}
with open(os.path.join(here, "receipts.json"), "w") as handle:
    json.dump(out_json, handle, indent=2)
    handle.write("\n")


def hexlit(b):
    return 'hex"%s"' % b.hex()


lines = []
lines.append("// SPDX-License-Identifier: MIT")
lines.append("pragma solidity ^0.8.24;")
lines.append("")
lines.append("// GENERATED by test/hardened/fixtures/generate_receipts.py. Do not edit by hand.")
lines.append("")
lines.append("/// @notice Synthetic receipts trie (140 receipts) with proofs for the named receipts.")
lines.append("library ReceiptFixtures {")
lines.append("    bytes32 internal constant RECEIPTS_ROOT = 0x%s;" % root.hex())
lines.append("    address internal constant REMOTE_VAULT = 0x%s;" % REMOTE_VAULT.hex())
lines.append("    address internal constant REMOTE_TOKEN = 0x%s;" % REMOTE_TOKEN.hex())
lines.append("    address internal constant DESTINATION_VAULT = 0x%s;" % DESTINATION_VAULT.hex())
lines.append("    address internal constant DESTINATION_TOKEN = 0x%s;" % DESTINATION_TOKEN.hex())
lines.append("    address internal constant OTHER_DESTINATION_VAULT = 0x%s;" % OTHER_DESTINATION_VAULT.hex())
lines.append("    address internal constant OTHER_EMITTER = 0x%s;" % OTHER_EMITTER.hex())
lines.append("    address internal constant UNREGISTERED_TOKEN = 0x%s;" % UNREGISTERED_TOKEN.hex())
lines.append("    address internal constant SENDER = 0x%s;" % SENDER.hex())
lines.append("    address internal constant RECIPIENT = 0x%s;" % RECIPIENT.hex())
lines.append("")
lines.append("    struct Named {")
lines.append("        uint256 transactionIndex;")
lines.append("        uint256 logIndex;")
lines.append("        uint256 amount;")
lines.append("        bytes32 nonce;")
lines.append("    }")
lines.append("")
for e in NAMED:
    lines.append("    /// @dev %s" % e["note"])
    lines.append("    function %s() internal pure returns (Named memory) {" % e["label"].lower())
    lines.append("        return Named(%d, %d, %d, 0x%s);" % (e["index"], e["logIndex"], e["amount"], e["nonce"].hex()))
    lines.append("    }")
    lines.append("")
lines.append("    /// @notice The proof nodes from the receipts root to the receipt at `transactionIndex`.")
lines.append("    function proofFor(uint256 transactionIndex) internal pure returns (bytes[] memory proof) {")
for i, proof in named_proofs.items():
    lines.append("        if (transactionIndex == %d) {" % i)
    lines.append("            proof = new bytes[](%d);" % len(proof))
    for j, node in enumerate(proof):
        lines.append("            proof[%d] = %s;" % (j, hexlit(node)))
    lines.append("            return proof;")
    lines.append("        }")
lines.append('        revert("ReceiptFixtures: no proof for this index");')
lines.append("    }")
lines.append("}")
sol_path = os.path.join(here, "..", "utils", "ReceiptFixtures.sol")
with open(sol_path, "w") as handle:
    handle.write("\n".join(lines) + "\n")
print("root", root.hex(), "nodes", len(store))
