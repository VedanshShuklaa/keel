// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {
    IMarketsCore,
    IBinaryVenueFees,
    IMarketCreatorFactory,
    IMarketCreator,
    IMarketCreatorPolicy,
    IOracleHub
} from "./interfaces/IMarketsControl.sol";

/// @title KeelFactory
/// @notice The launching side of Keel. Stands up Keel's own operator, venue,
///         market creator and creator-allowlist, then lets anyone open a rolling
///         Event Contract series on an oracle-fed asset that has none.
///
/// @dev This contract exists because of a measured fact rather than a preference.
///      DreamDEX's venue gates creation behind a `MarketCreatorPolicy` allowlist
///      that DreamDEX owns, so a third party cannot list a market there at all.
///      Running our own venue is the only path to launching anything — and it has
///      a second consequence worth stating plainly: on our own venue we also set
///      the maker and taker fees, which are zero on DreamDEX's.
///
///      Four decisions carry this contract.
///
///      1. **Bootstrap is one transaction or none.** Registering the operator,
///         creating the venue, minting the creator and allowlisting that creator
///         are a single atomic step. Split apart, a half-run leaves a venue that
///         reads as live and rejects every roll, and the operator and venue it
///         orphaned are not reclaimable — you pay to do it again.
///
///      2. **Launching is permissionless but never free.** Every market creation
///         attaches `resolveReserve()` in native value, earmarked per market by the
///         oracle hub. If launching cost the caller nothing, the first caller would
///         drain the creator's float and stall every series already running. So
///         `launch` is payable, priced off the hub's own live reserve, and the
///         value goes straight into the creator's float.
///
///      3. **Series ids are allocated here and never reused.** `registerSeries`
///         upserts by id and resets that series' oracle reference, so letting a
///         caller name an id hands them a switch that silently kills a running
///         series. The id space is a monotonic counter no caller can address.
///
///      4. **No owner path drains the float.** Launchers fund the creator, so the
///         float is theirs in every sense that matters; the only sweep is
///         `reclaimOracleCredit`, which is permissionless and moves the creator's
///         own oracle surplus to the creator. The owner sets fees and gas params
///         and nothing else.
contract KeelFactory is Ownable {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @dev `bytes4(keccak256("BINARY_V1"))`. Live-verified as the DreamDEX venue's
    ///      own `marketType`.
    bytes4 internal constant MARKET_TYPE_BINARY_V1 = 0x06c65d9f;

    /// @dev The module rejects anything shorter with `InvalidSeriesConfig`. Checked
    ///      here too so a caller gets a named error instead of a bare module revert.
    uint64 internal constant MIN_INTERVAL_SEC = 60;

    /// @dev A series rolling slower than this is not an Event Contract series in
    ///      any useful sense, and each roll would sit unquoted for days.
    uint64 internal constant MAX_INTERVAL_SEC = 7 days;

    /// @dev The oracle still has this long after expiry before the permissionless
    ///      void unlocks. Too short and a live answer arrives to a voided market.
    uint64 internal constant MIN_SETTLEMENT_WINDOW = 60;

    /// @dev `MAX_FEE_BPS` on the deployed module is 1000. Keel caps itself lower:
    ///      the pitch is that these markets are cheap to trade, and a fee the owner
    ///      can raise to 10% is not that pitch.
    uint64 internal constant MAX_KEEL_FEE_BPS = 100;

    uint256 internal constant MAX_ASSET_LEN = 16;

    /// @dev Reactivity gas budget the creator's roll loop pays its own callbacks
    ///      with. Set at bootstrap because a creator with zeros here cannot roll at
    ///      all — `triggerRoll` reverts with no revert data, which reads as a broken
    ///      deployment rather than a missing setting.
    ///
    ///      The gas limit is the number that matters and it is not a round guess: a
    ///      roll mints the market *and* schedules its oracle question, and measured
    ///      on Shannon 2026-09-02 that cost **64,387,607 gas**. A budget below it
    ///      does not fail loudly — the callback runs out of gas, the current market
    ///      settles normally, and no next market is ever minted. The series simply
    ///      stops, with nothing on-chain looking wrong. 120M leaves ~2x headroom;
    ///      `setReactivityGasParams` re-tunes without redeploying, and `rearm`
    ///      restarts a series that stalled before it was corrected.
    uint64 internal constant DEFAULT_PRIORITY_FEE = 1 gwei;
    uint64 internal constant DEFAULT_MAX_FEE = 15 gwei;
    uint64 internal constant DEFAULT_ROLL_GAS_LIMIT = 120_000_000;

    // -------------------------------------------------------------------------
    // Immutables — the deployed protocol
    // -------------------------------------------------------------------------

    IMarketsCore public immutable marketsCore;
    /// @dev Doubles as the `core` argument to `createMarketCreator` and as the
    ///      fee-params encoder.
    address public immutable binaryModule;
    IMarketCreatorFactory public immutable creatorFactory;
    /// @dev Oracle v2's single approved adapter.
    address public immutable oracleHub;

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    struct SeriesInfo {
        uint32 seriesId;
        address collateral;
        uint64 intervalSec;
        uint64 settlementWindow;
        uint64 numericDecimals;
        address launcher;
        string asset;
    }

    uint32 public operatorId;
    bytes32 public venueId;
    address public marketCreator;
    address public creatorPolicy;
    bool public bootstrapped;

    /// @dev How many rolls a launch is required to pre-pay for. A series that mints
    ///      its first market and then starves is worse than one that never opened,
    ///      so the entry price buys a runway rather than exactly one window.
    uint256 public rollsPrefunded = 4;

    /// @dev How much *time* a launch has to pre-pay for, which is the thing that
    ///      actually matters. Every series draws on one shared creator float, and a
    ///      flat roll count prices them all the same however fast they burn it: at
    ///      the 60-second minimum a series rolls 10,080 times in the span a 7-day
    ///      series rolls once, for identical money. That is not a fee mismatch, it
    ///      is a griefing vector — launch the cheap short-interval series and every
    ///      honestly funded long one starves behind it.
    ///
    ///      So the quote is per-runway, not per-roll: a launch buys `runwaySec` of
    ///      wall-clock life at its own cadence. `MAX_PREFUNDED_ROLLS` caps what the
    ///      shortest intervals can be charged, which does leave a bounded advantage
    ///      at the very short end — bounded by about 2x rather than by four orders
    ///      of magnitude, and `refuel` is permissionless for the rest.
    uint256 public runwaySec = 1 hours;

    uint256 internal constant MAX_PREFUNDED_ROLLS = 32;

    /// @dev The oracle's per-create value has two legs. `resolveReserve()` is a
    ///      constant this contract can read. The other is `getSchedulingCost(def)`,
    ///      quoted from a question definition the *market creator* assembles
    ///      internally — the factory has no way to reconstruct it on-chain, so it
    ///      cannot be read and must not be guessed silently. It is an explicit,
    ///      owner-set allowance instead, defaulting to a figure measured on Shannon
    ///      (1.096 STT for SOL at a 300s interval, rounded up for headroom).
    ///
    ///      Over-quoting is the safe direction: the hub refunds its own excess
    ///      in-transaction, and whatever is left over stays in the creator's float
    ///      and pays for later rolls. Under-quoting is not — it mints a series whose
    ///      very first roll reverts for want of native, which is exactly the failure
    ///      this allowance exists to prevent.
    uint256 public schedulingAllowance = 1.3 ether;

    uint32 internal nextSeriesId = 1;

    /// @dev keccak256(asset, intervalSec, collateral) -> seriesId. Keel's premise is
    ///      covering assets nobody covers; a second identical series would burn
    ///      reserve to split its own book in half.
    mapping(bytes32 => uint32) public seriesIdOf;
    mapping(uint32 => SeriesInfo) internal _series;
    uint32[] internal _seriesIds;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event Bootstrapped(uint32 indexed operatorId, bytes32 indexed venueId, address creator, address policy);
    event Launched(
        uint32 indexed seriesId, string asset, address indexed collateral, uint64 intervalSec, address indexed launcher
    );
    event Refuelled(address indexed from, uint256 amount);
    event CreditReclaimed(uint256 amount);
    event RollsPrefundedSet(uint256 rolls);
    event SchedulingAllowanceSet(uint256 allowance);
    event RunwaySecSet(uint256 runwaySec);
    event Rearmed(uint32 indexed seriesId, address indexed caller);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error AlreadyBootstrapped();
    error NotBootstrapped();
    error AlreadyLaunched(uint32 seriesId);
    error IntervalOutOfRange();
    error SettlementWindowTooShort();
    error InvalidAsset();
    error InsufficientLaunchValue(uint256 required);
    error ZeroAddress();
    error FeeTooHigh();
    error FundingFailed();
    error CreatorNotAllowlisted();
    error UnknownSeries(uint32 seriesId);

    constructor(address marketsCore_, address binaryModule_, address creatorFactory_, address oracleHub_) {
        if (
            marketsCore_ == address(0) || binaryModule_ == address(0) || creatorFactory_ == address(0)
                || oracleHub_ == address(0)
        ) revert ZeroAddress();
        marketsCore = IMarketsCore(marketsCore_);
        binaryModule = binaryModule_;
        creatorFactory = IMarketCreatorFactory(creatorFactory_);
        oracleHub = oracleHub_;
        _initializeOwner(msg.sender);
    }

    // -------------------------------------------------------------------------
    // Bootstrap
    // -------------------------------------------------------------------------

    /// @notice Stand up Keel's operator, venue, market creator and allowlist.
    /// @dev The chicken-and-egg here is real and is why `updateVenue` appears: the
    ///      venue must exist before `createMarketCreator` can be pointed at it, but
    ///      the policy that gates the venue is minted *by* `createMarketCreator`.
    ///      So the venue is created against `venuePolicySeed` and then repointed at
    ///      the policy we now own. Pass the deployed OpenPolicy as the seed if the
    ///      core rejects a zero create-side policy; zero works where it does not.
    ///
    ///      `signer` is left zero deliberately. A non-zero venue signer demands a
    ///      signature per market creation, and the roll loop that mints Keel's
    ///      windows is automated — it has no way to produce one.
    /// @param feeRecipient   Where this venue's fees accrue.
    /// @param makerFeeBps    Maker fee, capped at `MAX_KEEL_FEE_BPS`.
    /// @param takerFeeBps    Taker fee, capped at `MAX_KEEL_FEE_BPS`.
    /// @param venuePolicySeed Create-side policy for the venue before ours exists.
    /// @param book           Tick grid every market this creator mints inherits.
    function bootstrap(
        address feeRecipient,
        uint64 makerFeeBps,
        uint64 takerFeeBps,
        address venuePolicySeed,
        IMarketCreatorFactory.BookParams calldata book
    ) external onlyOwner returns (address creator, address policy) {
        if (bootstrapped) revert AlreadyBootstrapped();
        if (feeRecipient == address(0)) revert ZeroAddress();
        if (makerFeeBps > MAX_KEEL_FEE_BPS || takerFeeBps > MAX_KEEL_FEE_BPS) revert FeeTooHigh();

        uint32 opId = marketsCore.registerOperator(feeRecipient, true, address(0), "");

        bytes memory feeParams = IBinaryVenueFees(binaryModule).encodeVenueFeeParams(
            IBinaryVenueFees.VenueFeeParams({
                makerFeeBps: makerFeeBps,
                takerFeeBps: takerFeeBps,
                maxBuilderFeeBps: 0,
                routingFeeBps: 0,
                settlementFeeBps: 0,
                voidPolicy: 0
            })
        );

        bytes32 vId = marketsCore.createVenue(
            opId,
            MARKET_TYPE_BINARY_V1,
            IMarketsCore.VenueConfig({
                feeParams: feeParams,
                feeRecipientOverride: address(0),
                policy: venuePolicySeed,
                signer: address(0),
                creationEnabled: true,
                context: ""
            })
        );

        (creator, policy) = creatorFactory.createMarketCreator(address(this), binaryModule, oracleHub, opId, vId, book);

        // Repoint the venue at the policy we now own, then allowlist our creator on
        // it. Doing these in the same transaction as the create is the whole point:
        // a venue pointing at a policy that has not allowlisted its creator accepts
        // no rolls, and every roll it refuses still costs the caller gas.
        marketsCore.updateVenue(
            opId,
            vId,
            IMarketsCore.VenueConfig({
                feeParams: feeParams,
                feeRecipientOverride: address(0),
                policy: policy,
                signer: address(0),
                creationEnabled: true,
                context: ""
            })
        );
        IMarketCreatorPolicy(policy).setCreator(creator, true);
        if (!IMarketCreatorPolicy(policy).approved(creator)) revert CreatorNotAllowlisted();

        // A creator minted with zero reactivity gas params cannot arm its roll loop,
        // and `triggerRoll` reverts with no revert data at all — which reads as a
        // broken deployment rather than a missing setting. Bootstrapping is the only
        // moment we can guarantee it is done, so it is done here. Shannon's base fee
        // was 6 gwei when these were chosen; `setReactivityGasParams` re-tunes them
        // without redeploying.
        IMarketCreator(creator).setReactivityGasParams(
            DEFAULT_PRIORITY_FEE, DEFAULT_MAX_FEE, DEFAULT_ROLL_GAS_LIMIT
        );

        operatorId = opId;
        venueId = vId;
        marketCreator = creator;
        creatorPolicy = policy;
        bootstrapped = true;

        emit Bootstrapped(opId, vId, creator, policy);
    }

    /// @notice Reactivity gas budget the creator spends driving its own roll loop.
    /// @dev Must be set before the first `triggerRoll`; the loop pays for its own
    ///      scheduled callbacks out of the creator's native float.
    function setReactivityGasParams(uint64 priorityFeePerGas, uint64 maxFeePerGas, uint64 gasLimit)
        external
        onlyOwner
    {
        if (!bootstrapped) revert NotBootstrapped();
        IMarketCreator(marketCreator).setReactivityGasParams(priorityFeePerGas, maxFeePerGas, gasLimit);
    }

    function setRollsPrefunded(uint256 rolls) external onlyOwner {
        if (rolls == 0) revert IntervalOutOfRange();
        rollsPrefunded = rolls;
        emit RollsPrefundedSet(rolls);
    }

    /// @notice Re-price the scheduling leg of a create. See `schedulingAllowance`.
    /// @dev Raising it makes launching dearer; lowering it below what the oracle
    ///      actually charges makes every launch revert on its first roll. There is
    ///      no on-chain read to validate it against, so it is deliberately an
    ///      owner decision with a measured default rather than a silent guess.
    function setSchedulingAllowance(uint256 allowance) external onlyOwner {
        schedulingAllowance = allowance;
        emit SchedulingAllowanceSet(allowance);
    }

    // -------------------------------------------------------------------------
    // Launch — permissionless
    // -------------------------------------------------------------------------

    /// @notice What `launch` costs right now: the oracle's per-create value times
    ///         the runway a launch has to buy.
    /// @dev The reserve leg is read off the hub rather than stored, so a
    ///      protocol-side reserve change cannot leave this stale. The scheduling
    ///      leg cannot be read at all — see `schedulingAllowance` — so it is added
    ///      from the allowance. Measured on Shannon 2026-09-02: the hub asked for
    ///      1.296 STT to create one SOL/300s market, against a `resolveReserve()`
    ///      of 0.2. A quote that counted only the reserve reverted on the first
    ///      roll; both legs are needed.
    function launchCost() public view returns (uint256) {
        return launchCostFor(MIN_INTERVAL_SEC * 5); // 300s, the reference cadence
    }

    /// @notice What a launch at this cadence costs. Faster series cost more, because
    ///         they consume the shared float faster. See `runwaySec`.
    function launchCostFor(uint64 intervalSec) public view returns (uint256) {
        uint256 rolls = intervalSec == 0 ? MAX_PREFUNDED_ROLLS : runwaySec / intervalSec;
        if (rolls < rollsPrefunded) rolls = rollsPrefunded;
        if (rolls > MAX_PREFUNDED_ROLLS) rolls = MAX_PREFUNDED_ROLLS;
        return (IOracleHub(oracleHub).resolveReserve() + schedulingAllowance) * rolls;
    }

    function setRunwaySec(uint256 seconds_) external onlyOwner {
        if (seconds_ == 0) revert IntervalOutOfRange();
        runwaySec = seconds_;
        emit RunwaySecSet(seconds_);
    }

    /// @notice Open a rolling Event Contract series on an asset that has none.
    /// @dev Anyone may call this. The attached value funds the creator's float,
    ///      which is what pays each roll's oracle reserve — so the caller buys the
    ///      series a runway rather than a single window.
    ///
    ///      `triggerRoll` mints the first market *and* arms the reactivity
    ///      subscription that mints every later one. It calls the Somnia precompile,
    ///      so this function works on testnet and mainnet and not on local anvil.
    /// @param asset            Display ticker, and the base symbol the oracle's
    ///                         candle sources resolve — `"BTC"`, never a pair.
    /// @param collateral       ERC-20 the series settles in.
    /// @param numericDecimals  Precision of the oracle's numeric answer.
    /// @param intervalSec      Roll cadence.
    /// @param settlementWindow Post-expiry seconds the oracle still has.
    function launch(
        string calldata asset,
        address collateral,
        uint64 numericDecimals,
        uint64 intervalSec,
        uint64 settlementWindow
    ) external payable returns (uint32 seriesId) {
        if (!bootstrapped) revert NotBootstrapped();
        if (collateral == address(0)) revert ZeroAddress();
        if (intervalSec < MIN_INTERVAL_SEC || intervalSec > MAX_INTERVAL_SEC) revert IntervalOutOfRange();
        if (settlementWindow < MIN_SETTLEMENT_WINDOW) revert SettlementWindowTooShort();
        _requireTicker(asset);

        uint256 cost = launchCostFor(intervalSec);
        if (msg.value < cost) revert InsufficientLaunchValue(cost);

        bytes32 key = seriesKey(asset, intervalSec, collateral);
        uint32 existing = seriesIdOf[key];
        if (existing != 0) revert AlreadyLaunched(existing);

        seriesId = nextSeriesId++;
        seriesIdOf[key] = seriesId;
        _seriesIds.push(seriesId);
        _series[seriesId] = SeriesInfo({
            seriesId: seriesId,
            collateral: collateral,
            intervalSec: intervalSec,
            settlementWindow: settlementWindow,
            numericDecimals: numericDecimals,
            launcher: msg.sender,
            asset: asset
        });

        // Fund before registering. The creator pays each create out of its own
        // float, so a series that is armed before the money lands can fire a roll
        // it cannot pay for.
        _fundCreator(msg.value);

        IMarketCreator(marketCreator).registerSeries(
            seriesId,
            IMarketCreator.Series({
                collateral: collateral,
                asset: asset,
                numericDecimals: numericDecimals,
                intervalSec: intervalSec,
                settlementWindow: settlementWindow
            })
        );
        IMarketCreator(marketCreator).triggerRoll(seriesId);

        emit Launched(seriesId, asset, collateral, intervalSec, msg.sender);
    }

    /// @notice Restart a series whose roll loop has stopped.
    /// @dev Measured on Shannon 2026-09-02: a reactivity callback that runs out of
    ///      gas leaves the series stranded — the last market settles normally and
    ///      no next one is ever minted. `armedBoundary` still reads as the dead
    ///      market's expiry, so nothing on-chain looks broken.
    ///
    ///      `triggerRoll` is owner-only on the creator and this contract is that
    ///      owner, so without this function a stranded series could not be revived
    ///      at all — the only remedy would be launching a fresh series under a new
    ///      id, abandoning the old one's history.
    ///
    ///      Permissionless for the same reason `refuel` is: a stalled series hurts
    ///      everyone holding its positions, and gating the fix behind the owner
    ///      makes the operator a liveness dependency the design does not accept.
    ///      It spends only the creator's float, never the caller's, and it cannot
    ///      mint a second live window — the creator rolls to the next boundary,
    ///      not to an arbitrary one.
    function rearm(uint32 seriesId) external {
        if (!bootstrapped) revert NotBootstrapped();
        if (bytes(_series[seriesId].asset).length == 0) revert UnknownSeries(seriesId);
        IMarketCreator(marketCreator).triggerRoll(seriesId);
        emit Rearmed(seriesId, msg.sender);
    }

    /// @notice Top up the creator's float. Permissionless, because a starved
    ///         creator stalls every series it runs and anyone holding those
    ///         positions has reason to fix it.
    function refuel() public payable {
        if (!bootstrapped) revert NotBootstrapped();
        _fundCreator(msg.value);
        emit Refuelled(msg.sender, msg.value);
    }

    receive() external payable {
        refuel();
    }

    /// @notice Sweep the creator's accrued oracle surplus back into its own float.
    /// @dev Permissionless on the creator too — it moves the creator's own credit
    ///      to the creator and nowhere else.
    function reclaimOracleCredit() external returns (uint256 reclaimed) {
        if (!bootstrapped) revert NotBootstrapped();
        reclaimed = IMarketCreator(marketCreator).reclaimOracleCredit();
        emit CreditReclaimed(reclaimed);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function seriesKey(string memory asset, uint64 intervalSec, address collateral) public pure returns (bytes32) {
        return keccak256(abi.encode(asset, intervalSec, collateral));
    }

    function seriesCount() external view returns (uint256) {
        return _seriesIds.length;
    }

    function seriesAt(uint256 index) external view returns (SeriesInfo memory) {
        return _series[_seriesIds[index]];
    }

    function series(uint32 seriesId) external view returns (SeriesInfo memory) {
        return _series[seriesId];
    }

    /// @notice Native float the creator has left to pay rolls with.
    function creatorFloat() external view returns (uint256) {
        return marketCreator.balance;
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    function _fundCreator(uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = marketCreator.call{value: amount}("");
        if (!ok) revert FundingFailed();
    }

    /// @dev The asset string doubles as the base symbol the oracle's candle sources
    ///      look up on the exchanges. There is no on-chain allow-list of tickers, so
    ///      a malformed one registers cleanly and then never resolves — the series
    ///      looks alive, mints windows, and settles none of them. Rejecting anything
    ///      that is not a plain uppercase alphanumeric ticker turns that silent
    ///      failure into a revert the caller can read.
    function _requireTicker(string calldata asset) internal pure {
        bytes calldata b = bytes(asset);
        if (b.length == 0 || b.length > MAX_ASSET_LEN) revert InvalidAsset();
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            bool upper = c >= 0x41 && c <= 0x5A;
            bool digit = c >= 0x30 && c <= 0x39;
            if (!upper && !digit) revert InvalidAsset();
        }
    }
}
