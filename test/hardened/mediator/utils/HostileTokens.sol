// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A token whose `transfer` burns a fixed amount of gas and then moves the tokens as usual. `transferFrom`
/// burns nothing, so a relay into the mediator costs what a plain token costs. It stands for a token with a heavy
/// transfer hook.
contract GasBurningToken is ERC20 {
    uint256 public immutable burnedGas;

    constructor(uint256 burnedGas_) ERC20("Gas Burner", "BURN") {
        burnedGas = burnedGas_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        uint256 start = gasleft();
        while (start - gasleft() < burnedGas) {}
        return super.transfer(to, value);
    }
}

/// @notice A token whose `transfer` runs the INVALID opcode. The opcode burns all the gas that the call gets, and the
/// call fails.
contract InvalidOpcodeToken is ERC20 {
    constructor() ERC20("Invalid", "INV") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        assembly {
            invalid()
        }
    }
}
