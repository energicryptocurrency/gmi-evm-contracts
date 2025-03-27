const { toBN } = web3.utils;
const truffleAssert = require('truffle-assertions');

const { assert } = require('chai');

const PROTOCOL_FEE = toBN(100); // 1% protocol fee in bps (1 bps = 0.01%)
const CHAIN_ID = toBN(1);

let ERC1155Token,
  exchangeHelperProxy,
  exchangeHelperProxyAddress,
  exchangeProxy,
  exchangeProxyAddress,
  royalties,
  royaltiesRegistryProxy,
  royaltiesRegistryProxyAddress,
  weth;

contract(
  'Exchange - Functional Tests Part 11',
  ([deployer, owner, other, ownerToken, defaultFeeReceiver, royaltiesRecipient, orderBook]) => {
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

    describe('Upgrade ExchangeHelper', () => {
      it('Should upgrade exchange helper contract', async () => {
        const newExchangeHelper = await ExchangeHelper.new();

        await exchangeHelperProxy.upgradeToAndCall(newExchangeHelper.address, '0x', {
          from: deployer,
        });
      });
      it('Variables should not change after upgrade', async () => {
        const newExchangeHelper = await ExchangeHelper.new();

        await exchangeHelperProxy.upgradeToAndCall(newExchangeHelper.address, '0x', {
          from: deployer,
        });

        assert.equal(owner, await exchangeHelperProxy.owner());
      });
      it('Should not upgrade if not called by upgrade manager', async () => {
        const newExchangeHelper = await ExchangeHelper.new();

        await truffleAssert.reverts(
          exchangeHelperProxy.upgradeToAndCall(newExchangeHelper.address, '0x', {
            from: other,
          }),
          'UpgradeManager: Sender is not upgrade manager',
        );
      });
      it('Should change upgrade manager by owner', async () => {
        await exchangeHelperProxy.setUpgradeManager(other, { from: owner });

        assert.equal(await exchangeHelperProxy.upgradeManager(), other);
      });
    });
  },
);
