// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The protocol-wide ERC-6909 singleton holding every market's Up/Down
///         positions. Approval is per-operator and covers every id at once.
interface IOutcome6909 {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    function isOperator(address owner, address spender) external view returns (bool);
    function setOperator(address spender, bool approved) external returns (bool);
}
