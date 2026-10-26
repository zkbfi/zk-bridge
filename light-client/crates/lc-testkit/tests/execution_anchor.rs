//! The tolerant execution header decoder: it reads `number`, `receiptsRoot` and `timestamp` at their fixed positions from a
//! header of ANY field count, and refuses a header whose pinned positions have the wrong type or whose list is malformed.
//!
//! The headers are built item by item here, so the test shares no code with the encoder of `lc-core`.

use alloy_primitives::B256;
use alloy_rlp::Header;
use lc_core::execution::{decode_execution_anchor_fields, decode_execution_header};
use lc_core::Error;

/// An RLP list of already encoded items.
fn list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.concat();
    let mut out = Vec::new();
    Header { list: true, payload_length: payload.len() }.encode(&mut out);
    out.extend(payload);
    out
}

fn string(bytes: &[u8]) -> Vec<u8> {
    alloy_rlp::encode(bytes)
}

fn integer(value: u64) -> Vec<u8> {
    alloy_rlp::encode(value)
}

const RECEIPTS_ROOT: [u8; 32] = [0x55; 32];
const NUMBER: u64 = 12_031_594;
const TIMESTAMP: u64 = 1_792_040_000;

/// The first 15 items of a header with a marker value at the three positions that are read, and the given extra items.
fn header_with(extra_items: usize) -> Vec<Vec<u8>> {
    let mut items = vec![
        string(&[0x01; 32]),    // 0 parentHash
        string(&[0x02; 32]),    // 1 ommersHash
        string(&[0x03; 20]),    // 2 beneficiary
        string(&[0x04; 32]),    // 3 stateRoot
        string(&[0x05; 32]),    // 4 transactionsRoot
        string(&RECEIPTS_ROOT), // 5 receiptsRoot
        string(&[0u8; 256]),    // 6 logsBloom
        integer(0),             // 7 difficulty
        integer(NUMBER),        // 8 number
        integer(30_000_000),    // 9 gasLimit
        integer(21_000),        // 10 gasUsed
        integer(TIMESTAMP),     // 11 timestamp
        string(b"extra"),       // 12 extraData
        string(&[0x06; 32]),    // 13 mixHash
        string(&[0u8; 8]),      // 14 nonce
    ];
    // The items that later forks append, typed as the chain types them: `baseFeePerGas`, `withdrawalsRoot`, `blobGasUsed`,
    // `excessBlobGas`, `parentBeaconBlockRoot`, `requestsHash`, then 32 byte items (`blockAccessListHash` and later).
    let appended = [integer(7), string(&[0x07; 32]), integer(0), integer(0), string(&[0x08; 32]), string(&[0x09; 32])];
    items.extend(
        (0..extra_items).map(|index| appended.get(index).cloned().unwrap_or_else(|| string(&[index as u8; 32]))),
    );
    items
}

/// Claim: the decoder reads the same three values from headers of 15 (Frontier), 16 (London), 17 (Shanghai), 20 (Cancun),
/// 21 (Prague), 23 (Amsterdam) and 40 items. The values are the markers that the builder wrote, so a shifted position
/// shows at once. The control: the strict decoder agrees on the field counts that it knows, and refuses 23 and 40.
#[test]
fn every_field_count_gives_the_same_three_fields() {
    for extra in [0usize, 1, 2, 5, 6, 8, 25] {
        let rlp = list(&header_with(extra));
        let fields =
            decode_execution_anchor_fields(&rlp).unwrap_or_else(|error| panic!("{} items: {error}", 15 + extra));
        assert_eq!(fields.number, NUMBER, "{} items", 15 + extra);
        assert_eq!(fields.timestamp, TIMESTAMP, "{} items", 15 + extra);
        assert_eq!(fields.receipts_root, B256::from(RECEIPTS_ROOT), "{} items", 15 + extra);
        let strict_knows = [15usize, 16, 17, 20, 21].contains(&(15 + extra));
        assert_eq!(decode_execution_header(&rlp).is_ok(), strict_knows, "{} items: the strict decoder", 15 + extra);
    }
}

/// Claim: the positions are pinned. Swapping the number and the timestamp, or the receipts root and the state root, swaps
/// the values that are read. A decoder that searched for "the first 32 byte string" would not.
#[test]
fn the_positions_are_pinned() {
    let mut swapped = header_with(8);
    swapped.swap(8, 11);
    let fields = decode_execution_anchor_fields(&list(&swapped)).unwrap();
    assert_eq!((fields.number, fields.timestamp), (TIMESTAMP, NUMBER));

    let mut roots = header_with(8);
    roots.swap(3, 5);
    assert_eq!(decode_execution_anchor_fields(&list(&roots)).unwrap().receipts_root, B256::repeat_byte(0x04));
}

/// Claim: malformed headers are refused with `HeaderDecode`. Fewer than 15 items; more than 64; a receipts root that is not
/// 32 bytes; a number that is a list; a number with a leading zero (a non canonical integer); a timestamp wider than 64
/// bits; trailing bytes after the list; a list that is cut short; and a header that is not a list.
#[test]
fn malformed_headers_are_refused() {
    let refused = |bytes: Vec<u8>, why: &str| {
        assert!(matches!(decode_execution_anchor_fields(&bytes), Err(Error::HeaderDecode(_))), "{why}");
    };
    refused(list(&header_with(0)[..14]), "14 items");
    refused(list(&header_with(0)[..3]), "3 items");
    refused(list(&header_with(50)), "65 items");

    let mut short_root = header_with(8);
    short_root[5] = string(&[0x55; 31]);
    refused(list(&short_root), "receipts root of 31 bytes");

    let mut list_number = header_with(8);
    list_number[8] = list(&[integer(1)]);
    refused(list(&list_number), "a list as number");

    let mut leading_zero = header_with(8);
    leading_zero[8] = string(&[0x00, 0x01]);
    refused(list(&leading_zero), "number 0x0001");

    let mut wide = header_with(8);
    wide[11] = string(&[0x01; 9]);
    refused(list(&wide), "a 9 byte timestamp");

    let mut trailing = list(&header_with(8));
    trailing.push(0x80);
    refused(trailing, "trailing bytes");

    let mut cut = list(&header_with(8));
    cut.truncate(cut.len() - 5);
    refused(cut, "a cut list");

    refused(string(&[0x01; 40]), "a string, not a list");
    refused(Vec::new(), "no bytes");

    // The control: the unchanged header decodes.
    assert!(decode_execution_anchor_fields(&list(&header_with(8))).is_ok());
}

/// Claim: an item whose length prefix runs past the end of the list is refused, also when it is a skipped item (index 20).
#[test]
fn a_skipped_item_must_fit_the_list() {
    let mut items = header_with(8);
    // Item 20 claims 40 bytes but holds 3.
    items[20] = vec![0xb8, 40, 1, 2, 3];
    let bytes = list(&items);
    assert!(matches!(decode_execution_anchor_fields(&bytes), Err(Error::HeaderDecode(_))));
}
