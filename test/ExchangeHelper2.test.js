const { getBalance, getBlock } = web3.eth;
const { toBN } = web3.utils;
const truffleAssert = require('truffle-assertions');

const { Order, MatchAllowance, Asset, encodeTokenData, encodeOrderData } = require('./utils/order');
const { signOrderData, signMatchAllowance } = require('./utils/EIP712Signer');
const {
  ETH,
  WETH,
  ERC721,
  ERC1155,
  ORDER_DATA_V1,
  TO_MAKER,
  TO_TAKER,
  PROTOCOL,
  PAYOUT,
  ERC20,
  ORIGIN,
  ROYALTY,
} = require('./utils/hashKeys');

const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';
const PROTOCOL_FEE = toBN(100); // 1% protocol fee in bps (1 bps = 0.01%)
const CHAIN_ID = toBN(1);
const ZERO_FILLER_STRING = '00000000000000000000000000000000000000000000000000000000'; // 56 zeros

let collectionBidOrder,
  collectionBidOrderKeyHash,
  defaultFeeReceiverInitialETHBalance,
  encodedOrderData,
  orderData,
  ERC721Token,
  ERC1155Token,
  events,
  exchangeBehindProxy,
  exchangeHelperProxy,
  exchangeHelperProxyAddress,
  exchangeHelperBehindProxy,
  exchangeProxy,
  exchangeProxyAddress,
  latestBlock,
  latestTimestamp,
  libOrder,
  taker1InitialETHBalance,
  makerOrdersArray,
  collectionBidOrderBytesSig,
  expectedFillValuesArray,
  expectedProtocolFeeValuesArray,
  expectedPayoutValuesArray,
  expectedRoyaltiesValuesArray1,
  expectedRoyaltiesValuesArray2,
  makerOrderKeyHash,
  makerSignature,
  makerOrdersKeyHashesArray,
  matchAllowanceBytesSigLeftArray,
  matchAllowanceBytesSigRight,
  matchAllowanceBytesSigArray,
  matchAllowancesLeftArray,
  matchAllowanceRight,
  matchAllowancesSignaturesLeftArray,
  matchAllowanceSignatureRight,
  matchBeforeTimestamp,
  ordersBytesSigArray,
  ordersKeyHashesArray,
  royalties,
  royaltiesReturned,
  royaltiesRegistryBehindProxy,
  royaltiesRegistryProxy,
  royaltiesRegistryProxyAddress,
  takerOrdersArray,
  takerOrdersBytesSigArray,
  takerOrdersKeyHashesArray,
  takerOrdersSignaturesArray,
  takerOrdersMatchAllowancesArray,
  takerOrdersMatchAllowancesSignaturesArray,
  takerOrdersMatchAllowancesBytesSigArray,
  taker2OrdersSignaturesArray,
  taker2OrdersBytesSigArray,
  taker2OrdersMatchAllowancesArray,
  taker2OrdersMatchAllowancesSignaturesArray,
  taker2OrdersMatchAllowancesBytesSigArray,
  takerSignaturesArray,
  takersArray,
  tokenIdsArray,
  tokenValuesArray,
  tokenValuesArray1,
  tokenValuesArray2,
  tokenIdsArray1,
  tokenIdsArray2,
  ordersArray,
  signaturesArray,
  matchBeforeTimestampsArray,
  orderBookSignaturesArray,
  tx,
  weth,
  WETHValuesArray,
  WETHValuesArray1,
  WETHValuesArray2,
  whitelist,
  whitelistProxyAddress;

function expandToDecimals(value, decimals) {
  return toBN(value).mul(toBN(10).pow(toBN(decimals)));
}

function expandToDecimalsString(value, decimals) {
  return expandToDecimals(value, decimals).toString();
}

function asyncForEach(arrayIn, arrayOut, fn, index) {
  return new Promise(async (resolve, reject) => {
    try {
      if (index < arrayIn.length) {
        arrayOut.push(await fn(arrayIn[index]));
        resolve(asyncForEach(arrayIn, arrayOut, fn, index + 1));
      } else {
        resolve(arrayOut);
      }
    } catch (err) {
      reject(err);
    }
  });
}

contract('ExchangeHelper - Functional Tests Part 2', accounts => {
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
    taker1,
    taker2,
    royaltiesRecipient_1,
    royaltiesRecipient_2,
    originFeeRecipient_1,
    originFeeRecipient_2,
    ownerWhitelist,
    defaultFeeReceiver,
    orderBook,
  ] = accounts;

  beforeEach(async () => {
    // Deploy LibOrderTest
    libOrder = await LibOrderTest.new();

    // Deploy tokens
    weth = await WETH9.new();
    otherERC20Token = await TestERC20.new('Test ERC20', 'tERC20', { from: owner });
    ERC721Token = await TestERC721.new('Test NFT', 'tNFT', { from: owner });

    // Deploy RoyaltiesRegistry contracts
    royaltiesRegistry = await RoyaltiesRegistry.new({ from: deployer });
    royaltiesRegistryProxyContract = await RoyaltiesRegistryProxy.new(
      royaltiesRegistry.address,
      '0x',
    );
    royaltiesRegistryProxy = await RoyaltiesRegistry.at(royaltiesRegistryProxyContract.address);
    royaltiesRegistryProxyAddress = royaltiesRegistryProxy.address;
    await RoyaltiesRegistry.at(royaltiesRegistryProxyAddress);

    ERC1155Token = await TestERC1155.new('testURI', { from: owner });

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

  describe('matchCollectionBidOrder: make WETH, take ERC721', () => {
    beforeEach(async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(5, 18) }); // Deposit 5 ETH to get 5 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(5, 18));
      // Approve exchange proxy for transferring makeAsset (transfer to order taker and fee receiver)
      await weth.approve(exchangeProxy.address, expandToDecimals(5, 18), { from: maker });
      assert.equal(
        (await weth.allowance(maker, exchangeProxy.address)).toString(),
        expandToDecimalsString(5, 18),
      );

      await weth.approve(exchange.address, expandToDecimals(5, 18), { from: maker });
      assert.equal(
        (await weth.allowance(maker, exchange.address)).toString(),
        expandToDecimalsString(5, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      matchBeforeTimestamp = latestTimestamp + 100000;
      // Collection bid order (maker order)
      collectionBidOrder = Order(
        maker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 18)), // Willing to pay 5 WETH total
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 999), '5'), // Bid for 5 NFT total
        1, // salt cannot be 0
        latestTimestamp, // start
        matchBeforeTimestamp, // end
        '0xffffffff', // dataType
        '0x', // data,
        true, // collectionBid flag set to true
      );
      // Calculate collectionBidOrder key hash
      collectionBidOrderKeyHash = await libOrder.hashKey(collectionBidOrder);
      // Generate collection bid order EIP712 typed data signature
      makerSignature = await signOrderData(
        web3,
        maker,
        collectionBidOrder,
        exchangeProxyAddress.toLowerCase(),
        CHAIN_ID,
      );
      // makerSignature must be converted to bytes buffer before submission
      collectionBidOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // Generate collection bid order matchAllowance
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(collectionBidOrderKeyHash, matchBeforeTimestamp);
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

    it('full match with unsigned orders from same taker (taker == caller)', async () => {
      // Mint 5 ERC721 token from the same collection to taker, with non-consecutive tokenIds
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 2
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 4
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 5
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 8
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 10
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker1 });
      assert.equal(await ERC721Token.isApprovedForAll(taker1, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial taker1 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker1));
      // Format taker orders array
      takerOrdersArray = [];
      tokenIdsArray = [2, 4, 5, 8, 10];
      tokenIdsArray.forEach(tokenId => {
        takerOrdersArray.push(
          Order(
            taker1,
            Asset(ERC721, encodeTokenData(ERC721Token.address, tokenId), '1'),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)),
            0, // salt can be 0 since taker == caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            false, // collectionBid flag set to false
          ),
        );
      });
      // Format taker orders key hashes array
      takerOrdersKeyHashesArray = await asyncForEach(takerOrdersArray, [], libOrder.hashKey, 0);
      // Format matching maker orders array (these orders will be generated on-chain from the collectionBid order
      // and taker orders, and their keyHashes will appear in the Match events fired by the Exchange proxy contract)
      makerOrdersArray = [];
      takerOrdersArray.forEach(takerOrder => {
        // 0x111
        makerOrdersArray.push(
          Order(
            maker,
            takerOrder.takeAsset,
            ADDRESS_ZERO,
            takerOrder.makeAsset,
            0,
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            true, // collectionBid flag set to false
          ),
        );
      });
      // Format maker orders key hashes array
      makerOrdersKeyHashesArray = await asyncForEach(makerOrdersArray, [], libOrder.hashKey, 0);
      // Format orders array
      ordersArray = [collectionBidOrder].concat(takerOrdersArray);

      // Format orders' EIP712 signatures array
      ordersBytesSigArray = [collectionBidOrderBytesSig, '0x', '0x', '0x', '0x', '0x'];
      // Format orders' matchBeforeTimestamps array
      matchBeforeTimestampsArray = [matchBeforeTimestamp, 0, 0, 0, 0, 0];
      // Format orders' matchAllowance signatures array
      matchAllowanceBytesSigArray = [matchAllowanceBytesSigRight, '0x', '0x', '0x', '0x', '0x'];
      // Match collection bid orders
      tx = await exchangeHelperProxy.matchCollectionBidOrder(
        ordersArray,
        ordersBytesSigArray,
        matchBeforeTimestampsArray,
        matchAllowanceBytesSigArray,
        { from: taker1 },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(5, 16), // 0.05 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check makers and takers balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '5');
      assert.equal((await ERC721Token.balanceOf(taker1)).toString(), '0');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        '0', // 0 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(495, 16));
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(collectionBidOrderKeyHash)).toString(), '5');
      // Check emitted events
      // Match events
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 5);
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, taker1);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expandToDecimalsString(1, 18));
        assert.equal(events[i].returnValues.newRightFill, '1');
      }
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 15);
      for (let i = 0; i < events.length / 3; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 3].event, 'Transfer');
        assert.equal(events[i * 3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3].returnValues.assetData, null);
        assert.equal(events[i * 3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[i * 3].returnValues.from, maker);
        assert.equal(events[i * 3].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3].returnValues.transferType, PROTOCOL);
        // Transfer asset to taker1
        assert.equal(events[i * 3 + 1].event, 'Transfer');
        assert.equal(events[i * 3 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 3 + 1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
        assert.equal(events[i * 3 + 1].returnValues.from, maker);
        assert.equal(events[i * 3 + 1].returnValues.to, taker1);
        assert.equal(events[i * 3 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3 + 1].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[i * 3 + 2].event, 'Transfer');
        assert.equal(events[i * 3 + 2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 3 + 2].returnValues.assetData,
          encodeTokenData(ERC721Token.address, tokenIdsArray[i]),
        );
        assert.equal(events[i * 3 + 2].returnValues.assetValue, '1');
        assert.equal(events[i * 3 + 2].returnValues.from, taker1);
        assert.equal(events[i * 3 + 2].returnValues.to, maker);
        assert.equal(events[i * 3 + 2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 3 + 2].returnValues.transferType, PAYOUT);
      }
    });

    it('full match with orders from two different takers (taker1 == caller)', async () => {
      // Mint 5 ERC721 token from the same collection to taker, with non-consecutive tokenIds
      await ERC721Token.mint(taker2, { from: owner }); // tokenId 1
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 2
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 4
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 5
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker2, { from: owner }); // tokenId 7
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 8
      await ERC721Token.mint(taker2, { from: owner }); // tokenId 9
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 10
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker1 });
      assert.equal(await ERC721Token.isApprovedForAll(taker1, exchangeProxyAddress), true);
      await ERC721Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker2 });
      assert.equal(await ERC721Token.isApprovedForAll(taker2, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial taker1 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker1));
      // Get initial taker2 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker2));
      // Push taker1 orders to takerOrdersArray
      takerOrdersArray = [];
      tokenIdsArray1 = [2, 5, 8];
      tokenIdsArray1.forEach(tokenId => {
        takerOrdersArray.push(
          Order(
            taker1,
            Asset(ERC721, encodeTokenData(ERC721Token.address, tokenId), '1'),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)),
            0, // salt can be 0 since taker == caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            false, // collectionBid flag set to false
          ),
        );
      });
      // Push taker2 orders to takerOrdersArray
      tokenIdsArray2 = [7, 9];
      tokenIdsArray2.forEach(tokenId => {
        takerOrdersArray.push(
          Order(
            taker2,
            Asset(ERC721, encodeTokenData(ERC721Token.address, tokenId), '1'),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)),
            1, // salt can not be 0 since taker2 != caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            false, // collectionBid flag set to false
          ),
        );
      });
      // Format taker orders key hashes array
      takerOrdersKeyHashesArray = await asyncForEach(takerOrdersArray, [], libOrder.hashKey, 0);
      // Format taker2 orders EIP712 signatures array
      taker2OrdersSignaturesArray = await asyncForEach(
        [takerOrdersArray[3], takerOrdersArray[4]],
        [],
        order => {
          return signOrderData(web3, taker2, order, exchangeProxyAddress, CHAIN_ID);
        },
        0,
      );
      // taker2 signatures must be converted to bytes buffer before submission
      taker2OrdersBytesSigArray = [];
      taker2OrdersSignaturesArray.forEach(sig => {
        taker2OrdersBytesSigArray.push(Buffer.from(sig.slice(2), 'hex'));
      });
      // Generate taker2 orders matchAllowance
      taker2OrdersMatchAllowancesArray = [];
      [takerOrdersKeyHashesArray[3], takerOrdersKeyHashesArray[4]].forEach(keyHash => {
        taker2OrdersMatchAllowancesArray.push(MatchAllowance(keyHash, matchBeforeTimestamp));
      });
      // Generate taker 2 orders matchAllowance EIP712 typed data signatures
      taker2OrdersMatchAllowancesSignaturesArray = await asyncForEach(
        taker2OrdersMatchAllowancesArray,
        [],
        matchAllowance => {
          return signMatchAllowance(
            web3,
            orderBook,
            matchAllowance,
            exchangeProxyAddress,
            CHAIN_ID,
          );
        },
        0,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      taker2OrdersMatchAllowancesBytesSigArray = [];
      taker2OrdersMatchAllowancesSignaturesArray.forEach(sig => {
        taker2OrdersMatchAllowancesBytesSigArray.push(Buffer.from(sig.slice(2), 'hex'));
      });
      // Format matching maker orders array (these orders will be generated on-chain from the collectionBid order
      // and taker orders, and their keyHashes will appear in the Match events fired by the Exchange proxy contract)
      makerOrdersArray = [];
      takerOrdersArray.forEach(takerOrder => {
        makerOrdersArray.push(
          Order(
            maker,
            takerOrder.takeAsset,
            ADDRESS_ZERO,
            takerOrder.makeAsset,
            0,
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            true, // collectionBid flag set to false
          ),
        );
      });
      // Format maker orders key hashes array
      makerOrdersKeyHashesArray = await asyncForEach(makerOrdersArray, [], libOrder.hashKey, 0);
      // Format orders array
      ordersArray = [collectionBidOrder].concat(takerOrdersArray);
      // Format orders' EIP712 signatures array
      ordersBytesSigArray = [
        collectionBidOrderBytesSig,
        '0x',
        '0x',
        '0x',
        taker2OrdersBytesSigArray[0],
        taker2OrdersBytesSigArray[1],
      ];
      // Format orders' matchBeforeTimestamps array
      matchBeforeTimestampsArray = [
        matchBeforeTimestamp,
        0,
        0,
        0,
        matchBeforeTimestamp,
        matchBeforeTimestamp,
      ];
      // Format orders' matchAllowance signatures array
      matchAllowanceBytesSigArray = [
        matchAllowanceBytesSigRight,
        '0x',
        '0x',
        '0x',
        taker2OrdersMatchAllowancesBytesSigArray[0],
        taker2OrdersMatchAllowancesBytesSigArray[1],
      ];
      // Match collection bid orders
      tx = await exchangeHelperProxy.matchCollectionBidOrder(
        ordersArray,
        ordersBytesSigArray,
        matchBeforeTimestampsArray,
        matchAllowanceBytesSigArray,
        { from: taker1 },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(5, 16), // 0.05 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check makers and takers balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '5');
      assert.equal((await ERC721Token.balanceOf(taker1)).toString(), '2');
      assert.equal((await ERC721Token.balanceOf(taker2)).toString(), '1');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        '0', // 0 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(297, 16));
      assert.equal((await weth.balanceOf(taker2)).toString(), expandToDecimalsString(198, 16));
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(collectionBidOrderKeyHash)).toString(), '5');
      // Check emitted events
      // Match events
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });

      /**
       * 1,2
       *  1 - right hash - 0x1111
       *  2 - right hash - 0x2222
       *
       *  1 - order key - 0x111
       *  2 - order key - 0x222
       */

      // webapp - , indexer

      /**
       * 1,2 NFT
       *
       *  1 rightHash - 0x111
       *  2 rightHash - 0x111
       *
       *  orderKey - 0x111 == placedBid
       */
      assert.equal(events.length, 5);
      for (let i = 0; i < 3; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, taker1);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expandToDecimalsString(1, 18));
        assert.equal(events[i].returnValues.newRightFill, '1');
      }
      for (let i = 3; i < events.length; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, taker2);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expandToDecimalsString(1, 18));
        assert.equal(events[i].returnValues.newRightFill, '1');
      }
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 15);
      for (let i = 0; i < 3; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 3].event, 'Transfer');
        assert.equal(events[i * 3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3].returnValues.assetData, null);
        assert.equal(events[i * 3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[i * 3].returnValues.from, maker);
        assert.equal(events[i * 3].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3].returnValues.transferType, PROTOCOL);
        // Transfer asset to taker1
        assert.equal(events[i * 3 + 1].event, 'Transfer');
        assert.equal(events[i * 3 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 3 + 1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
        assert.equal(events[i * 3 + 1].returnValues.from, maker);
        assert.equal(events[i * 3 + 1].returnValues.to, taker1);
        assert.equal(events[i * 3 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3 + 1].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[i * 3 + 2].event, 'Transfer');
        assert.equal(events[i * 3 + 2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 3 + 2].returnValues.assetData,
          encodeTokenData(ERC721Token.address, tokenIdsArray1[i]),
        );
        assert.equal(events[i * 3 + 2].returnValues.assetValue, '1');
        assert.equal(events[i * 3 + 2].returnValues.from, taker1);
        assert.equal(events[i * 3 + 2].returnValues.to, maker);
        assert.equal(events[i * 3 + 2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 3 + 2].returnValues.transferType, PAYOUT);
      }
      for (let i = 3; i < 5; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 3].event, 'Transfer');
        assert.equal(events[i * 3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3].returnValues.assetData, null);
        assert.equal(events[i * 3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[i * 3].returnValues.from, maker);
        assert.equal(events[i * 3].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3].returnValues.transferType, PROTOCOL);
        // Transfer asset to taker1
        assert.equal(events[i * 3 + 1].event, 'Transfer');
        assert.equal(events[i * 3 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 3 + 1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
        assert.equal(events[i * 3 + 1].returnValues.from, maker);
        assert.equal(events[i * 3 + 1].returnValues.to, taker2);
        assert.equal(events[i * 3 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3 + 1].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[i * 3 + 2].event, 'Transfer');
        assert.equal(events[i * 3 + 2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 3 + 2].returnValues.assetData,
          encodeTokenData(ERC721Token.address, tokenIdsArray2[i - 3]),
        );
        assert.equal(events[i * 3 + 2].returnValues.assetValue, '1');
        assert.equal(events[i * 3 + 2].returnValues.from, taker2);
        assert.equal(events[i * 3 + 2].returnValues.to, maker);
        assert.equal(events[i * 3 + 2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 3 + 2].returnValues.transferType, PAYOUT);
      }
    });

    it('full match with signed orders from same taker (taker != caller)', async () => {
      // Mint 5 ERC721 token from the same collection to taker, with non-consecutive tokenIds
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 2
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 4
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 5
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 8
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 10
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker1 });
      assert.equal(await ERC721Token.isApprovedForAll(taker1, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial taker1 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker1));
      // Format taker orders array
      takerOrdersArray = [];
      tokenIdsArray = [2, 4, 5, 8, 10];
      tokenIdsArray.forEach(tokenId => {
        takerOrdersArray.push(
          Order(
            taker1,
            Asset(ERC721, encodeTokenData(ERC721Token.address, tokenId), '1'),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)),
            1, // salt can not be 0 since taker != caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            false, // collectionBid flag set to false
          ),
        );
      });
      // Format taker orders key hashes array
      takerOrdersKeyHashesArray = await asyncForEach(takerOrdersArray, [], libOrder.hashKey, 0);
      // Format taker orders EIP712 signatures array
      takerOrdersSignaturesArray = await asyncForEach(
        takerOrdersArray,
        [],
        order => {
          return signOrderData(web3, taker1, order, exchangeProxyAddress, CHAIN_ID);
        },
        0,
      );
      // taker signatures must be converted to bytes buffer before submission
      takerOrdersBytesSigArray = [];
      takerOrdersSignaturesArray.forEach(sig => {
        takerOrdersBytesSigArray.push(Buffer.from(sig.slice(2), 'hex'));
      });
      // Generate taker orders matchAllowance
      takerOrdersMatchAllowancesArray = [];
      takerOrdersKeyHashesArray.forEach(keyHash => {
        takerOrdersMatchAllowancesArray.push(MatchAllowance(keyHash, matchBeforeTimestamp));
      });
      // Generate taker orders matchAllowance EIP712 typed data signatures
      takerOrdersMatchAllowancesSignaturesArray = await asyncForEach(
        takerOrdersMatchAllowancesArray,
        [],
        matchAllowance => {
          return signMatchAllowance(
            web3,
            orderBook,
            matchAllowance,
            exchangeProxyAddress,
            CHAIN_ID,
          );
        },
        0,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      takerOrdersMatchAllowancesBytesSigArray = [];
      takerOrdersMatchAllowancesSignaturesArray.forEach(sig => {
        takerOrdersMatchAllowancesBytesSigArray.push(Buffer.from(sig.slice(2), 'hex'));
      });

      // Format matching maker orders array (these orders will be generated on-chain from the collectionBid order
      // and taker orders, and their keyHashes will appear in the Match events fired by the Exchange proxy contract)
      makerOrdersArray = [];
      takerOrdersArray.forEach(takerOrder => {
        makerOrdersArray.push(
          Order(
            maker,
            takerOrder.takeAsset,
            ADDRESS_ZERO,
            takerOrder.makeAsset,
            0,
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            true, // collectionBid flag set to false
          ),
        );
      });
      // Format maker orders key hashes array
      makerOrdersKeyHashesArray = await asyncForEach(makerOrdersArray, [], libOrder.hashKey, 0);
      // Format orders array
      ordersArray = [collectionBidOrder].concat(takerOrdersArray);
      // Format orders' EIP712 signatures array
      ordersBytesSigArray = [collectionBidOrderBytesSig].concat(takerOrdersBytesSigArray);
      // Format orders' matchBeforeTimestamps array
      matchBeforeTimestampsArray = [
        matchBeforeTimestamp,
        matchBeforeTimestamp,
        matchBeforeTimestamp,
        matchBeforeTimestamp,
        matchBeforeTimestamp,
        matchBeforeTimestamp,
      ];
      // Format orders' matchAllowance signatures array
      matchAllowanceBytesSigArray = [matchAllowanceBytesSigRight].concat(
        takerOrdersMatchAllowancesBytesSigArray,
      );
      // Match collection bid orders
      tx = await exchangeHelperProxy.matchCollectionBidOrder(
        ordersArray,
        ordersBytesSigArray,
        matchBeforeTimestampsArray,
        matchAllowanceBytesSigArray,
        { from: owner }, // taker != caller
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(5, 16), // 0.05 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check makers and takers balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '5');
      assert.equal((await ERC721Token.balanceOf(taker1)).toString(), '0');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        '0', // 0 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(495, 16));
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(collectionBidOrderKeyHash)).toString(), '5');
      // Check emitted events
      // Match events
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 5);
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, taker1);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expandToDecimalsString(1, 18));
        assert.equal(events[i].returnValues.newRightFill, '1');
      }
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 15);
      for (let i = 0; i < events.length / 3; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 3].event, 'Transfer');
        assert.equal(events[i * 3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3].returnValues.assetData, null);
        assert.equal(events[i * 3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[i * 3].returnValues.from, maker);
        assert.equal(events[i * 3].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3].returnValues.transferType, PROTOCOL);
        // Transfer asset to taker1
        assert.equal(events[i * 3 + 1].event, 'Transfer');
        assert.equal(events[i * 3 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 3 + 1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
        assert.equal(events[i * 3 + 1].returnValues.from, maker);
        assert.equal(events[i * 3 + 1].returnValues.to, taker1);
        assert.equal(events[i * 3 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3 + 1].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[i * 3 + 2].event, 'Transfer');
        assert.equal(events[i * 3 + 2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 3 + 2].returnValues.assetData,
          encodeTokenData(ERC721Token.address, tokenIdsArray[i]),
        );
        assert.equal(events[i * 3 + 2].returnValues.assetValue, '1');
        assert.equal(events[i * 3 + 2].returnValues.from, taker1);
        assert.equal(events[i * 3 + 2].returnValues.to, maker);
        assert.equal(events[i * 3 + 2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 3 + 2].returnValues.transferType, PAYOUT);
      }
    });

    it('full match with unsigned orders from same taker (taker == caller), royalties from registry', async () => {
      // Register ERC7215Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setRoyaltiesByToken(ERC721Token.address, royalties, {
        from: owner,
      });
      // Check that royalties have been registered for all tokenIds
      tokenIdsArray = [];
      for (let i = 1; i <= 10; i++) {
        tokenIdsArray.push(i);
      }
      royaltiesReturned = await asyncForEach(
        tokenIdsArray,
        [],
        tokenId => {
          return royaltiesRegistryProxy.getRoyalties(ERC721Token.address, tokenId);
        },
        0,
      );
      royaltiesReturned.forEach(royalty => {
        assert.equal(royalty[0].account, royaltiesRecipient_1);
        assert.equal(royalty[0].value, '100');
        assert.equal(royalty[1].account, royaltiesRecipient_2);
        assert.equal(royalty[1].value, '50');
      });
      // Mint 5 ERC721 token from the same collection to taker, with non-consecutive tokenIds
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 2
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 4
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 5
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 8
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 10
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker1 });
      assert.equal(await ERC721Token.isApprovedForAll(taker1, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial taker1 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker1));
      // Format taker orders array
      takerOrdersArray = [];
      tokenIdsArray = [2, 4, 5, 8, 10];
      tokenIdsArray.forEach(tokenId => {
        takerOrdersArray.push(
          Order(
            taker1,
            Asset(ERC721, encodeTokenData(ERC721Token.address, tokenId), '1'),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)),
            0, // salt can be 0 since taker == caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            false, // collectionBid flag set to false
          ),
        );
      });
      // Format taker orders key hashes array
      takerOrdersKeyHashesArray = await asyncForEach(takerOrdersArray, [], libOrder.hashKey, 0);
      // Format matching maker orders array (these orders will be generated on-chain from the collectionBid order
      // and taker orders, and their keyHashes will appear in the Match events fired by the Exchange proxy contract)
      makerOrdersArray = [];
      takerOrdersArray.forEach(takerOrder => {
        makerOrdersArray.push(
          Order(
            maker,
            takerOrder.takeAsset,
            ADDRESS_ZERO,
            takerOrder.makeAsset,
            0,
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            true, // collectionBid flag set to false
          ),
        );
      });
      // Format maker orders key hashes array
      makerOrdersKeyHashesArray = await asyncForEach(makerOrdersArray, [], libOrder.hashKey, 0);
      // Format orders array
      ordersArray = [collectionBidOrder].concat(takerOrdersArray);
      // Format orders' EIP712 signatures array
      ordersBytesSigArray = [collectionBidOrderBytesSig, '0x', '0x', '0x', '0x', '0x'];
      // Format orders' matchBeforeTimestamps array
      matchBeforeTimestampsArray = [matchBeforeTimestamp, 0, 0, 0, 0, 0];
      // Format orders' matchAllowance signatures array
      matchAllowanceBytesSigArray = [matchAllowanceBytesSigRight, '0x', '0x', '0x', '0x', '0x'];
      // Match collection bid orders
      tx = await exchangeHelperProxy.matchCollectionBidOrder(
        ordersArray,
        ordersBytesSigArray,
        matchBeforeTimestampsArray,
        matchAllowanceBytesSigArray,
        { from: taker1 },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(5, 16), // 0.05 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check that royalties were paid
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(5, 16),
      ); // 0.05 WETH
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_2)).toString(),
        expandToDecimalsString(25, 15),
      ); // 0.025 WETH
      // Check makers and takers balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '5');
      assert.equal((await ERC721Token.balanceOf(taker1)).toString(), '0');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        '0', // 0 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(4875, 15));
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(collectionBidOrderKeyHash)).toString(), '5');
      // Check emitted events
      // Match events
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 5);
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, taker1);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expandToDecimalsString(1, 18));
        assert.equal(events[i].returnValues.newRightFill, '1');
      }
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 25);
      for (let i = 0; i < events.length / 5; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 5].event, 'Transfer');
        assert.equal(events[i * 5].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5].returnValues.assetData, null);
        assert.equal(events[i * 5].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[i * 5].returnValues.from, maker);
        assert.equal(events[i * 5].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 5].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5].returnValues.transferType, PROTOCOL);
        // Transfer royalties (1/2)
        assert.equal(events[i * 5 + 1].event, 'Transfer');
        assert.equal(events[i * 5 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 5 + 1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[i * 5 + 1].returnValues.from, maker);
        assert.equal(events[i * 5 + 1].returnValues.to, royaltiesRecipient_1);
        assert.equal(events[i * 5 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5 + 1].returnValues.transferType, ROYALTY);
        // Transfer royalties (2/2)
        assert.equal(events[i * 5 + 2].event, 'Transfer');
        assert.equal(events[i * 5 + 2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5 + 2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 5 + 2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
        assert.equal(events[i * 5 + 2].returnValues.from, maker);
        assert.equal(events[i * 5 + 2].returnValues.to, royaltiesRecipient_2);
        assert.equal(events[i * 5 + 2].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5 + 2].returnValues.transferType, ROYALTY);
        // Transfer asset to taker1
        assert.equal(events[i * 5 + 3].event, 'Transfer');
        assert.equal(events[i * 5 + 3].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5 + 3].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 5 + 3].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 WETH
        assert.equal(events[i * 5 + 3].returnValues.from, maker);
        assert.equal(events[i * 5 + 3].returnValues.to, taker1);
        assert.equal(events[i * 5 + 3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5 + 3].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[i * 5 + 4].event, 'Transfer');
        assert.equal(events[i * 5 + 4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 5 + 4].returnValues.assetData,
          encodeTokenData(ERC721Token.address, tokenIdsArray[i]),
        );
        assert.equal(events[i * 5 + 4].returnValues.assetValue, '1');
        assert.equal(events[i * 5 + 4].returnValues.from, taker1);
        assert.equal(events[i * 5 + 4].returnValues.to, maker);
        assert.equal(events[i * 5 + 4].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 5 + 4].returnValues.transferType, PAYOUT);
      }
    });

    it('full match with unsigned orders from same taker (taker == caller), taker order origin fees', async () => {
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
      // Mint 5 ERC721 token from the same collection to taker, with non-consecutive tokenIds
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 2
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 4
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 5
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 8
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 10
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker1 });
      assert.equal(await ERC721Token.isApprovedForAll(taker1, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial taker1 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker1));
      // Format taker orders array
      takerOrdersArray = [];
      tokenIdsArray = [2, 4, 5, 8, 10];
      tokenIdsArray.forEach(tokenId => {
        takerOrdersArray.push(
          Order(
            taker1,
            Asset(ERC721, encodeTokenData(ERC721Token.address, tokenId), '1'),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)),
            0, // salt can be 0 since taker == caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
            encodedOrderData[1], // data
            false, // collectionBid flag set to false
          ),
        );
      });
      // Format taker orders key hashes array
      takerOrdersKeyHashesArray = await asyncForEach(takerOrdersArray, [], libOrder.hashKey, 0);
      // Format matching maker orders array (these orders will be generated on-chain from the collectionBid order
      // and taker orders, and their keyHashes will appear in the Match events fired by the Exchange proxy contract)
      makerOrdersArray = [];
      takerOrdersArray.forEach(takerOrder => {
        makerOrdersArray.push(
          Order(
            maker,
            takerOrder.takeAsset,
            ADDRESS_ZERO,
            takerOrder.makeAsset,
            0,
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            true, // collectionBid flag set to false
          ),
        );
      });
      // Format maker orders key hashes array
      makerOrdersKeyHashesArray = await asyncForEach(makerOrdersArray, [], libOrder.hashKey, 0);
      // Format orders array
      ordersArray = [collectionBidOrder].concat(takerOrdersArray);
      // Format orders' EIP712 signatures array
      ordersBytesSigArray = [collectionBidOrderBytesSig, '0x', '0x', '0x', '0x', '0x'];
      // Format orders' matchBeforeTimestamps array
      matchBeforeTimestampsArray = [matchBeforeTimestamp, 0, 0, 0, 0, 0];
      // Format orders' matchAllowance signatures array
      matchAllowanceBytesSigArray = [matchAllowanceBytesSigRight, '0x', '0x', '0x', '0x', '0x'];
      // Match collection bid orders
      tx = await exchangeHelperProxy.matchCollectionBidOrder(
        ordersArray,
        ordersBytesSigArray,
        matchBeforeTimestampsArray,
        matchAllowanceBytesSigArray,
        { from: taker1 },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(5, 16), // 0.05 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check that origin fees were paid
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_1)).toString(),
        expandToDecimalsString(5, 16), // 0.05 WEH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        expandToDecimalsString(25, 15), // 0.025 WEH
      );
      // Check makers and takers balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '5');
      assert.equal((await ERC721Token.balanceOf(taker1)).toString(), '0');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        '0', // 0 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(4875, 15));
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(collectionBidOrderKeyHash)).toString(), '5');
      // Check emitted events
      // Match events
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 5);
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, taker1);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expandToDecimalsString(1, 18));
        assert.equal(events[i].returnValues.newRightFill, '1');
      }
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 25);
      for (let i = 0; i < events.length / 5; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 5].event, 'Transfer');
        assert.equal(events[i * 5].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5].returnValues.assetData, null);
        assert.equal(events[i * 5].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[i * 5].returnValues.from, maker);
        assert.equal(events[i * 5].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 5].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5].returnValues.transferType, PROTOCOL);
        // Transfer origin fees (1/2)
        assert.equal(events[i * 5 + 1].event, 'Transfer');
        assert.equal(events[i * 5 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 5 + 1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[i * 5 + 1].returnValues.from, maker);
        assert.equal(events[i * 5 + 1].returnValues.to, originFeeRecipient_1);
        assert.equal(events[i * 5 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5 + 1].returnValues.transferType, ORIGIN);
        // Transfer origin fees (2/2)
        assert.equal(events[i * 5 + 2].event, 'Transfer');
        assert.equal(events[i * 5 + 2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5 + 2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 5 + 2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
        assert.equal(events[i * 5 + 2].returnValues.from, maker);
        assert.equal(events[i * 5 + 2].returnValues.to, originFeeRecipient_2);
        assert.equal(events[i * 5 + 2].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5 + 2].returnValues.transferType, ORIGIN);
        // Transfer asset to taker1
        assert.equal(events[i * 5 + 3].event, 'Transfer');
        assert.equal(events[i * 5 + 3].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5 + 3].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 5 + 3].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 WETH
        assert.equal(events[i * 5 + 3].returnValues.from, maker);
        assert.equal(events[i * 5 + 3].returnValues.to, taker1);
        assert.equal(events[i * 5 + 3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5 + 3].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[i * 5 + 4].event, 'Transfer');
        assert.equal(events[i * 5 + 4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 5 + 4].returnValues.assetData,
          encodeTokenData(ERC721Token.address, tokenIdsArray[i]),
        );
        assert.equal(events[i * 5 + 4].returnValues.assetValue, '1');
        assert.equal(events[i * 5 + 4].returnValues.from, taker1);
        assert.equal(events[i * 5 + 4].returnValues.to, maker);
        assert.equal(events[i * 5 + 4].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 5 + 4].returnValues.transferType, PAYOUT);
      }
    });

    it('full match with unsigned orders from same taker (taker == caller), maker order origin fees', async () => {
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
      // Format maker collectionBid order with origin fees
      // Collection bid order (maker order)
      collectionBidOrder = Order(
        maker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 18)), // Willing to pay 5 WETH total
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 999), '5'), // Bid for 5 NFT total
        1, // salt cannot be 0
        latestTimestamp, // start
        matchBeforeTimestamp, // end
        ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
        encodedOrderData[1], // data
        true, // collectionBid flag set to true
      );
      // Generate collection bid order EIP712 typed data signature
      makerSignature = await signOrderData(
        web3,
        maker,
        collectionBidOrder,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // makerSignature must be converted to bytes buffer before submission
      collectionBidOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // Get extra WETH to maker to pay for maker order origin fees
      await weth.deposit({ from: maker, value: expandToDecimals(75, 15) }); // Deposit 0.075 ETH to get 0.075 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(5075, 15));
      // Approve exchange proxy for transferring makeAsset (transfer to order taker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(5075, 15), { from: maker });
      assert.equal(
        (await weth.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(5075, 15),
      );
      // Mint 5 ERC721 token from the same collection to taker, with non-consecutive tokenIds
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 2
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 4
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 5
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 8
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 10
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker1 });
      assert.equal(await ERC721Token.isApprovedForAll(taker1, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial taker1 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker1));
      // Format taker orders array
      takerOrdersArray = [];
      tokenIdsArray = [2, 4, 5, 8, 10];
      tokenIdsArray.forEach(tokenId => {
        takerOrdersArray.push(
          Order(
            taker1,
            Asset(ERC721, encodeTokenData(ERC721Token.address, tokenId), '1'),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)),
            0, // salt can be 0 since taker == caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            false, // collectionBid flag set to false
          ),
        );
      });
      // Format taker orders key hashes array
      takerOrdersKeyHashesArray = await asyncForEach(takerOrdersArray, [], libOrder.hashKey, 0);
      // Format matching maker orders array (these orders will be generated on-chain from the collectionBid order
      // and taker orders, and their keyHashes will appear in the Match events fired by the Exchange proxy contract)
      makerOrdersArray = [];
      takerOrdersArray.forEach(takerOrder => {
        makerOrdersArray.push(
          Order(
            maker,
            takerOrder.takeAsset,
            ADDRESS_ZERO,
            takerOrder.makeAsset,
            0,
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
            encodedOrderData[1], // data
            true, // collectionBid flag set to false
          ),
        );
      });
      // Format maker orders key hashes array
      makerOrdersKeyHashesArray = await asyncForEach(makerOrdersArray, [], libOrder.hashKey, 0);
      // Format orders array
      ordersArray = [collectionBidOrder].concat(takerOrdersArray);
      // Format orders' EIP712 signatures array
      ordersBytesSigArray = [collectionBidOrderBytesSig, '0x', '0x', '0x', '0x', '0x'];
      // Format orders' matchBeforeTimestamps array
      matchBeforeTimestampsArray = [matchBeforeTimestamp, 0, 0, 0, 0, 0];
      // Format orders' matchAllowance signatures array
      matchAllowanceBytesSigArray = [matchAllowanceBytesSigRight, '0x', '0x', '0x', '0x', '0x'];
      // Match collection bid orders
      tx = await exchangeHelperProxy.matchCollectionBidOrder(
        ordersArray,
        ordersBytesSigArray,
        matchBeforeTimestampsArray,
        matchAllowanceBytesSigArray,
        { from: taker1 },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(5, 16), // 0.05 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check that origin fees were paid
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_1)).toString(),
        expandToDecimalsString(5, 16), // 0.05 WEH
      );
      assert.equal(
        (await weth.balanceOf(originFeeRecipient_2)).toString(),
        expandToDecimalsString(25, 15), // 0.025 WEH
      );
      // Check makers and takers balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '5');
      assert.equal((await ERC721Token.balanceOf(taker1)).toString(), '0');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        '0', // 0 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(495, 16));
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(collectionBidOrderKeyHash)).toString(), '5');
      // Check emitted events
      // Match events
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 5);
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, taker1);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expandToDecimalsString(1, 18));
        assert.equal(events[i].returnValues.newRightFill, '1');
      }
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 25);
      for (let i = 0; i < events.length / 5; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 5].event, 'Transfer');
        assert.equal(events[i * 5].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5].returnValues.assetData, null);
        assert.equal(events[i * 5].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[i * 5].returnValues.from, maker);
        assert.equal(events[i * 5].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 5].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5].returnValues.transferType, PROTOCOL);
        // Transfer origin fees (1/2)
        assert.equal(events[i * 5 + 1].event, 'Transfer');
        assert.equal(events[i * 5 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 5 + 1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[i * 5 + 1].returnValues.from, maker);
        assert.equal(events[i * 5 + 1].returnValues.to, originFeeRecipient_1);
        assert.equal(events[i * 5 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5 + 1].returnValues.transferType, ORIGIN);
        // Transfer origin fees (2/2)
        assert.equal(events[i * 5 + 2].event, 'Transfer');
        assert.equal(events[i * 5 + 2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5 + 2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 5 + 2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
        assert.equal(events[i * 5 + 2].returnValues.from, maker);
        assert.equal(events[i * 5 + 2].returnValues.to, originFeeRecipient_2);
        assert.equal(events[i * 5 + 2].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5 + 2].returnValues.transferType, ORIGIN);
        // Transfer asset to taker1
        assert.equal(events[i * 5 + 3].event, 'Transfer');
        assert.equal(events[i * 5 + 3].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5 + 3].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 5 + 3].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
        assert.equal(events[i * 5 + 3].returnValues.from, maker);
        assert.equal(events[i * 5 + 3].returnValues.to, taker1);
        assert.equal(events[i * 5 + 3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5 + 3].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[i * 5 + 4].event, 'Transfer');
        assert.equal(events[i * 5 + 4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 5 + 4].returnValues.assetData,
          encodeTokenData(ERC721Token.address, tokenIdsArray[i]),
        );
        assert.equal(events[i * 5 + 4].returnValues.assetValue, '1');
        assert.equal(events[i * 5 + 4].returnValues.from, taker1);
        assert.equal(events[i * 5 + 4].returnValues.to, maker);
        assert.equal(events[i * 5 + 4].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 5 + 4].returnValues.transferType, PAYOUT);
      }
    });

    it('full match with unsigned orders from same taker (taker == caller), taker order payouts', async () => {
      // Define taker order data including payouts
      orderData = {
        dataType: 'RARIBLE_V2_DATA_V1',
        payouts: [
          [taker1.toString(), '7500'], // 75% payout to taker1
          [taker2.toString(), '2500'], // 25% payout to taker2
        ],
        originFees: [],
      };
      // Encode order data
      encodedOrderData = encodeOrderData(orderData);
      // Mint 5 ERC721 token from the same collection to taker, with non-consecutive tokenIds
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 2
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 4
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 5
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 8
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 10
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker1 });
      assert.equal(await ERC721Token.isApprovedForAll(taker1, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial taker1 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker1));
      // Format taker orders array
      takerOrdersArray = [];
      tokenIdsArray = [2, 4, 5, 8, 10];
      tokenIdsArray.forEach(tokenId => {
        takerOrdersArray.push(
          Order(
            taker1,
            Asset(ERC721, encodeTokenData(ERC721Token.address, tokenId), '1'),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)),
            0, // salt can be 0 since taker == caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
            encodedOrderData[1], // data
            false, // collectionBid flag set to false
          ),
        );
      });
      // Format taker orders key hashes array
      takerOrdersKeyHashesArray = await asyncForEach(takerOrdersArray, [], libOrder.hashKey, 0);
      // Format matching maker orders array (these orders will be generated on-chain from the collectionBid order
      // and taker orders, and their keyHashes will appear in the Match events fired by the Exchange proxy contract)
      makerOrdersArray = [];
      takerOrdersArray.forEach(takerOrder => {
        makerOrdersArray.push(
          Order(
            maker,
            takerOrder.takeAsset,
            ADDRESS_ZERO,
            takerOrder.makeAsset,
            0,
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            true, // collectionBid flag set to false
          ),
        );
      });
      // Format maker orders key hashes array
      makerOrdersKeyHashesArray = await asyncForEach(makerOrdersArray, [], libOrder.hashKey, 0);
      // Format orders array
      ordersArray = [collectionBidOrder].concat(takerOrdersArray);
      // Format orders' EIP712 signatures array
      ordersBytesSigArray = [collectionBidOrderBytesSig, '0x', '0x', '0x', '0x', '0x'];
      // Format orders' matchBeforeTimestamps array
      matchBeforeTimestampsArray = [matchBeforeTimestamp, 0, 0, 0, 0, 0];
      // Format orders' matchAllowance signatures array
      matchAllowanceBytesSigArray = [matchAllowanceBytesSigRight, '0x', '0x', '0x', '0x', '0x'];
      // Match collection bid orders
      tx = await exchangeHelperProxy.matchCollectionBidOrder(
        ordersArray,
        ordersBytesSigArray,
        matchBeforeTimestampsArray,
        matchAllowanceBytesSigArray,
        { from: taker1 },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(5, 16), // 0.05 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check makers and takers balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '5');
      assert.equal((await ERC721Token.balanceOf(taker1)).toString(), '0');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        '0', // 0 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(37125, 14));
      assert.equal((await weth.balanceOf(taker2)).toString(), expandToDecimalsString(12375, 14));

      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(collectionBidOrderKeyHash)).toString(), '5');
      // Check emitted events
      // Match events
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 5);
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, taker1);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expandToDecimalsString(1, 18));
        assert.equal(events[i].returnValues.newRightFill, '1');
      }
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 20);
      for (let i = 0; i < events.length / 4; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 4].event, 'Transfer');
        assert.equal(events[i * 4].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 4].returnValues.assetData, null);
        assert.equal(events[i * 4].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[i * 4].returnValues.from, maker);
        assert.equal(events[i * 4].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 4].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 4].returnValues.transferType, PROTOCOL);
        // Transfer asset to taker1
        assert.equal(events[i * 4 + 1].event, 'Transfer');
        assert.equal(events[i * 4 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 4 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 4 + 1].returnValues.assetValue, expandToDecimalsString(7425, 14)); // 0.7425 WETH
        assert.equal(events[i * 4 + 1].returnValues.from, maker);
        assert.equal(events[i * 4 + 1].returnValues.to, taker1);
        assert.equal(events[i * 4 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 4 + 1].returnValues.transferType, PAYOUT);
        // Transfer asset to taker2
        assert.equal(events[i * 4 + 2].event, 'Transfer');
        assert.equal(events[i * 4 + 2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 4 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 4 + 2].returnValues.assetValue, expandToDecimalsString(2475, 14)); // 0.2475 WETH
        assert.equal(events[i * 4 + 2].returnValues.from, maker);
        assert.equal(events[i * 4 + 2].returnValues.to, taker2);
        assert.equal(events[i * 4 + 2].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 4 + 2].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[i * 4 + 3].event, 'Transfer');
        assert.equal(events[i * 4 + 3].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 4 + 3].returnValues.assetData,
          encodeTokenData(ERC721Token.address, tokenIdsArray[i]),
        );
        assert.equal(events[i * 4 + 3].returnValues.assetValue, '1');
        assert.equal(events[i * 4 + 3].returnValues.from, taker1);
        assert.equal(events[i * 4 + 3].returnValues.to, maker);
        assert.equal(events[i * 4 + 3].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 4 + 3].returnValues.transferType, PAYOUT);
      }
    });

    it('full match with unsigned orders from same taker (taker == caller), maker order payouts', async () => {
      // Define maker order data including payouts
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
      // Format maker collectionBid order with payouts
      // Collection bid order (maker order)
      collectionBidOrder = Order(
        maker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 18)), // Willing to pay 5 WETH total
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 999), '5'), // Bid for 5 NFT total
        1, // salt cannot be 0
        latestTimestamp, // start
        matchBeforeTimestamp, // end
        ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
        encodedOrderData[1], // data
        true, // collectionBid flag set to true
      );
      // Generate collection bid order EIP712 typed data signature
      makerSignature = await signOrderData(
        web3,
        maker,
        collectionBidOrder,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // makerSignature must be converted to bytes buffer before submission
      collectionBidOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // Mint 5 ERC721 token from the same collection to taker, with non-consecutive tokenIds
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 2
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 4
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 5
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 8
      await ERC721Token.mint(owner, { from: owner });
      await ERC721Token.mint(taker1, { from: owner }); // tokenId 10
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker1 });
      assert.equal(await ERC721Token.isApprovedForAll(taker1, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial taker1 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker1));
      // Format taker orders array
      takerOrdersArray = [];
      tokenIdsArray = [2, 4, 5, 8, 10];
      tokenIdsArray.forEach(tokenId => {
        takerOrdersArray.push(
          Order(
            taker1,
            Asset(ERC721, encodeTokenData(ERC721Token.address, tokenId), '1'),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)),
            0, // salt can be 0 since taker == caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            false, // collectionBid flag set to false
          ),
        );
      });
      // Format taker orders key hashes array
      takerOrdersKeyHashesArray = await asyncForEach(takerOrdersArray, [], libOrder.hashKey, 0);
      // Format matching maker orders array (these orders will be generated on-chain from the collectionBid order
      // and taker orders, and their keyHashes will appear in the Match events fired by the Exchange proxy contract)
      makerOrdersArray = [];
      takerOrdersArray.forEach(takerOrder => {
        makerOrdersArray.push(
          Order(
            maker,
            takerOrder.takeAsset,
            ADDRESS_ZERO,
            takerOrder.makeAsset,
            0,
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            ORDER_DATA_V1, // keccak256('V1') (see LibOrderDataV1)
            encodedOrderData[1], // data
            true, // collectionBid flag set to false
          ),
        );
      });
      // Format maker orders key hashes array
      makerOrdersKeyHashesArray = await asyncForEach(makerOrdersArray, [], libOrder.hashKey, 0);
      // Format orders array
      ordersArray = [collectionBidOrder].concat(takerOrdersArray);
      // Format orders' EIP712 signatures array
      ordersBytesSigArray = [collectionBidOrderBytesSig, '0x', '0x', '0x', '0x', '0x'];
      // Format orders' matchBeforeTimestamps array
      matchBeforeTimestampsArray = [matchBeforeTimestamp, 0, 0, 0, 0, 0];
      // Format orders' matchAllowance signatures array
      matchAllowanceBytesSigArray = [matchAllowanceBytesSigRight, '0x', '0x', '0x', '0x', '0x'];
      // Match collection bid orders
      tx = await exchangeHelperProxy.matchCollectionBidOrder(
        ordersArray,
        ordersBytesSigArray,
        matchBeforeTimestampsArray,
        matchAllowanceBytesSigArray,
        { from: taker1 },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(5, 16), // 0.05 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check makers and takers balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0'); // maker gets no payout
      assert.equal((await ERC721Token.balanceOf(other)).toString(), '5'); // other gets the full payout since
      // ERC721 tokens are not divisible
      assert.equal((await ERC721Token.balanceOf(taker1)).toString(), '0');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        '0', // 0 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(495, 16));
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(collectionBidOrderKeyHash)).toString(), '5');
      // Check emitted events
      // Match events
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 5);
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, taker1);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expandToDecimalsString(1, 18));
        assert.equal(events[i].returnValues.newRightFill, '1');
      }
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 15);
      for (let i = 0; i < events.length / 3; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 3].event, 'Transfer');
        assert.equal(events[i * 3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3].returnValues.assetData, null);
        assert.equal(events[i * 3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[i * 3].returnValues.from, maker);
        assert.equal(events[i * 3].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3].returnValues.transferType, PROTOCOL);
        // Transfer asset to taker1
        assert.equal(events[i * 3 + 1].event, 'Transfer');
        assert.equal(events[i * 3 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 3 + 1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
        assert.equal(events[i * 3 + 1].returnValues.from, maker);
        assert.equal(events[i * 3 + 1].returnValues.to, taker1);
        assert.equal(events[i * 3 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3 + 1].returnValues.transferType, PAYOUT);
        // Transfer asset to other
        assert.equal(events[i * 3 + 2].event, 'Transfer');
        assert.equal(events[i * 3 + 2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 3 + 2].returnValues.assetData,
          encodeTokenData(ERC721Token.address, tokenIdsArray[i]),
        );
        assert.equal(events[i * 3 + 2].returnValues.assetValue, '1');
        assert.equal(events[i * 3 + 2].returnValues.from, taker1);
        assert.equal(events[i * 3 + 2].returnValues.to, other);
        assert.equal(events[i * 3 + 2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 3 + 2].returnValues.transferType, PAYOUT);
      }
    });
  });

  describe('matchCollectionBidOrder: make WETH, take ERC1155', () => {
    beforeEach(async () => {
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(5, 18) }); // Deposit 5 ETH to get 5 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(5, 18));
      // Approve exchange proxy for transferring makeAsset (transfer to order taker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(5, 18), { from: maker });
      assert.equal(
        (await weth.allowance(maker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(5, 18),
      );
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      matchBeforeTimestamp = latestTimestamp + 100000;
      // Collection bid order (maker order)
      collectionBidOrder = Order(
        maker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 18)), // Willing to pay 5 WETH total
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(ERC1155, encodeTokenData(ERC1155Token.address, 999), '5'), // Bid for 5 NFT total
        1, // salt cannot be 0
        latestTimestamp, // start
        matchBeforeTimestamp, // end
        '0xffffffff', // dataType
        '0x', // data,
        true, // collectionBid flag set to true
      );
      // Calculate collectionBidOrder key hash
      collectionBidOrderKeyHash = await libOrder.hashKey(collectionBidOrder);
      // Generate collection bid order EIP712 typed data signature
      makerSignature = await signOrderData(
        web3,
        maker,
        collectionBidOrder,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // makerSignature must be converted to bytes buffer before submission
      collectionBidOrderBytesSig = Buffer.from(makerSignature.slice(2), 'hex');
      // Generate collection bid order matchAllowance
      // matchAllowanceRight
      matchAllowanceRight = MatchAllowance(collectionBidOrderKeyHash, matchBeforeTimestamp);
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

    it('full match with unsigned orders from same taker (taker == caller)', async () => {
      // Mint 5 ERC1155 token from the same collection to taker, with 3 different non-consecutive tokenIds
      await ERC1155Token.mint(owner, 1, 4, '0x', { from: owner });
      await ERC1155Token.mint(taker1, 1, 1, '0x', { from: owner }); // 1x tokenId 1
      await ERC1155Token.mint(owner, 2, 12, '0x', { from: owner });
      await ERC1155Token.mint(taker1, 3, 2, '0x', { from: owner }); // 2x tokenId 3
      await ERC1155Token.mint(owner, 4, 7, '0x', { from: owner });
      await ERC1155Token.mint(owner, 5, 2, '0x', { from: owner });
      await ERC1155Token.mint(taker1, 5, 2, '0x', { from: owner }); // 2x tokenId 5
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker1 });
      assert.equal(await ERC1155Token.isApprovedForAll(taker1, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial taker1 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker1));
      // Format taker orders array
      takerOrdersArray = [];
      tokenIdsArray = [1, 3, 5];
      tokenValuesArray = ['1', '2', '2'];
      WETHValuesArray = [
        expandToDecimalsString(1, 18),
        expandToDecimalsString(2, 18),
        expandToDecimalsString(2, 18),
      ];
      for (let i = 0; i < tokenIdsArray.length; i++) {
        takerOrdersArray.push(
          Order(
            taker1,
            Asset(
              ERC1155,
              encodeTokenData(ERC1155Token.address, tokenIdsArray[i]),
              tokenValuesArray[i],
            ),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), WETHValuesArray[i]),
            0, // salt can be 0 since taker == caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            false, // collectionBid flag set to false
          ),
        );
      }
      // Format taker orders key hashes array
      takerOrdersKeyHashesArray = await asyncForEach(takerOrdersArray, [], libOrder.hashKey, 0);
      // Format matching maker orders array (these orders will be generated on-chain from the collectionBid order
      // and taker orders, and their keyHashes will appear in the Match events fired by the Exchange proxy contract)
      makerOrdersArray = [];
      takerOrdersArray.forEach(takerOrder => {
        makerOrdersArray.push(
          Order(
            maker,
            takerOrder.takeAsset,
            ADDRESS_ZERO,
            takerOrder.makeAsset,
            0,
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            true, // collectionBid flag set to false
          ),
        );
      });
      // Format maker orders key hashes array
      makerOrdersKeyHashesArray = await asyncForEach(makerOrdersArray, [], libOrder.hashKey, 0);
      // Format orders array
      ordersArray = [collectionBidOrder].concat(takerOrdersArray);
      // Format orders' EIP712 signatures array
      ordersBytesSigArray = [collectionBidOrderBytesSig, '0x', '0x', '0x'];
      // Format orders' matchBeforeTimestamps array
      matchBeforeTimestampsArray = [matchBeforeTimestamp, 0, 0, 0];
      // Format orders' matchAllowance signatures array
      matchAllowanceBytesSigArray = [matchAllowanceBytesSigRight, '0x', '0x', '0x'];
      // Match collection bid orders
      tx = await exchangeHelperProxy.matchCollectionBidOrder(
        ordersArray,
        ordersBytesSigArray,
        matchBeforeTimestampsArray,
        matchAllowanceBytesSigArray,
        { from: taker1 },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(5, 16), // 0.05 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check makers and takers balances
      assert.equal((await ERC1155Token.balanceOf(maker, '1')).toString(), '1');
      assert.equal((await ERC1155Token.balanceOf(maker, '3')).toString(), '2');
      assert.equal((await ERC1155Token.balanceOf(maker, '5')).toString(), '2');
      assert.equal((await ERC1155Token.balanceOf(taker1, '1')).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker1, '3')).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker1, '5')).toString(), '0');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        '0', // 0 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(495, 16));
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(collectionBidOrderKeyHash)).toString(), '5');
      // Check emitted events
      expectedProtocolFeeValuesArray = [
        expandToDecimalsString(1, 16),
        expandToDecimalsString(2, 16),
        expandToDecimalsString(2, 16),
      ];
      expectedPayoutValuesArray = [
        expandToDecimalsString(99, 16),
        expandToDecimalsString(198, 16),
        expandToDecimalsString(198, 16),
      ];
      expectedFillValuesArray = [
        expandToDecimalsString(1, 18),
        expandToDecimalsString(2, 18),
        expandToDecimalsString(2, 18),
      ];
      // Match events
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 3);
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, taker1);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expectedFillValuesArray[i]);
        assert.equal(events[i].returnValues.newRightFill, tokenValuesArray[i]);
      }
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 9);
      for (let i = 0; i < events.length / 3; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 3].event, 'Transfer');
        assert.equal(events[i * 3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3].returnValues.assetData, null);
        assert.equal(events[i * 3].returnValues.assetValue, expectedProtocolFeeValuesArray[i]);
        assert.equal(events[i * 3].returnValues.from, maker);
        assert.equal(events[i * 3].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3].returnValues.transferType, PROTOCOL);
        // Transfer asset to taker1
        assert.equal(events[i * 3 + 1].event, 'Transfer');
        assert.equal(events[i * 3 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 3 + 1].returnValues.assetValue, expectedPayoutValuesArray[i]);
        assert.equal(events[i * 3 + 1].returnValues.from, maker);
        assert.equal(events[i * 3 + 1].returnValues.to, taker1);
        assert.equal(events[i * 3 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3 + 1].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[i * 3 + 2].event, 'Transfer');
        assert.equal(events[i * 3 + 2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 3 + 2].returnValues.assetData,
          encodeTokenData(ERC1155Token.address, tokenIdsArray[i]),
        );
        assert.equal(events[i * 3 + 2].returnValues.assetValue, tokenValuesArray[i]);
        assert.equal(events[i * 3 + 2].returnValues.from, taker1);
        assert.equal(events[i * 3 + 2].returnValues.to, maker);
        assert.equal(events[i * 3 + 2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 3 + 2].returnValues.transferType, PAYOUT);
      }
    });

    it('full match with orders from two different takers (taker1 == caller)', async () => {
      // Mint 5 ERC1155 token from the same collection to taker, with 3 different non-consecutive tokenIds
      await ERC1155Token.mint(taker2, 1, 4, '0x', { from: owner }); // 4x tokenId 1
      await ERC1155Token.mint(taker1, 1, 1, '0x', { from: owner }); // 1x tokenId 1
      await ERC1155Token.mint(owner, 2, 12, '0x', { from: owner });
      await ERC1155Token.mint(taker1, 3, 2, '0x', { from: owner }); // 2x tokenId 3
      await ERC1155Token.mint(owner, 4, 7, '0x', { from: owner });
      await ERC1155Token.mint(taker2, 5, 2, '0x', { from: owner }); // 2x tokenId 5
      await ERC1155Token.mint(taker1, 5, 2, '0x', { from: owner }); // 2x tokenId 5
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker1 });
      assert.equal(await ERC1155Token.isApprovedForAll(taker1, exchangeProxyAddress), true);
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker2 });
      assert.equal(await ERC1155Token.isApprovedForAll(taker2, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial taker1 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker1));
      // Get initial taker2 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker2));
      // Push taker1 orders to takerOrdersArray
      takerOrdersArray = [];
      tokenIdsArray1 = [1, 3];
      tokenValuesArray1 = ['1', '2'];
      WETHValuesArray1 = [expandToDecimalsString(1, 18), expandToDecimalsString(2, 18)];
      for (let i = 0; i < tokenIdsArray1.length; i++) {
        takerOrdersArray.push(
          Order(
            taker1,
            Asset(
              ERC1155,
              encodeTokenData(ERC1155Token.address, tokenIdsArray1[i]),
              tokenValuesArray1[i],
            ),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), WETHValuesArray1[i]),
            0, // salt can be 0 since taker == caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            false, // collectionBid flag set to false
          ),
        );
      }
      // Push taker2 orders to takerOrdersArray
      tokenIdsArray2 = [5];
      tokenValuesArray2 = ['2'];
      WETHValuesArray2 = [expandToDecimalsString(2, 18)];
      for (let i = 0; i < tokenIdsArray2.length; i++) {
        takerOrdersArray.push(
          Order(
            taker2,
            Asset(
              ERC1155,
              encodeTokenData(ERC1155Token.address, tokenIdsArray2[i]),
              tokenValuesArray2[i],
            ),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), WETHValuesArray2[i]),
            1, // salt can not be 0 since taker2 != caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            false, // collectionBid flag set to false
          ),
        );
      }
      // Format taker orders key hashes array
      takerOrdersKeyHashesArray = await asyncForEach(takerOrdersArray, [], libOrder.hashKey, 0);
      // Format taker2 orders EIP712 signatures array
      taker2OrdersSignaturesArray = await asyncForEach(
        [takerOrdersArray[2]],
        [],
        order => {
          return signOrderData(web3, taker2, order, exchangeProxyAddress, CHAIN_ID);
        },
        0,
      );
      // taker2 signatures must be converted to bytes buffer before submission
      taker2OrdersBytesSigArray = [];
      taker2OrdersSignaturesArray.forEach(sig => {
        taker2OrdersBytesSigArray.push(Buffer.from(sig.slice(2), 'hex'));
      });
      // Generate taker2 orders matchAllowance
      taker2OrdersMatchAllowancesArray = [];
      [takerOrdersKeyHashesArray[2]].forEach(keyHash => {
        taker2OrdersMatchAllowancesArray.push(MatchAllowance(keyHash, matchBeforeTimestamp));
      });
      // Generate taker 2 orders matchAllowance EIP712 typed data signatures
      taker2OrdersMatchAllowancesSignaturesArray = await asyncForEach(
        taker2OrdersMatchAllowancesArray,
        [],
        matchAllowance => {
          return signMatchAllowance(
            web3,
            orderBook,
            matchAllowance,
            exchangeProxyAddress,
            CHAIN_ID,
          );
        },
        0,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      taker2OrdersMatchAllowancesBytesSigArray = [];
      taker2OrdersMatchAllowancesSignaturesArray.forEach(sig => {
        taker2OrdersMatchAllowancesBytesSigArray.push(Buffer.from(sig.slice(2), 'hex'));
      });
      // Format matching maker orders array (these orders will be generated on-chain from the collectionBid order
      // and taker orders, and their keyHashes will appear in the Match events fired by the Exchange proxy contract)
      makerOrdersArray = [];
      takerOrdersArray.forEach(takerOrder => {
        makerOrdersArray.push(
          Order(
            maker,
            takerOrder.takeAsset,
            ADDRESS_ZERO,
            takerOrder.makeAsset,
            0,
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            true, // collectionBid flag set to false
          ),
        );
      });
      // Format maker orders key hashes array
      makerOrdersKeyHashesArray = await asyncForEach(makerOrdersArray, [], libOrder.hashKey, 0);
      // Format orders array
      ordersArray = [collectionBidOrder].concat(takerOrdersArray);
      // Format orders' EIP712 signatures array
      ordersBytesSigArray = [collectionBidOrderBytesSig, '0x', '0x', taker2OrdersBytesSigArray[0]];
      // Format orders' matchBeforeTimestamps array
      matchBeforeTimestampsArray = [matchBeforeTimestamp, 0, 0, matchBeforeTimestamp];
      // Format orders' matchAllowance signatures array
      matchAllowanceBytesSigArray = [
        matchAllowanceBytesSigRight,
        '0x',
        '0x',
        taker2OrdersMatchAllowancesBytesSigArray[0],
      ];
      // Match collection bid orders
      tx = await exchangeHelperProxy.matchCollectionBidOrder(
        ordersArray,
        ordersBytesSigArray,
        matchBeforeTimestampsArray,
        matchAllowanceBytesSigArray,
        { from: taker1 },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(5, 16), // 0.05 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check makers and takers balances
      assert.equal((await ERC1155Token.balanceOf(maker, '1')).toString(), '1');
      assert.equal((await ERC1155Token.balanceOf(maker, '3')).toString(), '2');
      assert.equal((await ERC1155Token.balanceOf(maker, '5')).toString(), '2');
      assert.equal((await ERC1155Token.balanceOf(taker1, '1')).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker1, '3')).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker1, '5')).toString(), '2');
      assert.equal((await ERC1155Token.balanceOf(taker2, '1')).toString(), '4');
      assert.equal((await ERC1155Token.balanceOf(taker2, '5')).toString(), '0');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        '0', // 0 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(297, 16));
      assert.equal((await weth.balanceOf(taker2)).toString(), expandToDecimalsString(198, 16));
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(collectionBidOrderKeyHash)).toString(), '5');
      // Check emitted events
      expectedProtocolFeeValuesArray = [
        expandToDecimalsString(1, 16),
        expandToDecimalsString(2, 16),
        expandToDecimalsString(2, 16),
      ];
      expectedPayoutValuesArray = [
        expandToDecimalsString(99, 16),
        expandToDecimalsString(198, 16),
        expandToDecimalsString(198, 16),
      ];
      expectedFillValuesArray = [
        expandToDecimalsString(1, 18),
        expandToDecimalsString(2, 18),
        expandToDecimalsString(2, 18),
      ];
      tokenValuesArray = tokenValuesArray1.concat(tokenValuesArray2);
      tokenIdsArray = tokenIdsArray1.concat(tokenIdsArray2);
      takersArray = [taker1, taker1, taker2];
      // Match events
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 3);
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, takersArray[i]);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expectedFillValuesArray[i]);
        assert.equal(events[i].returnValues.newRightFill, tokenValuesArray[i]);
      }
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 9);
      for (let i = 0; i < events.length / 3; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 3].event, 'Transfer');
        assert.equal(events[i * 3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3].returnValues.assetData, null);
        assert.equal(events[i * 3].returnValues.assetValue, expectedProtocolFeeValuesArray[i]);
        assert.equal(events[i * 3].returnValues.from, maker);
        assert.equal(events[i * 3].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3].returnValues.transferType, PROTOCOL);
        // Transfer asset to taker
        assert.equal(events[i * 3 + 1].event, 'Transfer');
        assert.equal(events[i * 3 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 3 + 1].returnValues.assetValue, expectedPayoutValuesArray[i]);
        assert.equal(events[i * 3 + 1].returnValues.from, maker);
        assert.equal(events[i * 3 + 1].returnValues.to, takersArray[i]);
        assert.equal(events[i * 3 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3 + 1].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[i * 3 + 2].event, 'Transfer');
        assert.equal(events[i * 3 + 2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 3 + 2].returnValues.assetData,
          encodeTokenData(ERC1155Token.address, tokenIdsArray[i]),
        );
        assert.equal(events[i * 3 + 2].returnValues.assetValue, tokenValuesArray[i]);
        assert.equal(events[i * 3 + 2].returnValues.from, takersArray[i]);
        assert.equal(events[i * 3 + 2].returnValues.to, maker);
        assert.equal(events[i * 3 + 2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 3 + 2].returnValues.transferType, PAYOUT);
      }
    });

    it('full match with signed orders from same taker (taker != caller)', async () => {
      // Mint 5 ERC1155 token from the same collection to taker, with 3 different non-consecutive tokenIds
      await ERC1155Token.mint(owner, 1, 4, '0x', { from: owner });
      await ERC1155Token.mint(taker1, 1, 1, '0x', { from: owner }); // 1x tokenId 1
      await ERC1155Token.mint(owner, 2, 12, '0x', { from: owner });
      await ERC1155Token.mint(taker1, 3, 2, '0x', { from: owner }); // 2x tokenId 3
      await ERC1155Token.mint(owner, 4, 7, '0x', { from: owner });
      await ERC1155Token.mint(owner, 5, 2, '0x', { from: owner });
      await ERC1155Token.mint(taker1, 5, 2, '0x', { from: owner }); // 2x tokenId 5
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker1 });
      assert.equal(await ERC1155Token.isApprovedForAll(taker1, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial taker1 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker1));
      // Format taker orders array
      takerOrdersArray = [];
      tokenIdsArray = [1, 3, 5];
      tokenValuesArray = ['1', '2', '2'];
      WETHValuesArray = [
        expandToDecimalsString(1, 18),
        expandToDecimalsString(2, 18),
        expandToDecimalsString(2, 18),
      ];
      for (let i = 0; i < tokenIdsArray.length; i++) {
        takerOrdersArray.push(
          Order(
            taker1,
            Asset(
              ERC1155,
              encodeTokenData(ERC1155Token.address, tokenIdsArray[i]),
              tokenValuesArray[i],
            ),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), WETHValuesArray[i]),
            1, // salt cannot be 0 since taker != caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            false, // collectionBid flag set to false
          ),
        );
      }
      // Format taker orders key hashes array
      takerOrdersKeyHashesArray = await asyncForEach(takerOrdersArray, [], libOrder.hashKey, 0);
      // Format taker orders EIP712 signatures array
      takerOrdersSignaturesArray = await asyncForEach(
        takerOrdersArray,
        [],
        order => {
          return signOrderData(web3, taker1, order, exchangeProxyAddress, CHAIN_ID);
        },
        0,
      );
      // taker signatures must be converted to bytes buffer before submission
      takerOrdersBytesSigArray = [];
      takerOrdersSignaturesArray.forEach(sig => {
        takerOrdersBytesSigArray.push(Buffer.from(sig.slice(2), 'hex'));
      });
      // Generate taker orders matchAllowance
      takerOrdersMatchAllowancesArray = [];
      takerOrdersKeyHashesArray.forEach(keyHash => {
        takerOrdersMatchAllowancesArray.push(MatchAllowance(keyHash, matchBeforeTimestamp));
      });
      // Generate taker orders matchAllowance EIP712 typed data signatures
      takerOrdersMatchAllowancesSignaturesArray = await asyncForEach(
        takerOrdersMatchAllowancesArray,
        [],
        matchAllowance => {
          return signMatchAllowance(
            web3,
            orderBook,
            matchAllowance,
            exchangeProxyAddress,
            CHAIN_ID,
          );
        },
        0,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      takerOrdersMatchAllowancesBytesSigArray = [];
      takerOrdersMatchAllowancesSignaturesArray.forEach(sig => {
        takerOrdersMatchAllowancesBytesSigArray.push(Buffer.from(sig.slice(2), 'hex'));
      });
      // Format matching maker orders array (these orders will be generated on-chain from the collectionBid order
      // and taker orders, and their keyHashes will appear in the Match events fired by the Exchange proxy contract)
      makerOrdersArray = [];
      takerOrdersArray.forEach(takerOrder => {
        makerOrdersArray.push(
          Order(
            maker,
            takerOrder.takeAsset,
            ADDRESS_ZERO,
            takerOrder.makeAsset,
            0,
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            true, // collectionBid flag set to false
          ),
        );
      });
      // Format maker orders key hashes array
      makerOrdersKeyHashesArray = await asyncForEach(makerOrdersArray, [], libOrder.hashKey, 0);
      // Format orders array
      ordersArray = [collectionBidOrder].concat(takerOrdersArray);
      // Format orders' EIP712 signatures array
      ordersBytesSigArray = [collectionBidOrderBytesSig].concat(takerOrdersBytesSigArray);
      // Format orders' matchBeforeTimestamps array
      matchBeforeTimestampsArray = [
        matchBeforeTimestamp,
        matchBeforeTimestamp,
        matchBeforeTimestamp,
        matchBeforeTimestamp,
        matchBeforeTimestamp,
        matchBeforeTimestamp,
      ];
      // Format orders' matchAllowance signatures array
      matchAllowanceBytesSigArray = [matchAllowanceBytesSigRight].concat(
        takerOrdersMatchAllowancesBytesSigArray,
      );
      // Match collection bid orders
      tx = await exchangeHelperProxy.matchCollectionBidOrder(
        ordersArray,
        ordersBytesSigArray,
        matchBeforeTimestampsArray,
        matchAllowanceBytesSigArray,
        { from: owner }, // taker != caller
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(5, 16), // 0.05 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check makers and takers balances
      assert.equal((await ERC1155Token.balanceOf(maker, '1')).toString(), '1');
      assert.equal((await ERC1155Token.balanceOf(maker, '3')).toString(), '2');
      assert.equal((await ERC1155Token.balanceOf(maker, '5')).toString(), '2');
      assert.equal((await ERC1155Token.balanceOf(taker1, '1')).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker1, '3')).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker1, '5')).toString(), '0');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        '0', // 0 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(495, 16));
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(collectionBidOrderKeyHash)).toString(), '5');
      // Check emitted events
      expectedProtocolFeeValuesArray = [
        expandToDecimalsString(1, 16),
        expandToDecimalsString(2, 16),
        expandToDecimalsString(2, 16),
      ];
      expectedPayoutValuesArray = [
        expandToDecimalsString(99, 16),
        expandToDecimalsString(198, 16),
        expandToDecimalsString(198, 16),
      ];
      expectedFillValuesArray = [
        expandToDecimalsString(1, 18),
        expandToDecimalsString(2, 18),
        expandToDecimalsString(2, 18),
      ];
      // Match events
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 3);
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, taker1);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expectedFillValuesArray[i]);
        assert.equal(events[i].returnValues.newRightFill, tokenValuesArray[i]);
      }
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 9);
      for (let i = 0; i < events.length / 3; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 3].event, 'Transfer');
        assert.equal(events[i * 3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3].returnValues.assetData, null);
        assert.equal(events[i * 3].returnValues.assetValue, expectedProtocolFeeValuesArray[i]);
        assert.equal(events[i * 3].returnValues.from, maker);
        assert.equal(events[i * 3].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3].returnValues.transferType, PROTOCOL);
        // Transfer asset to taker1
        assert.equal(events[i * 3 + 1].event, 'Transfer');
        assert.equal(events[i * 3 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 3 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 3 + 1].returnValues.assetValue, expectedPayoutValuesArray[i]);
        assert.equal(events[i * 3 + 1].returnValues.from, maker);
        assert.equal(events[i * 3 + 1].returnValues.to, taker1);
        assert.equal(events[i * 3 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 3 + 1].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[i * 3 + 2].event, 'Transfer');
        assert.equal(events[i * 3 + 2].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 3 + 2].returnValues.assetData,
          encodeTokenData(ERC1155Token.address, tokenIdsArray[i]),
        );
        assert.equal(events[i * 3 + 2].returnValues.assetValue, tokenValuesArray[i]);
        assert.equal(events[i * 3 + 2].returnValues.from, taker1);
        assert.equal(events[i * 3 + 2].returnValues.to, maker);
        assert.equal(events[i * 3 + 2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 3 + 2].returnValues.transferType, PAYOUT);
      }
    });

    it('full match with unsigned orders from same taker (taker == caller), royalties from registry', async () => {
      // Register ERC7215Token royalties into RoyaltiesRegistry
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
        { account: royaltiesRecipient_2, value: 50 }, // 0.5% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setRoyaltiesByToken(ERC1155Token.address, royalties, {
        from: owner,
      });
      // Check that royalties have been registered for all tokenIds
      tokenIdsArray = [];
      for (let i = 1; i <= 10; i++) {
        tokenIdsArray.push(i);
      }
      royaltiesReturned = await asyncForEach(
        tokenIdsArray,
        [],
        tokenId => {
          return royaltiesRegistryProxy.getRoyalties(ERC1155Token.address, tokenId);
        },
        0,
      );
      royaltiesReturned.forEach(royalty => {
        assert.equal(royalty[0].account, royaltiesRecipient_1);
        assert.equal(royalty[0].value, '100');
        assert.equal(royalty[1].account, royaltiesRecipient_2);
        assert.equal(royalty[1].value, '50');
      });
      // Mint 5 ERC1155 token from the same collection to taker, with 3 different non-consecutive tokenIds
      await ERC1155Token.mint(owner, 1, 4, '0x', { from: owner });
      await ERC1155Token.mint(taker1, 1, 1, '0x', { from: owner }); // 1x tokenId 1
      await ERC1155Token.mint(owner, 2, 12, '0x', { from: owner });
      await ERC1155Token.mint(taker1, 3, 2, '0x', { from: owner }); // 2x tokenId 3
      await ERC1155Token.mint(owner, 4, 7, '0x', { from: owner });
      await ERC1155Token.mint(owner, 5, 2, '0x', { from: owner });
      await ERC1155Token.mint(taker1, 5, 2, '0x', { from: owner }); // 2x tokenId 5
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: taker1 });
      assert.equal(await ERC1155Token.isApprovedForAll(taker1, exchangeProxyAddress), true);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial taker1 ETH balance
      taker1InitialETHBalance = toBN(await getBalance(taker1));
      // Format taker orders array
      takerOrdersArray = [];
      tokenIdsArray = [1, 3, 5];
      tokenValuesArray = ['1', '2', '2'];
      WETHValuesArray = [
        expandToDecimalsString(1, 18),
        expandToDecimalsString(2, 18),
        expandToDecimalsString(2, 18),
      ];
      for (let i = 0; i < tokenIdsArray.length; i++) {
        takerOrdersArray.push(
          Order(
            taker1,
            Asset(
              ERC1155,
              encodeTokenData(ERC1155Token.address, tokenIdsArray[i]),
              tokenValuesArray[i],
            ),
            ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
            Asset(WETH, encodeTokenData(weth.address), WETHValuesArray[i]),
            0, // salt can be 0 since taker == caller
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            false, // collectionBid flag set to false
          ),
        );
      }
      // Format taker orders key hashes array
      takerOrdersKeyHashesArray = await asyncForEach(takerOrdersArray, [], libOrder.hashKey, 0);
      // Format matching maker orders array (these orders will be generated on-chain from the collectionBid order
      // and taker orders, and their keyHashes will appear in the Match events fired by the Exchange proxy contract)
      makerOrdersArray = [];
      takerOrdersArray.forEach(takerOrder => {
        makerOrdersArray.push(
          Order(
            maker,
            takerOrder.takeAsset,
            ADDRESS_ZERO,
            takerOrder.makeAsset,
            0,
            latestTimestamp, // start
            matchBeforeTimestamp, // end
            '0xffffffff', // dataType
            '0x', // data
            true, // collectionBid flag set to false
          ),
        );
      });
      // Format maker orders key hashes array
      makerOrdersKeyHashesArray = await asyncForEach(makerOrdersArray, [], libOrder.hashKey, 0);
      // Format orders array
      ordersArray = [collectionBidOrder].concat(takerOrdersArray);
      // Format orders' EIP712 signatures array
      ordersBytesSigArray = [collectionBidOrderBytesSig, '0x', '0x', '0x'];
      // Format orders' matchBeforeTimestamps array
      matchBeforeTimestampsArray = [matchBeforeTimestamp, 0, 0, 0];
      // Format orders' matchAllowance signatures array
      matchAllowanceBytesSigArray = [matchAllowanceBytesSigRight, '0x', '0x', '0x'];
      // Match collection bid orders
      tx = await exchangeHelperProxy.matchCollectionBidOrder(
        ordersArray,
        ordersBytesSigArray,
        matchBeforeTimestampsArray,
        matchAllowanceBytesSigArray,
        { from: taker1 },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(5, 16), // 0.05 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check that royalties were paid
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(5, 16),
      ); // 0.05 WETH
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_2)).toString(),
        expandToDecimalsString(25, 15),
      ); // 0.025 WETH
      // Check makers and takers balances
      assert.equal((await ERC1155Token.balanceOf(maker, '1')).toString(), '1');
      assert.equal((await ERC1155Token.balanceOf(maker, '3')).toString(), '2');
      assert.equal((await ERC1155Token.balanceOf(maker, '5')).toString(), '2');
      assert.equal((await ERC1155Token.balanceOf(taker1, '1')).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker1, '3')).toString(), '0');
      assert.equal((await ERC1155Token.balanceOf(taker1, '5')).toString(), '0');
      assert.equal(
        (await weth.balanceOf(maker)).toString(),
        '0', // 0 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(4875, 15));
      // Check that maker order fill equals rightTake value
      assert.equal((await exchangeProxy.getOrderFill(collectionBidOrderKeyHash)).toString(), '5');
      // Check emitted events
      expectedProtocolFeeValuesArray = [
        expandToDecimalsString(1, 16),
        expandToDecimalsString(2, 16),
        expandToDecimalsString(2, 16),
      ];
      expectedPayoutValuesArray = [
        expandToDecimalsString(975, 15),
        expandToDecimalsString(195, 16),
        expandToDecimalsString(195, 16),
      ];
      expectedFillValuesArray = [
        expandToDecimalsString(1, 18),
        expandToDecimalsString(2, 18),
        expandToDecimalsString(2, 18),
      ];
      expectedRoyaltiesValuesArray1 = [
        expandToDecimalsString(1, 16),
        expandToDecimalsString(2, 16),
        expandToDecimalsString(2, 16),
      ];
      expectedRoyaltiesValuesArray2 = [
        expandToDecimalsString(5, 15),
        expandToDecimalsString(1, 16),
        expandToDecimalsString(1, 16),
      ];
      // Match events
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 3);
      for (let i = 0; i < events.length; i++) {
        assert.equal(events[i].event, 'Match');
        assert.equal(events[i].returnValues.leftHash, takerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.rightHash, makerOrdersKeyHashesArray[i]);
        assert.equal(events[i].returnValues.leftMaker, taker1);
        assert.equal(events[i].returnValues.rightMaker, maker);
        assert.equal(events[i].returnValues.newLeftFill, expectedFillValuesArray[i]);
        assert.equal(events[i].returnValues.newRightFill, tokenValuesArray[i]);
      }
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 15);
      for (let i = 0; i < events.length / 5; i++) {
        // Transfer protocol fee
        assert.equal(events[i * 5].event, 'Transfer');
        assert.equal(events[i * 5].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5].returnValues.assetData, null);
        assert.equal(events[i * 5].returnValues.assetValue, expectedProtocolFeeValuesArray[i]);
        assert.equal(events[i * 5].returnValues.from, maker);
        assert.equal(events[i * 5].returnValues.to, defaultFeeReceiver);
        assert.equal(events[i * 5].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5].returnValues.transferType, PROTOCOL);
        // Transfer royalties (1/2)
        assert.equal(events[i * 5 + 1].event, 'Transfer');
        assert.equal(events[i * 5 + 1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5 + 1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 5 + 1].returnValues.assetValue, expectedRoyaltiesValuesArray1[i]);
        assert.equal(events[i * 5 + 1].returnValues.from, maker);
        assert.equal(events[i * 5 + 1].returnValues.to, royaltiesRecipient_1);
        assert.equal(events[i * 5 + 1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5 + 1].returnValues.transferType, ROYALTY);
        // Transfer royalties (2/2)
        assert.equal(events[i * 5 + 2].event, 'Transfer');
        assert.equal(events[i * 5 + 2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5 + 2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 5 + 2].returnValues.assetValue, expectedRoyaltiesValuesArray2[i]);
        assert.equal(events[i * 5 + 2].returnValues.from, maker);
        assert.equal(events[i * 5 + 2].returnValues.to, royaltiesRecipient_2);
        assert.equal(events[i * 5 + 2].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5 + 2].returnValues.transferType, ROYALTY);
        // Transfer asset to taker1
        assert.equal(events[i * 5 + 3].event, 'Transfer');
        assert.equal(events[i * 5 + 3].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[i * 5 + 3].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[i * 5 + 3].returnValues.assetValue, expectedPayoutValuesArray[i]);
        assert.equal(events[i * 5 + 3].returnValues.from, maker);
        assert.equal(events[i * 5 + 3].returnValues.to, taker1);
        assert.equal(events[i * 5 + 3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[i * 5 + 3].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[i * 5 + 4].event, 'Transfer');
        assert.equal(events[i * 5 + 4].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(
          events[i * 5 + 4].returnValues.assetData,
          encodeTokenData(ERC1155Token.address, tokenIdsArray[i]),
        );
        assert.equal(events[i * 5 + 4].returnValues.assetValue, tokenValuesArray[i]);
        assert.equal(events[i * 5 + 4].returnValues.from, taker1);
        assert.equal(events[i * 5 + 4].returnValues.to, maker);
        assert.equal(events[i * 5 + 4].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[i * 5 + 4].returnValues.transferType, PAYOUT);
      }
    });
  });
});
