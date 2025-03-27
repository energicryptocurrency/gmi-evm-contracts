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

/// @title  LibFeeSide
/// @author Energi Core
/// @notice Defines if maker or taker pays the fee for trade
/// @dev    Returns fee payer and asset in which fee will be paid in

pragma solidity 0.8.27;

import { LibFeeSideTypes } from './LibFeeSideTypes.sol';
import { LibAssetClasses } from './LibAssetClasses.sol';

library LibFeeSide {
    function getFeeSide(
        bytes4 makerAssetClass, // Asset class expected to be received by maker
        bytes4 takerAssetClass // Asset class expected to be received by taker
    ) internal pure returns (LibFeeSideTypes.FeeSide) {
        // Determine fee side
        // The fee side corresponds to which side of the trade (order maker or taker) is paying the trading fee
        //
        // The fee asset is the asset in which fees and royalties are paid. It is determined in the following order:
        // 1) ETH
        // 2) WETH
        // 3) ERC20 asset
        // 4) ERC1155 asset
        // 5) none
        if (makerAssetClass == LibAssetClasses.ETH_ASSET_CLASS) {
            return LibFeeSideTypes.FeeSide.TAKE;
        }
        if (takerAssetClass == LibAssetClasses.ETH_ASSET_CLASS) {
            return LibFeeSideTypes.FeeSide.MAKE;
        }
        if (
            makerAssetClass == LibAssetClasses.WETH_ASSET_CLASS ||
            makerAssetClass == LibAssetClasses.PROXY_WETH_ASSET_CLASS
        ) {
            return LibFeeSideTypes.FeeSide.TAKE;
        }
        if (
            takerAssetClass == LibAssetClasses.WETH_ASSET_CLASS ||
            takerAssetClass == LibAssetClasses.PROXY_WETH_ASSET_CLASS
        ) {
            return LibFeeSideTypes.FeeSide.MAKE;
        }
        if (makerAssetClass == LibAssetClasses.ERC20_ASSET_CLASS) {
            return LibFeeSideTypes.FeeSide.TAKE;
        }
        if (takerAssetClass == LibAssetClasses.ERC20_ASSET_CLASS) {
            return LibFeeSideTypes.FeeSide.MAKE;
        }
        if (makerAssetClass == LibAssetClasses.ERC1155_ASSET_CLASS) {
            return LibFeeSideTypes.FeeSide.TAKE;
        }
        if (takerAssetClass == LibAssetClasses.ERC1155_ASSET_CLASS) {
            return LibFeeSideTypes.FeeSide.MAKE;
        }
        return LibFeeSideTypes.FeeSide.NONE;
    }
}
