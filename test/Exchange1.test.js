const { getBalance, getBlock } = web3.eth;
const { toBN } = web3.utils;
const truffleAssert = require('truffle-assertions');

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
  PAYOUT,
} = require('./utils/hashKeys');
const { artifacts } = require('hardhat');

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
  exchangeHelperBehindProxy,
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
  matchAllowance,
  matchAllowanceBytesSig,
  matchAllowanceSignature,
  matchBeforeTimestamp,
  otherERC20Token,
  otherInitialETHBalance,
  royaltiesRegistry,
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

contract('Exchange - Functional Tests Part 1', accounts => {
  const ExchangeHelper = artifacts.require('ExchangeHelper');
  const ExchangeHelperProxy = artifacts.require('TestERC1967Proxy');
  const Exchange = artifacts.require('Exchange');
  const ExchangeProxy = artifacts.require('ExchangeProxy');
  const RoyaltiesRegistry = artifacts.require('RoyaltiesRegistry');
  const RoyaltiesRegistryProxy = artifacts.require('TestERC1967Proxy');
  const LibOrderTest = artifacts.require('LibOrderTest');
  const WETH9 = artifacts.require('WETH9');
  const TestERC20 = artifacts.require('TestERC20');
  const TestERC721 = artifacts.require('TestERC721');

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

    // Deploy RoyaltiesRegistry contracts
    royaltiesRegistry = await RoyaltiesRegistry.new({ from: deployer });
    royaltiesRegistryProxy = await RoyaltiesRegistryProxy.new(royaltiesRegistry.address, '0x');
    royaltiesRegistryProxyAddress = royaltiesRegistryProxy.address;
    await RoyaltiesRegistry.at(royaltiesRegistryProxyAddress);

    // Deploy ExchangeHelper contracts
    exchange = await Exchange.new();
    exchangeProxyContract = await ExchangeProxy.new(exchange.address, '0x');
    exchangeProxy = await Exchange.at(exchangeProxyContract.address);
    exchangeProxyAddress = exchangeProxyContract.address;

    exchangeHelper = await ExchangeHelper.new();
    exchangeBehindProxy = await Exchange.at(exchangeProxyAddress);
    exchangeHelperProxyContract = await ExchangeHelperProxy.new(exchangeHelper.address, '0x');
    exchangeHelperProxy = await ExchangeHelper.at(exchangeHelperProxyContract.address);
    exchangeHelperProxyAddress = exchangeHelperProxy.address;
    exchangeHelperBehindProxy = await ExchangeHelper.at(exchangeHelperProxyAddress);

    await exchangeHelperProxy.initialize(
      exchangeProxyAddress,
      orderBook,
      owner,
      deployer,
      CHAIN_ID,
      { from: deployer },
    );

    await exchangeHelper.initialize(exchangeProxyAddress, orderBook, owner, deployer, CHAIN_ID, {
      from: deployer,
    });

    await exchange.initialize(
      exchangeProxyAddress,
      exchangeHelperProxyAddress,
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
      exchangeProxyAddress,
      exchangeHelperProxyAddress,
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
  });

  describe('constructors', () => {
    it('variables set by constructors are correct', async () => {
      assert.equal(await exchange.owner(), owner);
      assert.equal(await exchangeBehindProxy.getDefaultFeeReceiver(), defaultFeeReceiver);
      assert.equal(await exchangeBehindProxy.getFeeReceiver(weth.address), defaultFeeReceiver);
      assert.equal(
        (await exchangeBehindProxy.getProtocolFeeBps()).toString(),
        PROTOCOL_FEE.toString(),
      );
    });
  });

  describe('transferOwnership', () => {
    it('owner can transfer ownership', async () => {
      assert.equal(await exchange.owner(), owner);
      tx = await exchange.transferOwnership(other, { from: owner });
      assert.equal(await exchange.owner(), other);
      events = await exchange.getPastEvents('OwnershipTransferred', {
        fromBlock: tx.receipt.blockNumber,
        toBlock: tx.receipt.blockNumber,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'OwnershipTransferred');
      assert.equal(events[0].returnValues.previousOwner, owner);
      assert.equal(events[0].returnValues.newOwner, other);
    });

    it('other can NOT transfer ownership and the correct error message is returned', async () => {
      assert.equal(await exchange.owner(), owner);
      await truffleAssert.reverts(
        exchange.transferOwnership(other, { from: other }),
        `OwnableUnauthorizedAccount("${other}")`,
      );
      assert.equal(await exchange.owner(), owner);
    });
  });

  describe('getOrderKeyHash', () => {
    it('returned orderKeyHash should be the same as when calling the library directly', async () => {
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
        latestTimestamp + 1000, // end
        '0xffffffff', // dataType
        '0x', // data
      );
      // Calculate makerOrder key hash directly from library
      makerOrderKeyHash = await libOrder.hashKey(makerOrder);
      // Check that the keyHash returned by the exchange contract is the same as the one returned from the library
      assert.equal(await exchangeHelperBehindProxy.hashKey(makerOrder), makerOrderKeyHash);
    });
  });

  describe('safeTransferERC20', () => {
    it('direct call to the proxy reverts', async () => {
      await truffleAssert.reverts(
        exchangeProxy.safeTransferERC20(weth.address, other, toBN(100)),
        'ExchangeGovernedProxy: Only calls from implementation are allowed!',
      );
    });
  });

  // NOTE: this needs to be handle later
  // describe('safeTransferERC20From', () => {
  //   it('direct call to the proxy reverts', async () => {
  //     await truffleAssert.reverts(
  //       exchangeProxy.safeTransferERC20From(weth.address, owner, other, toBN(100)),
  //       'ExchangeGovernedProxy: Only calls from implementation are allowed!',
  //     );
  //   });
  // });

  describe('Exchange ERC20 asset transfer function', () => {
    it('safeTransferERC20', async () => {
      // Mint some ERC20 tokens to Exchange contract
      await otherERC20Token.mint(exchange.address, expandToDecimals(1, 18), { from: owner });
      assert.equal(
        (await otherERC20Token.balanceOf(exchange.address)).toString(),
        expandToDecimalsString(1, 18),
      );
      assert.equal((await otherERC20Token.balanceOf(owner)).toString(), '0');
      // Withdraw ERC20 tokens from Exchange contract
      await exchange.safeTransferERC20(otherERC20Token.address, owner, expandToDecimals(1, 18), {
        from: owner,
      });
      assert.equal((await otherERC20Token.balanceOf(exchange.address)).toString(), '0');
      assert.equal(
        (await otherERC20Token.balanceOf(owner)).toString(),
        expandToDecimalsString(1, 18),
      );
    });

    it('safeTransferERC20: other can NOT call', async () => {
      // Mint some ERC20 tokens to Exchange contract
      await otherERC20Token.mint(exchange.address, expandToDecimals(1, 18), { from: owner });
      assert.equal(
        (await otherERC20Token.balanceOf(exchange.address)).toString(),
        expandToDecimalsString(1, 18),
      );
      assert.equal((await otherERC20Token.balanceOf(other)).toString(), '0');
      // Withdraw ERC20 tokens from Exchange contract
      await truffleAssert.reverts(
        exchange.safeTransferERC20(otherERC20Token.address, owner, expandToDecimals(1, 18), {
          from: other,
        }),
        `OwnableUnauthorizedAccount("${other}")`,
      );
      assert.equal(
        (await otherERC20Token.balanceOf(exchange.address)).toString(),
        expandToDecimalsString(1, 18),
      );
      assert.equal((await otherERC20Token.balanceOf(other)).toString(), '0');
    });
  });
});
