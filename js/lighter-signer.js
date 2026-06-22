window.__lighterSignerReady = false;
window.__lighterSignerClient = null;
window.__lighterSignerError = null;

if(typeof window.process === 'undefined'){
  window.process = { env: {} };
}

import { SignerClient, GroupingType } from './lighter-ts-sdk.browser.js';

async function buildLighterSigner(){
  const privateKey = localStorage.getItem('lighterPrivateKey');
  if(!privateKey) throw new Error('no Lighter private key stored in localStorage (key: lighterPrivateKey)');

  const signer = new SignerClient({
    url: 'https://mainnet.zklighter.elliot.ai',
    privateKey,
    accountIndex: 21229,
    apiKeyIndex: 5,
    wasmConfig: { wasmPath: 'wasm/lighter-signer.wasm', wasmExecPath: 'wasm/wasm_exec.js' }
  });

  await signer.initialize();
  await signer.ensureWasmClient();
  return signer;
}

window.__getLighterSigner = async function(){
  if(window.__lighterSignerClient) return window.__lighterSignerClient;
  const signer = await buildLighterSigner();
  window.__lighterSignerClient = signer;
  window.__lighterSignerReady = true;
  return signer;
};

window.__LighterGroupingType = GroupingType;
