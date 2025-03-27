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

/// @title  IRoyaltiesProvider
/// @author Energi Core
/// @notice Interface to intreact with royalties registry contract
/// @dev    Fetch royalties details

pragma solidity 0.8.27;
pragma abicoder v2;

import { LibPartTypes } from '../libraries/LibPartTypes.sol';

interface IRoyaltiesProviders {
    // used for Rarible Royalties and other providers that implement the same function signature
    // compare: https://github.com/rarible/protocol-contracts/blob/master/royalties-registry/contracts/RoyaltiesRegistry.sol#L148-L195
    function getRoyalties(address token, uint256 tokenId) external view returns (LibPartTypes.Part96[] memory);

    // used for LooksRare and other providers that implement the same function signature
    // compare: https://github.com/LooksRare/contracts-exchange-v1/blob/master/contracts/royaltyFeeHelpers/RoyaltyFeeRegistry.sol#L83-L98
    function royaltyFeeInfoCollection(address collection) external view returns (LibPartTypes.FeeInfo memory);
}
