const { getBalance, getBlock } = web3.eth;
const { toBN } = web3.utils;
const truffleAssert = require('truffle-assertions');

const { Order, MatchAllowance, Asset, encodeTokenData, encodeOrderData } = require('./utils/order');
const { signOrderData, signMatchAllowance } = require('./utils/EIP712Signer');
const {
  ETH,
  WETH,
  PROXY_WETH,
  ERC20,
  ERC721,
  ORDER_DATA_V1,
  TO_MAKER,
  TO_TAKER,
  PROTOCOL,
  ROYALTY,
  ORIGIN,
  PAYOUT,
} = require('./utils/hashKeys');
const { assert } = require('chai');

const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';
const PROTOCOL_FEE = toBN(100); // 1% protocol fee in bps (1 bps = 0.01%)
const CHAIN_ID = toBN(1);
const ZERO_FILLER_STRING = '00000000000000000000000000000000000000000000000000000000'; // 56 zeros

let encodedOrderData,
  ERC721Token,
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

contract('Exchange - Functional Tests Part 9', accounts => {
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

  describe('WETH/ETH conversion on matchOrders: make ERC721, take ETH', () => {
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
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // rightTake
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

    it('taker sends WETH, maker gets ETH, taker == caller, no origin fees, no royalties', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      // Check that taker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker sends WETH, maker gets ETH, other == caller, no origin fees, no royalties', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
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
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      // Check that taker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(toBN(await getBalance(taker)).toString(), initialETHBalances.taker.toString());
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
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker sends WETH, maker gets ETH, maker == caller, no origin fees, no royalties', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimals(99, 16).sub(gasFee).toString(), // 0.99 ETH - gasFee
      );
      // Check that taker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(toBN(await getBalance(taker)).toString(), initialETHBalances.taker.toString());
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
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker sends WETH, maker gets ETH, taker == caller, royalties from registry, no origin fees', async () => {
      // Register ERC721Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC721Token.address,
        1,
        royalties,
        { from: owner },
      );
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC721Token.address,
        1,
        royalties,
        { from: owner },
      );
      // Check that royalties have been registered
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC721Token.address, 1);
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
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that royalties were paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(royaltiesRecipient_1)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_1)).toString(),
        initialETHBalances.royaltiesRecipient_1.add(expandToDecimals(1, 16)).toString(),
      ); // 0.01 ETH
      /*
      10000000000000000
      10000000000000000
      */
      assert.equal((await weth.balanceOf(royaltiesRecipient_2)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_2)).toString(),
        initialETHBalances.royaltiesRecipient_2.add(expandToDecimals(5, 15)).toString(),
      ); // 0.005 ETH
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(975, 15), // 0.975 ETH
      );
      // Check that taker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, taker);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker sends WETH, maker gets ETH, taker == caller, no royalties, taker order origin fees', async () => {
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
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1015, 15), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1015, 15),
      );
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that origin fees were paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(originFeeRecipient_1))
          .sub(initialETHBalances.originFeeRecipient_1)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_1)).toString(),
        '0', // 0 WETH
      );
      assert.equal(
        toBN(await getBalance(originFeeRecipient_2))
          .sub(initialETHBalances.originFeeRecipient_2)
          .toString(),
        expandToDecimalsString(5, 15), // 0.005 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        '0', // 0 WETH
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      // Check that taker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[2].returnValues.assetData, null);
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
      assert.equal(events[4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, taker);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker sends WETH, maker gets ETH, taker == caller, royalties from registry, taker order origin fees', async () => {
      // Register ERC721Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC721Token.address,
        1,
        royalties,
        { from: owner },
      );
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC721Token.address,
        1,
        royalties,
        { from: owner },
      );
      // Check that royalties have been registered
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC721Token.address, 1);
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
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1015, 15), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1015, 15),
      );
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that royalties were paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(royaltiesRecipient_1)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_1)).toString(),
        initialETHBalances.royaltiesRecipient_1.add(expandToDecimals(1, 16)).toString(),
      ); // 0.01 ETH
      assert.equal((await weth.balanceOf(royaltiesRecipient_2)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_2)).toString(),
        initialETHBalances.royaltiesRecipient_2.add(expandToDecimals(5, 15)).toString(),
      ); // 0.005 ETH
      // Check that origin fees were paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(originFeeRecipient_1))
          .sub(initialETHBalances.originFeeRecipient_1)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_1)).toString(),
        '0', // 0 WETH
      );
      assert.equal(
        toBN(await getBalance(originFeeRecipient_2))
          .sub(initialETHBalances.originFeeRecipient_2)
          .toString(),
        expandToDecimalsString(5, 15), // 0.005 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        '0', // 0 WETH
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(975, 15), // 0.975 ETH
      );
      // Check that taker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[6].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[6].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[6].returnValues.assetValue, '1');
      assert.equal(events[6].returnValues.from, maker);
      assert.equal(events[6].returnValues.to, taker);
      assert.equal(events[6].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[6].returnValues.transferType, PAYOUT);
    });

    it('taker sends WETH, maker gets ETH, taker == caller, taker order payouts', async () => {
      // Define order data including payouts
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
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      // Check that taker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .toString(),
        initialETHBalances.taker.toString(),
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
      // Transfer asset to other (other gets full payout because ERC721 is not divisible)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, other);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker sends WETH with ERC20 asset type (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC20, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
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
        'LibExchange: assets do not match',
      );
    });

    it('taker specifies WETH in taker order but sends ETH (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
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
          { from: taker, value: expandToDecimals(1, 18) },
        ),
        'Exchange: msg.value should be 0',
      );
    });
  });

  describe('WETH/ETH conversion on matchOrders: make ERC721, take WETH', () => {
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

    it('taker sends ETH, maker gets WETH, taker == caller, no origin fees, no royalties', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
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
        { from: taker, value: expandToDecimals(1, 18) },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        '0', // 0 ETH
      );
      // Check that taker paid in ETH
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .add(expandToDecimals(1, 18))
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[1].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
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

    it('taker sends ETH, maker gets WETH, other == caller, no origin fees, no royalties', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
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
        { from: other, value: expandToDecimals(1, 18) },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        '0', // 0 ETH
      );
      // Check that taker didn't pay anything
      assert.equal(toBN(await getBalance(taker)).toString(), initialETHBalances.taker.toString());
      // Check that other paid in ETH
      assert.equal(
        toBN(await getBalance(other))
          .add(gasFee)
          .add(expandToDecimals(1, 18))
          .toString(),
        initialETHBalances.other.toString(),
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
      assert.equal(events[1].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
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

    it('taker sends ETH, maker gets WETH, maker == caller, no origin fees, no royalties', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
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
        { from: maker, value: expandToDecimals(1, 18) },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      // Check that maker paid 1 ETH + gasFee
      assert.equal(
        toBN(await getBalance(maker))
          .add(gasFee)
          .add(expandToDecimals(1, 18))
          .toString(),
        initialETHBalances.maker.toString(),
      );
      // Check that taker didn't pay anything
      assert.equal(toBN(await getBalance(taker)).toString(), initialETHBalances.taker.toString());
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
      assert.equal(events[1].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
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

    it('taker sends ETH, maker gets WETH, taker == caller, royalties from registry, no origin fees', async () => {
      // Register ERC721Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC721Token.address,
        1,
        royalties,
        { from: owner },
      );
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC721Token.address,
        1,
        royalties,
        { from: owner },
      );
      // Check that royalties have been registered
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC721Token.address, 1);
      assert.equal(royaltiesReturned[0].account, royaltiesRecipient_1);
      assert.equal(royaltiesReturned[0].value, '100');
      assert.equal(royaltiesReturned[1].account, royaltiesRecipient_2);
      assert.equal(royaltiesReturned[1].value, '50');
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
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
        { from: taker, value: expandToDecimals(1, 18) },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that royalties were paid in WETH and not in ETH
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(1, 16),
      ); // 0.01 WETH
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_1)).toString(),
        initialETHBalances.royaltiesRecipient_1.toString(),
      );
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_2)).toString(),
        expandToDecimalsString(5, 15),
      ); // 0.005 WETH
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_2)).toString(),
        initialETHBalances.royaltiesRecipient_2.toString(),
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(975, 15)); // 0.975 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        '0', // 0 ETH
      );
      // Check that taker paid in ETH
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .add(expandToDecimals(1, 18))
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[1].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer royalties (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, royaltiesRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ROYALTY);
      // Transfer asset to maker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
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

    it('taker sends ETH, maker gets WETH, taker == caller, no royalties, taker order origin fees', async () => {
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
        { from: taker, value: expandToDecimals(1015, 15) },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that origin fees were paid in WETH and not in ETH
      assert.equal(
        toBN(await getBalance(originFeeRecipient_1))
          .sub(initialETHBalances.originFeeRecipient_1)
          .toString(),
        '0', // 0 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_1)).toString(),
        expandToDecimalsString(1, 16), // 0.01 WETH
      );
      assert.equal(
        toBN(await getBalance(originFeeRecipient_2))
          .sub(initialETHBalances.originFeeRecipient_2)
          .toString(),
        '0', // 0 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        expandToDecimalsString(5, 15), // 0.005 WETH
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        '0', // 0 ETH
      );
      // Check that taker paid in ETH
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .add(expandToDecimals(1015, 15))
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[1].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, originFeeRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, originFeeRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ORIGIN);
      // Transfer asset to maker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(990, 15)); // 0.99 WETH
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

    it('taker sends ETH, maker gets WETH, taker == caller, royalties from registry, taker order origin fees', async () => {
      // Register ERC721Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC721Token.address,
        1,
        royalties,
        { from: owner },
      );
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC721Token.address,
        1,
        royalties,
        { from: owner },
      );
      // Check that royalties have been registered
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC721Token.address, 1);
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
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
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
        { from: taker, value: expandToDecimals(1015, 15) },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that royalties were paid in WETH and not in ETH
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(1, 16),
      ); // 0.01 WETH
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_1)).toString(),
        initialETHBalances.royaltiesRecipient_1.toString(),
      );
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_2)).toString(),
        expandToDecimalsString(5, 15),
      ); // 0.005 WETH
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_2)).toString(),
        initialETHBalances.royaltiesRecipient_2.toString(),
      );
      // Check that origin fees were paid in WETH and not in ETH
      assert.equal(
        toBN(await getBalance(originFeeRecipient_1))
          .sub(initialETHBalances.originFeeRecipient_1)
          .toString(),
        '0',
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_1)).toString(),
        expandToDecimalsString(1, 16), // 0.01 WETH
      );
      assert.equal(
        toBN(await getBalance(originFeeRecipient_2))
          .sub(initialETHBalances.originFeeRecipient_2)
          .toString(),
        '0',
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        expandToDecimalsString(5, 15), // 0.005 WETH
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(975, 15)); // 0.975 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        '0', // 0 ETH
      );
      // Check that taker paid in ETH
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .add(expandToDecimals(1015, 15))
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[1].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer royalties (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, royaltiesRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ROYALTY);

      // Transfer origin fees (1/2)
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, originFeeRecipient_1);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/2)
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[4].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[4].returnValues.from, taker);
      assert.equal(events[4].returnValues.to, originFeeRecipient_2);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, ORIGIN);
      // Transfer asset to maker
      assert.equal(events[5].event, 'Transfer');
      assert.equal(events[5].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[5].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[5].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 ETH
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

    it('taker sends ETH, maker gets WETH, taker == caller, taker order payouts', async () => {
      // Define order data including payouts
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
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
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
        { from: taker, value: expandToDecimals(1, 18) },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        '0', // 0 ETH
      );
      // Check that taker paid in ETH
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .add(expandToDecimals(1, 18))
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[1].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to other (other gets full payout because ERC721 is not divisible)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, other);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker sends too much ETH, maker gets WETH, taker == caller, no origin fees, no royalties', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
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
        { from: taker, value: expandToDecimals(2, 18) }, // 2 ETH; taker sends more than what is required in the order object
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(99, 16)); // 0.99 WETH
      // Check maker never received ETH
      assert.equal(toBN(await getBalance(maker)).toString(), initialETHBalances.maker.toString());
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
      assert.equal(events[1].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
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

    it('taker does not send any ETH but holds WETH and has approved WETH to be transferred by ExchangeProxy (reverts)', async () => {
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
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
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
      // Match orders (reverst)
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
          { from: taker }, // Taker doesn't send any ETH
        ),
        'Exchange: msg.value should be > 0 or taker should be sending WETH',
      );
    });
  });

  describe('WETH/ETH conversion on matchOrders: make ETH, take ERC721', () => {
    it('maker sends ETH - which is not allowed (reverts)', async () => {
      // Get latest block timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // rightMake
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
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Get latest block timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
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
        'Exchange: maker cannot pay with ETH, use WETH instead',
      );
    });
  });

  describe('WETH/ETH conversion on matchOrders: make WETH, take ERC721', () => {
    beforeEach(async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring makeAsset (transfer to order taker and fee receiver)
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

    it('maker sends WETH, taker gets ETH, taker == caller, no origin fees, no royalties', async () => {
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      // Check that taker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .sub(initialETHBalances.taker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      // Check that maker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(toBN(await getBalance(maker)).toString(), initialETHBalances.maker.toString());
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 ETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('maker sends WETH, taker gets ETH, other == caller, no origin fees, no royalties', async () => {
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
        1, // salt cannot be 0 for taker orders submitted by third party account
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
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      // Check that taker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .sub(initialETHBalances.taker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      // Check that maker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(toBN(await getBalance(maker)).toString(), initialETHBalances.maker.toString());
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 ETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('maker sends WETH, taker gets ETH, maker == caller, no origin fees, no royalties', async () => {
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
        1, // salt cannot be 0 for taker orders submitted by third party account
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      // Check that taker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .sub(initialETHBalances.taker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      // Check that maker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      // Check that maker only paid gas in ETH
      assert.equal(
        toBN(await getBalance(maker)).toString(),
        initialETHBalances.maker.sub(gasFee).toString(),
      );
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 ETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('maker sends WETH, taker gets ETH, taker == caller, royalties from registry, no origin fees', async () => {
      // Register ERC721Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC721Token.address,
        1,
        royalties,
        { from: owner },
      );
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC721Token.address,
        1,
        royalties,
        { from: owner },
      );
      // Check that royalties have been registered
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC721Token.address, 1);
      assert.equal(royaltiesReturned[0].account, royaltiesRecipient_1);
      assert.equal(royaltiesReturned[0].value, '100');
      assert.equal(royaltiesReturned[1].account, royaltiesRecipient_2);
      assert.equal(royaltiesReturned[1].value, '50');
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that royalties were paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(royaltiesRecipient_1)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_1)).toString(),
        initialETHBalances.royaltiesRecipient_1.add(expandToDecimals(1, 16)).toString(),
      ); // 0.01 ETH
      assert.equal((await weth.balanceOf(royaltiesRecipient_2)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_2)).toString(),
        initialETHBalances.royaltiesRecipient_2.add(expandToDecimals(5, 15)).toString(),
      ); // 0.005 ETH
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      // Check that taker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .sub(initialETHBalances.taker)
          .toString(),
        expandToDecimalsString(975, 15), // 0.975 ETH
      );
      // Check that maker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(toBN(await getBalance(maker)).toString(), initialETHBalances.maker.toString());
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer royalties (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer royalties (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, royaltiesRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, ROYALTY);
      // Transfer asset to taker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, null);
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 ETH
      assert.equal(events[3].returnValues.from, maker);
      assert.equal(events[3].returnValues.to, taker);
      assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, taker);
      assert.equal(events[4].returnValues.to, maker);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('maker sends WETH, taker gets ETH, taker == caller, no royalties, taker order origin fees', async () => {
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
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that origin fees were paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(originFeeRecipient_1))
          .sub(initialETHBalances.originFeeRecipient_1)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_1)).toString(),
        '0', // 0 WETH
      );
      assert.equal(
        toBN(await getBalance(originFeeRecipient_2))
          .sub(initialETHBalances.originFeeRecipient_2)
          .toString(),
        expandToDecimalsString(5, 15), // 0.005 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        '0', // 0 WETH
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      // Check that taker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .sub(initialETHBalances.taker)
          .toString(),
        expandToDecimalsString(975, 15), // 0.975 ETH
      );
      // Check that maker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(toBN(await getBalance(maker)).toString(), initialETHBalances.maker.toString());
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer origin fees (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, originFeeRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, originFeeRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, ORIGIN);
      // Transfer asset to taker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, null);
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 ETH
      assert.equal(events[3].returnValues.from, maker);
      assert.equal(events[3].returnValues.to, taker);
      assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, taker);
      assert.equal(events[4].returnValues.to, maker);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('maker sends WETH, taker gets ETH, taker == caller, royalties from registry, taker order origin fees', async () => {
      // Register ERC721Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC721Token.address,
        1,
        royalties,
        { from: owner },
      );
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC721Token.address,
        1,
        royalties,
        { from: owner },
      );
      // Check that royalties have been registered
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC721Token.address, 1);
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
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that royalties were paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(royaltiesRecipient_1)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_1)).toString(),
        initialETHBalances.royaltiesRecipient_1.add(expandToDecimals(1, 16)).toString(),
      ); // 0.01 ETH
      assert.equal((await weth.balanceOf(royaltiesRecipient_2)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(royaltiesRecipient_2)).toString(),
        initialETHBalances.royaltiesRecipient_2.add(expandToDecimals(5, 15)).toString(),
      ); // 0.005 ETH
      // Check that origin fees were paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(originFeeRecipient_1))
          .sub(initialETHBalances.originFeeRecipient_1)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_1)).toString(),
        '0', // 0 WETH
      );
      assert.equal(
        toBN(await getBalance(originFeeRecipient_2))
          .sub(initialETHBalances.originFeeRecipient_2)
          .toString(),
        expandToDecimalsString(5, 15), // 0.005 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        '0', // 0 WETH
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      // Check that taker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .sub(initialETHBalances.taker)
          .toString(),
        expandToDecimalsString(960, 15), // 0.96 ETH
      );
      // Check that maker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(toBN(await getBalance(maker)).toString(), initialETHBalances.maker.toString());
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer royalties (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer royalties (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, royaltiesRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, ROYALTY);
      // Transfer origin fees (1/2)
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, null);
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[3].returnValues.from, maker);
      assert.equal(events[3].returnValues.to, originFeeRecipient_1);
      assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[3].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/2)
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, null);
      assert.equal(events[4].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, originFeeRecipient_2);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, ORIGIN);
      // Transfer asset to taker
      assert.equal(events[5].event, 'Transfer');
      assert.equal(events[5].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[5].returnValues.assetData, null);
      assert.equal(events[5].returnValues.assetValue, expandToDecimalsString(960, 15)); // 0.960 ETH
      assert.equal(events[5].returnValues.from, maker);
      assert.equal(events[5].returnValues.to, taker);
      assert.equal(events[5].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[5].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[6].event, 'Transfer');
      assert.equal(events[6].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[6].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[6].returnValues.assetValue, '1');
      assert.equal(events[6].returnValues.from, taker);
      assert.equal(events[6].returnValues.to, maker);
      assert.equal(events[6].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[6].returnValues.transferType, PAYOUT);
    });

    it('maker sends WETH, taker gets ETH, taker == caller, taker order payouts', async () => {
      // Define order data including payouts
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
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker and taker ERC721 balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      // Check that taker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .sub(initialETHBalances.taker)
          .toString(),
        expandToDecimalsString(7425, 14), // 0.7425 ETH
      );
      // Check that other was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(other)).toString(), '0');
      assert.equal(
        toBN(await getBalance(other))
          .sub(initialETHBalances.other)
          .toString(),
        expandToDecimalsString(2475, 14), // 0.2475 ETH
      );
      // Check that maker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(toBN(await getBalance(maker)).toString(), initialETHBalances.maker.toString());
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(7425, 14)); // 0.7425 ETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to other
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(2475, 14)); // 0.2475 ETH
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, other);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[3].returnValues.assetValue, '1');
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, maker);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
    });
  });

  describe('WETH/ETH conversion on matchOrders: make ERC721, take WETH, maker order origin fees', () => {
    beforeEach(async () => {
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

    it('taker sends ETH, maker pays origin fees specified in maker order', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
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
        { from: taker, value: expandToDecimals(1, 18) },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(975, 15)); // 0.975 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        '0', // 0 ETH
      );
      // Check that taker paid in ETH
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .add(expandToDecimals(1, 18))
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer origin fees (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, originFeeRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, originFeeRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ORIGIN);
      // Transfer asset to maker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
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

    it('taker sends ETH, taker order origin fees, both maker and taker pay origin fees as specified in their respective orders', async () => {
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
        { from: taker, value: expandToDecimals(1015, 15) },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(975, 15)); // 0.975 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        '0', // 0 ETH
      );
      // Check that taker paid in ETH
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .add(expandToDecimals(1015, 15))
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer origin fees (1/4)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, originFeeRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/4)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, originFeeRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ORIGIN);
      // Transfer origin fees (3/4)
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, originFeeRecipient_1);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, ORIGIN);
      // Transfer origin fees (4/4)
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[4].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[4].returnValues.from, taker);
      assert.equal(events[4].returnValues.to, originFeeRecipient_2);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, ORIGIN);
      // Transfer asset to maker
      assert.equal(events[5].event, 'Transfer');
      assert.equal(events[5].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
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

  describe('WETH/ETH conversion on matchOrders: make ERC721, take ETH, maker order origin fees', () => {
    beforeEach(async () => {
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
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // rightTake
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

    it('taker sends WETH, maker pays origin fees specified in maker order', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(975, 15), // 0.975 ETH
      );
      // Check that taker paid in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[2].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, originFeeRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ORIGIN);
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
      assert.equal(events[4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, taker);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker sends WETH, taker order origin fees, both maker and taker pay origin fees as specified in their respective orders', async () => {
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
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1015, 15), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1015, 15),
      );
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(975, 15), // 0.975 ETH
      );
      // Check that taker paid in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer origin fees (1/4)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, originFeeRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/4)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, originFeeRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ORIGIN);
      // Transfer origin fees (3/4)
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, null);
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, originFeeRecipient_1);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, ORIGIN);
      // Transfer origin fees (4/4)
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

  describe('WETH/ETH conversion on matchOrders: make WETH, take ERC721, maker order origin fees', () => {
    beforeEach(async () => {
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
      await weth.deposit({ from: maker, value: expandToDecimals(1015, 15) }); // Deposit 1.015 ETH to get 1.015 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1015, 15));
      // Approve exchange proxy for transferring makeAsset (transfer to order taker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1015, 15), { from: maker });
      assert.equal(
        (await weth.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1015, 15),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
        encodedOrderData[1], // data
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

    it('taker receives ETH, maker pays origin fees specified in maker order', async () => {
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that origin fees were paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(originFeeRecipient_1))
          .sub(initialETHBalances.originFeeRecipient_1)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_1)).toString(),
        '0', // 0 WETH
      );
      assert.equal(
        toBN(await getBalance(originFeeRecipient_2))
          .sub(initialETHBalances.originFeeRecipient_2)
          .toString(),
        expandToDecimalsString(5, 15), // 0.005 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        '0', // 0 WETH
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      // Check that taker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .sub(initialETHBalances.taker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      // Check that maker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(toBN(await getBalance(maker)).toString(), initialETHBalances.maker.toString());
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer origin fees (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, originFeeRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, originFeeRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, ORIGIN);
      // Transfer asset to taker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, null);
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 ETH
      assert.equal(events[3].returnValues.from, maker);
      assert.equal(events[3].returnValues.to, taker);
      assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, taker);
      assert.equal(events[4].returnValues.to, maker);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker receives ETH, taker order origin fees, both maker and taker pay origin fees as specified in their respective orders', async () => {
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
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that origin fees were paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(originFeeRecipient_1))
          .sub(initialETHBalances.originFeeRecipient_1)
          .toString(),
        expandToDecimalsString(2, 16), // 0.01 + 0.01 = 0.02 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_1)).toString(),
        '0', // 0 WETH
      );
      assert.equal(
        toBN(await getBalance(originFeeRecipient_2))
          .sub(initialETHBalances.originFeeRecipient_2)
          .toString(),
        expandToDecimalsString(1, 16), // 0.005 + 0.005 = 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        '0', // 0 WETH
      );
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      // Check that taker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .sub(initialETHBalances.taker)
          .toString(),
        expandToDecimalsString(975, 15), // 0.975 ETH
      );
      // Check that maker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(toBN(await getBalance(maker)).toString(), initialETHBalances.maker.toString());
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer origin fees (1/4)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, originFeeRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, ORIGIN);
      // Transfer origin fees (2/4)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, originFeeRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, ORIGIN);
      // Transfer origin fees (3/4)
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, null);
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[3].returnValues.from, maker);
      assert.equal(events[3].returnValues.to, originFeeRecipient_1);
      assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[3].returnValues.transferType, ORIGIN);
      // Transfer origin fees (4/4)
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, null);
      assert.equal(events[4].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 ETH
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, originFeeRecipient_2);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, ORIGIN);
      // Transfer asset to taker
      assert.equal(events[5].event, 'Transfer');
      assert.equal(events[5].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[5].returnValues.assetData, null);
      assert.equal(events[5].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 ETH
      assert.equal(events[5].returnValues.from, maker);
      assert.equal(events[5].returnValues.to, taker);
      assert.equal(events[5].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[5].returnValues.transferType, PAYOUT);
      // Transfer asset to maker
      assert.equal(events[6].event, 'Transfer');
      assert.equal(events[6].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[6].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[6].returnValues.assetValue, '1');
      assert.equal(events[6].returnValues.from, taker);
      assert.equal(events[6].returnValues.to, maker);
      assert.equal(events[6].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[6].returnValues.transferType, PAYOUT);
    });
  });

  describe('WETH/ETH conversion on matchOrders: make ERC721, take WETH, maker order payouts', () => {
    beforeEach(async () => {
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

    it('taker sends ETH, maker gets payouts as specified in maker order', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
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
        { from: taker, value: expandToDecimals(1, 18) },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker and other waere paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(7425, 14)); // 0.7425 WETH
      assert.equal((await weth.balanceOf(other)).toString(), expandToDecimalsString(2475, 14)); // 0.2475 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        '0', // 0 ETH
      );
      assert.equal(
        toBN(await getBalance(other))
          .sub(initialETHBalances.other)
          .toString(),
        '0', // 0 ETH
      );
      // Check that taker paid in ETH
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .add(expandToDecimals(1, 18))
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[1].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(7425, 14)); // 0.7425 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to other
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
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

    it('taker sends ETH, taker order payouts, both maker and taker get payouts as specified in their respective orders', async () => {
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
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
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
        { from: taker, value: expandToDecimals(1015, 15) },
      );
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker, other and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(other)).toString(), '1'); // Other gets full ERC721 payout
      // Check that maker and other were paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(7425, 14)); // 0.7425 WETH
      assert.equal((await weth.balanceOf(other)).toString(), expandToDecimalsString(2475, 14)); // 0.2475 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        '0', // 0 ETH
      );
      assert.equal(
        toBN(await getBalance(other))
          .sub(initialETHBalances.other)
          .toString(),
        '0', // 0 ETH
      );
      // Check that taker paid in ETH
      assert.equal(
        Number(
          toBN(await getBalance(taker))
            .add(gasFee)
            .add(expandToDecimals(1, 18))
            .toString(),
        ) < Number(initialETHBalances.taker.toString()),
        true,
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
      assert.equal(events[1].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(7425, 14)); // 0.7425 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to other
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, PROXY_WETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(2475, 14)); // 0.2475 WETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, other);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
      // Transfer asset to other
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

  describe('WETH/ETH conversion on matchOrders: make ERC721, take ETH, maker order payouts', () => {
    beforeEach(async () => {
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
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // rightTake
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

    it('taker sends WETH, maker gets payouts specified in maker order', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
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
      // Check that maker and other were paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0'); // 0 WETH
      assert.equal((await weth.balanceOf(other)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(7425, 14), // 0.7425 ETH
      );
      assert.equal(
        toBN(await getBalance(other))
          .sub(initialETHBalances.other)
          .toString(),
        expandToDecimalsString(2475, 14), // 0.2475 ETH
      );
      // Check that taker paid in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events.length, 4);
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
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(7425, 14)); // 0.7425 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to other
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(2475, 14)); // 0.2475 ETH
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

    it('taker sends WETH, taker order payouts, both maker and taker get payouts as specified in their respective orders', async () => {
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
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker, other and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(other)).toString(), '1'); // Other gets full ERC721 payout
      // Check that maker and other were paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0'); // 0 WETH
      assert.equal((await weth.balanceOf(other)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(7425, 14), // 0.7425 ETH
      );
      assert.equal(
        toBN(await getBalance(other))
          .sub(initialETHBalances.other)
          .toString(),
        expandToDecimalsString(2475, 14), // 0.2475 ETH
      );
      // Check that taker paid in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0'); // 0 WETH
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .toString(),
        initialETHBalances.taker.toString(),
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
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(7425, 14)); // 0.7425 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, maker);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to other
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(2475, 14)); // 0.2475 ETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, other);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
      // Transfer asset to other
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

  describe('WETH/ETH conversion on matchOrders: make WETH, take ERC721, maker order payouts', () => {
    beforeEach(async () => {
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
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring makeAsset (transfer to order taker and fee receiver)
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
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
        encodedOrderData[1], // data
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

    it('taker receives ETH, maker gets payout specified in maker order', async () => {
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker, other and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(other)).toString(), '1'); // Other gets full ERC721 payout
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      // Check that taker was paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .sub(initialETHBalances.taker)
          .toString(),
        expandToDecimalsString(99, 16), // 0.99 ETH
      );
      // Check that maker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(toBN(await getBalance(maker)).toString(), initialETHBalances.maker.toString());
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 ETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to other
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, other);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker receives ETH, taker order payouts, both maker and taker get payouts as specified in their respective orders', async () => {
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
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Update taker initial ETH balance
      initialETHBalances.taker = toBN(await getBalance(taker));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
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
      // Calculate transaction gas fee
      gasFee = toBN(0);
      if (tx.receipt.cumulativeGasUsed > 0) {
        gasFee = toBN(tx.receipt.effectiveGasPrice).mul(toBN(tx.receipt.cumulativeGasUsed));
      }
      // Check that protocol fee was paid in ETH and not in WETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(initialETHBalances.defaultFeeReceiver)
          .toString(),
        expandToDecimalsString(1, 16), // 0.01 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check maker, other and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(other)).toString(), '1'); // Other gets full ERC721 payout
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      // Check that taker and other were paid in ETH and not in WETH
      assert.equal((await weth.balanceOf(taker)).toString(), '0');
      assert.equal((await weth.balanceOf(other)).toString(), '0');
      assert.equal(
        toBN(await getBalance(taker))
          .add(gasFee)
          .sub(initialETHBalances.taker)
          .toString(),
        expandToDecimalsString(7425, 14), // 0.7425 ETH
      );
      assert.equal(
        toBN(await getBalance(other))
          .sub(initialETHBalances.other)
          .toString(),
        expandToDecimalsString(2475, 14), // 0.2475 ETH
      );
      // Check that maker paid in WETH and not in ETH
      assert.equal((await weth.balanceOf(maker)).toString(), '0');
      assert.equal(toBN(await getBalance(maker)).toString(), initialETHBalances.maker.toString());
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
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(7425, 14)); // 0.7425 ETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, taker);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to other
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(2475, 14)); // 0.2475 ETH
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, other);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
      // Transfer asset to other
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[3].returnValues.assetValue, '1');
      assert.equal(events[3].returnValues.from, taker);
      assert.equal(events[3].returnValues.to, other);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, PAYOUT);
    });
  });

  describe('WETH/ETH conversion on matchOrders: make ERC721, take WETH with ERC20 asset type (reverts)', () => {
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
        Asset(ERC20, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
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

    it('taker sends ETH (reverts)', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftMake
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
          { from: taker, value: expandToDecimals(1, 18) },
        ),
        'LibExchange: assets do not match',
      );
    });

    it('taker sends WETH (reverts)', async () => {
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
          { from: taker, value: expandToDecimals(1, 18) },
        ),
        'LibExchange: assets do not match',
      );
    });
  });

  describe('WETH/ETH conversion on matchOrders: make WETH with ERC20 asset type, take ERC721', () => {
    beforeEach(async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1015, 15) }); // Deposit 1.015 ETH to get 1.015 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1015, 15));
      // Approve exchange proxy for transferring makeAsset (transfer to order taker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1015, 15), { from: maker });
      assert.equal(
        (await weth.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1015, 15),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC20, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightTake
        1, // salt
        latestTimestamp, // start
        latestTimestamp + 100000, // end
        ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
        encodedOrderData[1], // data
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

    it('taker expects ETH (reverts)', async () => {
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ETH, '0x', expandToDecimalsString(1, 18)), // leftTake
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
        'LibExchange: assets do not match',
      );
    });

    it('taker expects WETH with WETH asset type (reverts)', async () => {
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
        'LibExchange: assets do not match',
      );
    });
  });
});
