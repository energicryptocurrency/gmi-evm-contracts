const web3 = require('web3');

function hashKey(str) {
  return web3.utils.keccak256(str).substring(0, 10);
}

const ETH = hashKey('ETH');
const WETH = hashKey('WETH');
const PROXY_WETH = hashKey('PROXY_WETH');
const ERC20 = hashKey('ERC20');
const ERC721 = hashKey('ERC721');
const ERC1155 = hashKey('ERC1155');
const ORDER_DATA_V1 = hashKey('V1');
const TO_MAKER = hashKey('TO_MAKER');
const TO_TAKER = hashKey('TO_TAKER');
const PROTOCOL = hashKey('PROTOCOL');
const ROYALTY = hashKey('ROYALTY');
const ORIGIN = hashKey('ORIGIN');
const PAYOUT = hashKey('PAYOUT');
const INTERFACE_ID_ERC2981 = hashKey('royaltyInfo(uint256,uint256)');
const CREATOR = hashKey('CREATOR');
const OWNER = hashKey('OWNER');

module.exports = {
  hashKey,
  ETH,
  WETH,
  PROXY_WETH,
  ERC20,
  ERC721,
  ERC1155,
  ORDER_DATA_V1,
  TO_MAKER,
  TO_TAKER,
  PROTOCOL,
  ROYALTY,
  ORIGIN,
  PAYOUT,
  INTERFACE_ID_ERC2981,
  CREATOR,
  OWNER,
};
