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

/// @title  IExchangeStorage
/// @author Energi Core
/// @notice Interface for Exchange storage contract
/// @dev    Interface to intract with ExchangeStorage contract

pragma solidity 0.8.27;

interface IExchangeStorage {
    function getHelperProxy() external view returns (address);

    function getOrderBook() external view returns (address);

    function getDefaultFeeReceiver() external view returns (address);

    function getRoyaltiesRegistryProxy() external view returns (address);

    function getFeeReceiver(address _token) external view returns (address);

    function getWETH() external view returns (address);

    function getFill(bytes32 _orderKeyHash) external view returns (uint256);

    function isERC20AssetAllowed(address _erc20AssetAddress) external view returns (bool);

    function getProtocolFeeBps() external view returns (uint16);

    function getChainId() external view returns (uint256);

    function setHelperProxy(address _helperProxy) external;

    function setOrderBook(address _orderBook) external;

    function setDefaultFeeReceiver(address _newDefaultFeeReceiver) external;

    function setRoyaltiesRegistryProxy(address _royaltiesRegistryProxy) external;

    function setFeeReceiver(address _token, address _recipient) external;

    function setWETH(address _weth) external;

    function setFill(bytes32 _orderKeyHash, uint256 _value) external;

    function setERC20AssetAllowed(address _erc20AssetAddress, bool _isAllowed) external;

    function setProtocolFeeBps(uint16 _newProtocolFeeBps) external;

    function setChainId(uint256 _newChainId) external;

    function setExchangeOwner(address _exchangeOwner) external;
}
