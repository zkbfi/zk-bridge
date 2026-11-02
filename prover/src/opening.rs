//! The `opening-proof` command: the evidence of `MessageBridge.openDeposits`.
//!
//! A bridge opens when its own light client has stored a block of the other chain, and the light client of the other
//! chain (the remote light client) had already stored a head in the state of that block. The proof walks four links, the
//! same four as `BeaconProofVerifier._verifyOpening`:
//!
//! 1. The own light client stored the execution block hash of a block of the other chain at `remoteSlot`.
//! 2. The header in the proof hashes to that block hash. Its field 3 is the state root.
//! 3. Under that state root, the account of the remote light client holds a storage root (account field 2).
//! 4. Under that storage root, `executionBlockHashes[storedSlot]` is not empty.
//!
//! [`verify_opening`] is the native copy of that walk. The command runs it on the decoded calldata before it prints, so a
//! proof that the contract would refuse never reaches the output.

use crate::chain::ChainClient;
use crate::contracts::{LightClientContract, MessageBridgeContract, OpeningProof};
use crate::error::{Error, Result};
use crate::light_client::rebuild_execution_header;
use crate::logging::redact_urls;
use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_rlp::Header as RlpHeader;
use alloy_sol_types::{SolCall, SolValue};
use lc_core::mpt::extract_proven_value;
use serde_json::{json, Value};
use std::str::FromStr;

/// The storage slot of the mapping `executionBlockHashes` in `BeaconLightClient`. The Solidity constant of the same name
/// has this value, and a test compares the two.
pub const EXECUTION_BLOCK_HASHES_MAPPING_SLOT: u64 = 3;

/// The index of `stateRoot` in the list of an execution block header.
pub const STATE_ROOT_FIELD: usize = 3;

/// The index of `storageRoot` in the list of an account (nonce, balance, storage root, code hash).
pub const ACCOUNT_STORAGE_ROOT_FIELD: usize = 2;

fn refused(reason: impl Into<String>) -> Error {
    Error::VerificationRefused(reason.into())
}

/// The storage slot of `executionBlockHashes[stored_slot]`: `keccak256(abi.encode(uint256(stored_slot), 3))`. It is the
/// Rust copy of `_executionBlockHashesSlot`.
pub fn execution_block_hashes_slot(stored_slot: u64) -> B256 {
    keccak256(
        (
            U256::from(stored_slot),
            U256::from(EXECUTION_BLOCK_HASHES_MAPPING_SLOT),
        )
            .abi_encode(),
    )
}

/// Splits the RLP of a list into the payloads of its string items.
fn string_items(encoded: &[u8], what: &str) -> Result<Vec<Vec<u8>>> {
    let mut buffer = encoded;
    let list =
        RlpHeader::decode(&mut buffer).map_err(|error| refused(format!("{what}: {error}")))?;
    if !list.list || list.payload_length != buffer.len() {
        return Err(refused(format!("{what}: not one RLP list")));
    }
    let mut items = Vec::new();
    while !buffer.is_empty() {
        let header =
            RlpHeader::decode(&mut buffer).map_err(|error| refused(format!("{what}: {error}")))?;
        if header.list || buffer.len() < header.payload_length {
            return Err(refused(format!("{what}: a field is not a string")));
        }
        let (payload, rest) = buffer.split_at(header.payload_length);
        items.push(payload.to_vec());
        buffer = rest;
    }
    Ok(items)
}

/// The 32-byte field at `index` of an RLP list.
fn hash_field(encoded: &[u8], index: usize, what: &str) -> Result<B256> {
    let items = string_items(encoded, what)?;
    let item = items
        .get(index)
        .ok_or_else(|| refused(format!("{what}: no field {index}")))?;
    B256::try_from(item.as_slice())
        .map_err(|_| refused(format!("{what}: field {index} is not 32 bytes")))
}

/// The bytes of a trie key: the nibbles of `keccak256(preimage)`.
fn trie_nibbles(preimage: &[u8]) -> Vec<u8> {
    keccak256(preimage)
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .collect()
}

/// What a verified opening proof shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerifiedOpening {
    /// The state root of the remote block, from field 3 of the header.
    pub state_root: B256,
    /// The storage root of the remote light client under that state root.
    pub storage_root: B256,
    /// The storage slot that the storage proof opens.
    pub storage_slot: B256,
    /// The value of `executionBlockHashes[storedSlot]`, as the contract stores it.
    pub stored_block_hash: B256,
}

/// Runs the checks of `BeaconProofVerifier._verifyOpening` on `proof` without a chain.
///
/// `own_stored_block_hash` is what the own light client stores at `proof.remoteSlot`. `remote_light_client` is the account
/// that the bridge names as its remote light client.
///
/// # Errors
/// `Error::VerificationRefused` with the failed link: the hash of the header, a field, or a trie proof.
pub fn verify_opening(
    proof: &OpeningProof,
    remote_light_client: Address,
    own_stored_block_hash: B256,
) -> Result<VerifiedOpening> {
    if own_stored_block_hash == B256::ZERO {
        return Err(refused(format!(
            "the own light client stores no block hash at slot {}",
            proof.remoteSlot
        )));
    }
    let actual = keccak256(&proof.remoteHeaderRlp);
    if actual != own_stored_block_hash {
        return Err(refused(format!(
            "the header hashes to {actual:#x}, the light client stores {own_stored_block_hash:#x}"
        )));
    }
    let state_root = hash_field(
        &proof.remoteHeaderRlp,
        STATE_ROOT_FIELD,
        "the remote header",
    )?;
    let account = extract_proven_value(
        state_root,
        &trie_nibbles(remote_light_client.as_slice()),
        &proof.accountProof,
    )
    .map_err(|error| refused(format!("the account proof: {error}")))?;
    if string_items(&account, "the account")?.len() != 4 {
        return Err(refused("the account does not have 4 fields"));
    }
    let storage_root = hash_field(&account, ACCOUNT_STORAGE_ROOT_FIELD, "the account")?;
    let storage_slot = execution_block_hashes_slot(proof.storedSlot);
    let entry = extract_proven_value(
        storage_root,
        &trie_nibbles(storage_slot.as_slice()),
        &proof.storageProof,
    )
    .map_err(|error| refused(format!("the storage proof: {error}")))?;
    let mut buffer = entry.as_slice();
    let header =
        RlpHeader::decode(&mut buffer).map_err(|error| refused(format!("the entry: {error}")))?;
    if header.list
        || header.payload_length != buffer.len()
        || buffer.is_empty()
        || buffer.len() > 32
    {
        return Err(refused(format!(
            "the entry of slot {} is empty or malformed",
            proof.storedSlot
        )));
    }
    Ok(VerifiedOpening {
        state_root,
        storage_root,
        storage_slot,
        stored_block_hash: B256::from(U256::from_be_slice(buffer)),
    })
}

/// The inputs of [`build_opening_proof`].
pub struct OpeningRequest<'a> {
    /// The route name for the output, or the empty text.
    pub route: &'a str,
    /// The chain of the bridge that opens.
    pub own_chain: &'a ChainClient,
    /// The other chain: it holds the remote light client.
    pub remote_chain: &'a ChainClient,
    /// More nodes of the remote chain, asked in order for the raw header when `remote_chain` does not give it. Each is
    /// named `<chain>.header_rpc_urls[i]`.
    pub remote_header_sources: &'a [ChainClient],
    /// The bridge to open.
    pub bridge: Address,
    /// The remote light client that the configuration names. It must equal what the bridge stores.
    pub remote_light_client: Address,
    /// A slot of the own light client to use. Default: its head.
    pub remote_slot: Option<u64>,
    /// A slot of the remote light client to prove. Default: its head at the remote block.
    pub stored_slot: Option<u64>,
    /// The proof cache of the remote chain (`destination.proof_cache_dir`), read before `eth_getProof`. See
    /// [`crate::proof_cache`]. A cached answer is verified like a live one.
    pub proof_cache_dir: Option<&'a std::path::Path>,
}

/// The proof with the facts that the command prints.
#[derive(Clone)]
pub struct OpeningPackage {
    /// The route name.
    pub route: String,
    /// The bridge to open, on the own chain.
    pub bridge: Address,
    /// The own chain identifier.
    pub chain_id: u64,
    /// The identifier of the other chain.
    pub remote_chain_id: u64,
    /// The light client of the bridge, which stored the remote block.
    pub own_light_client: Address,
    /// The light client on the other chain.
    pub remote_light_client: Address,
    /// Whether the bridge already reports open. A call then returns at once.
    pub deposits_open: bool,
    /// The number of the remote block whose hash the own light client stored.
    pub remote_block_number: u64,
    /// The hash of that block.
    pub remote_block_hash: B256,
    /// What the native check found.
    pub verified: VerifiedOpening,
    /// The proof, as the contract takes it.
    pub proof: OpeningProof,
    /// The calldata of `openDeposits`.
    pub calldata: Bytes,
}

fn address_of(chain: &ChainClient, what: &str, address: Address, expected: Address) -> Result<()> {
    if address == expected {
        return Ok(());
    }
    Err(Error::Config(format!(
        "{what}: the configuration has {expected:#x}, but the {} chain reports {address:#x}",
        chain.name()
    )))
}

fn hex_list(value: &Value, what: &str) -> Result<Vec<Bytes>> {
    value
        .as_array()
        .ok_or_else(|| Error::Malformed(format!("eth_getProof: {what} is not a list")))?
        .iter()
        .map(|node| {
            node.as_str()
                .and_then(|text| Bytes::from_str(text).ok())
                .ok_or_else(|| {
                    Error::Malformed(format!("eth_getProof: a node of {what} is not hex"))
                })
        })
        .collect()
}

/// The RLP of the remote block header. The raw header of a node (`debug_getRawHeader`) is the exact source: a header of a
/// newer fork has fields that the JSON of the block does not show, and a rebuild from that JSON then hashes to another
/// value (a live Sepolia block did). The main RPC of the remote chain is asked first, then each header endpoint in order
/// (`destination.header_rpc_urls`), then the rebuild from the JSON. Every source is checked against `block_hash`, so none
/// is trusted, and a header with another hash moves on to the next source.
///
/// # Errors
/// `Error::Malformed` when no source gives a header with the block hash. The message names each source (`<chain>.rpc_url`,
/// `<chain>.header_rpc_urls[i]`, the rebuild from JSON) with its cause, and no URL.
fn remote_header_rlp(
    remote: &ChainClient,
    header_sources: &[ChainClient],
    block: &Value,
    block_hash: B256,
) -> Result<Vec<u8>> {
    let mut failures = Vec::new();
    match remote.raw_header(block_hash) {
        Ok(bytes) => return Ok(bytes),
        Err(error) => failures.push(format!("{}.rpc_url: {error}", remote.name())),
    }
    for source in header_sources {
        match source.raw_header(block_hash) {
            Ok(bytes) => return Ok(bytes),
            Err(error) => failures.push(format!("{}: {error}", source.name())),
        }
    }
    match rebuild_execution_header(block) {
        Ok(rebuilt) => Ok(rebuilt.header_rlp.to_vec()),
        Err(error) => {
            failures.push(format!("the rebuild from JSON: {error}"));
            Err(Error::Malformed(redact_urls(&format!(
                "the remote header: no source gave a header with the block hash {block_hash:#x} ({})",
                failures.join("; ")
            ))))
        }
    }
}

/// Reads the chains, builds the proof, checks it natively and encodes the calldata of `openDeposits`.
///
/// The bridge is the authority for its wiring: the command reads the chain identifiers, the own light client and the remote
/// light client from the bridge, and it refuses a configuration that disagrees.
///
/// # Errors
/// `Error::Config` for a wiring that disagrees with the configuration. `Error::Beacon` when the light clients have not stored
/// enough yet. `Error::VerificationRefused` when the proof does not verify. `Error::Rpc` or `Error::Malformed` for node
/// answers.
pub fn build_opening_proof(request: &OpeningRequest<'_>) -> Result<OpeningPackage> {
    let own = request.own_chain;
    let remote = request.remote_chain;
    let local_id = own.view(request.bridge, MessageBridgeContract::localChainIdCall {})?;
    let remote_id = own.view(request.bridge, MessageBridgeContract::remoteChainIdCall {})?;
    if local_id != own.chain_id() || remote_id != remote.chain_id() {
        return Err(Error::Config(format!(
            "the bridge names chains {local_id} and {remote_id}, the configuration has {} and {}",
            own.chain_id(),
            remote.chain_id()
        )));
    }
    let remote_light_client = own.view(
        request.bridge,
        MessageBridgeContract::remoteLightClientCall {},
    )?;
    address_of(
        own,
        "remote light client",
        remote_light_client,
        request.remote_light_client,
    )?;
    let own_light_client = own.view(request.bridge, MessageBridgeContract::lightClientCall {})?;
    let deposits_open = own.view(request.bridge, MessageBridgeContract::depositsOpenCall {})?;

    let remote_slot = match request.remote_slot {
        Some(slot) => slot,
        None => own.view(own_light_client, LightClientContract::headCall {})?,
    };
    let remote_block_hash = own.view(
        own_light_client,
        LightClientContract::executionBlockHashesCall { slot: remote_slot },
    )?;
    if remote_block_hash == B256::ZERO {
        return Err(Error::Beacon(format!(
            "the own light client stored no block hash at slot {remote_slot}; post an update first"
        )));
    }
    let block = remote.block_by_hash(remote_block_hash)?.ok_or_else(|| {
        Error::Beacon(format!(
            "the {} chain does not know the block {remote_block_hash:#x}",
            remote.name()
        ))
    })?;
    let header_rlp = remote_header_rlp(
        remote,
        request.remote_header_sources,
        &block,
        remote_block_hash,
    )?;
    let block_number = crate::rpc::parse_quantity(&block["number"])?;

    let header_rlp = Bytes::from(header_rlp);
    let assemble = |stored_slot: u64, answer: &Value| {
        assemble_opening(
            remote_slot,
            &header_rlp,
            stored_slot,
            answer,
            remote_light_client,
            remote_block_hash,
            block_number,
        )
    };
    let cached = request.proof_cache_dir.and_then(|directory| {
        cached_opening(
            directory,
            remote.chain_id(),
            remote_light_client,
            block_number,
            remote_block_hash,
            request.stored_slot,
            &assemble,
        )
    });
    let (sent, calldata, verified) = match cached {
        Some(parts) => parts,
        None => {
            let stored_slot = match request.stored_slot {
                Some(slot) => slot,
                None => remote.view_at(
                    remote_light_client,
                    LightClientContract::headCall {},
                    Some(block_number),
                )?,
            };
            let storage_slot = execution_block_hashes_slot(stored_slot);
            let answer =
                remote.account_proof(remote_light_client, &[storage_slot], block_number)?;
            assemble(stored_slot, &answer)?
        }
    };
    Ok(OpeningPackage {
        route: request.route.to_string(),
        bridge: request.bridge,
        chain_id: own.chain_id(),
        remote_chain_id: remote.chain_id(),
        own_light_client,
        remote_light_client,
        deposits_open,
        remote_block_number: block_number,
        remote_block_hash,
        verified,
        proof: sent,
        calldata,
    })
}

/// The parts of a verified opening: the proof as it will be sent, its calldata and what the native walk found.
type Assembled = (OpeningProof, Bytes, VerifiedOpening);

/// The cached answer for the remote block, assembled and verified, or `None` when there is none or it does not verify.
/// A refused entry is logged without its content and the caller asks the node instead.
fn cached_opening(
    directory: &std::path::Path,
    chain_id: u64,
    remote_light_client: Address,
    block_number: u64,
    block_hash: B256,
    stored_slot: Option<u64>,
    assemble: &dyn Fn(u64, &Value) -> Result<Assembled>,
) -> Option<Assembled> {
    let logger = crate::logging::Logger::standard();
    let block = block_number.to_string();
    let entry = match crate::proof_cache::read_cached_proof(
        directory,
        chain_id,
        remote_light_client,
        block_number,
        block_hash,
        stored_slot,
    ) {
        Ok(Some(entry)) => entry,
        Ok(None) => {
            logger.info(
                "proof_cache_miss",
                &[("chain_id", chain_id.to_string()), ("block", block)],
            );
            return None;
        }
        Err(error) => {
            logger.warn(
                "proof_cache_refused",
                &[
                    ("chain_id", chain_id.to_string()),
                    ("block", block),
                    ("reason", error.to_string()),
                ],
            );
            return None;
        }
    };
    match assemble(entry.stored_slot, &entry.answer) {
        Ok(parts) => {
            logger.info(
                "proof_cache_hit",
                &[
                    ("chain_id", chain_id.to_string()),
                    ("block", block),
                    ("stored_slot", entry.stored_slot.to_string()),
                ],
            );
            Some(parts)
        }
        Err(error) => {
            logger.warn(
                "proof_cache_refused",
                &[
                    ("chain_id", chain_id.to_string()),
                    ("block", block),
                    ("reason", error.to_string()),
                ],
            );
            None
        }
    }
}

/// Builds the proof from an `eth_getProof` answer, encodes the calldata, decodes it again and runs the native walk on the
/// decoded proof. A live answer and a cached one take this same path.
fn assemble_opening(
    remote_slot: u64,
    header_rlp: &Bytes,
    stored_slot: u64,
    answer: &Value,
    remote_light_client: Address,
    remote_block_hash: B256,
    block_number: u64,
) -> Result<Assembled> {
    let storage_slot = execution_block_hashes_slot(stored_slot);
    let storage_entry = answer["storageProof"]
        .as_array()
        .and_then(|entries| entries.first())
        .ok_or_else(|| Error::Malformed("eth_getProof: no storage proof".into()))?;
    let reported_key = storage_entry["key"]
        .as_str()
        .and_then(|text| U256::from_str_radix(text.trim_start_matches("0x"), 16).ok());
    if reported_key != Some(U256::from_be_bytes(storage_slot.0)) {
        return Err(Error::Malformed(
            "eth_getProof: the storage proof is for another key".into(),
        ));
    }
    let proof = OpeningProof {
        remoteSlot: remote_slot,
        remoteHeaderRlp: header_rlp.clone(),
        accountProof: hex_list(&answer["accountProof"], "accountProof")?,
        storedSlot: stored_slot,
        storageProof: hex_list(&storage_entry["proof"], "storageProof")?,
    };
    let calldata = Bytes::from(MessageBridgeContract::openDepositsCall { proof }.abi_encode());
    // Check what will be sent, not what was built: decode the calldata and run the walk on the decoded struct.
    let sent = MessageBridgeContract::openDepositsCall::abi_decode(&calldata)
        .map_err(|error| Error::Malformed(format!("openDeposits calldata: {error}")))?
        .proof;
    let verified = verify_opening(&sent, remote_light_client, remote_block_hash)?;
    if verified.stored_block_hash == B256::ZERO {
        return Err(refused(format!(
            "the remote light client stores no block hash at slot {stored_slot} in block {block_number}; it needs its first update"
        )));
    }
    Ok((sent, calldata, verified))
}

impl OpeningPackage {
    /// The JSON object that the command prints.
    pub fn to_json(&self) -> Value {
        let list = |nodes: &[Bytes]| -> Vec<String> {
            nodes.iter().map(|node| format!("{node}")).collect()
        };
        json!({
            "schemaVersion": 1,
            "route": self.route,
            "bridge": format!("{:#x}", self.bridge),
            "chainId": self.chain_id,
            "remoteChainId": self.remote_chain_id,
            "ownLightClient": format!("{:#x}", self.own_light_client),
            "remoteLightClient": format!("{:#x}", self.remote_light_client),
            "depositsOpen": self.deposits_open,
            "remoteBlockNumber": self.remote_block_number,
            "remoteBlockHash": format!("{:#x}", self.remote_block_hash),
            "remoteStateRoot": format!("{:#x}", self.verified.state_root),
            "remoteStorageRoot": format!("{:#x}", self.verified.storage_root),
            "storageSlot": format!("{:#x}", self.verified.storage_slot),
            "storedBlockHash": format!("{:#x}", self.verified.stored_block_hash),
            "verifiedNatively": true,
            "proof": {
                "remoteSlot": self.proof.remoteSlot,
                "remoteHeaderRlp": format!("{}", self.proof.remoteHeaderRlp),
                "accountProof": list(&self.proof.accountProof),
                "storedSlot": self.proof.storedSlot,
                "storageProof": list(&self.proof.storageProof),
            },
            "calldata": format!("{}", self.calldata),
            "to": format!("{:#x}", self.bridge),
        })
    }
}
