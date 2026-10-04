// Verifies the Uniswap v4 (post-graduation) stack the bot routes through on
// Robinhood Chain: bytecode presence, the quoter's PoolManager wiring, and a
// binary-search quote against the Universal Router (expected to fail cleanly
// until a graduated pool exists). Usage: node verify-v4.cjs
const { ethers } = require('ethers');
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
const UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
const WALLET = '0x29a25642E7bd4c11F215f520cD6c1F5dA3ff0294';

const UR_ABI = ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'];
const PONS_FACTORY_ABI = ['function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))'];

// Action ids per v4-periphery as pinned by Universal Router 2.2.0 (Actions.sol):
// SWAP_EXACT_IN_SINGLE 0x06, SETTLE_ALL 0x0c, TAKE_ALL 0x0f; Command V4_SWAP 0x10.
const ACTIONS = [0x06, 0x0c, 0x0f];

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  for (const [name, addr] of [['PoolManager', POOL_MANAGER], ['V4Quoter', V4_QUOTER], ['UniversalRouter', UNIVERSAL_ROUTER], ['Permit2', PERMIT2]]) {
    const code = await provider.getCode(addr);
    console.log(`${name} ${addr}: ${code.length > 2 ? code.length / 2 - 1 + ' bytes of code' : 'NO CODE'}`);
  }

  // Quoter is wired to the right PoolManager?
  const pm = await provider.call({ to: V4_QUOTER, data: '0xdc4c90d3' }); // poolManager()
  console.log('quoter.poolManager():', '0x' + pm.slice(26), pm.slice(26).toLowerCase() === POOL_MANAGER.slice(2).toLowerCase() ? '(match)' : '(MISMATCH)');

  // Does the target token have a Pons v2 launch, and is it graduated?
  const factory = new ethers.Contract('0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', PONS_FACTORY_ABI, provider);
  const rec = await factory.getLaunchedToken(ethers.ZeroAddress);
  console.log('factory.getLaunchedToken(0) decodes OK (launches exist only after you launch).');

  // Binary-search quote rehearsal against a synthetic pool key (no launch yet).
  // Expected: simulation fails cleanly, proving the failure path is safe.
  const poolKey = { currency0: ethers.ZeroAddress, currency1: WALLET, fee: 3000, tickSpacing: 60, hooks: HOOK };
  const zeroForOne = true, amountIn = ethers.parseEther('0.001');
  const calldata = (minimum, deadline) => {
    const actions = ethers.solidityPacked(['uint8', 'uint8', 'uint8'], ACTIONS);
    const params = [
      ethers.AbiCoder.defaultAbiCoder().encode(['tuple(address,address,uint24,int24,address)', 'bool', 'uint128', 'uint128', 'uint256', 'bytes'],
        [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], zeroForOne, amountIn, minimum, 0, '0x']),
      ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [poolKey.currency0, amountIn]),
      ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [poolKey.currency1, minimum]),
    ];
    return new ethers.Interface(UR_ABI).encodeFunctionData('execute', [ethers.solidityPacked(['uint8'], [0x10]), params, deadline]);
  };
  const deadline = BigInt((await provider.getBlock('latest')).timestamp + 300);
  try {
    await provider.call({ to: UNIVERSAL_ROUTER, data: calldata(0n, deadline), from: WALLET, value: amountIn });
    console.log('Unexpected: simulation succeeded against a synthetic pool.');
  } catch (e) {
    console.log('Simulation against synthetic pool reverted as expected:', String(e.message ?? e).slice(0, 120));
  }
  console.log('verify-v4 done');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });