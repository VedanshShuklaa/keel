// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    IMarketsCore,
    IBinaryVenueFees,
    IMarketCreatorFactory,
    IMarketCreator
} from "../../src/interfaces/IMarketsControl.sol";

/// @notice Stand-ins for Somnia's operator/venue control plane. They model the
///         behaviour KeelFactory actually depends on — the allowlist gate, the
///         per-roll native charge, and the upsert semantics of `registerSeries` —
///         and nothing else. `triggerRoll` on the real creator calls the Somnia
///         reactivity precompile and therefore cannot run under Foundry at all,
///         which is precisely why it is mocked here.
contract MockMarketsCore is IMarketsCore {
    uint32 public nextOperatorId = 1;
    mapping(uint32 => address) public operatorOwner;
    mapping(bytes32 => VenueConfig) internal _venues;
    mapping(bytes32 => uint32) public venueOperator;
    uint256 public venueCount;

    function registerOperator(address, bool, address, bytes calldata) external returns (uint32 id) {
        id = nextOperatorId++;
        operatorOwner[id] = msg.sender;
    }

    function createVenue(uint32 operatorId, bytes4 marketType, VenueConfig calldata config)
        external
        returns (bytes32 id)
    {
        require(operatorOwner[operatorId] == msg.sender, "not operator owner");
        id = keccak256(abi.encode(operatorId, marketType, venueCount++));
        _venues[id] = config;
        venueOperator[id] = operatorId;
    }

    function updateVenue(uint32 operatorId, bytes32 id, VenueConfig calldata config) external {
        require(operatorOwner[operatorId] == msg.sender, "not operator owner");
        require(venueOperator[id] == operatorId, "wrong venue");
        _venues[id] = config;
    }

    function venuePolicy(bytes32 id) external view returns (address) {
        return _venues[id].policy;
    }

    function venueSigner(bytes32 id) external view returns (address) {
        return _venues[id].signer;
    }

    function venueFeeParams(bytes32 id) external view returns (bytes memory) {
        return _venues[id].feeParams;
    }
}

contract MockBinaryModule is IBinaryVenueFees {
    function encodeVenueFeeParams(VenueFeeParams calldata vp) external pure returns (bytes memory) {
        return abi.encode(uint8(3), vp);
    }

    function MAX_FEE_BPS() external pure returns (uint256) {
        return 1000;
    }
}

contract MockOracleHub {
    uint256 public reserve = 0.2 ether;

    function resolveReserve() external view returns (uint256) {
        return reserve;
    }

    /// @dev The other leg of the create value. The live hub quotes this from a
    ///      question definition; here it is just a number a test can move.
    uint256 public schedulingCost = 1.3 ether;

    function setSchedulingCost(uint256 c) external {
        schedulingCost = c;
    }

    function setReserve(uint256 r) external {
        reserve = r;
    }

    receive() external payable {}
}

contract MockCreatorPolicy {
    address public owner;
    mapping(address => bool) public approved;

    constructor(address owner_) {
        owner = owner_;
    }

    function setCreator(address creator, bool allowed) external {
        require(msg.sender == owner, "not policy owner");
        approved[creator] = allowed;
    }
}

contract MockMarketCreator is IMarketCreator {
    address public owner;
    MockOracleHub public hub;
    MockCreatorPolicy public policy;

    mapping(uint32 => Series) internal _series;
    mapping(uint32 => uint256) public rolls;
    /// @dev Counts overwrites, so a test can prove an id is never re-registered.
    mapping(uint32 => uint256) public registrations;
    uint256 public marketCount;
    uint256 public credit;

    uint64 public priorityFeePerGas;
    uint64 public maxFeePerGas;
    uint64 public gasLimit;

    error Starved();
    error NoReactivityBudget();

    constructor(address owner_, address hub_, address policy_) {
        owner = owner_;
        hub = MockOracleHub(payable(hub_));
        policy = MockCreatorPolicy(policy_);
    }

    receive() external payable {}

    function registerSeries(uint32 seriesId, Series calldata s) external {
        require(msg.sender == owner, "not creator owner");
        _series[seriesId] = s;
        registrations[seriesId] += 1;
    }

    function triggerRoll(uint32 seriesId) external {
        require(msg.sender == owner, "not creator owner");
        require(bytes(_series[seriesId].asset).length != 0, "series unknown");
        // The venue consults the allowlist on every create, not just the first.
        require(policy.approved(address(this)), "creator not approved");
        // A creator with no reactivity gas budget cannot arm its roll loop. The
        // live contract reverts here with *no revert data at all*, which is what
        // made the real failure hard to read; the mock names it instead.
        if (maxFeePerGas == 0 || gasLimit == 0) revert NoReactivityBudget();
        // Both legs of the oracle's per-create value, as the live hub charges them:
        // getSchedulingCost(def) + resolveReserve().
        uint256 due = hub.resolveReserve() + hub.schedulingCost();
        if (address(this).balance < due) revert Starved();
        (bool ok,) = address(hub).call{value: due}("");
        require(ok, "create value transfer failed");
        credit += hub.resolveReserve() / 10; // surplus refunded at resolution
        rolls[seriesId] += 1;
        marketCount += 1;
    }

    function armFirstRoll(uint32, uint256) external view {
        require(msg.sender == owner, "not creator owner");
    }

    function setReactivityGasParams(uint64 p, uint64 m, uint64 g) external {
        require(msg.sender == owner, "not creator owner");
        (priorityFeePerGas, maxFeePerGas, gasLimit) = (p, m, g);
    }

    function reclaimOracleCredit() external returns (uint256 reclaimed) {
        reclaimed = credit;
        credit = 0;
    }

    function latestExpiryBySeriesId(uint32) external pure returns (uint64) {
        return 0;
    }

    function seriesById(uint32 seriesId) external view returns (Series memory) {
        return _series[seriesId];
    }
}

contract MockMarketCreatorFactory is IMarketCreatorFactory {
    address public immutable hub;
    address public lastCreator;
    address public lastPolicy;

    constructor(address hub_) {
        hub = hub_;
    }

    function createMarketCreator(
        address owner,
        address,
        address,
        uint32,
        bytes32,
        BookParams calldata
    ) external returns (address creator, address policyOut) {
        MockCreatorPolicy p = new MockCreatorPolicy(owner);
        MockMarketCreator c = new MockMarketCreator(owner, hub, address(p));
        (lastCreator, lastPolicy) = (address(c), address(p));
        return (address(c), address(p));
    }
}
