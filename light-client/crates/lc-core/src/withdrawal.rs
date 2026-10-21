//! `verify_withdrawal`: the Rust reference of what the vault checks, and the receipt proof helpers.
//!
//! No zero-knowledge proof is involved. The vault verifies the evidence directly (build contract, section "Change:
//! the vault verifies withdrawals directly"). This function does the same checks in the same order, so a Rust test
//! and a Solidity test can run the same fixtures and must agree.
//!
//! Order: beacon path (anchor stored, window, block roots branch, block hash branch); header decode; receipt proof;
//! EIP-2718 receipt decode with a success check; log lookup; emitter and topic; field decode; target chain;
//! destination vault.
//! The vault state checks (registered token, unclaimed nonce) are outside this function.

use crate::abi::{DepositInitiated, WithdrawalProof, DEPOSIT_EVENT_TOPIC};
use crate::ancestry::verify_beacon_path;
use crate::chain::ChainSpec;
use crate::error::{Error, Result};
use crate::execution::{decode_execution_header, decode_receipt};
use crate::mpt::extract_proven_value;
use alloy_primitives::{Address, Bytes, B256, U256};
use alloy_sol_types::SolEvent;
use alloy_trie::proof::verify_proof;
use alloy_trie::Nibbles;

/// What the vault knows when it verifies a withdrawal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WithdrawalContext {
    /// The address of the vault on the source chain (`remoteVault`).
    pub remote_vault: Address,
    /// The chain identifier of the verifying chain (`localChainId`).
    pub local_chain_id: u64,
    /// The address of the verifying vault itself (`address(this)`). A deposit must name it as its destination vault.
    pub local_vault: Address,
    /// What `lightClient.headers(anchorHeader.slot)` returns. Zero means not stored.
    pub stored_anchor_root: B256,
}

/// The deposit that a verified withdrawal proves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerifiedDeposit {
    /// Token on the source chain.
    pub token: Address,
    /// Depositor on the source chain.
    pub sender: Address,
    /// Recipient on the verifying chain.
    pub recipient: Address,
    /// Deposited amount.
    pub amount: U256,
    /// Deposit nonce.
    pub nonce: B256,
    /// Target chain of the deposit.
    pub target_chain_id: u64,
    /// The vault on the verifying chain that the deposit is addressed to.
    pub destination_vault: Address,
    /// Execution block hash of the deposit block.
    pub deposit_block_hash: B256,
}

/// The receipts trie key of a transaction index: the RLP of the index, as nibbles.
pub fn receipt_trie_key(transaction_index: u64) -> Nibbles {
    Nibbles::unpack(alloy_rlp::encode(transaction_index))
}

/// Walks a receipt proof and returns the receipt bytes at `transaction_index`.
///
/// The result is also checked with `alloy_trie::proof::verify_proof`, a second implementation.
///
/// # Errors
/// `ReceiptProofInvalid` when the proof does not match.
pub fn extract_receipt(receipts_root: B256, transaction_index: u64, proof: &[Bytes]) -> Result<Vec<u8>> {
    let key = receipt_trie_key(transaction_index);
    let nibbles: Vec<u8> = key.to_vec();
    let receipt = extract_proven_value(receipts_root, &nibbles, proof)?;
    verify_proof(receipts_root, key, Some(receipt.clone()), proof)
        .map_err(|error| Error::ReceiptProofInvalid(error.to_string()))?;
    Ok(receipt)
}

fn index_to_u64(value: U256, what: &str) -> Result<u64> {
    u64::try_from(value).map_err(|_| Error::ReceiptProofInvalid(format!("{what} does not fit in 64 bits")))
}

/// Verifies a withdrawal and returns the deposit it proves.
///
/// # Errors
/// An [`Error`] naming the first failed rule. `Error::reason_code` gives the stable code used in fixtures.
pub fn verify_withdrawal(
    proof: &WithdrawalProof,
    context: &WithdrawalContext,
    spec: &ChainSpec,
) -> Result<VerifiedDeposit> {
    let deposit_block_hash = verify_beacon_path(spec, proof, &context.stored_anchor_root)?;
    let header = decode_execution_header(&proof.executionHeaderRlp)?;

    let transaction_index = index_to_u64(proof.transactionIndex, "transaction index")?;
    let receipt_bytes = extract_receipt(header.receipts_root, transaction_index, &proof.receiptProof)?;
    let receipt = decode_receipt(&receipt_bytes)?;
    if !receipt.success {
        return Err(Error::ReceiptFailed);
    }

    let log_index = u64::try_from(proof.logIndex).unwrap_or(u64::MAX);
    let log = usize::try_from(log_index)
        .ok()
        .and_then(|index| receipt.logs.get(index))
        .ok_or(Error::LogIndexOutOfRange { index: log_index, logs: receipt.logs.len() })?;
    if log.address != context.remote_vault {
        return Err(Error::LogEmitterMismatch);
    }
    if log.topics.first() != Some(&DEPOSIT_EVENT_TOPIC) {
        return Err(Error::LogTopicMismatch);
    }
    let event = DepositInitiated::decode_raw_log(log.topics.iter().copied(), &log.data)
        .map_err(|error| Error::LogDecode(error.to_string()))?;
    if event.targetChainId != context.local_chain_id {
        return Err(Error::TargetChainMismatch { target_chain_id: event.targetChainId });
    }
    if event.destinationVault != context.local_vault {
        return Err(Error::DestinationVaultMismatch { destination_vault: event.destinationVault });
    }

    Ok(VerifiedDeposit {
        token: event.token,
        sender: event.sender,
        recipient: event.recipient,
        amount: event.amount,
        nonce: event.nonce,
        target_chain_id: event.targetChainId,
        destination_vault: event.destinationVault,
        deposit_block_hash,
    })
}
