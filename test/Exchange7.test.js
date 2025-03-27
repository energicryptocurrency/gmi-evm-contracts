const { getBalance, getBlock } = web3.eth;
const { toBN } = web3.utils;

const { Order, MatchAllowance, Asset, encodeTokenData } = require('./utils/order');
const { signOrderData, signMatchAllowance } = require('./utils/EIP712Signer');
const {
  ETH,
  WETH,
  ERC20,
  ERC721,
  TO_MAKER,
  TO_TAKER,
  PROTOCOL,
  ROYALTY,
  PAYOUT,
  INTERFACE_ID_ERC2981,
} = require('./utils/hashKeys');

const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';
const PROTOCOL_FEE = toBN(100); // 1% protocol fee in bps (1 bps = 0.01%)
const CHAIN_ID = toBN(1);
const ZERO_FILLER_STRING = '00000000000000000000000000000000000000000000000000000000'; // 56 zeros

let defaultFeeReceiverInitialETHBalance,
  ERC721Token,
  events,
  exchange,
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
  otherERC20Token,
  royalties,
  royaltiesRegistryBehindProxy,
  royaltiesRegistryProxy,
  royaltiesRegistryProxyAddress,
  royaltiesReturned,
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

contract('Exchange - Functional Tests Part 7', accounts => {
  const ExchangeHelper = artifacts.require('ExchangeHelper');
  const ExchangeHelperProxy = artifacts.require('TestERC1967Proxy');
  const Exchange = artifacts.require('Exchange');
  const ExchangeProxy = artifacts.require('TestERC1967Proxy');
  const RoyaltiesRegistry = artifacts.require('RoyaltiesRegistry');
  const RoyaltiesRegistryProxy = artifacts.require('TestERC1967Proxy');
  const LibOrderTest = artifacts.require('LibOrderTest');
  const WETH9 = artifacts.require('WETH9');
  const TestERC20 = artifacts.require('TestERC20');
  const TestERC721 = artifacts.require('TestERC721ERC2981');
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

    const storage = await ExchangeStorage.at(await exchangeProxy._storage());

    await storage.setERC20AssetAllowed(otherERC20Token.address, true, { from: owner });
  });

  // The following ERC2981 royalties tests are done using the TestERC721-ERC2981 contracts.
  // Other ERC2981 royalties tests use the TestERC1155-ERC2981 contract and test ERC2981 royalties
  // distribution in the specific case of partially filled orders (only possible with ERC1155).
  describe('ERC2981 royalties: make ERC721-ERC2981, take WETH', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1'); // Get latest block number
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
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver)); // Get latest block number
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

    it('taker == caller, royalties from registry, no origin fees', async () => {
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
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver)); // Get latest block number
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
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
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
      assert.equal(events[4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, taker);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, ERC2981 royalties, no origin fees', async () => {
      // Register ERC2981 royalties into token contract (caller is token owner)

      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
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
      await ERC721Token.setRoyalty(1, royaltiesRecipient_1, 100, { from: owner }); // 1% royalty
      // Check that royalties have been registered
      royalties = await ERC721Token.royaltyInfo(1, 100);
      assert.equal(royalties._receiver, royaltiesRecipient_1);
      assert.equal(royalties._royaltyAmount.toString(), '1');
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
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver)); // Get latest block number
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
      // Check that royalties were paid
      assert.equal(
        (await weth.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(1, 16),
      ); // 0.01 WETH
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(98, 16)); // 0.98 WETH
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
      // Transfer royalties
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer asset to maker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(98, 16)); // 0.98 WETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
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
  });

  describe('ERC2981 royalties: make WETH, take ERC721-ERC2981', () => {
    beforeEach(async () => {
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
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver)); // Get latest block number
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
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), 1);
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
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, royalties from registry, no origin fees', async () => {
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
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver)); // Get latest block number
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
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), 1);
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
      assert.equal(events[4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, taker);
      assert.equal(events[4].returnValues.to, maker);
      assert.equal(events[4].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, ERC2981 royalties, no origin fees', async () => {
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
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
      // Register ERC2981 royalties into token contract (caller is token owner)
      await ERC721Token.setRoyalty(1, royaltiesRecipient_1, 100, { from: owner }); // 1% royalty
      // Check that royalties have been registered
      royalties = await ERC721Token.royaltyInfo(1, 100);
      assert.equal(royalties._receiver, royaltiesRecipient_1);
      assert.equal(royalties._royaltyAmount.toString(), '1');
      // Get WETH to maker
      await weth.deposit({ from: maker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(1, 18));
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Get initial defaultFeeReceiver ETH balance
      defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver)); // Get latest block number
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
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), 1);
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(98, 16)); // 0.98 WETH
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
      // Transfer royalties
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer asset to taker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(98, 16)); // 0.98 WETH
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
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

  describe('ERC2981 royalties: make ERC721-ERC2981, take ETH', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1'); // Get latest block number
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
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
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
      assert.equal(events[2].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[2].returnValues.assetValue, '1');
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, royalties from registry, no origin fees', async () => {
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
      // Update owner initial balance after sending transaction above
      initialETHBalances.owner = toBN(await getBalance(owner)); // Get latest block number
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
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(975, 15), // 0.975 ETH
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
      assert.equal(events[4].returnValues.assetClass, ERC721 + ZERO_FILLER_STRING);
      assert.equal(events[4].returnValues.assetData, encodeTokenData(ERC721Token.address, 1));
      assert.equal(events[4].returnValues.assetValue, '1');
      assert.equal(events[4].returnValues.from, maker);
      assert.equal(events[4].returnValues.to, taker);
      assert.equal(events[4].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[4].returnValues.transferType, PAYOUT);
    });

    it('taker == caller, ERC2981 royalties, no origin fees', async () => {
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
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
      // Register ERC2981 royalties into token contract (caller is token owner)
      await ERC721Token.setRoyalty(1, royaltiesRecipient_1, 100, { from: owner }); // 1% royalty
      // Check that royalties have been registered
      royalties = await ERC721Token.royaltyInfo(1, 100);
      assert.equal(royalties._receiver, royaltiesRecipient_1);
      assert.equal(royalties._royaltyAmount.toString(), '1');
      // Update owner initial balance after sending transaction above
      initialETHBalances.owner = toBN(await getBalance(owner)); // Get latest block number
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
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      assert.equal(
        toBN(await getBalance(maker))
          .sub(initialETHBalances.maker)
          .toString(),
        expandToDecimalsString(98, 16), // 0.98 ETH
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
      // Transfer royalties
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, null);
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 ETH
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer asset to maker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ETH + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, null);
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(98, 16)); // 0.98 ETH
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
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
  });

  describe('ERC2981 royalties: make ERC721-ERC2981, take ERC20', () => {
    beforeEach(async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1'); // Get latest block number
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

    it('taker == caller, no origin fees, no royalties', async () => {
      // Mint ERC20 token to taker
      await otherERC20Token.mint(taker, expandToDecimals(1, 18), { from: owner }); // Mint 1 token to taker
      assert.equal(
        (await otherERC20Token.balanceOf(taker)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
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
      // Check that protocol fee was paid in ERC20
      assert.equal(
        (await otherERC20Token.balanceOf(defaultFeeReceiver)).toString(),
        expandToDecimalsString(1, 16), // 0.01 token
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      assert.equal(
        (await otherERC20Token.balanceOf(maker)).toString(),
        expandToDecimalsString(99, 16), // 0.99 token
      );
      assert.equal((await otherERC20Token.balanceOf(taker)).toString(), '0');
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
      assert.equal(events[0].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 token
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to maker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 token
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

    it('taker == caller, royalties from registry, no origin fees', async () => {
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
      // Mint ERC20 token to taker
      await otherERC20Token.mint(taker, expandToDecimals(1, 18), { from: owner }); // Mint 1 token to taker
      assert.equal(
        (await otherERC20Token.balanceOf(taker)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await otherERC20Token.approve(exchangeProxyAddress, expandToDecimals(1, 18), {
        from: taker,
      });
      assert.equal(
        (await otherERC20Token.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      ); // Get latest block number
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
      // Check that protocol fee was paid in ERC20
      assert.equal(
        (await otherERC20Token.balanceOf(defaultFeeReceiver)).toString(),
        expandToDecimalsString(1, 16), // 0.01 token
      );
      // Check that royalties were paid
      assert.equal(
        (await otherERC20Token.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(1, 16),
      ); // 0.01 token
      assert.equal(
        (await otherERC20Token.balanceOf(royaltiesRecipient_2)).toString(),
        expandToDecimalsString(5, 15),
      ); // 0.005 token
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      assert.equal(
        (await otherERC20Token.balanceOf(maker)).toString(),
        expandToDecimalsString(975, 15),
      ); // 0.975 token
      assert.equal((await otherERC20Token.balanceOf(taker)).toString(), '0');
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
      assert.equal(events[0].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 token
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer royalties (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 token
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer royalties (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 token
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, royaltiesRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[2].returnValues.transferType, ROYALTY);
      // Transfer asset to maker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 token
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

    it('taker == caller, ERC2981 royalties, no origin fees', async () => {
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
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
      // Register ERC2981 royalties into token contract (caller is token owner)
      await ERC721Token.setRoyalty(1, royaltiesRecipient_1, 100, { from: owner }); // 1% royalty
      // Check that royalties have been registered
      royalties = await ERC721Token.royaltyInfo(1, 100);
      assert.equal(royalties._receiver, royaltiesRecipient_1);
      assert.equal(royalties._royaltyAmount.toString(), '1');
      // Mint ERC20 token to taker
      await otherERC20Token.mint(taker, expandToDecimals(1, 18), { from: owner }); // Mint 1 token to taker
      assert.equal(
        (await otherERC20Token.balanceOf(taker)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await otherERC20Token.approve(exchangeProxyAddress, expandToDecimals(1, 18), {
        from: taker,
      });
      assert.equal(
        (await otherERC20Token.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      ); // Get latest block number
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
      // Check that protocol fee was paid in ERC20
      assert.equal(
        (await otherERC20Token.balanceOf(defaultFeeReceiver)).toString(),
        expandToDecimalsString(1, 16), // 0.01 token
      );
      // Check that royalties were paid
      assert.equal(
        (await otherERC20Token.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(1, 16),
      ); // 0.01 token
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      assert.equal(
        (await otherERC20Token.balanceOf(maker)).toString(),
        expandToDecimalsString(98, 16),
      ); // 0.98 token
      assert.equal((await otherERC20Token.balanceOf(taker)).toString(), '0');
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
      assert.equal(events[0].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 token
      assert.equal(events[0].returnValues.from, taker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer royalties
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 token
      assert.equal(events[1].returnValues.from, taker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer asset to maker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(98, 16)); // 0.98 token
      assert.equal(events[2].returnValues.from, taker);
      assert.equal(events[2].returnValues.to, maker);
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
  });

  describe('ERC2981 royalties: make ERC20, take ERC721-ERC2981', () => {
    beforeEach(async () => {
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
      // Approve exchange proxy for transferring makeAsset (transfer to order taker + fees)
      // Amount approved is 1.015 token to covers all test cases below
      await otherERC20Token.approve(exchangeProxyAddress, expandToDecimals(1015, 15), {
        from: maker,
      });
      assert.equal(
        (await otherERC20Token.allowance(maker, exchangeProxyAddress)).toString(),
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
      // Mint ERC20 token to maker
      await otherERC20Token.mint(maker, expandToDecimals(1, 18), { from: owner }); // Mint 1 token to maker
      assert.equal(
        (await otherERC20Token.balanceOf(maker)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress); // Get latest block number
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
      // Check that protocol fee was paid in ERC20
      assert.equal(
        (await otherERC20Token.balanceOf(defaultFeeReceiver)).toString(),
        expandToDecimalsString(1, 16), // 0.01 token
      );
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), 1);
      assert.equal(
        (await otherERC20Token.balanceOf(taker)).toString(),
        expandToDecimalsString(99, 16),
      ); // 0.99 token
      assert.equal((await otherERC20Token.balanceOf(maker)).toString(), '0');
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
      assert.equal(events[0].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 token
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer asset to taker
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(99, 16)); // 0.99 token
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

    it('taker == caller, royalties from registry, no origin fees', async () => {
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
      // Check that royalties have been registered
      royaltiesReturned = await royaltiesRegistryProxy.getRoyalties(ERC721Token.address, 1);
      assert.equal(royaltiesReturned[0].account, royaltiesRecipient_1);
      assert.equal(royaltiesReturned[0].value, '100');
      assert.equal(royaltiesReturned[1].account, royaltiesRecipient_2);
      assert.equal(royaltiesReturned[1].value, '50');
      // Mint ERC20 token to maker
      await otherERC20Token.mint(maker, expandToDecimals(1, 18), { from: owner }); // Mint 1 token to maker
      assert.equal(
        (await otherERC20Token.balanceOf(maker)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress); // Get latest block number
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
      // Check that protocol fee was paid in ERC20
      assert.equal(
        (await otherERC20Token.balanceOf(defaultFeeReceiver)).toString(),
        expandToDecimalsString(1, 16), // 0.01 token
      );
      // Check that royalties were paid
      assert.equal(
        (await otherERC20Token.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(1, 16),
      ); // 0.01 token
      assert.equal(
        (await otherERC20Token.balanceOf(royaltiesRecipient_2)).toString(),
        expandToDecimalsString(5, 15),
      ); // 0.005 token
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), 1);
      assert.equal(
        (await otherERC20Token.balanceOf(taker)).toString(),
        expandToDecimalsString(975, 15),
      ); // 0.99 token
      assert.equal((await otherERC20Token.balanceOf(maker)).toString(), '0');
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
      assert.equal(events[0].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 token
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer royalties (1/2)
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 token
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer royalties (2/2)
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(5, 15)); // 0.005 token
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, royaltiesRecipient_2);
      assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[2].returnValues.transferType, ROYALTY);
      // Transfer asset to taker
      assert.equal(events[3].event, 'Transfer');
      assert.equal(events[3].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[3].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[3].returnValues.assetValue, expandToDecimalsString(975, 15)); // 0.975 token
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

    it('taker == caller, ERC2981 royalties, no origin fees', async () => {
      royalties = [
        { account: royaltiesRecipient_1, value: 100 }, // 1% royalty
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
      // Register ERC2981 royalties into token contract (caller is token owner)
      await ERC721Token.setRoyalty(1, royaltiesRecipient_1, 100, { from: owner }); // 1% royalty
      // Check that royalties have been registered
      royalties = await ERC721Token.royaltyInfo(1, 100);
      assert.equal(royalties._receiver, royaltiesRecipient_1);
      assert.equal(royalties._royaltyAmount.toString(), '1');
      // Mint ERC20 token to maker
      await otherERC20Token.mint(maker, expandToDecimals(1, 18), { from: owner }); // Mint 1 token to maker
      assert.equal(
        (await otherERC20Token.balanceOf(maker)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Mint ERC721 token to taker
      await ERC721Token.mint(taker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '1');
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: taker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress); // Get latest block number
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
      // Check that protocol fee was paid in ERC20
      assert.equal(
        (await otherERC20Token.balanceOf(defaultFeeReceiver)).toString(),
        expandToDecimalsString(1, 16), // 0.01 token
      );
      // Check that royalties were paid
      assert.equal(
        (await otherERC20Token.balanceOf(royaltiesRecipient_1)).toString(),
        expandToDecimalsString(1, 16),
      ); // 0.01 token
      // Check maker and taker balances
      assert.equal((await ERC721Token.balanceOf(taker)).toString(), '0');
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), 1);
      assert.equal(
        (await otherERC20Token.balanceOf(taker)).toString(),
        expandToDecimalsString(98, 16),
      ); // 0.98 token
      assert.equal((await otherERC20Token.balanceOf(maker)).toString(), '0');
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
      assert.equal(events[0].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[0].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 token
      assert.equal(events[0].returnValues.from, maker);
      assert.equal(events[0].returnValues.to, defaultFeeReceiver);
      assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[0].returnValues.transferType, PROTOCOL);
      // Transfer royalties
      assert.equal(events[1].event, 'Transfer');
      assert.equal(events[1].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[1].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 token
      assert.equal(events[1].returnValues.from, maker);
      assert.equal(events[1].returnValues.to, royaltiesRecipient_1);
      assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
      assert.equal(events[1].returnValues.transferType, ROYALTY);
      // Transfer asset to taker
      assert.equal(events[2].event, 'Transfer');
      assert.equal(events[2].returnValues.assetClass, ERC20 + ZERO_FILLER_STRING);
      assert.equal(events[2].returnValues.assetData, encodeTokenData(otherERC20Token.address));
      assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(98, 16)); // 0.98 token
      assert.equal(events[2].returnValues.from, maker);
      assert.equal(events[2].returnValues.to, taker);
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
});
