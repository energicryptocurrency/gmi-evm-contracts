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

/// @title  IExchange
/// @author Energi Core
/// @notice Interface for Exchange external functions
/// @dev    Interface to intereact with Exchange proxy contract

pragma solidity 0.8.27;
pragma abicoder v2;

import { LibOrderTypes } from '../libraries/LibOrderTypes.sol';
import { ExchangeStorage } from './Exchange.sol';

interface IExchange {
    // Core features
    function matchOrders(
        LibOrderTypes.Order memory orderLeft,
        bytes memory signatureLeft,
        uint256 matchLeftBeforeTimestamp,
        bytes memory orderBookSignatureLeft,
        LibOrderTypes.Order memory orderRight,
        bytes memory signatureRight,
        uint256 matchRightBeforeTimestamp,
        bytes memory orderBookSignatureRight
    ) external payable;

    function batchMatchOrders(
        LibOrderTypes.Order[] calldata orders,
        bytes[] calldata signatures,
        uint256[] calldata matchBeforeTimestamps,
        bytes[] calldata orderBookSignatures
    ) external payable;

    function cancelOrder(LibOrderTypes.Order memory order) external;

    // Asset transfer
    function safeTransferERC20(address token, address to, uint256 value) external;

    // Setter functions
    function setOrderFill(bytes32 orderKeyHash, uint256 fill) external;

    // Getter functions
    function getProtocolFeeBps() external view returns (uint16);

    function getDefaultFeeReceiver() external view returns (address);

    function getFeeReceiver(address _token) external view returns (address);

    function getOrderFill(bytes32 orderKeyHash) external view returns (uint256);

    function getOrdersFills(bytes32[] calldata ordersKeyHashes) external view returns (uint256[] memory);

    function isERC20AssetAllowed(address _erc20AssetAddress) external view returns (bool);

    function _storage() external view returns (ExchangeStorage _storage);
}
