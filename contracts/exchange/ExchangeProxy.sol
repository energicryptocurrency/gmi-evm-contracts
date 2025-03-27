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

/// @title  ExchangeProxy
/// @author Energi Core
/// @notice Proxy contract for Exchange
/// @dev    Proxy contract delegates calls to it's implementation contract

pragma solidity 0.8.27;

import { ReentrancyGuard } from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import { ERC1967Proxy } from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';

import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { IERC721 } from '@openzeppelin/contracts/token/ERC721/IERC721.sol';
import { IERC1155 } from '@openzeppelin/contracts/token/ERC1155/IERC1155.sol';

/**
 * SC-9: This contract has no chance of being updated. It must be stupid simple.
 *
 * If another upgrade logic is required in the future - it can be done as proxy stage II.
 */
contract ExchangeProxy is ERC1967Proxy, ReentrancyGuard {
    constructor(address _implementation, bytes memory _data) ERC1967Proxy(_implementation, _data) {}

    modifier senderOrigin() {
        // Internal calls are expected to use implementation directly.
        // That's due to use of call() instead of delegatecall() on purpose.
        require(tx.origin == msg.sender, 'ExchangeGovernedProxy: Only direct calls are allowed!');
        _;
    }

    modifier onlyImplementation() {
        require(
            msg.sender == address(_implementation()),
            'ExchangeGovernedProxy: Only calls from implementation are allowed!'
        );
        _;
    }

    event Match(
        bytes32 leftHash,
        bytes32 rightHash,
        address leftMaker,
        address rightMaker,
        uint256 newLeftFill,
        uint256 newRightFill
    );

    event CancelOrder(bytes32 hash);

    event Transfer(
        bytes4 indexed assetClass,
        address indexed from,
        address indexed to,
        bytes assetData,
        uint256 assetValue,
        bytes4 transferDirection,
        bytes4 transferType
    );

    function safeTransferERC20(IERC20 token, address to, uint256 value) external nonReentrant onlyImplementation {
        require(token.transfer(to, value), 'ExchangeGovernedProxy: safe transfer of ERC20 token failed');
    }

    function safeTransferERC20From(
        IERC20 token,
        address from,
        address to,
        uint256 value
    ) external nonReentrant onlyImplementation {
        require(token.transferFrom(from, to, value), 'ExchangeGovernedProxy: safe transferFrom of ERC20 token failed');
    }

    function safeTransferERC721From(
        IERC721 token,
        address from,
        address to,
        uint256 tokenId
    ) external nonReentrant onlyImplementation {
        token.safeTransferFrom(from, to, tokenId);
    }

    function safeTransferERC1155From(
        IERC1155 token,
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external nonReentrant onlyImplementation {
        token.safeTransferFrom(from, to, id, value, data);
    }

    function safeTransferETH(address to, uint256 amount) external nonReentrant onlyImplementation {
        (bool success, bytes memory data) = to.call{ value: amount }('');
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            'ExchangeGovernedProxy::safeTransferETH: failed to transfer ETH'
        );
    }

    function receiveETH() external payable {}

    function emitMatch(
        bytes32 leftHash,
        bytes32 rightHash,
        address leftMaker,
        address rightMaker,
        uint256 newLeftFill,
        uint256 newRightFill
    ) external onlyImplementation {
        emit Match(leftHash, rightHash, leftMaker, rightMaker, newLeftFill, newRightFill);
    }

    function emitCancelOrder(bytes32 hash) external onlyImplementation {
        emit CancelOrder(hash);
    }

    function emitTransfer(
        bytes4 assetClass,
        address from,
        address to,
        bytes calldata assetData,
        uint256 assetValue,
        bytes4 transferDirection,
        bytes4 transferType
    ) external onlyImplementation {
        emit Transfer(assetClass, from, to, assetData, assetValue, transferDirection, transferType);
    }

    receive() external payable {}
}
