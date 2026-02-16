# Deploy Phantom Protocol to Render (from Relayer repo)

Deploy the relayer API and validator coordinator from the **public Relayer repo** — no credit card required.

## 1. Add circuit files (required for proof generation)

The backend needs ZK circuit artifacts. Copy these from your core repo:

```
circuits/joinsplit_js/joinsplit.wasm
circuits/joinsplit_0001.zkey
circuits/portfolio_note_js/portfolio_note.wasm
circuits/portfolio_note_0001.zkey
```

Place them in the `circuits/` folder and commit. Or set env vars on Render:

- `PROVER_WASM` — path or URL to joinsplit.wasm
- `PROVER_ZKEY` — path or URL to joinsplit_0001.zkey
- `PORTFOLIO_WASM`, `PORTFOLIO_ZKEY` — for portfolio proofs

For testing without proofs: `DEV_BYPASS_PROOFS=true`

## 2. Connect to Render

1. Go to [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**
2. Connect **Phanton-Protocol/Relayer** (this repo)
3. Branch: `main`
4. Blueprint path: `render.yaml`
5. Click **Apply**

Render creates:

- **phantom-protocol** — Relayer API
- **phantom-validator-coordinator** — WebSocket coordinator for browser validators

## 3. Set environment variables

In Render → **phantom-protocol** → **Environment**:

| Variable | Required | Description |
|----------|----------|-------------|
| `RPC_URL` | Yes | BSC RPC (e.g. `https://data-seed-prebsc-1-s1.binance.org:8545`) |
| `RELAYER_PRIVATE_KEY` | Yes | Relayer wallet private key |
| `SHIELDED_POOL_ADDRESS` | Yes | ShieldedPool contract |
| `NOTE_STORAGE_ADDRESS` | Yes | NoteStorage contract |
| `SWAP_ADAPTOR_ADDRESS` | Yes | SwapAdaptor contract |
| `RELAYER_STAKING_ADDRESS` | Yes | `0x3c8c698335A4942A52a709091a441f27FF2a5bc8` (or your deployment) |
| `CHAIN_ID` | No | Default 97 (BSC testnet) |
| `VALIDATOR_URLS` | No | `https://phantom-validator-coordinator.onrender.com` for browser validators |

## 4. Dashboard

Deploy the dashboard to Vercel (already set up). Use:

```
https://relayer-phi.vercel.app/?api=https://phantom-protocol.onrender.com
```

Replace with your Render URL after deploy.
