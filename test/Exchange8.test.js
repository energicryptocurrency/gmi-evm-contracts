const { getBalance, getBlock, sendTransaction } = web3.eth;
const { toBN } = web3.utils;
const truffleAssert = require('truffle-assertions');

const { Order, MatchAllowance, Asset, encodeTokenData } = require('./utils/order');
const { signOrderData, signMatchAllowance } = require('./utils/EIP712Signer');
const { WETH, ERC721, INTERFACE_ID_ERC2981 } = require('./utils/hashKeys');
const { artifacts } = require('hardhat');

const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';
const PROTOCOL_FEE = toBN(100); // 1% protocol fee in bps (1 bps = 0.01%)
const CHAIN_ID = toBN(1);
const DUMMY_ORDER_KEY_HASH = '0x0000000000000000000000000000000000000000000000000000000000000001';

let ERC721Token,
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
  matchAllowance,
  matchAllowanceBytesSig,
  matchAllowanceBytesSigRight,
  matchAllowanceRight,
  matchAllowanceSignature,
  matchAllowanceSignatureRight,
  matchBeforeTimestamp,
  matchRightBeforeTimestamp,
  royaltiesRegistryProxy,
  royaltiesRegistryProxyAddress,
  takerOrder,
  takerOrderBytesSig,
  takerOrderKeyHash,
  takerSignature,
  weth,
  whitelist,
  whitelistProxyAddress;

function expandToDecimals(value, decimals) {
  return toBN(value).mul(toBN(10).pow(toBN(decimals)));
}

function expandToDecimalsString(value, decimals) {
  return expandToDecimals(value, decimals).toString();
}

contract('Exchange - Functional Tests Part 8', accounts => {
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
  const TestERC1271 = artifacts.require('TestERC1271');

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

  // The following ERC2981 royalties tests are done using the TestERC721-ERC2981 contracts.
  // Other ERC2981 royalties tests use the TestERC1155-ERC2981 contract and test ERC2981 royalties
  // distribution in the specific case of partially filled orders (only possible with ERC1155).
  describe('Invalid matchAllowance', () => {
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
    });

    it('a cancelled maker order can NOT be passed as taker order and matched with a taker order passed as maker order with valid matchAllowance and the correct error message is returned', async () => {
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
      // Generate taker order EIP712 typed data signature
      takerSignature = await signOrderData(web3, taker, takerOrder, exchangeProxyAddress, CHAIN_ID);
      // takerSignature must be converted to bytes buffer before submission
      takerOrderBytesSig = Buffer.from(takerSignature.slice(2), 'hex');
      // Generate taker order matchAllowance
      // matchBeforeTimestamp > latestBlock
      matchBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowance
      matchAllowance = MatchAllowance(takerOrderKeyHash, matchBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignature = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowance,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSig = Buffer.from(matchAllowanceSignature.slice(2), 'hex');
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Match orders
      await truffleAssert.reverts(
        exchangeBehindProxy.matchOrders(
          makerOrder, // Canceled maker order passed here instead of taker order
          makerOrderBytesSig, // Maker order hash signature
          matchBeforeTimestamp, // Valid matchBeforeTimestamp
          matchAllowanceBytesSig, // Invalid matchAllowance signature
          takerOrder, // Taker order passed here instead of maker order
          takerOrderBytesSig, // Valid taker signature
          matchBeforeTimestamp, // Valid matchBeforeTimestamp
          matchAllowanceBytesSig, // Valid matchAllowance signature
          { from: taker },
        ),
        'LibExchange: EIP-712 matchAllowance signature verification error',
      );
    });

    it('matchBeforeTimestamp < latestTimestamp (reverts)', async () => {
      // matchBeforeTimestamp < latestTimestamp
      matchBeforeTimestamp = latestTimestamp - 1;
      // matchAllowance
      matchAllowance = MatchAllowance(makerOrderKeyHash, matchBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignature = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowance,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSig = Buffer.from(matchAllowanceSignature.slice(2), 'hex');
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
        exchangeBehindProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchBeforeTimestamp,
          matchAllowanceBytesSig,
          { from: taker },
        ),
        'LibExchange: current block`s timestamp is higher than matchBeforeTimestamp',
      );
    });

    it('matchAllowance and matchBeforeTimestamp mismatch (reverts)', async () => {
      // matchBeforeTimestamp
      matchBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowance with different matchBeforeTimestamp
      matchAllowance = MatchAllowance(makerOrderKeyHash, latestTimestamp + 100);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignature = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowance,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSig = Buffer.from(matchAllowanceSignature.slice(2), 'hex');
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
        exchangeBehindProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchBeforeTimestamp,
          matchAllowanceBytesSig,
          { from: taker },
        ),
        'LibExchange: EIP-712 matchAllowance signature verification error',
      );
    });

    it('matchAllowance and orderKeyHash mismatch (reverts)', async () => {
      // matchBeforeTimestamp
      matchBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowance with different orderKeyHash
      matchAllowance = MatchAllowance(DUMMY_ORDER_KEY_HASH, matchBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature
      matchAllowanceSignature = await signMatchAllowance(
        web3,
        orderBook,
        matchAllowance,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSig = Buffer.from(matchAllowanceSignature.slice(2), 'hex');
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
        exchangeBehindProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchBeforeTimestamp,
          matchAllowanceBytesSig,
          { from: taker },
        ),
        'LibExchange: EIP-712 matchAllowance signature verification error',
      );
    });

    it('invalid signer (reverts)', async () => {
      matchBeforeTimestamp = latestTimestamp + 100000;
      // matchAllowance
      matchAllowance = MatchAllowance(makerOrderKeyHash, matchBeforeTimestamp);
      // Generate matchAllowance EIP712 typed data signature with invalid signer (taker)
      matchAllowanceSignature = await signMatchAllowance(
        web3,
        taker,
        matchAllowance,
        exchangeProxyAddress,
        CHAIN_ID,
      );
      // matchAllowanceSignature must be converted to bytes buffer before submission
      matchAllowanceBytesSig = Buffer.from(matchAllowanceSignature.slice(2), 'hex');
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
        exchangeBehindProxy.matchOrders(
          takerOrder, // Taker order
          '0x', // Taker order hash signature not needed since taker is callerAddress
          0,
          '0x',
          makerOrder, // Maker order
          makerOrderBytesSig,
          matchBeforeTimestamp,
          matchAllowanceBytesSig,
          { from: taker },
        ),
        'LibExchange: EIP-712 matchAllowance signature verification error',
      );
    });
  });

  describe('ECDSA signature errors', () => {
    // all other ECDSA errors are unreachable as LibExchange errors will be fired first
    it('invalid signature length', async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Get latest block timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        0, // start
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
      // invalidate the signature by adding to it
      makerSignature = makerSignature + 'aaaa';
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
      // Get latest block timestamp
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
        'LibSignature: invalid ECDSA signature length',
      );
    });
  });

  describe('LibOrderData error', () => {
    it('reverts when an unknown order data type is used', async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Get latest block timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        0,
        latestTimestamp + 100000, // Order end
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
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest block timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // takerOrder object
      takerOrder = Order(
        taker,
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
        ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
        0, // salt can be 0 for taker orders submitted by taker account
        latestTimestamp,
        latestTimestamp + 100000, // Order end
        '0xeeeeeeee', // invalid dataType
        '0x', // data
      );
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
        'LibOrderData: Unknown Order data type',
      );
    });
  });

  describe('Invalid signature', () => {
    it('taker == caller, maker order signature invalid, maker is EOA (reverts)', async () => {
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Get latest block timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        0, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Generate invalid maker order EIP712 typed data signature
      makerSignature = await signOrderData(web3, other, makerOrder, exchangeProxyAddress, CHAIN_ID);
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
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest block timestamp
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
        latestTimestamp + 100000, // Order end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Match orders reverts
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
        'LibExchange: EIP-712 wallet order signature verification error',
      );
    });

    it('maker == caller, taker order signature invalid, taker is EOA (reverts)', async () => {
      // Get WETH to taker
      await weth.deposit({ from: taker, value: expandToDecimals(1, 18) }); // Deposit 1 ETH to get 1 WETH
      assert.equal((await weth.balanceOf(taker)).toString(), expandToDecimalsString(1, 18));
      // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
      await weth.approve(exchangeProxyAddress, expandToDecimals(1, 18), { from: taker });
      assert.equal(
        (await weth.allowance(taker, exchangeProxyAddress)).toString(),
        expandToDecimalsString(1, 18),
      );
      // Get latest block timestamp
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
      // Generate invalid taker order EIP712 typed data signature
      takerSignature = await signOrderData(web3, other, takerOrder, exchangeProxyAddress, CHAIN_ID);
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
      // Mint ERC721 token to maker
      await ERC721Token.mint(maker, { from: owner });
      assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
      // Get latest block timestamp
      latestBlock = await getBlock('latest');
      latestTimestamp = latestBlock.timestamp;
      // makerOrder object
      makerOrder = Order(
        maker, // maker
        Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
        ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
        Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
        1, // salt
        0, // start
        latestTimestamp + 100000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Approve exchange proxy for transferring makeAsset (transfer to order taker)
      await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
      assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
      // Calculate makerOrder key hash
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
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
      // Match orders
      await truffleAssert.reverts(
        exchangeBehindProxy.matchOrders(
          takerOrder, // Taker order
          takerOrderBytesSig, // Taker order hash signature needed since taker is not caller
          matchLeftBeforeTimestamp,
          matchAllowanceBytesSigLeft,
          makerOrder, // Maker order
          '0x',
          matchRightBeforeTimestamp,
          matchAllowanceBytesSigRight,
          { from: maker },
        ),
        'LibExchange: EIP-712 wallet order signature verification error',
      );
    });

    describe('EIP-1271 compliant contracts', () => {
      beforeEach(async () => {
        // Deploy EIP-1271 compliant contracts
        makerERC1271Contract = await TestERC1271.new(maker, exchangeProxy.address);
        takerERC1271Contract = await TestERC1271.new(taker, exchangeProxy.address);
      });

      it('taker == caller, maker order signature invalid, maker is contract (reverts)', async () => {
        /* Maker */
        // Mint ERC721 token to maker
        await ERC721Token.mint(makerERC1271Contract.address, { from: owner });
        assert.equal((await ERC721Token.balanceOf(makerERC1271Contract.address)).toString(), '1');
        // Approve exchange proxy for transferring makeAsset (transfer to order taker)
        await makerERC1271Contract.setApprovalForAllERC721(
          ERC721Token.address,
          exchangeProxyAddress,
          true,
          {
            from: maker,
          },
        );
        assert.equal(
          await ERC721Token.isApprovedForAll(makerERC1271Contract.address, exchangeProxyAddress),
          true,
        );
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        matchRightBeforeTimestamp = latestTimestamp + 100000;
        // makerOrder object
        makerOrder = Order(
          makerERC1271Contract.address, // maker
          Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
          ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
          1, // salt
          latestTimestamp, // start
          matchRightBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate makerOrder key hash
        makerOrderKeyHash = await libOrder.hashKey(makerOrder);
        // Generate an invalid maker order EIP712 typed data signature
        makerSignature = await signOrderData(
          web3,
          other,
          makerOrder,
          exchangeProxyAddress,
          CHAIN_ID,
        );
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

        /* Taker */
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
        matchLeftBeforeTimestamp = latestTimestamp + 100000;
        // takerOrder object
        takerOrder = Order(
          taker,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
          1, // salt
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
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

        /* Match */
        // Match orders reverts
        await truffleAssert.reverts(
          exchangeBehindProxy.matchOrders(
            takerOrder, // Taker order
            '0x', // Taker order hash signature not needed since taker is caller
            matchLeftBeforeTimestamp,
            matchAllowanceBytesSigLeft,
            makerOrder, // Maker order
            makerOrderBytesSig, // Maker order hash signature needed since makerERC1271Contract is not caller
            matchRightBeforeTimestamp,
            matchAllowanceBytesSigRight,
            { from: taker },
          ),
          'LibExchange: EIP-1271 contract order signature verification error',
        );
      });

      it('maker == caller, taker order signature invalid, taker is contract (reverts)', async () => {
        /* Maker */
        // Mint ERC721 token to maker
        await ERC721Token.mint(maker, { from: owner });
        assert.equal((await ERC721Token.balanceOf(maker)).toString(), '1');
        // Approve exchange proxy for transferring makeAsset (transfer to order taker)
        await ERC721Token.approve(exchangeProxyAddress, 1, { from: maker });
        assert.equal(await ERC721Token.getApproved(1), exchangeProxyAddress);
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        matchRightBeforeTimestamp = latestTimestamp + 100000;
        // makerOrder object
        makerOrder = Order(
          maker, // maker
          Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // rightMake
          ADDRESS_ZERO, // taker can be any account or EIP-1271 compliant contract
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // rightTake
          1, // salt
          latestTimestamp, // start
          matchRightBeforeTimestamp, // end
          '0xffffffff', // dataType
          '0x', // data
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

        /* Taker */
        // Get WETH to taker's contract
        await takerERC1271Contract.receiveWETH(weth.address, {
          from: taker,
          value: expandToDecimals(1, 18),
        }); // Deposit 1 ETH to get 1 WETH
        assert.equal(
          (await weth.balanceOf(takerERC1271Contract.address)).toString(),
          expandToDecimalsString(1, 18),
        );
        // Approve exchange proxy for transferring takeAsset (transfer to order maker and fee receiver)
        await takerERC1271Contract.approveERC20(
          weth.address,
          exchangeProxyAddress,
          expandToDecimals(1, 18),
          { from: taker },
        );
        assert.equal(
          (await weth.allowance(takerERC1271Contract.address, exchangeProxyAddress)).toString(),
          expandToDecimalsString(1, 18),
        );
        // Get initial defaultFeeReceiver ETH balance
        defaultFeeReceiverInitialETHBalance = toBN(await getBalance(defaultFeeReceiver));
        // Get latest timestamp
        latestBlock = await getBlock('latest');
        latestTimestamp = latestBlock.timestamp;
        matchLeftBeforeTimestamp = latestTimestamp + 100000;
        // takerOrder object
        takerOrder = Order(
          takerERC1271Contract.address,
          Asset(WETH, encodeTokenData(weth.address), expandToDecimalsString(1, 18)), // leftMake
          ADDRESS_ZERO, // maker can be any account or EIP-1271 compliant contract
          Asset(ERC721, encodeTokenData(ERC721Token.address, 1), '1'), // leftTake
          1, // salt
          latestTimestamp, // start
          latestTimestamp + 100000, // end
          '0xffffffff', // dataType
          '0x', // data
        );
        // Calculate takerOrder key hash
        takerOrderKeyHash = await libOrder.hashKey(takerOrder);
        // Generate invalid taker order EIP712 typed data signature
        takerSignature = await signOrderData(
          web3,
          other,
          takerOrder,
          exchangeProxyAddress,
          CHAIN_ID,
        );
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

        /* Match */
        // Match orders reverts
        await truffleAssert.reverts(
          exchangeBehindProxy.matchOrders(
            takerOrder, // Taker order
            takerOrderBytesSig, // Taker order hash signature needed since takerERC1271Contract is not caller
            matchLeftBeforeTimestamp,
            matchAllowanceBytesSigLeft,
            makerOrder, // Maker order
            makerOrderBytesSig,
            matchRightBeforeTimestamp,
            matchAllowanceBytesSigRight,
            { from: maker },
          ),
          'LibExchange: EIP-1271 contract order signature verification error',
        );
      });
    });
  });
});
