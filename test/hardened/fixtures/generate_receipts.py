"""Generates synthetic receipt-trie fixtures for the message bridge tests.

Run: python3 -I test/hardened/fixtures/generate_receipts.py
Writes: test/hardened/utils/MessageFixtures.sol and test/hardened/fixtures/messages.json (message logs of the message
bridge, with a receipts trie and a transactions trie that share their indices).
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


REMOTE_BRIDGE = address(0x11)
OTHER_EMITTER = address(0x33)
SENDER = address(0x55)
OTHER_TOPIC = keccak256(b"Unrelated(uint256)")


def word(value):
    return value.to_bytes(32, "big")


def pad_address(a):
    return b"\x00" * 12 + a


def other_log(emitter):
    return [emitter, [OTHER_TOPIC], word(7)]


def receipt(kind, success, logs):
    body = rlp([b"\x01" if success else b"", 21000 * 3, b"\x00" * 256, logs])
    return body if kind == 0 else bytes([kind]) + body


here = os.path.dirname(os.path.abspath(__file__))


def hexlit(b):
    return 'hex"%s"' % b.hex()


# ================================================================ message bridge fixtures
# One receipts trie and one transactions trie with the same indices. Every message is written by the encoder below,
# which follows the layout comment of `ArbitraryMessage.unpackData` in `poanetwork/tokenbridge-contracts`. It shares no
# code with the Solidity codec, so the two agree only if both follow the layout.
SOURCE_CHAIN = 1
DESTINATION_CHAIN = 369
TARGET_RECORDER = address(0x31)
TARGET_REVERTER = address(0x32)
TARGET_BURNER = address(0x34)
TARGET_REENTRANT = address(0x35)
TARGET_SENDER = address(0x36)
MESSAGE_VERSION = 0x00050000
USER_REQUEST_TOPIC = keccak256(b"UserRequestForAffirmation(bytes32,bytes)")


def chain_id_bytes(value):
    return value.to_bytes(max(1, (value.bit_length() + 7) // 8), "big")


def message_id(nonce_value, version=MESSAGE_VERSION, source=SOURCE_CHAIN, bridge=REMOTE_BRIDGE):
    bridge_hash = keccak256(word(source) + bridge)
    return version.to_bytes(4, "big") + bridge_hash[4:24] + nonce_value.to_bytes(8, "big")


def amb_message(identifier, sender, executor, gas, data_type, source, destination, data):
    source_bytes, destination_bytes = chain_id_bytes(source), chain_id_bytes(destination)
    return (identifier + sender + executor + gas.to_bytes(4, "big") + bytes([len(source_bytes), len(destination_bytes), data_type])
            + source_bytes + destination_bytes + data)


def event_data(encoded, offset=32):
    padded = encoded + b"\x00" * (-len(encoded) % 32)
    return word(offset) + word(len(encoded)) + padded


def request_log(emitter, identifier, encoded, topic=USER_REQUEST_TOPIC, data=None):
    return [emitter, [topic, identifier], event_data(encoded) if data is None else data]


def message(nonce_value, target, gas, data, data_type=0, source=SOURCE_CHAIN, destination=DESTINATION_CHAIN,
            version=MESSAGE_VERSION, sender=SENDER):
    identifier = message_id(nonce_value, version)
    return dict(id=identifier, encoded=amb_message(identifier, sender, target, gas, data_type, source, destination, data),
                gas=gas, target=target, data=data)


def transaction(index, kind):
    fields = [index, 10 ** 9, 21000 * 20, TARGET_RECORDER, 0, b"transaction " + str(index).encode(), 27, 1, 2]
    body = rlp(fields)
    return body if kind == 0 else bytes([kind]) + rlp([1] + fields)


def build_trie(values):
    keys = {i: rlp(i) for i in range(len(values))}
    ordered = sorted(((nibbles(keys[i]), values[i]) for i in range(len(values))), key=lambda kv: kv[0])
    nodes = {}
    top = build(ordered, 0, nodes)
    nodes[keccak256(top)] = top
    return keccak256(top), top, nodes, keys


MESSAGE_TOTAL = 40
message_receipts = {}
message_transactions = {}
MESSAGE_NAMED = []  # dicts: label, index, logIndex, message, note


def add_message(label, index, entry, note, receipt_kind=2, success=True, log=None, other_logs_before=0):
    logs = [other_log(REMOTE_BRIDGE) for _ in range(other_logs_before)]
    logs.append(log if log is not None else request_log(REMOTE_BRIDGE, entry["id"], entry["encoded"]))
    message_receipts[index] = receipt(receipt_kind, success, logs)
    message_transactions[index] = transaction(index, receipt_kind)
    MESSAGE_NAMED.append(dict(label=label, index=index, logIndex=other_logs_before, message=entry, note=note))


PAYLOAD = bytes(range(70))
add_message("DELIVER", 0, message(0, TARGET_RECORDER, 500_000, PAYLOAD), "a message to the recorder, 70 bytes of data")
add_message("CONFIRM", 1, message(1, TARGET_RECORDER, 500_000, b"confirm", data_type=0x80), "sent with requireToConfirmMessage (data type 0x80)")
add_message("REVERTING", 2, message(2, TARGET_REVERTER, 300_000, b"fail"), "a target that always reverts")
add_message("BURNING", 3, message(3, TARGET_BURNER, 100_000, b"burn"), "a target that burns all of its gas")
add_message("ORDER_A", 4, message(4, TARGET_RECORDER, 300_000, b"order-a"), "independent message A")
add_message("ORDER_B", 5, message(5, TARGET_RECORDER, 300_000, b"order-b"), "independent message B")
add_message("ORDER_C", 6, message(6, TARGET_RECORDER, 300_000, b"order-c"), "independent message C")
add_message("WRONG_DESTINATION", 7, message(7, TARGET_RECORDER, 200_000, b"x", destination=56), "destination chain 56")
add_message("WRONG_SOURCE", 8, message(8, TARGET_RECORDER, 200_000, b"x", source=56), "source chain 56 from the real remote bridge")
add_message("BAD_DATA_TYPE", 9, message(9, TARGET_RECORDER, 200_000, b"x", data_type=7), "data type 7, which no bridge sends")
add_message("BAD_VERSION", 10, message(10, TARGET_RECORDER, 200_000, b"x", version=0x00040000), "message identifier with another format version")
mismatch = message(11, TARGET_RECORDER, 200_000, b"x")
add_message("ID_MISMATCH", 11, mismatch, "the topic holds another identifier than the message",
            log=request_log(REMOTE_BRIDGE, message_id(99), mismatch["encoded"]))
add_message("EMPTY_DATA", 12, message(12, TARGET_RECORDER, 300_000, b""), "no call data; legacy receipt and legacy transaction", receipt_kind=0)
add_message("HIGH_GAS", 13, message(13, TARGET_RECORDER, 2_000_000, b"high-gas"), "asks for 2,000,000 gas")
two_a, two_b = message(14, TARGET_RECORDER, 300_000, b"two-a"), message(15, TARGET_RECORDER, 300_000, b"two-b")
message_receipts[14] = receipt(2, True, [other_log(REMOTE_BRIDGE), request_log(REMOTE_BRIDGE, two_a["id"], two_a["encoded"]),
                                         request_log(REMOTE_BRIDGE, two_b["id"], two_b["encoded"])])
message_transactions[14] = transaction(14, 2)
MESSAGE_NAMED.append(dict(label="TWO_A", index=14, logIndex=1, message=two_a, note="first message of a transaction with two"))
MESSAGE_NAMED.append(dict(label="TWO_B", index=14, logIndex=2, message=two_b, note="second message of the same transaction"))
add_message("OTHER_EMITTER", 16, message(16, TARGET_RECORDER, 200_000, b"x"), "a message log from a contract that is not the remote bridge",
            log=request_log(OTHER_EMITTER, message_id(16), message(16, TARGET_RECORDER, 200_000, b"x")["encoded"]))
add_message("FAILED", 17, message(17, TARGET_RECORDER, 200_000, b"x"), "status 0 receipt with a message log", success=False)
add_message("OTHER_TOPIC", 18, message(18, TARGET_RECORDER, 200_000, b"x"), "a log of the remote bridge with another topic 0",
            log=request_log(REMOTE_BRIDGE, message_id(18), b"", topic=OTHER_TOPIC))
short = message(19, TARGET_RECORDER, 200_000, b"x")
add_message("SHORT_MESSAGE", 19, short, "the event data holds 10 bytes, fewer than a message header",
            log=request_log(REMOTE_BRIDGE, short["id"], b"0123456789"))
non_canonical = message(20, TARGET_RECORDER, 200_000, b"x")
add_message("NON_CANONICAL_DATA", 20, non_canonical, "the event data starts with the offset 64 instead of 32",
            log=request_log(REMOTE_BRIDGE, non_canonical["id"], non_canonical["encoded"],
                            data=word(64) + word(0) + word(len(non_canonical["encoded"])) + non_canonical["encoded"] + b"\x00" * (-len(non_canonical["encoded"]) % 32)))
add_message("REENTRANT", 21, message(21, TARGET_REENTRANT, 500_000, b"reenter"), "a target that calls executeMessage during its own delivery")
add_message("SENDING", 22, message(22, TARGET_SENDER, 500_000, b"send"), "a target that sends a message during its own delivery")
for index in range(MESSAGE_TOTAL):
    if index not in message_receipts:
        message_receipts[index] = receipt(2, True, [other_log(OTHER_EMITTER)])
        message_transactions[index] = transaction(index, 2)

receipts_root, receipts_top, receipts_nodes, message_keys = build_trie([message_receipts[i] for i in range(MESSAGE_TOTAL)])
transactions_root, transactions_top, transactions_nodes, _ = build_trie([message_transactions[i] for i in range(MESSAGE_TOTAL)])
receipt_proofs, transaction_proofs = {}, {}
for entry in MESSAGE_NAMED:
    i = entry["index"]
    if i in receipt_proofs:
        continue
    receipt_proofs[i] = prove(receipts_top, message_keys[i], receipts_nodes)
    transaction_proofs[i] = prove(transactions_top, message_keys[i], transactions_nodes)
    assert decode(receipt_proofs[i][-1])[1] == message_receipts[i]
    assert decode(transaction_proofs[i][-1])[1] == message_transactions[i]

with open(os.path.join(here, "messages.json"), "w") as handle:
    json.dump({
        "receiptsRoot": "0x" + receipts_root.hex(), "transactionsRoot": "0x" + transactions_root.hex(),
        "constants": {"remoteBridge": "0x" + REMOTE_BRIDGE.hex(), "sender": "0x" + SENDER.hex(),
                      "recorder": "0x" + TARGET_RECORDER.hex(), "reverter": "0x" + TARGET_REVERTER.hex(),
                      "burner": "0x" + TARGET_BURNER.hex(), "reentrant": "0x" + TARGET_REENTRANT.hex(), "sending": "0x" + TARGET_SENDER.hex(), "otherEmitter": "0x" + OTHER_EMITTER.hex(),
                      "sourceChainId": SOURCE_CHAIN, "destinationChainId": DESTINATION_CHAIN,
                      "userRequestTopic": "0x" + USER_REQUEST_TOPIC.hex()},
        "messages": [dict(label=e["label"], transactionIndex=e["index"], logIndex=e["logIndex"], note=e["note"],
                          messageId="0x" + e["message"]["id"].hex(), encoded="0x" + e["message"]["encoded"].hex(),
                          transactionHash="0x" + keccak256(message_transactions[e["index"]]).hex(),
                          receiptProof=["0x" + n.hex() for n in receipt_proofs[e["index"]]],
                          transactionProof=["0x" + n.hex() for n in transaction_proofs[e["index"]]]) for e in MESSAGE_NAMED],
    }, handle, indent=2)
    handle.write("\n")

message_lines = []
message_lines.append("// SPDX-License-Identifier: MIT")
message_lines.append("pragma solidity ^0.8.24;")
message_lines.append("")
message_lines.append("// GENERATED by test/hardened/fixtures/generate_receipts.py. Do not edit by hand.")
message_lines.append("")
message_lines.append("/// @notice Synthetic receipts and transactions tries (%d entries each, the same indices) with message logs." % MESSAGE_TOTAL)
message_lines.append("library MessageFixtures {")
message_lines.append("    bytes32 internal constant RECEIPTS_ROOT = 0x%s;" % receipts_root.hex())
message_lines.append("    bytes32 internal constant TRANSACTIONS_ROOT = 0x%s;" % transactions_root.hex())
message_lines.append("    address internal constant REMOTE_BRIDGE = 0x%s;" % REMOTE_BRIDGE.hex())
message_lines.append("    address internal constant SENDER = 0x%s;" % SENDER.hex())
message_lines.append("    address internal constant OTHER_EMITTER = 0x%s;" % OTHER_EMITTER.hex())
message_lines.append("    address internal constant TARGET_RECORDER = 0x%s;" % TARGET_RECORDER.hex())
message_lines.append("    address internal constant TARGET_REVERTER = 0x%s;" % TARGET_REVERTER.hex())
message_lines.append("    address internal constant TARGET_BURNER = 0x%s;" % TARGET_BURNER.hex())
message_lines.append("    address internal constant TARGET_REENTRANT = 0x%s;" % TARGET_REENTRANT.hex())
message_lines.append("    address internal constant TARGET_SENDING = 0x%s;" % TARGET_SENDER.hex())
message_lines.append("    uint64 internal constant SOURCE_CHAIN_ID = %d;" % SOURCE_CHAIN)
message_lines.append("    uint64 internal constant DESTINATION_CHAIN_ID = %d;" % DESTINATION_CHAIN)
message_lines.append("")
message_lines.append("    /// @param transactionIndex The index in both tries.")
message_lines.append("    /// @param logIndex The index of the log inside the receipt.")
message_lines.append("    /// @param messageId The identifier of the message.")
message_lines.append("    /// @param transactionHash The hash of the transaction at the index.")
message_lines.append("    /// @param encoded The message as the Arbitrary Message Bridge encodes it.")
message_lines.append("    struct Named {")
message_lines.append("        uint256 transactionIndex;")
message_lines.append("        uint256 logIndex;")
message_lines.append("        bytes32 messageId;")
message_lines.append("        bytes32 transactionHash;")
message_lines.append("        bytes encoded;")
message_lines.append("    }")
message_lines.append("")
for e in MESSAGE_NAMED:
    message_lines.append("    /// @dev %s" % e["note"])
    message_lines.append("    function %s() internal pure returns (Named memory) {" % e["label"].lower())
    message_lines.append("        return Named(%d, %d, 0x%s, 0x%s, %s);" % (
        e["index"], e["logIndex"], e["message"]["id"].hex(), keccak256(message_transactions[e["index"]]).hex(), hexlit(e["message"]["encoded"])))
    message_lines.append("    }")
    message_lines.append("")
for name, proofs in (("receiptProofFor", receipt_proofs), ("transactionProofFor", transaction_proofs)):
    message_lines.append("    /// @notice The proof nodes from the %s root to the entry at `transactionIndex`." % ("receipts" if name.startswith("receipt") else "transactions"))
    message_lines.append("    function %s(uint256 transactionIndex) internal pure returns (bytes[] memory proof) {" % name)
    for i, proof in proofs.items():
        message_lines.append("        if (transactionIndex == %d) {" % i)
        message_lines.append("            proof = new bytes[](%d);" % len(proof))
        for j, node in enumerate(proof):
            message_lines.append("            proof[%d] = %s;" % (j, hexlit(node)))
        message_lines.append("            return proof;")
        message_lines.append("        }")
    message_lines.append('        revert("MessageFixtures: no proof for this index");')
    message_lines.append("    }")
    message_lines.append("")
message_lines[-1:] = ["}"]
with open(os.path.join(here, "..", "utils", "MessageFixtures.sol"), "w") as handle:
    handle.write("\n".join(message_lines) + "\n")
print("message receipts root", receipts_root.hex(), "transactions root", transactions_root.hex())
