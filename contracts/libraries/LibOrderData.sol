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

/// @title  LibOrderData
/// @author Energi Core
/// @notice Decodes order data
/// @dev    Converts order data array in LibOrderDataV1Types struct

pragma solidity 0.8.27;

import { LibPartTypes } from './LibPartTypes.sol';
import { LibOrderTypes } from './LibOrderTypes.sol';
import { LibOrderDataV1 } from './LibOrderDataV1.sol';
import { LibOrderDataV1Types } from './LibOrderDataV1Types.sol';

library LibOrderData {
    function parse(
        LibOrderTypes.Order memory order
    ) internal pure returns (LibOrderDataV1Types.DataV1 memory dataOrder) {
        if (order.dataType == LibOrderDataV1.V1) {
            dataOrder = LibOrderDataV1.decodeOrderDataV1(order.data);
            if (dataOrder.payouts.length == 0) {
                dataOrder = payoutSet(order.maker, dataOrder);
            }
        } else if (
            order.dataType == 0xffffffff // Empty order data
        ) {
            dataOrder = payoutSet(order.maker, dataOrder);
        } else {
            revert('LibOrderData: Unknown Order data type');
        }
    }

    function payoutSet(
        address orderAddress,
        LibOrderDataV1Types.DataV1 memory dataOrderOnePayoutIn
    ) internal pure returns (LibOrderDataV1Types.DataV1 memory) {
        LibPartTypes.Part[] memory payout = new LibPartTypes.Part[](1);
        payout[0].account = payable(orderAddress);
        payout[0].value = 10000; // 100% of payout goes to payout[0].account
        dataOrderOnePayoutIn.payouts = payout;
        return dataOrderOnePayoutIn;
    }
}
