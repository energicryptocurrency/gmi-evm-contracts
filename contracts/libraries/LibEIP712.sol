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

/// @title  LibEIP712
/// @author Energi Core
/// @notice Genrate signatures
/// @dev    Calculates EIP721 message signature with provided parameters

pragma solidity 0.8.27;

library LibEIP712 {
    // Calculates EIP712 encoding for a hash struct in this EIP712 Domain.
    // Note that we use the verifying contract's proxy address here instead of the verifying contract's address,
    // so that users signatures remain valid when we upgrade the Exchange contract
    function hashEIP712Message(
        bytes32 hashStruct,
        address verifyingContractProxy,
        uint256 chainId
    ) internal pure returns (bytes32 result) {
        bytes32 eip712DomainHash = keccak256(
            abi.encode(
                keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
                keccak256(bytes('Energi')),
                keccak256(bytes('1')),
                chainId,
                verifyingContractProxy
            )
        );

        result = keccak256(abi.encodePacked('\x19\x01', eip712DomainHash, hashStruct));
    }
}
