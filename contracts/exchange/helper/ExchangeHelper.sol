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

/// @title  ExchangeHelper
/// @author Energi Core
/// @notice Extension of Exchange contract
/// @dev    This contract is used for validating and setting data for exchange transactions

pragma solidity 0.8.27;
pragma abicoder v2;

import { SafeMath } from '../../libraries/SafeMath.sol';
import { LibBps } from '../../libraries/LibBps.sol';
import { LibExchange } from '../../libraries/LibExchange.sol';
import { LibAssetTypes } from '../../libraries/LibAssetTypes.sol';
import { LibAssetClasses } from '../../libraries/LibAssetClasses.sol';
import { LibOrder } from '../../libraries/LibOrder.sol';
import { LibOrderTypes } from '../../libraries/LibOrderTypes.sol';
import { LibOrderData } from '../../libraries/LibOrderData.sol';
import { LibOrderDataV1Types } from '../../libraries/LibOrderDataV1Types.sol';
import { LibFill } from '../../libraries/LibFill.sol';
import { LibFillTypes } from '../../libraries/LibFillTypes.sol';
import { LibPartTypes } from '../../libraries/LibPartTypes.sol';
import { LibFeeSide } from '../../libraries/LibFeeSide.sol';
import { LibFeeSideTypes } from '../../libraries/LibFeeSideTypes.sol';

import { IExchange } from '../IExchange.sol';
import { IExchangeHelper } from './IExchangeHelper.sol';
import { IExchangeOrders } from './IExchangeOrders.sol';
import { ExchangeStorage } from '../Exchange.sol';

import { ERC1967Utils } from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol';
import { OwnableUpgradeable } from '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import { UUPSUpgradeable } from '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol';

import { UpgradeManager } from '../../access/UpgradeManager.sol';

contract ExchangeHelper is OwnableUpgradeable, UpgradeManager, IExchangeHelper, UUPSUpgradeable {
    using SafeMath for uint256;

    address exchangeProxy;
    address orderBook;
    uint256 chainId;

    function initialize(
        address _exchangeProxy,
        address _orderBook,
        address _owner, // Owner of the implementation smart contract
        address _upgradeManager, // Multisig wallet to upgrade smart contract
        uint256 _chainId
    ) public initializer {
        exchangeProxy = _exchangeProxy;
        orderBook = _orderBook;
        chainId = _chainId;

        __Ownable_init(_owner);
        __UpgradeManager_init(_upgradeManager, _owner);
        __UUPSUpgradeable_init();
    }

    // Cancel orders by batch
    function batchCancelOrders(LibOrderTypes.Order[] calldata orders) external override {
        // Loop over orders array
        for (uint256 i = 0; i < orders.length; i++) {
            // Cancel order at index i
            IExchangeOrders(exchangeProxy).cancelOrder(orders[i]);
        }
    }

    function matchCollectionBidOrders(LibOrderTypes.BatchBidOders[] calldata batchBidOrders) external payable {
        for (uint256 i = 0; i < batchBidOrders.length; i++) {
            LibOrderTypes.BatchBidOders calldata currentBatchBidOrder = batchBidOrders[i];

            _matchCollectionBidOrder(
                currentBatchBidOrder.orders,
                currentBatchBidOrder.signatures,
                currentBatchBidOrder.matchBeforeTimestamps,
                currentBatchBidOrder.orderBookSignatures
            );
        }
    }

    // // Match collection-wide buy order
    function matchCollectionBidOrder(
        LibOrderTypes.Order[] calldata orders, // Collection-wide buy order at index 0 followed by matching taker orders
        bytes[] calldata signatures, // Maker signature a index 0 followed by taker signatures
        uint256[] calldata matchBeforeTimestamps, // Array of timestamps after which matching orders is not allowed by order-book
        bytes[] calldata orderBookSignatures // Array of order-book signatures for orders matchAllowances
    ) external payable override {
        _matchCollectionBidOrder(orders, signatures, matchBeforeTimestamps, orderBookSignatures);
    }

    function verifyCollectionBid(
        LibOrderTypes.Order calldata collectionBidOrder,
        bytes calldata makerSignature,
        uint256 matchBeforeTimestamp,
        bytes calldata orderBookSignature
    ) internal view {
        // Verify maker signature of collectionBid order
        LibExchange.verifyOrder(collectionBidOrder, makerSignature, tx.origin, exchangeProxy, chainId);
        // Verify order-book's matchAllowance signature for collectionBid order
        LibExchange.verifyMatchAllowance(
            LibOrder.hashKey(collectionBidOrder),
            matchBeforeTimestamp,
            orderBookSignature,
            exchangeProxy,
            orderBook,
            chainId
        );
    }

    function formatCollectionBidOrdersBatch(
        LibOrderTypes.Order[] calldata orders
    ) internal returns (LibOrderTypes.Order[] memory formattedOrders) {
        (uint256[] memory remainingMakeValues, uint256[] memory remainingTakeValues) = setCollectionBidOrderFill(
            orders
        );
        // Format matching maker orders batch
        formattedOrders = LibOrder.formatCollectionBidOrdersBatch(remainingMakeValues, remainingTakeValues, orders);
    }

    function formatCollectionBidSignaturesBatch(
        bytes[] calldata signatures,
        uint256[] calldata matchBeforeTimestamps,
        bytes[] calldata orderBookSignatures
    )
        internal
        pure
        returns (
            bytes[] memory formattedSignatures,
            uint256[] memory formattedMatchBeforeTimestamps,
            bytes[] memory formattedOrderBookSignatures
        )
    {
        // Format signatures batch
        (formattedSignatures, formattedMatchBeforeTimestamps, formattedOrderBookSignatures) = LibOrder
            .formatCollectionBidSignaturesBatch(signatures, matchBeforeTimestamps, orderBookSignatures);
    }

    function setCollectionBidOrderFill(
        LibOrderTypes.Order[] memory orders // Collection-wide buy order at index 0 followed by matching taker orders
    ) internal returns (uint256[] memory remainingMakeValues, uint256[] memory remainingTakeValues) {
        uint256[] memory ordersFills = new uint256[](orders.length);
        // Get collection-bid order fill from storage (in case collection-bid order was already partially matched)
        bytes32 collectionBidOrderKeyHash = LibOrder.hashKey(orders[0]);
        ordersFills[0] = IExchangeOrders(exchangeProxy).getOrderFill(collectionBidOrderKeyHash);
        // Get taker orders fills from storage (in case taker orders were already partially matched)
        for (uint256 i = 1; i < orders.length; i += 1) {
            if (orders[i].salt > 0) {
                ordersFills[i] = IExchangeOrders(exchangeProxy).getOrderFill(LibOrder.hashKey(orders[i]));
            } else {
                ordersFills[i] = 0;
            }
        }
        // Calculate new collectionBidOrder fill
        uint256 newCollectionBidOrderFill;
        (newCollectionBidOrderFill, remainingMakeValues, remainingTakeValues) = LibFill.fillCollectionBidOrder(
            orders,
            ordersFills
        );
        // Set new collectionBidOrder fill (we already checked that collectionBidOrder.salt > 0 in
        // LibOrder.formatCollectionBid)
        IExchangeOrders(exchangeProxy).setOrderFill(
            collectionBidOrderKeyHash,
            ordersFills[0].add(newCollectionBidOrderFill)
        );
    }

    // LibBps
    function bps(uint256 value, uint16 bpsValue) external pure override returns (uint256) {
        return LibBps.bps(value, bpsValue);
    }

    // LibFill
    function calculateFills(
        LibOrderTypes.Order calldata leftOrder,
        LibOrderTypes.Order calldata rightOrder,
        bytes32 leftOrderKeyHash,
        bytes32 rightOrderKeyHash
    ) external override returns (LibFillTypes.FillResult memory newFill) {
        require(_msgSender() == exchangeProxy, 'ExchangeHelper: FORBIDDEN, only Exchange implementation can call');
        // Get recorded orders fills (in case orders were already partially matched)
        uint256 leftOrderTakeAssetFill = leftOrder.salt == 0
            ? 0
            : IExchangeOrders(exchangeProxy).getOrderFill(leftOrderKeyHash);
        uint256 rightOrderTakeAssetFill = rightOrder.salt == 0
            ? 0
            : IExchangeOrders(exchangeProxy).getOrderFill(rightOrderKeyHash);
        // Calculate new fills
        newFill = LibFill.fillOrder(leftOrder, rightOrder, leftOrderTakeAssetFill, rightOrderTakeAssetFill);
        require(newFill.leftOrderTakeValue > 0, 'ExchangeHelper: nothing to fill');
        // Set new order fills for orders with non-zero salt (maker orders registered in off-chain OrderBook and taker
        // orders submitted by third party after being registered in off-chain OrderBook)
        if (leftOrder.salt != 0) {
            IExchangeOrders(exchangeProxy).setOrderFill(
                leftOrderKeyHash,
                leftOrderTakeAssetFill.add(newFill.leftOrderTakeValue)
            );
        }
        if (rightOrder.salt != 0) {
            IExchangeOrders(exchangeProxy).setOrderFill(
                rightOrderKeyHash,
                rightOrderTakeAssetFill.add(newFill.rightOrderTakeValue)
            );
        }
    }

    // LibOrder
    function hashKey(LibOrderTypes.Order calldata order) external pure override returns (bytes32) {
        return LibOrder.hashKey(order);
    }

    // LibExchange
    function verifyOrder(
        LibOrderTypes.Order calldata order,
        bytes calldata signature,
        address callerAddress,
        address verifyingContractProxy,
        uint256 _chainId
    ) public view override {
        LibExchange.verifyOrder(order, signature, callerAddress, verifyingContractProxy, _chainId);
    }

    function verifyMatch(
        LibOrderTypes.Order calldata orderLeft,
        LibOrderTypes.Order calldata orderRight,
        uint256 matchLeftBeforeTimestamp,
        uint256 matchRightBeforeTimestamp,
        bytes memory orderBookSignatureLeft,
        bytes memory orderBookSignatureRight,
        address verifyingContractProxy,
        address _orderBook,
        uint256 _chainId
    ) external view override returns (bytes32 leftOrderKeyHash, bytes32 rightOrderKeyHash) {
        (leftOrderKeyHash, rightOrderKeyHash) = LibExchange.verifyMatch(
            orderLeft,
            orderRight,
            matchLeftBeforeTimestamp,
            matchRightBeforeTimestamp,
            orderBookSignatureLeft,
            orderBookSignatureRight,
            verifyingContractProxy,
            _orderBook,
            _chainId
        );
    }

    function matchAssets(
        LibOrderTypes.Order calldata orderLeft,
        LibOrderTypes.Order calldata orderRight
    )
        external
        pure
        override
        returns (
            LibAssetTypes.AssetType memory, // Asset type expected by order maker
            LibAssetTypes.AssetType memory // Asset type expected by order taker
        )
    {
        return LibExchange.matchAssets(orderLeft, orderRight);
    }

    function calculateTotalAmount(
        uint256 amount,
        LibPartTypes.Part[] calldata orderOriginFees
    ) external pure override returns (uint256) {
        return LibExchange.calculateTotalAmount(amount, orderOriginFees);
    }

    function subFeeInBps(
        uint256 rest,
        uint256 total,
        uint16 feeInBps
    ) external pure override returns (uint256, uint256) {
        return LibExchange.subFeeInBps(rest, total, feeInBps);
    }

    function getRoyaltiesByAssetType(
        LibAssetTypes.AssetType calldata assetType,
        address royaltiesRegistry
    ) external view override returns (LibPartTypes.Part[] memory) {
        return LibExchange.getRoyaltiesByAssetType(assetType, royaltiesRegistry);
    }

    // LibOrderData
    function parse(
        LibOrderTypes.Order memory order
    ) external pure override returns (LibOrderDataV1Types.DataV1 memory) {
        return LibOrderData.parse(order);
    }

    // LibFeeSide
    function getFeeSide(
        bytes4 makerAssetClass, // Asset class expected to be received by maker
        bytes4 takerAssetClass // Asset class expected to be received by taker
    ) external pure override returns (LibFeeSideTypes.FeeSide) {
        return LibFeeSide.getFeeSide(makerAssetClass, takerAssetClass);
    }

    function calculateTotalTakeAndMakeValues(
        LibOrderTypes.Order memory _leftOrder,
        LibOrderTypes.Order memory _rightOrder,
        LibAssetTypes.AssetType memory _takerAssetType,
        LibAssetTypes.AssetType memory _makerAssetType,
        LibFillTypes.FillResult memory _fill
    ) external pure override returns (uint256 _totalMakeValue, uint256 _totalTakeValue) {
        // Get make and take values from the fill struct
        uint256 _makeValue = _fill.leftOrderTakeValue;
        uint256 _takeValue = _fill.rightOrderTakeValue;
        // Determine fee side (and fee asset)
        LibFeeSideTypes.FeeSide feeSide = LibFeeSide.getFeeSide(_makerAssetType.assetClass, _takerAssetType.assetClass);
        // Get right and left order data (parse payouts and origin fees)
        LibOrderDataV1Types.DataV1 memory leftOrderData = LibOrderData.parse(_leftOrder);
        LibOrderDataV1Types.DataV1 memory rightOrderData = LibOrderData.parse(_rightOrder);
        // Add origin fees to get _totalMakeValue and _totalTakeValue
        // Origin fees are paid by taker if they are defined in taker order, and/or by maker if they are defined in
        // maker order. Only taker origin fees are added on top of _totalAmount, while maker origin fees are subtracted
        // from the amount that is paid to maker.
        _totalMakeValue = _makeValue;
        _totalTakeValue = _takeValue;
        if (feeSide == LibFeeSideTypes.FeeSide.MAKE) {
            _totalMakeValue = LibExchange.calculateTotalAmount(_makeValue, rightOrderData.originFees);
        } else if (feeSide == LibFeeSideTypes.FeeSide.TAKE) {
            _totalTakeValue = LibExchange.calculateTotalAmount(_takeValue, leftOrderData.originFees);
        }
    }

    function _matchCollectionBidOrder(
        LibOrderTypes.Order[] calldata orders, // Collection-wide buy order at index 0 followed by matching taker orders
        bytes[] calldata signatures, // Maker signature a index 0 followed by taker signatures
        uint256[] calldata matchBeforeTimestamps, // Array of timestamps after which matching orders is not allowed by order-book
        bytes[] calldata orderBookSignatures // Array of order-book signatures for orders matchAllowances
    ) internal {
        // Verify collection bid order
        verifyCollectionBid(
            orders[0], // collectionBidOrder
            signatures[0],
            matchBeforeTimestamps[0],
            orderBookSignatures[0]
        );
        // Validate collectionBid maker order
        LibOrder.validateCollectionBidMakerOrder(orders[0]);
        // Validate taker orders batch
        LibOrder.validateCollectionBidTakerOrdersBatch(orders);
        // Format orders batch
        LibOrderTypes.Order[] memory formattedOrders = formatCollectionBidOrdersBatch(orders);
        // Format signatures batch
        (
            bytes[] memory formattedSignatures,
            uint256[] memory formattedMatchBeforeTimestamps,
            bytes[] memory formattedOrderBookSignatures
        ) = formatCollectionBidSignaturesBatch(signatures, matchBeforeTimestamps, orderBookSignatures);
        // Match matching orders
        IExchangeOrders(exchangeProxy).batchMatchOrders(
            formattedOrders,
            formattedSignatures,
            formattedMatchBeforeTimestamps,
            formattedOrderBookSignatures
        );
    }

    function checkERC20TokensAllowed(
        LibOrderTypes.Order memory orderLeft, // Taker order
        LibOrderTypes.Order memory orderRight // Maker order
    ) external view {
        LibOrder.validate(orderLeft);
        LibOrder.validate(orderRight);

        ExchangeStorage storageContract = IExchange(exchangeProxy)._storage();

        // If orders involve an ERC20 token, make sure it is allowed
        if (orderRight.makeAsset.assetType.assetClass == LibAssetClasses.ERC20_ASSET_CLASS) {
            require(
                storageContract.isERC20AssetAllowed(abi.decode(orderRight.makeAsset.assetType.data, (address))),
                'Exchange: maker order make asset is not allowed'
            );
        }
        if (orderRight.takeAsset.assetType.assetClass == LibAssetClasses.ERC20_ASSET_CLASS) {
            require(
                storageContract.isERC20AssetAllowed(abi.decode(orderRight.takeAsset.assetType.data, (address))),
                'Exchange: maker order take asset is not allowed'
            );
        }
        if (orderLeft.makeAsset.assetType.assetClass == LibAssetClasses.ERC20_ASSET_CLASS) {
            require(
                storageContract.isERC20AssetAllowed(abi.decode(orderLeft.makeAsset.assetType.data, (address))),
                'Exchange: taker order make asset is not allowed'
            );
        }
        if (orderLeft.takeAsset.assetType.assetClass == LibAssetClasses.ERC20_ASSET_CLASS) {
            require(
                storageContract.isERC20AssetAllowed(abi.decode(orderLeft.takeAsset.assetType.data, (address))),
                'Exchange: taker order take asset is not allowed'
            );
        }

        LibExchange.checkCounterparties(orderLeft, orderRight);
    }

    function _authorizeUpgrade(address newImplementation) internal virtual override onlyUpgradeManager {}
}
