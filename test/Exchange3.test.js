const { getBalance, getBlock } = web3.eth;
const { toBN } = web3.utils;
const truffleAssert = require('truffle-assertions');

const { Order, MatchAllowance, Asset, encodeTokenData, encodeOrderData } = require('./utils/order');
const { signOrderData, signMatchAllowance } = require('./utils/EIP712Signer');
const {
  ETH,
  WETH,
  ERC1155,
  ORDER_DATA_V1,
  TO_MAKER,
  TO_TAKER,
  PROTOCOL,
  ROYALTY,
  ORIGIN,
  PAYOUT,
} = require('./utils/hashKeys');

const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';
const PROTOCOL_FEE = toBN(100); // 1% protocol fee in bps (1 bps = 0.01%)
const CHAIN_ID = toBN(1);
const ZERO_FILLER_STRING = '00000000000000000000000000000000000000000000000000000000'; // 56 zeros

let defaultFeeReceiverInitialETHBalance,
  encodedOrderData,
  ERC1155Token,
  events,
  exchangeBehindProxy,
  exchangeHelperProxy,
  exchangeHelperProxyAddress,
  exchangeProxy,
  exchangeProxyAddress,
  gasFee,
  initialETHBalances,
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
  matchAllowanceLeft,
  matchAllowanceBytesSigLeft,
  matchAllowanceSignatureLeft,
  matchLeftBeforeTimestamp,
  orderData,
  royalties,
  royaltiesRegistryBehindProxy,
  royaltiesRegistryProxy,
  royaltiesRegistryProxyAddress,
  royaltiesReturned,
  takerOrder,
  takerOrderBytesSig,
  takerOrderKeyHash,
  takerSignature,
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

contract('Exchange - Functional Tests Part 3', accounts => {
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

  describe('matchOrders: make ETH, take ERC1155', () => {
    beforeEach(async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        matchRightBeforeTimestamp, // end
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
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(makerOrderKeyHash, matchRightBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('maker cannot pay with ETH (reverts)', async () => {
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
        1, // salt cannot be 0 for taker orders submitted by another account
        latestTimestamp, // start
        matchLeftBeforeTimestamp, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Generate taker order EIP712 typed data signature
      takerSignature = await signOrderData(web3, taker, takerOrder, exchangeProxyAddress, CHAIN_ID);
      // takerSignature must be converted to bytes buffer before submission
      takerOrderBytesSig = Buffer.from(takerSignature.slice(2), 'hex');
      // Generate taker order matchAllowance
      // matchAllowanceLeft
      matchAllowanceLeft = MatchAllowance(takerOrderKeyHash, matchLeftBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignatureLeft = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceLeft,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeft = Buffer.from(matchAllowanceSignatureLeft.slice(2), 'hex');
      await truffleAssert.reverts(
        exchangeProxy.matchOrders(
          takerOrder, // Taker order
          takerOrderBytesSig, // Taker order hash signature needed since taker is not caller
          matchLeftBeforeTimestamp,
          matchAllowanceBytesSigLeft,
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          {
            from: other,
            value: expandToDecimalsString(1, 18), // msg.value == 1 ETH (paying for maker)
          },
        ),
        'Exchange: maker cannot pay with ETH, use WETH instead',
      );
    });
  });

  describe('matchOrders: make ERC1155, take WETH', () => {
    beforeEach(async () => {
      // Mint ERC1155 token to maker
      await ERC1155Token.mint(maker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '1');
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: maker });
      assert.equal(await ERC1155Token.isApprovedForAll(maker, exchangeProxyAddress), true);
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
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignatureRight = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceRight,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigRight = Buffer.from(matchAllowanceSignatureRight.slice(2), 'hex');
    });

    it('taker == caller, no origin fees, no royalties', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
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
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
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
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
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
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('other == caller, no origin fees, no royalties', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
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
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
        1, // salt cannot be 0 for taker orders submitted by other account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Generate taker order EIP712 typed data signature
      takerSignature = await signOrderData(web3, taker, takerOrder, exchangeProxyAddress, CHAIN_ID);
      // takerSignature must be converted to bytes buffer before submission
      takerOrderBytesSig = Buffer.from(takerSignature.slice(2), 'hex');
      // Generate taker order matchAllowance
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceLeft
      matchAllowanceLeft = MatchAllowance(takerOrderKeyHash, matchLeftBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignatureLeft = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceLeft,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeft = Buffer.from(matchAllowanceSignatureLeft.slice(2), 'hex');
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        takerOrderBytesSig, // Taker order hash signature needed since taker is not caller
        matchLeftBeforeTimestamp,
        matchAllowanceBytesSigLeft,
        makerOrder, // Maker order
        makerOrderBytesSig,
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        { from: other },
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
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Check that taker order fill equals leftTake value
      assert.equal((await exchangeProxy.getOrderFill(takerOrderKeyHash)).toString(), '1');
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
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('maker == caller, no origin fees, no royalties', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
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
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
        1, // salt cannot be 0 for taker orders submitted by other account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Generate taker order EIP712 typed data signature
      takerSignature = await signOrderData(web3, taker, takerOrder, exchangeProxyAddress, CHAIN_ID);
      // takerSignature must be converted to bytes buffer before submission
      takerOrderBytesSig = Buffer.from(takerSignature.slice(2), 'hex');
      // Generate taker order matchAllowance
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceLeft
      matchAllowanceLeft = MatchAllowance(takerOrderKeyHash, matchLeftBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignatureLeft = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceLeft,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeft = Buffer.from(matchAllowanceSignatureLeft.slice(2), 'hex');
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        takerOrderBytesSig, // Taker order hash signature needed since taker is not caller
        matchLeftBeforeTimestamp,
        matchAllowanceBytesSigLeft,
        makerOrder, // Maker order
        '0x', // Maker order hash signature not needed since maker is caller
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        { from: maker },
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
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Check that taker order fill equals leftTake value
      assert.equal((await exchangeProxy.getOrderFill(takerOrderKeyHash)).toString(), '1');
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
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, royalties from registry, no origin fees', async () => {
      // Register ERC1155Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC1155Token.address,
        1,
        royalties,
        { from: owner },
      );
      // Check that royalties have been registered
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC1155Token.address, 1);
      assert.equal(royaltiesReturned[0].account, royaltiesRecipient_1);
      assert.equal(royaltiesReturned[0].value, '100');
      assert.equal(royaltiesReturned[1].account, royaltiesRecipient_2);
      assert.equal(royaltiesReturned[1].value, '50');
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
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
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
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
      // Check that royalties were paid
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(1, 16),
      ); // 0.01 WETH
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_2)).toString(),
        expandToDecimalsString(5, 15),
      ); // 0.005 WETH
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(975, 15)); // 0.975 WETH
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
      // Transfer royalties (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer royalties (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, royaltiesRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ROYALTY);
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
      assert.equal(events[4].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, taker);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, no royalties, taker order origin fees', async () => {
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
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fees receivers)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1015, 15), { from: taker });
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
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
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
        expandToDecimalsString(1, 16), // 0.01 WETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        expandToDecimalsString(5, 15), // 0.005 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        expandToDecimalsString(990, 15), // 0.975 WETH
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
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(990, 15)); // 0.975 WETH
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, maker);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, taker);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, royalties from registry, taker order origin fees', async () => {
      // Register ERC1155Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC1155Token.address,
        1,
        royalties,
        { from: owner },
      );
      // Check that royalties have been registered
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC1155Token.address, 1);
      assert.equal(royaltiesReturned[0].account, royaltiesRecipient_1);
      assert.equal(royaltiesReturned[0].value, '100');
      assert.equal(royaltiesReturned[1].account, royaltiesRecipient_2);
      assert.equal(royaltiesReturned[1].value, '50');
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
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fees receivers)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1015, 15), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1015, 15), // 1.025 WETH
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
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
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
      // Check that royalties were paid
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(1, 16),
      ); // 0.01 WETH
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_2)).toString(),
        expandToDecimalsString(5, 15),
      ); // 0.005 WETH
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
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
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
      // Transfer royalties (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer royalties (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, royaltiesRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ROYALTY);

      // Transfer origin fees (1/2)
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, originFeeRecipient_1);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/2)
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(weth.address));
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
      assert.equal(events[6].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[6].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[6].returnValues.assetValue, '1');
      assert.equal(events[6].returnValues.from, maker);
      assert.equal(events[6].returnValues.to, taker);
      assert.equal(events[6].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[6].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, taker order payouts', async () => {
      // Define order data including payouts
      orderData = {
        dataType: 'RARIBLE_V2_DATA_V1',
        payouts: [
          [taker.toString(), '7500'], // 75% payout to taker
          [other.toString(), '2500'], // 25% payout to other
          // => other will get the ERC1155 asset and taker will get nothing because the asset is not divisible
          // and last payout recipient gets the rest of the payouts division
        ],
        originFees: [],
      };
      // Encode order data
      encodedOrderData = encodeOrderData(orderData);
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
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
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
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
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0'); // taker gets no payout
      assert.equal((await ERC1155Token.balanceOf(other, 1)).toString(), '1'); // other gets full payout
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
      // Transfer asset to other (other gets full payout because ERC1155 is not divisible)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, other);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, leftMake == 0 (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
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
        Asset(WETH, encodeTokenData(weth.address), '0'), // leftMake 0 WETH
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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
        'LibFill: fillLeft unable to fill',
      );
    });

    it('taker == caller, leftTake == 0 (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
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
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake 0 WETH
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '0'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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
        'LibMath: division by zero',
      );
    });

    it('taker == caller, leftMake < rightTake, leftTake/leftMake > rightMake/rightTake (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
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
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 17)), // leftMake 0.5 WETH
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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
        'LibFill: fillLeft unable to fill',
      );
    });

    it('taker == caller, leftMake > rightTake, leftTake/leftMake == rightMake/rightTake', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(2, 18) }); // Deposit 2 ETH to get 2 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(2, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(2, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(2, 18),
      );
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(2, 18)), // leftMake 2 WETH
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '2'), // leftTake 2 NFTs
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
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
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
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, leftMake > rightTake, leftTake/leftMake < rightMake/rightTake (reverts)', async () => {
      // reverts because taker should receive less but makeAsset is ERC1155 which is not divisible
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(2, 18) }); // Deposit 2 ETH to get 2 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(2, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(2, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(2, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(2, 18)), // leftMake 2 WETH
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake 1 NFT
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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
        'LibMath: rounding error',
      );
    });

    it('taker == caller, leftMake > rightTake, leftTake/leftMake > rightMake/rightTake (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(2, 18) }); // Deposit 2 ETH to get 2 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(2, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(2, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(2, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(2, 18)), // leftMake 2 WETH
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '3'), // leftTake 3 NFTs
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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
        'LibMath: rounding error',
      );
    });
  });

  describe('matchOrders: make WETH, take ERC1155', () => {
    beforeEach(async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker + fees)
      // Amount approved is 1.015 WETH to covers all test cases below
      await weth.approve(exchangeProxyAddress, expandToDecimals(1015, 15), { from: maker });
      assert.equal(
        (await weth.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1015, 15),
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

    it('taker == caller, no origin fees, no royalties', async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftMake
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
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), 1);
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '1');
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
      assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(1, 18));
      assert.equal(events[0].returnValues.newRightFill, '1');
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
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('other == caller, no origin fees, no royalties', async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftTake
        1, // salt cannot be 0 for taker orders submitted by other account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Generate taker order EIP712 typed data signature
      takerSignature = await signOrderData(web3, taker, takerOrder, exchangeProxyAddress, CHAIN_ID);
      // takerSignature must be converted to bytes buffer before submission
      takerOrderBytesSig = Buffer.from(takerSignature.slice(2), 'hex');
      // Generate taker order matchAllowance
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceLeft
      matchAllowanceLeft = MatchAllowance(takerOrderKeyHash, matchLeftBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignatureLeft = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceLeft,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeft = Buffer.from(matchAllowanceSignatureLeft.slice(2), 'hex');
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        takerOrderBytesSig, // Taker order hash signature needed since taker is not caller
        matchLeftBeforeTimestamp,
        matchAllowanceBytesSigLeft,
        makerOrder, // Maker order
        makerOrderBytesSig,
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        { from: other },
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
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), 1);
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '1');
      // Check that taker order fill equals leftTake value
      assert.equal(
        (await exchangeProxy.getOrderFill(takerOrderKeyHash)).toString(),
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
      assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(1, 18));
      assert.equal(events[0].returnValues.newRightFill, '1');
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
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('maker == caller, no origin fees, no royalties', async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftTake
        1, // salt cannot be 0 for taker orders submitted by other account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Generate taker order EIP712 typed data signature
      takerSignature = await signOrderData(web3, taker, takerOrder, exchangeProxyAddress, CHAIN_ID);
      // takerSignature must be converted to bytes buffer before submission
      takerOrderBytesSig = Buffer.from(takerSignature.slice(2), 'hex');
      // Generate taker order matchAllowance
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceLeft
      matchAllowanceLeft = MatchAllowance(takerOrderKeyHash, matchLeftBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignatureLeft = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceLeft,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeft = Buffer.from(matchAllowanceSignatureLeft.slice(2), 'hex');
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        takerOrderBytesSig, // Taker order hash signature needed since taker is not caller
        matchLeftBeforeTimestamp,
        matchAllowanceBytesSigLeft,
        makerOrder, // Maker order
        '0x', // Maker order hash signature not needed since maker is caller
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        { from: maker },
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
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), 1);
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '1');
      // Check that taker order fill equals leftTake value
      assert.equal(
        (await exchangeProxy.getOrderFill(takerOrderKeyHash)).toString(),
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
      assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(1, 18));
      assert.equal(events[0].returnValues.newRightFill, '1');
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
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, royalties from registry, no origin fees', async () => {
      // Register ERC1155Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC1155Token.address,
        1,
        royalties,
        { from: owner },
      );
      // Check that royalties have been registered
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC1155Token.address, 1);
      assert.equal(royaltiesReturned[0].account, royaltiesRecipient_1);
      assert.equal(royaltiesReturned[0].value, '100');
      assert.equal(royaltiesReturned[1].account, royaltiesRecipient_2);
      assert.equal(royaltiesReturned[1].value, '50');
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftMake
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
      // Check that royalties were paid
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(1, 16),
      ); // 0.01 WETH
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_2)).toString(),
        expandToDecimalsString(5, 15),
      ); // 0.005 WETH
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), 1);
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(975, 15)); // 0.99 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '1');
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
      assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(1, 18));
      assert.equal(events[0].returnValues.newRightFill, '1');
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
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer royalties (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer royalties (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, royaltiesRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, ROYALTY);
      // Transfer asset to taker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 WETH
      assert.equal(events[3].returnValues.from, maker);
      assert.equal(events[3].returnValues.to, taker);
      assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, taker);
      assert.equal(events[4].returnValues.to, maker);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, no royalties, taker order origin fees', async () => {
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
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftTake
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
        expandToDecimalsString(1, 16), // 0.01 WETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        expandToDecimalsString(5, 15), // 0.005 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), 1);
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(975, 15)); // 0.99 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '1');
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
      assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(1, 18));
      assert.equal(events[0].returnValues.newRightFill, '1');
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
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer origin fees (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, originFeeRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, originFeeRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, ORIGIN);
      // Transfer asset to taker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 WETH
      assert.equal(events[3].returnValues.from, maker);
      assert.equal(events[3].returnValues.to, taker);
      assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, taker);
      assert.equal(events[4].returnValues.to, maker);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, royalties from registry, taker order origin fees', async () => {
      // Check that royalties have been registered
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC1155Token.address,
        1,
        royalties,
        { from: owner },
      );
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC1155Token.address, 1);
      assert.equal(royaltiesReturned[0].account, royaltiesRecipient_1);
      assert.equal(royaltiesReturned[0].value, '100');
      assert.equal(royaltiesReturned[1].account, royaltiesRecipient_2);
      assert.equal(royaltiesReturned[1].value, '50');
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
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftTake
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
      // Check that royalties were paid
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(1, 16),
      ); // 0.01 WETH
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_2)).toString(),
        expandToDecimalsString(5, 15),
      ); // 0.005 WETH
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
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), 1);
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(960, 15)); // 0.96 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '1');
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
      assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(1, 18));
      assert.equal(events[0].returnValues.newRightFill, '1');
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
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer royalties (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer royalties (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, royaltiesRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, ROYALTY);
      // Transfer origin fees (1/2)
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[3].returnValues.from, maker);
      assert.equal(events[3].returnValues.to, originFeeRecipient_1);
      assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[3].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/2)
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[4].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, originFeeRecipient_2);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, ORIGIN);
      // Transfer asset to taker
      assert.equal(events[5].event, 'Transfer');
      assert.equal(events[5].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[5].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[5].returnValues.assetValue, expandToDecimalsString(960, 15)); // 0.975 WETH
      assert.equal(events[5].returnValues.from, maker);
      assert.equal(events[5].returnValues.to, taker);
      assert.equal(events[5].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[5].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[6].event, 'Transfer');
      assert.equal(events[6].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[6].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[6].returnValues.assetValue, '1');
      assert.equal(events[6].returnValues.from, taker);
      assert.equal(events[6].returnValues.to, maker);
      assert.equal(events[6].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[6].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, taker order payouts', async () => {
      // Define order data including payouts
      orderData = {
        dataType: 'RARIBLE_V2_DATA_V1',
        payouts: [
          [taker.toString(), '7500'], // 75% payout to taker
          [other.toString(), '2500'], // 25% payout to other
        ],
        originFees: [],
      };
      // Encode order data
      encodedOrderData = encodeOrderData(orderData);
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftTake
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
      // Check maker, take and other balances
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), 1);
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(7425, 14)); // 0.7425 WETH
      assert.equal((await weth.balanceOf(other)).toString(), expandToDecimalsString(2475, 14)); // 0.2475 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '1');
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
      assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(1, 18));
      assert.equal(events[0].returnValues.newRightFill, '1');
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
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(7425, 14)); // 0.7425 WETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to other
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(2475, 14)); // 0.2475 WETH
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, other);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[3].returnValues.assetValue, '1');
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, maker);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, leftMake == 0 (reverts)', async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
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
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '0'), // leftMake
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
        'LibFill: fillLeft unable to fill',
      );
    });

    it('taker == caller, leftTake == 0 (reverts)', async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
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
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), '0'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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
        'LibMath: division by zero',
      );
    });

    it('other == caller, leftMake > rightTake, leftTake/leftMake < rightMake/rightTake, taker receives less', async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '10'), // leftMake
        ADDRESS_ZERO, // mker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftTake
        1, // salt cannot be 0 for taker orders submitted by other account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Generate taker order EIP712 typed data signature
      takerSignature = await signOrderData(web3, taker, takerOrder, exchangeProxyAddress, CHAIN_ID);
      // takerSignature must be converted to bytes buffer before submission
      takerOrderBytesSig = Buffer.from(takerSignature.slice(2), 'hex');
      // Generate taker order matchAllowance
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceLeft
      matchAllowanceLeft = MatchAllowance(takerOrderKeyHash, matchLeftBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignatureLeft = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceLeft,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeft = Buffer.from(matchAllowanceSignatureLeft.slice(2), 'hex');
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        takerOrderBytesSig, // Taker order hash signature needed since taker is not caller
        matchLeftBeforeTimestamp,
        matchAllowanceBytesSigLeft,
        makerOrder, // Maker order
        makerOrderBytesSig,
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        { from: other },
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(1, 15), // 0.001 ETH
      );
      assert.equal((await weth.balanceOf(defaultFeeReceiver)).toString(), '0');
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), 1);
      assert.equal(
        (await weth.balanceOf(taker)).toString(),
        expandToDecimalsString(99, 15), // 0.99 WETH
      );
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        expandToDecimalsString(9, 17), // 0.9 WETH
      );
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '1');
      // Check taker order fill
      // Taker order fill equals actual value received by taker (less than leftTake value)
      assert.equal(
        (await exchangeProxy.getOrderFill(takerOrderKeyHash)).toString(),
        expandToDecimalsString(1, 17),
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
      assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(1, 17));
      assert.equal(events[0].returnValues.newRightFill, '1');
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 15)); // 0.001 WETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 15)); // 0.099 WETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('maker == caller, leftMake > rightTake, leftTake/leftMake < rightMake/rightTake, taker receives less', async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '10'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftTake
        1, // salt cannot be 0 for taker orders submitted by other account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Generate taker order EIP712 typed data signature
      takerSignature = await signOrderData(web3, taker, takerOrder, exchangeProxyAddress, CHAIN_ID);
      // takerSignature must be converted to bytes buffer before submission
      takerOrderBytesSig = Buffer.from(takerSignature.slice(2), 'hex');
      // Generate taker order matchAllowance
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceLeft
      matchAllowanceLeft = MatchAllowance(takerOrderKeyHash, matchLeftBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignatureLeft = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceLeft,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeft = Buffer.from(matchAllowanceSignatureLeft.slice(2), 'hex');
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        takerOrderBytesSig, // Taker order hash signature needed since taker is not caller
        matchLeftBeforeTimestamp,
        matchAllowanceBytesSigLeft,
        makerOrder, // Maker order
        '0x', // Maker order hash signature not needed since maker is caller
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        { from: maker },
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(1, 15), // 0.001 ETH
      );
      assert.equal((await weth.balanceOf(defaultFeeReceiver)).toString(), '0');
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), 1);
      assert.equal(
        (await weth.balanceOf(taker)).toString(),
        expandToDecimalsString(99, 15), // 0.99 WETH
      );
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        expandToDecimalsString(9, 17), // 0.9 WETH
      );
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '1');
      // Check taker order fill
      // Taker order fill equals actual value received by taker (less than leftTake value)
      assert.equal(
        (await exchangeProxy.getOrderFill(takerOrderKeyHash)).toString(),
        expandToDecimalsString(1, 17),
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
      assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(1, 17));
      assert.equal(events[0].returnValues.newRightFill, '1');
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 15)); // 0.001 WETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 15)); // 0.099 WETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, leftMake > rightTake, leftTake/leftMake == rightMake/rightTake', async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Mint ERC1155 token to taker
      await ERC1155Token.mint(taker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker });
      assert.equal(await ERC1155Token.isApprovedForAll(taker, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '10'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 19)), // leftTake
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
      assert.equal((await weth.balanceOf(defaultFeeReceiver)).toString(), '0');
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), 1);
      assert.equal(
        (await weth.balanceOf(taker)).toString(),
        expandToDecimalsString(99, 16), // 0.99 WETH
      );
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '1');
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
      assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(1, 18));
      assert.equal(events[0].returnValues.newRightFill, '1');
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
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, leftMake > rightTake, leftTake/leftMake > rightMake/rightTake (reverts)', async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
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
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '10'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 20)), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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
        'LibFill: fillRight unable to fill',
      );
    });
  });

  describe('matchOrders: make ERC1155, take ETH', () => {
    beforeEach(async () => {
      // Mint ERC1155 token to maker
      await ERC1155Token.mint(maker, 1, 1, '0x', { from: owner });
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '1');
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: maker });
      assert.equal(await ERC1155Token.isApprovedForAll(maker, exchangeProxyAddress), true);
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
      // Save initial ETH balances of accounts
      initialETHBalances = {
        defaultFeeReceiver: toBN(await getBalance(defaultFeeReceiver)),
        maker: toBN(await getBalance(maker)),
        taker: toBN(await getBalance(taker)),
        owner: toBN(await getBalance(owner)),
        other: toBN(await getBalance(other)),
        royaltiesRecipient_1: toBN(await getBalance(royaltiesRecipient_1)),
        royaltiesRecipient_2: toBN(await getBalance(royaltiesRecipient_2)),
        originFeeRecipient_1: toBN(await getBalance(originFeeRecipient_1)),
        originFeeRecipient_2: toBN(await getBalance(originFeeRecipient_2)),
      };
    });

    it('taker == caller, no origin fees, no royalties', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
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
        {
          from: taker,
          value: expandToDecimalsString(1, 18), // msg.value == 1 ETH
        },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid to defaultFeeReceiver
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      assert.equal(
        initialETHBalances.taker.sub(toBN(await getBalance(taker))).toString(),
        gasFee.add(expandToDecimals(1, 18)).toString(), // gasFee + 1 ETH
      );
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('other == caller, no origin fees, no royalties', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
        1, // salt cannot be 0 for taker orders submitted by another account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Generate taker order EIP712 typed data signature
      takerSignature = await signOrderData(web3, taker, takerOrder, exchangeProxyAddress, CHAIN_ID);
      // takerSignature must be converted to bytes buffer before submission
      takerOrderBytesSig = Buffer.from(takerSignature.slice(2), 'hex');
      // Generate taker order matchAllowance
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceLeft
      matchAllowanceLeft = MatchAllowance(takerOrderKeyHash, matchLeftBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignatureLeft = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceLeft,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeft = Buffer.from(matchAllowanceSignatureLeft.slice(2), 'hex');
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        takerOrderBytesSig, // Taker order hash signature needed since taker is not caller
        matchLeftBeforeTimestamp,
        matchAllowanceBytesSigLeft,
        makerOrder, // Maker order
        makerOrderBytesSig,
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        {
          from: other,
          value: expandToDecimalsString(1, 18), // msg.value == 1 ETH
        },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid to defaultFeeReceiver
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      // Check maker, taker and other balances
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      assert.equal(
        initialETHBalances.other.sub(toBN(await getBalance(other))).toString(),
        gasFee.add(expandToDecimals(1, 18)).toString(), // gasFee + 1 ETH
      );
      // Check that maker order fill equals rightTake value
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Check that taker order fill equals leftTake value
      assert.equal((await exchangeProxy.getOrderFill(takerOrderKeyHash)).toString(), '1');
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('maker == caller, no origin fees, no royalties', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
        1, // salt cannot be 0 for taker orders submitted by another account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
      // Generate taker order EIP712 typed data signature
      takerSignature = await signOrderData(web3, taker, takerOrder, exchangeProxyAddress, CHAIN_ID);
      // takerSignature must be converted to bytes buffer before submission
      takerOrderBytesSig = Buffer.from(takerSignature.slice(2), 'hex');
      // Generate taker order matchAllowance
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowanceLeft
      matchAllowanceLeft = MatchAllowance(takerOrderKeyHash, matchLeftBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignatureLeft = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowanceLeft,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeft = Buffer.from(matchAllowanceSignatureLeft.slice(2), 'hex');
      // Match orders
      tx = await exchangeProxy.matchOrders(
        takerOrder, // Taker order
        takerOrderBytesSig, // Taker order hash signature needed since taker is not caller
        matchLeftBeforeTimestamp,
        matchAllowanceBytesSigLeft,
        makerOrder, // Maker order
        '0x', // Maker order hash signature not needed since maker is caller
        matchRightBeforeTimestamp,
        matchAllowanceBytesSigRight,
        {
          from: maker,
          value: expandToDecimalsString(1, 18), // msg.value == 1 ETH
        },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid to defaultFeeReceiver
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      // Check maker and taker
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      // maker sent 1 ETH, received 0.99 ETH back, and paid for gas,
      // therefore the balance is now (gasFee + 0.01 ETH) less
      assert.equal(
        initialETHBalances.maker.sub(toBN(await getBalance(maker))).toString(),
        gasFee.add(expandToDecimals(1, 16)).toString(),
      );
      // taker's ETH balance didn't changed
      assert.equal(initialETHBalances.taker.toString(), toBN(await getBalance(taker)).toString());
      // Check that maker order fill equals rightTake value
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Check that taker order fill equals leftTake value
      assert.equal((await exchangeProxy.getOrderFill(takerOrderKeyHash)).toString(), '1');
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, royalties from registry, no origin fees', async () => {
      // Register ERC1155Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC1155Token.address,
        1,
        royalties,
        { from: owner },
      );
      // Check that royalties have been registered
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC1155Token.address, 1);
      assert.equal(royaltiesReturned[0].account, royaltiesRecipient_1);
      assert.equal(royaltiesReturned[0].value, '100');
      assert.equal(royaltiesReturned[1].account, royaltiesRecipient_2);
      assert.equal(royaltiesReturned[1].value, '50');
      // Update owner initial balance after sending transaction above
      initialETHBalances.owner = toBN(await getBalance(owner));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
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
        {
          from: taker,
          value: expandToDecimalsString(1, 18), // msg.value == 1 ETH
        },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid to defaultFeeReceiver
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      // Check that royalties were paid
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_1))
          .sub(initialETHBalances.royaltiesRecipient_1)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_2))
          .sub(initialETHBalances.royaltiesRecipient_2)
          .toString(),
        expandToDecimalsString(5, 15), // 0.005 ETH
      );
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(975, 15), // 0.99 ETH
      );
      assert.equal(
        initialETHBalances.taker.sub(toBN(await getBalance(taker))).toString(),
        gasFee.add(expandToDecimals(1, 18)).toString(), // gasFee + 1 ETH
      );
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer royalties (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer royalties (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, royaltiesRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ROYALTY);
      // Transfer asset to maker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, null);
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 ETH
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, maker);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, taker);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, no royalties, taker order origin fees', async () => {
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
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
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
        {
          from: taker,
          value: 1015000000000000000, // msg.value == 1.015 ETH
        },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid to defaultFeeReceiver
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      // Check that origin fees were paid
      assert.equal(
        toBN(await getBalance(originFeeRecipient_1))
          .sub(initialETHBalances.originFeeRecipient_1)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        toBN(await getBalance(originFeeRecipient_2))
          .sub(initialETHBalances.originFeeRecipient_2)
          .toString(),
        expandToDecimalsString(5, 15), // 0.005 ETH
      );
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(990, 15), // 0.99 ETH
      );
      assert.equal(
        initialETHBalances.taker.sub(toBN(await getBalance(taker))).toString(),
        gasFee.add(expandToDecimals(1015, 15)).toString(), // gasFee + 1.015 ETH
      );
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer origin fees (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, originFeeRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, originFeeRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ORIGIN);
      // Transfer asset to maker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, null);
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(990, 15)); // 0.975 ETH
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, maker);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, taker);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, royalties from registry, taker order origin fees', async () => {
      // Register ERC1155Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC1155Token.address,
        1,
        royalties,
        { from: owner },
      );
      // Check that royalties have been registered
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC1155Token.address, 1);
      assert.equal(royaltiesReturned[0].account, royaltiesRecipient_1);
      assert.equal(royaltiesReturned[0].value, '100');
      assert.equal(royaltiesReturned[1].account, royaltiesRecipient_2);
      assert.equal(royaltiesReturned[1].value, '50');
      // Update owner initial balance after sending transaction above
      initialETHBalances.owner = toBN(await getBalance(owner));
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
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
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
        {
          from: taker,
          value: 1015000000000000000, // msg.value == 1.015 ETH
        },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid to defaultFeeReceiver
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      // Check that royalties were paid
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_1))
          .sub(initialETHBalances.royaltiesRecipient_1)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_2))
          .sub(initialETHBalances.royaltiesRecipient_2)
          .toString(),
        expandToDecimalsString(5, 15), // 0.005 ETH
      );
      // Check that origin fees were paid
      assert.equal(
        toBN(await getBalance(originFeeRecipient_1))
          .sub(initialETHBalances.originFeeRecipient_1)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        toBN(await getBalance(originFeeRecipient_2))
          .sub(initialETHBalances.originFeeRecipient_2)
          .toString(),
        expandToDecimalsString(5, 15), // 0.005 ETH
      );
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(975, 15), // 0.975 ETH
      );
      assert.equal(
        initialETHBalances.taker.sub(toBN(await getBalance(taker))).toString(),
        gasFee.add(expandToDecimals(1015, 15)).toString(), // gasFee + 1.015 ETH
      );
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer royalties (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer royalties (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, royaltiesRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ROYALTY);
      // Transfer origin fees (1/2)
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, null);
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, originFeeRecipient_1);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/2)
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, null);
      assert.equal(events[4].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[4].returnValues.from, taker);
      assert.equal(events[4].returnValues.to, originFeeRecipient_2);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, ORIGIN);
      // Transfer asset to maker
      assert.equal(events[5].event, 'Transfer');
      assert.equal(events[5].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[5].returnValues.assetData, null);
      assert.equal(events[5].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 ETH
      assert.equal(events[5].returnValues.from, taker);
      assert.equal(events[5].returnValues.to, maker);
      assert.equal(events[5].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[5].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[6].event, 'Transfer');
      assert.equal(events[6].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[6].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[6].returnValues.assetValue, '1');
      assert.equal(events[6].returnValues.from, maker);
      assert.equal(events[6].returnValues.to, taker);
      assert.equal(events[6].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[6].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, taker order payouts', async () => {
      // Define order data including payouts
      orderData = {
        dataType: 'RARIBLE_V2_DATA_V1',
        payouts: [
          [taker.toString(), '7500'], // 75% payout to taker
          [other.toString(), '2500'], // 25% payout to other
          // => other will get the ERC1155 asset and taker will get nothing because the asset is not divisible
          // and last payout recipient gets the rest of the payouts division
        ],
        originFees: [],
      };
      // Encode order data
      encodedOrderData = encodeOrderData(orderData);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
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
        {
          from: taker,
          value: expandToDecimalsString(1, 18), // msg.value == 1 ETH
        },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid to defaultFeeReceiver
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      // Check maker, taker and other balances
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0'); // taker gets no payout
      assert.equal((await ERC1155Token.balanceOf(other, 1)).toString(), '1'); // other gets full payout
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      assert.equal(
        initialETHBalances.taker.sub(toBN(await getBalance(taker))).toString(),
        gasFee.add(expandToDecimals(1, 18)).toString(), // gasFee + 1 ETH
      );
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to other (other gets full payout because ERC1155 is not divisible)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, other);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, msg.value too small (reverts)', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders (reverts)
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
          {
            from: taker,
            value: expandToDecimalsString(1, 16), // msg.value == 0.01 ETH
          },
        ),
        'Exchange: failed to forward totalTakeValue to proxy',
      );
    });

    it('taker == caller, msg.value too large', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
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
        {
          from: taker,
          value: 2000000000000000000, // msg.value == 2 ETH
        },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid to defaultFeeReceiver
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      assert.equal(
        initialETHBalances.taker.sub(toBN(await getBalance(taker))).toString(),
        gasFee.add(expandToDecimals(2, 18)).toString(), // gasFee + 1 ETH => excess ETH sent
        // has been returned to taker
      );
      // Check that maker and taker did not receive WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, leftMake == 0 (reverts)', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', '0'), // leftMake 0 ETH
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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
        'LibFill: fillLeft unable to fill',
      );
    });

    it('taker == caller, leftTake == 0 (reverts)', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake 1 ETH
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '0'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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
        'LibMath: division by zero',
      );
    });

    it('taker == caller, leftMake < rightTake, leftTake/leftMake > rightMake/rightTake (reverts)', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(5, 17)), // leftMake 0.5 ETH
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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
        'LibFill: fillLeft unable to fill',
      );
    });

    it('taker == caller, leftMake > rightTake, leftTake/leftMake == rightMake/rightTake', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(2, 18)), // leftMake 2 ETH
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '2'), // leftTake 2 NFTs
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
        {
          from: taker,
          value: expandToDecimalsString(1, 18), // msg.value == 1 ETH
        },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid to defaultFeeReceiver
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      // Check maker and taker balances
      assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      assert.equal(
        initialETHBalances.taker.sub(toBN(await getBalance(taker))).toString(),
        gasFee.add(expandToDecimals(1, 18)).toString(), // gasFee + 1 ETH => excess ETH sent
        // has been returned to taker
      );
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
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to taker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, leftMake > rightTake, leftTake/leftMake < rightMake/rightTake (reverts)', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(2, 18)), // leftMake 2 ETH
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // leftTake 1 NFT
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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
        'LibMath: rounding error',
      );
    });

    it('taker == caller, leftMake > rightTake, leftTake/leftMake > rightMake/rightTake (reverts)', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(2, 18)), // leftMake 2 ETH
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '3'), // leftTake 3 NFTs
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate takerOrder key hash
      takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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
        'LibMath: rounding error',
      );
    });
  });
});
