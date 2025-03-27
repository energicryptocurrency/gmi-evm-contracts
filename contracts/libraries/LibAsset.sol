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

/// @title  LibAsset
/// @author Energi Core
/// @notice Contains hashing logic for asset types
/// @dev    Encode asset type to hash

pragma solidity 0.8.27;

import { LibAssetTypes } from './LibAssetTypes.sol';

library LibAsset {
    bytes32 constant ASSET_TYPE_TYPEHASH = keccak256('AssetType(bytes4 assetClass,bytes data)');

    bytes32 constant ASSET_TYPEHASH =
        keccak256('Asset(AssetType assetType,uint256 value)AssetType(bytes4 assetClass,bytes data)');

    function hash(LibAssetTypes.AssetType memory assetType) internal pure returns (bytes32) {
        return keccak256(abi.encode(ASSET_TYPE_TYPEHASH, assetType.assetClass, keccak256(assetType.data)));
    }

    function hash(LibAssetTypes.Asset memory asset) internal pure returns (bytes32) {
        return keccak256(abi.encode(ASSET_TYPEHASH, hash(asset.assetType), asset.value));
    }
}
