// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title BurnAllToken
/// @notice `transferFrom` returns true and moves nothing. The vault must notice that it received nothing.
contract BurnAllToken is ERC20 {
    constructor() ERC20("Burn all", "BURN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return true;
    }
}

/// @title ReentrantToken
/// @notice During the next transfer it calls `target` with `data` and bubbles up any revert.
contract ReentrantToken is ERC20 {
    address public target;
    bytes public data;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arms the callback for the next transfer.
    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        address callee = target;
        if (callee == address(0)) return;
        target = address(0);
        (bool ok, bytes memory returned) = callee.call(data);
        if (ok) return;
        assembly {
            revert(add(returned, 0x20), mload(returned))
        }
    }
}
