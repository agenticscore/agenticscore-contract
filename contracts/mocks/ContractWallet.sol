// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgenticScore} from "../AgenticScore.sol";

/// @dev Test only. Stands in for a smart-contract wallet that has no onERC721Received.
contract ContractWallet {
    function mintFrom(AgenticScore nft, uint256 score, uint256 deadline, bytes calldata signature) external {
        nft.mint(score, deadline, signature);
    }
}
