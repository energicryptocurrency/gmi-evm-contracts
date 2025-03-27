const { Wallet } = require('zksync-ethers');
const { Deployer } = require('@matterlabs/hardhat-zksync');

const ORDER_BOOK = '0x282C86910DC7bc7d5da158a4f01384DCcc0F8C96';
const DEFAULT_FEE_RECEIVER = '0x79F10487a8C0eD4E09045841160d01a7ecB96244';
const OWNER = '0x3C94e4aD6bCAE45E69aA821E700BDB1199460e7c';
const UPDRADE_MANAGER = '0x3C94e4aD6bCAE45E69aA821E700BDB1199460e7c';
const PROTOCOL_FEE_BPS = '100';
const WETH = '0x9EDCde0257F2386Ce177C3a7FCdd97787F0D841d';
const CHAIN_ID = '11124';

async function main() {
  const wallet = new Wallet(process.env.WALLET_PRIVATE_KEY);
  const deployer = new Deployer(hre, wallet);

  const Exchange = await deployer.loadArtifact('Exchange');
  const exchange = await deployer.deploy(Exchange);
  console.log(`Exchange: ${await exchange.getAddress()}`);

  const ExchangeHelper = await deployer.loadArtifact('ExchangeHelper');
  const exchangeHelper = await deployer.deploy(ExchangeHelper);
  console.log(`ExchangeHelper: ${await exchangeHelper.getAddress()}`);

  const RoyaltiesRegistry = await deployer.loadArtifact('RoyaltiesRegistry');
  const royaltiesRegistry = await deployer.deploy(RoyaltiesRegistry);
  console.log(`RoyaltiesRegistry: ${await royaltiesRegistry.getAddress()}`);

  const ExchangeProxy = await deployer.loadArtifact('ExchangeProxy');
  const exchangeProxy = await deployer.deploy(ExchangeProxy, [await exchange.getAddress(), '0x']);
  console.log(`ExchangeProxy: ${await exchangeProxy.getAddress()}`);

  const ExchangeHelperProxy = await deployer.loadArtifact('ExchangeHelperProxy');
  const exchangeHelperProxy = await deployer.deploy(ExchangeHelperProxy, [
    await exchangeHelper.getAddress(),
    '0x',
  ]);
  console.log(`ExchangeHelperProxy: ${await exchangeHelperProxy.getAddress()}`);

  const RoyaltiesRegistryProxy = await deployer.loadArtifact('RoyaltiesRegistryProxy');
  const royaltiesRegistryProxy = await deployer.deploy(RoyaltiesRegistryProxy, [
    await royaltiesRegistry.getAddress(),
    '0x',
  ]);
  console.log(`RoyaltiesRegistryProxy: ${await royaltiesRegistryProxy.getAddress()}`);

  const exchangeProxyContract = await exchange.attach(await exchangeProxy.getAddress());

  const exchangeHelperProxyContract = await exchangeHelper.attach(
    await exchangeHelperProxy.getAddress(),
  );

  const royaltiesRegistryProxyContract = await royaltiesRegistry.attach(
    await royaltiesRegistryProxy.getAddress(),
  );

  await exchangeProxyContract.initialize(
    await exchangeProxy.getAddress(),
    await exchangeHelperProxy.getAddress(),
    ORDER_BOOK,
    DEFAULT_FEE_RECEIVER,
    await royaltiesRegistryProxy.getAddress(),
    WETH,
    OWNER,
    UPDRADE_MANAGER,
    PROTOCOL_FEE_BPS,
    CHAIN_ID,
  );

  await exchangeHelperProxyContract.initialize(
    await exchangeProxy.getAddress(),
    ORDER_BOOK,
    OWNER,
    UPDRADE_MANAGER,
    CHAIN_ID,
  );

  await royaltiesRegistryProxyContract.initialize(OWNER, UPDRADE_MANAGER);

  console.log(`
    Exchange: ${await exchange.getAddress()}
    ExchangeProxy: ${await exchangeProxy.getAddress()}
    Exchange Storage: ${await exchangeProxyContract._storage()}
    Exchange Helper: ${await exchangeHelper.getAddress()}
    Exchange Helper Proxy: ${await exchangeHelperProxy.getAddress()}
    Royalties Registry: ${await royaltiesRegistry.getAddress()}
    Royalties Registry Proxy: ${await royaltiesRegistryProxy.getAddress()}
    Royalties Registry Storage: ${await royaltiesRegistryProxyContract._storage()}
`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
