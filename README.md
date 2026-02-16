# Phantom Relayer Dashboard

Operator dashboard for Phantom Protocol — stake, monitor relayer status, validator setup.

## Deploy to Vercel

1. Go to **https://vercel.com** → Sign in with GitHub
2. **Add New** → **Project**
3. Import `Phanton-Protocol/Relayer`
4. **Environment Variable** (required): `VITE_API_URL` = your relayer URL (e.g. `https://phantom-relayer.onrender.com`)
5. Click **Deploy**

## Share with others

Add the API URL to the link so it works for everyone:

```
https://relayer-phi.vercel.app/?api=https://YOUR-RELAYER-URL.com
```

Replace `YOUR-RELAYER-URL.com` with your relayer backend (e.g. `https://phantom-protocol.onrender.com`). Share this link — the API is pre-configured.

## Fix "Staking API error: HTTP 500"

Add this to your **Render** backend environment:

```
RELAYER_STAKING_ADDRESS=0x3c8c698335A4942A52a709091a441f27FF2a5bc8
```

Then redeploy. Use the RelayerStaking address that matches your deployment (see `frontend/config.json` → `relayerStaking`).

## Fix "Failed to fetch"

1. **Use the `?api=` link** when sharing (see above)
2. **Or set VITE_API_URL** in Vercel: Project → Settings → Environment Variables → Add `VITE_API_URL` = your relayer URL, then redeploy
3. **Relayer must use HTTPS** — `http://` is blocked by browsers
4. **Relayer must be running** — Render free tier sleeps after 15 min; first request may be slow

## Sign Proofs (Browser)

Stakers can validate by signing in their wallet — no server to run:

1. **Stake** ≥ 1000 SHDW (Relayer tab)
2. **Connect** wallet
3. **Validators** tab → "Join as validator"
4. When a transaction needs validation, click **Sign** in MetaMask

Keep the tab open when you want to validate. Deploy coordinator to Render for 24/7.

## Deploy to Render (API + Coordinator)

Deploy from this **Relayer repo** — no credit card required (public repo):

1. **Add circuit files** — Copy from core: `circuits/joinsplit_js/joinsplit.wasm`, `circuits/joinsplit_0001.zkey`, `circuits/portfolio_note_js/portfolio_note.wasm`, `circuits/portfolio_note_0001.zkey` into this repo's `circuits/` folder
2. Render Dashboard → **New** → **Blueprint**
3. Connect **Phanton-Protocol/Relayer** (this repo)
4. Blueprint path: `render.yaml`
5. Set env vars (see `DEPLOY.md`)

Render creates **phantom-protocol** (API). Free tier = 1 service only. For "Join as validator" you'd need to add the coordinator as a separate service (requires paid plan). First connection can take 30–60s (free tier sleeps).

## Usage

1. Open the deployed URL
2. Enter your relayer API URL (or it uses the default from VITE_API_URL)
3. Connect wallet and stake
4. Use the **Validators** tab for setup instructions
