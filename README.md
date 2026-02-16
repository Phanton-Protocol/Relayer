# Phantom Relayer Dashboard

Operator dashboard for Phantom Protocol — stake, monitor relayer status, validator setup.

## Deploy to Vercel

1. Go to **https://vercel.com** → Sign in with GitHub
2. **Add New** → **Project**
3. Import `Phanton-Protocol/Relayer`
4. **Environment Variable** (required): `VITE_API_URL` = your relayer URL (e.g. `https://phantom-relayer.onrender.com`)
5. Click **Deploy**

## Fix "Failed to fetch"

1. **Set VITE_API_URL** in Vercel: Project → Settings → Environment Variables → Add `VITE_API_URL` = your relayer URL
2. **Redeploy** after adding the env var
3. **Relayer must use HTTPS** — `http://` URLs are blocked by browsers when the dashboard is on HTTPS
4. **Relayer must allow CORS** — the backend uses `cors({ origin: true })` which allows all origins
5. **Relayer must be running** — Render free tier sleeps after 15 min; first request may be slow

## Usage

1. Open the deployed URL
2. Enter your relayer API URL (or it uses the default from VITE_API_URL)
3. Connect wallet and stake
4. Use the **Validators** tab for setup instructions
