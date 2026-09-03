// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SpreadPolicy} from "../../src/lib/SpreadPolicy.sol";

/// @notice Exposes SpreadPolicy's internal functions across a real call boundary.
/// @dev `vm.expectRevert` only observes reverts at a lower call depth than the
///      cheatcode itself. A library's internal functions are inlined into the
///      caller, so a revert inside one is indistinguishable from a revert in the
///      test body and the cheatcode cannot catch it. This harness gives the
///      library an external surface purely so the revert paths are testable.
contract SpreadPolicyHarness {
    function validate(SpreadPolicy.Config memory cfg) external pure {
        SpreadPolicy.validate(cfg);
    }

    function quote(
        SpreadPolicy.Config memory cfg,
        uint256 fairValueUp,
        uint256 tauSeconds,
        uint256 upSkewWad,
        uint256 downSkewWad
    ) external pure returns (uint256, uint256) {
        return SpreadPolicy.quote(cfg, fairValueUp, tauSeconds, upSkewWad, downSkewWad);
    }

    function assertSolvent(SpreadPolicy.Config memory cfg, uint256 askUp, uint256 askDown) external pure {
        SpreadPolicy.assertSolvent(cfg, askUp, askDown);
    }
}
