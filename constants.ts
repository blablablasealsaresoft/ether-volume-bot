import * as dotenv from 'dotenv';
import { testVersion } from './config';
import { ChainId } from './types';
dotenv.config();

export const retrieveEnvVariable = (variableName: string) => {
  const variable = process.env[variableName] || '';
  if (!variable) {
    console.log(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};

// Load environment variables from .env file
dotenv.config();

export const TARGET_TOKEN_ADDRESS = String(retrieveEnvVariable('TARGET_TOKEN_ADDRESS'));

export const ETH_RPC_ENDPOINT = String(retrieveEnvVariable('ETH_RPC_ENDPOINT'));
export const BSC_RPC_ENDPOINT = String(retrieveEnvVariable('BSC_RPC_ENDPOINT'));
export const ETH_SEPOLIA_RPC_ENDPOINT = String(retrieveEnvVariable('ETH_SEPOLIA_RPC_ENDPOINT'));
export const MEV_BLOCK_RPC_ENDPOINT = String(retrieveEnvVariable('MEV_BLOCK_RPC_ENDPOINT'));

export const BASE_WALLET_ADDRESS = String(retrieveEnvVariable('ETH_BASE_WALLET_ADDRESS'));
export const BASE_WALLET_PRIVATE_KEY = String(retrieveEnvVariable('ETH_BASE_WALLET_PRIVATE_KEY'));

// Constant variables
export const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const WETH_ADDRESS_SEPOLIA = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
export const UNISWAP_ROUTER_V2 = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
export const UNISWAP_ROUTER_V2_SEPOLIA = "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3"
export const UNISWAP_ROUTER_V3 = testVersion ? "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E" : '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45';
export const UNISWAP_FACTORY_V2 = testVersion ? "0xF62c03E08ada871A0bEb309762E260a7a6a880E6" : '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f';
export const UNISWAP_FACTORY_V2_SEPOLIA = "0xF62c03E08ada871A0bEb309762E260a7a6a880E6";
export const UNISWAP_FACTORY_V3 = testVersion ? "0x0227628f3F023bb0B980b67D528571c95c6DaC1c" : '0x1f98431c8ad98523631ae4a59f267346ea31f984';
export const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const PANCAKE_ROUTER_V2 = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
export const PANCAKE_FACTORY_V2 = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";

// Robinhood Chain (Arbitrum Orbit L2, chainId 4663, ETH gas).
// Addresses verified against https://docs.robinhood.com/chain/connecting/ and
// https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments,
// then confirmed live on-chain: router.WETH9() and router.factory() match, and the
// exactInputSingle / multicall / unwrapWETH9 / refundETH selectors exist in bytecode.
export const ROBINHOOD_RPC_ENDPOINT = String(process.env['ROBINHOOD_RPC_ENDPOINT'] || '');
export const UNISWAP_V3_ROUTER_ROBINHOOD = '0xCaf681a66D020601342297493863E78C959E5cb2';
export const WETH_ADDRESS_ROBINHOOD = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
// Pool fee tier (hundredths of a bip) of the token's V3 pool on Robinhood Chain.
// 0 = auto-detect the pool's fee tier from the V3 factory (recommended; Pons V1
// launches use 10000, ordinary pairs use 500/3000).
export const ROBINHOOD_POOL_FEE = Number(process.env['ROBINHOOD_POOL_FEE'] || 0);
// Slippage protection for Robinhood Chain V3 swaps, in basis points
// (1000 = allow up to 10% price movement against the quoted output).
export const ROBINHOOD_SLIPPAGE_BPS = Number(process.env['ROBINHOOD_SLIPPAGE_BPS'] || 1000);
// Uniswap V3 periphery on Robinhood Chain (chain 4663), per the official Uniswap
// deployment list; QuoterV2 is state-mutating but safe to read via eth_call.
export const UNISWAP_V3_QUOTER_ROBINHOOD = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7';
export const UNISWAP_V3_FACTORY_ROBINHOOD = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
// Pons v2 launchpad on Robinhood Chain: pre-graduation tokens trade on a
// per-launch bonding curve, discovered from the factory by token address.
export const PONS_V2_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
// Shared Pons meme hook that owns the graduated pool's fee logic.
export const PONS_MEME_HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
// Uniswap v4 stack on Robinhood Chain (chain 4663), per the official
// deployment list. Graduated Pons pools trade through these. The bot quotes
// v4 swaps by simulating its Universal Router calldata on-chain (binary search
// on amountOutMinimum) instead of using the quoter lens, which on this chain
// is from an older periphery revision.
export const POOL_MANAGER_V4_ROBINHOOD = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const V4_QUOTER_ROBINHOOD = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
export const UNIVERSAL_ROUTER_ROBINHOOD = '0x8876789976decbfcbbbe364623c63652db8c0904';
// Canonical Permit2; Universal Router pulls ERC20 input through it.
export const PERMIT2_ROBINHOOD = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export const CONFIRM_ENDPOINT = testVersion ? ETH_SEPOLIA_RPC_ENDPOINT : MEV_BLOCK_RPC_ENDPOINT;
export const ETH_ENDPOINT = testVersion ? ETH_SEPOLIA_RPC_ENDPOINT : ETH_RPC_ENDPOINT;
export const BSC_ENDPOINT = testVersion ? ETH_SEPOLIA_RPC_ENDPOINT : BSC_RPC_ENDPOINT;

export const routers: Record<ChainId, string> = {
  [ChainId.BSC]: PANCAKE_ROUTER_V2,
  [ChainId.Ethereum]: UNISWAP_ROUTER_V2,
  [ChainId.Sepolia]: UNISWAP_ROUTER_V2_SEPOLIA,
  [ChainId.Robinhood]: UNISWAP_V3_ROUTER_ROBINHOOD,
};

export const WrappedNative: Record<ChainId, string> ={
  [ChainId.BSC]: WBNB_ADDRESS,
  [ChainId.Ethereum]: WETH_ADDRESS,
  [ChainId.Sepolia]: WETH_ADDRESS_SEPOLIA,
  [ChainId.Robinhood]: WETH_ADDRESS_ROBINHOOD,
}

export const RPCs: Record<ChainId, string> = {
  [ChainId.BSC]: BSC_RPC_ENDPOINT,
  [ChainId.Ethereum]: ETH_RPC_ENDPOINT,
  [ChainId.Sepolia]: ETH_SEPOLIA_RPC_ENDPOINT,
  [ChainId.Robinhood]: ROBINHOOD_RPC_ENDPOINT,
}