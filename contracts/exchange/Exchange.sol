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

/// @title  Exchange
/// @author Energi Core
/// @notice Exchange contract handless buy and sell logic of marketplace
/// @dev    Contains buisness logic for Exchange process

pragma solidity 0.8.27;
pragma abicoder v2;

import { SafeMath } from '../libraries/SafeMath.sol';
import { LibAssetClasses } from '../libraries/LibAssetClasses.sol';
import { LibAssetTypes } from '../libraries/LibAssetTypes.sol';
import { LibOrderTypes } from '../libraries/LibOrderTypes.sol';
import { LibFillTypes } from '../libraries/LibFillTypes.sol';
import { LibPartTypes } from '../libraries/LibPartTypes.sol';
import { LibFeeSideTypes } from '../libraries/LibFeeSideTypes.sol';
import { LibOrderDataV1Types } from '../libraries/LibOrderDataV1Types.sol';

import { IWrappedCoin } from '../interfaces/IWrappedCoin.sol';
import { IExchange } from './IExchange.sol';
import { IExchangeHelper } from './helper/IExchangeHelper.sol';

import { IERC2981 } from '@openzeppelin/contracts/interfaces/IERC2981.sol';
import { IERC165 } from '@openzeppelin/contracts/interfaces/IERC165.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { IERC721 } from '@openzeppelin/contracts/token/ERC721/IERC721.sol';
import { IERC1155 } from '@openzeppelin/contracts/token/ERC1155/IERC1155.sol';

import { PausableUpgradeable } from '@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol';
import { ReentrancyGuardUpgradeable } from '@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol';
import { OwnableUpgradeable } from '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import { UUPSUpgradeable } from '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol';

import { UpgradeManager } from '../access/UpgradeManager.sol';

import { StorageBase } from '../StorageBase.sol';
import { IExchangeStorage } from './IExchangeStorage.sol';
import { IRoyaltiesRegistry } from '../royalties-registry/IRoyaltiesRegistry.sol';

contract ExchangeStorage is StorageBase, IExchangeStorage {
    // Settings
    address private helperProxy;
    address private orderBook; // Order-book service public key
    address private royaltiesRegistryProxy; // Registers details of royalties to be paid when an NFT asset is sold
    address private defaultFeeReceiver; // Receives protocol fee by default
    address private weth; // Wrapped ETH
    address private exchangeOwner;
    mapping(address => address) private feeReceivers; // Can be set for different addresses to receive protocol fee
    // when paid in different ERC20 assets
    mapping(bytes32 => uint256) private fills; // Order fills indexed by order key hashes
    // 100% of makerOrder is filled when => getFillsValue(rightOrderKeyHash) == rightOrder.takeAsset.value
    // 100% of takerOrder is filled when => getFillsValue(leftOrderKeyHash) == leftOrder.takeAsset.value
    // Fill values are only recorded on-chain for orders with non-zero salt (maker orders registered in off-chain OrderBook and taker
    // orders submitted by third party after being registered in off-chain OrderBook)
    mapping(address => bool) private allowedERC20Assets; // We only allow trading of ETH and some select ERC20 tokens
    // for ERC721 and ERC1155 assets
    uint16 private protocolFeeBps; // Protocol fee (basis points: 10000 <=> 100%) to be paid by seller of ERC721/ERC1155 asset
    // Chain Id (passing it here because Energi testnet chain doesn't return correct chain id)
    uint256 private chainId;

    constructor(
        address _helperProxy,
        address _orderBook,
        address _defaultFeeReceiver,
        address _royaltiesRegistryProxy,
        address _weth, // WETH token address (only ERC20 token allowed by default)
        uint16 _protocolFeeBps,
        uint256 _chainId,
        address _owner
    ) {
        helperProxy = _helperProxy;
        orderBook = _orderBook;
        defaultFeeReceiver = _defaultFeeReceiver;
        royaltiesRegistryProxy = _royaltiesRegistryProxy;
        weth = _weth;
        allowedERC20Assets[_weth] = true;
        protocolFeeBps = _protocolFeeBps;
        chainId = _chainId;
        exchangeOwner = _owner;
    }

    modifier requireExchangeOwner() {
        require(msg.sender == exchangeOwner, 'ExchangeStorage: Not exchange owner!');
        _;
    }

    // Getter functions
    //
    function getHelperProxy() external view override returns (address) {
        return helperProxy;
    }

    function getOrderBook() external view override returns (address) {
        return orderBook;
    }

    function getDefaultFeeReceiver() external view override returns (address) {
        return defaultFeeReceiver;
    }

    function getRoyaltiesRegistryProxy() external view override returns (address) {
        return royaltiesRegistryProxy;
    }

    function getFeeReceiver(address _token) external view override returns (address) {
        // Use address(0) as token address for ETH
        if (feeReceivers[_token] == address(0)) {
            return defaultFeeReceiver;
        }
        return feeReceivers[_token];
    }

    function getWETH() external view override returns (address) {
        return weth;
    }

    function getFill(bytes32 _orderKeyHash) external view override returns (uint256) {
        return fills[_orderKeyHash];
    }

    function isERC20AssetAllowed(address _erc20AssetAddress) external view override returns (bool) {
        return allowedERC20Assets[_erc20AssetAddress];
    }

    function getProtocolFeeBps() external view override returns (uint16) {
        return protocolFeeBps;
    }

    function getChainId() external view override returns (uint256) {
        return chainId;
    }

    // Setter functions (not all implemented in Exchange contract but available for future upgrades)
    //
    function setHelperProxy(address _helperProxy) external override requireOwner {
        helperProxy = _helperProxy;
    }

    function setOrderBook(address _orderBook) external override requireOwner {
        orderBook = _orderBook;
    }

    function setDefaultFeeReceiver(address _newDefaultFeeReceiver) public override requireExchangeOwner {
        defaultFeeReceiver = _newDefaultFeeReceiver;
    }

    function setRoyaltiesRegistryProxy(address _royaltiesRegistryProxy) public override requireOwner {
        royaltiesRegistryProxy = _royaltiesRegistryProxy;
    }

    function setFeeReceiver(address _token, address _recipient) public override requireExchangeOwner {
        // Use address(0) as token address for ETH
        feeReceivers[_token] = _recipient;
    }

    function setWETH(address _weth) public override requireOwner {
        weth = _weth;
    }

    function setFill(bytes32 _orderKeyHash, uint256 _value) external override requireOwner {
        fills[_orderKeyHash] = _value;
    }

    function setERC20AssetAllowed(address _erc20AssetAddress, bool _isAllowed) external override requireExchangeOwner {
        allowedERC20Assets[_erc20AssetAddress] = _isAllowed;
    }

    function setProtocolFeeBps(uint16 _newProtocolFeeBps) public override requireExchangeOwner {
        protocolFeeBps = _newProtocolFeeBps;
    }

    function setChainId(uint256 _newChainId) public override requireOwner {
        chainId = _newChainId;
    }

    function setExchangeOwner(address _exchangeOwner) public override requireExchangeOwner {
        exchangeOwner = _exchangeOwner;
    }
}

contract Exchange is
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    OwnableUpgradeable,
    UpgradeManager,
    IExchange,
    UUPSUpgradeable
{
    using SafeMath for uint256;
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

    // Constants
    bytes4 constant INTERFACE_ID_ERC2981 = bytes4(keccak256('royaltyInfo(uint256,uint256)'));
    bytes4 constant TO_MAKER = bytes4(keccak256('TO_MAKER'));
    bytes4 constant TO_TAKER = bytes4(keccak256('TO_TAKER'));
    bytes4 constant PROTOCOL = bytes4(keccak256('PROTOCOL'));
    bytes4 constant ROYALTY = bytes4(keccak256('ROYALTY'));
    bytes4 constant ORIGIN = bytes4(keccak256('ORIGIN'));
    bytes4 constant PAYOUT = bytes4(keccak256('PAYOUT'));
    uint256 private constant UINT256_MAX = 2 ** 256 - 1;

    // Storage
    ExchangeStorage public _storage;

    address public proxy;

    modifier onlyWETH() {
        require(
            _msgSender() == _storage.getWETH(),
            'Exchange: FORBIDDEN, ETH can only be received from the WETH contract'
        );
        _;
    }

    function initialize(
        address _proxy,
        address _helperProxy,
        address _orderBook, // Order-book service public key
        address _defaultFeeReceiver, // Protocol fee is forwarded to this address by default
        address _royaltiesRegistryProxy,
        address _weth, // WETH token address (only ERC20 token allowed by default)
        address _owner, // Owner of the  smart contract
        address _upgradeManager,
        uint16 _protocolFeeBps,
        uint256 _chainId
    ) public initializer {
        proxy = _proxy;
        _storage = new ExchangeStorage(
            _helperProxy,
            _orderBook,
            _defaultFeeReceiver,
            _royaltiesRegistryProxy,
            _weth,
            _protocolFeeBps,
            _chainId,
            _owner
        );

        __Ownable_init(_owner);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UpgradeManager_init(_upgradeManager, _owner);
        __UUPSUpgradeable_init();
    }

    // Exchange functions
    //
    // Cancel an order by setting its fill to Max(uint256) so that it can't ever be matched
    function cancelOrder(LibOrderTypes.Order memory order) public override whenNotPaused {
        require(tx.origin == order.maker, 'Exchange: not order maker');
        require(order.salt != 0, 'Exchange: 0 salt cannot be used');
        bytes32 orderKeyHash = IExchangeHelper(_storage.getHelperProxy()).hashKey(order);
        _storage.setFill(orderKeyHash, UINT256_MAX);
        // Emit CancelOrder event from proxy
        emit CancelOrder(orderKeyHash);
    }

    // Match orders
    function matchOrders(
        LibOrderTypes.Order memory orderLeft, // Taker order
        bytes memory signatureLeft, // Taker order hash signature
        uint256 matchLeftBeforeTimestamp, // Timestamp after which matching taker order is not allowed by order-book
        bytes memory orderBookSignatureLeft, // Order-book signature for taker order matchAllowance
        LibOrderTypes.Order memory orderRight, // Maker order
        bytes memory signatureRight, // Maker order hash signature
        uint256 matchRightBeforeTimestamp, // Timestamp after which matching maker order is not allowed by order-book
        bytes memory orderBookSignatureRight // Order-book signature for maker order matchAllowance
    ) public payable override whenNotPaused {
        // Validate maker and taker orders:
        // Make sure maker does not pay with ETH
        require(
            orderRight.makeAsset.assetType.assetClass != LibAssetClasses.ETH_ASSET_CLASS,
            'Exchange: maker cannot pay with ETH, use WETH instead'
        );
        IExchangeHelper helper = IExchangeHelper(_storage.getHelperProxy());
        if (orderLeft.collectionBid || orderRight.collectionBid) {
            require(
                _msgSender() == address(helper),
                'Exchange: collection bid orders must be submitted via ExchangeHelper contract'
            );
        }
        // Make sure specific ERC20 tokens used in orders are allowed
        IExchangeHelper(_storage.getHelperProxy()).checkERC20TokensAllowed(orderLeft, orderRight);
        // Validate order-book's matchAllowance signature(s)
        // Assign chainId and orderBook first to avoid multiple calls
        uint256 chainId = _storage.getChainId();
        (bytes32 leftOrderKeyHash, bytes32 rightOrderKeyHash) = helper.verifyMatch(
            orderLeft,
            orderRight,
            matchLeftBeforeTimestamp,
            matchRightBeforeTimestamp,
            orderBookSignatureLeft,
            orderBookSignatureRight,
            proxy,
            _storage.getOrderBook(),
            chainId
        );
        // Verify maker and taker orders signatures
        helper.verifyOrder(orderRight, signatureRight, tx.origin, proxy, chainId);
        helper.verifyOrder(orderLeft, signatureLeft, tx.origin, proxy, chainId);
        // Match assets and proceed to transfers
        matchAndTransfer(helper, orderLeft, orderRight, leftOrderKeyHash, rightOrderKeyHash);
    }

    // Match orders by batch
    function batchMatchOrders(
        LibOrderTypes.Order[] calldata orders, // Orders array (matching orders at indexes i and i + 1)
        bytes[] calldata signatures, // Orders hashes signatures array
        uint256[] calldata matchBeforeTimestamps, // Array of timestamps after which matching orders is not allowed by order-book
        bytes[] calldata orderBookSignatures // Array of order-book signatures for orders matchAllowances
    ) external payable override whenNotPaused {
        require(orders.length % 2 == 0, 'Exchange: invalid orders array length');
        require(
            orders.length == signatures.length &&
                signatures.length == matchBeforeTimestamps.length &&
                matchBeforeTimestamps.length == orderBookSignatures.length,
            'Exchange: arrays length mismatch'
        );
        // Loop over orders array, matching orders at indexes i and i + 1
        for (uint256 i = 0; i < orders.length; i += 2) {
            // Match orders at indexes i and i+1
            matchOrders(
                orders[i],
                signatures[i],
                matchBeforeTimestamps[i],
                orderBookSignatures[i],
                orders[i + 1],
                signatures[i + 1],
                matchBeforeTimestamps[i + 1],
                orderBookSignatures[i + 1]
            );
        }
    }

    function matchAndTransfer(
        IExchangeHelper helper,
        LibOrderTypes.Order memory orderLeft, // Taker order
        LibOrderTypes.Order memory orderRight, // Maker order
        bytes32 leftOrderKeyHash, // Taker order keyHash
        bytes32 rightOrderKeyHash // Maker order keyHash
    ) internal {
        // Match assets and return AssetType objects
        (
            LibAssetTypes.AssetType memory makerAssetType, // Asset type order maker expects to receive
            LibAssetTypes.AssetType memory takerAssetType // Asset type order taker expects to receive
        ) = helper.matchAssets(orderLeft, orderRight);
        // Calculate orders fills
        LibFillTypes.FillResult memory newFill = helper.calculateFills(
            orderLeft,
            orderRight,
            leftOrderKeyHash,
            rightOrderKeyHash
        );
        // Process ETH and WETH conversions and transfers to proxy and update makerAssetType if needed
        (makerAssetType) = processEthAndWeth(helper, makerAssetType, takerAssetType, orderLeft, orderRight, newFill);
        // Transfer assets
        doTransfers(helper, takerAssetType, makerAssetType, newFill, orderLeft, orderRight);
        // Emit Match and MatchAssetDetails events from proxy
        emit Match(
            leftOrderKeyHash,
            rightOrderKeyHash,
            orderLeft.maker,
            orderRight.maker,
            newFill.leftOrderTakeValue,
            newFill.rightOrderTakeValue
        );
    }

    function processEthAndWeth(
        IExchangeHelper helper,
        LibAssetTypes.AssetType memory makerAssetType, // Asset type order maker expects to receive
        LibAssetTypes.AssetType memory takerAssetType, // Asset type order taker expects to receive
        LibOrderTypes.Order memory orderLeft,
        LibOrderTypes.Order memory orderRight,
        LibFillTypes.FillResult memory newFill
    ) internal returns (LibAssetTypes.AssetType memory _makerAssetType) {
        // Calculate totalMakeValue and totalTakeValue
        uint256 totalMakeValue; // Total value to be sent by maker to taker
        uint256 totalTakeValue; // Total value to be sent by taker to maker
        (totalMakeValue, totalTakeValue) = helper.calculateTotalTakeAndMakeValues(
            orderLeft,
            orderRight,
            takerAssetType,
            makerAssetType,
            newFill
        );
        _makerAssetType = makerAssetType;
        // Check msg.value
        if (msg.value > 0) {
            // If msg.value > 0, taker should be sending ETH and maker should expect to receive ETH or WETH
            require(
                orderLeft.makeAsset.assetType.assetClass == LibAssetClasses.ETH_ASSET_CLASS &&
                    (makerAssetType.assetClass == LibAssetClasses.ETH_ASSET_CLASS ||
                        makerAssetType.assetClass == LibAssetClasses.WETH_ASSET_CLASS),
                'Exchange: msg.value should be 0'
            );

            // Check if maker wishes to receive ETH or WETH
            if (makerAssetType.assetClass == LibAssetClasses.ETH_ASSET_CLASS) {
                // Maker wishes to receive ETH
                // Forward totalTakeValue to proxy (proxy holds funds)
                // selector = bytes4(keccak256(bytes('receiveETH()')))
                (bool success, bytes memory data) = proxy.call{ value: totalTakeValue }(
                    abi.encodeWithSelector(0x3ecfd51e)
                );
                require(
                    success && (data.length == 0 || abi.decode(data, (bool))),
                    'Exchange: failed to forward totalTakeValue to proxy'
                );
            } else {
                // Maker wishes to receive WETH, but taker sent ETH
                // Deposit ETH to get WETH
                address weth = _storage.getWETH();
                IWrappedCoin(weth).deposit{ value: totalTakeValue }();
                // Transfer WETH to proxy (proxy holds funds)
                _transferERC20(weth, proxy, totalTakeValue);
                // Update maker asset class (maker will receive WETH from proxy)
                _makerAssetType.assetClass = LibAssetClasses.PROXY_WETH_ASSET_CLASS;
            }
        } else if (
            makerAssetType.assetClass == LibAssetClasses.ETH_ASSET_CLASS ||
            takerAssetType.assetClass == LibAssetClasses.ETH_ASSET_CLASS
        ) {
            address weth = _storage.getWETH();
            if (makerAssetType.assetClass == LibAssetClasses.ETH_ASSET_CLASS) {
                // If msg.value == 0 and maker wishes to receive ETH
                // Taker must be sending WETH
                require(
                    orderLeft.makeAsset.assetType.assetClass == LibAssetClasses.WETH_ASSET_CLASS,
                    'Exchange: msg.value should be > 0 or taker should be sending WETH'
                );
                // Transfer WETH from taker to implementation
                _transferFromERC20(weth, orderLeft.maker, address(this), totalTakeValue);
                // Redeem ETH for WETH
                IWrappedCoin(weth).withdraw(totalTakeValue);
                // Forward ETH to proxy via receiveETH function (proxy holds funds)
                (bool success, bytes memory data) = proxy.call{ value: totalTakeValue }(
                    abi.encodeWithSelector(0x3ecfd51e)
                );
                require(
                    success && (data.length == 0 || abi.decode(data, (bool))),
                    'Exchange: failed to forward redeemed ETH to proxy after redeeming from taker WETH'
                );
            } else {
                // If msg.value == 0 and taker is expecting ETH
                // Maker must be sending WETH (because it is not allowed for maker to be sending ETH)
                require(
                    orderRight.makeAsset.assetType.assetClass == LibAssetClasses.WETH_ASSET_CLASS,
                    'Exchange: maker should be sending WETH'
                );
                // Transfer WETH from maker to implementation
                _transferFromERC20(weth, orderRight.maker, address(this), totalMakeValue);
                // Redeem ETH for WETH
                IWrappedCoin(weth).withdraw(totalMakeValue);
                // Forward ETH to proxy via receiveETH function (proxy holds funds)
                (bool success, bytes memory data) = proxy.call{ value: totalMakeValue }(
                    abi.encodeWithSelector(0x3ecfd51e)
                );
                require(
                    success && (data.length == 0 || abi.decode(data, (bool))),
                    'Exchange: failed to forward ETH to proxy after redeeming from maker WETH'
                );
            }
        } else if (makerAssetType.assetClass == LibAssetClasses.WETH_ASSET_CLASS) {
            // If msg.value == 0 and maker wishes to receive WETH
            // Taker must be sending WETH
            require(
                orderLeft.makeAsset.assetType.assetClass == LibAssetClasses.WETH_ASSET_CLASS,
                'Exchange: msg.value should be > 0 or taker should be sending WETH'
            );
        }
        // In all other cases no ETH will be transferred
    }

    function doTransfers(
        IExchangeHelper helper,
        LibAssetTypes.AssetType memory _takerAssetType,
        LibAssetTypes.AssetType memory _makerAssetType,
        LibFillTypes.FillResult memory _fill,
        LibOrderTypes.Order memory _leftOrder,
        LibOrderTypes.Order memory _rightOrder
    ) internal {
        // Determine fee side (and fee asset)
        LibFeeSideTypes.FeeSide feeSide = helper.getFeeSide(_makerAssetType.assetClass, _takerAssetType.assetClass);
        // Get right and left order data (parse payouts and origin fees)
        LibOrderDataV1Types.DataV1 memory leftOrderData = helper.parse(_leftOrder);
        LibOrderDataV1Types.DataV1 memory rightOrderData = helper.parse(_rightOrder);
        if (feeSide == LibFeeSideTypes.FeeSide.MAKE) {
            // If maker is paying the protocol fee
            // Transfer make asset from maker to taker and transfer protocol fee, royalties and origin fees
            doTransfersWithFees(
                helper,
                _fill.leftOrderTakeValue, // Value to be transferred from maker to taker
                _rightOrder.maker, // Maker
                rightOrderData, // Maker order data
                leftOrderData, // Taker order data
                _makerAssetType, // Maker asset type
                _takerAssetType, // Taker asset type
                TO_TAKER // Payouts will be transferred to taker side
            );
            // Transfer order payouts from taker side to maker side
            transferPayouts(
                helper,
                _makerAssetType, // Maker asset type
                _fill.rightOrderTakeValue, // Value to be transferred from taker to maker
                _leftOrder.maker, // Taker
                rightOrderData.payouts, // Maker order payouts data
                TO_MAKER // Payouts will be transferred to maker side
            );
        } else if (feeSide == LibFeeSideTypes.FeeSide.TAKE) {
            // If taker is paying the protocol fee
            // Transfer take asset from taker to maker and transfer protocol fee, royalties and origin fees
            doTransfersWithFees(
                helper,
                _fill.rightOrderTakeValue, // Value to be transferred from taker to maker
                _leftOrder.maker, // Taker
                leftOrderData, // Taker order data
                rightOrderData, // Maker order data
                _takerAssetType, // Taker asset type
                _makerAssetType, // Maker asset type
                TO_MAKER // Payouts will be transferred to maker side
            );
            // Transfer order payouts from maker side to taker side
            transferPayouts(
                helper,
                _takerAssetType, // Taker asset type
                _fill.leftOrderTakeValue, // Value to be transferred from maker to taker
                _rightOrder.maker, // Maker
                leftOrderData.payouts, // Taker order payouts data
                TO_TAKER // Payouts will be transferred to taker side
            );
        } else {
            // If no trading fee is paid: transfer payouts to taker and maker
            transferPayouts(
                helper,
                _makerAssetType,
                _fill.leftOrderTakeValue,
                _leftOrder.maker,
                rightOrderData.payouts,
                TO_MAKER
            );
            transferPayouts(
                helper,
                _takerAssetType,
                _fill.rightOrderTakeValue,
                _rightOrder.maker,
                leftOrderData.payouts,
                TO_TAKER
            );
        }
    }

    function doTransfersWithFees(
        IExchangeHelper helper,
        uint256 _amount,
        address _from,
        LibOrderDataV1Types.DataV1 memory _feePayerOrderData,
        LibOrderDataV1Types.DataV1 memory _otherOrderData,
        LibAssetTypes.AssetType memory _feePayerAssetType,
        LibAssetTypes.AssetType memory _otherAssetType,
        bytes4 _transferDirection
    ) internal {
        // Add origin fees to order amount to get _totalAmount
        // Origin fees are paid by taker if they are defined in taker order, and/or by maker if they are defined in
        // maker order. Only taker origin fees are added on top of _totalAmount, while maker origin fees are subtracted
        // from the amount that is paid to maker.
        uint256 _totalAmount = helper.calculateTotalAmount(_amount, _feePayerOrderData.originFees);
        // Transfer protocol fee (ERC721/ERC1155 seller pays protocol fee by receiving less than the order amount)
        uint256 rest = transferProtocolFee(helper, _totalAmount, _amount, _from, _otherAssetType, _transferDirection);
        // Transfer royalties
        rest = transferRoyalties(helper, _otherAssetType, _feePayerAssetType, rest, _amount, _from, _transferDirection);
        // Transfer origin fees (both sides)
        // Order data may carry instructions to distribute origin fees to several addresses as a percentage of the order
        // amount
        (rest, ) = transferFees(
            helper,
            _otherAssetType,
            rest,
            _amount,
            _feePayerOrderData.originFees,
            _from,
            _transferDirection,
            ORIGIN
        );
        (rest, ) = transferFees(
            helper,
            _otherAssetType,
            rest,
            _amount,
            _otherOrderData.originFees,
            _from,
            _transferDirection,
            ORIGIN
        );
        // Transfer order payouts (one side)
        // Order data may carry instructions to distribute payouts to several addresses as a percentage of the order
        // amount. If this is not the case, by default all payouts are made to order maker.
        transferPayouts(helper, _otherAssetType, rest, _from, _otherOrderData.payouts, _transferDirection);
    }

    // Transfer functions
    //
    function transferProtocolFee(
        IExchangeHelper helper,
        uint256 _totalAmount,
        uint256 _amount,
        address _from,
        LibAssetTypes.AssetType memory _assetType,
        bytes4 _transferDirection
    ) internal returns (uint256) {
        // We calculate the following:
        // 1) _protocolFee: it is the total protocol fee to be transferred by feePayer. Expressed as a percentage of the
        // order amount, it is the value of PROTOCOL_FEE. It is paid by the side of the order that sells the
        // ERC721/ERC1155 asset (transferred by feePayer but subtracted from the amount that will be
        // received by the other side of the order). This is achieved by passing protocolFee to
        // LibExchange.subFeeInBps function below, and subtracting it from the totalAmount value which has been calculated
        // as totalAmount = amount + originFees
        // 2) _rest: it is the amount that will remain after transferring protocol fee. It is calculated in
        // LibExchange.subFeeInBps as _rest = _totalAmount - protocolFee
        (uint256 _rest, uint256 _protocolFee) = helper.subFeeInBps(_totalAmount, _amount, _storage.getProtocolFeeBps());
        if (_protocolFee > 0) {
            // Determine fee asset address
            address tokenAddress = address(0);
            if (
                _assetType.assetClass == LibAssetClasses.ERC20_ASSET_CLASS ||
                _assetType.assetClass == LibAssetClasses.WETH_ASSET_CLASS ||
                _assetType.assetClass == LibAssetClasses.PROXY_WETH_ASSET_CLASS
            ) {
                tokenAddress = abi.decode(_assetType.data, (address));
                // If token is WETH, ETH is redeemed before transferring protocol fee in ETH
                address weth = _storage.getWETH();
                if (tokenAddress == weth) {
                    if (_assetType.assetClass == LibAssetClasses.PROXY_WETH_ASSET_CLASS) {
                        // Transfer WETH from proxy to implementation
                    } else {
                        // Transfer WETH from user to implementation via proxy
                        _transferFromERC20(weth, _from, address(this), _protocolFee);
                    }
                    // Redeem ETH for WETH
                    IWrappedCoin(weth).withdraw(_protocolFee);
                    // Forward ETH to proxy via receiveETH function (proxy holds funds)
                    // selector = bytes4(keccak256(bytes('receiveETH()')))
                    (bool success, bytes memory data) = proxy.call{ value: _protocolFee }(
                        abi.encodeWithSelector(0x3ecfd51e)
                    );
                    require(
                        success && (data.length == 0 || abi.decode(data, (bool))),
                        'Exchange::transferProtocolFee: failed to forward redeemed ETH to proxy'
                    );
                    // Update _assetType to ETH
                    _assetType = LibAssetTypes.AssetType(LibAssetClasses.ETH_ASSET_CLASS, bytes(''));
                    // Update tokenAddress accordingly (address(0) <=> ETH)
                    tokenAddress = address(0);
                }
            }
            // Transfer protocol fee
            transfer(
                LibAssetTypes.Asset(_assetType, _protocolFee),
                _from,
                _storage.getFeeReceiver(tokenAddress),
                _transferDirection,
                PROTOCOL
            );
        }
        return _rest;
    }

    function transferRoyalties(
        IExchangeHelper helper,
        LibAssetTypes.AssetType memory _otherAssetType,
        LibAssetTypes.AssetType memory _feePayerAssetType,
        uint256 _rest,
        uint256 _amount,
        address _from,
        bytes4 _transferDirection
    ) internal returns (uint256 _newRest) {
        // Get royalties to be paid for considered asset (expressed in bps of order amount)
        LibPartTypes.Part[] memory royalties = helper.getRoyaltiesByAssetType(
            _feePayerAssetType,
            _storage.getRoyaltiesRegistryProxy()
        );
        // Initialize _newRest in case no royalty is paid
        _newRest = _rest;
        // Transfer royalties
        uint256 totalRoyaltiesBps;
        if (royalties.length == 0) {
            // Try to get royalties from the token contract itself assuming it implements EIP-2981 standard
            (address tokenAddress, uint256 tokenId) = abi.decode(_feePayerAssetType.data, (address, uint256));
            // Check first if token supports ERC2981 interface
            try IERC165(tokenAddress).supportsInterface(INTERFACE_ID_ERC2981) returns (bool isSupported) {
                if (isSupported) {
                    // If token supports ERC2981 interface, call royaltyInfo()
                    (address _royaltyReceiver, uint256 _royaltyAmount) = IERC2981(tokenAddress).royaltyInfo(
                        tokenId,
                        _amount
                    );
                    // ERC-2981 royaltyInfo returns absolute royalty amount, here we calculate the royalty value in bps
                    totalRoyaltiesBps = (_royaltyAmount * 10000) / _amount;
                    // Transfer royalties
                    _newRest = transferERC2981Royalties(
                        _otherAssetType,
                        _rest,
                        _royaltyReceiver,
                        _royaltyAmount,
                        _from,
                        _transferDirection,
                        ROYALTY
                    );
                }
            } catch {}
        } else {
            // Transfer royalties
            (_newRest, totalRoyaltiesBps) = transferFees(
                helper,
                _otherAssetType,
                _rest,
                _amount,
                royalties,
                _from,
                _transferDirection,
                ROYALTY
            );
        }
        // Make sure royalties are not above 50% of sale price
        require(totalRoyaltiesBps <= 5000, 'Exchange: royalties can not be above 50%');
    }

    // This function transfers royalties or origin fees
    function transferFees(
        IExchangeHelper helper,
        LibAssetTypes.AssetType memory _otherAssetType,
        uint256 _rest,
        uint256 _amount,
        LibPartTypes.Part[] memory _fees,
        address _from,
        bytes4 _transferDirection,
        bytes4 _transferType
    ) internal returns (uint256 _newRest, uint256 _totalFeesBps) {
        _totalFeesBps = 0;
        _newRest = _rest;
        for (uint256 i = 0; i < _fees.length; i++) {
            // Add fee expressed in bps to _totalFeesBps
            _totalFeesBps = _totalFeesBps.add(_fees[i].value);
            // Subtract fee as a percentage of _amount from _newRest  and get feeValue
            (uint256 newRestValue, uint256 feeValue) = helper.subFeeInBps(_newRest, _amount, _fees[i].value);
            _newRest = newRestValue;
            // Transfer fee
            if (feeValue > 0) {
                transfer(
                    LibAssetTypes.Asset(_otherAssetType, feeValue),
                    _from,
                    _fees[i].account,
                    _transferDirection,
                    _transferType
                );
            }
        }
    }

    // This function transfers ERC2981 royalties
    function transferERC2981Royalties(
        LibAssetTypes.AssetType memory _otherAssetType,
        uint256 _rest,
        address _royaltyReceiver,
        uint256 _royaltyAmount,
        address _from,
        bytes4 _transferDirection,
        bytes4 _transferType
    ) internal returns (uint256 _newRest) {
        // Subtract royalty amount from rest
        _newRest = _rest.sub(_royaltyAmount);
        // Transfer royalty
        if (_royaltyAmount > 0) {
            transfer(
                LibAssetTypes.Asset(_otherAssetType, _royaltyAmount),
                _from,
                _royaltyReceiver,
                _transferDirection,
                _transferType
            );
        }
    }

    // This function transfers the remaining amount after protocol fee, royalties and origin fees have been transferred
    function transferPayouts(
        IExchangeHelper helper,
        LibAssetTypes.AssetType memory _assetType,
        uint256 _amount,
        address _from,
        LibPartTypes.Part[] memory _payouts,
        bytes4 _transferDirection
    ) internal {
        uint256 sumBps = 0; // 10,000 Bps == 100%
        uint256 rest = _amount;
        // Iterate over all payout addresses except the last one and transfer respective payouts
        for (uint256 i = 0; i < _payouts.length - 1; i++) {
            // Calculate value to transfer as a percentage of remaining amount
            uint256 payoutAmount = helper.bps(_amount, _payouts[i].value);
            // Add payout expressed as bps to sumBps
            sumBps = sumBps.add(_payouts[i].value);
            if (payoutAmount > 0) {
                // Subtract payoutAmount from rest
                rest = rest.sub(payoutAmount);
                // Transfer payout
                transfer(
                    LibAssetTypes.Asset(_assetType, payoutAmount),
                    _from,
                    _payouts[i].account,
                    _transferDirection,
                    PAYOUT
                );
            }
        }
        // The last payout receives whatever is left to ensure that there are no rounding issues
        LibPartTypes.Part memory lastPayout = _payouts[_payouts.length - 1];
        sumBps = sumBps.add(lastPayout.value);
        // Make sure all payouts add up to 100%
        require(sumBps == 10000, 'Exchange: the sum of all payouts did not add up to 100% of the available funds');
        if (rest > 0) {
            // Transfer last payout
            transfer(LibAssetTypes.Asset(_assetType, rest), _from, lastPayout.account, _transferDirection, PAYOUT);
        }
    }

    function transfer(
        LibAssetTypes.Asset memory _asset,
        address _from,
        address _to,
        bytes4 _transferDirection,
        bytes4 _transferType
    ) internal nonReentrant whenNotPaused {
        require(_to != address(0), 'Exchange: can not transfer to zero address');
        require(_asset.value != 0, 'Exchange: transfer amount can not be zero');

        if (_asset.assetType.assetClass == LibAssetClasses.ETH_ASSET_CLASS) {
            // Transfer ETH from proxy
            (bool os, ) = payable(_to).call{ value: _asset.value }('');
            require(os, 'Exchange: cannot send ETH');
        } else if (_asset.assetType.assetClass == LibAssetClasses.ERC721_ASSET_CLASS) {
            (address token, uint256 tokenId) = abi.decode(_asset.assetType.data, (address, uint256));
            require(_asset.value == 1, 'Exchange: can only transfer one ERC721');
            // Transfer ERC721 token from user via proxy
            IERC721(token).safeTransferFrom(_from, _to, tokenId);
        } else if (_asset.assetType.assetClass == LibAssetClasses.ERC1155_ASSET_CLASS) {
            (address token, uint256 tokenId) = abi.decode(_asset.assetType.data, (address, uint256));
            // Transfer ERC1155 token from user via proxy
            IERC1155(token).safeTransferFrom(_from, _to, tokenId, _asset.value, '');
        } else {
            if (
                _asset.assetType.assetClass == LibAssetClasses.PROXY_WETH_ASSET_CLASS ||
                _asset.assetType.assetClass == LibAssetClasses.WETH_ASSET_CLASS
            ) {
                address weth = _storage.getWETH();
                if (_asset.assetType.assetClass == LibAssetClasses.PROXY_WETH_ASSET_CLASS) {
                    // Transfer WETH from proxy
                    _transferERC20(weth, _to, _asset.value);
                } else {
                    // Transfer WETH from user via proxy
                    _transferFromERC20(weth, _from, _to, _asset.value);
                }
            } else if (_asset.assetType.assetClass == LibAssetClasses.ERC20_ASSET_CLASS) {
                address token = abi.decode(_asset.assetType.data, (address));
                // Transfer ERC20 token from user via proxy
                _transferFromERC20(token, _from, _to, _asset.value);
            } else {
                // Revert if asset class is unknown
                revert('Exchange: asset class unknown');
            }
        }

        // // Emit Transfer event from proxy
        emit Transfer(
            _asset.assetType.assetClass,
            _from,
            _to,
            _asset.assetType.data,
            _asset.value,
            _transferDirection,
            _transferType
        );
    }

    // Payable fallback function only accepts ETH redemptions from the WETH contract
    receive() external payable onlyWETH {}

    // ERC20 Asset transfer function (should never be needed but are implemented for safety)
    //
    // N.B. If it is ever needed to transfer ETH out of this contract this can be achieved by upgrading the contract.
    // Any ETH held by this contract would be transferred via self destruct to the new implementation which should
    // implement the ETH transfer function (it was not possible to implement such a function here due to contract size
    // limitation)
    //
    function safeTransferERC20(address token, address to, uint256 value) external override nonReentrant onlyOwner {
        require(_transferERC20(token, to, value), 'Exchange: failed to transfer ERC20');
    }

    // Setter functions
    //
    // Set order fill (only ExchangeHelper implementation can call)
    function setOrderFill(bytes32 orderKeyHash, uint256 fill) external override {
        require(
            _msgSender() == _storage.getHelperProxy(),
            'Exchange: FORBIDDEN, only ExchangeHelper implementation can call'
        );
        _storage.setFill(orderKeyHash, fill);
    }

    // External getter functions
    //
    function getProtocolFeeBps() external view override returns (uint16) {
        return _storage.getProtocolFeeBps();
    }

    function getDefaultFeeReceiver() external view override returns (address) {
        return _storage.getDefaultFeeReceiver();
    }

    function getFeeReceiver(address _token) external view override returns (address) {
        // Use address(0) as token address for ETH
        return _storage.getFeeReceiver(_token);
    }

    function getOrderFill(bytes32 orderKeyHash) external view override returns (uint256) {
        return _storage.getFill(orderKeyHash);
    }

    function getOrdersFills(bytes32[] calldata ordersKeyHashes) external view override returns (uint256[] memory) {
        uint256[] memory ordersFills = new uint256[](ordersKeyHashes.length);
        // Loop over ordersKeyHashes array
        for (uint256 i = 0; i < ordersKeyHashes.length; i++) {
            // Push order fill to ordersFills array
            ordersFills[i] = _storage.getFill(ordersKeyHashes[i]);
        }
        return ordersFills;
    }

    function isERC20AssetAllowed(address _erc20AssetAddress) external view override returns (bool) {
        return _storage.isERC20AssetAllowed(_erc20AssetAddress);
    }

    function _transferFromERC20(address _token, address _from, address _to, uint256 _value) internal returns (bool) {
        return IERC20(_token).transferFrom(_from, _to, _value);
    }

    function _transferERC20(address _token, address _to, uint256 _value) internal returns (bool) {
        return IERC20(_token).transfer(_to, _value);
    }

    function togglePause() external onlyOwner {
        paused() ? _unpause() : _pause();
    }

    function receiveETH() public payable {}

    function _authorizeUpgrade(address newImplementation) internal virtual override onlyUpgradeManager {}
}
