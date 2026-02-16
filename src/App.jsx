import React, { useState, useEffect, useCallback } from "react";
import { BrowserProvider, Contract, parseEther } from "ethers";

const API_URL = import.meta.env.VITE_API_URL || "";
const BSC_TESTNET = { chainId: 97, chainIdHex: "0x61", rpcUrl: "https://data-seed-prebsc-1-s1.binance.org:8545", name: "BSC Testnet" };

function getInjectedProvider() {
  if (typeof window === "undefined") return null;
  const eth = window.ethereum;
  if (!eth) return null;
  if (eth.providers?.length) return eth.providers.find((p) => p.isMetaMask) || eth.providers[0];
  return eth;
}

function useFetch(url, intervalMs = 0) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!url) return;
    const fetchIt = () => {
      fetch(url, { mode: "cors" })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((d) => { setData(d); setError(null); })
        .catch((e) => { setError(e.message); setData(null); })
        .finally(() => setLoading(false));
    };
    fetchIt();
    if (intervalMs > 0) {
      const id = setInterval(fetchIt, intervalMs);
      return () => clearInterval(id);
    }
  }, [url, intervalMs]);

  return { data, error, loading };
}

function getInitialApiUrl() {
  if (typeof window === "undefined") return API_URL;
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("api");
  if (fromUrl) return fromUrl.trim();
  return localStorage.getItem("relayer_api") || API_URL;
}

export default function App() {
  const [apiBase, setApiBase] = useState(getInitialApiUrl);
  const base = (apiBase || "").replace(/\/$/, "").trim();

  const { data: health, error: healthError } = useFetch(base ? `${base}/health` : null, 5000);
  const { data: relayer } = useFetch(base ? `${base}/relayer` : null, 10000);
  const { data: staking, error: stakingError } = useFetch(base ? `${base}/relayer/staking-status` : null, 10000);
  const { data: proofStats } = useFetch(base ? `${base}/relayer/proof-stats` : null, 5000);
  const { data: stakingStats } = useFetch(base ? `${base}/staking/stats` : null, 15000);
  const { data: network } = useFetch(base ? `${base}/relayer/network` : null, 0);

  const [wallet, setWallet] = useState({ address: null, provider: null, signer: null });
  const [stakeAmount, setStakeAmount] = useState("");
  const [stakeTx, setStakeTx] = useState({ status: null, hash: null, error: null });
  const [connectError, setConnectError] = useState(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    localStorage.setItem("relayer_api", apiBase);
  }, [apiBase]);

  const connectWallet = useCallback(async () => {
    const provider = getInjectedProvider();
    if (!provider) {
      setConnectError("No wallet found. Install MetaMask, Trust Wallet, or another Web3 wallet.");
      return;
    }
    setConnecting(true);
    setConnectError(null);
    setStakeTx((t) => (t.status === "error" && t.error?.includes("wallet") ? { status: null, hash: null, error: null } : t));
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!accounts?.length) {
        setConnectError("No accounts returned. Please unlock your wallet.");
        return;
      }
      const targetChainId = network?.chainId ?? BSC_TESTNET.chainId;
      const chainIdHex = "0x" + Number(targetChainId).toString(16);
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chainIdHex }]
        });
      } catch (switchErr) {
        if (switchErr?.code === 4902 || switchErr?.message?.includes("Unrecognized chain")) {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: BSC_TESTNET.chainIdHex,
              chainName: BSC_TESTNET.name,
              nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
              rpcUrls: [BSC_TESTNET.rpcUrl]
            }]
          });
        } else {
          throw switchErr;
        }
      }
      const prov = new BrowserProvider(provider);
      const signer = await prov.getSigner();
      setWallet({ address: accounts[0], provider: prov, signer });
      setConnectError(null);
    } catch (e) {
      const msg = e?.message || String(e);
      setConnectError(msg.includes("User rejected") ? "Connection cancelled" : msg);
    } finally {
      setConnecting(false);
    }
  }, [network?.chainId]);

  useEffect(() => {
    const p = getInjectedProvider();
    if (!p || !wallet.address) return;
    const onAccounts = (accounts) => {
      if (!accounts?.length) setWallet({ address: null, provider: null, signer: null });
    };
    const onChain = () => window.location.reload();
    p.on?.("accountsChanged", onAccounts);
    p.on?.("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [wallet.address]);

  const stake = async () => {
    const stakingAddr = staking?.stakingAddress;
    const tokenAddr = stakingStats?.protocolTokenAddress;
    if (!stakingAddr || !tokenAddr || !wallet.signer || !stakeAmount) return;
    setStakeTx({ status: "pending" });
    try {
      const amountWei = parseEther(stakeAmount);
      const tokenAbi = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];
      const stakingAbi = ["function stake(uint256) external"];
      const token = new Contract(tokenAddr, tokenAbi, wallet.signer);
      const stakingContract = new Contract(stakingAddr, stakingAbi, wallet.signer);
      const allowance = await token.allowance(wallet.address, stakingAddr);
      if (allowance < amountWei) {
        const approveTx = await token.approve(stakingAddr, amountWei);
        await approveTx.wait();
      }
      const tx = await stakingContract.stake(amountWei);
      await tx.wait();
      setStakeTx({ status: "success", hash: tx.hash });
      setStakeAmount("");
    } catch (e) {
      setStakeTx({ status: "error", error: e.message });
    }
  };

  const isRelayerWallet = relayer && wallet.address && String(wallet.address).toLowerCase() === String(relayer.relayer).toLowerCase();
  const [tab, setTab] = useState("relayer");

  return (
    <div style={{ padding: "2rem", maxWidth: 900, margin: "0 auto" }}>
      <header style={{ marginBottom: "2rem", borderBottom: "1px solid #2a2a3a", paddingBottom: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 600, color: "#8b5cf6" }}>
              Phantom Relayer Dashboard
            </h1>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "#6b7280" }}>
              Operator dashboard — not for end users
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.5rem" }}>
            {wallet.address ? (
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span style={{ fontSize: "0.85rem", color: "#22c55e", fontFamily: "monospace" }}>
                  {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
                </span>
                <button
                  onClick={() => { setWallet({ address: null, provider: null, signer: null }); setConnectError(null); }}
                  style={{ padding: "0.25rem 0.5rem", background: "#2a2a3a", border: "none", borderRadius: 4, color: "#9ca3af", fontSize: "0.75rem", cursor: "pointer" }}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={connectWallet}
                disabled={connecting}
                style={{
                  padding: "0.5rem 1rem",
                  background: connecting ? "#4b5563" : "#8b5cf6",
                  border: "none",
                  borderRadius: 6,
                  color: "#fff",
                  fontWeight: 600,
                  cursor: connecting ? "wait" : "pointer",
                  fontSize: "0.9rem"
                }}
              >
                {connecting ? "Connecting…" : "Connect Wallet"}
              </button>
            )}
            {connectError && <span style={{ fontSize: "0.8rem", color: "#ef4444", maxWidth: 220, textAlign: "right" }}>{connectError}</span>}
          </div>
        </div>
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <label style={{ fontSize: "0.8rem", color: "#9ca3af" }}>API URL</label>
          <input
            type="text"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder="https://your-relayer.onrender.com (required)"
            style={{
              flex: 1,
              padding: "0.5rem 0.75rem",
              background: "#1a1a24",
              border: "1px solid #2a2a3a",
              borderRadius: 6,
              color: "#e0e0e8",
              fontFamily: "inherit",
              fontSize: "0.9rem"
            }}
          />
        </div>
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
          <button
            onClick={() => setTab("relayer")}
            style={{
              padding: "0.5rem 1rem",
              background: tab === "relayer" ? "#8b5cf6" : "#2a2a3a",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: "0.9rem"
            }}
          >
            Relayer
          </button>
          <button
            onClick={() => setTab("validators")}
            style={{
              padding: "0.5rem 1rem",
              background: tab === "validators" ? "#8b5cf6" : "#2a2a3a",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: "0.9rem"
            }}
          >
            Validators
          </button>
        </div>
      </header>

      {tab === "validators" ? (
        <ValidatorSetup />
      ) : (
      <section style={{ display: "grid", gap: "1.5rem" }}>
        <Card title="Health">
          {!base ? (
            <div style={{ color: "#f59e0b" }}>
              Enter your relayer API URL above (e.g. https://your-relayer.onrender.com). The relayer must be running and allow CORS.
            </div>
          ) : health ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e" }} />
              <span>OK — {health.status || "running"}</span>
            </div>
          ) : (
            <div style={{ color: "#ef4444" }}>
              {healthError || "Cannot reach API."} Check: (1) Relayer URL is correct and uses HTTPS, (2) Relayer is running, (3) Relayer allows CORS from this site.
            </div>
          )}
        </Card>

        <Card title="Relayer">
          {relayer ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.9rem" }}>
              <Row label="Address" value={relayer.relayer} mono />
              <Row label="Dry run" value={relayer.dryRun ? "Yes" : "No"} />
              <Row label="Bypass validators" value={relayer.bypassValidators ? "Yes" : "No"} />
              <Row label="Bypass proofs" value={relayer.bypassProofs ? "Yes" : "No"} />
              {relayer.validatorUrls?.length > 0 && (
                <Row label="Validators" value={relayer.validatorUrls.join(", ")} mono small />
              )}
            </div>
          ) : (
            <div style={{ color: "#6b7280" }}>Loading…</div>
          )}
        </Card>

        <Card title="Staking">
          {staking ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", fontSize: "0.9rem" }}>
              <Row label="Staked" value={formatWei(staking.staked)} />
              <Row label="Min stake" value={formatWei(staking.minStake)} />
              <Row label="Total staked" value={formatWei(staking.totalStaked)} />
              <Row
                label="Valid"
                value={staking.isRelayerValid ? "Yes" : "No"}
                valueColor={staking.isRelayerValid ? "#22c55e" : "#ef4444"}
              />
              <Row label="Staking contract" value={staking.stakingAddress} mono small />
              <hr style={{ border: "none", borderTop: "1px solid #2a2a3a", margin: "0.5rem 0" }} />
              <div style={{ fontSize: "0.85rem", color: "#9ca3af", marginBottom: "0.5rem" }}>
                <strong style={{ color: "#e0e0e8" }}>How to become a relayer:</strong> The relayer is the wallet in your backend config (RELAYER_PRIVATE_KEY). To stake, connect that same wallet here — import its key into MetaMask, then connect and stake.
              </div>
              {!wallet.address ? (
                <div style={{ fontSize: "0.85rem", color: "#6b7280" }}>Connect wallet above to stake.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {relayer && (
                    <div style={{ fontSize: "0.8rem", color: isRelayerWallet ? "#22c55e" : "#f59e0b" }}>
                      {isRelayerWallet
                        ? "✓ Correct wallet — staking will make this relayer valid"
                        : "⚠ Wrong wallet — connect the relayer wallet (see Relayer address above). Import its key into MetaMask if needed."}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type="text"
                      placeholder="Amount (e.g. 100)"
                      value={stakeAmount}
                      onChange={(e) => setStakeAmount(e.target.value)}
                      style={{
                        flex: 1,
                        minWidth: 120,
                        padding: "0.5rem 0.75rem",
                        background: "#1a1a24",
                        border: "1px solid #2a2a3a",
                        borderRadius: 6,
                        color: "#e0e0e8",
                        fontFamily: "inherit",
                        fontSize: "0.9rem"
                      }}
                    />
                    <button
                      onClick={stake}
                      disabled={!stakeAmount || stakeTx.status === "pending"}
                      style={{
                        padding: "0.5rem 1rem",
                        background: stakeTx.status === "pending" ? "#4b5563" : "#22c55e",
                        border: "none",
                        borderRadius: 6,
                        color: "#fff",
                        fontWeight: 600,
                        cursor: stakeAmount && stakeTx.status !== "pending" ? "pointer" : "not-allowed",
                        fontSize: "0.9rem"
                      }}
                    >
                      {stakeTx.status === "pending" ? "Staking…" : "Stake"}
                    </button>
                  </div>
                  {stakeTx.status === "success" && (
                    <div style={{ color: "#22c55e", fontSize: "0.85rem" }}>Staked! Tx: {stakeTx.hash?.slice(0, 10)}…</div>
                  )}
                  {stakeTx.status === "error" && (
                    <div style={{ color: "#ef4444", fontSize: "0.85rem" }}>{stakeTx.error}</div>
                  )}
                </div>
              )}
            </div>
          ) : stakingError ? (
            <div style={{ color: "#ef4444" }}>API error: {stakingError}</div>
          ) : (
            <div style={{ color: "#6b7280" }}>Loading…</div>
          )}
        </Card>

        <Card title="Proof Stats">
          {proofStats ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", fontSize: "0.9rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: proofStats.rapidsnarkEnabled ? "#22c55e" : "#f59e0b" }} />
                <span>{proofStats.rapidsnarkEnabled ? "Rapidsnark enabled" : "Using snarkjs (set RAPIDSNARK_PATH for faster proofs)"}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem" }}>
                <StatBox label="Swap" count={proofStats.swap?.count} avgMs={proofStats.swap?.avgMs} />
                <StatBox label="Withdraw" count={proofStats.withdraw?.count} avgMs={proofStats.withdraw?.avgMs} />
                <StatBox label="Portfolio" count={proofStats.portfolio?.count} avgMs={proofStats.portfolio?.avgMs} />
              </div>
              {proofStats.lastError && (
                <div style={{ color: "#ef4444", fontSize: "0.8rem" }}>
                  Last error: {proofStats.lastError.type} @ {new Date(proofStats.lastError.ts).toLocaleTimeString()}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: "#6b7280" }}>Loading…</div>
          )}
        </Card>

        <Card title="Protocol">
          {stakingStats ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.9rem" }}>
              <Row label="Protocol token" value={stakingStats.protocolTokenAddress} mono small />
              <Row label="Total staked" value={formatWei(stakingStats.totalStaked)} />
              <Row label="Min stake" value={formatWei(stakingStats.minStake)} />
            </div>
          ) : (
            <div style={{ color: "#6b7280" }}>Loading…</div>
          )}
        </Card>
      </section>
      )}
    </div>
  );
}

function ValidatorSetup() {
  return (
    <section style={{ display: "grid", gap: "1.5rem" }}>
      <Card title="Validator Setup">
        <p style={{ color: "#9ca3af", marginBottom: "1rem", lineHeight: 1.6 }}>
          Validators run a <strong>Node.js server</strong> — deploy to Render, Railway, or your own VPS.
        </p>
        <h4 style={{ margin: "1rem 0 0.5rem", fontSize: "0.95rem" }}>1. Stake SHDW</h4>
        <p style={{ color: "#9ca3af", fontSize: "0.9rem", margin: 0 }}>
          Stake ≥ 1000 SHDW in RelayerStaking. Use the <strong>Relayer</strong> tab above to stake.
        </p>
        <h4 style={{ margin: "1rem 0 0.5rem", fontSize: "0.95rem" }}>2. Run Validator Server</h4>
        <pre style={{
          background: "#0a0a0f",
          padding: "1rem",
          borderRadius: 6,
          overflow: "auto",
          fontSize: "0.8rem",
          color: "#e0e0e8",
          margin: "0.5rem 0"
        }}>
{`cd backend
export VALIDATOR_PRIVATE_KEY=0x...
export VALIDATOR_PORT=6000
export RELAYER_STAKING_ADDRESS=0xf68c0F35075c168289aF67E18698180b7F71a1e8
export RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545
node src/validatorServer.js`}
        </pre>
        <h4 style={{ margin: "1rem 0 0.5rem", fontSize: "0.95rem" }}>3. Add to Relayer</h4>
        <p style={{ color: "#9ca3af", fontSize: "0.9rem", margin: 0 }}>
          Set <code style={{ background: "#2a2a3a", padding: "0.1rem 0.3rem", borderRadius: 4 }}>VALIDATOR_URLS</code> in relayer env: <code style={{ background: "#2a2a3a", padding: "0.1rem 0.3rem", borderRadius: 4 }}>https://your-validator.onrender.com</code>
        </p>
        <h4 style={{ margin: "1rem 0 0.5rem", fontSize: "0.95rem" }}>Threshold: 66%</h4>
        <p style={{ color: "#9ca3af", fontSize: "0.9rem", margin: 0 }}>
          Validators representing <strong>66% of total staked voting power</strong> must sign each proof.
        </p>
      </Card>
    </section>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background: "#12121a", border: "1px solid #2a2a3a", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid #2a2a3a", fontWeight: 600, fontSize: "0.95rem" }}>
        {title}
      </div>
      <div style={{ padding: "1rem" }}>{children}</div>
    </div>
  );
}

function Row({ label, value, mono, small, valueColor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "baseline" }}>
      <span style={{ color: "#6b7280", fontSize: small ? "0.8rem" : undefined }}>{label}</span>
      <span
        style={{
          fontFamily: mono ? "monospace" : "inherit",
          fontSize: small ? "0.75rem" : "0.9rem",
          color: valueColor || "#e0e0e8",
          wordBreak: "break-all",
          textAlign: "right"
        }}
      >
        {value}
      </span>
    </div>
  );
}

function StatBox({ label, count, avgMs }) {
  return (
    <div style={{ background: "#0a0a0f", padding: "0.75rem", borderRadius: 6, textAlign: "center" }}>
      <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: "0.25rem" }}>{label}</div>
      <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{count ?? 0}</div>
      <div style={{ fontSize: "0.8rem", color: "#9ca3af" }}>
        avg {typeof avgMs === "number" ? `${avgMs.toFixed(0)}ms` : "—"}
      </div>
    </div>
  );
}

function formatWei(s) {
  if (!s || s === "0") return "0";
  const n = BigInt(s);
  if (n < 10n ** 18n) return n.toString();
  return (Number(n) / 1e18).toFixed(4) + " …";
}
