const { getBalance, getBlock } = web3.eth;
const { toBN } = web3.utils;
const truffleAssert = require('truffle-assertions');

const { Order, MatchAllowance, Asset, encodeTokenData } = require('./utils/order');
const { signOrderData, signMatchAllowance } = require('./utils/EIP712Signer');
const {
  ETH,
  WETH,
  ERC1155,
  TO_MAKER,
  TO_TAKER,
  PROTOCOL,
  ROYALTY,
  PAYOUT,
} = require('./utils/hashKeys');

const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';
const PROTOCOL_FEE = toBN(100); // 1% protocol fee in bps (1 bps = 0.01%)
const CHAIN_ID = toBN(1);
const ZERO_FILLER_STRING = '00000000000000000000000000000000000000000000000000000000'; // 56 zeros

let defaultFeeReceiverInitialETHBalance,
  ERC1155Token,
  events,
  exchangeBehindProxy,
  exchangeHelperProxy,
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
  royalties,
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

contract(
  'Exchange - Functional Tests Part 11',
  ([
    deployer,
    owner,
    other,
    maker,
    taker,
    ownerToken,
    ownerWhitelist,
    defaultFeeReceiver,
    royaltiesRecipient,
    orderBook,
  ]) => {
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

    beforeEach(async () => {
      // Deploy LibOrderTest
      libOrder = await LibOrderTest.new();

      // Deploy tokens
      weth = await WETH9.new();
      otherERC20Token = await TestERC20.new('Test ERC20', 'tERC20', { from: owner });
      ERC721Token = await TestERC721.new('Test NFT', 'tNFT', { from: owner });

      ERC1155Token = await TestERC1155.new('', { from: ownerToken });

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

      royalties = [
        { account: royaltiesRecipient, value: 100 }, // 1% royalty
      ];
      // Caller is token owner
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC1155Token.address,
        1,
        royalties,
        { from: ownerToken },
      );
      await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
        ERC1155Token.address,
        1,
        royalties,
        { from: ownerToken },
      );
    });

    describe('ERC2981 royalties, partial fills: make ERC1155-ERC2981, take WETH', () => {
      beforeEach(async () => {
        // Mint 10 ERC1155 tokens to maker
        await ERC1155Token.mint(maker, 1, 10, '0x', { from: ownerToken });
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '10');
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // makerOrder object
        makerOrder = Order(
          maker, // maker
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '10'), // rightMake
          ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(10, 18)), // rightTake
          1, // salt
          0,
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
        makerSignature = await signOrderData(
          web3,
          maker,
          makerOrder,
          exchangeProxyAddress,
          CHAIN_ID,
        );
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
        // Register ERC2981 royalties
        await ERC1155Token.setRoyalty(1, royaltiesRecipient, 100, { from: ownerToken }); // 1% royalty
        // Check that royalties have been registered correctly
        royalties = await ERC1155Token.royaltyInfo(1, 100);
        assert.equal(royalties._receiver, royaltiesRecipient);
        assert.equal(royalties._royaltyAmount.toString(), '1');
      });

      it('ERC2981 royalties registered in token contract, taker order fills 50% of maker order', async () => {
        // Get WETH to taker
        royalties = [
          { account: royaltiesRecipient, value: 100 }, // 1% royalty
        ];
        // Caller is token owner
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await weth.deposit({ from: taker, value: expandToDecimals(5, 18) }); // Deposit 5 ETH to get 5 WETH
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(5, 18));
        // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
        await weth.approve(exchangeProxyAddress, expandToDecimals(5, 18), { from: taker });
        assert.equal(
          (await weth.allowance(taker, exchangeProxyAddress)).toString(),
          expandToDecimalsString(5, 18),
        );
        // Get initial defaultFeeReceiver ETH balance
        defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // takerOrder object
        takerOrder = Order(
          taker,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '5'), // leftTake
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
          expandToDecimalsString(5, 16), // 0.05 ETH
        );
        assert.equal(
          (await weth.balanceOf(defaultFeeReceiver)).toString(),
          '0', // 0 WETH
        );
        // Check that royalties were paid
        assert.equal(
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(5, 16),
        ); // 0.05 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '5');
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '5');
        assert.equal(
          (await weth.balanceOf(maker)).toString(),
          expandToDecimalsString(49, 17), // 4.90 WETH
        );
        assert.equal((await weth.balanceOf(taker)).toString(), '0');
        // Check that maker order fill equals rightTake value
        assert.equal(
          (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
          expandToDecimalsString(5, 18),
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
        assert.equal(events[0].returnValues.newLeftFill, '5');
        assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(5, 18));
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
        assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(5, 16)); // 0.05 WETH
        assert.equal(events[0].returnValues.from, taker);
        assert.equal(events[0].returnValues.to, defaultFeeReceiver);
        assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[0].returnValues.transferType, PROTOCOL);
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(5, 16)); // 0.05 WETH
        assert.equal(events[1].returnValues.from, taker);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to maker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(49, 17)); // 4.90 WETH
        assert.equal(events[2].returnValues.from, taker);
        assert.equal(events[2].returnValues.to, maker);
        assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to taker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '5');
        assert.equal(events[3].returnValues.from, maker);
        assert.equal(events[3].returnValues.to, taker);
        assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);
      });

      it('ERC2981 royalties registered in token contract, taker order fills 150% of maker order', async () => {
        // Get WETH to taker
        royalties = [
          { account: royaltiesRecipient, value: 100 }, // 1% royalty
        ];
        // Caller is token owner
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await weth.deposit({ from: taker, value: expandToDecimals(15, 18) }); // Deposit 15 ETH to get 15 WETH
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(15, 18));
        // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
        await weth.approve(exchangeProxyAddress, expandToDecimals(15, 18), { from: taker });
        assert.equal(
          (await weth.allowance(taker, exchangeProxyAddress)).toString(),
          expandToDecimalsString(15, 18),
        );
        // Get initial defaultFeeReceiver ETH balance
        defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // takerOrder object
        takerOrder = Order(
          taker,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(15, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '15'), // leftTake
          0, // salt can be 0 for taker orders submitted by taker account
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
        // Match orders
        tx = await exchangeBehindProxy.matchOrders(
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
          expandToDecimalsString(1, 17), // 0.1 ETH
        );
        assert.equal(
          (await weth.balanceOf(defaultFeeReceiver)).toString(),
          '0', // 0 WETH
        );
        // Check that royalties were paid
        assert.equal(
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(1, 17),
        ); // 0.1 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '10');
        assert.equal(
          (await weth.balanceOf(maker)).toString(),
          expandToDecimalsString(98, 17), // 9.8 WETH
        );
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(5, 18));
        // Check that maker order fill equals rightTake value
        assert.equal(
          (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
          expandToDecimalsString(1, 19),
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
        assert.equal(events[0].returnValues.newLeftFill, '10');
        assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(10, 18));
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
        assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 17)); // 0.1 WETH
        assert.equal(events[0].returnValues.from, taker);
        assert.equal(events[0].returnValues.to, defaultFeeReceiver);
        assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[0].returnValues.transferType, PROTOCOL);
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 17)); // 0.1 WETH
        assert.equal(events[1].returnValues.from, taker);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to maker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(98, 17)); // 9.8 WETH
        assert.equal(events[2].returnValues.from, taker);
        assert.equal(events[2].returnValues.to, maker);
        assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to taker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '10');
        assert.equal(events[3].returnValues.from, maker);
        assert.equal(events[3].returnValues.to, taker);
        assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);
      });

      it('ERC2981 royalties registered in token contract, taker order fills 10% of maker order, then other order fills 50% more, then 100% more', async () => {
        // 1) Taker order fills 10% of maker order
        // Get WETH to taker
        royalties = [
          { account: royaltiesRecipient, value: 100 }, // 1% royalty
        ];
        // Caller is token owner
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
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
        tx = await exchangeBehindProxy.matchOrders(
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
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(1, 16),
        ); // 0.01 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '9');
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '1');
        assert.equal(
          (await weth.balanceOf(maker)).toString(),
          expandToDecimalsString(98, 16), // 0.98 WETH
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
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 16)); // 0.01 WETH
        assert.equal(events[1].returnValues.from, taker);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to maker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(98, 16)); // 0.98 WETH
        assert.equal(events[2].returnValues.from, taker);
        assert.equal(events[2].returnValues.to, maker);
        assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to taker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '1');
        assert.equal(events[3].returnValues.from, maker);
        assert.equal(events[3].returnValues.to, taker);
        assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);

        // 2) Other fills another 50% of maker order
        // Get WETH to taker
        await weth.deposit({ from: other, value: expandToDecimals(5, 18) }); // Deposit 5 ETH to get 5 WETH
        assert.equal((await weth.balanceOf(other)).toString(), expandToDecimalsString(5, 18));
        // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
        await weth.approve(exchangeProxyAddress, expandToDecimals(5, 18), { from: other });
        assert.equal(
          (await weth.allowance(other, exchangeProxyAddress)).toString(),
          expandToDecimalsString(5, 18),
        );
        // Get initial defaultFeeReceiver ETH balance
        defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // takerOrder object
        takerOrder = Order(
          other,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '5'), // leftTake
          0, // salt can be 0 for taker orders submitted by taker account
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
        // Match orders
        tx = await exchangeBehindProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
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
          expandToDecimalsString(5, 16), // 0.05 ETH
        );
        assert.equal(
          (await weth.balanceOf(defaultFeeReceiver)).toString(),
          '0', // 0 WETH
        );
        // Check that royalties were paid
        assert.equal(
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(6, 16),
        ); // 0.01 + 0.05 = 0.06 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '4');
        assert.equal((await ERC1155Token.balanceOf(other, 1)).toString(), '5');
        assert.equal(
          (await weth.balanceOf(maker)).toString(),
          expandToDecimalsString(588, 16), // 5.88 WETH
        );
        assert.equal((await weth.balanceOf(other)).toString(), '0');
        // Check new maker order fill
        assert.equal(
          (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
          expandToDecimalsString(6, 18),
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
        assert.equal(events[0].returnValues.leftMaker, other);
        assert.equal(events[0].returnValues.rightMaker, maker);
        assert.equal(events[0].returnValues.newLeftFill, '5');
        assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(5, 18));
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
        assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(5, 16)); // 0.05 WETH
        assert.equal(events[0].returnValues.from, other);
        assert.equal(events[0].returnValues.to, defaultFeeReceiver);
        assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[0].returnValues.transferType, PROTOCOL);
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(5, 16)); // 0.05 WETH
        assert.equal(events[1].returnValues.from, other);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to maker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(49, 17)); // 4.90 WETH
        assert.equal(events[2].returnValues.from, other);
        assert.equal(events[2].returnValues.to, maker);
        assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to taker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '5');
        assert.equal(events[3].returnValues.from, maker);
        assert.equal(events[3].returnValues.to, other);
        assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);

        // 3) Other fills another 100% of maker order
        // Get WETH to taker
        await weth.deposit({ from: other, value: expandToDecimals(10, 18) }); // Deposit 10 ETH to get 10 WETH
        assert.equal((await weth.balanceOf(other)).toString(), expandToDecimalsString(10, 18));
        // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
        await weth.approve(exchangeProxyAddress, expandToDecimals(10, 18), { from: other });
        assert.equal(
          (await weth.allowance(other, exchangeProxyAddress)).toString(),
          expandToDecimalsString(10, 18),
        );
        // Get initial defaultFeeReceiver ETH balance
        defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // takerOrder object
        takerOrder = Order(
          other,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(10, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '10'), // leftTake
          0, // salt can be 0 for taker orders submitted by taker account
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
        // Match orders
        tx = await exchangeBehindProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
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
          expandToDecimalsString(4, 16), // 0.04 ETH
        );
        assert.equal(
          (await weth.balanceOf(defaultFeeReceiver)).toString(),
          '0', // 0 WETH
        );
        // Check that royalties were paid
        assert.equal(
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(1, 17),
        ); // 0.01 + 0.05 + 0.04 = 0.1 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
        assert.equal((await ERC1155Token.balanceOf(other, 1)).toString(), '9');
        assert.equal(
          (await weth.balanceOf(maker)).toString(),
          expandToDecimalsString(98, 17), // 9.8 WETH
        );
        assert.equal((await weth.balanceOf(other)).toString(), expandToDecimalsString(6, 18));
        // Check new maker order fill
        assert.equal(
          (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
          expandToDecimalsString(10, 18),
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
        assert.equal(events[0].returnValues.leftMaker, other);
        assert.equal(events[0].returnValues.rightMaker, maker);
        assert.equal(events[0].returnValues.newLeftFill, '4');
        assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(4, 18));
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
        assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(4, 16)); // 0.04 WETH
        assert.equal(events[0].returnValues.from, other);
        assert.equal(events[0].returnValues.to, defaultFeeReceiver);
        assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[0].returnValues.transferType, PROTOCOL);
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(4, 16)); // 0.04 WETH
        assert.equal(events[1].returnValues.from, other);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to maker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(392, 16)); // 3.92 WETH
        assert.equal(events[2].returnValues.from, other);
        assert.equal(events[2].returnValues.to, maker);
        assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to taker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '4');
        assert.equal(events[3].returnValues.from, maker);
        assert.equal(events[3].returnValues.to, other);
        assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);
      });

      it('ERC2981 royalties registered in token contract, taker order make value buys less than one ERC1155 token (reverts)', async () => {
        // Get WETH to taker
        royalties = [
          { account: royaltiesRecipient, value: 100 }, // 1% royalty
        ];
        // Caller is token owner
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await weth.deposit({ from: taker, value: expandToDecimals(5, 17) }); // Deposit 0.5 ETH to get 0.5 WETH
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(5, 17));
        // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
        await weth.approve(exchangeProxyAddress, expandToDecimals(5, 17), { from: taker });
        assert.equal(
          (await weth.allowance(taker, exchangeProxyAddress)).toString(),
          expandToDecimalsString(5, 17),
        );
        // Get initial defaultFeeReceiver ETH balance
        defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // takerOrder object
        takerOrder = Order(
          taker,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 17)), // leftMake
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
          exchangeBehindProxy.matchOrders(
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

      it('ERC2981 royalties registered in token contract, taker order make value is twice larger than maker order take value while taker order take value equals maker order make value (taker pays double price)', async () => {
        // Get WETH to taker
        await weth.deposit({ from: taker, value: expandToDecimals(20, 18) }); // Deposit 20 ETH to get 20 WETH
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(20, 18));
        // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
        await weth.approve(exchangeProxyAddress, expandToDecimals(20, 18), { from: taker });
        assert.equal(
          (await weth.allowance(taker, exchangeProxyAddress)).toString(),
          expandToDecimalsString(20, 18),
        );
        // Get initial defaultFeeReceiver ETH balance
        defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // takerOrder object
        takerOrder = Order(
          taker,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(20, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '10'), // leftTake
          0, // salt can be 0 for taker orders submitted by taker account
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
        // Match orders
        tx = await exchangeBehindProxy.matchOrders(
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
          expandToDecimalsString(1, 17), // 0.1 ETH
        );
        assert.equal(
          (await weth.balanceOf(defaultFeeReceiver)).toString(),
          '0', // 0 WETH
        );
        // Check that royalties were paid
        assert.equal(
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(1, 17),
        ); // 0.1 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '5'); // Taker only got 5 ERC1155 (paid double price)
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '5');
        assert.equal(
          (await weth.balanceOf(maker)).toString(),
          expandToDecimalsString(98, 17), // 9.8 WETH
        );
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(10, 18));
        // Check that maker order fill equals rightTake value
        assert.equal(
          (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
          expandToDecimalsString(10, 18),
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
        assert.equal(events[0].returnValues.newLeftFill, '5');
        assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(10, 18));
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
        assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 17)); // 0.1 WETH
        assert.equal(events[0].returnValues.from, taker);
        assert.equal(events[0].returnValues.to, defaultFeeReceiver);
        assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[0].returnValues.transferType, PROTOCOL);
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 17)); // 0.1 WETH
        assert.equal(events[1].returnValues.from, taker);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to maker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(98, 17)); // 9.8 WETH
        assert.equal(events[2].returnValues.from, taker);
        assert.equal(events[2].returnValues.to, maker);
        assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to taker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '5');
        assert.equal(events[3].returnValues.from, maker);
        assert.equal(events[3].returnValues.to, taker);
        assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);
      });

      it('ERC2981 royalties registered in token contract, taker order make/take values are both twice larger than maker order take/make values (taker pays normal price)', async () => {
        // Get WETH to taker

        await weth.deposit({ from: taker, value: expandToDecimals(20, 18) }); // Deposit 20 ETH to get 20 WETH
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(20, 18));
        // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
        await weth.approve(exchangeProxyAddress, expandToDecimals(20, 18), { from: taker });
        assert.equal(
          (await weth.allowance(taker, exchangeProxyAddress)).toString(),
          expandToDecimalsString(20, 18),
        );
        // Get initial defaultFeeReceiver ETH balance
        defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // takerOrder object
        takerOrder = Order(
          taker,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(20, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '20'), // leftTake
          0, // salt can be 0 for taker orders submitted by taker account
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
        // Match orders
        tx = await exchangeBehindProxy.matchOrders(
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
          expandToDecimalsString(1, 17), // 0.1 ETH
        );
        assert.equal(
          (await weth.balanceOf(defaultFeeReceiver)).toString(),
          '0', // 0 WETH
        );
        // Check that royalties were paid
        assert.equal(
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(1, 17),
        ); // 0.1 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '0');
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '10');
        assert.equal(
          (await weth.balanceOf(maker)).toString(),
          expandToDecimalsString(98, 17), // 9.8 WETH
        );
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(10, 18));
        // Check that maker order fill equals rightTake value
        assert.equal(
          (await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(),
          expandToDecimalsString(10, 18),
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
        assert.equal(events[0].returnValues.newLeftFill, '10');
        assert.equal(events[0].returnValues.newRightFill, expandToDecimalsString(10, 18));
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
        assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 17)); // 0.1 WETH
        assert.equal(events[0].returnValues.from, taker);
        assert.equal(events[0].returnValues.to, defaultFeeReceiver);
        assert.equal(events[0].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[0].returnValues.transferType, PROTOCOL);
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 17)); // 0.1 WETH
        assert.equal(events[1].returnValues.from, taker);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to maker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(98, 17)); // 9.8 WETH
        assert.equal(events[2].returnValues.from, taker);
        assert.equal(events[2].returnValues.to, maker);
        assert.equal(events[2].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to taker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '10');
        assert.equal(events[3].returnValues.from, maker);
        assert.equal(events[3].returnValues.to, taker);
        assert.equal(events[3].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);
      });

      it('ERC2981 royalties registered in token contract, taker order make value equals maker order take value while taker order take value is twice larger than maker order make value (reverts)', async () => {
        // Get WETH to taker
        await weth.deposit({ from: taker, value: expandToDecimals(10, 18) }); // Deposit 10 ETH to get 10 WETH
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(10, 18));
        // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
        await weth.approve(exchangeProxyAddress, expandToDecimals(10, 18), { from: taker });
        assert.equal(
          (await weth.allowance(taker, exchangeProxyAddress)).toString(),
          expandToDecimalsString(10, 18),
        );
        // Get initial defaultFeeReceiver ETH balance
        defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // takerOrder object
        takerOrder = Order(
          taker,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(10, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '20'), // leftTake
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
          exchangeBehindProxy.matchOrders(
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

    describe('ERC2981 royalties, partial fills: make WETH, take ERC1155', () => {
      beforeEach(async () => {
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // makerOrder object
        makerOrder = Order(
          maker, // maker
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(10, 18)), // rightMake
          ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '10'), // rightTake
          1, // salt
          0, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Approve exchange proxy for transferring makeAsset (transfer to order taker + fees)
        await weth.approve(exchangeProxyAddress, expandToDecimals(10, 18), { from: maker });
        assert.equal(
          (await weth.allowance(maker, exchangeProxyAddress)).toString(),
          expandToDecimalsString(10, 18),
        );
        // Calculate makerOrder key hash
        makerOrderKeyHash = await libOrder.hashKey(makerOrder);
        // Generate maker order EIP712 typed data signature
        makerSignature = await signOrderData(
          web3,
          maker,
          makerOrder,
          exchangeProxyAddress,
          CHAIN_ID,
        );
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
        // Register ERC2981 royalties
        await ERC1155Token.setRoyalty(1, royaltiesRecipient, 100, { from: ownerToken }); // 1% royalty
        // Check that royalties have been registered correctly
        royalties = await ERC1155Token.royaltyInfo(1, 100);
        assert.equal(royalties._receiver, royaltiesRecipient);
        assert.equal(royalties._royaltyAmount.toString(), '1');
      });

      it('ERC2981 royalties registered in token contract, taker order fills 50% of maker order', async () => {
        // Get WETH to maker
        await weth.deposit({ from: maker, value: expandToDecimals(10, 18) }); // Deposit 10 ETH to get 10 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(10, 18));
        // Mint ERC1155 token to taker
        await ERC1155Token.mint(taker, 1, 5, '0x', { from: ownerToken });
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '5');
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
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '5'), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 18)), // leftTake
          0, // salt can be 0 for taker orders submitted by taker account
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
        // Match orders
        tx = await exchangeBehindProxy.matchOrders(
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
          expandToDecimalsString(5, 16), // 0.05 ETH
        );
        assert.equal(
          (await weth.balanceOf(defaultFeeReceiver)).toString(),
          '0', // 0 WETH
        );
        // Check that royalties were paid
        assert.equal(
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(5, 16),
        ); // 0.05 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0');
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '5');
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(49, 17)); // 4.9 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(5, 18));
        // Check that maker order fill equals rightTake value
        assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '5');
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
        assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(5, 18));
        assert.equal(events[0].returnValues.newRightFill, '5');
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
        assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(5, 16)); // 0.05 WETH
        assert.equal(events[0].returnValues.from, maker);
        assert.equal(events[0].returnValues.to, defaultFeeReceiver);
        assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[0].returnValues.transferType, PROTOCOL);
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(5, 16)); // 0.05 WETH
        assert.equal(events[1].returnValues.from, maker);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to taker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(49, 17)); // 4.9 WETH
        assert.equal(events[2].returnValues.from, maker);
        assert.equal(events[2].returnValues.to, taker);
        assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '5');
        assert.equal(events[3].returnValues.from, taker);
        assert.equal(events[3].returnValues.to, maker);
        assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);
      });

      it('ERC2981 royalties registered in token contract, taker order fills 150% of maker order', async () => {
        // Get WETH to maker
        royalties = [
          { account: royaltiesRecipient, value: 100 }, // 1% royalty
        ];
        // Caller is token owner
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await weth.deposit({ from: maker, value: expandToDecimals(10, 18) }); // Deposit 10 ETH to get 10 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(10, 18));
        // Mint ERC1155 token to taker
        await ERC1155Token.mint(taker, 1, 15, '0x', { from: ownerToken });
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '15');
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
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '15'), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(15, 18)), // leftTake
          0, // salt can be 0 for taker orders submitted by taker account
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
        // Match orders
        tx = await exchangeBehindProxy.matchOrders(
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
          expandToDecimalsString(1, 17), // 0.1 ETH
        );
        assert.equal(
          (await weth.balanceOf(defaultFeeReceiver)).toString(),
          '0', // 0 WETH
        );
        // Check that royalties were paid
        assert.equal(
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(1, 17),
        ); // 0.1 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '5');
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '10');
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(98, 17)); // 9.8 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), '0');
        // Check that maker order fill equals rightTake value
        assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '10');
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
        assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(10, 18));
        assert.equal(events[0].returnValues.newRightFill, '10');
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
        assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 17)); // 0.1 WETH
        assert.equal(events[0].returnValues.from, maker);
        assert.equal(events[0].returnValues.to, defaultFeeReceiver);
        assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[0].returnValues.transferType, PROTOCOL);
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 17)); // 0.1 WETH
        assert.equal(events[1].returnValues.from, maker);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to taker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(98, 17)); // 9.8 WETH
        assert.equal(events[2].returnValues.from, maker);
        assert.equal(events[2].returnValues.to, taker);
        assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '10');
        assert.equal(events[3].returnValues.from, taker);
        assert.equal(events[3].returnValues.to, maker);
        assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);
      });

      it('ERC2981 royalties registered in token contract, taker order fills 10% of maker order, then other order fills 50% more, then 100% more', async () => {
        // 1) Taker order fills 10% of maker order
        // Get WETH to maker
        royalties = [
          { account: royaltiesRecipient, value: 100 }, // 1% royalty
        ];
        // Caller is token owner
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await weth.deposit({ from: maker, value: expandToDecimals(10, 18) }); // Deposit 10 ETH to get 10 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(10, 18));
        // Mint ERC1155 token to taker
        await ERC1155Token.mint(taker, 1, 1, '0x', { from: ownerToken });
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
        tx = await exchangeBehindProxy.matchOrders(
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
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(1, 16),
        ); // 0.01 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '0');
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '1');
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(98, 16)); // 0.98 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(9, 18));
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
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
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
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '1');
        assert.equal(events[3].returnValues.from, taker);
        assert.equal(events[3].returnValues.to, maker);
        assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);

        // 2) Other fills another 50% of maker order
        // Mint ERC1155 token to taker
        await ERC1155Token.mint(other, 1, 5, '0x', { from: ownerToken });
        assert.equal((await ERC1155Token.balanceOf(other, 1)).toString(), '5');
        // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
        await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: other });
        assert.equal(await ERC1155Token.isApprovedForAll(other, exchangeProxyAddress), true);
        // Get initial defaultFeeReceiver ETH balance
        defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // takerOrder object
        takerOrder = Order(
          other,
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '5'), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 18)), // leftTake
          0, // salt can be 0 for taker orders submitted by taker account
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
        // Match orders
        tx = await exchangeBehindProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
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
          expandToDecimalsString(5, 16), // 0.05 ETH
        );
        assert.equal(
          (await weth.balanceOf(defaultFeeReceiver)).toString(),
          '0', // 0 WETH
        );
        // Check that royalties were paid
        assert.equal(
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(6, 16),
        ); // 0.01 + 0.05 = 0.06 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(other, 1)).toString(), '0');
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '6');
        assert.equal((await weth.balanceOf(other)).toString(), expandToDecimalsString(49, 17)); // 4.9 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(4, 18));
        // Check that maker order fill equals rightTake value
        assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '6');
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
        assert.equal(events[0].returnValues.leftMaker, other);
        assert.equal(events[0].returnValues.rightMaker, maker);
        assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(5, 18));
        assert.equal(events[0].returnValues.newRightFill, '5');
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
        assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(5, 16)); // 0.05 WETH
        assert.equal(events[0].returnValues.from, maker);
        assert.equal(events[0].returnValues.to, defaultFeeReceiver);
        assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[0].returnValues.transferType, PROTOCOL);
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(5, 16)); // 0.05 WETH
        assert.equal(events[1].returnValues.from, maker);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to taker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(49, 17)); // 4.9 WETH
        assert.equal(events[2].returnValues.from, maker);
        assert.equal(events[2].returnValues.to, other);
        assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '5');
        assert.equal(events[3].returnValues.from, other);
        assert.equal(events[3].returnValues.to, maker);
        assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);

        // 3) Other fills another 100% of maker order
        // Mint ERC1155 token to taker
        await ERC1155Token.mint(other, 1, 10, '0x', { from: ownerToken });
        assert.equal((await ERC1155Token.balanceOf(other, 1)).toString(), '10');
        // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
        await ERC1155Token.setApprovalForAll(exchangeProxyAddress, true, { from: other });
        assert.equal(await ERC1155Token.isApprovedForAll(other, exchangeProxyAddress), true);
        // Get initial defaultFeeReceiver ETH balance
        defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // takerOrder object
        takerOrder = Order(
          other,
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '10'), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(10, 18)), // leftTake
          0, // salt can be 0 for taker orders submitted by taker account
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
        // Match orders
        tx = await exchangeBehindProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
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
          expandToDecimalsString(4, 16), // 0.04 ETH
        );
        assert.equal(
          (await weth.balanceOf(defaultFeeReceiver)).toString(),
          '0', // 0 WETH
        );
        // Check that royalties were paid
        assert.equal(
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(1, 17),
        ); // 0.01 + 0.05 + 0.04 = 0.1 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(other, 1)).toString(), '6');
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '10');
        assert.equal((await weth.balanceOf(other)).toString(), expandToDecimalsString(882, 16)); // 8.82 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), '0');
        // Check that maker order fill equals rightTake value
        assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '10');
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
        assert.equal(events[0].returnValues.leftMaker, other);
        assert.equal(events[0].returnValues.rightMaker, maker);
        assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(4, 18));
        assert.equal(events[0].returnValues.newRightFill, '4');
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
        assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(4, 16)); // 0.04 WETH
        assert.equal(events[0].returnValues.from, maker);
        assert.equal(events[0].returnValues.to, defaultFeeReceiver);
        assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[0].returnValues.transferType, PROTOCOL);
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(4, 16)); // 0.04 WETH
        assert.equal(events[1].returnValues.from, maker);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to taker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(392, 16)); // 3.92 WETH
        assert.equal(events[2].returnValues.from, maker);
        assert.equal(events[2].returnValues.to, other);
        assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '4');
        assert.equal(events[3].returnValues.from, other);
        assert.equal(events[3].returnValues.to, maker);
        assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);
      });

      // here
      it('ERC2981 royalties registered in token contract, taker order make value is twice larger than maker order take value while taker order take value equals maker order make value (maker pays half price)', async () => {
        // Get WETH to maker
        await weth.deposit({ from: maker, value: expandToDecimals(10, 18) }); // Deposit 10 ETH to get 10 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(10, 18));
        // Mint ERC1155 token to taker
        await ERC1155Token.mint(taker, 1, 20, '0x', { from: ownerToken });
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '20');
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
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '20'), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(10, 18)), // leftTake
          0, // salt can be 0 for taker orders submitted by taker account
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
        // Match orders
        tx = await exchangeBehindProxy.matchOrders(
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
          expandToDecimalsString(5, 16), // 0.05 ETH
        );
        assert.equal(
          (await weth.balanceOf(defaultFeeReceiver)).toString(),
          '0', // 0 WETH
        );
        // Check that royalties were paid
        assert.equal(
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(5, 16),
        ); // 0.05 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '10');
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '10');
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(49, 17)); // 4.9 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(5, 18));
        // Check that maker order fill equals rightTake value
        assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '10');
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
        assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(5, 18));
        assert.equal(events[0].returnValues.newRightFill, '10');
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
        assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(5, 16)); // 0.05 WETH
        assert.equal(events[0].returnValues.from, maker);
        assert.equal(events[0].returnValues.to, defaultFeeReceiver);
        assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[0].returnValues.transferType, PROTOCOL);
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(5, 16)); // 0.05 WETH
        assert.equal(events[1].returnValues.from, maker);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to taker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(49, 17)); // 4.9 WETH
        assert.equal(events[2].returnValues.from, maker);
        assert.equal(events[2].returnValues.to, taker);
        assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '10');
        assert.equal(events[3].returnValues.from, taker);
        assert.equal(events[3].returnValues.to, maker);
        assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);
      });

      it('ERC2981 royalties registered in token contract, taker order make/take values are both twice larger than maker order take/make values (maker pays normal price)', async () => {
        // Get WETH to maker
        royalties = [
          { account: royaltiesRecipient, value: 100 }, // 1% royalty
        ];
        // Caller is token owner
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await royaltiesRegistryProxy.setOwnerRoyaltiesByTokenAndTokenId(
          ERC1155Token.address,
          1,
          royalties,
          { from: ownerToken },
        );
        await weth.deposit({ from: maker, value: expandToDecimals(10, 18) }); // Deposit 10 ETH to get 10 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(10, 18));
        // Mint ERC1155 token to taker
        await ERC1155Token.mint(taker, 1, 20, '0x', { from: ownerToken });
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '20');
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
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '20'), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(20, 18)), // leftTake
          0, // salt can be 0 for taker orders submitted by taker account
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
        // Match orders
        tx = await exchangeBehindProxy.matchOrders(
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
          expandToDecimalsString(1, 17), // 0.1 ETH
        );
        assert.equal(
          (await weth.balanceOf(defaultFeeReceiver)).toString(),
          '0', // 0 WETH
        );
        // Check that royalties were paid
        assert.equal(
          (await weth.balanceOf(royaltiesRecipient)).toString(),
          expandToDecimalsString(1, 17),
        ); // 0.1 WETH
        // Check maker and taker balances
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '10');
        assert.equal((await ERC1155Token.balanceOf(maker, 1)).toString(), '10');
        assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(98, 17)); // 9.8 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), '0');
        // Check that maker order fill equals rightTake value
        assert.equal((await exchangeProxy.getOrderFill(makerOrderKeyHash)).toString(), '10');
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
        assert.equal(events[0].returnValues.newLeftFill, expandToDecimalsString(10, 18));
        assert.equal(events[0].returnValues.newRightFill, '10');
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
        assert.equal(events[0].returnValues.assetValue, expandToDecimalsString(1, 17)); // 0.1 WETH
        assert.equal(events[0].returnValues.from, maker);
        assert.equal(events[0].returnValues.to, defaultFeeReceiver);
        assert.equal(events[0].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[0].returnValues.transferType, PROTOCOL);
        // Transfer royalties
        assert.equal(events[1].event, 'Transfer');
        assert.equal(events[1].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[1].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[1].returnValues.assetValue, expandToDecimalsString(1, 17)); // 0.1 WETH
        assert.equal(events[1].returnValues.from, maker);
        assert.equal(events[1].returnValues.to, royaltiesRecipient);
        assert.equal(events[1].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[1].returnValues.transferType, ROYALTY);
        // Transfer asset to taker
        assert.equal(events[2].event, 'Transfer');
        assert.equal(events[2].returnValues.assetClass, WETH + ZERO_FILLER_STRING);
        assert.equal(events[2].returnValues.assetData, encodeTokenData(weth.address));
        assert.equal(events[2].returnValues.assetValue, expandToDecimalsString(98, 17)); // 9.8 WETH
        assert.equal(events[2].returnValues.from, maker);
        assert.equal(events[2].returnValues.to, taker);
        assert.equal(events[2].returnValues.transferDirection, TO_TAKER);
        assert.equal(events[2].returnValues.transferType, PAYOUT);
        // Transfer asset to maker
        assert.equal(events[3].event, 'Transfer');
        assert.equal(events[3].returnValues.assetClass, ERC1155 + ZERO_FILLER_STRING);
        assert.equal(events[3].returnValues.assetData, encodeTokenData(ERC1155Token.address, 1));
        assert.equal(events[3].returnValues.assetValue, '10');
        assert.equal(events[3].returnValues.from, taker);
        assert.equal(events[3].returnValues.to, maker);
        assert.equal(events[3].returnValues.transferDirection, TO_MAKER);
        assert.equal(events[3].returnValues.transferType, PAYOUT);
      });

      it('ERC2981 royalties registered in token contract, taker order make value equals maker order take value while taker order take value is twice larger than maker order make value (reverts)', async () => {
        // Get WETH to maker
        await weth.deposit({ from: maker, value: expandToDecimals(10, 18) }); // Deposit 10 ETH to get 10 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(10, 18));
        // Mint ERC1155 token to taker
        await ERC1155Token.mint(taker, 1, 10, '0x', { from: ownerToken });
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '10');
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
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '10'), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(20, 18)), // leftTake
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
          exchangeBehindProxy.matchOrders(
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

    describe('ERC2981 royalties, partial fills: make WETH, take ERC1155', () => {
      beforeEach(async () => {
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        // makerOrder object
        makerOrder = Order(
          maker, // maker
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(5, 17)), // rightMake
          ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '1'), // rightTake
          1, // salt
          0, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Approve exchange proxy for transferring makeAsset (transfer to order taker + fees)
        await weth.approve(exchangeProxyAddress, expandToDecimals(5, 17), { from: maker });
        assert.equal(
          (await weth.allowance(maker, exchangeProxyAddress)).toString(),
          expandToDecimalsString(5, 17),
        );
        // Calculate makerOrder key hash
        makerOrderKeyHash = await libOrder.hashKey(makerOrder);
        // Generate maker order EIP712 typed data signature
        makerSignature = await signOrderData(
          web3,
          maker,
          makerOrder,
          exchangeProxyAddress,
          CHAIN_ID,
        );
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
        // Register ERC2981 royalties
        await ERC1155Token.setRoyalty(1, royaltiesRecipient, 100, { from: ownerToken }); // 1% royalty
        // Check that royalties have been registered correctly
        royalties = await ERC1155Token.royaltyInfo(1, 100);
        assert.equal(royalties._receiver, royaltiesRecipient);
        assert.equal(royalties._royaltyAmount.toString(), '1');
      });

      it('ERC2981 royalties registered in token contract, maker order make value buys less than one ERC1155 token (reverts)', async () => {
        // Get WETH to maker
        await weth.deposit({ from: maker, value: expandToDecimals(5, 17) }); // Deposit 0.5 ETH to get 0.5 WETH
        assert.equal((await weth.balanceOf(maker)).toString(), expandToDecimalsString(5, 17));
        // Mint ERC1155 token to taker
        await ERC1155Token.mint(taker, 1, 10, '0x', { from: ownerToken });
        assert.equal((await ERC1155Token.balanceOf(taker, 1)).toString(), '10');
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
          Asset(ERC1155, encodeTokenData(ERC1155Token.address, 1), '10'), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(10, 18)), // leftTake
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
          exchangeBehindProxy.matchOrders(
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
  },
);
