// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {KeelFactory} from "../src/KeelFactory.sol";
import {IMarketCreatorFactory} from "../src/interfaces/IMarketsControl.sol";
import {
    MockMarketsCore,
    MockBinaryModule,
    MockOracleHub,
    MockCreatorPolicy,
    MockMarketCreator,
    MockMarketCreatorFactory
} from "./mocks/MockMarketsControl.sol";

contract KeelFactoryTest is Test {
    MockMarketsCore core;
    MockBinaryModule module;
    MockOracleHub hub;
    MockMarketCreatorFactory mcFactory;
    KeelFactory factory;

    address owner = address(0xBEEF);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address collateral = address(0xC011A);
    address feeRecipient = address(0xFEE);

    IMarketCreatorFactory.BookParams book =
        IMarketCreatorFactory.BookParams({tickSize: 1000, minQuantity: 1000, lotSize: 1000});

    function setUp() public {
        core = new MockMarketsCore();
        module = new MockBinaryModule();
        hub = new MockOracleHub();
        mcFactory = new MockMarketCreatorFactory(address(hub));

        vm.prank(owner);
        factory = new KeelFactory(address(core), address(module), address(mcFactory), address(hub));

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(owner, 100 ether);
    }

    function _bootstrap() internal {
        vm.prank(owner);
        factory.bootstrap(feeRecipient, 10, 20, address(0), book);
    }

    // -------------------------------------------------------------------------
    // Bootstrap
    // -------------------------------------------------------------------------

    function test_bootstrapWiresOperatorVenueCreatorAndAllowlist() public {
        _bootstrap();

        assertEq(factory.operatorId(), 1);
        assertTrue(factory.venueId() != bytes32(0));
        assertTrue(factory.marketCreator() != address(0));
        assertTrue(factory.creatorPolicy() != address(0));
        assertTrue(factory.bootstrapped());

        // The gate DreamDEX's own venue closes against third parties is open here
        // because Keel owns the policy and allowlisted itself in the same call.
        assertTrue(MockCreatorPolicy(factory.creatorPolicy()).approved(factory.marketCreator()));
    }

    /// @dev The venue has to exist before the creator can be pointed at it, but the
    ///      policy that gates the venue is minted by the creator. Bootstrap resolves
    ///      that by repointing the venue afterwards — if it did not, the venue would
    ///      still be gated by the seed and refuse every roll.
    function test_bootstrapRepointsVenueAtThePolicyItMinted() public {
        address seed = address(0xDEAD);
        vm.prank(owner);
        factory.bootstrap(feeRecipient, 0, 0, seed, book);

        assertEq(core.venuePolicy(factory.venueId()), factory.creatorPolicy());
    }

    /// @dev A non-zero venue signer demands a signature per market creation. The
    ///      roll loop is automated and cannot produce one, so a venue created with
    ///      a signer is a venue that never rolls.
    function test_venueIsCreatedWithNoSignerRequirement() public {
        _bootstrap();
        assertEq(core.venueSigner(factory.venueId()), address(0));
    }

    function test_bootstrapIsOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        factory.bootstrap(feeRecipient, 0, 0, address(0), book);
    }

    function test_bootstrapCannotRunTwice() public {
        _bootstrap();
        vm.prank(owner);
        vm.expectRevert(KeelFactory.AlreadyBootstrapped.selector);
        factory.bootstrap(feeRecipient, 0, 0, address(0), book);
    }

    /// @dev The module would accept up to 1000 bps. Keel caps itself at 100 because
    ///      "these markets are cheap to trade" is not compatible with an owner who
    ///      can set a 10% taker fee.
    function test_feesAreCappedBelowTheProtocolMaximum() public {
        vm.prank(owner);
        vm.expectRevert(KeelFactory.FeeTooHigh.selector);
        factory.bootstrap(feeRecipient, 101, 0, address(0), book);

        vm.prank(owner);
        vm.expectRevert(KeelFactory.FeeTooHigh.selector);
        factory.bootstrap(feeRecipient, 0, 101, address(0), book);

        assertLt(uint256(100), module.MAX_FEE_BPS());
    }

    function test_constructorRejectsZeroProtocolAddresses() public {
        vm.expectRevert(KeelFactory.ZeroAddress.selector);
        new KeelFactory(address(0), address(module), address(mcFactory), address(hub));
        vm.expectRevert(KeelFactory.ZeroAddress.selector);
        new KeelFactory(address(core), address(0), address(mcFactory), address(hub));
        vm.expectRevert(KeelFactory.ZeroAddress.selector);
        new KeelFactory(address(core), address(module), address(0), address(hub));
        vm.expectRevert(KeelFactory.ZeroAddress.selector);
        new KeelFactory(address(core), address(module), address(mcFactory), address(0));
    }

    function test_reactivityGasParamsReachTheCreator() public {
        _bootstrap();
        vm.prank(owner);
        factory.setReactivityGasParams(1 gwei, 5 gwei, 500_000);

        MockMarketCreator c = MockMarketCreator(payable(factory.marketCreator()));
        assertEq(c.priorityFeePerGas(), 1 gwei);
        assertEq(c.maxFeePerGas(), 5 gwei);
        assertEq(c.gasLimit(), 500_000);
    }

    // -------------------------------------------------------------------------
    // Launch
    // -------------------------------------------------------------------------

    function test_anyoneCanLaunchASeries() public {
        _bootstrap();
        uint256 cost = factory.launchCost();

        vm.prank(alice);
        uint32 id = factory.launch{value: cost}("SOMI", collateral, 2, 300, 300);

        assertEq(id, 1);
        assertEq(factory.seriesCount(), 1);

        KeelFactory.SeriesInfo memory s = factory.series(id);
        assertEq(s.asset, "SOMI");
        assertEq(s.collateral, collateral);
        assertEq(s.intervalSec, 300);
        assertEq(s.launcher, alice);

        // The first market exists and the roll loop is armed.
        assertEq(MockMarketCreator(payable(factory.marketCreator())).rolls(id), 1);
    }

    function test_launchBeforeBootstrapReverts() public {
        vm.prank(alice);
        vm.expectRevert(KeelFactory.NotBootstrapped.selector);
        factory.launch{value: 1 ether}("SOMI", collateral, 2, 300, 300);
    }

    /// @dev If launching were free the first caller could drain the float and stall
    ///      every series already running, so the entry price is the point.
    function test_launchUnderpricedReverts() public {
        _bootstrap();
        uint256 cost = factory.launchCost();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(KeelFactory.InsufficientLaunchValue.selector, cost));
        factory.launch{value: cost - 1}("SOMI", collateral, 2, 300, 300);
    }

    function test_launchValueLandsInTheCreatorFloatNotHere() public {
        _bootstrap();
        uint256 cost = factory.launchCost();

        vm.prank(alice);
        factory.launch{value: cost}("SOMI", collateral, 2, 300, 300);

        // One roll already spent one full create value — both legs — and the rest
        // is runway.
        assertEq(factory.creatorFloat(), cost - (hub.reserve() + hub.schedulingCost()));
        assertEq(address(factory).balance, 0, "factory must not accumulate native");
    }

    /// @dev The runway is the reason `rollsPrefunded` is more than one: a series
    ///      that mints its first market and then starves is worse than one that
    ///      never opened.
    function test_prefundedRunwayCoversMoreThanTheFirstRoll() public {
        _bootstrap();
        uint256 cost = factory.launchCost();

        vm.prank(alice);
        uint32 id = factory.launch{value: cost}("SOMI", collateral, 2, 300, 300);

        MockMarketCreator c = MockMarketCreator(payable(factory.marketCreator()));
        // How many rolls that money actually bought, at this cadence.
        uint256 rolls = cost / (hub.reserve() + hub.schedulingCost());
        for (uint256 i = 1; i < rolls; ++i) {
            vm.prank(address(factory));
            c.triggerRoll(id);
        }
        assertEq(c.rolls(id), rolls);

        // And exactly there it starves, which is what `refuel` exists for.
        vm.prank(address(factory));
        vm.expectRevert(MockMarketCreator.Starved.selector);
        c.triggerRoll(id);
    }

    /// @dev The griefing vector a security review found: with a flat roll count, a
    ///      60-second series pays exactly what a 7-day series pays while draining the
    ///      shared float 10,080x faster, starving every honestly funded series behind
    ///      it. The quote has to scale with cadence.
    function test_fasterSeriesCostMoreToLaunch() public {
        _bootstrap();
        uint256 fast = factory.launchCostFor(60);
        uint256 medium = factory.launchCostFor(300);
        uint256 slow = factory.launchCostFor(7 days);

        assertGt(fast, medium, "a minute-cadence series must not launch at the 5-minute price");
        assertGt(medium, slow, "a 5-minute series must not launch at the weekly price");

        // And the floor still applies at the slow end: even a weekly series buys a
        // runway rather than exactly one window.
        assertEq(slow, (hub.reserve() + factory.schedulingAllowance()) * factory.rollsPrefunded());
    }

    function test_launchChargesTheCadenceItWasAskedFor() public {
        _bootstrap();
        uint256 cost = factory.launchCostFor(60);

        // Read the cheaper quote first: a view call in the same expression would
        // consume the prank before `launch` ever sees it.
        uint256 tooLittle = factory.launchCostFor(300);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(KeelFactory.InsufficientLaunchValue.selector, cost));
        factory.launch{value: tooLittle}("SOMI", collateral, 2, 60, 300);

        vm.prank(alice);
        factory.launch{value: cost}("SOMI", collateral, 2, 60, 300);
        assertEq(factory.seriesCount(), 1);
    }

    function test_launchCostTracksTheHubsLiveReserve() public {
        _bootstrap();
        uint256 before = factory.launchCost();
        hub.setReserve(0.5 ether);
        assertEq(factory.launchCost(), (0.5 ether + factory.schedulingAllowance()) * (factory.runwaySec() / 300));
        assertTrue(factory.launchCost() != before);
    }

    /// @dev The measured failure this test exists for: a launch quoted at only the
    ///      reserve leg reverts on its very first roll, because the hub charges
    ///      `getSchedulingCost(def) + resolveReserve()`. Live on Shannon the hub
    ///      asked 1.296 STT against a 0.2 reserve — quoting 0.2 bought nothing.
    function test_launchCostCoversBothLegsOfTheOraclesCreateValue() public {
        _bootstrap();
        uint256 reserveOnly = hub.reserve() * factory.rollsPrefunded();
        assertGt(factory.launchCost(), reserveOnly, "a reserve-only quote under-prices the create");

        // Paying only the reserve leg is not merely under-priced, it does not work.
        vm.deal(alice, 100 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(KeelFactory.InsufficientLaunchValue.selector, factory.launchCost()));
        factory.launch{value: reserveOnly}("SOMI", collateral, 2, 300, 300);
    }

    /// @dev A creator minted with zero reactivity gas params cannot arm its roll
    ///      loop, and reverts with no revert data — so `bootstrap` sets them.
    function test_bootstrapArmsTheCreatorsReactivityBudget() public {
        _bootstrap();
        MockMarketCreator c = MockMarketCreator(payable(factory.marketCreator()));
        assertGt(c.maxFeePerGas(), 0, "bootstrap must leave the creator able to roll");
        assertGt(c.gasLimit(), 0);

        vm.prank(alice);
        factory.launch{value: factory.launchCost()}("SOMI", collateral, 2, 300, 300);
        assertEq(c.marketCount(), 1, "the first roll fires without a separate setup call");
    }

    // -------------------------------------------------------------------------
    // Re-arming a stalled series
    // -------------------------------------------------------------------------

    /// @dev Measured on Shannon: a reactivity callback whose gas budget is too small
    ///      strands the series. The last market settles, no next one is minted, and
    ///      nothing on-chain reads as broken. `rearm` is the only way back, because
    ///      `triggerRoll` is owner-only on the creator and this contract is the owner.
    function test_rearmRestartsAStalledSeries() public {
        _bootstrap();
        vm.prank(alice);
        uint32 id = factory.launch{value: factory.launchCost()}("SOMI", collateral, 2, 300, 300);

        MockMarketCreator c = MockMarketCreator(payable(factory.marketCreator()));
        assertEq(c.rolls(id), 1);

        // Anyone may restart it — a stalled series hurts everyone holding its
        // positions, so the fix must not depend on the operator being around.
        vm.prank(bob);
        factory.rearm(id);
        assertEq(c.rolls(id), 2, "rearm must mint the next window");
    }

    function test_rearmRejectsAnUnknownSeries() public {
        _bootstrap();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(KeelFactory.UnknownSeries.selector, uint32(7)));
        factory.rearm(7);
    }

    function test_rearmBeforeBootstrapReverts() public {
        vm.expectRevert(KeelFactory.NotBootstrapped.selector);
        factory.rearm(1);
    }

    /// @dev `rearm` spends the creator's float, never the caller's, and the caller
    ///      cannot use it to pull value out.
    function test_rearmCostsTheFloatNotTheCaller() public {
        _bootstrap();
        vm.prank(alice);
        uint32 id = factory.launch{value: factory.launchCost()}("SOMI", collateral, 2, 300, 300);

        uint256 floatBefore = factory.creatorFloat();
        uint256 callerBefore = bob.balance;
        vm.prank(bob);
        factory.rearm(id);

        assertEq(bob.balance, callerBefore, "rearm must not pay the caller");
        assertLt(factory.creatorFloat(), floatBefore, "the roll is paid out of the float");
    }

    /// @dev The gas budget is the setting that stranded the live series. A roll mints
    ///      a market and schedules its oracle question — 64,387,607 gas measured on
    ///      Shannon — so a default anywhere near the old 3,000,000 silently stops the
    ///      loop after one window.
    function test_bootstrapGivesTheRollLoopEnoughGasToActuallyRoll() public {
        _bootstrap();
        MockMarketCreator c = MockMarketCreator(payable(factory.marketCreator()));
        assertGe(c.gasLimit(), 64_387_607, "a roll costs more gas than this budget allows");
    }

    function test_onlyOwnerCanRepriceTheSchedulingLeg() public {
        _bootstrap();
        vm.prank(alice);
        vm.expectRevert();
        factory.setSchedulingAllowance(2 ether);

        vm.prank(owner);
        factory.setSchedulingAllowance(2 ether);
        assertEq(factory.schedulingAllowance(), 2 ether);
        assertEq(factory.launchCost(), (hub.reserve() + 2 ether) * (factory.runwaySec() / 300));
    }

    // -------------------------------------------------------------------------
    // The duplicate guard and the id space
    // -------------------------------------------------------------------------

    /// @dev Keel's premise is covering assets nobody covers. A second identical
    ///      series burns reserve to split its own book in half.
    function test_duplicateSeriesIsRejectedAndNamesTheIncumbent() public {
        _bootstrap();
        uint256 cost = factory.launchCost();

        vm.prank(alice);
        uint32 id = factory.launch{value: cost}("SOMI", collateral, 2, 300, 300);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(KeelFactory.AlreadyLaunched.selector, id));
        factory.launch{value: cost}("SOMI", collateral, 2, 300, 300);
    }

    function test_sameAssetAtADifferentCadenceIsADifferentSeries() public {
        _bootstrap();
        uint256 cost = factory.launchCost();

        vm.prank(alice);
        uint32 a = factory.launch{value: cost}("SOMI", collateral, 2, 300, 300);
        vm.prank(bob);
        uint32 b = factory.launch{value: cost}("SOMI", collateral, 2, 900, 300);

        assertTrue(a != b);
        assertEq(factory.seriesCount(), 2);
    }

    /// @dev `registerSeries` upserts and resets the series' oracle reference, so an
    ///      id a caller could name is a switch that silently kills a running series.
    ///      Ids are allocated here, monotonically, and never handed out twice.
    function test_seriesIdsAreAllocatedMonotonicallyAndNeverReused() public {
        _bootstrap();
        uint256 cost = factory.launchCost();
        MockMarketCreator c = MockMarketCreator(payable(factory.marketCreator()));

        string[3] memory assets = ["SOMI", "SOL", "ARB"];
        for (uint256 i; i < 3; ++i) {
            vm.prank(alice);
            uint32 id = factory.launch{value: cost}(assets[i], collateral, 2, 300, 300);
            assertEq(id, uint32(i + 1));
            assertEq(c.registrations(id), 1, "an id must be registered exactly once");
        }
        assertEq(factory.seriesCount(), 3);
        assertEq(factory.seriesAt(2).asset, "ARB");
    }

    // -------------------------------------------------------------------------
    // Input validation — every one of these is a silent failure made loud
    // -------------------------------------------------------------------------

    function test_intervalBelowTheModuleMinimumReverts() public {
        _bootstrap();
        uint256 cost = factory.launchCost();
        vm.prank(alice);
        vm.expectRevert(KeelFactory.IntervalOutOfRange.selector);
        factory.launch{value: cost}("SOMI", collateral, 2, 59, 300);
    }

    function test_absurdlySlowIntervalReverts() public {
        _bootstrap();
        uint256 cost = factory.launchCost();
        vm.prank(alice);
        vm.expectRevert(KeelFactory.IntervalOutOfRange.selector);
        factory.launch{value: cost}("SOMI", collateral, 2, 8 days, 300);
    }

    function test_shortSettlementWindowReverts() public {
        _bootstrap();
        uint256 cost = factory.launchCost();
        vm.prank(alice);
        vm.expectRevert(KeelFactory.SettlementWindowTooShort.selector);
        factory.launch{value: cost}("SOMI", collateral, 2, 300, 59);
    }

    function test_zeroCollateralReverts() public {
        _bootstrap();
        uint256 cost = factory.launchCost();
        vm.prank(alice);
        vm.expectRevert(KeelFactory.ZeroAddress.selector);
        factory.launch{value: cost}("SOMI", address(0), 2, 300, 300);
    }

    /// @dev The asset doubles as the base symbol the oracle's candle sources look
    ///      up. A pair, a lowercase ticker or an empty string registers cleanly and
    ///      then never resolves — the series mints windows and settles none of them.
    function test_malformedTickersAreRejectedRatherThanSilentlyNeverResolving() public {
        _bootstrap();
        uint256 cost = factory.launchCost();

        string[5] memory bad = ["", "btc", "BTC/USDC", "BTC-PERP", "TOOLONGTICKERNAME"];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(KeelFactory.InvalidAsset.selector);
            factory.launch{value: cost}(bad[i], collateral, 2, 300, 300);
        }
    }

    function testFuzz_onlyUppercaseAlphanumericTickersAreAccepted(bytes1 c) public {
        _bootstrap();
        uint256 cost = factory.launchCost();

        bool ok = (uint8(c) >= 0x41 && uint8(c) <= 0x5A) || (uint8(c) >= 0x30 && uint8(c) <= 0x39);
        string memory asset = string(abi.encodePacked(c));

        vm.prank(alice);
        if (!ok) vm.expectRevert(KeelFactory.InvalidAsset.selector);
        factory.launch{value: cost}(asset, collateral, 2, 300, 300);
    }

    // -------------------------------------------------------------------------
    // Float: nobody can take it out
    // -------------------------------------------------------------------------

    /// @dev Launchers fund the creator, so the float is theirs in every sense that
    ///      matters. There is no owner path that moves it anywhere.
    function test_ownerCannotDrainTheCreatorFloat() public {
        _bootstrap();
        uint256 cost = factory.launchCost();
        vm.prank(alice);
        factory.launch{value: cost}("SOMI", collateral, 2, 300, 300);

        uint256 float_ = factory.creatorFloat();
        uint256 ownerBefore = owner.balance;

        // Nothing on the factory forwards native to the caller. The only native
        // movement it can cause is into the creator.
        vm.prank(owner);
        (bool sent,) = address(factory).call{value: 1 ether}("");
        assertTrue(sent);

        assertEq(factory.creatorFloat(), float_ + 1 ether);
        assertEq(owner.balance, ownerBefore - 1 ether);
        assertEq(address(factory).balance, 0);
    }

    function test_refuelIsPermissionless() public {
        _bootstrap();
        uint256 float_ = factory.creatorFloat();

        vm.prank(bob);
        factory.refuel{value: 3 ether}();

        assertEq(factory.creatorFloat(), float_ + 3 ether);
    }

    function test_plainTransferRefuels() public {
        _bootstrap();
        uint256 float_ = factory.creatorFloat();

        vm.prank(bob);
        (bool ok,) = address(factory).call{value: 2 ether}("");
        assertTrue(ok);

        assertEq(factory.creatorFloat(), float_ + 2 ether);
    }

    function test_reclaimOracleCreditReturnsSurplusToTheFloat() public {
        _bootstrap();
        uint256 cost = factory.launchCost();
        vm.prank(alice);
        factory.launch{value: cost}("SOMI", collateral, 2, 300, 300);

        vm.prank(bob);
        uint256 reclaimed = factory.reclaimOracleCredit();
        assertGt(reclaimed, 0, "a resolved market refunds its unspent reserve");
    }

    function test_setRollsPrefundedMovesTheEntryPrice() public {
        _bootstrap();
        vm.prank(owner);
        factory.setRollsPrefunded(10);
        // The floor rises above the cadence-derived count, so it governs.
        // 10 is now a floor, not the count — a 300s cadence over the default hour
        // of runway needs 12, and the larger of the two governs.
        assertEq(factory.launchCost(), (hub.reserve() + factory.schedulingAllowance()) * 12);

        vm.prank(owner);
        vm.expectRevert(KeelFactory.IntervalOutOfRange.selector);
        factory.setRollsPrefunded(0);
    }
}
