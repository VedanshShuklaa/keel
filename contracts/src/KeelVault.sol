// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";

import {SpreadPolicy} from "./lib/SpreadPolicy.sol";
import {IBinaryPool} from "./interfaces/IBinaryPool.sol";
import {IOutcome6909} from "./interfaces/IOutcome6909.sol";
import {IBinarySettlement, IBinaryMarket, IBinaryMarketsModule} from "./interfaces/IBinarySettlement.sol";

/// @title KeelVault
/// @notice The underwriting side of Keel. Depositors put in collateral; the vault
///         manufactures complete sets and rests both legs of a window's book above
///         par, so a taker who wants exposure always has something to hit.
///
/// @dev Three design decisions carry the whole safety argument, and each one
///      removes a class of attack rather than mitigating it.
///
///      1. **Quotes are priced on-chain, not accepted from off-chain.** The hot
///         quoter key supplies a fair value and a size; `SpreadPolicy` turns those
///         into the actual prices and enforces `askUp + askDown > 1`. Selling both
///         legs of a set for more than the set cost is profit no matter how the
///         window resolves, so a quoter key that is stolen or simply wrong can
///         quote badly but cannot quote at a structural loss.
///
///      2. **Share price is struck only when the vault is flat.** Marking a
///         half-filled book requires marking positions, and anything markable is
///         gameable — the classic vault attack is to move the mark and redeem
///         against it. Instead this vault runs in epochs: deposits and redemptions
///         queue, and `rollEpoch` may only run when every order is dead and every
///         position is redeemed, at which point net asset value is just the
///         collateral balance. There is no mark to game because there is no mark.
///
///      3. **The exit path never touches the quoter.** Every order Keel places
///         expires at the window's own expiry, expired escrow is reclaimable by
///         anyone, settled positions are redeemable by anyone, and `rollEpoch` is
///         permissionless. A depositor's worst case if the quoter key goes dark is
///         waiting out one market window and then driving the exit themselves.
///
///      Shares carry the collateral's own decimals, so one share is struck at one
///      unit of collateral and the two read on the same scale. The usual ERC-4626
///      decimal-offset defence is not needed here: the epoch design already makes
///      the first-depositor inflation attack impossible, because at zero supply the
///      share price is a constant rather than a ratio. Collateral donated before the
///      first deposit is therefore a gift to the first depositors, not a lever
///      against them.
contract KeelVault is ERC20, Ownable {
    using SafeTransferLib for address;
    using FixedPointMathLib for uint256;
    using SpreadPolicy for SpreadPolicy.Config;
    using SafeCastLib for uint256;

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint256 internal constant WAD = 1e18;

    /// @dev Minted once, to an address with no key, the first time the vault issues
    ///      shares. It costs the first depositor a rounding error and it closes the
    ///      share-inflation attack, which the epoch design does **not** close on its
    ///      own — an earlier version of this file claimed it did, and that was wrong.
    ///
    ///      The attack the zero-supply price does not stop: deposit dust while the
    ///      supply is zero, transfer a large amount of collateral straight to this
    ///      contract (a plain `transfer`, so it never touches `pendingDepositAssets`),
    ///      and roll. The roll prices at `WAD` because supply is zero, so the dust
    ///      mints dust — but the donation has landed in `nav`, and one wei of shares
    ///      now backs all of it. The next roll prices at `nav/supply`, an enormous
    ///      number, and the next honest depositor's shares floor to zero. Their
    ///      collateral stays in the vault, backing the attacker's single share.
    ///
    ///      Dead shares break it by taking the supply away from the attacker. To
    ///      floor a victim's deposit to zero the attacker must now donate more than
    ///      `DEAD_SHARES` times it, and they own only their own sliver of the supply,
    ///      so they forfeit almost all of that donation to shares nobody can redeem.
    ///      The attack stops paying for itself.
    uint256 internal constant DEAD_SHARES = 1e3;
    address internal constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @dev Defence in depth beside `DEAD_SHARES`, and a floor low enough that no
    ///      real depositor meets it: one thousandth of a unit at six decimals.
    uint256 internal constant MIN_DEPOSIT = 1e3;

    /// @dev DreamDEX order enums. Keel only ever sells, and only ever post-only:
    ///      a resting quote that crosses the book has taken instead of made, which
    ///      is the one thing this strategy must never do.
    uint8 internal constant KIND_SELL_YES = 1;
    uint8 internal constant KIND_SELL_NO = 3;
    uint8 internal constant TYPE_POST_ONLY = 3;
    uint8 internal constant SMO_CANCEL_TAKER = 0;

    /// @dev Ceiling on the owner-settable performance fee, fixed at deploy time so
    ///      the fee cannot be raised into a withdrawal.
    uint256 internal constant MAX_PERF_FEE_BPS = 2000; // 20%

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /// @param marketId    Module-level id, needed only to finalize after resolution.
    /// @param outcomeUpId ERC-6909 id of the Up leg.
    /// @param outcomeDownId ERC-6909 id of the Down leg.
    /// @param oneCollateral One whole outcome token in raw collateral units, i.e.
    ///        the raw price of certainty. Read from the pool rather than assumed,
    ///        because it is the venue's decimals and not a protocol constant.
    /// @param settlement  Per-pool settlement contract, read from the pool.
    /// @param outcome     ERC-6909 singleton, read from the pool.
    /// @param registered  Distinguishes a live entry from a zeroed one.
    struct Pool {
        bytes32 marketId;
        uint256 outcomeUpId;
        uint256 outcomeDownId;
        uint256 oneCollateral;
        address settlement;
        address outcome;
        bool registered;
    }

    /// @param epoch  Epoch the request was made in; claimable once `epoch` has rolled.
    /// @param assets Collateral queued for deposit.
    /// @param shares Shares queued for redemption.
    struct Pending {
        uint64 epoch;
        uint128 assets;
        uint128 shares;
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    address public immutable asset;
    address public immutable module;

    /// @dev The venue this vault will underwrite, and only this one. Every pool it
    ///      registers must belong to it, checked against the module rather than
    ///      against the pool's own word for it. See `registerPool`.
    bytes32 public immutable venueId;

    /// @dev Mirrors the collateral's decimals so a share and a unit of collateral
    ///      are quoted on the same scale, which is what the epoch price assumes.
    uint8 internal immutable _decimals;

    /// @notice Hot key. Quotes and cancels; cannot move a single unit of collateral out.
    address public quoter;

    /// @notice Recipient of performance-fee shares.
    address public feeRecipient;

    uint256 public perfFeeBps;

    /// @notice Highest share price ever struck. Fees accrue only above it, so a
    ///         loss must be earned back before the manager is paid again.
    uint256 public highWaterPrice;

    SpreadPolicy.Config internal _cfg;

    uint64 public epoch;

    /// @notice Share price struck at the end of each epoch, in collateral per share,
    ///         WAD-scaled. Requests made during epoch N settle at `sharePrice[N]`.
    mapping(uint64 => uint256) public sharePrice;

    mapping(address => Pending) public pendingOf;

    /// @notice Collateral sitting in the contract that is not yet vault equity.
    uint256 public pendingDepositAssets;
    /// @notice Shares transferred in and awaiting burn at the next roll.
    uint256 public pendingRedeemShares;
    /// @notice Collateral already promised to redeemers and excluded from equity.
    uint256 public reservedAssets;

    mapping(address => Pool) public pools;
    /// @notice Pools with live exposure. Kept small: an entry is dropped the moment
    ///         it is flat, so the flatness loop stays cheap.
    address[] public activePools;
    mapping(address => uint256) internal _activeIndexPlusOne;

    /// @notice Live order ids per pool, so cancellation and expiry reclaim need no
    ///         off-chain bookkeeping and no indexer.
    mapping(address => uint128[]) internal _openOrders;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event QuoterSet(address indexed quoter);
    event ConfigSet(SpreadPolicy.Config cfg);
    event FeeSet(address indexed recipient, uint256 bps);
    event PoolRegistered(address indexed pool, bytes32 indexed marketId);
    event PoolRetired(address indexed pool);
    event DepositRequested(address indexed user, uint64 indexed epoch, uint256 assets);
    event RedeemRequested(address indexed user, uint64 indexed epoch, uint256 shares);
    event Claimed(address indexed user, uint256 shares, uint256 assets);
    event EpochRolled(uint64 indexed epoch, uint256 sharePrice, uint256 nav, uint256 feeShares);
    event SetsMinted(address indexed pool, uint256 amount);
    event SetsBurned(address indexed pool, uint256 amount);
    /// @dev Prices are raw collateral units, each in its own leg's terms.
    event Quoted(address indexed pool, uint256 askUp, uint256 askDown, uint256 quantity);
    event Redeemed(address indexed pool, uint256 outcomeId, uint256 amount, uint256 collateralOut);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NotQuoter();
    error NotFlat();
    error ZeroAmount();
    error NothingToClaim();
    error PoolNotRegistered();
    error PoolAlreadyRegistered();
    error PoolNotFlat();
    error InsufficientInventory();
    error OrderRejected();
    error FeeTooHigh();
    error WindowNotExpired();
    error NotResolved();
    error InvalidQuote();
    error PoolParamsUnreadable();
    error PoolNotInMarket();
    error PoolNotFromOurVenue();
    error WrongCollateral();
    error WindowExpired();
    error DepositTooSmall(uint256 minimum);

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    constructor(
        address asset_,
        address module_,
        bytes32 venueId_,
        address quoter_,
        address feeRecipient_,
        uint256 perfFeeBps_,
        SpreadPolicy.Config memory cfg_
    ) {
        _initializeOwner(msg.sender);
        asset = asset_;
        _decimals = ERC20(asset_).decimals();
        module = module_;
        venueId = venueId_;
        quoter = quoter_;
        feeRecipient = feeRecipient_;
        if (perfFeeBps_ > MAX_PERF_FEE_BPS) revert FeeTooHigh();
        perfFeeBps = perfFeeBps_;
        cfg_.validate();
        _cfg = cfg_;
        epoch = 1;
        highWaterPrice = WAD;
        sharePrice[0] = WAD;
    }

    function name() public pure override returns (string memory) {
        return "Keel Underwriting Vault";
    }

    function symbol() public pure override returns (string memory) {
        return "kUSDC";
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    modifier onlyQuoter() {
        if (msg.sender != quoter) revert NotQuoter();
        _;
    }

    // -------------------------------------------------------------------------
    // Owner controls
    // -------------------------------------------------------------------------

    /// @dev Deliberately absent: any function that lets the owner move `asset` out.
    ///      The owner can change how the vault quotes and can rotate the hot key,
    ///      and that is the entire extent of the privilege.
    function setQuoter(address quoter_) external onlyOwner {
        quoter = quoter_;
        emit QuoterSet(quoter_);
    }

    function setConfig(SpreadPolicy.Config calldata cfg_) external onlyOwner {
        cfg_.validate();
        _cfg = cfg_;
        emit ConfigSet(cfg_);
    }

    function setFee(address recipient, uint256 bps) external onlyOwner {
        if (bps > MAX_PERF_FEE_BPS) revert FeeTooHigh();
        feeRecipient = recipient;
        perfFeeBps = bps;
        emit FeeSet(recipient, bps);
    }

    function config() external view returns (SpreadPolicy.Config memory) {
        return _cfg;
    }

    // -------------------------------------------------------------------------
    // Depositor surface
    // -------------------------------------------------------------------------

    /// @notice Queue collateral for the next epoch. Shares are struck at the price
    ///         computed when the vault is next flat, not at the price now — a price
    ///         computed now would have to mark an open book.
    function requestDeposit(uint256 assets) external {
        if (assets == 0) revert ZeroAmount();
        // Dust deposits exist to manufacture a tiny share supply, not to underwrite
        // anything. See `DEAD_SHARES`.
        if (assets < MIN_DEPOSIT) revert DepositTooSmall(MIN_DEPOSIT);
        _settleIfMatured(msg.sender);
        asset.safeTransferFrom(msg.sender, address(this), assets);
        pendingDepositAssets += assets;

        Pending storage p = pendingOf[msg.sender];
        p.epoch = epoch;
        p.assets += assets.toUint128();
        emit DepositRequested(msg.sender, epoch, assets);
    }

    /// @notice Queue shares for redemption at the next epoch price.
    function requestRedeem(uint256 shares) external {
        if (shares == 0) revert ZeroAmount();
        _settleIfMatured(msg.sender);
        _transfer(msg.sender, address(this), shares);
        pendingRedeemShares += shares;

        Pending storage p = pendingOf[msg.sender];
        p.epoch = epoch;
        p.shares += shares.toUint128();
        emit RedeemRequested(msg.sender, epoch, shares);
    }

    /// @notice Collect shares from a matured deposit and collateral from a matured
    ///         redemption. Also runs automatically before a new request.
    function claim() external {
        if (!_settleIfMatured(msg.sender)) revert NothingToClaim();
    }

    /// @dev Returns whether anything was settled, so `claim` can distinguish a
    ///      no-op from a real collection rather than silently succeeding.
    function _settleIfMatured(address user) internal returns (bool) {
        Pending storage p = pendingOf[user];
        if (p.epoch == 0 || p.epoch >= epoch) return false;
        if (p.assets == 0 && p.shares == 0) return false;

        uint256 price = sharePrice[p.epoch];
        uint256 shares = uint256(p.assets).fullMulDiv(WAD, price);
        uint256 assets = uint256(p.shares).fullMulDiv(price, WAD);

        delete pendingOf[user];

        // Each user's share is floored, and a sum of floors never exceeds the floor
        // of the sum that was minted or reserved at the roll, so these transfers
        // can never overdraw the pool they come from.
        if (shares != 0) _transfer(address(this), user, shares);
        if (assets != 0) {
            reservedAssets -= assets;
            asset.safeTransfer(user, assets);
        }
        emit Claimed(user, shares, assets);
        return true;
    }

    // -------------------------------------------------------------------------
    // Epoch roll
    // -------------------------------------------------------------------------

    /// @notice Strike the share price and settle every queued request. Permissionless
    ///         by design: a depositor must never need the operator's cooperation to
    ///         get paid.
    /// @dev Only callable when the vault holds no orders and no positions, which is
    ///      what makes `nav` exact rather than a mark.
    function rollEpoch() external {
        if (activePools.length != 0) revert NotFlat();

        uint256 nav = asset.balanceOf(address(this)) - pendingDepositAssets - reservedAssets;
        uint256 supply = totalSupply();

        uint256 price = supply == 0 ? WAD : nav.fullMulDiv(WAD, supply);

        // Performance fee, charged only on the part of the price above the previous
        // high-water mark, and paid in shares so it cannot drain collateral.
        uint256 feeShares;
        if (supply != 0 && price > highWaterPrice && perfFeeBps != 0 && feeRecipient != address(0)) {
            uint256 gainPerShare = price - highWaterPrice;
            uint256 feeAssets = supply.fullMulDiv(gainPerShare, WAD) * perfFeeBps / 10_000;
            feeShares = feeAssets.fullMulDiv(WAD, price);
            if (feeShares != 0) {
                _mint(feeRecipient, feeShares);
                // Diluting the supply lowers the price the fee was struck at, so
                // restate it against the post-fee supply. Everyone redeems at the
                // same number, including the recipient.
                supply += feeShares;
                price = nav.fullMulDiv(WAD, supply);
            }
        }
        if (price > highWaterPrice) highWaterPrice = price;

        uint256 redeemShares = pendingRedeemShares;
        if (redeemShares != 0) {
            uint256 payout = redeemShares.fullMulDiv(price, WAD);
            _burn(address(this), redeemShares);
            reservedAssets += payout;
            pendingRedeemShares = 0;
        }

        uint256 depositAssets = pendingDepositAssets;
        if (depositAssets != 0) {
            // The one and only mint of dead shares, at the roll that first issues
            // any. It is the supply an attacker cannot own — see `DEAD_SHARES`.
            if (supply == 0) _mint(DEAD_ADDRESS, DEAD_SHARES);
            _mint(address(this), depositAssets.fullMulDiv(WAD, price));
            pendingDepositAssets = 0;
        }

        sharePrice[epoch] = price;
        emit EpochRolled(epoch, price, nav, feeShares);
        unchecked {
            epoch += 1;
        }
    }

    /// @notice Collateral backing outstanding shares, exact only while flat.
    /// @dev Provided for display. Share maths never reads it — see `rollEpoch`.
    function totalAssets() public view returns (uint256) {
        uint256 bal = asset.balanceOf(address(this));
        uint256 nav = bal - pendingDepositAssets - reservedAssets;
        uint256 n = activePools.length;
        for (uint256 i; i < n; ++i) {
            Pool storage p = pools[activePools[i]];
            uint256 up = IOutcome6909(p.outcome).balanceOf(address(this), p.outcomeUpId);
            uint256 down = IOutcome6909(p.outcome).balanceOf(address(this), p.outcomeDownId);
            // Matched sets are worth exactly one collateral unit each and can be
            // burned back at par by anyone. A leftover leg is worth 0 or 1 depending
            // on an outcome nobody knows yet, so it is carried at 0: the only
            // honest mark that cannot be argued upward.
            nav += FixedPointMathLib.min(up, down);
        }
        return nav;
    }

    // -------------------------------------------------------------------------
    // Quoter surface
    // -------------------------------------------------------------------------

    /// @notice Point the vault at a market's pool and grant the one-time approvals.
    /// @dev Everything that decides *whether* to trust this pool is read from the
    ///      module, which is immutable here, and nothing from the pool itself.
    ///
    ///      That distinction is the difference between a hot key that can quote
    ///      badly and a hot key that can empty the vault. This function ends in an
    ///      unlimited `approve` of the collateral to `pool`. If `pool` were simply
    ///      taken on trust, the quoter could pass a contract of its own whose
    ///      `getBinaryPoolParams()` returns the vault's real collateral address,
    ///      collect an infinite allowance, and `transferFrom` the entire balance —
    ///      queued deposits and reserved redemptions included. No amount of care in
    ///      the pricing path defends against that, because it never touches the
    ///      pricing path.
    ///
    ///      So: ask the module what pool that `marketId` actually has, and take the
    ///      outcome ids from the same answer. A forged pool cannot appear here
    ///      unless the module itself is lying, and the module is the contract whose
    ///      word the vault has no choice but to take.
    function registerPool(address pool, bytes32 marketId) external onlyQuoter {
        if (pools[pool].registered) revert PoolAlreadyRegistered();

        (
            address mCollateral,
            bytes32 mVenueId,
            address mPool,
            uint256 yesId,
            uint256 noId
        ) = _marketFromModule(marketId);

        if (mPool != pool) revert PoolNotInMarket();
        // Only the venue this vault was deployed to underwrite. Keel does not make
        // markets it did not launch, and this is where that stops being a promise.
        if (mVenueId != venueId) revert PoolNotFromOurVenue();
        // A pool settling in some other token would have this vault approve that
        // token and mint sets it cannot value.
        if (mCollateral != asset) revert WrongCollateral();

        // `oneCollateral`, `outcome` and `settlement` still come from the pool — but
        // only now that the module has vouched for the pool being real.
        (,, address outcome,,, uint256 one, address settlement) = _readPoolParams(pool);

        pools[pool] = Pool({
            marketId: marketId,
            outcomeUpId: yesId,
            outcomeDownId: noId,
            oneCollateral: one,
            settlement: settlement,
            outcome: outcome,
            registered: true
        });

        // The pool pulls collateral on mint; the pool, the settlement contract and
        // the module each pull outcome tokens. One ERC-6909 operator grant covers
        // every id and every market forever, so this is the only place it is needed.
        // `asset`, not the pool's own claim about its collateral — the two were
        // just checked equal, and using the immutable removes the question.
        asset.safeApproveWithRetry(pool, type(uint256).max);
        IOutcome6909(outcome).setOperator(pool, true);
        IOutcome6909(outcome).setOperator(settlement, true);
        IOutcome6909(outcome).setOperator(module, true);

        emit PoolRegistered(pool, marketId);
    }

    /// @notice Turn idle collateral into inventory: `amount` collateral becomes
    ///         `amount` Up and `amount` Down at the same time.
    /// @dev Minting into a window that has already expired is never a quote — it is
    ///      a way to keep the vault permanently non-flat. `rollEpoch` refuses while
    ///      any pool is active, so a hostile quoter that could mint at will could
    ///      block every deposit and redemption from ever settling, using the vault's
    ///      own collateral and nothing of its own. Tying `mintSets` to a live window
    ///      bounds that: the positions it opens expire on a clock the quoter does not
    ///      control, and once they do, anyone can reclaim, burn and roll.
    function mintSets(address pool, uint256 amount) external onlyQuoter {
        if (!pools[pool].registered) revert PoolNotRegistered();
        if (amount == 0) revert ZeroAmount();
        if (_tau(pool) == 0) revert WindowExpired();
        // Queued deposits and promised redemptions are not the vault's to trade.
        uint256 free = asset.balanceOf(address(this)) - pendingDepositAssets - reservedAssets;
        if (amount > free) revert InsufficientInventory();

        _markActive(pool);
        IBinaryPool(pool).mintSet(address(this), address(this), amount);
        emit SetsMinted(pool, amount);
    }

    /// @notice Replace the vault's quotes on a pool with a fresh two-sided pair.
    /// @dev Cancels first, so inventory is fully in hand when skew is measured and
    ///      the sizing check cannot be fooled by tokens sitting in escrow.
    /// @param fairValueUp Model probability of Up, WAD-scaled, from the off-chain
    ///        quoter. It is an input to the price, never the price itself.
    /// @param quantity    Outcome-token units to rest on each side.
    function quote(address pool, uint256 fairValueUp, uint256 quantity) external onlyQuoter {
        Pool storage p = pools[pool];
        if (!p.registered) revert PoolNotRegistered();
        _cancelAll(pool);
        // Cancelling then re-placing must never let the pool look flat in between:
        // `rollEpoch` reads that flag, and striking a share price against a book
        // Keel is about to be on again would mark a position that still exists.
        _markActive(pool);

        uint256 qty = _sizeQuote(pool, p, quantity);
        (uint256 rawUp, uint256 rawDown) = _legPrices(pool, p, fairValueUp);
        uint64 expiryNs = IBinaryPool(pool).marketExpiryNs();

        // The pool quotes everything in Up terms, including the order that sells
        // Down: resting Down at `rawDown` means resting Up at its complement, and
        // one whole collateral unit is a whole number of ticks, so the complement
        // stays on the grid.
        _place(pool, KIND_SELL_YES, rawUp, qty, expiryNs);
        _place(pool, KIND_SELL_NO, p.oneCollateral - rawDown, qty, expiryNs);

        emit Quoted(pool, rawUp, rawDown, qty);
    }

    /// @dev Keel only ever rests matched sets, so the size it can quote is capped by
    ///      the smaller leg it holds — never by the larger one, which would be a
    ///      naked short of the difference.
    function _sizeQuote(address pool, Pool storage p, uint256 quantity)
        internal
        view
        returns (uint256 qty)
    {
        (uint256 up, uint256 down) = _inventory(p);
        if (quantity == 0 || quantity > FixedPointMathLib.min(up, down)) revert InsufficientInventory();
        (,, uint256 lotSize) = IBinaryPool(pool).getOrderBookParameters();
        // The truncation is the point: an off-lot quantity is rejected by the pool.
        // forge-lint: disable-next-line(divide-before-multiply)
        qty = (quantity / lotSize) * lotSize;
        if (qty == 0) revert InsufficientInventory();
    }

    /// @dev The whole price path, split across three small steps because the EVM
    ///      stack will not hold it in one. Model input in, two raw on-grid ask
    ///      prices out, with the solvency invariant re-checked on what actually
    ///      gets sent rather than on what the policy returned.
    function _legPrices(address pool, Pool storage p, uint256 fairValueUp)
        internal
        view
        returns (uint256 rawUp, uint256 rawDown)
    {
        (uint256 askUp, uint256 askDown) = _asks(pool, p, fairValueUp);
        (uint256 tickSize,,) = IBinaryPool(pool).getOrderBookParameters();
        (rawUp, rawDown) = _snapToGrid(p.oneCollateral, tickSize, askUp, askDown);
    }

    /// @dev Applies the spread policy. Skew is measured against net asset value, so
    ///      the same absolute leftover leg widens a small vault more than a large one.
    function _asks(address pool, Pool storage p, uint256 fairValueUp)
        internal
        view
        returns (uint256, uint256)
    {
        (uint256 up, uint256 down) = _inventory(p);
        uint256 matched = FixedPointMathLib.min(up, down);
        uint256 nav = totalAssets();
        return _cfg.quote(
            fairValueUp,
            _tau(pool),
            nav == 0 ? 0 : (up - matched).fullMulDiv(WAD, nav),
            nav == 0 ? 0 : (down - matched).fullMulDiv(WAD, nav)
        );
    }

    /// @dev Converts WAD probabilities to raw collateral prices on the tick grid.
    ///      Both legs round up: rounding down would hand the taker a fraction of a
    ///      tick for free on each side, and two of those can exceed the entire
    ///      markup the strategy earns.
    function _snapToGrid(uint256 one, uint256 tickSize, uint256 askUp, uint256 askDown)
        internal
        view
        returns (uint256 rawUp, uint256 rawDown)
    {
        rawUp = _ceilTick(askUp.fullMulDiv(one, WAD), tickSize);
        rawDown = _ceilTick(askDown.fullMulDiv(one, WAD), tickSize);
        // A leg at or above certainty is not a price anyone can pay.
        if (rawUp >= one || rawDown >= one) revert InvalidQuote();
        _cfg.assertSolvent(rawUp.fullMulDiv(WAD, one), rawDown.fullMulDiv(WAD, one));
    }

    function _inventory(Pool storage p) internal view returns (uint256 up, uint256 down) {
        up = IOutcome6909(p.outcome).balanceOf(address(this), p.outcomeUpId);
        down = IOutcome6909(p.outcome).balanceOf(address(this), p.outcomeDownId);
    }

    /// @dev Seconds of window left. Clamped at zero rather than reverting, because
    ///      the policy's job at zero is to quote very wide, not to stop existing.
    function _tau(address pool) internal view returns (uint256) {
        uint256 expirySec = uint256(IBinaryPool(pool).marketExpiryNs()) / 1e9;
        return expirySec > block.timestamp ? expirySec - block.timestamp : 0;
    }

    /// @notice Pull every live quote on a pool.
    function cancelAll(address pool) external onlyQuoter {
        _cancelAll(pool);
        _retireIfFlat(pool);
    }

    // -------------------------------------------------------------------------
    // Permissionless keeper / exit surface
    // -------------------------------------------------------------------------

    /// @notice Reclaim escrow from orders the window has already expired past.
    /// @dev Permissionless and un-griefable: the pool skips any id that has not
    ///      expired, so this can free a stuck vault but cannot cancel a live quote.
    function reclaimExpired(address pool) external {
        uint128[] storage ids = _openOrders[pool];
        if (ids.length == 0) return;
        if (block.timestamp * 1e9 < IBinaryPool(pool).marketExpiryNs()) revert WindowNotExpired();
        IBinaryPool(pool).cancelExpiredOrders(ids);
        delete _openOrders[pool];
        _retireIfFlat(pool);
    }

    /// @notice Collapse matched inventory back into collateral at par.
    /// @dev Value-neutral by construction, but restricted to expired windows for
    ///      anyone other than the quoter: burning live inventory would not lose
    ///      money, it would just knock Keel off the book for free.
    function burnSets(address pool, uint256 amount) external {
        Pool storage p = pools[pool];
        if (!p.registered) revert PoolNotRegistered();
        if (msg.sender != quoter) {
            if (block.timestamp * 1e9 < IBinaryPool(pool).marketExpiryNs()) revert WindowNotExpired();
        }
        if (amount == 0) revert ZeroAmount();
        IBinaryPool(pool).burnSet(amount);
        emit SetsBurned(pool, amount);
        _retireIfFlat(pool);
    }

    /// @notice Sweep a resolved market's backing into settlement so redemption pays.
    function finalize(address pool) external {
        Pool storage p = pools[pool];
        if (!p.registered) revert PoolNotRegistered();
        IBinaryMarketsModule(module).finalizeMarket(p.marketId);
    }

    /// @notice Redeem whatever the vault still holds in a settled market.
    /// @dev Redeems every leg carrying a non-zero payout numerator, which covers a
    ///      void — a voided market pays half on both sides rather than all on one.
    function redeemSettled(address pool) external {
        Pool storage p = pools[pool];
        if (!p.registered) revert PoolNotRegistered();

        (, address market,,,,,) = _readPoolParams(pool);
        if (!IBinaryMarket(market).isResolved()) revert NotResolved();
        uint256[] memory numerators = IBinaryMarket(market).payoutNumerators();

        if (numerators.length > 0 && numerators[0] != 0) _redeemLeg(pool, p, p.outcomeUpId);
        if (numerators.length > 1 && numerators[1] != 0) _redeemLeg(pool, p, p.outcomeDownId);

        _retireIfFlat(pool);
    }

    function _redeemLeg(address pool, Pool storage p, uint256 id) internal {
        uint256 bal = IOutcome6909(p.outcome).balanceOf(address(this), id);
        if (bal == 0) return;
        uint256 out = IBinarySettlement(p.settlement).redeem(id, bal, address(this));
        emit Redeemed(pool, id, bal, out);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function openOrders(address pool) external view returns (uint128[] memory) {
        return _openOrders[pool];
    }

    function activePoolCount() external view returns (uint256) {
        return activePools.length;
    }

    /// @notice Whether `rollEpoch` can run right now.
    function isFlat() external view returns (bool) {
        return activePools.length == 0;
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /// @dev `getBinaryPoolParams` returns fifteen values, and Solidity's ABI decoder
    ///      for a tuple that wide overflows the stack before the caller does any work
    ///      at all. Every field is a single static word, so the seven Keel needs are
    ///      read straight out of the returndata by offset. Addresses are masked
    ///      because a hostile pool could return words with dirty upper bits.
    /// @dev `markets(bytes32)` on the module, decoded down to the five fields that
    ///      decide whether a pool may be registered. Fourteen values come back; the
    ///      ones taken here are `collateral` (3), `originVenueId` (5), `pool` (9),
    ///      `yesId` (10) and `noId` (11), all statically sized and therefore at
    ///      fixed word offsets.
    function _marketFromModule(bytes32 marketId)
        internal
        view
        returns (address collateral, bytes32 originVenueId, address pool, uint256 yesId, uint256 noId)
    {
        (bool ok, bytes memory data) =
            module.staticcall(abi.encodeWithSelector(IBinaryMarketsModule.markets.selector, marketId));
        if (!ok || data.length < 14 * 32) revert PoolParamsUnreadable();
        assembly {
            let d := add(data, 0x20)
            let mask := 0xffffffffffffffffffffffffffffffffffffffff
            collateral := and(mload(add(d, 0x60)), mask)
            originVenueId := mload(add(d, 0xa0))
            pool := and(mload(add(d, 0x120)), mask)
            yesId := mload(add(d, 0x140))
            noId := mload(add(d, 0x160))
        }
    }

    function _readPoolParams(address pool)
        internal
        view
        returns (
            address collateralToken,
            address market,
            address outcome,
            uint256 yesId,
            uint256 noId,
            uint256 one,
            address settlement
        )
    {
        (bool ok, bytes memory data) =
            pool.staticcall(abi.encodeWithSelector(IBinaryPool.getBinaryPoolParams.selector));
        if (!ok || data.length < 15 * 32) revert PoolParamsUnreadable();
        assembly {
            let d := add(data, 0x20)
            let mask := 0xffffffffffffffffffffffffffffffffffffffff
            collateralToken := and(mload(d), mask)
            market := and(mload(add(d, 0x20)), mask)
            outcome := and(mload(add(d, 0x40)), mask)
            yesId := mload(add(d, 0x60))
            noId := mload(add(d, 0x80))
            one := mload(add(d, 0xa0))
            settlement := and(mload(add(d, 0x180)), mask)
        }
    }

    function _place(address pool, uint8 kind, uint256 price, uint256 qty, uint64 expiryNs) internal {
        (bool ok, uint128 id) = IBinaryPool(pool).placeBinaryOrder(
            kind, price, qty, expiryNs, TYPE_POST_ONLY, SMO_CANCEL_TAKER, address(0), 0, 0
        );
        // A successful transaction can still contain a rejected order — a post-only
        // that would have crossed comes back `false` rather than reverting. Treating
        // that as placed would leave the vault quoting a book it is not on.
        if (!ok) revert OrderRejected();
        _openOrders[pool].push(id);
    }

    function _cancelAll(address pool) internal {
        uint128[] storage ids = _openOrders[pool];
        if (ids.length == 0) return;
        IBinaryPool(pool).cancelOrders(ids);
        delete _openOrders[pool];
    }

    function _markActive(address pool) internal {
        if (_activeIndexPlusOne[pool] != 0) return;
        activePools.push(pool);
        _activeIndexPlusOne[pool] = activePools.length;
    }

    /// @dev A pool leaves the active set only when it holds nothing at all, which is
    ///      exactly the condition `rollEpoch` depends on.
    function _retireIfFlat(address pool) internal {
        Pool storage p = pools[pool];
        if (_openOrders[pool].length != 0) return;
        if (IOutcome6909(p.outcome).balanceOf(address(this), p.outcomeUpId) != 0) return;
        if (IOutcome6909(p.outcome).balanceOf(address(this), p.outcomeDownId) != 0) return;

        uint256 idx = _activeIndexPlusOne[pool];
        if (idx == 0) return;
        uint256 last = activePools.length;
        if (idx != last) {
            address moved = activePools[last - 1];
            activePools[idx - 1] = moved;
            _activeIndexPlusOne[moved] = idx;
        }
        activePools.pop();
        delete _activeIndexPlusOne[pool];
        emit PoolRetired(pool);
    }

    /// @dev Rounds a raw price up onto the tick grid. Doing this in Solidity rather
    ///      than off-chain avoids the documented trap where a float price converted
    ///      through `toFixed` lands a few wei off a tick and the pool rejects it.
    function _ceilTick(uint256 raw, uint256 tickSize) internal pure returns (uint256) {
        // Snapping to a grid is division-then-multiplication by definition.
        // forge-lint: disable-next-line(divide-before-multiply)
        return ((raw + tickSize - 1) / tickSize) * tickSize;
    }
}
