// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The per-market DreamDEX BinaryPool: order book, complete-set mint/burn,
///         and the parameter block every other address is derived from.
/// @dev Signatures and selectors verified against `@somnia-chain/markets-sdk` 0.29.0
///      source and live `eth_call` on Shannon; see `docs/SDK-0.29.0-VERIFIED.md` §0.
interface IBinaryPool {
    /// @dev 0x54657dd2. Pool pulls `amount` collateral from the caller and mints
    ///      `amount` YES to `yesTo` and `amount` NO to `noTo`.
    function mintSet(address yesTo, address noTo, uint256 amount) external;

    /// @dev 0x55664dbd. Burns `amount` of both legs, refunds `amount` collateral.
    function burnSet(uint256 amount) external;

    /// @dev 0x718c2d4d. `payable` mirrors the on-chain signature even though binary
    ///      pools take no msg.value — dropping it changes the selector.
    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external payable returns (bool success, uint128 id);

    /// @dev 0x0dce6933. Best-effort: returns per-id success rather than reverting.
    function cancelOrders(uint128[] calldata orderIds) external returns (bool[] memory);

    /// @dev 0x2f2461cd. Permissionless keeper drain; skips ids that are not expired.
    function cancelExpiredOrders(uint128[] calldata orderIds) external;

    function getBinaryPoolParams()
        external
        view
        returns (
            address collateralToken,
            address market,
            address outcomeToken,
            uint256 yesId,
            uint256 noId,
            uint256 oneCollateral,
            uint256 setBacking,
            address feeRecipient,
            uint256 makerFeeBpsTimes1k,
            uint256 takerFeeBpsTimes1k,
            uint256 maxBuilderFeeBpsTimes1k,
            uint256 settlementFeeBpsTimes1k,
            address settlement,
            uint64 marketNonce,
            bool finalized
        );

    function getOrderBookParameters()
        external
        view
        returns (uint256 tickSize, uint256 minQuantity, uint256 lotSize);

    /// @dev Expiry seconds x 1e9. Every order must expire at or before this.
    function marketExpiryNs() external view returns (uint64);
}
