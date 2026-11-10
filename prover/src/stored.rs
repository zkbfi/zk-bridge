//! What a `BeaconLightClient` contract stores, read from its chain with view calls and logs only.
//!
//! The producer starts an update at the stored head. The evidence builder anchors a message proof at a stored header and
//! needs the slots of the heads that the light client stored by updates. Both read the chain here.

use crate::beacon::StoredHead;
use crate::chain::ChainClient;
use crate::contracts::{head_updated_topic, LightClientContract};
use crate::error::{Error, Result};
use alloy_primitives::{Address, B256};

/// The values of a light client that an update must agree with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoredState {
    /// The stored head.
    pub head: StoredHead,
    /// The genesis validators root of the tracked beacon chain.
    pub genesis_validators_root: B256,
    /// The committee hash stored for the period of the head.
    pub head_committee_hash: B256,
    /// The program key that the light client verifies proofs against.
    pub program_key: B256,
}

/// Reads the head, the committee hashes and the program key of the light client at `address`.
///
/// # Errors
/// `Error::Rpc` when a call reverts. `Error::Malformed` when an answer does not decode. `Error::Config` when the contract
/// has no head yet or reports zero slots per period (it is not a light client).
pub fn read_stored_state(client: &ChainClient, address: Address) -> Result<StoredState> {
    let head_slot = client.view(address, LightClientContract::headCall {})?;
    let slots_per_period = client.view(address, LightClientContract::slotsPerPeriodCall {})?;
    if slots_per_period == 0 {
        return Err(Error::Config(format!(
            "{address:#x} on chain {} reports zero slots per period: it is not a beacon light client",
            client.name()
        )));
    }
    let period = head_slot / slots_per_period;
    let head_root = client.view(
        address,
        LightClientContract::headersCall { slot: head_slot },
    )?;
    if head_root == B256::ZERO {
        return Err(Error::Config(format!(
            "the light client {address:#x} on chain {} stores no header at its head slot {head_slot}",
            client.name()
        )));
    }
    Ok(StoredState {
        head: StoredHead {
            slot: head_slot,
            root: head_root,
            next_committee_hash: client.view(
                address,
                LightClientContract::syncCommitteesCall { period: period + 1 },
            )?,
        },
        genesis_validators_root: client
            .view(address, LightClientContract::genesisValidatorsRootCall {})?,
        head_committee_hash: client
            .view(address, LightClientContract::syncCommitteesCall { period })?,
        program_key: client.view(address, LightClientContract::programVKeyCall {})?,
    })
}

/// Reads the header root that the light client stores for `slot`, or `None` when it stores none.
///
/// # Errors
/// `Error::Rpc` when the call reverts.
pub fn read_stored_header(
    client: &ChainClient,
    address: Address,
    slot: u64,
) -> Result<Option<B256>> {
    let root = client.view(address, LightClientContract::headersCall { slot })?;
    Ok((root != B256::ZERO).then_some(root))
}

/// The slots of every head that the light client stored by an update, from its `HeadUpdated` events.
///
/// The scan starts at `start_block` and reads `log_block_range` blocks at a time. `start_block` must be at or before the
/// deployment of the LIGHT CLIENT, not of a bridge: a light client kept across a bridge redeploy holds heads stored before
/// it, and a message sent just after the redeploy needs one of those older heads for its block hash row.
///
/// # Errors
/// `Error::Rpc` when a log call fails. `Error::Malformed` for an event without a slot topic. `Error::Config` when
/// `log_block_range` is zero.
pub fn read_stored_slots(
    client: &ChainClient,
    address: Address,
    start_block: u64,
    log_block_range: u64,
) -> Result<Vec<u64>> {
    if log_block_range == 0 {
        return Err(Error::Config(
            "the log block range is zero: a scan needs at least one block per call".into(),
        ));
    }
    let latest = client.latest_block_number()?;
    let mut slots = Vec::new();
    let mut from = start_block;
    while from <= latest {
        let to = latest.min(from.saturating_add(log_block_range - 1));
        for log in client.logs(address, head_updated_topic(), from, to)? {
            let slot_topic = log
                .topics
                .get(1)
                .ok_or_else(|| Error::Malformed("HeadUpdated without a slot topic".into()))?;
            slots.push(u64::from_be_bytes(
                slot_topic[24..].try_into().expect("8 bytes"),
            ));
        }
        from = to + 1;
    }
    Ok(slots)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::fake::ScriptedRpc;
    use alloy_primitives::hex;
    use alloy_sol_types::SolCall;
    use serde_json::{json, Value};
    use std::sync::Mutex;

    /// A light client at head slot 20_000 (period 2 of 8192 slots) with distinct committee hashes for periods 2 and 3.
    fn light_client_node(program_key: B256) -> ChainClient {
        let handler = move |method: &str, params: &Value| -> Result<Value> {
            if method == "eth_chainId" {
                return Ok(json!("0x171"));
            }
            assert_eq!(method, "eth_call");
            let data = hex::decode(params[0]["data"].as_str().unwrap()).unwrap();
            let selector: [u8; 4] = data[..4].try_into().unwrap();
            let word = |value: B256| Ok(json!(format!("0x{}", hex::encode(value))));
            let number = |value: u64| word(B256::from(alloy_primitives::U256::from(value)));
            match selector {
                LightClientContract::headCall::SELECTOR => number(20_000),
                LightClientContract::slotsPerPeriodCall::SELECTOR => number(8192),
                LightClientContract::headersCall::SELECTOR => {
                    let call = LightClientContract::headersCall::abi_decode(&data).unwrap();
                    word(if call.slot == 20_000 {
                        B256::repeat_byte(0xaa)
                    } else {
                        B256::ZERO
                    })
                }
                LightClientContract::syncCommitteesCall::SELECTOR => {
                    let call = LightClientContract::syncCommitteesCall::abi_decode(&data).unwrap();
                    word(match call.period {
                        2 => B256::repeat_byte(0x02),
                        3 => B256::repeat_byte(0x03),
                        _ => B256::ZERO,
                    })
                }
                LightClientContract::genesisValidatorsRootCall::SELECTOR => {
                    word(B256::repeat_byte(0x11))
                }
                LightClientContract::programVKeyCall::SELECTOR => word(program_key),
                other => panic!("unexpected call {other:?}"),
            }
        };
        let rpc = ScriptedRpc {
            calls: Mutex::new(vec![]),
            handler: Box::new(handler),
        };
        ChainClient::connect("test", 369, Box::new(rpc)).unwrap()
    }

    /// Claim: the head comes from `head()`, its root from `headers(head)`, the next committee hash from the period AFTER
    /// the head, and the head committee hash from the period OF the head.
    /// Why it matters: an update that carries the wrong next committee, or none, is refused by the contract. The two
    /// hashes differ here, so a swap of the periods fails this test.
    #[test]
    fn the_stored_state_uses_the_period_of_the_head_and_the_next_one() {
        let key = B256::repeat_byte(0x42);
        let state = read_stored_state(&light_client_node(key), Address::repeat_byte(0x44)).unwrap();
        assert_eq!(state.head.slot, 20_000);
        assert_eq!(state.head.root, B256::repeat_byte(0xaa));
        assert_eq!(state.head_committee_hash, B256::repeat_byte(0x02));
        assert_eq!(state.head.next_committee_hash, B256::repeat_byte(0x03));
        assert_eq!(state.genesis_validators_root, B256::repeat_byte(0x11));
        assert_eq!(state.program_key, key);
    }

    /// Claim: an unknown slot gives `None`, not a zero root.
    /// Why it matters: a zero root would pass for a stored header and send the evidence builder to a header that the
    /// light client never stored.
    #[test]
    fn a_slot_without_a_header_is_none() {
        let node = light_client_node(B256::ZERO);
        let address = Address::repeat_byte(0x44);
        assert_eq!(
            read_stored_header(&node, address, 20_000).unwrap(),
            Some(B256::repeat_byte(0xaa))
        );
        assert_eq!(read_stored_header(&node, address, 19_999).unwrap(), None);
    }

    /// Claim: a log range of zero is a configuration error, not a wrapped subtraction.
    /// Why it matters: `log_block_range - 1` on zero wraps in a release build and asks the node for every block at once.
    #[test]
    fn a_zero_log_range_is_refused() {
        let handler = |method: &str, _params: &Value| -> Result<Value> {
            match method {
                "eth_chainId" => Ok(json!("0x171")),
                other => panic!("unexpected {other}"),
            }
        };
        let rpc = ScriptedRpc {
            calls: Mutex::new(vec![]),
            handler: Box::new(handler),
        };
        let node = ChainClient::connect("test", 369, Box::new(rpc)).unwrap();
        let error = read_stored_slots(&node, Address::repeat_byte(0x44), 0, 0).unwrap_err();
        assert!(matches!(error, Error::Config(_)), "{error}");
    }

    /// Claim: the log scan covers the whole range in pages of the given size and reads the slot from topic 1.
    /// Why it matters: public nodes refuse wide log ranges. A page that skips a block loses a stored slot, and the layout
    /// evidence then cannot find the stored header it needs.
    #[test]
    fn stored_slots_are_scanned_in_pages() {
        let ranges = std::sync::Arc::new(Mutex::new(Vec::new()));
        let seen = ranges.clone();
        let handler = move |method: &str, params: &Value| -> Result<Value> {
            match method {
                "eth_chainId" => Ok(json!("0x171")),
                "eth_blockNumber" => Ok(json!("0x9")),
                "eth_getLogs" => {
                    let from = params[0]["fromBlock"].as_str().unwrap().to_string();
                    let to = params[0]["toBlock"].as_str().unwrap().to_string();
                    seen.lock().unwrap().push((from.clone(), to));
                    if from != "0x2" {
                        return Ok(json!([]));
                    }
                    let slot_topic =
                        format!("{:#x}", B256::from(alloy_primitives::U256::from(77u64)));
                    Ok(json!([{
                        "address": format!("{:#x}", Address::repeat_byte(0x44)),
                        "topics": [format!("{:#x}", head_updated_topic()), slot_topic],
                        "data": "0x",
                        "blockNumber": "0x4",
                        "blockHash": format!("{:#x}", B256::repeat_byte(1)),
                        "transactionHash": format!("{:#x}", B256::repeat_byte(2)),
                        "transactionIndex": "0x0",
                        "logIndex": "0x0",
                    }]))
                }
                other => panic!("unexpected {other}"),
            }
        };
        let rpc = ScriptedRpc {
            calls: Mutex::new(vec![]),
            handler: Box::new(handler),
        };
        let node = ChainClient::connect("test", 369, Box::new(rpc)).unwrap();
        let slots = read_stored_slots(&node, Address::repeat_byte(0x44), 2, 3).unwrap();
        assert_eq!(slots, vec![77]);
        assert_eq!(
            *ranges.lock().unwrap(),
            vec![
                ("0x2".to_string(), "0x4".to_string()),
                ("0x5".to_string(), "0x7".to_string()),
                ("0x8".to_string(), "0x9".to_string()),
            ]
        );
    }
}
