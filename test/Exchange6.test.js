const { getBalance, getBlock } = web3.eth;
const { toBN } = web3.utils;
const truffleAssert = require('truffle-assertions');

const { Order, MatchAllowance, Asset, encodeTokenData, encodeOrderData } = require('./utils/order');
const { signOrderData, signMatchAllowance } = require('./utils/EIP712Signer');
const {
  ETH,
  WETH,
  ERC20,
  ERC721,
  ERC1155,
  ORDER_DATA_V1,
  TO_MAKER,
  TO_TAKER,
  PROTOCOL,
  ORIGIN,
  PAYOUT,
} = require('./utils/hashKeys');

const UINT256_MAX = toBN(2).pow(toBN(256)).sub(toBN(1));
const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';
const PROTOCOL_FEE = toBN(100); // 1% protocol fee in bps (1 bps = 0.01%)
const CHAIN_ID = toBN(1);
const ZERO_FILLER_STRING = '00000000000000000000000000000000000000000000000000000000'; // 56 zeros

let defaultFeeReceiverInitialETHBalance,
  encodedOrderData,
  ERC721Token,
  ERC1155Token,
  events,
  exchangeBehindProxy,
  exchangeHelperProxy,
  exchangeHelperBehindProxy,
  exchangeHelperProxyAddress,
  exchangeProxy,
  exchangeProxyAddress,
  latestBlock,
  latestTimestamp,
  libOrder,
  makerOrder,
  makerOrderBytesSig,
  makerOrderKeyHash,
  makerSignature,
  matchAllowanceRight,
  matchAllowanceBytesSigRight,
  matchAllowanceSignatureRight,
  matchRightBeforeTimestamp,
  orderData,
  otherERC20Token,
  royaltiesRegistryProxy,
  royaltiesRegistryProxyAddress,
  takerOrder,
  takerOrderKeyHash,
  tx,
  weth,
  whitelist,
  whitelistProxyAddress;

function expandToDecimals(value, decimals) {
  return toBN(value).mul(toBN(10).pow(toBN(decimals)));
}

function expandToDecimalsString(value, decimals) {
  return expandToDecimals(value, decimals).toString();
}

contract('Exchange - Functional Tests Part 6', accounts => {
  const ExchangeHelper = artifacts.require('ExchangeHelper');
  const ExchangeHelperProxy = artifacts.require('TestERC1967Proxy');
  const Exchange = artifacts.require('Exchange');
  const ExchangeProxy = artifacts.require('TestERC1967Proxy');
  const RoyaltiesRegistry = artifacts.require('RoyaltiesRegistry');
  const RoyaltiesRegistryProxy = artifacts.require('TestERC1967Proxy');
  const LibOrderTest = artifacts.require('LibOrderTest');
  const WETH9 = artifacts.require('WETH9');
  const TestERC20 = artifacts.require('TestERC20');
  const TestERC721 = artifacts.require('TestERC721');
  const TestERC1155 = artifacts.require('TestERC1155');
  const ExchangeStorage = artifacts.require('ExchangeStorage');

  const [
    deployer,
    owner,
    other,
    maker,
    taker,
    ownerWhitelist,
    defaultFeeReceiver,
    royaltiesRecipient_1,
    royaltiesRecipient_2,
    originFeeRecipient_1,
    originFeeRecipient_2,
    orderBook,
    sporkProxyAddress,
  ] = accounts;

  beforeEach(async () => {
    // Deploy LibOrderTest
    libOrder = await LibOrderTest.new();

    // Deploy tokens
    weth = await WETH9.new();
    otherERC20Token = await TestERC20.new('Test ERC20', 'tERC20', { from: owner });
    ERC721Token = await TestERC721.new('Test NFT', 'tNFT', { from: owner });

    ERC1155Token = await TestERC1155.new('', { from: owner });

    // Deploy RoyaltiesRegistry contracts
    royaltiesRegistry = await RoyaltiesRegistry.new({ from: deployer });
    royaltiesRegistryProxyContract = await RoyaltiesRegistryProxy.new(
      royaltiesRegistry.address,
      '0x',
    );
    royaltiesRegistryProxy = await RoyaltiesRegistry.at(royaltiesRegistryProxyContract.address);
    royaltiesRegistryProxyAddress = royaltiesRegistryProxy.address;
    await RoyaltiesRegistry.at(royaltiesRegistryProxyAddress);

    // Deploy ExchangeHelper contracts
    exchange = await Exchange.new();
    exchangeProxyContract = await ExchangeProxy.new(exchange.address, '0x');
    exchangeProxy = await Exchange.at(exchangeProxyContract.address);
    exchangeProxyAddress = exchangeProxyContract.address;
    exchangeBehindProxy = await Exchange.at(exchangeProxyAddress);

    exchangeHelper = await ExchangeHelper.new();
    exchangeBehindProxy = await Exchange.at(exchangeProxyAddress);
    exchangeHelperProxyContract = await ExchangeHelperProxy.new(exchangeHelper.address, '0x');
    exchangeHelperProxy = await ExchangeHelper.at(exchangeHelperProxyContract.address);
    exchangeHelperProxyAddress = exchangeHelperProxy.address;
    exchangeHelperBehindProxy = await ExchangeHelper.at(exchangeHelperProxyAddress);

    await exchangeHelperProxy.initialize(
      exchangeProxy.address,
      orderBook,
      owner,
      deployer,
      CHAIN_ID,
      { from: deployer },
    );

    await exchangeHelper.initialize(exchangeProxy.address, orderBook, owner, deployer, CHAIN_ID, {
      from: deployer,
    });

    await exchange.initialize(
      exchangeProxy.address,
      exchangeHelperProxy.address,
      orderBook,
      defaultFeeReceiver,
      royaltiesRegistryProxyAddress,
      weth.address,
      owner,
      deployer,
      PROTOCOL_FEE,
      CHAIN_ID,
      { from: deployer },
    );

    await exchangeProxy.initialize(
      exchangeProxy.address,
      exchangeHelperProxy.address,
      orderBook,
      defaultFeeReceiver,
      royaltiesRegistryProxyAddress,
      weth.address,
      owner,
      deployer,
      PROTOCOL_FEE,
      CHAIN_ID,
      { from: deployer },
    );

    await royaltiesRegistryProxy.initialize(owner, deployer);
    await royaltiesRegistry.initialize(owner, deployer);
  });

  describe('matchOrders: make ERC721, take ERC721', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 2), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // Generate maker order matchAllowance
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('make ERC721, take ERC721 (reverts)', async () => {
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      /// Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 2, { from: taker });
      assert.equal(await ERC721Token.getApproved(2), exchangeProxyAddress);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 2), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'LibOrder: Asset types mismatch - makeAsset is non-fungible, therefore takeAsset must be fungible',
      );
    });
  });

  describe('matchOrders: make ERC721, take ERC1155', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // Generate maker order matchAllowance
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('make ERC721, take ERC1155 (reverts)', async () => {
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 2), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'LibOrder: Asset types mismatch - makeAsset is non-fungible, therefore takeAsset must be fungible',
      );
    });
  });

  describe('matchOrders: make ERC1155, take ERC721', () => {
    beforeEach(async () => {
      // Mint ERC1155 token to maker
      await ERC1155Token.mint(maker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '1');
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: maker });
      assert.equal(await ERC1155Token.isApprovedForAll(maker, exchangeProxyAddress), true);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // Generate maker order matchAllowance
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('make ERC1155, take ERC721 (reverts)', async () => {
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'LibOrder: Asset types mismatch - makeAsset is non-fungible, therefore takeAsset must be fungible',
      );
    });
  });

  describe('matchOrders: make ERC1155, take ERC1155', () => {
    beforeEach(async () => {
      // Mint ERC1155 token to maker
      await ERC1155Token.mint(maker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '1');
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: maker });
      assert.equal(await ERC1155Token.isApprovedForAll(maker, exchangeProxyAddress), true);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 2), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // Generate maker order matchAllowance
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('make ERC1155, take ERC1155 (reverts)', async () => {
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 2, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 2)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 2), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'LibOrder: Asset types mismatch - makeAsset is non-fungible, therefore takeAsset must be fungible',
      );
    });
  });

  describe('matchOrders: specify taker in maker order', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('with specified taker', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        '0x', // Taker order hash signature not needed since taker is callerAddress
        0,
        '0x',
        makerOrder, // Maker order
        makerOrderBytesSig,
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        { from: taker },
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Check emitted events
      // Match event
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'Match');
      assert.equal(events[0].returnValues.leftHash, takerOrderKeyHash);
      assert.equal(events[0].returnValues.rightHash, makerOrderKeyHash);
      assert.equal(events[0].returnValues.leftMaker, taker);
      assert.equal(events[0].returnValues.rightMaker, maker);
      assert.equal(events[0].returnValues.newLeftFill, '1');
      assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(1, 18));
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 3);
      // Transfer protocol fee
      assert.equal(events[0].event, 'Transfer');
      assert.equal(events[0].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, null);
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('with other taker (reverts)', async () => {
      // Get WETH to other
      await weth.deposit({ from: other, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(other)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: other });
      assert.equal(
        (await weth.allowance(other, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        other, // maker
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: other },
        ),
        'Exchange: rightOrder.taker verification failed',
      );
    });

    it('with specified taker, specify maker in taker order', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        maker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        '0x', // Taker order hash signature not needed since taker is callerAddress
        0,
        '0x',
        makerOrder, // Maker order
        makerOrderBytesSig,
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        { from: taker },
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        expandToDecimalsString(99, 16), // 0.99 WETH
      );
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Check emitted events
      // Match event
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'Match');
      assert.equal(events[0].returnValues.leftHash, takerOrderKeyHash);
      assert.equal(events[0].returnValues.rightHash, makerOrderKeyHash);
      assert.equal(events[0].returnValues.leftMaker, taker);
      assert.equal(events[0].returnValues.rightMaker, maker);
      assert.equal(events[0].returnValues.newLeftFill, '1');
      assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(1, 18));
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 3);
      // Transfer protocol fee
      assert.equal(events[0].event, 'Transfer');
      assert.equal(events[0].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, null);
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('with specified taker, specify other maker in taker order (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        other,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'Exchange: leftOrder.taker verification failed',
      );
    });
  });

  describe('matchOrders: maker order end timestamp < latest timestamp', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 1, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('matchOrder (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'LibOrder: Order end timestamp validation failed',
      );
    });
  });

  describe('matchOrders: maker order start timestamp > latest timestamp', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp + 100000, // start
        latestTimestamp + 1000000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('matchOrder (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'LibOrder: Order start timestamp validation failed',
      );
    });
  });

  describe('matchOrders', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('taker order end timestamp < latest timestamp (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp - 2, // start
        latestTimestamp - 1, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'LibOrder: Order end timestamp validation failed',
      );
    });

    it('taker order start timestamp > latest timestamp (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp + 100000, // start
        latestTimestamp + 1000000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'LibOrder: Order start timestamp validation failed',
      );
    });
  });

  describe('matchOrders: maker order origin fees', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Define order data including origin fees
      orderData = {
        dataType: 'RARIBLE_V2_DATA_V1',
        payouts: [],
        originFees: [
          [originFeeRecipient_1.toString(), '100'], // 1% origin fee
          [originFeeRecipient_2.toString(), '50'], // 0.5% origin fee
        ],
      };
      // Encode order data
      encodedOrderData = encodeOrderData(orderData);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
        encodedOrderData[1], // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('maker pays origin fees specified in maker order', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        '0x', // Taker order hash signature not needed since taker is callerAddress
        0,
        '0x',
        makerOrder, // Maker order
        makerOrderBytesSig,
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        { from: taker },
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check that origin fees were paid
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_1)).toString(),
        expandToDecimalsString(1, 16), // 0.01 WETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        expandToDecimalsString(5, 15), // 0.005 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        expandToDecimalsString(975, 15), // 0.975 WETH
      );
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Check emitted events
      // Match event
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'Match');
      assert.equal(events[0].returnValues.leftHash, takerOrderKeyHash);
      assert.equal(events[0].returnValues.rightHash, makerOrderKeyHash);
      assert.equal(events[0].returnValues.leftMaker, taker);
      assert.equal(events[0].returnValues.rightMaker, maker);
      assert.equal(events[0].returnValues.newLeftFill, '1');
      assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(1, 18));
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 5);
      // Transfer protocol fee
      assert.equal(events[0].event, 'Transfer');
      assert.equal(events[0].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, null);
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer origin fees (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, originFeeRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, originFeeRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ORIGIN);
      // Transfer asset to maker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 WETH
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, maker);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, taker);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker order origin fees, both maker and taker pay origin fees as specified in their respective orders', async () => {
      // Define order data including origin fees
      orderData = {
        dataType: 'RARIBLE_V2_DATA_V1',
        payouts: [],
        originFees: [
          [originFeeRecipient_1.toString(), '100'], // 1% origin fee
          [originFeeRecipient_2.toString(), '50'], // 0.5% origin fee
        ],
      };
      // Encode order data
      encodedOrderData = encodeOrderData(orderData);
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1015, 15) }); // Deposit 1.015 ETH to get 1.015 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1015, 15));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1015, 15), {
        from: taker,
      });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1015, 15),
      );
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // mker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
        encodedOrderData[1], // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        '0x', // Taker order hash signature not needed since taker is callerAddress
        0,
        '0x',
        makerOrder, // Maker order
        makerOrderBytesSig,
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        { from: taker },
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check that origin fees were paid
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_1)).toString(),
        expandToDecimalsString(2, 16), // 0.01 + 0.01 = 0.02 WETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        expandToDecimalsString(1, 16), // 0.005 + 0.005 = 0.1 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        expandToDecimalsString(975, 15), // 0.975 WETH
      );
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Check emitted events
      // Match event
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'Match');
      assert.equal(events[0].returnValues.leftHash, takerOrderKeyHash);
      assert.equal(events[0].returnValues.rightHash, makerOrderKeyHash);
      assert.equal(events[0].returnValues.leftMaker, taker);
      assert.equal(events[0].returnValues.rightMaker, maker);
      assert.equal(events[0].returnValues.newLeftFill, '1');
      assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(1, 18));
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 7);
      // Transfer protocol fee
      assert.equal(events[0].event, 'Transfer');
      assert.equal(events[0].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, null);
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer origin fees (1/4)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, originFeeRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/4)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, originFeeRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ORIGIN);
      // Transfer origin fees (3/4)
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, originFeeRecipient_1);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, ORIGIN);
      // Transfer origin fees (4/4)
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[4].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[4].returnValues.from, taker);
      assert.equal(events[4].returnValues.to, originFeeRecipient_2);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, ORIGIN);
      // Transfer asset to maker
      assert.equal(events[5].event, 'Transfer');
      assert.equal(events[5].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[5].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[5].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 WETH
      assert.equal(events[5].returnValues.from, taker);
      assert.equal(events[5].returnValues.to, maker);
      assert.equal(events[5].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[5].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[6].event, 'Transfer');
      assert.equal(events[6].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[6].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[6].returnValues.assetValue, '1');
      assert.equal(events[6].returnValues.from, maker);
      assert.equal(events[6].returnValues.to, taker);
      assert.equal(events[6].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[6].returnValues.transferType, PAYOUT);
    });
  });

  describe('matchOrders: maker order payouts', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Define order data including payouts
      orderData = {
        dataType: 'RARIBLE_V2_DATA_V1',
        payouts: [
          [maker.toString(), '7500'], // 75% payout to maker
          [other.toString(), '2500'], // 25% payout to other
        ],
        originFees: [],
      };
      // Encode order data
      encodedOrderData = encodeOrderData(orderData);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
        encodedOrderData[1], // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('orders matches', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        '0x', // Taker order hash signature not needed since taker is callerAddress
        0,
        '0x',
        makerOrder, // Maker order
        makerOrderBytesSig,
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        { from: taker },
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker, other and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        expandToDecimalsString(7425, 14), // 0.7425 WETH
      );
      assert.equal(
        (await weth.balanceOf(other)).toString(),
        expandToDecimalsString(2475, 14), // 0.2475 WETH
      );
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Check emitted events
      // Match event
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'Match');
      assert.equal(events[0].returnValues.leftHash, takerOrderKeyHash);
      assert.equal(events[0].returnValues.rightHash, makerOrderKeyHash);
      assert.equal(events[0].returnValues.leftMaker, taker);
      assert.equal(events[0].returnValues.rightMaker, maker);
      assert.equal(events[0].returnValues.newLeftFill, '1');
      assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(1, 18));
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 4);
      // Transfer protocol fee
      assert.equal(events[0].event, 'Transfer');
      assert.equal(events[0].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, null);
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(7425, 14)); // 0.7425 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to other
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(2475, 14)); // 0.2475 WETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, other);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[3].returnValues.assetValue, '1');
      assert.equal(events[3].returnValues.from, maker);
      assert.equal(events[3].returnValues.to, taker);
      assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
    });

    it('taker order payouts', async () => {
      // Define order data including origin fees
      orderData = {
        dataType: 'RARIBLE_V2_DATA_V1',
        payouts: [
          [taker.toString(), '7500'], // 75% payout to taker
          [other.toString(), '2500'], // 25% payout to other
          // => other will get the ERC721 asset and taker will get nothing because the asset is not divisible
          // and last payout recipient gets the rest of the payouts division
        ],
        originFees: [],
      };
      // Encode order data
      encodedOrderData = encodeOrderData(orderData);
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
        encodedOrderData[1], // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        '0x', // Taker order hash signature not needed since taker is callerAddress
        0,
        '0x',
        makerOrder, // Maker order
        makerOrderBytesSig,
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        { from: taker },
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker, taker and other balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0'); // taker gets no payout
      assert.equal((await ERC721Token.balanceOf(other)).toString(), '1'); // other gets full payout
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        expandToDecimalsString(7425, 14), // 0.7425 WETH
      );
      assert.equal(
        (await weth.balanceOf(other)).toString(),
        expandToDecimalsString(2475, 14), // 0.2475 WETH
      );
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Check emitted events
      // Match event
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'Match');
      assert.equal(events[0].returnValues.leftHash, takerOrderKeyHash);
      assert.equal(events[0].returnValues.rightHash, makerOrderKeyHash);
      assert.equal(events[0].returnValues.leftMaker, taker);
      assert.equal(events[0].returnValues.rightMaker, maker);
      assert.equal(events[0].returnValues.newLeftFill, '1');
      assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(1, 18));
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 4);
      // Transfer protocol fee
      assert.equal(events[0].event, 'Transfer');
      assert.equal(events[0].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, null);
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(7425, 14)); // 0.7425 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to other
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(2475, 14)); // 0.2475 WETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, other);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
      // Transfer asset to other (other gets full payout because ERC721 is not divisible)
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[3].returnValues.assetValue, '1');
      assert.equal(events[3].returnValues.from, maker);
      assert.equal(events[3].returnValues.to, other);
      assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
    });
  });

  describe('matchOrders: make 2 ERC721, take WETH', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '2'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker + protocol fee)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('matchOrder (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '2'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders should revert
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'Exchange: can only transfer one ERC721',
      );
    });
  });

  describe('matchOrders: make WETH, take 2 ERC721', () => {
    beforeEach(async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: maker });
      assert.equal(
        (await weth.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '2'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('matchOrder (reverts)', async () => {
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '2'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders should revert
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'Exchange: can only transfer one ERC721',
      );
    });
  });

  describe('matchOrders: make WETH, take ETH', () => {
    beforeEach(async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(101, 16) }); // Deposit 1.01 ETH to get 1.01 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(101, 16));
      // Approve exchange proxy for transferring takeAsset (transfer to order taker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: maker });
      assert.equal(
        (await weth.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('take WETH, make ETH (reverts)', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftTake
        0,
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders should revert
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x',
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          {
            from: taker,
            value: expandToDecimalsString(1, 18), // msg.value == 1 ETH
          },
        ),
        'LibOrder: Asset types mismatch - makeAsset is fungible, therefore takeAsset must be non-fungible',
      );
    });
  });

  describe('matchOrders: make WETH, take WETH', () => {
    beforeEach(async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(101, 16) }); // Deposit 1.01 ETH to get 1.01 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(101, 16));
      // Approve exchange proxy for transferring takeAsset (transfer to order taker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: maker });
      assert.equal(
        (await weth.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('take WETH, make WETH (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1.01 ETH to get 1.01 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftTake
        0,
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders should revert
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x',
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'LibOrder: Asset types mismatch - makeAsset is fungible, therefore takeAsset must be non-fungible',
      );
    });
  });

  describe('matchOrders: make WETH, take ERC20', () => {
    beforeEach(async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(101, 16) }); // Deposit 1.01 ETH to get 1.01 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(101, 16));
      // Approve exchange proxy for transferring takeAsset (transfer to order taker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: maker });
      assert.equal(
        (await weth.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC20, encodeTokenData(otherERC20Token.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('make WETH, take ERC20 (reverts)', async () => {
      // Mint ERC20 token to taker
      await otherERC20Token.mint(taker, expandToDecimals(1, 18), { from: owner }); // Mint 1 token to taker
      assert.equal(
        (await otherERC20Token.balanceOf(taker)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await otherERC20Token.approve(exchangeProxyAddress, expandToDecimals(1, 18), {
        from: taker,
      });
      assert.equal(
        (await otherERC20Token.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC20, encodeTokenData(otherERC20Token.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftTake
        1, // salt cannot be 0 for taker orders submitted by other account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders should revert
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x',
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'LibOrder: Asset types mismatch - makeAsset is fungible, therefore takeAsset must be non-fungible',
      );
    });
  });

  describe('matchOrders: make ERC20, take WETH', () => {
    beforeEach(async () => {
      // Mint ERC20 token to maker
      await otherERC20Token.mint(maker, expandToDecimals(1, 18), { from: owner }); // Mint 1 token to maker
      assert.equal(
        (await otherERC20Token.balanceOf(maker)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Approve exchange proxy for transferring takeAsset (transfer to order taker)
      await otherERC20Token.approve(exchangeProxyAddress, expandToDecimals(1, 18), {
        from: maker,
      });
      assert.equal(
        (await otherERC20Token.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC20, encodeTokenData(otherERC20Token.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('make ERC20, take WETH (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(101, 16) }); // Deposit 1.01 ETH to get 1.01 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(101, 16));
      // Approve exchange proxy for transferring makeAsset (transfer to order maker)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC20, encodeTokenData(otherERC20Token.address), expandToDecimalsString(1, 18)), // leftTake
        1, // salt cannot be 0 for taker orders submitted by other account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders should revert
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x',
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'LibOrder: Asset types mismatch - makeAsset is fungible, therefore takeAsset must be non-fungible',
      );
    });
  });

  describe('matchOrders: make ERC20, take ETH', () => {
    beforeEach(async () => {
      // Mint ERC20 token to maker
      await otherERC20Token.mint(maker, expandToDecimals(1, 18), { from: owner }); // Mint 1 token to maker
      assert.equal(
        (await otherERC20Token.balanceOf(maker)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Approve exchange proxy for transferring takeAsset (transfer to order taker)
      await otherERC20Token.approve(exchangeProxyAddress, expandToDecimals(1, 18), {
        from: maker,
      });
      assert.equal(
        (await otherERC20Token.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC20, encodeTokenData(otherERC20Token.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('make ERC20, take ETH (reverts)', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC20, encodeTokenData(otherERC20Token.address), expandToDecimalsString(1, 18)), // leftTake
        1, // salt cannot be 0 for taker orders submitted by other account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders should revert
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x',
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker, value: expandToDecimals(101, 16) },
        ),
        'LibOrder: Asset types mismatch - makeAsset is fungible, therefore takeAsset must be non-fungible',
      );
    });
  });

  describe('matchOrders: make ERC721, take ERC20 asset not allowed', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC20, encodeTokenData(otherERC20Token.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('takeAsset not allowed (reverts)', async () => {
      // Mint ERC20 tokens to taker
      await otherERC20Token.mint(taker, expandToDecimals(1, 18), { from: owner }); // Mint 1 token to taker
      assert.equal(
        (await otherERC20Token.balanceOf(taker)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await otherERC20Token.approve(exchangeProxyAddress, expandToDecimals(1, 18), {
        from: taker,
      });
      assert.equal(
        (await otherERC20Token.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC20, encodeTokenData(otherERC20Token.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // otherERC20Token is not allowed
      assert.equal(await exchange.isERC20AssetAllowed(otherERC20Token.address), false);
      // Match orders should revert
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'Exchange: maker order take asset is not allowed',
      );
    });
  });

  describe('matchOrders: make ERC20 asset not allowed, take ERC721', () => {
    beforeEach(async () => {
      // Mint ERC20 tokens to maker
      await otherERC20Token.mint(maker, expandToDecimals(1, 18), { from: owner }); // Mint 1 token to maker
      assert.equal(
        (await otherERC20Token.balanceOf(maker)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Approve exchange proxy for transferring takeAsset (transfer to order taker)
      await otherERC20Token.approve(exchangeProxyAddress, expandToDecimals(1, 18), {
        from: maker,
      });
      assert.equal(
        (await otherERC20Token.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC20, encodeTokenData(otherERC20Token.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('makeAsset not allowed (reverts)', async () => {
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring makeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC20, encodeTokenData(otherERC20Token.address), expandToDecimalsString(1, 18)), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // otherERC20Token is not allowed
      assert.equal(await exchange.isERC20AssetAllowed(otherERC20Token.address), false);
      // Match orders should revert
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'Exchange: maker order make asset is not allowed',
      );
    });
  });

  describe('cancelOrder', () => {
    it('cancels an existing order', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // Order object
      makerOrder = Order(
        maker, // maker
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Cancel order
      await exchangeProxy.cancelOrder(makerOrder, { from: maker });
      // Check that order fill equals UINT256_MAX
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
        UINT256_MAX.toString(),
      );
    });

    it('order.salt == 0 (reverts)', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // Order object
      makerOrder = Order(
        maker, // maker
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightTake
        0, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Cancel order (reverts)
      await truffleAssert.reverts(
        exchangeProxy.cancelOrder(makerOrder, { from: maker }),
        'Exchange: 0 salt cannot be used',
      );
    });

    it('other can NOT cancel and the correct error message is returned', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // Order object
      makerOrder = Order(
        maker, // maker
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Cancel order (reverts)
      await truffleAssert.reverts(
        exchangeProxy.cancelOrder(makerOrder, { from: other }),
        'Exchange: not order maker',
      );
    });

    it('a previously cancelled order can NOT be matched and the correct error message is returned', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // Order object
      makerOrder = Order(
        maker, // maker
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, maker, makerOrder, exchangeProxyAddress, CHAIN_ID);
      // makerSignature must be converted to bytes buffer before submission
      makerOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // matchRightBeforeTimestamp
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowanceRight EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignatureRight must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
      // Cancel order
      await exchange.cancelOrder(makerOrder, { from: maker });
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: maker });
      assert.equal(
        (await weth.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Match orders
      truffleAssert.reverts(
        await exchangeProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: taker },
        ),
        'LibOrder: Order was previously cancelled',
      );
    });
  });

  describe('batchCancelOrder', () => {
    // This function returns an order object
    function makerOrder(salt) {
      return Order(
        maker, // maker
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightTake
        salt, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
    }
    // This function returns a mapping containing an array of order objects and another array with
    // corresponding order key hashes
    async function createOrders(count, index, ordersMap) {
      return new Promise(async (resolve, reject) => {
        try {
          if (index >= count) {
            resolve(ordersMap);
          } else {
            const salt = index + 1;
            const order = makerOrder(salt);
            const orderKeyHash = await libOrder.hashKey(order);
            ordersMap.orders.push(order);
            ordersMap.keyHashes.push(orderKeyHash);
            resolve(createOrders(count, index + 1, ordersMap));
          }
        } catch (err) {
          reject(err);
        }
      });
    }

    it('cancels orders by batch', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // Create array of orders
      const ordersMap = await createOrders(10, 0, { orders: [], keyHashes: [] });
      // Cancel orders by batch
      await exchangeHelperProxy.batchCancelOrders(ordersMap.orders, { from: maker });
      // Get orders fills
      const ordersFills = await exchangeProxy.getOrdersFills(ordersMap.keyHashes);
      // Check that all 10  orders fill are returned
      assert.equal(ordersFills.length, ordersMap.keyHashes.length);
      // Check that order fills all equal UINT256_MAX
      for (let i = 0; i < ordersMap.orders.length; i++) {
        assert.equal(ordersFills[i].toString(), UINT256_MAX.toString());
      }
    });
  });
});
