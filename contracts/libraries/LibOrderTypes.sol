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

/// @title  LibOrderTypes
/// @author Energi Core
/// @notice Defines types of order
/// @dev    Contains struct for orders, i.e Order and BatchBidOrders

pragma solidity 0.8.27;

import { LibAssetTypes } from './LibAssetTypes.sol';

library LibOrderTypes {
    struct Order {
        address maker;
        LibAssetTypes.Asset makeAsset;
        address taker;
        LibAssetTypes.Asset takeAsset;
        uint256 salt;
        uint256 start;
        uint256 end;
        bytes4 dataType;
        bytes data;
        bool collectionBid;
    }

    struct BatchBidOders {
        Order[] orders;
        bytes[] signatures;
        uint256[] matchBeforeTimestamps;
        bytes[] orderBookSignatures;
    }
}
