// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {DeliveryRouter} from "src/hardened/mediator/DeliveryRouter.sol";
import {ITokenMediator} from "src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "src/hardened/mediator/IWETH.sol";

/// @dev Calls `feeInfo` through an external call, so that a revert can be caught and printed.
contract DeliveryFeeProbe {
    DeliveryRouter public immutable router;

    constructor(DeliveryRouter router_) {
        router = router_;
    }

    function feeInfo(address token, uint256 value, uint256 gasUsed, DeliveryRouter.FeeDirector calldata director)
        external
        view
        returns (uint256 fee, uint256 toRecipient)
    {
        return router.feeInfo(token, value, gasUsed, director);
    }
}

/// @title GenerateDeliveryFeeVectors
/// @notice Prints test vectors of the delivery router: the encoding of a `FeeDirector` and the answer of `feeInfo`, one JSON
/// object per line. Run from the repository root:
///   forge script explorer/shared/vectors/GenerateDeliveryFeeVectors.s.sol --tc GenerateDeliveryFeeVectors --root . 2>&1 | grep '^  VECTOR ' | sed 's/^  VECTOR //' > explorer/shared/test/fixtures/delivery-fee-vectors.jsonl
/// The test in explorer/shared/test/delivery-fee.test.ts reads the saved lines, so the TypeScript copy and the router
/// cannot drift. A line with `"reverts":true` is a case where the router reverts on an overflow.
contract GenerateDeliveryFeeVectors is Script {
    address private constant WRAPPED_NATIVE = address(0xBEEF);
    address private constant OTHER_TOKEN = address(0xCAFE);

    DeliveryFeeProbe private probe;

    function run() external {
        probe = new DeliveryFeeProbe(new DeliveryRouter(ITokenMediator(address(0xB1D6E)), IWETH(WRAPPED_NATIVE), address(0xA11CE), address(0xB0B)));

        // Every combination of the four flag bits, with the values around the edges.
        uint256[8] memory values = [uint256(0), 1, 999, 1 ether, 1_000 ether, 10 ** 30, type(uint128).max, type(uint256).max];
        uint256[4] memory limits = [uint256(0), 1 gwei, 5 ether, type(uint256).max];
        uint256[4] memory multipliers = [uint256(0), 0.01 ether, 1.2 ether, 5 ether];
        for (uint256 settings = 0; settings < 16; settings++) {
            for (uint256 v = 0; v < values.length; v++) {
                for (uint256 l = 0; l < limits.length; l++) {
                    for (uint256 m = 0; m < multipliers.length; m++) {
                        _printCase(settings, values[v], 400_000, limits[l], multipliers[m], 7 gwei, 3 gwei, v % 2 == 0);
                    }
                }
            }
        }
        // Gas based fees at several gas figures and prices.
        uint256[5] memory gasFigures = [uint256(0), 1, 198_850, 550_000, 30_000_000];
        uint256[4] memory baseFees = [uint256(0), 1, 7 gwei, 900 gwei];
        uint256[3] memory priorities = [uint256(0), 1 gwei, 50 gwei];
        for (uint256 g = 0; g < gasFigures.length; g++) {
            for (uint256 b = 0; b < baseFees.length; b++) {
                for (uint256 p = 0; p < priorities.length; p++) {
                    _printCase(0, 1_000 ether, gasFigures[g], 100 ether, 1.2 ether, baseFees[b], priorities[p], true);
                    _printCase(4, 1_000 ether, gasFigures[g], 100 ether, 1.2 ether, baseFees[b], priorities[p], false);
                    _printCase(2, 1_000 ether, gasFigures[g], 100 ether, 1.2 ether, baseFees[b], priorities[p], true);
                }
            }
        }
        // Overflow edges.
        _printCase(0, 1 ether, type(uint256).max, type(uint256).max, 1 ether, 1, 0, true);
        _printCase(0, 1 ether, type(uint256).max - 100_000, type(uint256).max, 1, 1, 0, true);
        _printCase(0, 1 ether, 1, type(uint256).max, type(uint256).max, 1 gwei, 0, true);
        _printCase(8, type(uint256).max, 0, 0, 2, 0, 0, true);
        _printCase(8, type(uint256).max / 2, 0, 0, 2, 0, 0, true);
        // Pseudo random cases from a fixed seed.
        for (uint256 i = 0; i < 120; i++) {
            uint256 seed = uint256(keccak256(abi.encode("delivery fee vector", i)));
            _printCase(
                seed % 16,
                (seed >> 4) % 10 ** 27,
                (seed >> 36) % 5_000_000,
                (seed >> 68) % 10 ** 24,
                (seed >> 100) % 10 ether,
                (seed >> 132) % 2_000 gwei,
                (seed >> 164) % 100 gwei,
                (seed >> 200) % 2 == 0
            );
        }
    }

    struct Case {
        uint256 settings;
        uint256 value;
        uint256 gasUsed;
        uint256 limit;
        uint256 multiplier;
        uint256 baseFee;
        uint256 priorityFee;
        bool wrappedNative;
    }

    function _printCase(
        uint256 settings,
        uint256 value,
        uint256 gasUsed,
        uint256 limit,
        uint256 multiplier,
        uint256 baseFee,
        uint256 priorityFee,
        bool wrappedNative
    ) private {
        _print(Case(settings, value, gasUsed, limit, multiplier, baseFee, priorityFee, wrappedNative));
    }

    function _print(Case memory c) private {
        address recipient = address(uint160(uint256(keccak256(abi.encode(c.settings, c.value, c.limit, c.multiplier)))));
        DeliveryRouter.FeeDirector memory director = DeliveryRouter.FeeDirector(recipient, c.settings, c.limit, c.multiplier);
        vm.fee(c.baseFee);
        vm.txGasPrice(c.baseFee + c.priorityFee);
        string memory head = _head(c, director);
        address token = c.wrappedNative ? WRAPPED_NATIVE : OTHER_TOKEN;
        try probe.feeInfo(token, c.value, c.gasUsed, director) returns (uint256 fee, uint256 toRecipient) {
            console2.log(
                string.concat(
                    head, "\",\"reverts\":false,\"fee\":\"", vm.toString(fee), "\",\"toRecipient\":\"", vm.toString(toRecipient), "\"}"
                )
            );
        } catch {
            console2.log(string.concat(head, "\",\"reverts\":true,\"fee\":\"0\",\"toRecipient\":\"0\"}"));
        }
    }

    function _head(Case memory c, DeliveryRouter.FeeDirector memory director) private view returns (string memory) {
        return string.concat(
            _directorFields(director),
            "\",\"wrappedNative\":", c.wrappedNative ? "true" : "false",
            ",\"value\":\"", vm.toString(c.value),
            "\",\"gasUsed\":\"", vm.toString(c.gasUsed),
            "\",\"baseFee\":\"", vm.toString(c.baseFee),
            "\",\"priorityFee\":\"", vm.toString(c.priorityFee)
        );
    }

    function _directorFields(DeliveryRouter.FeeDirector memory director) private view returns (string memory) {
        return string.concat(
            "VECTOR {\"recipient\":\"", vm.toString(director.recipient),
            "\",\"settings\":\"", vm.toString(director.settings),
            "\",\"limit\":\"", vm.toString(director.limit),
            "\",\"multiplier\":\"", vm.toString(director.multiplier),
            "\",\"encoded\":\"", vm.toString(abi.encode(director))
        );
    }
}
