// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgenticScore} from "../AgenticScore.sol";

/// @dev Test only. Stands in for a smart-contract wallet that has no onERC721Received.
contract ContractWallet {
    /// @dev Forwards the mint fee with the call, the way an agent's wallet would.
    function mintFrom(AgenticScore nft, uint256 score, uint256 deadline, bytes calldata signature)
        external
        payable
    {
        nft.mint{value: msg.value}(score, deadline, signature);
    }
}
