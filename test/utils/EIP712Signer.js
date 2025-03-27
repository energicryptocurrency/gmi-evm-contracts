const sigUtil = require('eth-sig-util');

module.exports = {
  signOrderData: (web3, signer, order, verifyingContractAddress, chainId) => {
    return new Promise(async (resolve, reject) => {
      if (!chainId) {
        chainId = Number(await web3.eth.getChainId());
      }
      const msgParams = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          AssetType: [
            { name: 'assetClass', type: 'bytes4' },
            { name: 'data', type: 'bytes' },
          ],
          Asset: [
            { name: 'assetType', type: 'AssetType' },
            { name: 'value', type: 'uint256' },
          ],
          Order: [
            { name: 'maker', type: 'address' },
            { name: 'makeAsset', type: 'Asset' },
            { name: 'taker', type: 'address' },
            { name: 'takeAsset', type: 'Asset' },
            { name: 'salt', type: 'uint256' },
            { name: 'start', type: 'uint256' },
            { name: 'end', type: 'uint256' },
            { name: 'dataType', type: 'bytes4' },
            { name: 'data', type: 'bytes' },
            { name: 'collectionBid', type: 'bool' },
          ],
        },
        primaryType: 'Order',
        domain: {
          name: 'Energi',
          version: '1',
          chainId: chainId,
          verifyingContract: verifyingContractAddress,
        },
        message: order,
      };

      let from = signer;
      let params = [from, msgParams];
      let method = 'eth_signTypedData_v4';
      return web3.currentProvider.send(
        {
          method,
          params,
        },
        async function (err, result) {
          if (err) {
            resolve(console.error(err));
          }
          if (result.error) {
            reject(console.error('ERROR', result.error.message));
          }
          const recovered = sigUtil.recoverTypedSignature_v4({
            data: msgParams,
            sig: result.result,
          });
          if (!(web3.utils.toChecksumAddress(recovered) === from)) {
            console.log('Failed to verify signer when comparing ' + result + ' to ' + from);
          }

          /*
                    getting r s v from a signature
                    const signature = result.result.substring(2);
                    const r = '0x' + signature.substring(0, 64);
                    const s = '0x' + signature.substring(64, 128);
                    const v = parseInt(signature.substring(128, 130), 16);
                    console.log('r:', r);
                    console.log('s:', s);
                    console.log('v:', v);
                    */

          resolve(result.result);
        },
      );
    });
  },

  signMatchAllowance: (web3, signer, matchAllowance, verifyingContractAddress, chainId) => {
    return new Promise(async (resolve, reject) => {
      if (!chainId) {
        chainId = Number(await web3.eth.getChainId());
      }
      const msgParams = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          MatchAllowance: [
            { name: 'orderKeyHash', type: 'bytes32' },
            { name: 'matchBeforeTimestamp', type: 'uint256' },
          ],
        },
        primaryType: 'MatchAllowance',
        domain: {
          name: 'Energi',
          version: '1',
          chainId: chainId,
          verifyingContract: verifyingContractAddress,
        },
        message: matchAllowance,
      };

      let from = signer;
      let params = [from, msgParams];
      let method = 'eth_signTypedData_v4';
      return web3.currentProvider.send(
        {
          method,
          params,
        },
        async function (err, result) {
          if (err) {
            resolve(console.error(err));
          }
          if (result.error) {
            reject(console.error('ERROR', result.error.message));
          }
          const recovered = sigUtil.recoverTypedSignature_v4({
            data: msgParams,
            sig: result.result,
          });

          if (!(web3.utils.toChecksumAddress(recovered) === from)) {
            console.log('Failed to verify signer when comparing ' + result + ' to ' + from);
          }

          /*
                    getting r s v from a signature
                    const signature = result.result.substring(2);
                    const r = '0x' + signature.substring(0, 64);
                    const s = '0x' + signature.substring(64, 128);
                    const v = parseInt(signature.substring(128, 130), 16);
                    console.log('r:', r);
                    console.log('s:', s);
                    console.log('v:', v);
                    */

          resolve(result.result);
        },
      );
    });
  },
};
