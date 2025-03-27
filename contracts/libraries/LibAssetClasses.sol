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

/// @title  LibAssetClasses
/// @author Energi Core
/// @notice Contains bytes for each asset type
/// @dev    Stores bytes for every asset type like ETH, WETH and more

pragma solidity 0.8.27;

library LibAssetClasses {
    // Asset classes
    bytes4 public constant ETH_ASSET_CLASS = bytes4(keccak256('ETH'));
    bytes4 public constant WETH_ASSET_CLASS = bytes4(keccak256('WETH'));
    bytes4 public constant PROXY_WETH_ASSET_CLASS = bytes4(keccak256('PROXY_WETH'));
    bytes4 public constant ERC20_ASSET_CLASS = bytes4(keccak256('ERC20'));
    bytes4 public constant ERC721_ASSET_CLASS = bytes4(keccak256('ERC721'));
    bytes4 public constant ERC1155_ASSET_CLASS = bytes4(keccak256('ERC1155'));
}
