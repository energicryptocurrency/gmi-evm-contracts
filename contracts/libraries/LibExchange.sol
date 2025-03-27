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

/// @title  LibExchange
/// @author Energi Core
/// @notice Contract to match signatures
/// @dev    Match given signatures to the contract

pragma solidity 0.8.27;
pragma abicoder v2;

import { LibAsset } from './LibAsset.sol';
import { LibAssetClasses } from './LibAssetClasses.sol';
import { LibAssetTypes } from './LibAssetTypes.sol';
import { LibBps } from './LibBps.sol';
import { LibEIP712 } from './LibEIP712.sol';
import { LibOrder } from './LibOrder.sol';
import { LibOrderTypes } from './LibOrderTypes.sol';
import { LibPartTypes } from './LibPartTypes.sol';
import { LibSignature } from './LibSignature.sol';
import { SafeMath } from './SafeMath.sol';

import { IRoyaltiesRegistry } from '../royalties-registry/IRoyaltiesRegistry.sol';
import { IERC1271 } from '@openzeppelin/contracts/interfaces/IERC1271.sol';
import { Address } from '@openzeppelin/contracts/utils/Address.sol';

library LibExchange {
    using SafeMath for uint256;

    // See: https://eips.ethereum.org/EIPS/eip-1271
    bytes4 internal constant MAGICVALUE = 0x1626ba7e; // bytes4(keccak256("isValidSignature(bytes32,bytes)")

    // Assets match functions
    function simpleMatch(
        LibAssetTypes.AssetType memory _takeAssetType,
        LibAssetTypes.AssetType memory _makeAssetType
    ) private pure returns (LibAssetTypes.AssetType memory) {
        bytes32 leftHash = keccak256(_takeAssetType.data);
        bytes32 rightHash = keccak256(_makeAssetType.data);
        if (leftHash == rightHash) {
            return _takeAssetType;
        }
        return LibAssetTypes.AssetType(0, '');
    }

    function matchAssets(
        LibAssetTypes.AssetType memory _takeAssetType, // Asset type expected by one side
        LibAssetTypes.AssetType memory _makeAssetType // Asset type sent by the other side
    ) private pure returns (LibAssetTypes.AssetType memory) {
        bytes4 classTake = _takeAssetType.assetClass;
        bytes4 classMake = _makeAssetType.assetClass;
        // Match ETH and WETH assets
        if (classTake == LibAssetClasses.ETH_ASSET_CLASS || classTake == LibAssetClasses.WETH_ASSET_CLASS) {
            if (classMake == LibAssetClasses.ETH_ASSET_CLASS || classMake == LibAssetClasses.WETH_ASSET_CLASS) {
                return _takeAssetType;
            }
            return LibAssetTypes.AssetType(0, '');
        }
        // Match ERC20 asset
        if (classTake == LibAssetClasses.ERC20_ASSET_CLASS) {
            if (classMake == LibAssetClasses.ERC20_ASSET_CLASS) {
                return simpleMatch(_takeAssetType, _makeAssetType);
            }
            return LibAssetTypes.AssetType(0, '');
        }
        // Match ERC721 asset
        if (classTake == LibAssetClasses.ERC721_ASSET_CLASS) {
            if (classMake == LibAssetClasses.ERC721_ASSET_CLASS) {
                return simpleMatch(_takeAssetType, _makeAssetType);
            }
            return LibAssetTypes.AssetType(0, '');
        }
        // Match ERC1155 asset
        if (classTake == LibAssetClasses.ERC1155_ASSET_CLASS) {
            if (classMake == LibAssetClasses.ERC1155_ASSET_CLASS) {
                return simpleMatch(_takeAssetType, _makeAssetType);
            }
            return LibAssetTypes.AssetType(0, '');
        }

        revert('LibExchange: asset class not supported');
    }

    function matchAssets(
        LibOrderTypes.Order memory orderLeft,
        LibOrderTypes.Order memory orderRight
    )
        internal
        pure
        returns (
            LibAssetTypes.AssetType memory makerAssetType, // Asset type expected by order maker
            LibAssetTypes.AssetType memory takerAssetType // Asset type expected by order taker
        )
    {
        makerAssetType = matchAssets(orderRight.takeAsset.assetType, orderLeft.makeAsset.assetType);
        require(makerAssetType.assetClass != 0, 'LibExchange: assets do not match');
        takerAssetType = matchAssets(orderLeft.takeAsset.assetType, orderRight.makeAsset.assetType);
        require(takerAssetType.assetClass != 0, 'LibExchange: assets do not match');
    }

    function verifyOrder(
        LibOrderTypes.Order memory _order,
        bytes memory _signature,
        address _callerAddress,
        address _verifyingContractProxy,
        uint256 _chainId
    ) internal view {
        if (_order.salt == 0) {
            // order.salt can be 0 and no signature is expected if order.collectionBid == true or if caller is order.maker
            if (!_order.collectionBid) {
                if (_order.maker != address(0)) {
                    // We check that order has been submitted by order.maker
                    require(_callerAddress == _order.maker, 'LibExchange: order maker is not caller');
                } else {
                    // If order.maker is not set, we set it to callerAddress
                    _order.maker = _callerAddress;
                }
            }
        } else {
            // When order is submitted by a third party account, order.salt cannot be 0
            // We check that the signature has been created by order.maker, or by a smart-contract implementing the
            // EIP-1271 standard
            if (_callerAddress != _order.maker) {
                // Calculate order EIP712 hashStruct
                bytes32 hashStruct = LibOrder.hash(_order);
                // Verify order EIP712 hashStruct signature
                address signer = LibSignature.recover(
                    LibEIP712.hashEIP712Message(hashStruct, _verifyingContractProxy, _chainId),
                    _signature
                );
                if (signer != _order.maker) {
                    // if (Address.isContract(_order.maker)) {
                    if (_order.maker.code.length > 0) {
                        // If order.maker is a smart-contract, it must implement the ERC1271 standard to validate the
                        // signature (see: https://eips.ethereum.org/EIPS/eip-1271)
                        require(
                            IERC1271(_order.maker).isValidSignature(
                                LibEIP712.hashEIP712Message(hashStruct, _verifyingContractProxy, _chainId),
                                _signature
                            ) == MAGICVALUE,
                            'LibExchange: EIP-1271 contract order signature verification error'
                        );
                    } else {
                        // If order.maker is not a smart-contract, it must be the signer
                        revert('LibExchange: EIP-712 wallet order signature verification error');
                    }
                }
            }
        }
    }

    function verifyMatch(
        LibOrderTypes.Order calldata _orderLeft,
        LibOrderTypes.Order calldata _orderRight,
        uint256 _matchLeftBeforeTimestamp,
        uint256 _matchRightBeforeTimestamp,
        bytes memory _orderBookSignatureLeft,
        bytes memory _orderBookSignatureRight,
        address _verifyingContractProxy,
        address _orderBook,
        uint256 _chainId
    ) internal view returns (bytes32 _leftOrderKeyHash, bytes32 _rightOrderKeyHash) {
        // Calculate _orderLeft hashKey
        _leftOrderKeyHash = LibOrder.hashKey(_orderLeft);
        // Verify order-book's matchAllowance for orders submitted by third parties only
        if (_orderLeft.salt > 0) {
            verifyMatchAllowance(
                _leftOrderKeyHash,
                _matchLeftBeforeTimestamp,
                _orderBookSignatureLeft,
                _verifyingContractProxy,
                _orderBook,
                _chainId
            );
        }
        // Calculate _orderRight hashKey
        _rightOrderKeyHash = LibOrder.hashKey(_orderRight);
        // Verify order-book's matchAllowance for orders submitted by third parties only
        if (_orderRight.salt > 0) {
            verifyMatchAllowance(
                _rightOrderKeyHash,
                _matchRightBeforeTimestamp,
                _orderBookSignatureRight,
                _verifyingContractProxy,
                _orderBook,
                _chainId
            );
        }
    }

    function verifyMatchAllowance(
        bytes32 _orderKeyHash,
        uint256 _matchBeforeTimestamp,
        bytes memory _orderBookSignature,
        address _verifyingContractProxy,
        address _orderBook,
        uint256 _chainId
    ) internal view {
        // Make sure current block`s timestamp is below matchBeforeTimestamp
        require(
            _matchBeforeTimestamp > block.timestamp,
            'LibExchange: current block`s timestamp is higher than matchBeforeTimestamp'
        );

        // OrderBook must be the signer
        if (
            recoverMatchAllowanceSigner(
                _orderKeyHash,
                _matchBeforeTimestamp,
                _orderBookSignature,
                _verifyingContractProxy,
                _chainId
            ) != _orderBook
        ) {
            revert('LibExchange: EIP-712 matchAllowance signature verification error');
        }
    }

    function recoverMatchAllowanceSigner(
        bytes32 _orderKeyHash,
        uint256 _matchBeforeTimestamp,
        bytes memory _orderBookSignature,
        address _verifyingContractProxy,
        uint256 _chainId
    ) internal pure returns (address _recovered) {
        // Calculate matchAllowance EIP712 hashStruct
        bytes32 hashStruct = LibOrder.hash(_orderKeyHash, _matchBeforeTimestamp);
        // Verify matchAllowance EIP712 hashStruct signature
        _recovered = LibSignature.recover(
            LibEIP712.hashEIP712Message(hashStruct, _verifyingContractProxy, _chainId),
            _orderBookSignature
        );
    }

    // Helper functions
    function subFee(uint256 _value, uint256 _fee) internal pure returns (uint256 _newValue, uint256 _realFee) {
        if (_value > _fee) {
            _newValue = _value.sub(_fee);
            _realFee = _fee;
        } else {
            _newValue = 0;
            _realFee = _value;
        }
    }

    // Subtract, from _rest amount, a fee expressed in bps of a _total amount
    function subFeeInBps(
        uint256 _rest,
        uint256 _total,
        uint16 _feeInBps
    ) internal pure returns (uint256 _newRest, uint256 _realFee) {
        uint256 _fee = LibBps.bps(_total, _feeInBps); // Calculate fee
        return subFee(_rest, _fee); // Subtract fee from _rest and return new rest and real fee
    }

    function calculateTotalAmount(
        uint256 _amount,
        LibPartTypes.Part[] memory _orderOriginFees
    ) internal pure returns (uint256 _total) {
        _total = _amount;
        // Add origin fees  to amount
        for (uint256 i = 0; i < _orderOriginFees.length; i++) {
            _total = _total.add(LibBps.bps(_amount, _orderOriginFees[i].value));
        }
    }

    function getRoyaltiesByAssetType(
        LibAssetTypes.AssetType memory _assetType,
        address _royaltiesRegistry
    ) internal view returns (LibPartTypes.Part[] memory) {
        if (
            _assetType.assetClass == LibAssetClasses.ERC1155_ASSET_CLASS ||
            _assetType.assetClass == LibAssetClasses.ERC721_ASSET_CLASS
        ) {
            (address token, uint256 tokenId) = abi.decode(_assetType.data, (address, uint256));
            return IRoyaltiesRegistry(_royaltiesRegistry).getRoyalties(token, tokenId);
        }
        LibPartTypes.Part[] memory empty;
        return empty;
    }

    function checkCounterparties(
        LibOrderTypes.Order memory orderLeft, // Taker order
        LibOrderTypes.Order memory orderRight // Maker order
    ) internal pure {
        // Validate taker and maker addresses if they are specified in orders
        if (orderLeft.taker != address(0)) {
            require(orderRight.maker == orderLeft.taker, 'LibExchange: leftOrder.taker verification failed');
        }
        if (orderRight.taker != address(0)) {
            require(orderRight.taker == orderLeft.maker, 'LibExchange: rightOrder.taker verification failed');
        }
    }
}
