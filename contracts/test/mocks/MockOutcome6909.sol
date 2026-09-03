// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal ERC-6909 singleton: per-id balances, per-operator approval.
contract MockOutcome6909 {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isOperator;

    error NotOperator();
    error InsufficientBalance();

    function setOperator(address spender, bool approved) external returns (bool) {
        isOperator[msg.sender][spender] = approved;
        return true;
    }

    function mint(address to, uint256 id, uint256 amount) external {
        balanceOf[to][id] += amount;
    }

    function burnFrom(address from, uint256 id, uint256 amount) external {
        if (from != msg.sender && !isOperator[from][msg.sender]) revert NotOperator();
        if (balanceOf[from][id] < amount) revert InsufficientBalance();
        balanceOf[from][id] -= amount;
    }

    function transferFrom(address from, address to, uint256 id, uint256 amount) external returns (bool) {
        if (from != msg.sender && !isOperator[from][msg.sender]) revert NotOperator();
        if (balanceOf[from][id] < amount) revert InsufficientBalance();
        balanceOf[from][id] -= amount;
        balanceOf[to][id] += amount;
        return true;
    }
}
