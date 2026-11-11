//! `verify_message`: the Rust reference of what `MessageBridge.executeMessage` checks, with the fork proof of the source
//! state.
//!
//! The bridge checks are listed in `docs/hardened-build-contract.md` ("Layer 2: message bridge"). This function does the
//! same checks in the same order, so a Rust test and a Solidity test can run the same fixtures and must agree.
//!
//! Order: the receipt index equals the transaction index; beacon path (anchor stored, ancestry branch, fork proof of the
//! source state, block hash branch); header decode; receipt proof; transaction proof; EIP-2718 receipt decode with a
//! success check; log lookup; emitter and topics; event data; message decode; identifier, version, source chain,
//! destination chain and data type. The delivery state (a message executes once) and the gas guard are bridge state and
//! outside this function.
//!
//! The steps that the fork proof does not touch are the functions of `lc_core::message`, which this function calls.

use super::abi::MessageProof;
use super::ancestry::{source_shape, verify_beacon_path};
use alloy_primitives::{keccak256, B256, U256};
use lc_core::chain::ChainSpec;
use lc_core::execution::{decode_execution_anchor_fields, decode_execution_header, decode_receipt};
use lc_core::layout::SHAPE_PROGRESSIVE;
use lc_core::message::{
    decode_message, extract_receipt, extract_transaction, message_of_log, require_acceptable_message, MessageContext,
    VerifiedMessage,
};
use lc_core::{Error, Result};

/// A stable code for the failure, used as the expected rejection reason in the message fixtures: `Error::reason_code`,
/// and `InvalidForkShapeProof` for a fork proof that proves no allowed shape (`Error::reason_code` of `lc-core` names
/// that one only as a light-client rejection).
pub fn reason_code(error: &Error) -> &'static str {
    match error {
        Error::InvalidForkShapeProof => "InvalidForkShapeProof",
        other => other.reason_code(),
    }
}

fn index_to_u64(value: U256) -> Result<u64> {
    u64::try_from(value).map_err(|_| Error::ReceiptProofInvalid("index does not fit in 64 bits".to_string()))
}

/// The receipts root and the transactions root of the execution header of the proof.
///
/// A source whose state the fork proof shows to be progressive (Gloas on) reads them with the tolerant decoder, because an
/// Amsterdam header has more items than the strict decoder knows. A plain source keeps the strict decoder, as before. The
/// rule follows the same proof as the block hash rule of [`verify_beacon_path`], never the fork schedule, so a Gloas source
/// on a chain whose schedule has no Gloas epoch yet is read as Gloas. The contract reads both items by position in every
/// case (`ReceiptProofLib.headerRoot`).
fn trie_roots(spec: &ChainSpec, proof: &MessageProof) -> Result<(B256, B256)> {
    let shape = source_shape(&proof.sourceFork, &proof.sourceHeader.stateRoot, &spec.genesis_validators_root)?;
    if shape == SHAPE_PROGRESSIVE {
        let fields = decode_execution_anchor_fields(&proof.executionHeaderRlp)?;
        return Ok((fields.receipts_root, fields.transactions_root));
    }
    let header = decode_execution_header(&proof.executionHeaderRlp)?;
    Ok((header.receipts_root, header.transactions_root))
}

/// Verifies a message proof and returns the message it proves.
///
/// # Errors
/// An [`Error`] naming the first failed rule. [`reason_code`] gives the stable code used in fixtures.
pub fn verify_message(proof: &MessageProof, context: &MessageContext, spec: &ChainSpec) -> Result<VerifiedMessage> {
    if proof.receiptIndex != proof.transactionIndex {
        return Err(Error::IndexMismatch {
            receipt_index: proof.receiptIndex,
            transaction_index: proof.transactionIndex,
        });
    }
    let source_block_hash = verify_beacon_path(spec, proof, &context.stored_anchor_root)?;
    let (receipts_root, transactions_root) = trie_roots(spec, proof)?;

    let index = index_to_u64(proof.receiptIndex)?;
    let receipt_bytes = extract_receipt(receipts_root, index, &proof.receiptProof)?;
    let transaction_bytes = extract_transaction(transactions_root, index, &proof.transactionProof)?;
    let source_transaction_hash = keccak256(&transaction_bytes);

    let receipt = decode_receipt(&receipt_bytes)?;
    if !receipt.success {
        return Err(Error::ReceiptFailed);
    }
    let log_index = u64::try_from(proof.logIndex).unwrap_or(u64::MAX);
    let log = usize::try_from(log_index)
        .ok()
        .and_then(|position| receipt.logs.get(position))
        .ok_or(Error::LogIndexOutOfRange { index: log_index, logs: receipt.logs.len() })?;

    let (topic_message_id, encoded) = message_of_log(log, context.remote_bridge)?;
    let (message_header, data) = decode_message(&encoded)?;
    require_acceptable_message(&message_header, topic_message_id, context)?;
    Ok(VerifiedMessage { header: message_header, data, source_block_hash, source_transaction_hash })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claim: the fixture code of a failed fork proof is `InvalidForkShapeProof`, and every other error keeps the code of
    /// `lc-core`. Why it matters: the Solidity fixtures expect the revert name of the bridge, and `lc-core` (frozen with the
    /// guest programs) names this error only as a light-client rejection.
    #[test]
    fn reason_codes_name_the_fork_proof() {
        assert_eq!(Error::InvalidForkShapeProof.reason_code(), "LightClientUpdateRejected");
        assert_eq!(reason_code(&Error::InvalidForkShapeProof), "InvalidForkShapeProof");
        assert_eq!(reason_code(&Error::InvalidBlockHashBranch), "InvalidBlockHashBranch");
        assert_eq!(reason_code(&Error::ReceiptFailed), "ReceiptFailed");
    }

    /// Claim: an index above 64 bits is refused as a receipt proof failure. Why it matters: the trie key is a 64-bit index.
    #[test]
    fn a_wide_index_is_refused() {
        assert_eq!(index_to_u64(U256::from(7u64)), Ok(7));
        assert!(matches!(index_to_u64(U256::from(u128::MAX)), Err(Error::ReceiptProofInvalid(_))));
    }
}
