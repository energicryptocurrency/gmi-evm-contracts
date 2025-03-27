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

/// @title  TestERC1271
/// @author Energi Core
/// @notice Match orders with signatures
/// @dev    Verifies and match signature agains given data

pragma solidity 0.8.27;
pragma abicoder v2;

import { LibSignature } from '../libraries/LibSignature.sol';
import { LibOrderTypes } from '../libraries/LibOrderTypes.sol';

import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { IERC721 } from '@openzeppelin/contracts/token/ERC721/IERC721.sol';
import { IERC1155 } from '@openzeppelin/contracts/token/ERC1155/IERC1155.sol';
import { IERC1271 } from '@openzeppelin/contracts/interfaces/IERC1271.sol';
import { IExchange } from '../exchange/IExchange.sol';
import { IWrappedCoin } from '../interfaces/IWrappedCoin.sol';
import { IERC721Receiver } from '@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol';
import { IERC1155Receiver } from '@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol';

contract TestERC1271 is IERC721Receiver, IERC1155Receiver, IERC1271 {
    address public owner;
    address public impl;

    bytes4 private constant ERC165_SUPPORTED = 0x01ffc9a7; // bytes4(keccak256('supportsInterface(bytes4)'))
    bytes4 private constant ERC721_RECEIVED = 0x150b7a02; // bytes4(keccak256('onERC721Received(address,address,uint256,bytes)'))
    bytes4 private constant ERC1155_RECEIVED = 0xf23a6e61; // bytes4(keccak256('onERC1155Received(address,address,uint256,uint256,bytes)'))
    bytes4 private constant ERC1271_VALID_SIGNATURE = 0x1626ba7e; // bytes4(keccak256('isValidSignature(bytes32,bytes)'))

    constructor(address _owner, address _impl) {
        owner = _owner;
        impl = _impl;
    }

    /* EIP-1271 function */

    // Check for valid signature from contract owner
    function isValidSignature(bytes32 _hash, bytes calldata _signature) external view override returns (bytes4) {
        if (LibSignature.recover(_hash, _signature) == owner) {
            return ERC1271_VALID_SIGNATURE;
        } else {
            return 0xffffffff;
        }
    }

    /* Asset Receiver Functions */

    // Receive ETH
    receive() external payable {}

    // Allows this contract to receive ERC721 transfers supporting the IERC721Receiver interface
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external pure override returns (bytes4 response) {
        if (
            operator != address(0x0) ||
            from != address(0x0) ||
            tokenId >= 0 ||
            abi.decode(data, (address)) != address(0x0)
        ) {
            response = ERC721_RECEIVED;
        }
    }

    // Allows this contract to receive ERC1155 transfers supporting the IERC1155Receiver interface
    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external pure override returns (bytes4 response) {
        if (
            operator != address(0x0) ||
            from != address(0x0) ||
            id >= 0 ||
            value >= 0 ||
            abi.decode(data, (address)) != address(0x0)
        ) {
            response = ERC1155_RECEIVED;
        }
    }

    // Allows this contract to receive ERC1155 batch transfers supporting the IERC1155Receiver interface
    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external pure override returns (bytes4 response) {
        if (
            operator != address(0x0) ||
            from != address(0x0) ||
            ids.length >= 0 ||
            values.length >= 0 ||
            abi.decode(data, (address)) != address(0x0)
        ) {
            response = ERC1155_RECEIVED;
        }
    }

    // Contract supports the IERC165 interface
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == ERC165_SUPPORTED;
    }

    /* Transfer Functions to Recover Assets back to the owner EOA */

    function recoverETH() external {
        (bool success, bytes memory data) = owner.call{ value: address(this).balance }('');
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            'TestERC1271: failed to return excess ETH to owner'
        );
    }

    function recoverERC20(address token) external {
        IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this)));
    }

    function recoverERC721(address token, uint256 tokenId) external {
        IERC721(token).safeTransferFrom(address(this), owner, tokenId);
    }

    function recoverERC1155(address token, uint256 tokenId) external {
        IERC1155(token).safeTransferFrom(
            address(this),
            owner,
            tokenId,
            IERC1155(token).balanceOf(address(this), tokenId),
            '0x'
        );
    }

    /* Mutative Functions used in Tests */

    // Receive WETH from ETH deposits
    function receiveWETH(address weth) external payable {
        IWrappedCoin(weth).deposit{ value: msg.value }();
    }

    // Approve WETH/ERC20 for exchange proxy to spend
    function approveERC20(address erc20Token, address operator, uint256 allowance) external {
        IERC20(erc20Token).approve(operator, allowance);
    }

    // Approve ERC721 for exchange proxy to spend
    function setApprovalForAllERC721(address erc721Token, address operator, bool approved) external {
        IERC721(erc721Token).setApprovalForAll(operator, approved);
    }

    // Approve ERC1155 for exchange proxy to spend
    function setApprovalForAllERC1155(address erc1155Token, address operator, bool approved) external {
        IERC1155(erc1155Token).setApprovalForAll(operator, approved);
    }

    // Match orders on the exchange implementation
    function matchOrdersOnExchange(
        LibOrderTypes.Order memory orderLeft, // Taker order
        bytes memory signatureLeft, // Taker order hash signature
        uint256 matchLeftBeforeTimestamp, // Timestamp after which matching taker order is not allowed by order-book
        bytes memory orderBookSignatureLeft, // Order-book signature for taker order matchAllowance
        LibOrderTypes.Order memory orderRight, // Maker order
        bytes memory signatureRight, // Maker order hash signature
        uint256 matchRightBeforeTimestamp, // Timestamp after which matching maker order is not allowed by order-book
        bytes memory orderBookSignatureRight // Order-book signature for maker order matchAllowance
    ) external payable {
        // Direct calls via exchange proxy are prevented by the `senderOrigin` modifier
        IExchange(impl).matchOrders(
            orderLeft,
            signatureLeft,
            matchLeftBeforeTimestamp,
            orderBookSignatureLeft,
            orderRight,
            signatureRight,
            matchRightBeforeTimestamp,
            orderBookSignatureRight
        );
    }
}
