const { ethers } = require('ethers');
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
const QUOTER = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const factory = new ethers.Contract(FACTORY, [
    'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
    'function getPool(address,address,uint24) view returns (address)'
  ], provider);
  const current = await provider.getBlockNumber();
  const logs = await factory.queryFilter(factory.filters.PoolCreated(), Math.max(0, current - 500000), current);
  console.log('Pools created (last ~500k blocks):', logs.length);
  const tokens = new Set();
  for (const log of logs.slice(-20)) {
    const { token0, token1, fee, pool } = log.args;
    if (token0.toLowerCase() === WETH.toLowerCase()) tokens.add(token1);
    if (token1.toLowerCase() === WETH.toLowerCase()) tokens.add(token0);
    console.log(`pool ${pool} fee ${fee} ${token0}/${token1} block ${log.blockNumber}`);
  }
  if (tokens.size === 0) { console.log('NO-WETH-POOLS'); return; }
  // Quote one real pool through QuoterV2 with named-struct ABI (same pattern as the bot)
  const sample = [...tokens][0];
  const tier = logs.find(l => l.args.token0.toLowerCase() === sample.toLowerCase() || l.args.token1.toLowerCase() === sample.toLowerCase()).args.fee;
  const quoter = new ethers.Contract(QUOTER, ['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'], provider);
  const [out] = await quoter.quoteExactInputSingle.staticCall({ tokenIn: WETH, tokenOut: sample, amountIn: ethers.parseEther('0.0001'), fee: tier, sqrtPriceLimitX96: 0n });
  console.log(`QuoterV2 quote 0.0001 ETH -> ${sample} (fee ${tier}):`, out.toString());
  console.log('ALL-OK');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });