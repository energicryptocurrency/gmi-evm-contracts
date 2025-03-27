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

/// @title  IExchangeHelper
/// @author Energi Core
/// @notice Interface for ExchangeHelper external functions
/// @dev    Interface to intreact with ExchangeHelper proxy contract

pragma solidity 0.8.27;
pragma abicoder v2;

import { LibAssetTypes } from '../../libraries/LibAssetTypes.sol';
import { LibOrderTypes } from '../../libraries/LibOrderTypes.sol';
import { LibFillTypes } from '../../libraries/LibFillTypes.sol';
import { LibPartTypes } from '../../libraries/LibPartTypes.sol';
import { LibFeeSideTypes } from '../../libraries/LibFeeSideTypes.sol';
import { LibOrderDataV1Types } from '../../libraries/LibOrderDataV1Types.sol';

interface IExchangeHelper {
    function batchCancelOrders(LibOrderTypes.Order[] calldata orders) external;

    function matchCollectionBidOrder(
        LibOrderTypes.Order[] calldata orders,
        bytes[] calldata takerSignatures, // Maker signature a index 0 followed by taker signatures
        uint256[] calldata matchLeftBeforeTimestamps, // Array of timestamps after which matching orders is not allowed by order-book
        bytes[] calldata orderBookSignaturesLeft
    ) external payable;

    // Library calls
    function bps(uint256 value, uint16 bpsValue) external pure returns (uint256);

    function calculateFills(
        LibOrderTypes.Order calldata leftOrder,
        LibOrderTypes.Order calldata rightOrder,
        bytes32 leftOrderKeyHash,
        bytes32 rightOrderKeyHash
    ) external returns (LibFillTypes.FillResult memory);

    function hashKey(LibOrderTypes.Order calldata order) external pure returns (bytes32);

    function verifyOrder(
        LibOrderTypes.Order calldata order,
        bytes calldata _signature,
        address _callerAddress,
        address _verifyingContractProxy,
        uint256 chainId
    ) external view;

    function verifyMatch(
        LibOrderTypes.Order calldata orderLeft,
        LibOrderTypes.Order calldata orderRight,
        uint256 matchLeftBeforeTimestamp,
        uint256 matchRightBeforeTimestamp,
        bytes memory orderBookSignatureLeft,
        bytes memory orderBookSignatureRight,
        address verifyingContractProxy,
        address orderBook,
        uint256 chainId
    ) external view returns (bytes32, bytes32);

    function matchAssets(
        LibOrderTypes.Order calldata orderLeft,
        LibOrderTypes.Order calldata orderRight
    ) external pure returns (LibAssetTypes.AssetType memory, LibAssetTypes.AssetType memory);

    function calculateTotalAmount(
        uint256 _amount,
        LibPartTypes.Part[] calldata _orderOriginFees
    ) external pure returns (uint256);

    function subFeeInBps(uint256 _rest, uint256 _total, uint16 _feeInBps) external pure returns (uint256, uint256);

    function getRoyaltiesByAssetType(
        LibAssetTypes.AssetType calldata assetType,
        address _royaltiesRegistry
    ) external view returns (LibPartTypes.Part[] memory);

    function parse(LibOrderTypes.Order memory order) external pure returns (LibOrderDataV1Types.DataV1 memory);

    function getFeeSide(bytes4 makerAssetClass, bytes4 takerAssetClass) external pure returns (LibFeeSideTypes.FeeSide);

    function calculateTotalTakeAndMakeValues(
        LibOrderTypes.Order memory _leftOrder,
        LibOrderTypes.Order memory _rightOrder,
        LibAssetTypes.AssetType memory _takerAssetType,
        LibAssetTypes.AssetType memory _makerAssetType,
        LibFillTypes.FillResult memory _fill
    ) external pure returns (uint256 _totalMakeValue, uint256 _totalTakeValue);

    function checkERC20TokensAllowed(
        LibOrderTypes.Order memory orderLeft, // Taker order
        LibOrderTypes.Order memory orderRight // Maker order
    ) external view;
}
