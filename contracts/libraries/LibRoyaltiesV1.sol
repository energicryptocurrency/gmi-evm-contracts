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

/// @title  LibRoyaltiesV1
/// @author Energi Core
/// @notice Bytes of functions
/// @dev    Encoded function indentifiers for royalties contract

pragma solidity 0.8.27;

library LibRoyaltiesV1 {
    // bytes4(keccak256('getFeeRecipients(uint256)')) == 0xb9c4d9fb
    bytes4 constant _INTERFACE_ID_FEE_RECIPIENTS = 0xb9c4d9fb;

    // bytes4(keccak256('getFeeBps(uint256)')) == 0x0ebd4c7f
    bytes4 constant _INTERFACE_ID_FEE_BPS = 0x0ebd4c7f;
}
