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

/// @title  LibOrderDataV1Types
/// @author Energi Core
/// @notice Contract consists data structure of order data
/// @dev    Struct for order data

pragma solidity 0.8.27;
pragma abicoder v2;

import { LibPartTypes } from './LibPartTypes.sol';

library LibOrderDataV1Types {
    bytes4 public constant V1 = bytes4(keccak256('V1'));

    struct DataV1 {
        LibPartTypes.Part[] payouts;
        LibPartTypes.Part[] originFees;
    }
}
