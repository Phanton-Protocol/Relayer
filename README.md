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

## Fix "Failed to fetch"

1. **Use the `?api=` link** when sharing (see above)
2. **Or set VITE_API_URL** in Vercel: Project → Settings → Environment Variables → Add `VITE_API_URL` = your relayer URL, then redeploy
3. **Relayer must use HTTPS** — `http://` is blocked by browsers
4. **Relayer must be running** — Render free tier sleeps after 15 min; first request may be slow

## Usage

1. Open the deployed URL
2. Enter your relayer API URL (or it uses the default from VITE_API_URL)
3. Connect wallet and stake
4. Use the **Validators** tab for setup instructions
