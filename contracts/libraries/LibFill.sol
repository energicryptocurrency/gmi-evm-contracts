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

/// @title  LibFill
/// @author Energi Core
/// @notice Fill orders
/// @dev    Fill orders according to the trade

pragma solidity 0.8.27;

import { LibOrder } from './LibOrder.sol';
import { LibOrderTypes } from './LibOrderTypes.sol';
import { LibFillTypes } from './LibFillTypes.sol';
import { LibMath } from './LibMath.sol';
import { SafeMath } from './SafeMath.sol';

library LibFill {
    using SafeMath for uint256;

    function fillOrder(
        LibOrderTypes.Order memory leftOrder,
        LibOrderTypes.Order memory rightOrder,
        uint256 leftOrderTakeAssetFill,
        uint256 rightOrderTakeAssetFill
    ) internal pure returns (LibFillTypes.FillResult memory) {
        // Calculate orders' remaining make and take values based on current fill
        (uint256 leftMakeValue, uint256 leftTakeValue) = LibOrder.calculateRemaining(leftOrder, leftOrderTakeAssetFill);
        (uint256 rightMakeValue, uint256 rightTakeValue) = LibOrder.calculateRemaining(
            rightOrder,
            rightOrderTakeAssetFill
        );

        //We have 3 cases here:
        if (rightTakeValue > leftMakeValue) {
            // 1st case: left order will end up fully filled
            return fillLeft(leftMakeValue, leftTakeValue, rightOrder.makeAsset.value, rightOrder.takeAsset.value);
        }
        // 2nd case: right order will end up fully filled
        // 3rd case: both orders will end up fully filled
        return fillRight(leftOrder.makeAsset.value, leftOrder.takeAsset.value, rightMakeValue, rightTakeValue);
    }

    function fillRight(
        uint256 leftMakeValue,
        uint256 leftTakeValue,
        uint256 rightMakeValue,
        uint256 rightTakeValue
    ) internal pure returns (LibFillTypes.FillResult memory result) {
        // In this case we have rightTakeValue <= leftMakeValue
        // We know that right order will be fully filled
        // We calculate the corresponding left order's take value (amount that taker will receive):
        //
        // leftTake = rightTakeValue * (leftTakeValue / leftMakeValue)
        //
        uint256 leftTake = LibMath.safeGetPartialAmountFloor(rightTakeValue, leftMakeValue, leftTakeValue);
        // And we make sure that left order's take value is not larger than right order's make value
        require(leftTake <= rightMakeValue, 'LibFill: fillRight unable to fill');
        // Return fill result
        //
        // rightTake is returned unchanged (maker will receive the take amount specified in maker order)
        //
        // leftTake is less than initially specified by taker, and less than, or equal to rightMake (maker will pay no
        // more than the make amount specified in maker order)
        //
        // WARNING: with this logic it is possible for taker to receive less than expected if the initial ratio
        // leftTakeValue/leftMakeValue is less than the ratio rightMakeValue/rightTakeValue !
        //
        return LibFillTypes.FillResult(rightTakeValue, leftTake);
    }

    function fillLeft(
        uint256 leftMakeValue,
        uint256 leftTakeValue,
        uint256 rightMakeValue,
        uint256 rightTakeValue
    ) internal pure returns (LibFillTypes.FillResult memory result) {
        // In this case we have rightTakeValue > leftMakeValue
        // We know that left order will be fully filled
        // We calculate the corresponding right order's take value (amount that maker will receive):
        //
        // rightTake = leftTakeValue * (rightTakeValue / rightMakeValue)
        //
        uint256 rightTake = LibMath.safeGetPartialAmountFloor(leftTakeValue, rightMakeValue, rightTakeValue);
        // And wake sure that right order's take value is not larger than left order's make value
        require(rightTake <= leftMakeValue, 'LibFill: fillLeft unable to fill');
        // Return fill result
        //
        // leftTake is returned unchanged (taker will receive the take amount specified in taker order)
        //
        // rightTake is deducted from leftTake and the initial ratio (rightTakeValue / rightMakeValue) specified by
        // maker, and cannot be larger than leftMake
        //
        return LibFillTypes.FillResult(rightTake, leftTakeValue);
    }

    function fillCollectionBidOrder(
        LibOrderTypes.Order[] memory orders, // Collection-wide buy order at index 0 followed by matching taker orders
        uint256[] memory ordersFills // Collection-wide buy order fill at index 0 followed by taker orders fills
    )
        internal
        pure
        returns (
            uint256 newCollectionBidOrderFill,
            uint256[] memory remainingMakeValues,
            uint256[] memory remainingTakeValues
        )
    {
        remainingMakeValues = new uint256[](orders.length);
        remainingTakeValues = new uint256[](orders.length);
        // Calculate collectionBidOrder's remaining take values based on current fill
        (uint256 remainingCollectionBidOrderMakeValue, uint256 remainingCollectionBidOrderTakeValue) = LibOrder
            .calculateRemaining(orders[0], ordersFills[0]);
        remainingMakeValues[0] = remainingCollectionBidOrderMakeValue;
        remainingTakeValues[0] = remainingCollectionBidOrderTakeValue;
        // Calculate taker orders aggregated remaining make and take values based on current fills
        uint256 sumRemainingTakerOrdersMakeValue;
        for (uint256 i = 1; i < orders.length; i += 1) {
            (uint256 remainingMakeValue, uint256 remainingTakeValue) = LibOrder.calculateRemaining(
                orders[i],
                ordersFills[i]
            );
            sumRemainingTakerOrdersMakeValue += remainingMakeValue;
            remainingMakeValues[i] = remainingMakeValue;
            remainingTakeValues[i] = remainingTakeValue;
        }
        //We have 2 cases here:
        if (remainingCollectionBidOrderTakeValue > sumRemainingTakerOrdersMakeValue) {
            // 1st case: collection-bid order will end up partially filled
            newCollectionBidOrderFill = sumRemainingTakerOrdersMakeValue;
        }
        // 2nd case: collection-bid order will end up fully filled
        newCollectionBidOrderFill = remainingCollectionBidOrderTakeValue;
    }
}
