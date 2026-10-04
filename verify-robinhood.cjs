// Verify Robinhood Chain (4663) router supports the V2-style methods the bot uses.
// Uses ethers from the bot's own node_modules; read-only RPC calls only.
const path = require('path');
const ethers = require(path.join('C:\\', 'Users', 'ckthe', 'ether-volume-bot-main', 'node_modules', 'ethers'));

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const ROUTER = '0xCaf681a66D020601342297493863E78C959E5cb2';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';

const selectors = {
  swapExactETHForTokensSupportingFeeOnTransferTokens: 'swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)',
  swapExactTokensForETHSupportingFeeOnTransferTokens: 'swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
  WETH9: 'WETH9()',
  factory: 'factory()',
};

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const chainId = await provider.send('eth_chainId', []);
  console.log('chainId:', chainId, '(expect 0x1237 = 4663)');

  const code = await provider.send('eth_getCode', [ROUTER, 'latest']);
  console.log('router has bytecode:', code.length > 2, '(' + Math.round(code.length / 2) + ' bytes)');

  for (const [name, sig] of Object.entries(selectors)) {
    const sel = ethers.id(sig).slice(0, 10).slice(2);
    console.log(name.padEnd(52), 'selector', '0x' + sel, 'present:', code.toLowerCase().includes(sel.toLowerCase()));
  }

  const weth9Data = '0x' + ethers.id('WETH9()').slice(2, 10);
  const weth9 = await provider.send('eth_call', [{ to: ROUTER, data: weth9Data }, 'latest']);
  console.log('router.WETH9():', '0x' + weth9.slice(-40), '== expected WETH:', weth9.toLowerCase().endsWith(WETH.slice(2).toLowerCase()));

  const factoryData = '0x' + ethers.id('factory()').slice(2, 10);
  const factory = await provider.send('eth_call', [{ to: ROUTER, data: factoryData }, 'latest']);
  console.log('router.factory():', '0x' + factory.slice(-40), '== expected factory:', factory.toLowerCase().endsWith(FACTORY.slice(2).toLowerCase()));
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });