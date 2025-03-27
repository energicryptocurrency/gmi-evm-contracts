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

/// @title  LibPartTypes
/// @author Energi Core
/// @notice Defines part types for fee
/// @dev    Structs for fee structure with different implementation

pragma solidity 0.8.27;

library LibPartTypes {
    struct Part {
        address payable account;
        // `value` is used to capture basepoints (bps) for royalties, origin fees, and payouts
        // `value` can only range from 0 to 10,000, therefore uint16 with a range of 0 to 65,535 suffices
        uint16 value;
    }

    // use for external providers that implement values based on uint96 (e.g. Rarible)
    struct Part96 {
        address payable account;
        uint96 value;
    }

    // use for external providers following the LooksRare pattern
    struct FeeInfo {
        address setter;
        address receiver;
        uint256 fee;
    }
}
