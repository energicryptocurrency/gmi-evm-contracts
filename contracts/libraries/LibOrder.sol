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

/// @title  LibOrder
/// @author Energi Core
/// @notice Calculates values related to order
/// @dev    Functions to calculate, validate and verify order data

pragma solidity 0.8.27;

import { LibOrderTypes } from './LibOrderTypes.sol';
import { LibMath } from './LibMath.sol';
import { LibAsset } from './LibAsset.sol';
import { LibAssetTypes } from './LibAssetTypes.sol';
import { LibAssetClasses } from './LibAssetClasses.sol';
import { SafeMath } from './SafeMath.sol';

library LibOrder {
    using SafeMath for uint256;

    bytes32 constant ORDER_TYPEHASH =
        keccak256(
            'Order(address maker,Asset makeAsset,address taker,Asset takeAsset,uint256 salt,uint256 start,uint256 end,bytes4 dataType,bytes data,bool collectionBid)Asset(AssetType assetType,uint256 value)AssetType(bytes4 assetClass,bytes data)'
        );

    bytes32 constant MATCH_ALLOWANCE_TYPEHASH =
        keccak256('MatchAllowance(bytes32 orderKeyHash,uint256 matchBeforeTimestamp)');

    function calculateRemaining(
        LibOrderTypes.Order memory order,
        uint256 takeAssetFill
    ) internal pure returns (uint256 makeValue, uint256 takeValue) {
        // ensure that the order was not previously cancelled (takeAssetFill set to UINT256_MAX)
        require(takeAssetFill < 2 ** 256 - 1, 'LibOrder: Order was previously cancelled');
        // Calculate remaining takeAsset value as:
        // takeValue = takeAsset.value - fill
        takeValue = order.takeAsset.value.sub(takeAssetFill);
        // Calculate corresponding makeAsset value as:
        // makeValue = makeAsset.value * (takeValue / takeAsset.value)
        makeValue = LibMath.safeGetPartialAmountFloor(order.makeAsset.value, order.takeAsset.value, takeValue);
    }

    function hashKey(LibOrderTypes.Order memory order) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    order.maker,
                    LibAsset.hash(order.makeAsset.assetType),
                    LibAsset.hash(order.takeAsset.assetType),
                    order.salt,
                    order.collectionBid
                )
            );
    }

    function hash(LibOrderTypes.Order memory order) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH,
                    order.maker,
                    LibAsset.hash(order.makeAsset),
                    order.taker,
                    LibAsset.hash(order.takeAsset),
                    order.salt,
                    order.start,
                    order.end,
                    order.dataType,
                    keccak256(order.data),
                    order.collectionBid
                )
            );
    }

    function hash(bytes32 orderKeyHash, uint256 matchBeforeTimestamp) internal pure returns (bytes32) {
        return keccak256(abi.encode(MATCH_ALLOWANCE_TYPEHASH, orderKeyHash, matchBeforeTimestamp));
    }

    function validate(LibOrderTypes.Order memory order) internal view {
        // Check order start and end blocks
        require(order.start == 0 || order.start < block.timestamp, 'LibOrder: Order start timestamp validation failed');
        require(order.end == 0 || order.end > block.timestamp, 'LibOrder: Order end timestamp validation failed');
        // Check order assets types
        // We only allow trading of ETH and some select ERC20 tokens for ERC721 and ERC1155 assets
        if (
            order.makeAsset.assetType.assetClass == LibAssetClasses.ETH_ASSET_CLASS ||
            order.makeAsset.assetType.assetClass == LibAssetClasses.WETH_ASSET_CLASS ||
            order.makeAsset.assetType.assetClass == LibAssetClasses.ERC20_ASSET_CLASS
        ) {
            require(
                order.takeAsset.assetType.assetClass == LibAssetClasses.ERC721_ASSET_CLASS ||
                    order.takeAsset.assetType.assetClass == LibAssetClasses.ERC1155_ASSET_CLASS,
                'LibOrder: Asset types mismatch - makeAsset is fungible, therefore takeAsset must be non-fungible'
            );
        }
        if (
            order.takeAsset.assetType.assetClass == LibAssetClasses.ETH_ASSET_CLASS ||
            order.takeAsset.assetType.assetClass == LibAssetClasses.WETH_ASSET_CLASS ||
            order.takeAsset.assetType.assetClass == LibAssetClasses.ERC20_ASSET_CLASS
        ) {
            require(
                order.makeAsset.assetType.assetClass == LibAssetClasses.ERC721_ASSET_CLASS ||
                    order.makeAsset.assetType.assetClass == LibAssetClasses.ERC1155_ASSET_CLASS,
                'LibOrder: Asset types mismatch - takeAsset is fungible, therefore makeAsset must be non-fungible'
            );
        }
        // We disallow trading of ERC721(or ERC1155) for ERC721(or ERC1155)
        if (
            order.makeAsset.assetType.assetClass == LibAssetClasses.ERC721_ASSET_CLASS ||
            order.makeAsset.assetType.assetClass == LibAssetClasses.ERC1155_ASSET_CLASS
        ) {
            require(
                order.takeAsset.assetType.assetClass != LibAssetClasses.ERC721_ASSET_CLASS &&
                    order.takeAsset.assetType.assetClass != LibAssetClasses.ERC1155_ASSET_CLASS,
                'LibOrder: Asset types mismatch - makeAsset is non-fungible, therefore takeAsset must be fungible'
            );
        }
    }

    function validateCollectionBidMakerOrder(LibOrderTypes.Order memory collectionBidMakerOrder) internal pure {
        require(collectionBidMakerOrder.collectionBid, 'LibOrder: not a collection bid order');
        require(collectionBidMakerOrder.salt > 0, 'LibOrder: collection bid order salt should not be 0');
        // Verify collectionBid order makeAsset and takeAsset classes
        require(
            collectionBidMakerOrder.makeAsset.assetType.assetClass == LibAssetClasses.WETH_ASSET_CLASS ||
                collectionBidMakerOrder.makeAsset.assetType.assetClass == LibAssetClasses.ERC20_ASSET_CLASS,
            'LibOrder: invalid collection bid order make asset class'
        );
        require(
            collectionBidMakerOrder.takeAsset.assetType.assetClass == LibAssetClasses.ERC721_ASSET_CLASS ||
                collectionBidMakerOrder.takeAsset.assetType.assetClass == LibAssetClasses.ERC1155_ASSET_CLASS,
            'LibOrder: invalid collection bid order take asset class'
        );
    }

    function validateCollectionBidTakerOrdersBatch(
        LibOrderTypes.Order[] memory orders // Collection-wide buy order at index 0 followed by matching taker orders
    ) internal pure {
        // Decode collectionBidOrder take asset token address
        address makerTakeAsset;
        (makerTakeAsset, ) = abi.decode(orders[0].takeAsset.assetType.data, (address, uint256));
        for (uint256 i = 1; i < orders.length; i += 1) {
            // Validate taker order
            validateCollectionBidTakerOrder(orders[i], makerTakeAsset);
        }
    }

    function formatCollectionBidOrdersBatch(
        uint256[] memory remainingMakeValues,
        uint256[] memory remainingTakeValues,
        LibOrderTypes.Order[] memory orders
    ) internal pure returns (LibOrderTypes.Order[] memory formattedOrders) {
        uint256 arraysLength = (orders.length - 1) * 2;
        formattedOrders = new LibOrderTypes.Order[](arraysLength);
        uint256 sumRemainingTakerOrdersMakeValue = 0;
        uint256 sumRemainingTakerOrdersTakeValue = 0;
        // Iterate over taker signatures array
        for (uint256 i = 1; i < orders.length; i += 1) {
            // Format orders and signature
            formattedOrders[(i - 1) * 2] = orders[i]; // Taker order
            formattedOrders[(i - 1) * 2 + 1] = formatCollectionBidMakerOrder(
                orders[0],
                orders[i],
                remainingMakeValues[i],
                remainingTakeValues[i]
            ); // Maker order
            // Aggregate remaining taker order make and take values
            sumRemainingTakerOrdersMakeValue += remainingMakeValues[i];
            sumRemainingTakerOrdersTakeValue += remainingTakeValues[i];
        }
        // Verify that the ratio of collectionBid order take value / collectionBid order make value equals
        // the ratio of sumRemainingTakerOrdersMakeValue / sumRemainingTakerOrdersTakeValue (i.e. the price per NFT
        // specified in collectionBidOrder is globally respected by the batch of taker orders)
        require(
            orders[0].takeAsset.value / orders[0].makeAsset.value ==
                sumRemainingTakerOrdersMakeValue / sumRemainingTakerOrdersTakeValue,
            'LibOrder: collection bid order price mismatch'
        );
    }

    function formatCollectionBidSignaturesBatch(
        bytes[] memory signatures,
        uint256[] memory matchBeforeTimestamps,
        bytes[] memory orderBookSignatures
    )
        internal
        pure
        returns (
            bytes[] memory formattedSignatures,
            uint256[] memory formattedMatchBeforeTimestamps,
            bytes[] memory formattedOrderBookSignatures
        )
    {
        uint256 arraysLength = (signatures.length - 1) * 2;
        formattedSignatures = new bytes[](arraysLength);
        formattedMatchBeforeTimestamps = new uint256[](arraysLength);
        formattedOrderBookSignatures = new bytes[](arraysLength);
        // Iterate over signatures array
        for (uint256 i = 1; i < signatures.length; i += 1) {
            // Format signatures
            formattedSignatures[(i - 1) * 2] = signatures[i]; // Taker signature
            formattedSignatures[(i - 1) * 2 + 1] = new bytes(0); // Empty maker order signature
            formattedMatchBeforeTimestamps[(i - 1) * 2] = matchBeforeTimestamps[i]; // Taker order matchBeforeTimestamp
            formattedMatchBeforeTimestamps[(i - 1) * 2 + 1] = matchBeforeTimestamps[0]; // Collection bid order matchBeforeTimestamp
            formattedOrderBookSignatures[(i - 1) * 2] = orderBookSignatures[i]; // Taker order order-book signature
            formattedOrderBookSignatures[(i - 1) * 2 + 1] = new bytes(0); // Empty maker order order-book signature
        }
    }

    function validateCollectionBidTakerOrder(
        LibOrderTypes.Order memory takerOrder,
        address makerTakeAsset
    ) internal pure {
        // Make sure taker order has collectionBid == false (otherwise it would be possible
        // to match an un-signed taker order submitted by a malicious third party on behalf of an unwilling taker)
        require(!takerOrder.collectionBid, 'LibOrder: invalid taker order collectionBid flag');
        // Make sure taker order's make asset token address equals collectionBidOrder take asset token address
        address takerMakeAsset;
        (takerMakeAsset, ) = abi.decode(takerOrder.makeAsset.assetType.data, (address, uint256));
        require(
            makerTakeAsset == takerMakeAsset,
            'LibOrder: taker order make asset does not match collection bid order take asset'
        );
    }

    function formatCollectionBidMakerOrder(
        LibOrderTypes.Order memory collectionBidOrder,
        LibOrderTypes.Order memory takerOrder,
        uint256 remainingTakerOrderMakeValue,
        uint256 remainingTakerOrderTakeValue
    ) internal pure returns (LibOrderTypes.Order memory makerOrder) {
        // Format matching maker order's make and take assets
        LibAssetTypes.Asset memory makerOrderMakeAsset = LibAssetTypes.Asset(
            LibAssetTypes.AssetType( // Maker order make asset type equals collectionBidOrder make asset type
                collectionBidOrder.makeAsset.assetType.assetClass, // assetClass is WETH or ERC20
                collectionBidOrder.makeAsset.assetType.data // data is ERC20 token address
            ),
            remainingTakerOrderTakeValue // Maker order make asset value matches remaining taker order take asset value
        );
        LibAssetTypes.Asset memory makerOrderTakeAsset = LibAssetTypes.Asset(
            LibAssetTypes.AssetType( // Maker order make asset type equals taker order take asset type
                takerOrder.makeAsset.assetType.assetClass, // asset class is ERC721 or ERC1155
                takerOrder.makeAsset.assetType.data // Maker order take asset data equals taker order
            ), // make asset data (token address and tokenId)
            remainingTakerOrderMakeValue // Maker order take asset value matches remaining taker order make asset value
        );
        // Format matching maker order
        makerOrder = LibOrderTypes.Order(
            collectionBidOrder.maker, // Maker order maker equals collectionBidOrder maker
            makerOrderMakeAsset,
            collectionBidOrder.taker, // Maker order taker equals collectionBidOrder taker
            makerOrderTakeAsset,
            0, // Maker order salt must be 0 (maker order signature and matchAllowance will not be verified)
            collectionBidOrder.start, // Maker order start equals collectionBidOrder start
            collectionBidOrder.end, // Maker order end equals collectionBidOrder end,
            collectionBidOrder.dataType, // Maker order dataType equals collectionBidOrder dataType,
            collectionBidOrder.data, // Maker order data equals collectionBidOrder data,
            true // Maker order collectionBid flag must be set to true to pass signature and matchAllowance verifications
        );
    }
}
