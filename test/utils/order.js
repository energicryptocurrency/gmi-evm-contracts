function AssetType(assetClass, data) {
  return { assetClass, data };
}

function Asset(assetClass, assetData, value) {
  return { assetType: AssetType(assetClass, assetData), value };
}

function Order(
  maker,
  makeAsset,
  taker,
  takeAsset,
  salt,
  start,
  end,
  dataType,
  data,
  collectionBid = false,
) {
  return { maker, makeAsset, taker, takeAsset, salt, start, end, dataType, data, collectionBid };
}

function MatchAllowance(orderKeyHash, matchBeforeTimestamp) {
  return { orderKeyHash, matchBeforeTimestamp };
}

function encodeTokenData(token, tokenId) {
  if (tokenId) {
    return web3.eth.abi.encodeParameters(['address', 'uint256'], [token, tokenId]);
  } else {
    return web3.eth.abi.encodeParameter('address', token);
  }
}
function encodeOrderData(data) {
  // function encodeOrderData(data, wrongEncode = false) {
  // See: https://github.com/rarible/ethereum-sdk/blob/master/packages/sdk/src/order/encode-data.ts

  switch (data.dataType) {
    // RARIBLE_V2_DATA_V2 dataType not used here
    // case 'RARIBLE_V2_DATA_V2': {
    //   const encoded = ethereum.encodeParameter(DATA_V2_TYPE, {
    //     payouts: data.payouts,
    //     originFees: data.originFees,
    //     isMakeFill: data.isMakeFill
    //   })
    //   return ['0x23d235ef', encoded]
    // }
    case 'RARIBLE_V2_DATA_V1': {
      // In order to optimize memory allocation we reduced the standard's original
      // declaration of uint96 to uint16 as we use base points for royalties, payouts, and origin fees.
      // The decoding happens in `LibOrderDataV1.sol`, which leads to `LibOrderDataV1Types.sol`
      // where payouts and originFees use the `LibPartTypes.Part` struct which is shared with royalties.
      const encoded = web3.eth.abi.encodeParameters(DATA_V1_TYPE, [
        {
          payouts: data.payouts,
          originFees: data.originFees,
        },
      ]);
      // if (wrongEncode) {
      //      In case there are encoding issues
      //      `wrongEncode` can be set to `true` to remove the first 66 digits
      //      from `encoded` and concat it with a `0x` prefix
      //      return ['0x4c234266', `0x${encoded.substring(66)}`];
      // }

      // Use the following lines if needed to check decoded data
      // const decodedData = web3.eth.abi.decodeParameters(DATA_V1_TYPE, encoded);
      // console.log(decodedData.data[0], 'payouts')
      // console.log(decodedData.data[1], 'originFees')
      return ['0x4c234266', encoded];
    }
    default: {
      throw new Error(`Data type not supported: ${data.dataType}`);
    }
  }
}

const DATA_V1_TYPE = [
  {
    components: [
      {
        components: [
          {
            name: 'account',
            type: 'address',
          },
          {
            name: 'value',
            type: 'uint16',
          },
        ],
        name: 'payouts',
        type: 'tuple[]',
      },
      {
        components: [
          {
            name: 'account',
            type: 'address',
          },
          {
            name: 'value',
            type: 'uint16',
          },
        ],
        name: 'originFees',
        type: 'tuple[]',
      },
    ],
    name: 'data',
    type: 'tuple',
  },
];

// RARIBLE_V2_DATA_V2 dataType not used here
// const DATA_V2_TYPE = [
//   {
//     components: [
//       {
//         components: [
//           {
//             name: 'account',
//             type: 'address'
//           },
//           {
//             name: 'value',
//             type: 'uint16'
//           }
//         ],
//         name: 'payouts',
//         type: 'tuple[]'
//       },
//       {
//         components: [
//           {
//             name: 'account',
//             type: 'address'
//           },
//           {
//             name: 'value',
//             type: 'uint16'
//           }
//         ],
//         name: 'originFees',
//         type: 'tuple[]'
//       },
//       {
//         name: 'isMakeFill',
//         type: 'bool'
//       }
//     ],
//     name: 'data',
//     type: 'tuple'
//   }
// ]

module.exports = {
  AssetType,
  Asset,
  Order,
  MatchAllowance,
  encodeTokenData,
  encodeOrderData,
  DATA_V1_TYPE,
};
