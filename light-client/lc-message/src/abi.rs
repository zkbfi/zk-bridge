//! Solidity ABI types of the message proof: calldata of `executeMessage(MessageProof)`.
//!
//! The struct field order is the order of the Solidity structs in `src/hardened/MessageBridge.sol` (`MessageProof`) and
//! `BeaconProofVerifier.sol` (`ForkProof`). `MessageProof` is dynamic: its calldata is the 4-byte selector of
//! `executeMessage(MessageProof)` followed by the encoding of the struct as the only argument.
//!
//! `BeaconBlockHeader` is declared here again, with the same fields as `lc_core::abi::BeaconBlockHeader`, because a `sol!`
//! struct can only name structs of its own block. The message event and its topic stay in `lc_core::abi`
//! (`USER_REQUEST_TOPIC`).

use alloy_sol_types::sol;

sol! {
    /// A beacon block header, as the bridge receives it in calldata.
    #[derive(Debug, PartialEq, Eq)]
    struct BeaconBlockHeader {
        uint64 slot;
        uint64 proposerIndex;
        bytes32 parentRoot;
        bytes32 stateRoot;
        bytes32 bodyRoot;
    }

    /// The fork proof of one beacon state (`BeaconProofVerifier.ForkProof`): `fork.current_version` and
    /// `genesis_validators_root` under the same state root. The bridge judges it with `ForkShape.judge`; the Rust reference
    /// is `ancestry::source_shape`.
    #[derive(Debug, PartialEq, Eq)]
    struct ForkProof {
        bytes4 version;
        bytes32[] versionBranch;
        bytes32[] genesisValidatorsRootBranch;
    }

    /// The evidence for one message: calldata of `executeMessage(MessageProof)`. No zero-knowledge proof is involved.
    /// `receiptIndex` and `transactionIndex` must be equal: the receipt and the transaction sit at one index.
    /// `sourceFork` is the fork proof of the state of `sourceHeader`; its proven shape picks the block hash rule.
    #[derive(Debug, PartialEq, Eq)]
    struct MessageProof {
        BeaconBlockHeader anchorHeader;
        BeaconBlockHeader sourceHeader;
        bytes32[] ancestryBranch;
        bytes32[] blockHashBranch;
        ForkProof sourceFork;
        bytes executionHeaderRlp;
        bytes[] receiptProof;
        uint256 receiptIndex;
        bytes[] transactionProof;
        uint256 transactionIndex;
        uint256 logIndex;
    }

    /// The bridge entry point. Its selector and argument encoding make the calldata.
    function executeMessage(MessageProof calldata proof) external;
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{hex, B256};

    /// Claim: the calldata of `executeMessage(MessageProof)` equals the output of
    /// `cast calldata "executeMessage(((uint64,uint64,bytes32,bytes32,bytes32),(uint64,uint64,bytes32,bytes32,bytes32),bytes32[],bytes32[],(bytes4,bytes32[],bytes32[]),bytes,bytes[],uint256,bytes[],uint256,uint256))" ...`
    /// (Foundry `cast` 1.8.5, 2026-11-10) for a sample proof with two branches, a fork proof (version `0x07000000`, one
    /// version branch entry, two genesis validators root branch entries), a header blob, two receipt nodes and two
    /// transaction nodes. The selector is `0x63f08d5e`. Why it matters: the bridge decodes these exact bytes, and the
    /// fixtures hold them.
    #[test]
    fn message_calldata_matches_cast() {
        use alloy_sol_types::SolCall;
        let header = |first: u64, second: u64, byte: u8| BeaconBlockHeader {
            slot: first,
            proposerIndex: second,
            parentRoot: B256::repeat_byte(byte),
            stateRoot: B256::repeat_byte(byte + 0x11),
            bodyRoot: B256::repeat_byte(byte + 0x22),
        };
        let proof = MessageProof {
            anchorHeader: header(1, 2, 0x11),
            sourceHeader: header(4, 5, 0x44),
            ancestryBranch: vec![B256::repeat_byte(0x77)],
            blockHashBranch: vec![B256::repeat_byte(0x88), B256::repeat_byte(0x99)],
            sourceFork: ForkProof {
                version: alloy_primitives::FixedBytes::from([0x07, 0, 0, 0]),
                versionBranch: vec![B256::repeat_byte(0xaa)],
                genesisValidatorsRootBranch: vec![B256::repeat_byte(0xbb), B256::repeat_byte(0xcc)],
            },
            executionHeaderRlp: hex!("deadbeef").into(),
            receiptProof: vec![hex!("aabb").into(), hex!("ccddeeff00").into()],
            receiptIndex: alloy_primitives::U256::from(7u64),
            transactionProof: vec![hex!("0102").into(), hex!("030405").into()],
            transactionIndex: alloy_primitives::U256::from(7u64),
            logIndex: alloy_primitives::U256::from(8u64),
        };
        let expected = hex!(
            "63f08d5e00000000000000000000000000000000000000000000000000000000"
            "0000002000000000000000000000000000000000000000000000000000000000"
            "0000000100000000000000000000000000000000000000000000000000000000"
            "0000000211111111111111111111111111111111111111111111111111111111"
            "1111111122222222222222222222222222222222222222222222222222222222"
            "2222222233333333333333333333333333333333333333333333333333333333"
            "3333333300000000000000000000000000000000000000000000000000000000"
            "0000000400000000000000000000000000000000000000000000000000000000"
            "0000000544444444444444444444444444444444444444444444444444444444"
            "4444444455555555555555555555555555555555555555555555555555555555"
            "5555555566666666666666666666666666666666666666666666666666666666"
            "6666666600000000000000000000000000000000000000000000000000000000"
            "0000026000000000000000000000000000000000000000000000000000000000"
            "000002a000000000000000000000000000000000000000000000000000000000"
            "0000030000000000000000000000000000000000000000000000000000000000"
            "0000040000000000000000000000000000000000000000000000000000000000"
            "0000044000000000000000000000000000000000000000000000000000000000"
            "0000000700000000000000000000000000000000000000000000000000000000"
            "0000052000000000000000000000000000000000000000000000000000000000"
            "0000000700000000000000000000000000000000000000000000000000000000"
            "0000000800000000000000000000000000000000000000000000000000000000"
            "0000000177777777777777777777777777777777777777777777777777777777"
            "7777777700000000000000000000000000000000000000000000000000000000"
            "0000000288888888888888888888888888888888888888888888888888888888"
            "8888888899999999999999999999999999999999999999999999999999999999"
            "9999999907000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000"
            "0000006000000000000000000000000000000000000000000000000000000000"
            "000000a000000000000000000000000000000000000000000000000000000000"
            "00000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            "aaaaaaaa00000000000000000000000000000000000000000000000000000000"
            "00000002bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            "bbbbbbbbcccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            "cccccccc00000000000000000000000000000000000000000000000000000000"
            "00000004deadbeef000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000"
            "0000000200000000000000000000000000000000000000000000000000000000"
            "0000004000000000000000000000000000000000000000000000000000000000"
            "0000008000000000000000000000000000000000000000000000000000000000"
            "00000002aabb0000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000"
            "00000005ccddeeff000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000"
            "0000000200000000000000000000000000000000000000000000000000000000"
            "0000004000000000000000000000000000000000000000000000000000000000"
            "0000008000000000000000000000000000000000000000000000000000000000"
            "0000000201020000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000"
            "0000000303040500000000000000000000000000000000000000000000000000"
            "00000000"
        );
        assert_eq!(executeMessageCall { proof }.abi_encode(), expected.to_vec());
        assert_eq!(executeMessageCall::SELECTOR, hex!("63f08d5e"));
    }
}
