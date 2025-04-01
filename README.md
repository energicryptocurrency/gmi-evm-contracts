# GMI EVM contracts

This repo have all the contracts related to GMI EVM contract, this contracts can be deployed on any EVM chain

## Project Status

GMI EVM contract repo is active and is maintained by Energi Core LTD

## Authors and acknowledgment

- [@leon](https://github.com/LeonDolinar)
- [@haidar](https://github.com/haidaralimasu)

## Quickstart

**Requirements**

- node v22.11.0
- yarn v1.22+

**Clone the repo**

```sh
git clone https://github.com/energicryptocurrency/gmi-evm-contracts.git
```

**Install all dependencies**

```sh
yarn
```

**Setup enviorment variables in** `.env`

```sh
INFURA_PROJECT_ID='INFURA_API_KEY'
WALLET_PRIVATE_KEY='YOUR_PRIVATE_KEY'
ETHERSCAN_API_KEY='YOUR_ETHERSCAN_API_KEY'
```

**Run test cases**

```sh
npx hardhat test
```

**Format code**

```sh
yarn lint
```

**Deploy contracts**

```sh
npx hardhat run scripts/deploy.js --network <network-name>
```

## License

GMI Ethereum contracts repo is available under the GNU license. See the [LICENSE](LICENSE) file for more info.
