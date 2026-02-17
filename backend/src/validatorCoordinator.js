

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const { ethers } = require("ethers");

const COORDINATOR_PORT = process.env.PORT || process.env.VALIDATOR_COORDINATOR_PORT || 6005;
const RPC_URL = process.env.RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const RELAYER_STAKING_ADDRESS = process.env.RELAYER_STAKING_ADDRESS;
const THRESHOLD_BPS = 6600; 

if (!RELAYER_STAKING_ADDRESS) {
  console.error("❌ Set RELAYER_STAKING_ADDRESS in .env");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const stakers = new Map();

async function getVotingPower(address) {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const staking = new ethers.Contract(
      RELAYER_STAKING_ADDRESS,
      ["function stakedBalance(address) view returns (uint256)"],
      provider
    );
    return await staking.stakedBalance(address);
  } catch (e) {
    return 0n;
  }
}

wss.on("connection", async (ws, req) => {
  let address = null;
  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "register" && msg.address) {
        address = ethers.getAddress(msg.address);
        const power = await getVotingPower(address);
        if (power < ethers.parseEther("1000")) {
          ws.send(JSON.stringify({ type: "error", message: "Stake ≥ 1000 SHDW first" }));
          ws.close();
          return;
        }
        stakers.set(address, { ws, votingPower: power, lastSeen: Date.now() });
        console.log(`✅ Staker connected: ${address} (${ethers.formatEther(power)} SHDW)`);
        ws.send(JSON.stringify({ type: "registered", votingPower: power.toString() }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: e.message }));
    }
  });
  ws.on("close", () => {
    if (address) stakers.delete(address);
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    stakers: stakers.size,
    uptime: process.uptime()
  });
});

app.post("/verify", async (req, res) => {
  const { proof, publicInputs } = req.body;
  if (!proof || !publicInputs) {
    return res.status(400).json({ error: "Missing proof or publicInputs" });
  }

  const connected = Array.from(stakers.entries());
  if (connected.length === 0) {
    return res.status(503).json({
      error: "No stakers connected. Stakers run: node src/validatorClient.js"
    });
  }

  console.log(`\n📡 Broadcasting to ${connected.length} stakers...`);
  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const payload = { type: "verify", requestId, proof, publicInputs };

  const results = await Promise.allSettled(
    connected.map(([addr, { ws }]) => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), 15000);
        const handler = (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.requestId === requestId) {
              clearTimeout(timeout);
              ws.off("message", handler);
              resolve(msg);
            }
          } catch (_) {}
        };
        ws.on("message", handler);
        ws.send(JSON.stringify(payload));
      });
    })
  );

  const signatures = [];
  let totalVotingPower = 0n;
  let validVotingPower = 0n;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const [addr] = connected[i];
    const power = stakers.get(addr)?.votingPower ?? 0n;
    totalVotingPower += power;
    if (r.status === "fulfilled" && r.value?.valid) {
      validVotingPower += power;
      signatures.push({
        validator: addr,
        votingPower: power.toString(),
        signature: r.value.signature,
        timestamp: r.value.timestamp
      });
    }
  }

  const thresholdMet = totalVotingPower > 0n && (validVotingPower * 10000n) >= (totalVotingPower * BigInt(THRESHOLD_BPS));

  res.json({
    aggregated: true,
    valid: thresholdMet,
    signatures,
    totalVotingPower: totalVotingPower.toString(),
    validVotingPower: validVotingPower.toString(),
    stakerCount: connected.length
  });
});

server.listen(COORDINATOR_PORT, () => {
  console.log(`\n✅ Validator Coordinator running on port ${COORDINATOR_PORT}`);
  console.log(`   WebSocket: ws://localhost:${COORDINATOR_PORT}`);
  console.log(`   HTTP /verify: http://localhost:${COORDINATOR_PORT}/verify`);
  console.log(`\n   Stakers run: node src/validatorClient.js`);
  console.log(`   Set VALIDATOR_URLS=http://localhost:${COORDINATOR_PORT} in relayer\n`);
});
