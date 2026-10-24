//! Opens the deposits of a source vault.
//!
//! A vault refuses every deposit until `openDeposits` proves that the light client on the OTHER chain stored a head.
//! Without that proof a deposit could never be paid: no stored head lies at or below its slot (finding of the end to
//! end run, `docs/end-to-end-real-proofs.md`).
//!
//! For the route X to Y, deposits are made on chain X in the vault `V_X`. The destination chain Y holds the light
//! client `LC_Y`, which tracks the beacon chain of X. `V_X` has its own light client `LC_X`, which tracks the beacon
//! chain of Y and was updated by the reverse route. The proof says: `LC_X` stored a finalized block of chain Y, and in
//! that block `LC_Y` holds a non-zero `executionBlockHashes` entry. Only `update` writes that entry, so `LC_Y` stored a
//! head at or before that block.
//!
//! [`open_source_vault`] reads the newest head of `LC_X`, fetches the block of chain Y that it names, asks chain Y for
//! the `eth_getProof` proof of `LC_Y` in that block, simulates `openDeposits`, and sends it only when the simulation
//! passes. Anyone can send it: the contract checks every part of the proof. The answer is an [`OpeningOutcome`].
//!
//! Finality lags. `LC_X` must have stored a block of chain Y that is NEWER than the block in which `LC_Y` was first
//! updated, so the first attempt after a first `follow` is usually not ready. The second `follow` of the reverse route
//! stores the newer block.

use crate::chain::ChainClient;
use crate::contracts::{
    open_deposits_calldata, opening_error_name, LightClientContract, OpeningProof, VaultContract,
};
use crate::error::{Error, Result};
use crate::light_client::rebuild_execution_header;
use alloy_primitives::{hex, keccak256, Address, Bytes, B256, U256};
use serde_json::Value;
use std::time::Duration;

/// The storage slot of the mapping `executionBlockHashes` in `BeaconLightClient`. It is the fourth declared state
/// variable. A Solidity test pins this number to the contract (`BridgeVault` holds the same constant), so a change of
/// the contract layout fails a test and not a deployment.
pub const EXECUTION_BLOCK_HASHES_MAPPING_SLOT: u64 = 3;

/// What an attempt to open a vault did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpeningOutcome {
    /// The vault was open already. Nothing was sent.
    AlreadyOpen,
    /// The vault was locked, and this transaction opened it.
    Opened {
        /// The hash of the `openDeposits` transaction.
        transaction: B256,
    },
    /// The vault is still locked. The reason says what is missing. Nothing was sent.
    NotReady {
        /// Why no proof can open the vault yet.
        reason: String,
    },
}

/// What [`open_source_vault`] needs to know about a vault.
#[derive(Clone, Copy, Debug)]
pub struct OpeningTarget {
    /// The vault on the source chain.
    pub vault: Address,
    /// The light client on the destination chain. The vault must name it as `remoteLightClient`.
    pub destination_light_client: Address,
    /// How long to wait for the receipt of the `openDeposits` transaction.
    pub receipt_timeout: Duration,
}

/// The storage entry that the proof reads, with the nodes that prove it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProvenEntry {
    /// The state trie nodes from the state root to the account of the light client.
    pub account_proof: Vec<Bytes>,
    /// The storage trie nodes from the storage root to the entry.
    pub storage_proof: Vec<Bytes>,
    /// The value of the entry.
    pub value: U256,
}

/// The storage slot of `executionBlockHashes[stored_slot]` in a light client: the mapping key and the declared slot of
/// the mapping, hashed together. This is the slot that `eth_getProof` takes. The state trie key is its hash.
pub fn execution_block_hash_slot(stored_slot: u64) -> B256 {
    let mut preimage = [0u8; 64];
    preimage[..32].copy_from_slice(&U256::from(stored_slot).to_be_bytes::<32>());
    preimage[32..]
        .copy_from_slice(&U256::from(EXECUTION_BLOCK_HASHES_MAPPING_SLOT).to_be_bytes::<32>());
    keccak256(preimage)
}

fn parse_node_list(value: &Value, what: &str) -> Result<Vec<Bytes>> {
    value
        .as_array()
        .ok_or_else(|| Error::Malformed(format!("eth_getProof: {what} is not an array")))?
        .iter()
        .map(|node| {
            let text = node.as_str().ok_or_else(|| {
                Error::Malformed(format!("eth_getProof: a node of {what} is not text"))
            })?;
            hex::decode(text)
                .map(Bytes::from)
                .map_err(|error| Error::Malformed(format!("eth_getProof: {what}: {error}")))
        })
        .collect()
}

fn parse_word(value: &Value, what: &str) -> Result<U256> {
    let text = value
        .as_str()
        .ok_or_else(|| Error::Malformed(format!("eth_getProof: {what} is not text")))?;
    let digits = text.trim_start_matches("0x");
    if digits.is_empty() {
        return Ok(U256::ZERO);
    }
    U256::from_str_radix(digits, 16)
        .map_err(|error| Error::Malformed(format!("eth_getProof: {what}: {error}")))
}

/// Reads the `eth_getProof` answer for one storage slot of an account.
///
/// The answer must hold exactly the requested slot, whatever form the node prints its key in.
///
/// # Errors
/// `Error::Malformed` for a missing field, a bad hex string, or an answer for another slot.
pub fn decode_entry_proof(answer: &Value, slot: B256) -> Result<ProvenEntry> {
    let entries = answer["storageProof"]
        .as_array()
        .ok_or_else(|| Error::Malformed("eth_getProof: no storageProof array".into()))?;
    let [entry] = entries.as_slice() else {
        return Err(Error::Malformed(format!(
            "eth_getProof: expected one storage proof, got {}",
            entries.len()
        )));
    };
    if parse_word(&entry["key"], "storage key")? != U256::from_be_bytes(slot.0) {
        return Err(Error::Malformed(format!(
            "eth_getProof: the storage proof is for another slot than {slot:#x}"
        )));
    }
    Ok(ProvenEntry {
        account_proof: parse_node_list(&answer["accountProof"], "accountProof")?,
        storage_proof: parse_node_list(&entry["proof"], "storageProof")?,
        value: parse_word(&entry["value"], "storage value")?,
    })
}

/// Joins the parts into the calldata struct of `openDeposits`.
pub fn assemble_opening_proof(
    remote_slot: u64,
    remote_header_rlp: Bytes,
    stored_slot: u64,
    entry: ProvenEntry,
) -> OpeningProof {
    OpeningProof {
        remoteSlot: remote_slot,
        remoteHeaderRlp: remote_header_rlp,
        accountProof: entry.account_proof,
        storedSlot: stored_slot,
        storageProof: entry.storage_proof,
    }
}

/// Checks that the vault names the destination light client of the route as its `remoteLightClient`.
///
/// The service reads the relationship from the vault and compares it. A vault that names another light client could
/// never be opened by the proof of this route.
///
/// # Errors
/// `Error::Config` when the vault names another light client.
pub fn check_remote_light_client(
    source: &ChainClient,
    vault: Address,
    destination_light_client: Address,
    route_name: &str,
) -> Result<()> {
    let remote = source.view(vault, VaultContract::remoteLightClientCall {})?;
    if remote != destination_light_client {
        return Err(Error::Config(format!(
            "route {route_name}: source vault remoteLightClient is {remote}, the configuration says {destination_light_client}"
        )));
    }
    Ok(())
}

fn not_ready(reason: impl Into<String>) -> Result<OpeningOutcome> {
    Ok(OpeningOutcome::NotReady {
        reason: reason.into(),
    })
}

/// Tries to open the deposits of a source vault. It sends a transaction only when the simulation of `openDeposits`
/// passes.
///
/// `source` is the chain of the vault and needs a signer. `destination` is the chain of the remote light client.
///
/// # Errors
/// A failed read or a node answer of an unknown shape. A proof that cannot exist yet is no error: it gives
/// [`OpeningOutcome::NotReady`].
pub fn open_source_vault(
    source: &ChainClient,
    destination: &ChainClient,
    target: &OpeningTarget,
) -> Result<OpeningOutcome> {
    let vault = target.vault;
    if source.view(vault, VaultContract::depositsOpenCall {})? {
        return Ok(OpeningOutcome::AlreadyOpen);
    }
    let vault_light_client = source.view(vault, VaultContract::lightClientCall {})?;
    let remote_slot = source.view(vault_light_client, LightClientContract::headCall {})?;
    let stored_hash = source.view(
        vault_light_client,
        LightClientContract::executionBlockHashesCall { slot: remote_slot },
    )?;
    if stored_hash.is_zero() {
        return not_ready("the light client on the source chain stored no update yet");
    }
    let block = destination.block_by_hash(stored_hash)?.ok_or_else(|| {
        Error::Malformed(format!(
            "the destination chain does not know block {stored_hash:#x}, which the light client on the source chain stored"
        ))
    })?;
    let header = rebuild_execution_header(&block)?;
    if header.block_hash != stored_hash {
        return Err(Error::Malformed(format!(
            "the destination chain returned block {:#x} for the hash {stored_hash:#x}",
            header.block_hash
        )));
    }
    let number = crate::rpc::parse_quantity(&block["number"])?;
    let remote = target.destination_light_client;
    let stored_slot = destination.view_at(remote, LightClientContract::headCall {}, number)?;
    let slot = execution_block_hash_slot(stored_slot);
    let entry = decode_entry_proof(&destination.account_proof(remote, &[slot], number)?, slot)?;
    if entry.value.is_zero() {
        return not_ready(format!(
            "the destination light client had stored no update in block {number}"
        ));
    }
    let calldata = open_deposits_calldata(assemble_opening_proof(
        remote_slot,
        header.header_rlp,
        stored_slot,
        entry,
    ));
    if let Some(reason) = refusal_of_simulation(source.eth_call(vault, &calldata, true))? {
        return not_ready(reason);
    }
    let transaction =
        source.send_and_wait(vault, &calldata, "openDeposits", target.receipt_timeout)?;
    Ok(OpeningOutcome::Opened { transaction })
}

/// The reason text for a simulated `openDeposits` that reverted, or `None` when it passed.
///
/// # Errors
/// The error itself when it carries no revert data: the node failed, and the vault gave no answer.
fn refusal_of_simulation(simulation: Result<Bytes>) -> Result<Option<String>> {
    let error = match simulation {
        Ok(_) => return Ok(None),
        Err(error) => error,
    };
    let Some(data) = error.revert_data() else {
        return Err(error);
    };
    let reason = match opening_error_name(data) {
        Some(name) => format!("the vault refused the opening proof: {name}"),
        None => format!(
            "the vault refused the opening proof (revert data 0x{})",
            hex::encode(data)
        ),
    };
    Ok(Some(reason))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Claim: the storage slot of `executionBlockHashes[5]` is the hash of the key and the mapping slot 3, as Solidity
    /// derives it. The expected value comes from `cast keccak` over the 64 byte preimage, not from this module.
    /// Why it matters: a wrong slot proves another entry, and the vault refuses every opening.
    #[test]
    fn mapping_slot_is_the_hash_of_key_and_declared_slot() {
        let expected: B256 = "0x405aad32e1adbac89bb7f176e338b8fc6e994ca210c9bb7bdca249b465942250"
            .parse()
            .unwrap();
        assert_eq!(execution_block_hash_slot(5), expected);
        assert_ne!(execution_block_hash_slot(5), execution_block_hash_slot(6));
    }

    fn answer(key: &str, value: &str) -> Value {
        json!({
            "accountProof": ["0x0102", "0x03"],
            "storageProof": [{ "key": key, "value": value, "proof": ["0xaabb"] }],
        })
    }

    /// Claim: the nodes and the value come out of an `eth_getProof` answer, and a key printed as a short quantity
    /// still matches its slot.
    /// Why it matters: nodes differ in how they print the key. A strict string compare would refuse a good answer.
    #[test]
    fn proof_nodes_and_value_are_read_from_the_answer() {
        let slot = B256::from(U256::from(3u64).to_be_bytes::<32>());
        for key in ["0x3", &format!("{slot:#x}")] {
            let entry = decode_entry_proof(&answer(key, "0x2a"), slot).unwrap();
            assert_eq!(entry.value, U256::from(42u64));
            assert_eq!(
                entry.account_proof,
                vec![Bytes::from(vec![1, 2]), Bytes::from(vec![3])]
            );
            assert_eq!(entry.storage_proof, vec![Bytes::from(vec![0xaa, 0xbb])]);
        }
        assert_eq!(
            decode_entry_proof(&answer("0x3", "0x0"), slot)
                .unwrap()
                .value,
            U256::ZERO
        );
    }

    /// Claim: an answer for another slot, with no slot, or with a broken node is refused.
    /// Why it matters: the vault would refuse the proof anyway, but only after a transaction. The prover refuses first.
    #[test]
    fn a_wrong_or_broken_answer_is_refused() {
        let slot = B256::from(U256::from(3u64).to_be_bytes::<32>());
        assert!(decode_entry_proof(&answer("0x4", "0x1"), slot).is_err());
        assert!(decode_entry_proof(&json!({ "accountProof": [] }), slot).is_err());
        assert!(
            decode_entry_proof(&json!({ "accountProof": [], "storageProof": [] }), slot).is_err()
        );
        let broken = json!({
            "accountProof": ["0xzz"],
            "storageProof": [{ "key": "0x3", "value": "0x1", "proof": [] }],
        });
        assert!(decode_entry_proof(&broken, slot).is_err());
    }

    /// Claim: the struct for `openDeposits` carries each part in its own field.
    /// Why it matters: the remote slot and the stored slot are both slots. Swapped, the proof reads another entry.
    #[test]
    fn the_opening_proof_keeps_every_part_in_its_field() {
        let entry = ProvenEntry {
            account_proof: vec![Bytes::from(vec![1])],
            storage_proof: vec![Bytes::from(vec![2]), Bytes::from(vec![3])],
            value: U256::from(1u64),
        };
        let proof = assemble_opening_proof(11, Bytes::from(vec![9, 9]), 22, entry);
        assert_eq!(proof.remoteSlot, 11);
        assert_eq!(proof.storedSlot, 22);
        assert_eq!(proof.remoteHeaderRlp.as_ref(), &[9, 9]);
        assert_eq!(proof.accountProof.len(), 1);
        assert_eq!(proof.storageProof.len(), 2);
    }

    /// Claim: a revert with an opening error is a refusal that names the error, a pass is no refusal, and a failure
    /// without revert data stays an error.
    /// Why it matters: a refusal is a wait for the operator, and a node failure must not look like one.
    #[test]
    fn only_a_revert_with_data_is_a_refusal() {
        use alloy_sol_types::SolError;
        assert_eq!(refusal_of_simulation(Ok(Bytes::new())).unwrap(), None);
        let refused = Error::Rpc {
            code: 3,
            message: "execution reverted".into(),
            data: Some(Bytes::from(
                VaultContract::OpeningProofMalformed {}.abi_encode(),
            )),
        };
        let reason = refusal_of_simulation(Err(refused))
            .unwrap()
            .expect("a refusal");
        assert!(reason.contains("OpeningProofMalformed"), "{reason}");
        let unknown = Error::Rpc {
            code: 3,
            message: "execution reverted".into(),
            data: Some(Bytes::from(vec![0xde, 0xad, 0xbe, 0xef])),
        };
        let reason = refusal_of_simulation(Err(unknown))
            .unwrap()
            .expect("a refusal");
        assert!(reason.contains("0xdeadbeef"), "{reason}");
        let outage = Error::Rpc {
            code: -32000,
            message: "busy".into(),
            data: None,
        };
        assert!(refusal_of_simulation(Err(outage)).is_err());
    }
}
