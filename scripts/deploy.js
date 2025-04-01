const { ethers, network } = require('hardhat');

// Mainnet
// const ORDER_BOOK = '0x697d5eA4c9ae01Ebda46230f81424091485A6f68';
// const DEFAULT_FEE_RECEIVER = '0x3C94e4aD6bCAE45E69aA821E700BDB1199460e7c';
// const OWNER = '0x3C94e4aD6bCAE45E69aA821E700BDB1199460e7c';
// const UPDRADE_MANAGER = '0x4c1DE5D424fC5666837DE3281dae6689cd4f5D88';
// const PROTOCOL_FEE_BPS = '100';
// const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
// const CHAIN_ID = '1';

// TESTNET
const ORDER_BOOK = '0x282C86910DC7bc7d5da158a4f01384DCcc0F8C96';
const DEFAULT_FEE_RECEIVER = '0x79F10487a8C0eD4E09045841160d01a7ecB96244';
const OWNER = '0x3C94e4aD6bCAE45E69aA821E700BDB1199460e7c';
const UPDRADE_MANAGER = '0x3C94e4aD6bCAE45E69aA821E700BDB1199460e7c';
const PROTOCOL_FEE_BPS = '0';
const WETH = '0x0000000000000000000000000000000000000000';
const CHAIN_ID = '37084624';

async function main() {
  const exchange = await ethers.deployContract('Exchange', []);
  await exchange.waitForDeployment();
  console.log(`Exchange: ${await exchange.getAddress()}`);

  const exchangeHelper = await ethers.deployContract('ExchangeHelper', []);
  await exchangeHelper.waitForDeployment();
  console.log(`ExchangeHelper: ${await exchangeHelper.getAddress()}`);

  const royaltiesRegistry = await ethers.deployContract('RoyaltiesRegistry', []);
  await royaltiesRegistry.waitForDeployment();
  console.log(`RoyaltiesRegistry: ${await royaltiesRegistry.getAddress()}`);

  const exchangeProxy = await ethers.deployContract('ExchangeProxy', [
    await exchange.getAddress(),
    '0x',
  ]);
  await exchangeProxy.waitForDeployment();
  console.log(`ExchangeProxy: ${await exchangeProxy.getAddress()}`);

  const exchangeHelperProxy = await ethers.deployContract('ExchangeHelperProxy', [
    await exchangeHelper.getAddress(),
    '0x',
  ]);
  await exchangeHelperProxy.waitForDeployment();
  console.log(`ExchangeHelperProxy: ${await exchangeHelperProxy.getAddress()}`);

  const royaltiesRegistryProxy = await ethers.deployContract('RoyaltiesRegistryProxy', [
    await royaltiesRegistry.getAddress(),
    '0x',
  ]);
  await royaltiesRegistryProxy.waitForDeployment();
  console.log(`RoyaltiesRegistryProxy: ${await royaltiesRegistryProxy.getAddress()}`);

  const exchangeProxyContract = await ethers.getContractAt(
    'Exchange',
    await exchangeProxy.getAddress(),
  );

  const exchangeHelperProxyContract = await ethers.getContractAt(
    'ExchangeHelper',
    await exchangeHelperProxy.getAddress(),
  );

  const royaltiesRegistryProxyContract = await ethers.getContractAt(
    'RoyaltiesRegistry',
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
  console.log('Initialized ExchangeProxy');

  await exchangeHelperProxyContract.initialize(
    await exchangeProxy.getAddress(),
    ORDER_BOOK,
    OWNER,
    UPDRADE_MANAGER,
    CHAIN_ID,
  );
  console.log('Initialized ExchangeHelperProxy');

  await royaltiesRegistryProxyContract.initialize(OWNER, UPDRADE_MANAGER);
  console.log('Initialized RoyaltiesRegistryProxy');

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
