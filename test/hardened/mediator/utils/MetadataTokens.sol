// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A token whose `decimals()` returns a chosen 256-bit word, as a token that does not follow the standard
/// can. The standard type is a `uint8`, so the word can be above 255 only for a token that does not follow it.
contract DecimalsReturningToken is ERC20 {
    uint256 private immutable _word;

    constructor(uint256 word) ERC20("Odd Decimals", "ODD") {
        _word = word;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public view override returns (uint8) {
        uint256 word = _word;
        assembly {
            mstore(0x00, word)
            return(0x00, 0x20)
        }
    }
}

/// @notice A token that has a name and a symbol and no `decimals()` function at all.
contract NoDecimalsToken {
    string public name = "No Decimals";
    string public symbol = "NOD";
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
