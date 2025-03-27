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

/// @title  IRoyaltiesRegistryStorage
/// @author Energi Core
/// @notice Interface for RoyaltyRegistryStorage contract
/// @dev    External functions defination of royalties registry storage contract

pragma solidity 0.8.27;
pragma abicoder v2;

import { LibPartTypes } from '../libraries/LibPartTypes.sol';
import { LibRoyaltiesV2 } from '../libraries/LibRoyaltiesV2.sol';

interface IRoyaltiesRegistryStorage {
    function getOwnerRoyaltiesByTokenAndTokenId(
        address token,
        uint256 tokenId
    ) external view returns (LibRoyaltiesV2.RoyaltiesSet memory);

    function initializeOwnerRoyaltiesByTokenAndTokenId(address token, uint256 tokenId) external;

    function pushOwnerRoyaltyByTokenAndTokenId(
        address token,
        uint256 tokenId,
        LibPartTypes.Part memory royalty
    ) external;

    function deleteOwnerRoyaltiesByTokenAndTokenId(address token, uint256 tokenId) external;

    function getCreatorRoyaltiesByTokenAndTokenId(
        address token,
        uint256 tokenId
    ) external view returns (LibRoyaltiesV2.RoyaltiesSet memory);

    function initializeCreatorRoyaltiesByTokenAndTokenId(address token, uint256 tokenId) external;

    function pushCreatorRoyaltyByTokenAndTokenId(
        address token,
        uint256 tokenId,
        LibPartTypes.Part memory royalty
    ) external;

    function deleteCreatorRoyaltiesByTokenAndTokenId(address token, uint256 tokenId) external;

    function getRoyaltiesByToken(address token) external view returns (LibRoyaltiesV2.RoyaltiesSet memory);

    function initializeRoyaltiesByToken(address token) external;

    function pushRoyaltyByToken(address token, LibPartTypes.Part memory royalty) external;

    function deleteRoyaltiesByToken(address token) external;

    function getProviderByToken(address token) external view returns (address);

    function setProviderByToken(address token, address provider) external;
}
