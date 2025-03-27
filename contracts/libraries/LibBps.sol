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

/// @title  LibBps
/// @author Energi Core
/// @notice Basis points calculator contract
/// @dev    Converts given basis points value into actual value

pragma solidity 0.8.27;

import { SafeMath } from './SafeMath.sol';

library LibBps {
    using SafeMath for uint256;

    function bps(uint256 value, uint16 bpsValue) internal pure returns (uint256) {
        return value.mul(bpsValue).div(10000);
    }
}
