// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @notice Stand-in for tUSDC. Six decimals, because the vault's price scaling is
///         only interesting when the collateral is not 18.
contract MockERC20 is ERC20 {
    function name() public pure override returns (string memory) {
        return "Mock USDC";
    }

    function symbol() public pure override returns (string memory) {
        return "mUSDC";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
