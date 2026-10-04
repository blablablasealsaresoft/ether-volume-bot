# Volume bot — Robinhood Chain / Pons v2 edition

Fork of [donpushme/ether-volume-bot](https://github.com/donpushme/ether-volume-bot),
heavily extended for **Robinhood Chain** (chainId 4663) and **Pons v2 launchpad** tokens.

## What this fork adds

- **Robinhood Chain support** (Arbitrum Orbit L2, ETH gas)
  - Uniswap **V3** trading via SwapRouter02 with automatic fee-tier detection
    and QuoterV2-backed slippage protection (`ROBINHOOD_SLIPPAGE_BPS`)
  - **Pons v2 launchpad** integration: set `TARGET_TOKEN_ADDRESS` and the bot
    auto-detects how to trade it —
    - **pre-graduation**: per-launch bonding curve (buy/sell with fee, creator
      tax, and decaying snipe tax priced in; buys wait 5s so the snipe tax decays)
    - **post-graduation**: the launch's Uniswap **v4** pool via Universal Router
      (Permit2-pulled sells, native-value buys). Quotes are produced by
      simulating the exact router calldata on-chain with a binary search on
      `amountOutMinimum` — every send is preceded by a passing rehearsal of
      byte-identical calldata
  - Robust funding/sweeping tuned for Orbit chains: explicit EIP-1559 caps
    derived from the live base fee (Orbit ignores priority tips) and a 100k gas
    floor (21k transfers are rejected as "intrinsic gas too low")
- `run-bot.ps1` continuous loop with a fuel guard (stops at a reserve instead of
  grinding the base wallet empty)
- Verification scripts: `verify-quoter.cjs`, `verify-pons.cjs`, `verify-v4.cjs`

## Supported chains

- **Robinhood Chain** (Pons v2 launchpad tokens, Uniswap v3/v4) ← primary
- BSC, Ethereum mainnet (original bot paths)

## Setup

```
npm i
```

Fill in `.env` (copy `.env.example`):

```
TARGET_TOKEN_ADDRESS=0x...      # the token to trade
ETH_BASE_WALLET_ADDRESS=0x...   # funding wallet
ETH_BASE_WALLET_PRIVATE_KEY=... # funding wallet key (never share/commit)
ROBINHOOD_RPC_ENDPOINT=https://rpc.mainnet.chain.robinhood.com
```

`config.ts` knobs:

| knob | meaning |
|---|---|
| `CHAINID` | set `ChainId.Robinhood` for Robinhood Chain |
| `amountMin/amountMax` | per-wallet trade size (ETH) |
| `fee` | ETH kept in each sub-wallet for gas |
| `subWalletNum` | sub-wallets per pass |
| `minInterval/maxInterval` | random buy→sell delay window (ms) |

Budget rule of thumb: fund the base wallet with roughly
`(amountMax + fee) * subWalletNum * 1.5` — leftovers are swept back to the base
wallet after every round.

## Running

```
node verify-pons.cjs        # optional: check the launch record on-chain
npm run dev                 # one pass over the sub-wallets
```

Continuous volume:

```
powershell -ExecutionPolicy Bypass -File run-bot.ps1
```

The loop re-runs passes until the base wallet hits the reserve, then stops.

## Routing logic (Robinhood Chain)

1. Is `TARGET_TOKEN_ADDRESS` a Pons v2 launch? (factory lookup)
   - on-curve → bonding-curve buy/sell
   - graduated → Uniswap v4 pool via Universal Router
2. Otherwise → Uniswap V3 (`exactInputSingle`, fee tier auto-detected, quote-backed slippage floor)

## Notes

- ETH-paired Pons launches only.
- The bot wallet is just another trader — launch your token from a separate
  creator wallet; the bot never needs the creator key.
- `.env` and `wallets/*.json` hold keys — gitignored, never commit them.