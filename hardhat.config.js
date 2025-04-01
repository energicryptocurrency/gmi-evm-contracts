const { url } = require('inspector');
const path = require('path');

require('@nomicfoundation/hardhat-toolbox');
require('@nomiclabs/hardhat-truffle5');
require('dotenv').config();
require('@nomicfoundation/hardhat-chai-matchers');
require('@openzeppelin/hardhat-upgrades');
require('@matterlabs/hardhat-zksync-deploy');
require('@matterlabs/hardhat-zksync-solc');

task('compile:one', 'Compiles a single Solidity file')
  .addParam('file', 'The Solidity file to compile (e.g., MySingleContract.sol)')
  .setAction(async (taskArgs, hre) => {
    const path = require('path');
    const fullPath = path.join(hre.config.paths.sources, taskArgs.file);

    // Temporarily set the source path to the specified file
    hre.config.paths.sources = path.dirname(fullPath);

    // Compile only the specified file
    await hre.run('compile', {
      quiet: true,
    });

    console.log(`Compiled ${taskArgs.file} successfully.`);
  });

module.exports = {
  zksolc: {
    version: '1.5.7', // Explicitly specified at https://docs.abs.xyz/build-on-abstract/smart-contracts/hardhat
    settings: {
      enableEraVMExtensions: true,
    },
  },
  solidity: {
    compilers: [
      {
        version: '0.8.27',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: 'istanbul',
        },
      },
    ],
  },
  networks: {
    development: {
      url: 'http://127.0.0.1:8545',
      gas: 12000000, // Increase the gas limit
      blockGasLimit: 12000000, // Block-wide gas limit
    },
    sepolia: {
      url: `https://sepolia.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
      accounts: [process.env.WALLET_PRIVATE_KEY],
    },
    mainnet: {
      url: `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
      accounts: [process.env.WALLET_PRIVATE_KEY],
    },
    abstractTestnet: {
      chainId: 11124,
      url: 'https://api.testnet.abs.xyz',
      ethNetwork: `https://sepolia.infura.io/v3/${process.env.INFURA_PROJECT_ID}`,
      zksync: true,
      accounts: [process.env.WALLET_PRIVATE_KEY],
    },
    berachainArtio: {
      chainId: 80084,
      url: 'https://bartio.rpc.berachain.com/',
      accounts: [process.env.WALLET_PRIVATE_KEY],
    },
    apechainTestnet: {
      chainId: 33111,
      url: 'https://curtis.rpc.caldera.xyz/http',
      accounts: [process.env.WALLET_PRIVATE_KEY],
    },
    monadTestnet: {
      chainId: 10143,
      url: 'https://testnet-rpc.monad.xyz',
      accounts: [process.env.WALLET_PRIVATE_KEY],
    },
    skaleNebulaTestnet: {
      weth: '0x0000000000000000000000000000000000000000',
      chainId: 37084624,
      url: 'https://testnet.skalenodes.com/v1/lanky-ill-funny-testnet',
      accounts: [process.env.WALLET_PRIVATE_KEY],
    },
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY,
      sepolia: process.env.ETHERSCAN_API_KEY,
      berachainArtio: 'berachainArtio',
    },
  },
  customChains: [
    {
      network: 'abstractTestnet',
      chainId: 11124,
      urls: {
        apiURL: 'https://api-sepolia.abscan.org/api',
        browserURL: 'https://sepolia.abscan.org/',
      },
    },
    {
      network: 'berachainArtio',
      chainId: 80084,
      urls: {
        apiURL: 'https://api.routescan.io/v2/network/testnet/evm/80084/etherscan',
        browserURL: 'https://artio.beratrail.io',
      },
    },
    {
      network: 'apechainTestnet',
      chainId: 33111,
      urls: {
        apiURL: 'https://curtis.explorer.caldera.xyz/api',
        browserURL: 'https://curtis.explorer.caldera.xyz/',
      },
    },
    {
      network: 'monadTestnet',
      chainId: 10143,
      urls: {
        apiURL: 'https://testnet-rpc.monad.xyz',
        browserURL: 'https://monad-testnet.socialscan.io/',
      },
    },
    {
      network: 'skaleNebulaTestnet',
      chainId: 37084624,
      urls: {
        apiURL: 'https://lanky-ill-funny-testnet.explorer.testnet.skalenodes.com/api',
        browserURL: 'https://lanky-ill-funny-testnet.explorer.testnet.skalenodes.com',
      },
    },
  ],
  mocha: {
    useColors: true,
  },
};
