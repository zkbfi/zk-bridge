// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";
import {ReceiptFixtures} from "./utils/ReceiptFixtures.sol";

/// @notice Tests of the deposit lock. A vault refuses deposits until `openDeposits` proves, through its own light client,
/// that the light client on the other chain stored a head. The state tries here have one leaf each, which is a valid
/// trie. Branch and extension nodes of real tries are covered by the Anvil tests of the prover, which use `eth_getProof`.
contract DepositOpeningTest is WithdrawalScenes {
    event DepositsOpened(uint64 indexed remoteSlot, bytes32 indexed remoteBlockHash, uint64 storedSlot);

    /// @dev The mapping `executionBlockHashes` is the fourth declaration of `BeaconLightClient`: slot 3.
    uint256 internal constant EXECUTION_BLOCK_HASHES_SLOT = 3;
    /// @dev A slot at which the remote light client stores its first update, below the deposit slot of the first scene.
    uint64 internal constant FIRST_UPDATE_SLOT = 823_900;

    /// @dev A vault on chain A, closed, with the fixture light client of chain A and the remote light client of chain B.
    BridgeVault internal closed;

    function setUp() public override {
        super.setUp();
        closed = _closedVault(lightClientForA, lightClientForB);
        tokenOnA.mint(alice, 100e18);
        vm.prank(alice);
        tokenOnA.approve(address(closed), type(uint256).max);
    }

    // ---------------------------------------------------------------- construction

    function _closedVault(BeaconLightClient own, BeaconLightClient remote) internal returns (BridgeVault vault) {
        BridgeVault.TokenPair[] memory pairs = new BridgeVault.TokenPair[](1);
        pairs[0] = BridgeVault.TokenPair(address(tokenOnA), address(tokenOnB), 18);
        vm.chainId(CHAIN_A);
        vault = new BridgeVault(
            address(own), CHAIN_A, CHAIN_B, address(vaultB), pairs,
            BridgeVault.VaultTerms(0, address(0), address(0), 0, 0, address(0), address(remote)),
            DEFAULT_CAPELLA_ERA, address(gateA)
        );
    }

    // ---------------------------------------------------------------- the model of the remote chain

    /// @dev The trie key of a storage slot or an account: the hash of the 32-byte slot or of the 20-byte address.
    function _leaf(bytes memory trieKey, bytes memory content) internal pure returns (bytes memory) {
        bytes[] memory items = new bytes[](2);
        items[0] = _rlpBytes(bytes.concat(bytes1(0x20), trieKey));
        items[1] = _rlpBytes(content);
        return _rlpList(items);
    }

    function _trimmed(bytes32 value) internal pure returns (bytes memory) {
        uint256 skip;
        while (skip < 32 && value[skip] == 0) skip++;
        bytes memory out = new bytes(32 - skip);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = value[skip + i];
        }
        return out;
    }

    function _account(bytes32 storageRoot, address contractAddress, uint256 fieldCount)
        internal
        view
        returns (bytes memory)
    {
        bytes[] memory items = new bytes[](fieldCount);
        bytes[4] memory all = [
            _rlpBytes(hex"01"),
            _rlpBytes(""),
            _rlpBytes(abi.encodePacked(storageRoot)),
            _rlpBytes(abi.encodePacked(contractAddress.codehash))
        ];
        for (uint256 i = 0; i < fieldCount; i++) {
            items[i] = all[i];
        }
        return _rlpList(items);
    }

    /// @dev A block header whose fourth item is `stateRoot`. The vault reads that item and no other.
    function _header(bytes32 stateRoot) internal pure returns (bytes memory) {
        bytes[] memory items = new bytes[](6);
        items[0] = _rlpBytes(abi.encodePacked(keccak256("parent")));
        items[1] = _rlpBytes(abi.encodePacked(keccak256("ommers")));
        items[2] = _rlpBytes(abi.encodePacked(address(0xC0FFEE)));
        items[3] = _rlpBytes(abi.encodePacked(stateRoot));
        items[4] = _rlpBytes(abi.encodePacked(keccak256("transactions root")));
        items[5] = _rlpBytes(abi.encodePacked(keccak256("receipts root")));
        return _rlpList(items);
    }

    /// @dev The storage slot of `executionBlockHashes[slot]`, computed here and not by the vault.
    function _entrySlot(uint64 slot) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(slot), EXECUTION_BLOCK_HASHES_SLOT));
    }

    /// @dev What a prover builds. The remote chain has a block whose state holds `remote` with one storage entry: the
    /// entry that the remote light client really holds at `storedSlot` (read with `vm.load`, so the model cannot drift from
    /// the contract). The light client of the vault stores the hash of that block. Returns the evidence.
    struct Model {
        bytes32 entryValue;
        bytes entryLeaf;
        bytes accountLeaf;
        bytes header;
    }

    function _model(BeaconLightClient remote, uint64 storedSlot, bytes memory entryContent)
        internal
        view
        returns (Model memory model)
    {
        model.entryValue = vm.load(address(remote), _entrySlot(storedSlot));
        model.entryLeaf = _leaf(abi.encodePacked(keccak256(abi.encodePacked(_entrySlot(storedSlot)))), entryContent);
        bytes32 storageRoot = keccak256(model.entryLeaf);
        model.accountLeaf = _leaf(
            abi.encodePacked(keccak256(abi.encodePacked(address(remote)))), _account(storageRoot, address(remote), 4)
        );
        model.header = _header(keccak256(model.accountLeaf));
    }

    function _proof(Model memory model, uint64 remoteSlot, uint64 storedSlot)
        internal
        pure
        returns (BridgeVault.OpeningProof memory proof)
    {
        proof.remoteSlot = remoteSlot;
        proof.remoteHeaderRlp = model.header;
        proof.accountProof = new bytes[](1);
        proof.accountProof[0] = model.accountLeaf;
        proof.storedSlot = storedSlot;
        proof.storageProof = new bytes[](1);
        proof.storageProof[0] = model.entryLeaf;
    }

    /// @dev The remote light client stores its first update, as `follow` makes it do.
    function _remoteFollows(BeaconLightClient remote, uint64 slot) internal {
        BeaconLightClient.LightClientOutput memory output = _outputAt(remote, GENESIS_ROOT_A, slot, _execHash(slot));
        output.newHeaderRoot = keccak256(abi.encode("followed header", slot));
        _submit(remote, output);
    }

    /// @dev The light client of the vault stores the block of the remote chain that holds the model. Returns its slot.
    function _ownStores(BeaconLightClient own, bytes memory header) internal returns (uint64) {
        _finalize(own, GENESIS_ROOT_B, keccak256(header));
        return own.head();
    }

    /// @dev The whole honest preparation: the remote light client follows, the model is built from its real storage, and
    /// the own light client stores the block.
    function _honestProof(BridgeVault vault) internal returns (BridgeVault.OpeningProof memory) {
        BeaconLightClient remote = BeaconLightClient(vault.remoteLightClient());
        BeaconLightClient own = BeaconLightClient(address(vault.lightClient()));
        _remoteFollows(remote, FIRST_UPDATE_SLOT);
        Model memory model = _model(remote, FIRST_UPDATE_SLOT, _rlpBytes(_trimmed(_execHash(FIRST_UPDATE_SLOT))));
        assertEq(model.entryValue, _execHash(FIRST_UPDATE_SLOT), "the model reads the entry from the real contract");
        return _proof(model, _ownStores(own, model.header), FIRST_UPDATE_SLOT);
    }

    // ================================================================ the lock

    /// Claim: a closed vault refuses a deposit with `DepositsNotOpen`, and the tokens stay with the sender.
    /// Why it matters: a deposit made before the remote light client stored a head can never be paid.
    function test_lock_closedVaultRefusesDeposits() public {
        assertFalse(closed.depositsOpen());
        vm.expectRevert(BridgeVault.DepositsNotOpen.selector);
        vm.prank(alice);
        closed.deposit(address(tokenOnA), bob, 1e18, 0, "");
        assertEq(tokenOnA.balanceOf(alice), 100e18, "nothing moved");
        assertEq(closed.depositCount(), 0, "no nonce was spent");
    }

    /// Claim: the lock comes before the gate and before every other check, so a refusal never depends on the evidence.
    function test_lock_isTheFirstCheck() public {
        vm.expectRevert(BridgeVault.DepositsNotOpen.selector);
        closed.deposit(address(0xdead), address(0), 0, 0, hex"1234");
    }

    /// Claim: the constructor refuses a zero remote light client and stores the one it gets.
    function test_lock_constructorTakesTheRemoteLightClient() public {
        assertEq(closed.remoteLightClient(), address(lightClientForB));
        BridgeVault.TokenPair[] memory pairs = new BridgeVault.TokenPair[](1);
        pairs[0] = BridgeVault.TokenPair(address(tokenOnA), address(tokenOnB), 18);
        vm.chainId(CHAIN_A);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.ZeroValue.selector, "remoteLightClient"));
        new BridgeVault(
            address(lightClientForA), CHAIN_A, CHAIN_B, address(vaultB), pairs,
            BridgeVault.VaultTerms(0, address(0), address(0), 0, 0, address(0), address(0)),
            DEFAULT_CAPELLA_ERA, address(gateA)
        );
    }

    // ================================================================ opening exactly at the condition

    /// Claim: while the remote light client has stored no update, the vault cannot be opened, and it opens in the
    /// call after the first update. The blocks are the same in both calls: only the state of the remote light client differs.
    /// Why it matters: this is the condition itself. An opening before it would let deposits in that are lost.
    function test_open_opensExactlyWhenTheRemoteLightClientStoredAnUpdate() public {
        BeaconLightClient remote = lightClientForB;
        BeaconLightClient own = lightClientForA;

        // Before: the remote light client holds only its checkpoint. The best a prover can show is a snapshot of
        // its storage that holds other entries: the head. The entry for the first update slot is not in it.
        bytes memory headLeaf = _leaf(abi.encodePacked(keccak256(abi.encode(uint256(0)))), _rlpBytes(_trimmed(bytes32(uint256(INITIAL_SLOT)))));
        bytes32 headStorageRoot = keccak256(headLeaf);
        bytes memory accountLeaf = _leaf(
            abi.encodePacked(keccak256(abi.encodePacked(address(remote)))), _account(headStorageRoot, address(remote), 4)
        );
        bytes memory header = _header(keccak256(accountLeaf));
        uint64 remoteSlot = _ownStores(own, header);
        BridgeVault.OpeningProof memory early;
        early.remoteSlot = remoteSlot;
        early.remoteHeaderRlp = header;
        early.accountProof = new bytes[](1);
        early.accountProof[0] = accountLeaf;
        early.storedSlot = FIRST_UPDATE_SLOT;
        early.storageProof = new bytes[](1);
        early.storageProof[0] = headLeaf;
        vm.expectRevert();
        closed.openDeposits(early);
        assertFalse(closed.depositsOpen(), "no entry, no opening");

        // After: the remote light client follows once and the honest model has the entry.
        _remoteFollows(remote, FIRST_UPDATE_SLOT);
        Model memory model = _model(remote, FIRST_UPDATE_SLOT, _rlpBytes(_trimmed(_execHash(FIRST_UPDATE_SLOT))));
        uint64 laterSlot = _ownStores(own, model.header);
        vm.expectEmit(true, true, false, true, address(closed));
        emit DepositsOpened(laterSlot, keccak256(model.header), FIRST_UPDATE_SLOT);
        closed.openDeposits(_proof(model, laterSlot, FIRST_UPDATE_SLOT));
        assertTrue(closed.depositsOpen());
    }

    /// Claim: nobody needs a key. A stranger opens the vault.
    function test_open_needsNoKey() public {
        BridgeVault.OpeningProof memory proof = _honestProof(closed);
        vm.prank(attacker);
        closed.openDeposits(proof);
        assertTrue(closed.depositsOpen());
    }

    // ================================================================ refusals of the opening

    /// Claim: a slot at which the own light client stored no block cannot carry an opening.
    function test_open_refusesAnUnstoredRemoteSlot() public {
        BridgeVault.OpeningProof memory proof = _honestProof(closed);
        proof.remoteSlot += 1;
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.OpeningSlotNotStored.selector, proof.remoteSlot));
        closed.openDeposits(proof);
    }

    /// Claim: a header that is not the stored block cannot carry an opening, even with a state root that fits its own proofs.
    function test_open_refusesAHeaderThatIsNotTheStoredBlock() public {
        BridgeVault.OpeningProof memory proof = _honestProof(closed);
        bytes32 expected = lightClientForA.executionBlockHashes(proof.remoteSlot);
        proof.remoteHeaderRlp = _header(keccak256("another state root"));
        vm.expectRevert(
            abi.encodeWithSelector(BridgeVault.OpeningHeaderMismatch.selector, expected, keccak256(proof.remoteHeaderRlp))
        );
        closed.openDeposits(proof);
    }

    /// Claim: the proof must be about the account of the remote light client. A proof of another account fails.
    function test_open_refusesAnotherAccount() public {
        BridgeVault.OpeningProof memory proof = _honestProof(closed);
        // The same state, but the vault looks for the other light client of the fixture.
        BridgeVault other = _closedVault(lightClientForA, lightClientForA);
        vm.expectRevert();
        other.openDeposits(proof);
        assertFalse(other.depositsOpen());
    }

    /// Claim: a slot with no entry fails: the proof of the entry of the first update slot does not prove another slot.
    function test_open_refusesAnotherStoredSlot() public {
        BridgeVault.OpeningProof memory proof = _honestProof(closed);
        proof.storedSlot = FIRST_UPDATE_SLOT + 1;
        vm.expectRevert();
        closed.openDeposits(proof);
    }

    /// Claim: an account that does not decode to four fields is refused with `OpeningProofMalformed`.
    function test_open_refusesAMalformedAccount() public {
        _remoteFollows(lightClientForB, FIRST_UPDATE_SLOT);
        Model memory model = _model(lightClientForB, FIRST_UPDATE_SLOT, _rlpBytes(_trimmed(_execHash(FIRST_UPDATE_SLOT))));
        model.accountLeaf = _leaf(
            abi.encodePacked(keccak256(abi.encodePacked(address(lightClientForB)))),
            _account(keccak256(model.entryLeaf), address(lightClientForB), 3)
        );
        model.header = _header(keccak256(model.accountLeaf));
        uint64 remoteSlot = _ownStores(lightClientForA, model.header);
        vm.expectRevert(BridgeVault.OpeningProofMalformed.selector);
        closed.openDeposits(_proof(model, remoteSlot, FIRST_UPDATE_SLOT));
    }

    /// Claim: a header with no state root item is refused with `OpeningProofMalformed`.
    function test_open_refusesAShortHeader() public {
        bytes[] memory items = new bytes[](3);
        items[0] = _rlpBytes(abi.encodePacked(keccak256("parent")));
        items[1] = _rlpBytes(abi.encodePacked(keccak256("ommers")));
        items[2] = _rlpBytes(abi.encodePacked(address(0xC0FFEE)));
        bytes memory header = _rlpList(items);
        BridgeVault.OpeningProof memory proof;
        proof.remoteSlot = _ownStores(lightClientForA, header);
        proof.remoteHeaderRlp = header;
        vm.expectRevert(BridgeVault.OpeningProofMalformed.selector);
        closed.openDeposits(proof);
    }

    /// Claim: an entry that holds the encoding of the empty value is refused with `OpeningEntryEmpty`. A real trie never
    /// holds a zero entry, because a zero value removes the entry, so this guards the vault against a decoding gap.
    function test_open_refusesAnEmptyEntry() public {
        _remoteFollows(lightClientForB, FIRST_UPDATE_SLOT);
        Model memory model = _model(lightClientForB, FIRST_UPDATE_SLOT, _rlpBytes(""));
        uint64 remoteSlot = _ownStores(lightClientForA, model.header);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.OpeningEntryEmpty.selector, FIRST_UPDATE_SLOT));
        closed.openDeposits(_proof(model, remoteSlot, FIRST_UPDATE_SLOT));
    }

    // ================================================================ the lock never closes

    /// Claim: the flag is permanent. A second call with a garbage proof returns without a change and without an event, and
    /// the fee functions, which write the neighbours of the flag in one storage word, do not clear it.
    /// Why it matters: a closed vault again would strand the deposits that are in flight.
    function test_open_neverClosesAgain() public {
        BridgeVault feeVault = _feeVault();
        closed.openDeposits(_honestProof(closed));
        feeVault.openDeposits(_honestProofAgain(feeVault));
        assertTrue(feeVault.depositsOpen());

        BridgeVault.OpeningProof memory garbage;
        vm.recordLogs();
        feeVault.openDeposits(garbage);
        assertEq(vm.getRecordedLogs().length, 0, "a second call emits nothing");
        assertTrue(feeVault.depositsOpen());

        vm.prank(feeVault.feeAuthority());
        feeVault.setFee(40, makeAddr("fee recipient"));
        assertTrue(feeVault.depositsOpen(), "setFee keeps the flag");
        assertEq(feeVault.feeBasisPoints(), 40);
        vm.prank(feeVault.feeAuthority());
        feeVault.nullifyFee();
        assertTrue(feeVault.depositsOpen(), "nullifyFee keeps the flag");
        assertEq(feeVault.feeAuthority(), address(0));

        vm.warp(block.timestamp + 365 days);
        tokenOnA.mint(alice, 1e18);
        vm.startPrank(alice);
        tokenOnA.approve(address(feeVault), 1e18);
        feeVault.deposit(address(tokenOnA), bob, 1e18, 0, "");
        vm.stopPrank();
    }

    /// @dev A vault with a live fee switch, so that the word that holds the flag holds an authority and a fee too.
    function _feeVault() internal returns (BridgeVault vault) {
        BridgeVault.TokenPair[] memory pairs = new BridgeVault.TokenPair[](1);
        pairs[0] = BridgeVault.TokenPair(address(tokenOnA), address(tokenOnB), 18);
        vm.chainId(CHAIN_A);
        vault = new BridgeVault(
            address(lightClientForA), CHAIN_A, CHAIN_B, address(vaultB), pairs,
            BridgeVault.VaultTerms(0, makeAddr("fee authority"), makeAddr("fee recipient"), 25, 50, address(0), address(lightClientForB)),
            DEFAULT_CAPELLA_ERA, address(gateA)
        );
    }

    /// @dev The remote light client already followed in this test, so only the own light client stores a new block.
    function _honestProofAgain(BridgeVault vault) internal returns (BridgeVault.OpeningProof memory) {
        Model memory model =
            _model(lightClientForB, FIRST_UPDATE_SLOT, _rlpBytes(_trimmed(_execHash(FIRST_UPDATE_SLOT))));
        return _proof(model, _ownStores(BeaconLightClient(address(vault.lightClient())), model.header), FIRST_UPDATE_SLOT);
    }

    // ================================================================ pins to the real contracts

    /// Claim: the vault reads the mapping `executionBlockHashes` of the light client at slot 3 of its storage layout.
    /// Why it matters: the vault hard-codes the slot. If the light client changes its layout, this test fails first.
    function test_pin_executionBlockHashesLivesAtDeclaredSlotThree() public {
        _remoteFollows(lightClientForB, FIRST_UPDATE_SLOT);
        _remoteFollows(lightClientForB, FIRST_UPDATE_SLOT + 32);
        assertEq(vm.load(address(lightClientForB), _entrySlot(FIRST_UPDATE_SLOT)), _execHash(FIRST_UPDATE_SLOT));
        assertEq(vm.load(address(lightClientForB), _entrySlot(FIRST_UPDATE_SLOT + 32)), _execHash(FIRST_UPDATE_SLOT + 32));
        assertEq(vm.load(address(lightClientForB), _entrySlot(FIRST_UPDATE_SLOT + 1)), bytes32(0), "an unstored slot is empty");
    }

    /// Claim: the flag shares its word with the fee authority and the fee, at the offset that the test helper writes.
    /// Why it matters: the helper that opens vaults in other tests writes that bit, and the packing is the reason that the
    /// check costs almost no gas.
    function test_pin_flagSharesTheWordOfTheFeeFields() public {
        BridgeVault feeVault = _feeVault();
        bytes32 before = vm.load(address(feeVault), bytes32(VAULT_FLAG_WORD_SLOT));
        assertEq(address(uint160(uint256(before))), feeVault.feeAuthority(), "the authority sits in the low bytes");
        assertEq(uint16(uint256(before) >> 160), 25, "the fee follows");
        assertEq(uint8(uint256(before) >> VAULT_FLAG_BIT_OFFSET), 0, "the flag starts false");
        _openDepositsWithoutProof(feeVault);
        bytes32 afterOpen = vm.load(address(feeVault), bytes32(VAULT_FLAG_WORD_SLOT));
        assertEq(uint8(uint256(afterOpen) >> VAULT_FLAG_BIT_OFFSET), 1);
        assertEq(afterOpen & ~(bytes32(uint256(1) << VAULT_FLAG_BIT_OFFSET)), before, "no other bit changed");
    }

    // ================================================================ gas

    /// Claim: the lock adds almost nothing to a deposit. The flag shares a storage word with `feeBasisPoints`, which
    /// `deposit` reads anyway, so the check adds no cold read. The measure is the one of `test_gas_deposit_feeZero` in
    /// `BridgeVaultFee.t.sol`: the fixture vault from `setUp`, so its storage is cold. Before the lock that deposit used
    /// 90,464 gas. With the lock the same call uses 90,637 (plus 173: one mask, no storage read), and this test reads 90,737. The bound catches a second cold
    /// storage read, which would add 2,100.
    function test_gas_depositAfterOpeningCostsNoColdRead() public {
        vm.chainId(CHAIN_A);
        tokenOnA.mint(alice, 100e18);
        vm.startPrank(alice);
        tokenOnA.approve(address(vaultA), 100e18);
        uint256 before = gasleft();
        vaultA.deposit(address(tokenOnA), bob, 100e18, 25, "");
        uint256 used = before - gasleft();
        vm.stopPrank();
        console2.log("deposit gas, open vault", used);
        assertLt(used, 90_464 + 400, "the lock added more than the packed read");
    }

    /// Claim: opening costs one transaction of modest size. Printed for the report.
    function test_gas_openDeposits() public {
        BridgeVault.OpeningProof memory proof = _honestProof(closed);
        uint256 before = gasleft();
        closed.openDeposits(proof);
        console2.log("openDeposits gas, one-leaf tries", before - gasleft());
    }

    // ================================================================ end to end

    /// Claim: the first deposit after the opening is paid by the destination vault, through a receipt that holds the
    /// log that the deposit really emitted. Shows: the vault at the address that the fixture names refuses, opens with a
    /// real proof, deposits, and the destination vault pays the recipient the amount of the log.
    /// Why it matters: the lock exists to make exactly this deposit payable.
    function test_endToEnd_firstDepositAfterOpeningIsPaid() public {
        // The remote light client follows first, at a slot below the deposit slot of the scene.
        BridgeVault source = _sourceVaultAtTheFixtureAddress();
        BridgeVault destination = _newWithdrawalVault();
        tokenOnB.mint(address(destination), 1_000_000e18);

        // Refused while closed.
        MockERC20 sourceToken = MockERC20(ReceiptFixtures.REMOTE_TOKEN);
        sourceToken.mint(alice, 10e18);
        vm.chainId(CHAIN_A);
        vm.startPrank(alice);
        sourceToken.approve(address(source), 10e18);
        vm.expectRevert(BridgeVault.DepositsNotOpen.selector);
        source.deposit(address(sourceToken), ReceiptFixtures.RECIPIENT, 10e18, 0, "");
        vm.stopPrank();

        // Open with a real proof of the state of the remote light client.
        source.openDeposits(_honestProof(source));
        assertTrue(source.depositsOpen());

        // The first deposit after the opening.
        vm.recordLogs();
        vm.startPrank(alice);
        source.deposit(address(sourceToken), ReceiptFixtures.RECIPIENT, 10e18, 0, "");
        vm.stopPrank();
        Vm.Log memory log = _depositLog(vm.getRecordedLogs(), address(source));
        (uint256 amount, bytes32 nonce,,,) = abi.decode(log.data, (uint256, bytes32, uint64, address, address));

        // Its receipt: one transaction, one log, in a trie of one leaf.
        bytes memory receipt = _receiptOf(log);
        bytes memory leaf = _leaf(hex"80", receipt);
        // The key of transaction index 0 is the byte 0x80, which `_leaf` writes as the key of a leaf of even length.
        bytes[] memory receiptProof = new bytes[](1);
        receiptProof[0] = leaf;

        SceneParams memory params = _defaultParams();
        Scene memory scene = _sceneWithHeader(
            ReceiptFixtures.Named(0, 0, amount, nonce), params, _receiptsHeader(keccak256(leaf))
        );
        scene.proof.receiptProof = receiptProof;

        vm.chainId(CHAIN_B);
        destination.withdraw(scene.proof);
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), amount, "the recipient got the logged amount");
        assertTrue(destination.claimed(nonce));
    }

    function _sourceVaultAtTheFixtureAddress() internal returns (BridgeVault) {
        deployCodeTo("MockERC20.sol:MockERC20", abi.encode("Token at the fixture address", "TFA"), ReceiptFixtures.REMOTE_TOKEN);
        BridgeVault.TokenPair[] memory pairs = new BridgeVault.TokenPair[](1);
        pairs[0] = BridgeVault.TokenPair(ReceiptFixtures.REMOTE_TOKEN, ReceiptFixtures.DESTINATION_TOKEN, 18);
        vm.chainId(CHAIN_A);
        bytes memory arguments = abi.encode(
            address(lightClientForA), CHAIN_A, CHAIN_B, ReceiptFixtures.DESTINATION_VAULT, pairs,
            BridgeVault.VaultTerms(0, address(0), address(0), 0, 0, address(0), address(lightClientForB)),
            DEFAULT_CAPELLA_ERA, address(gateA)
        );
        deployCodeTo("BridgeVault.sol:BridgeVault", arguments, ReceiptFixtures.REMOTE_VAULT);
        return BridgeVault(ReceiptFixtures.REMOTE_VAULT);
    }

    function _depositLog(Vm.Log[] memory logs, address emitter) internal view returns (Vm.Log memory found) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == closed.DEPOSIT_EVENT_TOPIC()) return logs[i];
        }
        revert("the deposit emitted no log");
    }

    /// @dev A legacy receipt of a successful transaction with the log: status, gas used, bloom, logs.
    function _receiptOf(Vm.Log memory log) internal pure returns (bytes memory) {
        bytes[] memory topics = new bytes[](log.topics.length);
        for (uint256 i = 0; i < topics.length; i++) {
            topics[i] = _rlpBytes(abi.encodePacked(log.topics[i]));
        }
        bytes[] memory logItems = new bytes[](3);
        logItems[0] = _rlpBytes(abi.encodePacked(log.emitter));
        logItems[1] = _rlpList(topics);
        logItems[2] = _rlpBytes(log.data);
        bytes[] memory logs = new bytes[](1);
        logs[0] = _rlpList(logItems);
        bytes[] memory fields = new bytes[](4);
        fields[0] = _rlpBytes(hex"01");
        fields[1] = _rlpBytes(hex"5208");
        fields[2] = _rlpBytes(new bytes(256));
        fields[3] = _rlpList(logs);
        return _rlpList(fields);
    }

    /// @dev A full execution header whose receipts root is `receiptsRoot`.
    function _receiptsHeader(bytes32 receiptsRoot) internal pure returns (bytes memory) {
        return _executionHeaderRlp(receiptsRoot, 17);
    }
}
