// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgenticScore} from "../AgenticScore.sol";

/// @dev Test only. Lets the supply-cap test jump to the end without 3,000 mints. Never deploy this.
contract AgenticScoreHarness is AgenticScore {
    constructor(address initialOwner, address initialSigner, string memory metadataURI_)
        AgenticScore(initialOwner, initialSigner, metadataURI_)
    {}

    function setTotalMintedForTest(uint256 n) external {
        _totalMinted = n;
    }
}
