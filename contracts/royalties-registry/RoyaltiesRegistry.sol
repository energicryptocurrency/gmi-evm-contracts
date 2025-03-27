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

/// @title  RoyaltiesRegistry
/// @author Energi Core
/// @notice Buisness logic to royalties for GMI
/// @dev    Set, edit and manages royalties

pragma solidity 0.8.27;
pragma abicoder v2;

import { StorageBase } from '../StorageBase.sol';

import { SafeMath } from '../libraries/SafeMath.sol';
import { LibPartTypes } from '../libraries/LibPartTypes.sol';
import { LibRoyaltiesV2 } from '../libraries/LibRoyaltiesV2.sol';
import { LibRoyaltiesV1 } from '../libraries/LibRoyaltiesV1.sol';

import { IRoyaltiesRegistryStorage } from './IRoyaltiesRegistryStorage.sol';
import { IRoyaltiesRegistry } from './IRoyaltiesRegistry.sol';
import { IRoyaltiesProviders } from './IRoyaltiesProviders.sol';
import { IRoyaltiesV1 } from '../interfaces/IRoyaltiesV1.sol';
import { IRoyaltiesV2 } from '../interfaces/IRoyaltiesV2.sol';
import { IOwnable } from '../interfaces/IOwnable.sol';
import { ICreator } from '../interfaces/ICreator.sol';

import { UpgradeManager } from '../access/UpgradeManager.sol';

import { OwnableUpgradeable } from '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import { UUPSUpgradeable } from '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol';
import { ERC1967Utils } from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol';
import { IERC165 } from '@openzeppelin/contracts/interfaces/IERC165.sol';

contract RoyaltiesRegistryStorage is StorageBase, IRoyaltiesRegistryStorage {
    mapping(bytes32 => LibRoyaltiesV2.RoyaltiesSet) private ownerRoyaltiesByTokenAndTokenId;
    mapping(bytes32 => LibRoyaltiesV2.RoyaltiesSet) private creatorRoyaltiesByTokenAndTokenId;
    mapping(address => LibRoyaltiesV2.RoyaltiesSet) private royaltiesByToken;
    mapping(address => address) private royaltiesProviders; // royaltiesProviders are other contracts providing royalties

    // ownerRoyaltiesByTokenAndTokenId getter
    //
    function getOwnerRoyaltiesByTokenAndTokenId(
        address token,
        uint256 tokenId
    ) external view override returns (LibRoyaltiesV2.RoyaltiesSet memory) {
        return ownerRoyaltiesByTokenAndTokenId[keccak256(abi.encode(token, tokenId))];
    }

    // creatorRoyaltiesByTokenAndTokenId getter
    //
    function getCreatorRoyaltiesByTokenAndTokenId(
        address token,
        uint256 tokenId
    ) external view override returns (LibRoyaltiesV2.RoyaltiesSet memory) {
        return creatorRoyaltiesByTokenAndTokenId[keccak256(abi.encode(token, tokenId))];
    }

    // ownerRoyaltiesByTokenAndTokenId setters
    //
    function initializeOwnerRoyaltiesByTokenAndTokenId(address token, uint256 tokenId) external override requireOwner {
        ownerRoyaltiesByTokenAndTokenId[keccak256(abi.encode(token, tokenId))].initialized = true;
    }

    function pushOwnerRoyaltyByTokenAndTokenId(
        address token,
        uint256 tokenId,
        LibPartTypes.Part memory royalty
    ) external override requireOwner {
        ownerRoyaltiesByTokenAndTokenId[keccak256(abi.encode(token, tokenId))].royalties.push(royalty);
    }

    function deleteOwnerRoyaltiesByTokenAndTokenId(address token, uint256 tokenId) external override requireOwner {
        delete ownerRoyaltiesByTokenAndTokenId[keccak256(abi.encode(token, tokenId))].royalties;
    }

    // creatorRoyaltiesByTokenAndTokenId setters
    //
    function initializeCreatorRoyaltiesByTokenAndTokenId(
        address token,
        uint256 tokenId
    ) external override requireOwner {
        creatorRoyaltiesByTokenAndTokenId[keccak256(abi.encode(token, tokenId))].initialized = true;
    }

    function pushCreatorRoyaltyByTokenAndTokenId(
        address token,
        uint256 tokenId,
        LibPartTypes.Part memory royalty
    ) external override requireOwner {
        creatorRoyaltiesByTokenAndTokenId[keccak256(abi.encode(token, tokenId))].royalties.push(royalty);
    }

    function deleteCreatorRoyaltiesByTokenAndTokenId(address token, uint256 tokenId) external override requireOwner {
        delete creatorRoyaltiesByTokenAndTokenId[keccak256(abi.encode(token, tokenId))].royalties;
    }

    // royaltiesByToken getter
    //
    function getRoyaltiesByToken(address token) external view override returns (LibRoyaltiesV2.RoyaltiesSet memory) {
        return royaltiesByToken[token];
    }

    // royaltiesByToken setters
    //
    function initializeRoyaltiesByToken(address token) external override requireOwner {
        royaltiesByToken[token].initialized = true;
    }

    function pushRoyaltyByToken(address token, LibPartTypes.Part memory royalty) external override requireOwner {
        royaltiesByToken[token].royalties.push(royalty);
    }

    function deleteRoyaltiesByToken(address token) external override requireOwner {
        delete royaltiesByToken[token];
    }

    // royaltiesProviders getter
    //
    function getProviderByToken(address token) external view override returns (address) {
        return royaltiesProviders[token];
    }

    // royaltiesProviders setters
    //
    function setProviderByToken(address token, address provider) external override requireOwner {
        royaltiesProviders[token] = provider;
    }
}

contract RoyaltiesRegistry is OwnableUpgradeable, UpgradeManager, UUPSUpgradeable, IRoyaltiesRegistry {
    using SafeMath for uint256;

    event RoyaltiesSetForToken(
        address indexed token,
        uint256 indexed tokenId,
        address[] royaltiesRecipients,
        uint16[] royaltiesBps,
        bytes4 setter
    );

    event RoyaltiesSetForContract(address indexed token, address[] royaltiesRecipients, uint16[] royaltiesBps);

    RoyaltiesRegistryStorage public _storage;

    bytes4 constant OWNER = bytes4(keccak256('OWNER'));
    bytes4 constant CREATOR = bytes4(keccak256('CREATOR'));

    modifier requireOwnerOrTokenOwner(address token) {
        require(
            // RoyaltiesRegistry owner must call on impl while token owner can also call on proxy
            _msgSender() == owner() || tx.origin == IOwnable(token).owner(),
            'RoyaltiesRegistry: FORBIDDEN, not contract or token owner'
        );
        _;
    }

    modifier requireOwnerOrTokenIdCreator(address token, uint256 tokenId) {
        require(
            _msgSender() == owner() || tx.origin == ICreator(token).creator(tokenId),
            'RoyaltiesRegistry: FORBIDDEN, not contract owner or token ID creator'
        );
        _;
    }

    function initialize(address _owner, address _upgradeManager) public initializer {
        _storage = new RoyaltiesRegistryStorage();

        __Ownable_init(_owner);
        __UpgradeManager_init(_upgradeManager, _owner);
        __UUPSUpgradeable_init();
    }

    // Royalties setters (to be called by RoyaltiesRegistry owner or by token owner)
    function setProviderByToken(address token, address provider) external override requireOwnerOrTokenOwner(token) {
        _storage.setProviderByToken(token, provider);
    }

    function setRoyaltiesByToken(
        address token,
        LibPartTypes.Part[] memory royalties
    ) external override requireOwnerOrTokenOwner(token) {
        // Delete previous royalties data
        _storage.deleteRoyaltiesByToken(token);
        uint16 sumRoyaltiesBps = 0;
        // Iterate over new royalties array
        address[] memory royaltiesRecipients = new address[](royalties.length);
        uint16[] memory royaltiesBps = new uint16[](royalties.length);
        for (uint256 i = 0; i < royalties.length; i++) {
            require(
                royalties[i].account != address(0x0),
                'RoyaltiesRegistry: royaltiesByToken recipient should be present'
            );
            // Register new royalties
            _storage.pushRoyaltyByToken(token, royalties[i]);
            sumRoyaltiesBps += royalties[i].value;
            // Split royalties (array of structs) into two arrays to be passed the even emitter function on the proxy
            royaltiesRecipients[i] = address(royalties[i].account);
            royaltiesBps[i] = royalties[i].value;
        }
        // Make sure total royalties do not represent more than 100% of token sale amount
        require(sumRoyaltiesBps <= 10000, 'RoyaltiesRegistry: royalties for token cannot be more than 100%');
        // Register royalties set as initialized
        _storage.initializeRoyaltiesByToken(token);
        // Emit RoyaltiesSetForContract event from proxy
        emit RoyaltiesSetForContract(token, royaltiesRecipients, royaltiesBps);
    }

    function setOwnerRoyaltiesByTokenAndTokenId(
        address token,
        uint256 tokenId,
        LibPartTypes.Part[] memory royalties
    ) external override requireOwnerOrTokenOwner(token) {
        // Delete previous royalties data
        _storage.deleteOwnerRoyaltiesByTokenAndTokenId(token, tokenId);
        uint256 sumRoyalties = 0;
        // Iterate over new royalties array
        address[] memory royaltiesRecipients = new address[](royalties.length);
        uint16[] memory royaltiesBps = new uint16[](royalties.length);
        for (uint256 i = 0; i < royalties.length; i++) {
            require(
                royalties[i].account != address(0x0),
                'RoyaltiesRegistry: ownerRoyaltiesByTokenAndTokenId recipient should be present'
            );
            // Register new royalties
            _storage.pushOwnerRoyaltyByTokenAndTokenId(token, tokenId, royalties[i]);
            sumRoyalties += royalties[i].value;
            // Split the royalties array of structs into two arrays of elementary types
            // to be passed to the event emitter function on the proxy
            royaltiesRecipients[i] = address(royalties[i].account);
            royaltiesBps[i] = royalties[i].value;
        }
        // Make sure total royalties do not represent more than 100% of token sale amount
        require(sumRoyalties <= 10000, 'RoyaltiesRegistry: royalties for token and tokenID cannot be more than 100%');
        // Register royalties set as initialized
        _storage.initializeOwnerRoyaltiesByTokenAndTokenId(token, tokenId);
        // Emit RoyaltiesSetForToken event from proxy
        emit RoyaltiesSetForToken(token, tokenId, royaltiesRecipients, royaltiesBps, OWNER);
    }

    function setCreatorRoyaltiesByTokenAndTokenId(
        address token,
        uint256 tokenId,
        LibPartTypes.Part[] memory royalties
    ) external override requireOwnerOrTokenIdCreator(token, tokenId) {
        // Delete previous royalties data
        _storage.deleteCreatorRoyaltiesByTokenAndTokenId(token, tokenId);
        uint16 sumRoyaltiesBps = 0;
        // Iterate over new royalties array
        address[] memory royaltiesRecipients = new address[](royalties.length);
        uint16[] memory royaltiesBps = new uint16[](royalties.length);
        for (uint256 i = 0; i < royalties.length; i++) {
            require(
                royalties[i].account != address(0x0),
                'RoyaltiesRegistry: creatorRoyaltiesByTokenAndTokenId recipient should be present'
            );
            // Register new royalties
            _storage.pushCreatorRoyaltyByTokenAndTokenId(token, tokenId, royalties[i]);
            sumRoyaltiesBps += royalties[i].value;
            // Split the royalties array of structs into two arrays of elementary types
            // to be passed to the event emitter function on the proxy
            royaltiesRecipients[i] = address(royalties[i].account);
            royaltiesBps[i] = royalties[i].value;
        }
        // Make sure total royalties do not represent more than 100% of token sale amount
        require(
            sumRoyaltiesBps <= 10000,
            'RoyaltiesRegistry: royalties for token and tokenID cannot be more than 100%'
        );
        // Register royalties set as initialized
        _storage.initializeCreatorRoyaltiesByTokenAndTokenId(token, tokenId);
        // Emit RoyaltiesSetForToken event from proxy
        emit RoyaltiesSetForToken(token, tokenId, royaltiesRecipients, royaltiesBps, CREATOR);
    }

    // Provider getter
    function getProviderByToken(address token) external view override returns (address) {
        return _storage.getProviderByToken(token);
    }

    // Royalties getter
    function getRoyalties(address token, uint256 tokenId) external view override returns (LibPartTypes.Part[] memory) {
        // Get owner royalties from storage using token address and id
        LibRoyaltiesV2.RoyaltiesSet memory ownerRoyaltiesSet = _storage.getOwnerRoyaltiesByTokenAndTokenId(
            token,
            tokenId
        );

        // If owner royalties were not set in storage using token address and id,
        // get owner royalties using token address only
        if (!ownerRoyaltiesSet.initialized) {
            ownerRoyaltiesSet = _storage.getRoyaltiesByToken(token);
        }

        // Get creator royalties from storage using token address and id
        LibRoyaltiesV2.RoyaltiesSet memory creatorRoyaltiesSet = _storage.getCreatorRoyaltiesByTokenAndTokenId(
            token,
            tokenId
        );

        // We have royalties from both sources -> merge them and return the result
        if (ownerRoyaltiesSet.initialized && creatorRoyaltiesSet.initialized) {
            LibPartTypes.Part[] memory mergedRoyalties = new LibPartTypes.Part[](
                ownerRoyaltiesSet.royalties.length + creatorRoyaltiesSet.royalties.length
            );
            for (uint256 i = 0; i < ownerRoyaltiesSet.royalties.length; i++) {
                mergedRoyalties[i].account = ownerRoyaltiesSet.royalties[i].account;
                mergedRoyalties[i].value = ownerRoyaltiesSet.royalties[i].value;
            }
            for (uint256 i = 0; i < creatorRoyaltiesSet.royalties.length; i++) {
                mergedRoyalties[ownerRoyaltiesSet.royalties.length + i].account = creatorRoyaltiesSet
                    .royalties[i]
                    .account;
                mergedRoyalties[ownerRoyaltiesSet.royalties.length + i].value = creatorRoyaltiesSet.royalties[i].value;
            }

            return mergedRoyalties;

            // We only have owner royalties
        } else if (ownerRoyaltiesSet.initialized && !creatorRoyaltiesSet.initialized) {
            return ownerRoyaltiesSet.royalties;

            // We only have creator royalties
        } else if (!ownerRoyaltiesSet.initialized && creatorRoyaltiesSet.initialized) {
            return creatorRoyaltiesSet.royalties;

            // We have no royalties in the storage
        } else {
            // Check the external provider for this token address and id
            (bool success, LibPartTypes.Part[] memory providerRoyalties) = providerExtractor(token, tokenId);

            if (success) {
                return providerRoyalties;

                // If nothing is found, check the token contract itself assuming it implements Rarible's RoyaltiesV1/V2 standards
            } else {
                LibPartTypes.Part[] memory contractRoyalties = royaltiesFromContract(token, tokenId);

                // Here we either return the contract based royalties or an empty array as we don't have royalties to return
                return contractRoyalties;
            }
        }
    }

    // This function fetches royalties from the token contract
    function royaltiesFromContract(address token, uint256 tokenId) internal view returns (LibPartTypes.Part[] memory) {
        try IERC165(token).supportsInterface(LibRoyaltiesV2._INTERFACE_ID_ROYALTIES) returns (
            bool id_royalties_supported
        ) {
            if (id_royalties_supported) {
                try IRoyaltiesV2(token).getRaribleV2Royalties(tokenId) returns (LibPartTypes.Part96[] memory res) {
                    LibPartTypes.Part[] memory result = new LibPartTypes.Part[](res.length);
                    for (uint256 i = 0; i < res.length; i++) {
                        result[i].value = uint16(res[i].value);
                        result[i].account = res[i].account;
                    }
                    return result;
                } catch {}
            } else {
                address payable[] memory recipients;

                try IERC165(token).supportsInterface(LibRoyaltiesV1._INTERFACE_ID_FEE_RECIPIENTS) returns (
                    bool id_fee_recipients_supported
                ) {
                    if (id_fee_recipients_supported) {
                        try IRoyaltiesV1(token).getFeeRecipients(tokenId) returns (address payable[] memory res) {
                            recipients = res;
                        } catch {
                            return new LibPartTypes.Part[](0);
                        }
                    }
                } catch {}

                uint256[] memory values;

                try IERC165(token).supportsInterface(LibRoyaltiesV1._INTERFACE_ID_FEE_BPS) returns (
                    bool id_fee_bps_supported
                ) {
                    if (id_fee_bps_supported) {
                        try IRoyaltiesV1(token).getFeeBps(tokenId) returns (uint256[] memory res) {
                            values = res;
                        } catch {
                            return new LibPartTypes.Part[](0);
                        }
                    }
                } catch {}

                if (values.length != recipients.length) {
                    return new LibPartTypes.Part[](0);
                }
                LibPartTypes.Part[] memory result = new LibPartTypes.Part[](values.length);
                for (uint256 i = 0; i < values.length; i++) {
                    result[i].value = uint16(values[i]);
                    result[i].account = recipients[i];
                }
                return result;
            }
        } catch {}
        return new LibPartTypes.Part[](0);
    }

    // This function fetches royalties from an external royalties provider (only one can be set per token)
    // OpenSea royalties are currently not available to fetch from the blockchain
    function providerExtractor(
        address token,
        uint256 tokenId
    ) internal view returns (bool success, LibPartTypes.Part[] memory royalties) {
        address providerAddress = _storage.getProviderByToken(token);
        uint256 sumBps = 0; // using uint256 so we can use SafeMath operators to prevent variable overflow
        if (providerAddress != address(0x0)) {
            // try assuming uint16 is used for royalties base points as implemented e.g. by us
            try IRoyaltiesRegistry(providerAddress).getRoyalties(token, tokenId) returns (
                LibPartTypes.Part[] memory royaltiesByProvider
            ) {
                if (royaltiesByProvider.length > 0) {
                    for (uint256 i = 0; i < royaltiesByProvider.length; i++) {
                        sumBps = sumBps.add(uint256(royaltiesByProvider[i].value));
                    }
                    royalties = royaltiesByProvider;
                }
            } catch {}

            // try assuming uint96 is used for royalties base points as implemented e.g. by Rarible
            try IRoyaltiesProviders(providerAddress).getRoyalties(token, tokenId) returns (
                LibPartTypes.Part96[] memory royaltiesByProvider
            ) {
                if (royaltiesByProvider.length > 0) {
                    for (uint256 i = 0; i < royaltiesByProvider.length; i++) {
                        royalties[i].account = royaltiesByProvider[i].account;
                        royalties[i].value = uint16(royaltiesByProvider[i].value);
                        sumBps = sumBps.add(uint256(royaltiesByProvider[i].value));
                    }
                }
            } catch {}

            // try the pattern that LooksRare uses
            try IRoyaltiesProviders(providerAddress).royaltyFeeInfoCollection(token) returns (
                LibPartTypes.FeeInfo memory royaltiesByProvider
            ) {
                if (royaltiesByProvider.setter != address(0x0)) {
                    // we have to set the length of the array, otherwise the call will revert
                    royalties = new LibPartTypes.Part[](1);
                    royalties[0].account = payable(royaltiesByProvider.receiver);
                    royalties[0].value = uint16(royaltiesByProvider.fee);
                    sumBps = royaltiesByProvider.fee;
                }
            } catch {}
        }
        // if we find no or out-of-range data from the provider we return empty royalties
        if (sumBps == 0 || sumBps > 10000) {
            return (false, new LibPartTypes.Part[](0));
        }

        return (true, royalties);
    }

    function _authorizeUpgrade(address newImplementation) internal virtual override onlyUpgradeManager {}
}
