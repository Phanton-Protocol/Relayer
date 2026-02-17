# Deploy Phantom Protocol (no credit card)

Deploy the relayer API from the **public Relayer repo**. Use **Vercel** — free tier, **no credit card required**.

---

## Option A: Vercel (recommended — no card)

Dashboard + API in one deployment:

1. Go to [vercel.com](https://vercel.com) → Sign up with GitHub (no card)
2. **Add New** → **Project** → Import **Phanton-Protocol/Relayer**
3. **Environment variables** (Settings → Environment Variables):
   - `VITE_API_URL` = `/api` (so dashboard uses same-origin API)
   - `RPC_URL`, `RELAYER_PRIVATE_KEY`, `SHIELDED_POOL_ADDRESS`, `NOTE_STORAGE_ADDRESS`, `SWAP_ADAPTOR_ADDRESS`, `RELAYER_STAKING_ADDRESS`
4. Click **Deploy**

Your app: `https://YOUR-PROJECT.vercel.app` — dashboard at `/`, API at `/api`. Share: `https://YOUR-PROJECT.vercel.app` (API is built-in).

---

## Option B: Koyeb (Docker, may require card)

1. Go to [app.koyeb.com](https://app.koyeb.com) → Sign up with GitHub (no card)
2. **Create Web Service** → Choose **GitHub**
3. Select **Phanton-Protocol/Relayer**, branch `main`
4. **Builder**: Choose **Dockerfile** (Koyeb will use the repo's Dockerfile)
5. **Instance**: Pick the free tier (e.g. Nano / 0.25 vCPU)
6. Add **Environment variables** (see table below)
7. Click **Deploy**
8. Your API URL: `https://YOUR-SERVICE-NAME.koyeb.app`

---

## Option B: Render (may require card)

1. [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**
2. Connect **Phanton-Protocol/Relayer**, path `render.yaml`
3. Add env vars in Dashboard

---

## 1. Circuit files (required for proof generation)

The backend needs ZK circuit artifacts. Copy these from your core repo:

```
circuits/joinsplit_js/joinsplit.wasm
circuits/joinsplit_0001.zkey
circuits/portfolio_note_js/portfolio_note.wasm
circuits/portfolio_note_0001.zkey
```

Place them in the `circuits/` folder and commit. Or set env vars: `PROVER_WASM`, `PROVER_ZKEY`, etc. For testing: `DEV_BYPASS_PROOFS=true`

## 2. Environment variables

Add these in Koyeb (or Render) → Service → Environment:

| Variable | Required | Description |
|----------|----------|-------------|
| `RPC_URL` | Yes | BSC RPC (e.g. `https://data-seed-prebsc-1-s1.binance.org:8545`) |
| `RELAYER_PRIVATE_KEY` | Yes | Relayer wallet private key |
| `SHIELDED_POOL_ADDRESS` | Yes | ShieldedPool contract |
| `NOTE_STORAGE_ADDRESS` | Yes | NoteStorage contract |
| `SWAP_ADAPTOR_ADDRESS` | Yes | SwapAdaptor contract |
| `RELAYER_STAKING_ADDRESS` | Yes | `0x3c8c698335A4942A52a709091a441f27FF2a5bc8` (or your deployment) |
| `CHAIN_ID` | No | Default 97 (BSC testnet) |
| `VALIDATOR_URLS` | No | For browser validators (coordinator URL if deployed) |

## 3. Dashboard

Dashboard is on Vercel. Use your API URL:

```
https://relayer-phi.vercel.app/?api=https://YOUR-APP.koyeb.app
```
