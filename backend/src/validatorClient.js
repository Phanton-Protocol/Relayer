/**
 * Validator Client - Auto-validator for stakers
 *
 * Run this after staking ≥ 1000 SHDW. Connects to coordinator and signs
 * proofs automatically. No server deploy needed.
 *
 * Usage:
 *   export VALIDATOR_PRIVATE_KEY=0x...
 *   export COORDINATOR_URL=ws://localhost:6005
 *   node src/validatorClient.js
 *
 * Or with .env:
 *   VALIDATOR_PRIVATE_KEY=0x...
 *   COORDINATOR_URL=ws://localhost:6005
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const WebSocket = require("ws");
const { ethers } = require("ethers");
const snarkjs = require("snarkjs");
const fs = require("fs");
const path = require("path");

const VALIDATOR_PRIVATE_KEY = process.env.VALIDATOR_PRIVATE_KEY;
const COORDINATOR_URL = process.env.COORDINATOR_URL || "ws://localhost:6005";
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const VERIFICATION_KEY_PATH = path.join(PROJECT_ROOT, "circuits", "verification_key.json");

if (!VALIDATOR_PRIVATE_KEY) {
  console.error("❌ Set VALIDATOR_PRIVATE_KEY in .env");
  process.exit(1);
}

const wallet = new ethers.Wallet(VALIDATOR_PRIVATE_KEY);
let vKey;

function loadVKey() {
  try {
    vKey = JSON.parse(fs.readFileSync(VERIFICATION_KEY_PATH, "utf8"));
  } catch (e) {
    console.error("❌ Missing circuits/verification_key.json. Run: npx snarkjs zkey export verificationkey circuits/joinsplit_0001.zkey circuits/verification_key.json");
    process.exit(1);
  }
}

function normalizeProof(proof) {
  const a = proof?.a || proof?.pi_a;
  const b = proof?.b || proof?.pi_b;
  const c = proof?.c || proof?.pi_c;
  if (!a || !b || !c) return null;
  return {
    a: Array.isArray(a) ? a.slice(0, 2) : a,
    b: Array.isArray(b) ? b : null,
    c: Array.isArray(c) ? c.slice(0, 2) : c
  };
}

async function verifyProof(proof, publicInputs) {
  const p = normalizeProof(proof);
  if (!p) return false;
  const proofSnarkJS = {
    pi_a: p.a,
    pi_b: Array.isArray(p.b) ? [[p.b[0][1], p.b[0][0]], [p.b[1][1], p.b[1][0]]] : p.b,
    pi_c: p.c,
    protocol: "groth16",
    curve: "bn128"
  };
  return snarkjs.groth16.verify(vKey, publicInputs, proofSnarkJS);
}

function connect() {
  const ws = new WebSocket(COORDINATOR_URL);
  ws.on("open", () => {
    console.log("📡 Connected to coordinator");
    ws.send(JSON.stringify({ type: "register", address: wallet.address }));
  });
  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "error") {
        console.error("❌", msg.message);
        return;
      }
      if (msg.type === "registered") {
        console.log(`✅ Registered as validator (${ethers.formatEther(msg.votingPower)} SHDW)`);
        console.log("⏳ Waiting for proof requests...\n");
        return;
      }
      if (msg.type === "verify") {
        console.log("🔍 Proof request received, verifying...");
        const isValid = await verifyProof(msg.proof, msg.publicInputs);
        const p = normalizeProof(msg.proof);
        if (!p) {
          ws.send(JSON.stringify({ requestId: msg.requestId, valid: false, signature: "0x", timestamp: 0 }));
          return;
        }
        const coder = ethers.AbiCoder.defaultAbiCoder();
        const proofForHash = {
          a: coder.encode(["uint256[2]"], [p.a]),
          b: coder.encode(["uint256[2][2]"], [p.b]),
          c: coder.encode(["uint256[2]"], [p.c])
        };
        const proofHash = ethers.keccak256(
          coder.encode(
            ["bytes", "bytes", "bytes", "uint256[]"],
            [proofForHash.a, proofForHash.b, proofForHash.c, msg.publicInputs]
          )
        );
        const timestamp = Math.floor(Date.now() / 1000);
        const message = ethers.keccak256(
          ethers.solidityPacked(["bytes32", "bool", "uint256"], [proofHash, isValid, timestamp])
        );
        const signature = await wallet.signMessage(ethers.getBytes(message));
        ws.send(JSON.stringify({
          requestId: msg.requestId,
          valid: isValid,
          signature,
          timestamp
        }));
        console.log(`${isValid ? "✅" : "❌"} Signed (${isValid ? "valid" : "invalid"})`);
      }
    } catch (e) {
      console.error("Error:", e.message);
    }
  });
  ws.on("close", () => {
    console.log("🔌 Disconnected, reconnecting in 5s...");
    setTimeout(connect, 5000);
  });
  ws.on("error", (e) => {
    console.error("WebSocket error:", e.message);
  });
}

loadVKey();
console.log(`🔐 Validator: ${wallet.address}`);
console.log(`📡 Coordinator: ${COORDINATOR_URL}\n`);
connect();
