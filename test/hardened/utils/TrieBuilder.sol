// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TrieBuilder
/// @notice Builds Merkle Patricia tries inside a test and proves single entries, in the encoding of Ethereum.
/// @dev The tries hold leaf, extension and branch nodes with hex-prefix paths. A node whose RLP is shorter than 32 bytes
/// sits inside its parent. The root node is always hashed. A key may end at a branch node, which then carries the value.
/// Two keys may not be equal. The proof lists every node from the root to the leaf, embedded nodes included, in the
/// order that `MerkleTrie.get` expects.
library TrieBuilder {
    /// @notice The keys and the values have different lengths.
    error LengthMismatch(uint256 keyCount, uint256 valueCount);
    /// @notice A key has no bytes.
    error EmptyKey(uint256 position);
    /// @notice Two entries have the same key.
    error DuplicateKey(uint256 firstPosition, uint256 secondPosition);
    /// @notice The position of a proof is not an entry of the trie.
    error PositionOutOfRange(uint256 position, uint256 count);

    /// @dev The two kinds of node that carry a path in their first field.
    enum PathKind {
        Extension,
        Leaf
    }

    /// @dev One entry of a trie: the key as one nibble per byte, the value, and the position in the input.
    struct Entry {
        bytes nibbles;
        bytes value;
        uint256 position;
    }

    /// @dev Records the nodes on the way to the leaves that a caller wants to prove. The build adds a node to the path of
    /// every wanted entry below it, from the leaf up to the root. Entries are identified by their input position.
    struct Collector {
        bool[] wanted;
        bytes[][] paths;
        uint256[] counts;
    }

    // ---------------------------------------------------------------- general trie

    /// @notice Computes the root hash of a trie.
    /// @param keys The keys of the entries.
    /// @param values The values of the entries, in the order of the keys.
    /// @return The hash of the root node. An empty trie has the hash of the empty string encoding.
    function rootOf(bytes[] memory keys, bytes[] memory values) internal pure returns (bytes32) {
        if (keys.length == 0 && values.length == 0) return keccak256(hex"80");
        Entry[] memory entries = _entries(keys, values);
        return keccak256(_build(entries, 0, _emptyCollector(entries.length)));
    }

    /// @notice Builds the proof of one entry.
    /// @param keys The keys of the entries.
    /// @param values The values of the entries, in the order of the keys.
    /// @param position The position of the entry to prove.
    /// @return nodes The encoded nodes from the root node to the leaf.
    function proofOf(bytes[] memory keys, bytes[] memory values, uint256 position)
        internal
        pure
        returns (bytes[] memory nodes)
    {
        if (position >= keys.length) revert PositionOutOfRange(position, keys.length);
        Entry[] memory entries = _entries(keys, values);
        Collector memory collector = _emptyCollector(entries.length);
        _want(collector, entries[position]);
        _build(entries, 0, collector);
        return _reversed(collector, position);
    }

    /// @notice Builds the proofs of all entries in one pass. It costs far less than one `proofOf` call per entry.
    /// @param keys The keys of the entries.
    /// @param values The values of the entries, in the order of the keys.
    /// @return proofs The proof of every entry, in the order of the keys.
    function proofsOf(bytes[] memory keys, bytes[] memory values) internal pure returns (bytes[][] memory proofs) {
        Entry[] memory entries = _entries(keys, values);
        Collector memory collector = _emptyCollector(entries.length);
        for (uint256 i = 0; i < entries.length; i++) {
            _want(collector, entries[i]);
        }
        _build(entries, 0, collector);
        proofs = new bytes[][](entries.length);
        for (uint256 i = 0; i < entries.length; i++) {
            proofs[i] = _reversed(collector, i);
        }
    }

    // ---------------------------------------------------------------- index keyed trie

    /// @notice The key of item `index` in a transactions trie or a receipts trie: the RLP encoding of the integer.
    /// @param index The position of the item in its block.
    /// @return The key. Zero gives 0x80, 1 to 127 give one byte, larger numbers give a length byte and the number.
    function indexKey(uint256 index) internal pure returns (bytes memory) {
        return encodeUint(index);
    }

    /// @notice Computes the root hash of a trie where item `i` has the key `indexKey(i)`.
    /// @param values The items in block order.
    /// @return The root hash.
    function indexedRoot(bytes[] memory values) internal pure returns (bytes32) {
        return rootOf(_indexKeys(values.length), values);
    }

    /// @notice Builds the proof of item `index` in a trie where item `i` has the key `indexKey(i)`.
    /// @param values The items in block order.
    /// @param index The position of the item to prove.
    /// @return The encoded nodes from the root node to the leaf.
    function indexedProof(bytes[] memory values, uint256 index) internal pure returns (bytes[] memory) {
        return proofOf(_indexKeys(values.length), values, index);
    }

    /// @notice Builds the proofs of all items of a trie where item `i` has the key `indexKey(i)`.
    /// @param values The items in block order.
    /// @return The proof of every item, in block order.
    function indexedProofs(bytes[] memory values) internal pure returns (bytes[][] memory) {
        return proofsOf(_indexKeys(values.length), values);
    }

    // ---------------------------------------------------------------- RLP encoding

    /// @notice Encodes a byte string in RLP.
    /// @param data The bytes to encode.
    /// @return The encoding.
    function encodeBytes(bytes memory data) internal pure returns (bytes memory) {
        if (data.length == 1 && uint8(data[0]) < 0x80) return data;
        return bytes.concat(_prefix(data.length, 0x80), data);
    }

    /// @notice Encodes an integer in RLP: the big-endian bytes without leading zeros, as a byte string.
    /// @param number The integer to encode.
    /// @return The encoding. Zero gives 0x80.
    function encodeUint(uint256 number) internal pure returns (bytes memory) {
        return encodeBytes(_minimalBytes(number));
    }

    /// @notice Encodes a list of items that are already encoded.
    /// @param encodedItems The encoded items.
    /// @return The encoding of the list.
    function encodeList(bytes[] memory encodedItems) internal pure returns (bytes memory) {
        bytes memory body;
        for (uint256 i = 0; i < encodedItems.length; i++) {
            body = bytes.concat(body, encodedItems[i]);
        }
        return bytes.concat(_prefix(body.length, 0xc0), body);
    }

    /// @dev The header of a string (offset 0x80) or a list (offset 0xc0) with a payload of `length` bytes.
    function _prefix(uint256 length, uint8 offset) private pure returns (bytes memory) {
        if (length < 56) return abi.encodePacked(uint8(offset + length));
        bytes memory size = _minimalBytes(length);
        return bytes.concat(abi.encodePacked(uint8(offset + 55 + size.length)), size);
    }

    /// @dev The big-endian bytes of a number without leading zeros. Zero gives no bytes.
    function _minimalBytes(uint256 number) private pure returns (bytes memory trimmed) {
        bytes memory full = abi.encodePacked(number);
        uint256 skip;
        while (skip < full.length && full[skip] == 0) skip++;
        trimmed = new bytes(full.length - skip);
        for (uint256 i = 0; i < trimmed.length; i++) {
            trimmed[i] = full[skip + i];
        }
    }

    // ---------------------------------------------------------------- node building

    function _indexKeys(uint256 count) private pure returns (bytes[] memory keys) {
        keys = new bytes[](count);
        for (uint256 i = 0; i < count; i++) {
            keys[i] = indexKey(i);
        }
    }

    /// @dev Checks the input and turns every key into nibbles.
    function _entries(bytes[] memory keys, bytes[] memory values) private pure returns (Entry[] memory entries) {
        if (keys.length != values.length) revert LengthMismatch(keys.length, values.length);
        entries = new Entry[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            if (keys[i].length == 0) revert EmptyKey(i);
            entries[i] = Entry({nibbles: _nibblesOf(keys[i]), value: values[i], position: i});
        }
    }

    function _nibblesOf(bytes memory key) private pure returns (bytes memory nibbles) {
        nibbles = new bytes(key.length * 2);
        for (uint256 i = 0; i < key.length; i++) {
            nibbles[2 * i] = bytes1(uint8(key[i]) >> 4);
            nibbles[2 * i + 1] = bytes1(uint8(key[i]) & 0x0f);
        }
    }

    /// @dev A collector that records nothing yet.
    function _emptyCollector(uint256 count) private pure returns (Collector memory) {
        return Collector({wanted: new bool[](count), paths: new bytes[][](count), counts: new uint256[](count)});
    }

    /// @dev Makes the collector record the path of one entry.
    function _want(Collector memory collector, Entry memory entry) private pure {
        collector.wanted[entry.position] = true;
        collector.paths[entry.position] = new bytes[](entry.nibbles.length + 2);
    }

    /// @dev Encodes the node for `entries`, which all share their first `depth` nibbles. The node joins the path of every
    /// wanted entry below it.
    function _build(Entry[] memory entries, uint256 depth, Collector memory collector)
        private
        pure
        returns (bytes memory encoded)
    {
        encoded = _encodeNode(entries, depth, collector);
        for (uint256 i = 0; i < entries.length; i++) {
            uint256 position = entries[i].position;
            if (!collector.wanted[position]) continue;
            collector.paths[position][collector.counts[position]] = encoded;
            collector.counts[position] += 1;
        }
    }

    function _encodeNode(Entry[] memory entries, uint256 depth, Collector memory collector)
        private
        pure
        returns (bytes memory)
    {
        if (entries.length == 1) return _leaf(entries[0], depth);
        uint256 shared = _sharedLength(entries, depth);
        if (shared > 0) return _extension(entries, depth, shared, collector);
        return _branch(entries, depth, collector);
    }

    function _leaf(Entry memory entry, uint256 depth) private pure returns (bytes memory) {
        bytes[] memory fields = new bytes[](2);
        fields[0] = encodeBytes(_hexPrefix(entry.nibbles, depth, entry.nibbles.length, PathKind.Leaf));
        fields[1] = encodeBytes(entry.value);
        return encodeList(fields);
    }

    function _extension(Entry[] memory entries, uint256 depth, uint256 shared, Collector memory collector)
        private
        pure
        returns (bytes memory)
    {
        bytes[] memory fields = new bytes[](2);
        fields[0] = encodeBytes(_hexPrefix(entries[0].nibbles, depth, depth + shared, PathKind.Extension));
        fields[1] = _reference(_build(entries, depth + shared, collector));
        return encodeList(fields);
    }

    function _branch(Entry[] memory entries, uint256 depth, Collector memory collector)
        private
        pure
        returns (bytes memory)
    {
        Entry[][16] memory groups = _groups(entries, depth);
        bytes[] memory fields = new bytes[](17);
        for (uint256 nibble = 0; nibble < 16; nibble++) {
            if (groups[nibble].length == 0) {
                fields[nibble] = hex"80";
                continue;
            }
            fields[nibble] = _reference(_build(groups[nibble], depth + 1, collector));
        }
        fields[16] = encodeBytes(_valueEndingAt(entries, depth));
        return encodeList(fields);
    }

    /// @dev How a parent holds a child: inside itself when the child is short, else by hash.
    function _reference(bytes memory encodedChild) private pure returns (bytes memory) {
        if (encodedChild.length < 32) return encodedChild;
        return encodeBytes(abi.encodePacked(keccak256(encodedChild)));
    }

    /// @dev The number of nibbles after `depth` that every entry shares and that no entry ends inside of.
    function _sharedLength(Entry[] memory entries, uint256 depth) private pure returns (uint256 shared) {
        bytes memory first = entries[0].nibbles;
        while (true) {
            uint256 at = depth + shared;
            if (!_allContinueWith(entries, at, first)) return shared;
            shared += 1;
        }
    }

    function _allContinueWith(Entry[] memory entries, uint256 at, bytes memory first) private pure returns (bool) {
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].nibbles.length <= at) return false;
            if (entries[i].nibbles[at] != first[at]) return false;
        }
        return true;
    }

    /// @dev Splits the entries that are longer than `depth` by their nibble at `depth`, in one pass over the entries to
    /// count and one to fill.
    function _groups(Entry[] memory entries, uint256 depth) private pure returns (Entry[][16] memory groups) {
        uint256[16] memory counts;
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].nibbles.length <= depth) continue;
            counts[uint8(entries[i].nibbles[depth])]++;
        }
        for (uint256 nibble = 0; nibble < 16; nibble++) {
            groups[nibble] = new Entry[](counts[nibble]);
            counts[nibble] = 0;
        }
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].nibbles.length <= depth) continue;
            uint256 nibble = uint8(entries[i].nibbles[depth]);
            groups[nibble][counts[nibble]] = entries[i];
            counts[nibble]++;
        }
    }

    /// @dev The value of the entry that ends exactly at `depth`, or no bytes when none does.
    function _valueEndingAt(Entry[] memory entries, uint256 depth) private pure returns (bytes memory value) {
        bool found;
        uint256 firstPosition;
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].nibbles.length != depth) continue;
            if (found) revert DuplicateKey(firstPosition, entries[i].position);
            found = true;
            firstPosition = entries[i].position;
            value = entries[i].value;
        }
    }

    /// @dev The hex-prefix encoding of `nibbles[from:to]`. The first nibble holds the leaf flag (2) and the odd flag (1).
    function _hexPrefix(bytes memory nibbles, uint256 from, uint256 to, PathKind kind)
        private
        pure
        returns (bytes memory encoded)
    {
        uint256 length = to - from;
        uint256 flag = kind == PathKind.Leaf ? 2 : 0;
        bool odd = length % 2 == 1;
        encoded = new bytes(length / 2 + 1);
        uint256 cursor = from;
        if (odd) {
            encoded[0] = bytes1(uint8(((flag + 1) << 4) | uint8(nibbles[cursor])));
            cursor++;
        } else {
            encoded[0] = bytes1(uint8(flag << 4));
        }
        for (uint256 i = 1; i < encoded.length; i++) {
            encoded[i] = bytes1(uint8((uint8(nibbles[cursor]) << 4) | uint8(nibbles[cursor + 1])));
            cursor += 2;
        }
    }

    /// @dev The recorded nodes of one entry in root-to-leaf order. The build records them leaf first.
    function _reversed(Collector memory collector, uint256 position) private pure returns (bytes[] memory nodes) {
        uint256 count = collector.counts[position];
        nodes = new bytes[](count);
        for (uint256 i = 0; i < count; i++) {
            nodes[i] = collector.paths[position][count - 1 - i];
        }
    }
}
