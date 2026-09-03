// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockERC20} from "./MockERC20.sol";
import {MockOutcome6909} from "./MockOutcome6909.sol";

/// @notice Resolution state of a market, matching the v3 payout-vector shape.
contract MockBinaryMarket {
    uint256[] internal _numerators;
    bool public isResolved;
    bool public isVoided;

    function payoutNumerators() external view returns (uint256[] memory) {
        return _numerators;
    }

    function resolveUp() external {
        _numerators = [uint256(10_000_000), 0];
        isResolved = true;
    }

    function resolveDown() external {
        _numerators = [uint256(0), 10_000_000];
        isResolved = true;
    }

    function resolveVoid() external {
        _numerators = [uint256(5_000_000), 5_000_000];
        isResolved = true;
        isVoided = true;
    }
}

/// @notice Pays out winning positions at par against its own collateral balance.
contract MockSettlement {
    MockERC20 public immutable collateral;
    MockOutcome6909 public immutable outcome;
    mapping(uint256 => uint256) public payoutPerUnit; // raw collateral per whole token

    constructor(MockERC20 c, MockOutcome6909 o) {
        collateral = c;
        outcome = o;
    }

    function setPayout(uint256 id, uint256 perUnit) external {
        payoutPerUnit[id] = perUnit;
    }

    function redeem(uint256 outcomeId, uint256 amount, address to) external returns (uint256) {
        outcome.burnFrom(msg.sender, outcomeId, amount);
        uint256 out = amount * payoutPerUnit[outcomeId] / 1e6;
        if (out != 0) collateral.transfer(to, out);
        return out;
    }
}

contract MockModule {
    mapping(bytes32 => bool) public finalized;

    /// @dev The module's market registry, which is what `registerPool` trusts. A
    ///      marketId that was never listed here returns zeros, so a pool the module
    ///      does not know cannot be registered — that is the point of the check.
    struct MarketRow {
        address collateral;
        bytes32 originVenueId;
        address pool;
        uint256 yesId;
        uint256 noId;
    }

    mapping(bytes32 => MarketRow) internal _rows;

    function list(bytes32 marketId, address collateral, bytes32 venueId, address pool, uint256 yesId, uint256 noId)
        external
    {
        _rows[marketId] = MarketRow(collateral, venueId, pool, yesId, noId);
    }

    function finalizeMarket(bytes32 marketId) external {
        finalized[marketId] = true;
    }

    /// @dev Same fourteen-value shape as the deployed module, so the vault's
    ///      offset-based decoding is exercised rather than bypassed.
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
        )
    {
        MarketRow storage r = _rows[marketId];
        return (
            0, 2, 0, r.collateral, 0, r.originVenueId, address(0), address(0), address(0), r.pool, r.yesId, r.noId, 0, 0
        );
    }
}

/// @notice A BinaryPool faithful to the parts KeelVault depends on: complete-set
///         mint and burn, outcome-token escrow on resting sells, best-effort
///         cancellation, and lazy expiry.
/// @dev `fill` is the taker the real book would provide. Prices are always in Up
///      terms, including for the order that sells Down — the same trap the real
///      pool sets.
contract MockBinaryPool {
    struct Order {
        address owner;
        uint8 kind;
        uint256 price;
        uint256 remaining;
        uint64 expireNs;
        bool live;
    }

    uint8 internal constant SELL_YES = 1;
    uint8 internal constant SELL_NO = 3;

    MockERC20 public immutable collateral;
    MockOutcome6909 public immutable outcome;
    MockBinaryMarket public immutable market;
    MockSettlement public immutable settlement;

    uint256 public immutable yesId;
    uint256 public immutable noId;
    uint256 public constant oneCollateral = 1e6;

    uint256 public tickSize = 1000;
    uint256 public minQuantity = 1000;
    uint256 public lotSize = 1000;

    uint64 public marketExpiryNs;

    mapping(uint128 => Order) public orders;
    uint128 public nextOrderId = 1;

    /// @notice Set true to make every placement come back rejected, which is what a
    ///         post-only order that would cross does — without reverting.
    bool public rejectPlacements;

    error PriceOffTick();
    error QuantityOffLot();
    error BadExpiry();

    constructor(MockERC20 c, MockOutcome6909 o, MockBinaryMarket m, MockSettlement s, uint64 expiryNs) {
        collateral = c;
        outcome = o;
        market = m;
        settlement = s;
        marketExpiryNs = expiryNs;
        yesId = uint256(uint160(address(this))) << 72 | (1 << 8) | 0;
        noId = uint256(uint160(address(this))) << 72 | (1 << 8) | 1;
    }

    function setRejectPlacements(bool v) external {
        rejectPlacements = v;
    }

    function setExpiryNs(uint64 v) external {
        marketExpiryNs = v;
    }

    function getBinaryPoolParams()
        external
        view
        returns (address, address, address, uint256, uint256, uint256, uint256, address, uint256, uint256, uint256, uint256, address, uint64, bool)
    {
        return (
            address(collateral),
            address(market),
            address(outcome),
            yesId,
            noId,
            oneCollateral,
            0,
            address(0),
            0,
            0,
            0,
            0,
            address(settlement),
            1,
            false
        );
    }

    function getOrderBookParameters() external view returns (uint256, uint256, uint256) {
        return (tickSize, minQuantity, lotSize);
    }

    function mintSet(address yesTo, address noTo, uint256 amount) external {
        collateral.transferFrom(msg.sender, address(this), amount);
        outcome.mint(yesTo, yesId, amount);
        outcome.mint(noTo, noId, amount);
    }

    function burnSet(uint256 amount) external {
        outcome.burnFrom(msg.sender, yesId, amount);
        outcome.burnFrom(msg.sender, noId, amount);
        collateral.transfer(msg.sender, amount);
    }

    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8,
        uint8,
        address,
        uint96,
        uint64
    ) external payable returns (bool, uint128) {
        if (rejectPlacements) return (false, 0);
        if (price == 0 || price % tickSize != 0) revert PriceOffTick();
        if (quantity < minQuantity || quantity % lotSize != 0) revert QuantityOffLot();
        if (expireTimestampNs == 0 || expireTimestampNs > marketExpiryNs) revert BadExpiry();

        // The set the vault minted is the escrow; no further collateral is locked.
        uint256 id = kind == SELL_YES ? yesId : noId;
        outcome.transferFrom(msg.sender, address(this), id, quantity);

        uint128 orderId = nextOrderId++;
        orders[orderId] = Order(msg.sender, kind, price, quantity, expireTimestampNs, true);
        return (true, orderId);
    }

    function cancelOrders(uint128[] calldata ids) external returns (bool[] memory ok) {
        ok = new bool[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            ok[i] = _cancel(ids[i], false);
        }
    }

    function cancelExpiredOrders(uint128[] calldata ids) external {
        for (uint256 i; i < ids.length; ++i) {
            _cancel(ids[i], true);
        }
    }

    function _cancel(uint128 id, bool requireExpired) internal returns (bool) {
        Order storage o = orders[id];
        if (!o.live) return false;
        if (requireExpired && block.timestamp * 1e9 < o.expireNs) return false;
        uint256 oid = o.kind == SELL_YES ? yesId : noId;
        outcome.transferFrom(address(this), o.owner, oid, o.remaining);
        o.live = false;
        return true;
    }

    /// @notice Simulate a taker crossing `quantity` of `id`. The maker keeps nothing
    ///         of the escrowed leg and is paid in collateral at its own resting price.
    function fill(uint128 id, uint256 quantity) external {
        Order storage o = orders[id];
        require(o.live && quantity <= o.remaining, "no fill");
        o.remaining -= quantity;
        if (o.remaining == 0) o.live = false;
        uint256 proceedsPerUnit = o.kind == SELL_YES ? o.price : oneCollateral - o.price;
        collateral.transfer(o.owner, quantity * proceedsPerUnit / oneCollateral);
    }
}
