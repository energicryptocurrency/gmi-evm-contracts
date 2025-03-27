// Copyright 2024 Energi Core

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// Energi Governance system is the fundamental part of Energi Core.

// NOTE: It's not allowed to change the compiler due to byte-to-byte
//       match requirement.

/// @title  IRoyaltiesRegistry
/// @author Energi Core
/// @notice Interface for RoyaltyRegistry contract
/// @dev    External functions defination of royalties registry contract

pragma solidity 0.8.27;
pragma abicoder v2;

import { LibPartTypes } from '../libraries/LibPartTypes.sol';

interface IRoyaltiesRegistry {
    // Royalties setters
    function setProviderByToken(address token, address provider) external;

    function setRoyaltiesByToken(address token, LibPartTypes.Part[] memory royalties) external;

    function setOwnerRoyaltiesByTokenAndTokenId(
        address token,
        uint256 tokenId,
        LibPartTypes.Part[] memory royalties
    ) external;

    function setCreatorRoyaltiesByTokenAndTokenId(
        address token,
        uint256 tokenId,
        LibPartTypes.Part[] memory royalties
    ) external;

    // Provider getter
    function getProviderByToken(address token) external view returns (address);

    // Royalties getter
    function getRoyalties(address token, uint256 tokenId) external view returns (LibPartTypes.Part[] memory);
}
