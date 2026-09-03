// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Direct settlement route. Takes an outcome id, so it needs no marketId
///         and no operator/venue attribution.
interface IBinarySettlement {
    /// @dev 0x049104e5. Requires `setOperator(settlement, true)` on the singleton.
    function redeem(uint256 outcomeId, uint256 amount, address to)
        external
        returns (uint256 collateralOut);
}

/// @notice Per-market resolution state. `winningOutcome()` was removed in
///         settlement v3 and reverts on-chain — the payout vector is the source.
interface IBinaryMarket {
    function payoutNumerators() external view returns (uint256[] memory);
    function isResolved() external view returns (bool);
    function isVoided() external view returns (bool);
}

/// @notice Permissionless keeper entry point that sweeps a resolved pool's backing
///         into settlement. Must run before redemption can pay out.
interface IBinaryMarketsModule {
    function finalizeMarket(bytes32 marketId) external;

    /// @notice The module's own record of a market. Live-verified on Shannon
    ///         2026-09-03 against market `0x…010eac`: returns pool
    ///         `0xa02E260B…4180`, collateral `0x70a86D88…5d8E` and the originating
    ///         venue id, all matching the indexer.
    /// @dev Fourteen values, every one statically sized. Declared in full so the
    ///      selector is right; `KeelVault` decodes the five it needs by offset.
    function markets(bytes32 marketId)
        external
        view
        returns (
            uint256 oracleQuestionId,
            uint8 outcomeSlotCount,
            uint8 voidPolicy,
            address collateral,
            uint32 originOperatorId,
            bytes32 originVenueId,
            address oracleAdapter,
            address creator,
            address market,
            address pool,
            uint256 yesId,
            uint256 noId,
            uint64 tradingStart,
            uint64 expiry
        );
}
