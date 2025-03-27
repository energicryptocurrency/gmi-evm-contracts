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

/// @title  IExchangeOrders
/// @author Energi Core
/// @notice Interface to intreact with orders related transactions
/// @dev    Interface for only order related external functions for Exchange contract

pragma solidity 0.8.27;
pragma abicoder v2;

import { LibOrderTypes } from '../../libraries/LibOrderTypes.sol';

interface IExchangeOrders {
    function batchMatchOrders(
        LibOrderTypes.Order[] calldata orders,
        bytes[] calldata signatures,
        uint256[] calldata matchBeforeTimestamps,
        bytes[] calldata orderBookSignatures
    ) external payable;

    function cancelOrder(LibOrderTypes.Order memory order) external;

    function setOrderFill(bytes32 orderKeyHash, uint256 fill) external;

    function getOrderFill(bytes32 orderKeyHash) external view returns (uint256);
}
