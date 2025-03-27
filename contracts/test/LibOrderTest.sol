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

/// @title  LibOrderTest
/// @author Energi Core
/// @notice Calculates order stats
/// @dev    Used for local test

pragma solidity 0.8.27;
pragma abicoder v2;

import { LibOrder } from '../libraries/LibOrder.sol';
import { LibOrderTypes } from '../libraries/LibOrderTypes.sol';

contract LibOrderTest {
    function calculateRemaining(
        LibOrderTypes.Order calldata order,
        uint256 fill
    ) external pure returns (uint256 makeAmount, uint256 takeAmount) {
        return LibOrder.calculateRemaining(order, fill);
    }

    function hashKey(LibOrderTypes.Order calldata order) external pure returns (bytes32) {
        return LibOrder.hashKey(order);
    }

    function validate(LibOrderTypes.Order calldata order) external view {
        LibOrder.validate(order);
    }
}
