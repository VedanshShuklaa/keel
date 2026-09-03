// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The operator/venue control plane. Every Event Contract on Somnia is
///         created under a venue, and every venue belongs to an operator.
/// @dev Tuple shapes and selectors verified against `@somnia-chain/markets-sdk`
///      0.29.0 `src/operatorAbi.ts` and live reads on Shannon; see
///      `docs/SDK-0.29.0-VERIFIED.md` §4.
interface IMarketsCore {
    /// @param feeParams            Opaque blob from `encodeVenueFeeParams`. Frozen
    ///                             into every market this venue creates.
    /// @param feeRecipientOverride Zero falls back to the operator's recipient.
    /// @param policy               IVenuePolicy gating who may create markets here.
    /// @param signer               Non-zero demands a venue signature per create,
    ///                             which an automated roll loop cannot produce.
    /// @param creationEnabled      Master switch for market creation.
    struct VenueConfig {
        bytes feeParams;
        address feeRecipientOverride;
        address policy;
        address signer;
        bool creationEnabled;
        bytes context;
    }

    /// @dev 0xb3012817.
    function registerOperator(address feeRecipient, bool enabled, address policy, bytes calldata context)
        external
        returns (uint32 operatorId);

    /// @dev 0x796e23e1. `marketType` is `bytes4(keccak256("BINARY_V1"))`.
    function createVenue(uint32 operatorId, bytes4 marketType, VenueConfig calldata config)
        external
        returns (bytes32 venueId);

    function updateVenue(uint32 operatorId, bytes32 venueId, VenueConfig calldata config) external;
}

/// @notice The module's own fee-parameter encoder.
/// @dev Encoding is read off the deployed module rather than re-derived, so a
///      future `FEE_PARAMS_VERSION` bump cannot silently produce a venue whose
///      fees decode to something else. Selector `0x16899d27` — the 0.28.1 tuple
///      lacked `voidPolicy` and lives at a different, now-dead selector.
interface IBinaryVenueFees {
    struct VenueFeeParams {
        uint64 makerFeeBps;
        uint64 takerFeeBps;
        uint64 maxBuilderFeeBps;
        uint64 routingFeeBps;
        uint64 settlementFeeBps;
        uint8 voidPolicy;
    }

    function encodeVenueFeeParams(VenueFeeParams calldata vp) external pure returns (bytes memory);
    function MAX_FEE_BPS() external view returns (uint256);
}

/// @notice Mints a MarketCreator plus the MarketCreatorPolicy that gates it.
interface IMarketCreatorFactory {
    struct BookParams {
        uint256 tickSize;
        uint256 minQuantity;
        uint256 lotSize;
    }

    /// @dev 0x165ca027. `core` is the BinaryMarketsModule, `adapter` the OracleHub —
    ///      Oracle v2's single approved adapter, so there is nothing to arm per operator.
    function createMarketCreator(
        address owner,
        address core,
        address adapter,
        uint32 operatorId,
        bytes32 venueId,
        BookParams calldata defaultBookParams
    ) external returns (address creator, address policy);
}

/// @notice A factory-minted MarketCreator: registers rolling series and mints each
///         window's market off the previous one's expiry.
interface IMarketCreator {
    struct Series {
        address collateral;
        string asset;
        uint64 numericDecimals;
        uint64 intervalSec;
        uint64 settlementWindow;
    }

    /// @dev 0x9360d325. Owner-only, and it **upserts**: re-registering a live
    ///      seriesId overwrites its config and resets its oracle reference.
    function registerSeries(uint32 seriesId, Series calldata s) external;

    /// @dev 0xae3332fa. V1 only. Mints the first market and arms the reactivity
    ///      subscription that drives every later roll. Touches the Somnia
    ///      precompile, so it succeeds on testnet/mainnet and not on local anvil.
    function triggerRoll(uint32 seriesId) external;

    /// @dev 0xea623a3c. Start at a future aligned boundary without minting now.
    function armFirstRoll(uint32 seriesId, uint256 firesAtSec) external;

    function setReactivityGasParams(uint64 priorityFeePerGas, uint64 maxFeePerGas, uint64 gasLimit) external;

    /// @dev Permissionless — moves only this creator's own oracle surplus to itself.
    function reclaimOracleCredit() external returns (uint256 reclaimed);

    function latestExpiryBySeriesId(uint32 seriesId) external view returns (uint64 expiry);
    function marketCount() external view returns (uint256);
}

/// @notice The per-creator allowlist a venue consults on every create.
interface IMarketCreatorPolicy {
    function approved(address creator) external view returns (bool);
    function setCreator(address creator, bool allowed) external;
}

/// @notice Oracle v2's scheduling and reserve accounting.
/// @dev Every market creation must attach `getSchedulingCost(def) + resolveReserve()`
///      in native. The reserve is earmarked per market at bind and any surplus is
///      credited back to whoever fronted it. Live on Shannon: 0.2 STT.
interface IOracleHub {
    function resolveReserve() external view returns (uint256 reserve);
}
