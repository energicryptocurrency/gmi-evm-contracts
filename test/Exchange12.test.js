const { getBalance, getBlock } = web3.eth;
const { toBN } = web3.utils;
const truffleAssert = require('truffle-assertions');

const { Order, MatchAllowance, Asset, encodeTokenData } = require('./utils/order');
const { signOrderData, signMatchAllowance } = require('./utils/EIP712Signer');
const { ETH, WETH, ERC721, TO_MAKER, TO_TAKER, PROTOCOL, PAYOUT } = require('./utils/hashKeys');

const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';
const PROTOCOL_FEE = toBN(100); // 1% protocol fee in bps (1 bps = 0.01%)
const CHAIN_ID = toBN(1);
const ZERO_FILLER_STRING = '00000000000000000000000000000000000000000000000000000000'; // 56 zeros

let defaultFeeReceiverInitialETHBalance,
  ERC721Token,
  events,
  exchangeHelperProxy,
  exchangeHelperProxyAddress,
  exchangeProxy,
  exchangeProxyAddress,
  latestBlock,
  latestTimestamp,
  libOrder,
  maker1InitialETHBalance,
  makerOrdersArray,
  makerOrdersBytesSigArray,
  makerOrdersKeyHashesArray,
  makerSignaturesArray,
  matchAllowanceBytesSigLeftArray,
  matchAllowanceBytesSigRightArray,
  matchAllowancesLeftArray,
  matchAllowancesRightArray,
  matchAllowancesSignaturesLeftArray,
  matchAllowancesSignaturesRightArray,
  matchLeftBeforeTimestamp,
  matchRightBeforeTimestamp,
  royaltiesRegistryProxy,
  royaltiesRegistryProxyAddress,
  takerOrdersArray,
  takerOrdersBytesSigArray,
  takerOrdersKeyHashesArray,
  takerSignaturesArray,
  ordersArray,
  signaturesArray,
  matchBeforeTimestampsArray,
  orderBookSignaturesArray,
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

contract('Exchange - Functional Tests Part 12', accounts => {
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
  const TestERC1155 = artifacts.require('TestERC1155ERC2981');

  const [
    deployer,
    owner,
    other,
    maker1,
    maker2,
    maker3,
    taker1,
    taker2,
    taker3,
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
  describe('batchMatchOrders', () => {
    beforeEach(async () => {
      // Mint ERC721 token to makers
      await ERC721Token.mint(maker1, { from: owner });
      await ERC721Token.mint(maker2, { from: owner });
      await ERC721Token.mint(maker3, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker1)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(maker2)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(maker3)).toString(), '1');
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker1 });
      await ERC721Token.approve(exchangeProxyAddress, 2, { from: maker2 });
      await ERC721Token.approve(exchangeProxyAddress, 3, { from: maker3 });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      assert.equal(await ERC721Token.getApproved(2), exchangeProxyAddress);
      assert.equal(await ERC721Token.getApproved(3), exchangeProxyAddress);
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      matchRightBeforeTimestamp = latestTimestamp + 100000;
      // makerOrder objects
      makerOrdersArray = [
        Order(
          maker1, // maker
          Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
          ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
          Asset(ETH, '0x', expandToDecimalsString(5, 17)), // rightTake
          10, // salt
          latestTimestamp, // start
          matchRightBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
        Order(
          maker2, // maker
          Asset(ERC721, encodeTokenData(ERC721Token.address, 2), '1'), // rightMake
          ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
          1, // salt
          latestTimestamp, // start
          matchRightBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
        Order(
          maker3, // maker
          Asset(ERC721, encodeTokenData(ERC721Token.address, 3), '1'), // rightMake
          ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 17)), // rightTake
          3, // salt
          latestTimestamp, // start
          matchRightBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
      ];
      // Calculate maker orders key hashes
      makerOrdersKeyHashesArray = [
        await libOrder.hashKey(makerOrdersArray[0]),
        await libOrder.hashKey(makerOrdersArray[1]),
        await libOrder.hashKey(makerOrdersArray[2]),
      ];
      // Generate maker orders EIP712 typed data signatures
      makerSignaturesArray = [
        await signOrderData(web3, maker1, makerOrdersArray[0], exchangeProxyAddress, CHAIN_ID),
        await signOrderData(web3, maker2, makerOrdersArray[1], exchangeProxyAddress, CHAIN_ID),
        await signOrderData(web3, maker3, makerOrdersArray[2], exchangeProxyAddress, CHAIN_ID),
      ];
      // maker signatures must be converted to bytes buffer before submission
      makerOrdersBytesSigArray = [
        Buffer.from(makerSignaturesArray[0].slice(2), 'hex'),
        Buffer.from(makerSignaturesArray[1].slice(2), 'hex'),
        Buffer.from(makerSignaturesArray[2].slice(2), 'hex'),
      ];
      // Generate maker orders matchAllowances
      matchAllowancesRightArray = [
        MatchAllowance(makerOrdersKeyHashesArray[0], matchRightBeforeTimestamp),
        MatchAllowance(makerOrdersKeyHashesArray[1], matchRightBeforeTimestamp),
        MatchAllowance(makerOrdersKeyHashesArray[2], matchRightBeforeTimestamp),
      ];
      // Generate matchAllowance EIP712 typed data signatures
      matchAllowancesSignaturesRightArray = [
        await signMatchAllowance(
          web3,
          orderBook,
          matchAllowancesRightArray[0],
          exchangeProxyAddress,
          CHAIN_ID,
        ),
        await signMatchAllowance(
          web3,
          orderBook,
          matchAllowancesRightArray[1],
          exchangeProxyAddress,
          CHAIN_ID,
        ),
        await signMatchAllowance(
          web3,
          orderBook,
          matchAllowancesRightArray[2],
          exchangeProxyAddress,
          CHAIN_ID,
        ),
      ];
      // matchAllowanceSignatures must be converted to bytes buffers before submission
      matchAllowanceBytesSigRightArray = [
        Buffer.from(matchAllowancesSignaturesRightArray[0].slice(2), 'hex'),
        Buffer.from(matchAllowancesSignaturesRightArray[1].slice(2), 'hex'),
        Buffer.from(matchAllowancesSignaturesRightArray[2].slice(2), 'hex'),
      ];
    });

    it('match with unsigned orders from same taker (taker == caller)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker1, value: expandToDecimals(16, 17) }); // Deposit 1.6 ETH to get 1.6 WETH
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(16, 17));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(16, 17), { from: taker1 });
      assert.equal(
        (await weth.allowance(taker1, exchangeProxyAddress)).toString(),
        expandToDecimalsString(16, 17),
      );
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial maker1 ETH balance
      maker1InitialETHBalance = toBN(await getBalance(maker1));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // takerOrder objects
      takerOrdersArray = [
        Order(
          taker1,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 17)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
          0, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
        Order(
          taker1,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 2), '1'), // leftTake
          0, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
        Order(
          taker1,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 17)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 3), '1'), // leftTake
          0, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
      ];
      // Calculate taker orders key hashes
      takerOrdersKeyHashesArray = [
        await libOrder.hashKey(takerOrdersArray[0]),
        await libOrder.hashKey(takerOrdersArray[1]),
        await libOrder.hashKey(takerOrdersArray[2]),
      ];
      // Generate taker orders EIP712 typed data signatures
      takerOrdersBytesSigArray = ['0x', '0x', '0x'];
      // Generate matchAllowance EIP712 typed data signatures
      matchAllowanceBytesSigLeftArray = ['0x', '0x', '0x'];
      //Format orders array
      ordersArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        ordersArray.push(takerOrdersArray[i]);
        ordersArray.push(makerOrdersArray[i]);
      }
      //Format signatures array
      signaturesArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        signaturesArray.push(takerOrdersBytesSigArray[i]);
        signaturesArray.push(makerOrdersBytesSigArray[i]);
      }
      //Format matchBeforeTimestamps array
      matchBeforeTimestampsArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        matchBeforeTimestampsArray.push(matchLeftBeforeTimestamp);
        matchBeforeTimestampsArray.push(matchRightBeforeTimestamp);
      }
      //Format signatures array
      orderBookSignaturesArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        orderBookSignaturesArray.push(matchAllowanceBytesSigLeftArray[i]);
        orderBookSignaturesArray.push(matchAllowanceBytesSigRightArray[i]);
      }
      // Match orders by batch
      tx = await exchangeProxy.batchMatchOrders(
        ordersArray,
        signaturesArray,
        matchBeforeTimestampsArray,
        orderBookSignaturesArray,
        { from: taker1 },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(16, 15), // 0.016 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check makers and takers balances
      assert.equal((await ERC721Token.balanceOf(maker1)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(maker2)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(maker3)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker1)).toString(), '3');
      assert.equal(
        (await weth.balanceOf(maker1)).toString(),
        '0', // 0 WETH
      );
      assert.equal(
        toBN(await getBalance(maker1))
          .sub(maker1InitialETHBalance)
          .toString(),
        expandToDecimalsString(495, 15), // 0.495 ETH
      );
      assert.equal(
        (await weth.balanceOf(maker2)).toString(),
        expandToDecimalsString(99, 16), // 0.99 WETH
      );
      assert.equal(
        (await weth.balanceOf(maker3)).toString(),
        expandToDecimalsString(99, 15), // 0.099 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), '0');
      // Check that maker orders fills equal rightTake values
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrdersKeyHashesArray[0])).toString(),
        expandToDecimalsString(5, 17),
      );
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrdersKeyHashesArray[1])).toString(),
        expandToDecimalsString(1, 18),
      );
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrdersKeyHashesArray[2])).toString(),
        expandToDecimalsString(1, 17),
      );
      // Check emitted events
      // Match event
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 3);
      assert.equal(events[0].event, 'Match');
      assert.equal(events[0].returnValues.leftHash, takerOrdersKeyHashesArray[0]);
      assert.equal(events[0].returnValues.rightHash, makerOrdersKeyHashesArray[0]);
      assert.equal(events[0].returnValues.leftMaker, taker1);
      assert.equal(events[0].returnValues.rightMaker, maker1);
      assert.equal(events[0].returnValues.newLeftFill, '1');
      assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(5, 17));
      assert.equal(events[1].event, 'Match');
      assert.equal(events[1].returnValues.leftHash, takerOrdersKeyHashesArray[1]);
      assert.equal(events[1].returnValues.rightHash, makerOrdersKeyHashesArray[1]);
      assert.equal(events[1].returnValues.leftMaker, taker1);
      assert.equal(events[1].returnValues.rightMaker, maker2);
      assert.equal(events[1].returnValues.newLeftFill, '1');
      assert.equal(events[1].returnValues.newRightFill, expandToDecimalsString(1, 18));
      assert.equal(events[2].event, 'Match');
      assert.equal(events[2].returnValues.leftHash, takerOrdersKeyHashesArray[2]);
      assert.equal(events[2].returnValues.rightHash, makerOrdersKeyHashesArray[2]);
      assert.equal(events[2].returnValues.leftMaker, taker1);
      assert.equal(events[2].returnValues.rightMaker, maker3);
      assert.equal(events[2].returnValues.newLeftFill, '1');
      assert.equal(events[2].returnValues.newRightFill, expandToDecimalsString(1, 17));
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 9);
      // Transfer protocol fee
      assert.equal(events[0].event, 'Transfer');
      assert.equal(events[0].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, null);
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[0].returnValues.from, taker1);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker1
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(495, 15)); // 0.495 WETH
      assert.equal(events[1].returnValues.from, taker1);
      assert.equal(events[1].returnValues.to, maker1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to taker1
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker1);
      assert.equal(events[2].returnValues.to, taker1);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
      // Transfer protocol fee
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, null);
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[3].returnValues.from, taker1);
      assert.equal(events[3].returnValues.to, defaultFeeReceiver);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker1
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[4].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(events[4].returnValues.from, taker1);
      assert.equal(events[4].returnValues.to, maker2);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
      // Transfer asset to taker1
      assert.equal(events[5].event, 'Transfer');
      assert.equal(events[5].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[5].returnValues.assetData, encodeTokenData(ERC721Token.address, 2));
      assert.equal(events[5].returnValues.assetValue, '1');
      assert.equal(events[5].returnValues.from, maker2);
      assert.equal(events[5].returnValues.to, taker1);
      assert.equal(events[5].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[5].returnValues.transferType, PAYOUT);
      // Transfer protocol fee
      assert.equal(events[6].event, 'Transfer');
      assert.equal(events[6].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[6].returnValues.assetData, null);
      assert.equal(events[6].returnValues.assetValue, expandToDecimalsString(1, 15)); // 0.001 WETH
      assert.equal(events[6].returnValues.from, taker1);
      assert.equal(events[6].returnValues.to, defaultFeeReceiver);
      assert.equal(events[6].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[6].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker1
      assert.equal(events[7].event, 'Transfer');
      assert.equal(events[7].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[7].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[7].returnValues.assetValue, expandToDecimalsString(99, 15)); // 0.099 WETH
      assert.equal(events[7].returnValues.from, taker1);
      assert.equal(events[7].returnValues.to, maker3);
      assert.equal(events[7].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[7].returnValues.transferType, PAYOUT);
      // Transfer asset to taker1
      assert.equal(events[8].event, 'Transfer');
      assert.equal(events[8].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[8].returnValues.assetData, encodeTokenData(ERC721Token.address, 3));
      assert.equal(events[8].returnValues.assetValue, '1');
      assert.equal(events[8].returnValues.from, maker3);
      assert.equal(events[8].returnValues.to, taker1);
      assert.equal(events[8].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[8].returnValues.transferType, PAYOUT);
    });

    it('match with signed orders from different takers (takers !== caller))', async () => {
      // Get WETH to takers
      await weth.deposit({ from: taker1, value: expandToDecimals(5, 17) }); // Deposit 0.5 ETH to get 0.5 WETH
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(5, 17));
      await weth.deposit({ from: taker2, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker2)).toString(), expandToDecimalsString(1, 18));
      await weth.deposit({ from: taker3, value: expandToDecimals(1, 17) }); // Deposit 0.1 ETH to get 0.1 WETH
      assert.equal((await weth.balanceOf(taker3)).toString(), expandToDecimalsString(1, 17));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(5, 17), { from: taker1 });
      assert.equal(
        (await weth.allowance(taker1, exchangeProxyAddress)).toString(),
        expandToDecimalsString(5, 17),
      );
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker2 });
      assert.equal(
        (await weth.allowance(taker2, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 17), { from: taker3 });
      assert.equal(
        (await weth.allowance(taker3, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 17),
      );
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial maker1 ETH balance
      maker1InitialETHBalance = toBN(await getBalance(maker1));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // takerOrder objects
      takerOrdersArray = [
        Order(
          taker1,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 17)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
          12, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
        Order(
          taker2,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 2), '1'), // leftTake
          6, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
        Order(
          taker3,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 17)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 3), '1'), // leftTake
          1, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
      ];
      // Calculate taker orders key hashes
      takerOrdersKeyHashesArray = [
        await libOrder.hashKey(takerOrdersArray[0]),
        await libOrder.hashKey(takerOrdersArray[1]),
        await libOrder.hashKey(takerOrdersArray[2]),
      ];
      // Generate taker orders EIP712 typed data signatures
      takerSignaturesArray = [
        await signOrderData(web3, taker1, takerOrdersArray[0], exchangeProxyAddress, CHAIN_ID),
        await signOrderData(web3, taker2, takerOrdersArray[1], exchangeProxyAddress, CHAIN_ID),
        await signOrderData(web3, taker3, takerOrdersArray[2], exchangeProxyAddress, CHAIN_ID),
      ];
      // takerSignatures must be converted to bytes buffers before submission
      takerOrdersBytesSigArray = [
        Buffer.from(takerSignaturesArray[0].slice(2), 'hex'),
        Buffer.from(takerSignaturesArray[1].slice(2), 'hex'),
        Buffer.from(takerSignaturesArray[2].slice(2), 'hex'),
      ];
      // Generate taker orders matchAllowances
      matchAllowancesLeftArray = [
        MatchAllowance(takerOrdersKeyHashesArray[0], matchLeftBeforeTimestamp),
        MatchAllowance(takerOrdersKeyHashesArray[1], matchLeftBeforeTimestamp),
        MatchAllowance(takerOrdersKeyHashesArray[2], matchLeftBeforeTimestamp),
      ];
      // Generate matchAllowance EIP712 typed data signatures
      matchAllowancesSignaturesLeftArray = [
        await signMatchAllowance(
          web3,
          orderBook,
          matchAllowancesLeftArray[0],
          exchangeProxyAddress,
          CHAIN_ID,
        ),
        await signMatchAllowance(
          web3,
          orderBook,
          matchAllowancesLeftArray[1],
          exchangeProxyAddress,
          CHAIN_ID,
        ),
        await signMatchAllowance(
          web3,
          orderBook,
          matchAllowancesLeftArray[2],
          exchangeProxyAddress,
          CHAIN_ID,
        ),
      ];
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeftArray = [
        Buffer.from(matchAllowancesSignaturesLeftArray[0].slice(2), 'hex'),
        Buffer.from(matchAllowancesSignaturesLeftArray[1].slice(2), 'hex'),
        Buffer.from(matchAllowancesSignaturesLeftArray[2].slice(2), 'hex'),
      ];
      //Format orders array
      ordersArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        ordersArray.push(takerOrdersArray[i]);
        ordersArray.push(makerOrdersArray[i]);
      }
      //Format signatures array
      signaturesArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        signaturesArray.push(takerOrdersBytesSigArray[i]);
        signaturesArray.push(makerOrdersBytesSigArray[i]);
      }
      //Format matchBeforeTimestamps array
      matchBeforeTimestampsArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        matchBeforeTimestampsArray.push(matchLeftBeforeTimestamp);
        matchBeforeTimestampsArray.push(matchRightBeforeTimestamp);
      }
      //Format signatures array
      orderBookSignaturesArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        orderBookSignaturesArray.push(matchAllowanceBytesSigLeftArray[i]);
        orderBookSignaturesArray.push(matchAllowanceBytesSigRightArray[i]);
      }
      // Match orders by batch
      tx = await exchangeProxy.batchMatchOrders(
        ordersArray,
        signaturesArray,
        matchBeforeTimestampsArray,
        orderBookSignaturesArray,
        { from: other },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(16, 15), // 0.016 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check makers and takers balances
      assert.equal((await ERC721Token.balanceOf(maker1)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(maker2)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(maker3)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker1)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker2)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker3)).toString(), '1');
      assert.equal(
        (await weth.balanceOf(maker1)).toString(),
        '0', // 0 WETH
      );
      assert.equal(
        toBN(await getBalance(maker1))
          .sub(maker1InitialETHBalance)
          .toString(),
        expandToDecimalsString(495, 15), // 0.495 ETH
      );
      assert.equal(
        (await weth.balanceOf(maker2)).toString(),
        expandToDecimalsString(99, 16), // 0.99 WETH
      );
      assert.equal(
        (await weth.balanceOf(maker3)).toString(),
        expandToDecimalsString(99, 15), // 0.099 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), '0');
      assert.equal((await weth.balanceOf(taker2)).toString(), '0');
      assert.equal((await weth.balanceOf(taker3)).toString(), '0');
      // Check that maker orders fills equal rightTake values
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrdersKeyHashesArray[0])).toString(),
        expandToDecimalsString(5, 17),
      );
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrdersKeyHashesArray[1])).toString(),
        expandToDecimalsString(1, 18),
      );
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrdersKeyHashesArray[2])).toString(),
        expandToDecimalsString(1, 17),
      );
      // Check emitted events
      // Match event
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 3);
      assert.equal(events[0].event, 'Match');
      assert.equal(events[0].returnValues.leftHash, takerOrdersKeyHashesArray[0]);
      assert.equal(events[0].returnValues.rightHash, makerOrdersKeyHashesArray[0]);
      assert.equal(events[0].returnValues.leftMaker, taker1);
      assert.equal(events[0].returnValues.rightMaker, maker1);
      assert.equal(events[0].returnValues.newLeftFill, '1');
      assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(5, 17));
      assert.equal(events[1].event, 'Match');
      assert.equal(events[1].returnValues.leftHash, takerOrdersKeyHashesArray[1]);
      assert.equal(events[1].returnValues.rightHash, makerOrdersKeyHashesArray[1]);
      assert.equal(events[1].returnValues.leftMaker, taker2);
      assert.equal(events[1].returnValues.rightMaker, maker2);
      assert.equal(events[1].returnValues.newLeftFill, '1');
      assert.equal(events[1].returnValues.newRightFill, expandToDecimalsString(1, 18));
      assert.equal(events[2].event, 'Match');
      assert.equal(events[2].returnValues.leftHash, takerOrdersKeyHashesArray[2]);
      assert.equal(events[2].returnValues.rightHash, makerOrdersKeyHashesArray[2]);
      assert.equal(events[2].returnValues.leftMaker, taker3);
      assert.equal(events[2].returnValues.rightMaker, maker3);
      assert.equal(events[2].returnValues.newLeftFill, '1');
      assert.equal(events[2].returnValues.newRightFill, expandToDecimalsString(1, 17));
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 9);
      // Transfer protocol fee
      assert.equal(events[0].event, 'Transfer');
      assert.equal(events[0].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, null);
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[0].returnValues.from, taker1);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker1
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(495, 15)); // 0.495 WETH
      assert.equal(events[1].returnValues.from, taker1);
      assert.equal(events[1].returnValues.to, maker1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to taker1
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker1);
      assert.equal(events[2].returnValues.to, taker1);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
      // Transfer protocol fee
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, null);
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[3].returnValues.from, taker2);
      assert.equal(events[3].returnValues.to, defaultFeeReceiver);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker1
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[4].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(events[4].returnValues.from, taker2);
      assert.equal(events[4].returnValues.to, maker2);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
      // Transfer asset to taker1
      assert.equal(events[5].event, 'Transfer');
      assert.equal(events[5].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[5].returnValues.assetData, encodeTokenData(ERC721Token.address, 2));
      assert.equal(events[5].returnValues.assetValue, '1');
      assert.equal(events[5].returnValues.from, maker2);
      assert.equal(events[5].returnValues.to, taker2);
      assert.equal(events[5].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[5].returnValues.transferType, PAYOUT);
      // Transfer protocol fee
      assert.equal(events[6].event, 'Transfer');
      assert.equal(events[6].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[6].returnValues.assetData, null);
      assert.equal(events[6].returnValues.assetValue, expandToDecimalsString(1, 15)); // 0.001 WETH
      assert.equal(events[6].returnValues.from, taker3);
      assert.equal(events[6].returnValues.to, defaultFeeReceiver);
      assert.equal(events[6].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[6].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker1
      assert.equal(events[7].event, 'Transfer');
      assert.equal(events[7].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[7].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[7].returnValues.assetValue, expandToDecimalsString(99, 15)); // 0.099 WETH
      assert.equal(events[7].returnValues.from, taker3);
      assert.equal(events[7].returnValues.to, maker3);
      assert.equal(events[7].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[7].returnValues.transferType, PAYOUT);
      // Transfer asset to taker1
      assert.equal(events[8].event, 'Transfer');
      assert.equal(events[8].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[8].returnValues.assetData, encodeTokenData(ERC721Token.address, 3));
      assert.equal(events[8].returnValues.assetValue, '1');
      assert.equal(events[8].returnValues.from, maker3);
      assert.equal(events[8].returnValues.to, taker3);
      assert.equal(events[8].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[8].returnValues.transferType, PAYOUT);
    });

    it('match with a mix of signed and unsigned orders from different takers (taker1 == caller))', async () => {
      // Get WETH to takers
      await weth.deposit({ from: taker1, value: expandToDecimals(5, 17) }); // Deposit 0.5 ETH to get 0.5 WETH
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(5, 17));
      await weth.deposit({ from: taker2, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker2)).toString(), expandToDecimalsString(1, 18));
      await weth.deposit({ from: taker3, value: expandToDecimals(1, 17) }); // Deposit 0.1 ETH to get 0.1 WETH
      assert.equal((await weth.balanceOf(taker3)).toString(), expandToDecimalsString(1, 17));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(5, 17), { from: taker1 });
      assert.equal(
        (await weth.allowance(taker1, exchangeProxyAddress)).toString(),
        expandToDecimalsString(5, 17),
      );
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker2 });
      assert.equal(
        (await weth.allowance(taker2, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 17), { from: taker3 });
      assert.equal(
        (await weth.allowance(taker3, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 17),
      );
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial maker1 ETH balance
      maker1InitialETHBalance = toBN(await getBalance(maker1));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // takerOrder objects
      takerOrdersArray = [
        Order(
          taker1,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 17)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
          0, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
        Order(
          taker2,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 2), '1'), // leftTake
          6, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
        Order(
          taker3,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 17)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 3), '1'), // leftTake
          1, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
      ];
      // Calculate taker orders key hashes
      takerOrdersKeyHashesArray = [
        await libOrder.hashKey(takerOrdersArray[0]),
        await libOrder.hashKey(takerOrdersArray[1]),
        await libOrder.hashKey(takerOrdersArray[2]),
      ];
      // Generate taker orders EIP712 typed data signatures
      takerSignaturesArray = [
        '0x',
        await signOrderData(web3, taker2, takerOrdersArray[1], exchangeProxyAddress, CHAIN_ID),
        await signOrderData(web3, taker3, takerOrdersArray[2], exchangeProxyAddress, CHAIN_ID),
      ];
      // takerSignatures must be converted to bytes buffers before submission
      takerOrdersBytesSigArray = [
        '0x',
        Buffer.from(takerSignaturesArray[1].slice(2), 'hex'),
        Buffer.from(takerSignaturesArray[2].slice(2), 'hex'),
      ];
      // Generate taker orders matchAllowances
      matchAllowancesLeftArray = [
        null,
        MatchAllowance(takerOrdersKeyHashesArray[1], matchLeftBeforeTimestamp),
        MatchAllowance(takerOrdersKeyHashesArray[2], matchLeftBeforeTimestamp),
      ];
      // Generate matchAllowance EIP712 typed data signatures
      matchAllowancesSignaturesLeftArray = [
        '0x',
        await signMatchAllowance(
          web3,
          orderBook,
          matchAllowancesLeftArray[1],
          exchangeProxyAddress,
          CHAIN_ID,
        ),
        await signMatchAllowance(
          web3,
          orderBook,
          matchAllowancesLeftArray[2],
          exchangeProxyAddress,
          CHAIN_ID,
        ),
      ];
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeftArray = [
        '0x',
        Buffer.from(matchAllowancesSignaturesLeftArray[1].slice(2), 'hex'),
        Buffer.from(matchAllowancesSignaturesLeftArray[2].slice(2), 'hex'),
      ];
      //Format orders array
      ordersArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        ordersArray.push(takerOrdersArray[i]);
        ordersArray.push(makerOrdersArray[i]);
      }
      //Format signatures array
      signaturesArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        signaturesArray.push(takerOrdersBytesSigArray[i]);
        signaturesArray.push(makerOrdersBytesSigArray[i]);
      }
      //Format matchBeforeTimestamps array
      matchBeforeTimestampsArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        matchBeforeTimestampsArray.push(matchLeftBeforeTimestamp);
        matchBeforeTimestampsArray.push(matchRightBeforeTimestamp);
      }
      //Format signatures array
      orderBookSignaturesArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        orderBookSignaturesArray.push(matchAllowanceBytesSigLeftArray[i]);
        orderBookSignaturesArray.push(matchAllowanceBytesSigRightArray[i]);
      }
      // Match orders by batch
      tx = await exchangeProxy.batchMatchOrders(
        ordersArray,
        signaturesArray,
        matchBeforeTimestampsArray,
        orderBookSignaturesArray,
        { from: taker1 },
      );
      // Check that protocol fee was paid in ETH
      assert.equal(
        toBN(await getBalance(defaultFeeReceiver))
          .sub(defaultFeeReceiverInitialETHBalance)
          .toString(),
        expandToDecimalsString(16, 15), // 0.016 ETH
      );
      assert.equal(
        (await weth.balanceOf(defaultFeeReceiver)).toString(),
        '0', // 0 WETH
      );
      // Check makers and takers balances
      assert.equal((await ERC721Token.balanceOf(maker1)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(maker2)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(maker3)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker1)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker2)).toString(), '1');
      assert.equal((await ERC721Token.balanceOf(taker3)).toString(), '1');
      assert.equal(
        (await weth.balanceOf(maker1)).toString(),
        '0', // 0 WETH
      );
      assert.equal(
        toBN(await getBalance(maker1))
          .sub(maker1InitialETHBalance)
          .toString(),
        expandToDecimalsString(495, 15), // 0.495 ETH
      );
      assert.equal(
        (await weth.balanceOf(maker2)).toString(),
        expandToDecimalsString(99, 16), // 0.99 WETH
      );
      assert.equal(
        (await weth.balanceOf(maker3)).toString(),
        expandToDecimalsString(99, 15), // 0.099 WETH
      );
      assert.equal((await weth.balanceOf(taker1)).toString(), '0');
      assert.equal((await weth.balanceOf(taker2)).toString(), '0');
      assert.equal((await weth.balanceOf(taker3)).toString(), '0');
      // Check that maker orders fills equal rightTake values
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrdersKeyHashesArray[0])).toString(),
        expandToDecimalsString(5, 17),
      );
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrdersKeyHashesArray[1])).toString(),
        expandToDecimalsString(1, 18),
      );
      assert.equal(
        (await exchangeProxy.getOrderFill(makerOrdersKeyHashesArray[2])).toString(),
        expandToDecimalsString(1, 17),
      );
      // Check emitted events
      // Match event
      events = await exchangeProxy.getPastEvents('Match', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 3);
      assert.equal(events[0].event, 'Match');
      assert.equal(events[0].returnValues.leftHash, takerOrdersKeyHashesArray[0]);
      assert.equal(events[0].returnValues.rightHash, makerOrdersKeyHashesArray[0]);
      assert.equal(events[0].returnValues.leftMaker, taker1);
      assert.equal(events[0].returnValues.rightMaker, maker1);
      assert.equal(events[0].returnValues.newLeftFill, '1');
      assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(5, 17));
      assert.equal(events[1].event, 'Match');
      assert.equal(events[1].returnValues.leftHash, takerOrdersKeyHashesArray[1]);
      assert.equal(events[1].returnValues.rightHash, makerOrdersKeyHashesArray[1]);
      assert.equal(events[1].returnValues.leftMaker, taker2);
      assert.equal(events[1].returnValues.rightMaker, maker2);
      assert.equal(events[1].returnValues.newLeftFill, '1');
      assert.equal(events[1].returnValues.newRightFill, expandToDecimalsString(1, 18));
      assert.equal(events[2].event, 'Match');
      assert.equal(events[2].returnValues.leftHash, takerOrdersKeyHashesArray[2]);
      assert.equal(events[2].returnValues.rightHash, makerOrdersKeyHashesArray[2]);
      assert.equal(events[2].returnValues.leftMaker, taker3);
      assert.equal(events[2].returnValues.rightMaker, maker3);
      assert.equal(events[2].returnValues.newLeftFill, '1');
      assert.equal(events[2].returnValues.newRightFill, expandToDecimalsString(1, 17));
      // Transfer events
      events = await exchangeProxy.getPastEvents('Transfer', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 9);
      // Transfer protocol fee
      assert.equal(events[0].event, 'Transfer');
      assert.equal(events[0].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, null);
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 WETH
      assert.equal(events[0].returnValues.from, taker1);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker1
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(495, 15)); // 0.495 WETH
      assert.equal(events[1].returnValues.from, taker1);
      assert.equal(events[1].returnValues.to, maker1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, PAYOUT);
      // Transfer asset to taker1
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker1);
      assert.equal(events[2].returnValues.to, taker1);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
      // Transfer protocol fee
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, null);
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[3].returnValues.from, taker2);
      assert.equal(events[3].returnValues.to, defaultFeeReceiver);
      assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[3].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker1
      assert.equal(events[4].event, 'Transfer');
      assert.equal(events[4].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[4].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 WETH
      assert.equal(events[4].returnValues.from, taker2);
      assert.equal(events[4].returnValues.to, maker2);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
      // Transfer asset to taker1
      assert.equal(events[5].event, 'Transfer');
      assert.equal(events[5].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[5].returnValues.assetData, encodeTokenData(ERC721Token.address, 2));
      assert.equal(events[5].returnValues.assetValue, '1');
      assert.equal(events[5].returnValues.from, maker2);
      assert.equal(events[5].returnValues.to, taker2);
      assert.equal(events[5].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[5].returnValues.transferType, PAYOUT);
      // Transfer protocol fee
      assert.equal(events[6].event, 'Transfer');
      assert.equal(events[6].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[6].returnValues.assetData, null);
      assert.equal(events[6].returnValues.assetValue, expandToDecimalsString(1, 15)); // 0.001 WETH
      assert.equal(events[6].returnValues.from, taker3);
      assert.equal(events[6].returnValues.to, defaultFeeReceiver);
      assert.equal(events[6].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[6].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker1
      assert.equal(events[7].event, 'Transfer');
      assert.equal(events[7].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[7].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[7].returnValues.assetValue, expandToDecimalsString(99, 15)); // 0.099 WETH
      assert.equal(events[7].returnValues.from, taker3);
      assert.equal(events[7].returnValues.to, maker3);
      assert.equal(events[7].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[7].returnValues.transferType, PAYOUT);
      // Transfer asset to taker1
      assert.equal(events[8].event, 'Transfer');
      assert.equal(events[8].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[8].returnValues.assetData, encodeTokenData(ERC721Token.address, 3));
      assert.equal(events[8].returnValues.assetValue, '1');
      assert.equal(events[8].returnValues.from, maker3);
      assert.equal(events[8].returnValues.to, taker3);
      assert.equal(events[8].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[8].returnValues.transferType, PAYOUT);
    });

    it('invalid orders array length (reverts)', async () => {
      // Get WETH to takers
      await weth.deposit({ from: taker1, value: expandToDecimals(5, 17) }); // Deposit 0.5 ETH to get 0.5 WETH
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(5, 17));
      await weth.deposit({ from: taker2, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker2)).toString(), expandToDecimalsString(1, 18));
      await weth.deposit({ from: taker3, value: expandToDecimals(1, 17) }); // Deposit 0.1 ETH to get 0.1 WETH
      assert.equal((await weth.balanceOf(taker3)).toString(), expandToDecimalsString(1, 17));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(5, 17), { from: taker1 });
      assert.equal(
        (await weth.allowance(taker1, exchangeProxyAddress)).toString(),
        expandToDecimalsString(5, 17),
      );
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker2 });
      assert.equal(
        (await weth.allowance(taker2, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 17), { from: taker3 });
      assert.equal(
        (await weth.allowance(taker3, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 17),
      );
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial maker1 ETH balance
      maker1InitialETHBalance = toBN(await getBalance(maker1));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // takerOrder objects
      takerOrdersArray = [
        Order(
          taker1,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 17)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
          0, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
        Order(
          taker2,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 2), '1'), // leftTake
          6, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
      ];
      // Calculate taker orders key hashes
      takerOrdersKeyHashesArray = [
        await libOrder.hashKey(takerOrdersArray[0]),
        await libOrder.hashKey(takerOrdersArray[1]),
      ];
      // Generate taker orders EIP712 typed data signatures
      takerSignaturesArray = [
        '0x',
        await signOrderData(web3, taker2, takerOrdersArray[1], exchangeProxyAddress, CHAIN_ID),
      ];
      // takerSignatures must be converted to bytes buffers before submission
      takerOrdersBytesSigArray = ['0x', Buffer.from(takerSignaturesArray[1].slice(2), 'hex')];
      // Generate taker orders matchAllowances
      matchAllowancesLeftArray = [
        null,
        MatchAllowance(takerOrdersKeyHashesArray[1], matchLeftBeforeTimestamp),
      ];
      // Generate matchAllowance EIP712 typed data signatures
      matchAllowancesSignaturesLeftArray = [
        '0x',
        await signMatchAllowance(
          web3,
          orderBook,
          matchAllowancesLeftArray[1],
          exchangeProxyAddress,
          CHAIN_ID,
        ),
      ];
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeftArray = [
        '0x',
        Buffer.from(matchAllowancesSignaturesLeftArray[1].slice(2), 'hex'),
      ];
      //Format orders array
      ordersArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        ordersArray.push(takerOrdersArray[i]);
        ordersArray.push(makerOrdersArray[i]);
      }
      // Push last element from makerOrdersArray
      ordersArray.push(makerOrdersArray[makerOrdersArray.length - 1]);
      //Format signatures array
      signaturesArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        signaturesArray.push(takerOrdersBytesSigArray[i]);
        signaturesArray.push(makerOrdersBytesSigArray[i]);
      }
      // Push last element from makerOrdersBytesSigArray
      signaturesArray.push(makerOrdersBytesSigArray[makerOrdersBytesSigArray.length - 1]);
      //Format matchBeforeTimestamps array
      matchBeforeTimestampsArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        matchBeforeTimestampsArray.push(matchLeftBeforeTimestamp);
        matchBeforeTimestampsArray.push(matchRightBeforeTimestamp);
      }
      // Push last element
      matchBeforeTimestampsArray.push(matchRightBeforeTimestamp);
      //Format signatures array
      orderBookSignaturesArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        orderBookSignaturesArray.push(matchAllowanceBytesSigLeftArray[i]);
        orderBookSignaturesArray.push(matchAllowanceBytesSigRightArray[i]);
      }
      // Push last element from matchAllowanceBytesSigRightArray
      orderBookSignaturesArray.push(
        matchAllowanceBytesSigRightArray[matchAllowanceBytesSigRightArray.length - 1],
      );
      // Match orders by batch
      await truffleAssert.reverts(
        exchangeProxy.batchMatchOrders(
          ordersArray,
          signaturesArray,
          matchBeforeTimestampsArray,
          orderBookSignaturesArray,
          { from: taker1 },
        ),
        'Exchange: invalid orders array length',
      );
    });

    it('arrays length mismatch (reverts)', async () => {
      // Get WETH to takers
      await weth.deposit({ from: taker1, value: expandToDecimals(5, 17) }); // Deposit 0.5 ETH to get 0.5 WETH
      assert.equal((await weth.balanceOf(taker1)).toString(), expandToDecimalsString(5, 17));
      await weth.deposit({ from: taker2, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker2)).toString(), expandToDecimalsString(1, 18));
      await weth.deposit({ from: taker3, value: expandToDecimals(1, 17) }); // Deposit 0.1 ETH to get 0.1 WETH
      assert.equal((await weth.balanceOf(taker3)).toString(), expandToDecimalsString(1, 17));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(5, 17), { from: taker1 });
      assert.equal(
        (await weth.allowance(taker1, exchangeProxyAddress)).toString(),
        expandToDecimalsString(5, 17),
      );
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker2 });
      assert.equal(
        (await weth.allowance(taker2, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 17), { from: taker3 });
      assert.equal(
        (await weth.allowance(taker3, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 17),
      );
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
      // Get initial maker1 ETH balance
      maker1InitialETHBalance = toBN(await getBalance(maker1));
      // Get latest timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      matchLeftBeforeTimestamp = latestTimestamp + 100000;
      // takerOrder objects
      takerOrdersArray = [
        Order(
          taker1,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 17)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
          0, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
        Order(
          taker2,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 2), '1'), // leftTake
          6, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
        Order(
          taker3,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 17)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 3), '1'), // leftTake
          1, // salt cannot be 0 for taker orders submitted by another account
          latestTimestamp, // start
          matchLeftBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        ),
      ];
      // Calculate taker orders key hashes
      takerOrdersKeyHashesArray = [
        await libOrder.hashKey(takerOrdersArray[0]),
        await libOrder.hashKey(takerOrdersArray[1]),
        await libOrder.hashKey(takerOrdersArray[2]),
      ];
      // Generate taker orders EIP712 typed data signatures
      takerSignaturesArray = [
        '0x',
        await signOrderData(web3, taker2, takerOrdersArray[1], exchangeProxyAddress, CHAIN_ID),
        await signOrderData(web3, taker3, takerOrdersArray[2], exchangeProxyAddress, CHAIN_ID),
      ];
      // takerSignatures must be converted to bytes buffers before submission
      takerOrdersBytesSigArray = [
        '0x',
        Buffer.from(takerSignaturesArray[1].slice(2), 'hex'),
        Buffer.from(takerSignaturesArray[2].slice(2), 'hex'),
      ];
      // Generate taker orders matchAllowances
      matchAllowancesLeftArray = [
        null,
        MatchAllowance(takerOrdersKeyHashesArray[1], matchLeftBeforeTimestamp),
        MatchAllowance(takerOrdersKeyHashesArray[2], matchLeftBeforeTimestamp),
      ];
      // Generate matchAllowance EIP712 typed data signatures
      matchAllowancesSignaturesLeftArray = [
        '0x',
        await signMatchAllowance(
          web3,
          orderBook,
          matchAllowancesLeftArray[1],
          exchangeProxyAddress,
          CHAIN_ID,
        ),
        await signMatchAllowance(
          web3,
          orderBook,
          matchAllowancesLeftArray[2],
          exchangeProxyAddress,
          CHAIN_ID,
        ),
      ];
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSigLeftArray = [
        '0x',
        Buffer.from(matchAllowancesSignaturesLeftArray[1].slice(2), 'hex'),
        Buffer.from(matchAllowancesSignaturesLeftArray[2].slice(2), 'hex'),
      ];
      //Format orders array
      ordersArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        ordersArray.push(takerOrdersArray[i]);
        ordersArray.push(makerOrdersArray[i]);
      }
      //Format signatures array
      signaturesArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        signaturesArray.push(takerOrdersBytesSigArray[i]);
        signaturesArray.push(makerOrdersBytesSigArray[i]);
      }
      //Format matchBeforeTimestamps array
      matchBeforeTimestampsArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        matchBeforeTimestampsArray.push(matchLeftBeforeTimestamp);
        matchBeforeTimestampsArray.push(matchRightBeforeTimestamp);
      }
      //Format signatures array
      orderBookSignaturesArray = [];
      for (let i = 0; i < takerOrdersArray.length; i++) {
        orderBookSignaturesArray.push(matchAllowanceBytesSigLeftArray[i]);
        orderBookSignaturesArray.push(matchAllowanceBytesSigRightArray[i]);
      }
      // Push extra element to orderBookSignaturesArray to trigger arrays length mismatch error
      orderBookSignaturesArray.push('0x');
      // Match orders by batch
      await truffleAssert.reverts(
        exchangeProxy.batchMatchOrders(
          ordersArray,
          signaturesArray,
          matchBeforeTimestampsArray,
          orderBookSignaturesArray,
          { from: taker1 },
        ),
        'Exchange: arrays length mismatch',
      );
    });
  });
});
