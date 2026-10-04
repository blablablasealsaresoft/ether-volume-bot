const { ethers } = require('ethers');
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const PONS_V2_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const factory = new ethers.Contract(PONS_V2_FACTORY, [
    'function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
    'function launchEnabled() view returns (bool)',
    'function canLaunch(address who) view returns (bool)',
    'function launchFee() view returns (uint256)',
    'function maxCreatorTaxBps() view returns (uint16)',
  ], provider);
  const info = await factory.getLaunchedToken('0x0000000000000000000000000000000000000001');
  console.log('getLaunchedToken(unknown): exists =', info.exists, '| phase =', String(info.phase), '| pairToken =', info.pairToken);
  console.log('launchEnabled:', await factory.launchEnabled());
  console.log('launchFee:', ethers.formatEther(await factory.launchFee()), 'ETH');
  console.log('maxCreatorTaxBps:', String(await factory.maxCreatorTaxBps()));
  console.log('canLaunch(you):', await factory.canLaunch('0x29a25642E7bd4c11F215f520cD6c1F5dA3ff0294'));
  console.log('ALL-OK: factory ABI matches deployed contract');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });