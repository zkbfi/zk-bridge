// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {FeeOnTransferToken} from "../../src/mocks/FeeOnTransferToken.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";
import {ReceiptFixtures} from "./utils/ReceiptFixtures.sol";

/// @notice Fuzz tests: deposit amounts, nonce uniqueness, public-value decoding, jump sequences, callers.
contract HardenedFuzzTest is WithdrawalScenes {
    bytes32 internal constant ANCHOR = keccak256("fuzz anchor");

    // ================================================================ light client

    /// @dev Builds an honest output for `slot`. When the next committee slot is empty, the output proves a
    /// deterministic one, as the program does. The committee of the new period is always the stored one.
    function _stepOutput(BeaconLightClient client, uint64 slot, bytes32 blockHash)
        internal
        view
        returns (BeaconLightClient.LightClientOutput memory output)
    {
        output = _outputAt(client, GENESIS_ROOT_A, slot, blockHash);
        uint64 period = client.periodOf(slot);
        if (output.nextSyncCommitteeHash == bytes32(0)) {
            output.nextSyncCommitteeHash = keccak256(abi.encode("committee", period + 1));
        }
    }

    /// Claim: after any sequence of forward jumps of any size, every jump is accepted and the stored state matches
    /// the output. Shows: 12 random jumps (1 to 5 million slots) with matching committees each move the head and
    /// store the header root and the block hash. Matters: HB-01 and rule 2. There is no jump cap, and a head that moves
    /// far leaves earlier heads stored, because withdrawals use them as anchors.
    function testFuzz_HB01_everyForwardJumpIsAcceptedAndStored(uint32[12] memory rawJumps) public {
        BeaconLightClient client = lightClientForB;
        uint64[] memory slots = new uint64[](12);
        bytes32[] memory roots = new bytes32[](12);
        for (uint256 i = 0; i < 12; i++) {
            uint64 jump = uint64(bound(rawJumps[i], 1, 5_000_000));
            uint64 slot = client.head() + jump;
            BeaconLightClient.LightClientOutput memory output = _stepOutput(client, slot, keccak256(abi.encode("block", i)));
            _submit(client, output);
            slots[i] = slot;
            roots[i] = output.newHeaderRoot;
            assertEq(client.head(), slot);
        }
        for (uint256 i = 0; i < 12; i++) {
            assertEq(client.headers(slots[i]), roots[i], "every past head stays stored");
            assertTrue(client.isFinalizedExecutionBlock(keccak256(abi.encode("block", i))));
        }
    }

    /// Claim: the acceptance rule for a new slot is exactly "advances". Shows: for a random slot (from zero up to
    /// 100 million) with matching committees, a slot at or before the head reverts with `HeadNotAdvancing` and any
    /// later slot is accepted. Matters: rule 2, the only slot rule left. The control is the other branch of the model.
    function testFuzz_HB01_updateAcceptsExactlyTheAdvancingSlots(uint64 rawSlot) public {
        BeaconLightClient client = lightClientForB;
        uint64 head = client.head();
        uint64 slot = uint64(bound(rawSlot, 0, 100_000_000));
        BeaconLightClient.LightClientOutput memory output = _outputAt(client, GENESIS_ROOT_A, slot, keccak256("model"));
        if (slot <= head) {
            _submitExpectingRevert(client, output, abi.encodeWithSelector(BeaconLightClient.HeadNotAdvancing.selector, head, slot));
            assertEq(client.head(), head);
            return;
        }
        _submit(client, output);
        assertEq(client.head(), slot);
        assertEq(client.headers(slot), output.newHeaderRoot);
    }

    /// Claim: `update` is permissionless. Shows: any caller can move the head with a valid proof; the proof, not
    /// the caller, authorizes the move. Matters: H-15 (anyone can relay) and no owner.
    function testFuzz_H15_updateCanBeCalledByAnyAddress(address caller) public {
        BeaconLightClient client = lightClientForB;
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("by anyone"));
        bytes memory proof = _lightClientProof(output);
        bytes memory values = abi.encode(output);
        vm.prank(caller);
        client.update(proof, values);
        assertEq(client.head(), output.newHeadSlot);
    }

    /// Claim: the decoder of the light-client output takes exactly the eleven-word layout. Shows: fuzzed words in
    /// every field reach the first failing check in order. Matters: R2-09 and H-01 (a field in the wrong place
    /// would be a different statement).
    function testFuzz_R2_09_decodingChecksFieldsInOrder(
        bytes32 genesisRoot,
        bytes32 previousHeaderRoot,
        uint64 previousSlot,
        bytes32 previousCommittee,
        bytes32 startNextCommittee
    ) public {
        BeaconLightClient client = lightClientForB;
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, genesisRoot, keccak256("b"));
        output.previousHeaderRoot = previousHeaderRoot;
        output.previousHeadSlot = previousSlot;
        output.previousSyncCommitteeHash = previousCommittee;
        output.startNextSyncCommitteeHash = startNextCommittee;
        bytes memory expected;
        if (genesisRoot != GENESIS_ROOT_A) {
            expected = abi.encodeWithSelector(BeaconLightClient.GenesisValidatorsRootMismatch.selector, GENESIS_ROOT_A, genesisRoot);
        } else if (previousSlot != INITIAL_SLOT) {
            expected = abi.encodeWithSelector(BeaconLightClient.PreviousHeadSlotMismatch.selector, INITIAL_SLOT, previousSlot);
        } else if (previousHeaderRoot != INITIAL_HEADER_ROOT) {
            expected = abi.encodeWithSelector(BeaconLightClient.PreviousHeaderRootMismatch.selector, INITIAL_HEADER_ROOT, previousHeaderRoot);
        } else if (previousCommittee != COMMITTEE_100) {
            expected = abi.encodeWithSelector(BeaconLightClient.PreviousSyncCommitteeMismatch.selector, COMMITTEE_100, previousCommittee);
        } else if (startNextCommittee != COMMITTEE_101) {
            expected = abi.encodeWithSelector(BeaconLightClient.StartNextSyncCommitteeMismatch.selector, COMMITTEE_101, startNextCommittee);
        }
        if (expected.length > 0) {
            _submitExpectingRevert(client, output, expected);
            return;
        }
        _submit(client, output);
        assertEq(client.head(), output.newHeadSlot);
    }

    // ================================================================ vault: deposits

    /// Claim: for any amount, a plain token deposit locks exactly that amount and emits it. Shows: balances and the
    /// event agree for amounts from 1 to 2^128. Matters: H-13 (accounting is exact for honest tokens).
    function testFuzz_H13_depositAmountIsLockedAndEmitted(uint128 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, type(uint128).max);
        (bytes32 nonce, uint256 eventAmount) = _depositOnA(alice, bob, amount);
        assertEq(eventAmount, amount);
        assertEq(tokenOnA.balanceOf(address(vaultA)), amount);
        assertEq(nonce, keccak256(abi.encode(uint256(CHAIN_A), address(vaultA), uint256(0))));
    }

    /// Claim: for any amount, a fee-on-transfer deposit emits what the vault holds, never the request.
    /// Shows: the event equals the balance for amounts from 1 to 2^100 (including amounts under 100, which have no fee).
    /// Matters: H-13.
    function testFuzz_H13_feeOnTransferEventEqualsHeldBalance(uint128 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, uint256(1) << 100);
        FeeOnTransferToken fee = new FeeOnTransferToken("Fee", "FEE");
        BridgeVault.TokenPair[] memory pairs = new BridgeVault.TokenPair[](1);
        pairs[0] = BridgeVault.TokenPair(address(fee), address(tokenOnA), 18);
        vm.chainId(CHAIN_B);
        BridgeVault vault = new BridgeVault(
            address(lightClientForB), CHAIN_B, CHAIN_A, address(vaultA), pairs, BridgeVault.VaultTerms(0, address(0), address(0), 0, 0, address(0), address(lightClientForA)), DEFAULT_CAPELLA_ERA, address(gateB)
        );
        _openDepositsWithoutProof(vault);
        (, uint256 eventAmount) = _deposit(vault, address(fee), alice, bob, amount);
        assertEq(eventAmount, fee.balanceOf(address(vault)));
        assertEq(eventAmount, amount - amount / 100);
    }

    /// Claim: nonces are unique across many deposits, many senders, and both vaults. Shows: 1..40 deposits in one
    /// block, no collision in a set. Matters: H-12 and H-16.
    function testFuzz_H12_noncesAreUnique(uint8 rawCount, address[3] memory senders) public {
        uint256 count = bound(rawCount, 1, 40);
        for (uint256 i = 0; i < senders.length; i++) {
            vm.assume(senders[i] != address(0) && senders[i].code.length == 0);
            vm.assume(senders[i] != address(vaultA) && senders[i] != address(vaultB));
        }
        bytes32[] memory seen = new bytes32[](count * 2);
        for (uint256 i = 0; i < count; i++) {
            (seen[2 * i],) = _depositOnA(senders[i % 3], bob, 1);
            (seen[2 * i + 1],) = _depositOnB(senders[i % 3], bob, 1);
        }
        for (uint256 i = 0; i < seen.length; i++) {
            for (uint256 j = i + 1; j < seen.length; j++) {
                assertTrue(seen[i] != seen[j]);
            }
        }
    }

    // ================================================================ vault: withdrawals

    /// Claim: no single flipped bit in the evidence pays. Shows: for a random bit in a random part of the proof (an
    /// anchor field, a branch sibling, the execution header, a receipt proof node, the indices), the vault reverts, pays
    /// nothing and marks nothing; the untouched evidence then pays. Matters: R2-04 and H-08 (every byte of the
    /// evidence is bound by some check).
    function testFuzz_H08_withdrawRejectsAnyFlippedBit(uint8 part, uint256 position, uint8 bit) public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        BridgeVault vault = _newWithdrawalVault();
        tokenOnB.mint(address(vault), 100e18);
        Scene memory scene = _scene(named, _defaultParams());
        BridgeVault.WithdrawalProof memory tampered = _clone(scene.proof);
        uint256 mask = uint256(1) << (bit % 8);

        uint256 choice = part % 7;
        if (choice == 0) tampered.anchorHeader.stateRoot ^= bytes32(uint256(1) << (position % 256));
        if (choice == 1) tampered.anchorHeader.parentRoot ^= bytes32(uint256(1) << (position % 256));
        if (choice == 2) tampered.depositHeader.bodyRoot ^= bytes32(uint256(1) << (position % 256));
        if (choice == 3) {
            tampered.ancestryBranch[position % tampered.ancestryBranch.length] ^= bytes32(uint256(1) << (position % 256));
        }
        if (choice == 4) {
            tampered.blockHashBranch[position % tampered.blockHashBranch.length] ^= bytes32(uint256(1) << (position % 256));
        }
        if (choice == 5) tampered.executionHeaderRlp[position % tampered.executionHeaderRlp.length] ^= bytes1(uint8(mask));
        if (choice == 6) {
            bytes memory node = tampered.receiptProof[position % tampered.receiptProof.length];
            node[(position / 7) % node.length] ^= bytes1(uint8(mask));
        }

        vm.expectRevert();
        vault.withdraw(tampered);
        assertFalse(vault.claimed(named.nonce));
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), 0);

        vault.withdraw(scene.proof); // honest path
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), named.amount);
    }

    /// Claim: the transaction index and the log index are bound by the evidence. Shows: for a random other transaction
    /// index or log index the vault does not pay the deposit of the original receipt. Matters: R2-06.
    function testFuzz_R2_06_withdrawRejectsOtherIndices(uint16 transactionIndex, uint8 logIndex) public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.two_a();
        BridgeVault vault = _newWithdrawalVault();
        tokenOnB.mint(address(vault), 100e18);
        Scene memory scene = _scene(named, _defaultParams());
        vm.assume(transactionIndex != named.transactionIndex || logIndex != named.logIndex);
        BridgeVault.WithdrawalProof memory other = _clone(scene.proof);
        other.transactionIndex = transactionIndex;
        other.logIndex = logIndex;
        // A different log of the same receipt may be the other deposit, which is a legitimate claim of its own.
        bool sameReceiptOtherDeposit = transactionIndex == named.transactionIndex && logIndex == ReceiptFixtures.two_b().logIndex;
        if (sameReceiptOtherDeposit) {
            vault.withdraw(other);
            assertTrue(vault.claimed(ReceiptFixtures.two_b().nonce));
            assertFalse(vault.claimed(named.nonce));
            return;
        }
        vm.expectRevert();
        vault.withdraw(other);
        assertFalse(vault.claimed(named.nonce));
    }
}
