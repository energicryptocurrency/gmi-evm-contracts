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

/// @title  UpgradeManager
/// @author Energi Core
/// @notice Upgrade conrtacts to new implemetation
/// @dev    This contract should be inherited to contract to use upgrade manager access

pragma solidity 0.8.27;

import { Initializable } from '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';
import { OwnableUpgradeable } from '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';

contract UpgradeManager is Initializable, OwnableUpgradeable {
    address public upgradeManager;

    function __UpgradeManager_init(address initialUpgradeManager, address initialOwner) internal onlyInitializing {
        upgradeManager = initialUpgradeManager;
        __Ownable_init(initialOwner);
    }

    modifier onlyUpgradeManager() {
        require(_msgSender() == upgradeManager, 'UpgradeManager: Sender is not upgrade manager');
        _;
    }

    function setUpgradeManager(address _upgradeManager) external onlyOwner {
        upgradeManager = _upgradeManager;
    }
}
