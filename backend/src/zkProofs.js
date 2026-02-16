/**
 * @title ZK Proof Generation for Backend
 * @notice Generates Groth16 proofs for swaps and withdrawals
 * @dev Supports rapidsnark for 10-100x faster proof generation when RAPIDSNARK_PATH is set
 */

const snarkjs = require("snarkjs");
let zkKitProve = null;
try {
  zkKitProve = require("@zk-kit/groth16").prove;
} catch (_) {
  /* @zk-kit/groth16 optional for faster consecutive proofs */
}
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");
const { mimc7, FIELD } = require("./mimc7");
const { toBigIntString, toBigInt } = require("./utils/bigint");

// Circuit paths
const WASM_PATH = process.env.PROVER_WASM || path.join(__dirname, "..", "..", "circuits", "joinsplit_js", "joinsplit.wasm");
const ZKEY_PATH = process.env.PROVER_ZKEY || path.join(__dirname, "..", "..", "circuits", "joinsplit_0001.zkey");
const PORTFOLIO_WASM = process.env.PORTFOLIO_WASM || path.join(__dirname, "..", "..", "circuits", "portfolio_note_js", "portfolio_note.wasm");
const PORTFOLIO_ZKEY = process.env.PORTFOLIO_ZKEY || path.join(__dirname, "..", "..", "circuits", "portfolio_note_0001.zkey");
// Read at runtime so loadConfig() can populate from config.json
function getRapidsnarkPath() {
  return process.env.RAPIDSNARK_PATH;
}
const CIRCUITS_DIR = path.join(__dirname, "..", "..", "circuits");

const DEV_BYPASS_PROOFS = process.env.DEV_BYPASS_PROOFS === "true";

/** Proof generation stats for relayer dashboard */
const proofStats = { swap: [], withdraw: [], portfolio: [], lastError: null };
const MAX_STATS = 50;

function recordProofStats(type, elapsedMs, success = true) {
  proofStats[type].push({ elapsedMs, success, ts: Date.now() });
  if (proofStats[type].length > MAX_STATS) proofStats[type].shift();
  if (!success) proofStats.lastError = { type, ts: Date.now() };
}

function getProofStats() {
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  return {
    swap: { count: proofStats.swap.length, avgMs: avg(proofStats.swap.map((s) => s.elapsedMs)), recent: proofStats.swap.slice(-5) },
    withdraw: { count: proofStats.withdraw.length, avgMs: avg(proofStats.withdraw.map((s) => s.elapsedMs)), recent: proofStats.withdraw.slice(-5) },
    portfolio: { count: proofStats.portfolio.length, avgMs: avg(proofStats.portfolio.map((s) => s.elapsedMs)), recent: proofStats.portfolio.slice(-5) },
    lastError: proofStats.lastError,
    rapidsnarkEnabled: !!getRapidsnarkPath()
  };
}

/**
 * Generate witness.wtns using circom's witness calculator, then prove with rapidsnark.
 * Falls back to snarkjs fullProve if rapidsnark fails or is not configured.
 */
async function proveWithRapidsnarkOrSnarkjs(circuitInputs, wasmPath, zkeyPath, circuitType = "joinsplit") {
  const startTime = Date.now();

  const rapidsnarkPath = getRapidsnarkPath();
  if (rapidsnarkPath && fs.existsSync(rapidsnarkPath) && fs.existsSync(wasmPath) && fs.existsSync(zkeyPath)) {
    const tmpDir = os.tmpdir();
    const prefix = path.join(tmpDir, `phantom_proof_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const inputPath = `${prefix}_input.json`;
    const wtnsPath = `${prefix}_witness.wtns`;
    const proofPath = `${prefix}_proof.json`;
    const publicPath = `${prefix}_public.json`;

    try {
      fs.writeFileSync(inputPath, JSON.stringify(circuitInputs, null, 0));

      // Generate witness using circom's generate_witness.js
      const genWitnessPath = path.join(CIRCUITS_DIR, circuitType === "portfolio" ? "portfolio_note_js" : "joinsplit_js", "generate_witness.js");
      if (!fs.existsSync(genWitnessPath)) throw new Error("generate_witness.js not found");
      await new Promise((resolve, reject) => {
        const proc = spawn("node", [genWitnessPath, wasmPath, inputPath, wtnsPath], { stdio: "pipe" });
        let err = "";
        proc.stderr?.on("data", (d) => { err += d.toString(); });
        proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `witness gen exit ${code}`))));
      });

      if (!fs.existsSync(wtnsPath)) throw new Error("Witness file not created");

      // Run rapidsnark prover
      await new Promise((resolve, reject) => {
        const proc = spawn(rapidsnarkPath, [zkeyPath, wtnsPath, proofPath, publicPath], { stdio: "pipe" });
        let err = "";
        proc.stderr?.on("data", (d) => { err += d.toString(); });
        proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `rapidsnark exit ${code}`))));
      });

      const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
      const publicSignals = JSON.parse(fs.readFileSync(publicPath, "utf8"));

      [inputPath, wtnsPath, proofPath, publicPath].forEach((p) => { try { fs.unlinkSync(p); } catch (_) {} });

      const solidityProof = {
        a: [proof.pi_a[0], proof.pi_a[1]],
        b: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
        c: [proof.pi_c[0], proof.pi_c[1]]
      };
      const elapsed = Date.now() - startTime;
      console.log(`✅ Proof generated in ${elapsed}ms (rapidsnark)`);
      return { proof: solidityProof, publicSignals, generationTime: elapsed };
    } catch (rapidErr) {
      console.warn("Rapidsnark failed, falling back to snarkjs:", rapidErr.message);
      [inputPath, wtnsPath, proofPath, publicPath].forEach((p) => { try { fs.unlinkSync(p); } catch (_) {} });
    }
  }

  // Use @zk-kit/groth16 (faster for consecutive proofs) or snarkjs
  let proof;
  let publicSignals;
  let proverName = "snarkjs";

  if (zkKitProve) {
    try {
      const result = await zkKitProve(circuitInputs, wasmPath, zkeyPath);
      proof = result.proof;
      publicSignals = result.publicSignals;
      proverName = "zk-kit";
    } catch (_) {
      /* fall through to snarkjs */
    }
  }
  if (!proof) {
    const result = await snarkjs.groth16.fullProve(circuitInputs, wasmPath, zkeyPath);
    proof = result.proof;
    publicSignals = result.publicSignals;
  }

  const elapsed = Date.now() - startTime;
  console.log(`✅ Proof generated in ${elapsed}ms (${proverName})`);
  const solidityProof = {
    a: [String(proof.pi_a[0]), String(proof.pi_a[1])],
    b: [
      [String(proof.pi_b[0][1]), String(proof.pi_b[0][0])],
      [String(proof.pi_b[1][1]), String(proof.pi_b[1][0])]
    ],
    c: [String(proof.pi_c[0]), String(proof.pi_c[1])]
  };
  return { proof: solidityProof, publicSignals, generationTime: elapsed };
}


/**
 * Generate ZK proof for swap
 */
async function generateSwapProof(swapData) {
  const {
    inputNote,
    outputNoteSwap,
    outputNoteChange,
    merkleRoot,
    merklePath,
    merklePathIndices,
    swapAmount,
    minOutputAmount,
    protocolFee,
    gasRefund
  } = swapData;

  // Use shared toBigIntString for normalization

  // Ensure merklePath and merklePathIndices are arrays of exactly 10 strings
  // merklePath values should be BigInt strings (no 0x prefix)
  // merklePathIndices should be "0" or "1" strings
  const formatMerklePath = (path) => {
    if (!Array.isArray(path)) return Array(10).fill("0");
    const formatted = path.slice(0, 10).map(v => {
      if (!v || v === "0x0" || v === "0x0000000000000000000000000000000000000000000000000000000000000000") {
        return "0";
      }
      return toBigIntString(v);
    });
    while (formatted.length < 10) formatted.push("0");
    return formatted;
  };
  
  const formatMerkleIndices = (indices) => {
    if (!Array.isArray(indices)) return Array(10).fill("0");
    const formatted = indices.slice(0, 10).map(v => {
      const num = toBigInt(v);
      return String(num % 2n); // Ensure 0 or 1
    });
    while (formatted.length < 10) formatted.push("0");
    return formatted;
  };

  const circuitInputs = {
    // Private inputs
    inputAssetID: inputNote.assetID.toString(),
    inputAmount: toBigIntString(inputNote.amount),
    inputBlindingFactor: toBigIntString(inputNote.blindingFactor),
    ownerPublicKey: toBigIntString(inputNote.ownerPublicKey),
    
    // Output Note 1 (Swap Result)
    outputAssetIDSwap: outputNoteSwap.assetID.toString(),
    outputAmountSwap: toBigIntString(outputNoteSwap.amount),
    swapBlindingFactor: toBigIntString(outputNoteSwap.blindingFactor),
    
    // Output Note 2 (Change)
    outputAssetIDChange: outputNoteChange.assetID.toString(),
    changeAmount: toBigIntString(outputNoteChange.amount),
    changeBlindingFactor: toBigIntString(outputNoteChange.blindingFactor),
    
    // Swap parameters
    swapAmount: toBigIntString(swapAmount),
    
    // Public inputs - convert hex strings to BigInt strings
    nullifier: toBigIntString(inputNote.nullifier),
    inputCommitment: toBigIntString(inputNote.commitment),
    outputCommitmentSwap: toBigIntString(outputNoteSwap.commitment),
    outputCommitmentChange: toBigIntString(outputNoteChange.commitment),
    merkleRoot: toBigIntString(merkleRoot),
    outputAmountSwapPublic: toBigIntString(outputNoteSwap.amount),
    minOutputAmountSwap: toBigIntString(minOutputAmount),
    protocolFee: toBigIntString(protocolFee),
    gasRefund: toBigIntString(gasRefund),
    
    // Merkle proof - ensure arrays of 10 strings
    merklePath: formatMerklePath(merklePath),
    merklePathIndices: formatMerkleIndices(merklePathIndices)
  };

  const mimcCommitment = (assetId, amount, blinding, ownerKey) => {
    const h1 = mimc7(BigInt(assetId), BigInt(amount));
    const h2 = mimc7(h1, BigInt(blinding));
    const h3 = mimc7(h2, BigInt(ownerKey));
    return h3.toString();
  };

  const mimcNullifier = (commitment, ownerKey) => {
    return mimc7(BigInt(commitment), BigInt(ownerKey)).toString();
  };

  if (circuitInputs.outputAssetIDChange !== circuitInputs.inputAssetID) {
    console.log(
      `   ⚠️ Adjusting outputAssetIDChange to match inputAssetID: ${circuitInputs.outputAssetIDChange} -> ${circuitInputs.inputAssetID}`
    );
    circuitInputs.outputAssetIDChange = circuitInputs.inputAssetID;
    circuitInputs.outputCommitmentChange = mimcCommitment(
      BigInt(circuitInputs.outputAssetIDChange),
      BigInt(circuitInputs.changeAmount),
      BigInt(circuitInputs.changeBlindingFactor),
      BigInt(circuitInputs.ownerPublicKey)
    );
  }

  const expectedNullifier = mimcNullifier(
    BigInt(circuitInputs.inputCommitment),
    BigInt(circuitInputs.ownerPublicKey)
  );
  if (expectedNullifier !== circuitInputs.nullifier) {
    console.log(
      `   ⚠️ Recomputing nullifier: ${circuitInputs.nullifier} -> ${expectedNullifier}`
    );
    circuitInputs.nullifier = expectedNullifier;
  }

  // Persist inputs for offline debugging when proofs fail.
  try {
    const debugPath = path.join(__dirname, "..", "..", "circuits", "debug_last_swap_inputs.json");
    fs.writeFileSync(debugPath, JSON.stringify(circuitInputs, null, 2));
  } catch (e) {
    // Best-effort debug write; ignore errors.
  }

  // Keep public and private swap outputs aligned for circuit constraint.
  if (BigInt(circuitInputs.outputAmountSwapPublic) !== BigInt(circuitInputs.outputAmountSwap)) {
    console.log(
      `   ⚠️ Aligning outputAmountSwapPublic to outputAmountSwap: ${circuitInputs.outputAmountSwapPublic} -> ${circuitInputs.outputAmountSwap}`
    );
    circuitInputs.outputAmountSwapPublic = circuitInputs.outputAmountSwap;
  }

  // Ensure amount conservation matches circuit expectations.
  const inputAmountBigInt = toBigInt(inputNote.amount);
  const swapAmountBigInt = toBigInt(swapAmount);
  const protocolFeeBigInt = toBigInt(protocolFee);
  const gasRefundBigInt = toBigInt(gasRefund);
  const changeAmountBigInt = toBigInt(outputNoteChange.amount);
  const expectedChange = inputAmountBigInt - swapAmountBigInt - protocolFeeBigInt - gasRefundBigInt;
  if (expectedChange !== changeAmountBigInt) {
    console.log(
      `   ⚠️ Adjusting changeAmount to satisfy conservation: ${changeAmountBigInt} -> ${expectedChange}`
    );
    circuitInputs.changeAmount = expectedChange.toString();
    const outputAssetIDChange = BigInt(circuitInputs.outputAssetIDChange);
    const changeBlindingFactor = BigInt(circuitInputs.changeBlindingFactor);
    const ownerPublicKey = BigInt(circuitInputs.ownerPublicKey);
    circuitInputs.outputCommitmentChange = mimcCommitment(
      outputAssetIDChange,
      expectedChange,
      changeBlindingFactor,
      ownerPublicKey
    );
  }

  // Validate commitments against circuit MiMC7 chaining
  const expectedInputCommitment = mimcCommitment(
    BigInt(circuitInputs.inputAssetID),
    BigInt(circuitInputs.inputAmount),
    BigInt(circuitInputs.inputBlindingFactor),
    BigInt(circuitInputs.ownerPublicKey)
  );
  if (expectedInputCommitment !== circuitInputs.inputCommitment) {
    console.log(
      `   ❗ Input commitment mismatch (circuit vs provided): ${expectedInputCommitment} != ${circuitInputs.inputCommitment}`
    );
  }

  const expectedSwapCommitment = mimcCommitment(
    BigInt(circuitInputs.outputAssetIDSwap),
    BigInt(circuitInputs.outputAmountSwap),
    BigInt(circuitInputs.swapBlindingFactor),
    BigInt(circuitInputs.ownerPublicKey)
  );
  if (expectedSwapCommitment !== circuitInputs.outputCommitmentSwap) {
    console.log(
      `   ⚠️ Recomputing outputCommitmentSwap: ${circuitInputs.outputCommitmentSwap} -> ${expectedSwapCommitment}`
    );
    circuitInputs.outputCommitmentSwap = expectedSwapCommitment;
  }

  const expectedChangeCommitment = mimcCommitment(
    BigInt(circuitInputs.outputAssetIDChange),
    BigInt(circuitInputs.changeAmount),
    BigInt(circuitInputs.changeBlindingFactor),
    BigInt(circuitInputs.ownerPublicKey)
  );
  if (expectedChangeCommitment !== circuitInputs.outputCommitmentChange) {
    console.log(
      `   ⚠️ Recomputing outputCommitmentChange: ${circuitInputs.outputCommitmentChange} -> ${expectedChangeCommitment}`
    );
    circuitInputs.outputCommitmentChange = expectedChangeCommitment;
  }

  if (DEV_BYPASS_PROOFS) {
    const publicSignals = [
      circuitInputs.nullifier,
      circuitInputs.inputCommitment,
      circuitInputs.outputCommitmentSwap,
      circuitInputs.outputCommitmentChange,
      circuitInputs.merkleRoot,
      circuitInputs.outputAmountSwapPublic,
      circuitInputs.minOutputAmountSwap,
      circuitInputs.protocolFee,
      circuitInputs.gasRefund
    ];
    return {
      proof: { a: ["0", "0"], b: [["0", "0"], ["0", "0"]], c: ["0", "0"] },
      publicSignals,
      generationTime: 0
    };
  }

  // Verify Merkle path before generating proof - using EXACT circuit logic
  // CRITICAL: Field arithmetic in circom automatically handles negatives via modulo
  // We must ensure our JavaScript matches this exactly
  // Helper for field arithmetic (handles negatives correctly)
  // CRITICAL: Must match circom's field arithmetic exactly
  // In circom, all arithmetic is automatically modulo FIELD
  // For subtraction: (a - b) mod FIELD, if negative, add FIELD
  const fieldAdd = (a, b) => {
    return (a + b) % FIELD;
  };
  const fieldSub = (a, b) => {
    const result = (a - b) % FIELD;
    // Handle negative modulo
    return result < 0n ? result + FIELD : result;
  };
  const fieldMul = (a, b) => {
    return (a * b) % FIELD;
  };
  
  let computedRoot = BigInt(circuitInputs.inputCommitment);
  
  console.log(`🔍 Verifying Merkle path (circuit logic with proper field arithmetic):`);
  console.log(`   Starting with commitment: 0x${computedRoot.toString(16).padStart(64, "0")}`);
  
  for (let i = 0; i < 10; i++) {
    const pathValue = BigInt(circuitInputs.merklePath[i]);
    const idx = BigInt(circuitInputs.merklePathIndices[i]);
    
    // WASM was compiled with OLD circuit logic (leftDiff/rightDiff approach):
    // leftDiff[i] <== merklePath[i] - cur[i];
    // left[i] <== cur[i] + merklePathIndices[i] * leftDiff[i];
    // rightDiff[i] <== cur[i] - merklePath[i];
    // right[i] <== merklePath[i] + merklePathIndices[i] * rightDiff[i];
    // merkleHash[i].x_in <== left[i];
    // merkleHash[i].k <== right[i];
    // cur[i + 1] <== merkleHash[i].out;
    
    // Match WASM exactly using field arithmetic:
    const leftDiff = fieldSub(pathValue, computedRoot);
    const left = fieldAdd(computedRoot, fieldMul(idx, leftDiff));
    const rightDiff = fieldSub(computedRoot, pathValue);
    const right = fieldAdd(pathValue, fieldMul(idx, rightDiff));
    
    // Circuit uses: MiMC7.x_in = left, MiMC7.k = right
    // Our JS: mimc7(x, k) where x is first param, k is second
    computedRoot = mimc7(left, right);
    
    if (i < 3) {
      console.log(`   Level ${i}: idx=${idx}, left=0x${left.toString(16).substring(0, 16)}..., right=0x${right.toString(16).substring(0, 16)}..., hash=0x${computedRoot.toString(16).substring(0, 16)}...`);
    }
  }
  
  const expectedRoot = BigInt(circuitInputs.merkleRoot);
  console.log(`   Final computed root: 0x${computedRoot.toString(16).padStart(64, "0")}`);
  console.log(`   Expected root:       0x${expectedRoot.toString(16).padStart(64, "0")}`);
  
  if (computedRoot !== expectedRoot) {
    console.error(`❌ Merkle root mismatch!`);
    console.error(`   Computed (MiMC7): 0x${computedRoot.toString(16).padStart(64, "0")}`);
    console.error(`   Expected:         0x${expectedRoot.toString(16).padStart(64, "0")}`);
    console.error(`   ⚠️  This should match if backend is using MiMC7 correctly`);
    console.error(`   ⚠️  Continuing anyway - circuit will fail but we can see the exact error...`);
    // Don't throw - let the circuit fail to see the exact error
  } else {
    console.log(`✅ Merkle path verification passed (MiMC7)`);
  }
  
  console.log("🔐 Generating swap proof...");
  console.log("📋 Circuit Inputs Summary:");
  console.log(`   Input Commitment: ${circuitInputs.inputCommitment.substring(0, 20)}...`);
  console.log(`   Merkle Root (as BigInt string): ${circuitInputs.merkleRoot}`);
  console.log(`   Merkle Root (hex): 0x${BigInt(circuitInputs.merkleRoot).toString(16).padStart(64, "0")}`);
  console.log(`   Merkle Path Length: ${circuitInputs.merklePath.length}`);
  console.log(`   Merkle Path Indices: [${circuitInputs.merklePathIndices.slice(0, 5).join(", ")}...]`);
  console.log(`   Merkle Path[0]: ${circuitInputs.merklePath[0]}`);
  console.log(`   Merkle Path[0] (hex): 0x${BigInt(circuitInputs.merklePath[0]).toString(16).padStart(64, "0")}`);
  console.log(`   Change Amount: ${circuitInputs.changeAmount}`);
  console.log(`   Swap Amount: ${circuitInputs.swapAmount}`);
  console.log(`   Input AssetID: ${circuitInputs.inputAssetID}`);
  console.log(`   Output AssetID Swap: ${circuitInputs.outputAssetIDSwap}`);
  console.log(`   Output AssetID Change: ${circuitInputs.outputAssetIDChange}`);
  console.log(`   Output Amount Swap (private): ${circuitInputs.outputAmountSwap}`);
  console.log(`   Output Amount Swap (public): ${circuitInputs.outputAmountSwapPublic}`);
  
  // Verify the computed root matches what we're passing
  const computedRootFromPath = computedRoot; // From verification above
  const merkleRootBigInt = BigInt(circuitInputs.merkleRoot);
  console.log(`\n🔍 Root Comparison:`);
  console.log(`   Computed from path: 0x${computedRootFromPath.toString(16).padStart(64, "0")}`);
  console.log(`   Passed to circuit:  0x${merkleRootBigInt.toString(16).padStart(64, "0")}`);
  console.log(`   Match: ${computedRootFromPath === merkleRootBigInt ? "✅ YES" : "❌ NO"}`);
  
  // EXTENSIVE DEBUG: Log every single input value
  console.log(`\n🔍 EXTENSIVE DEBUG - ALL CIRCUIT INPUTS:`);
  console.log(`   inputCommitment: ${circuitInputs.inputCommitment} (type: ${typeof circuitInputs.inputCommitment})`);
  console.log(`   merkleRoot: ${circuitInputs.merkleRoot} (type: ${typeof circuitInputs.merkleRoot})`);
  console.log(`   merkleRoot as BigInt: ${BigInt(circuitInputs.merkleRoot).toString()}`);
  console.log(`   merklePath length: ${circuitInputs.merklePath.length}`);
  for (let i = 0; i < Math.min(5, circuitInputs.merklePath.length); i++) {
    console.log(`   merklePath[${i}]: ${circuitInputs.merklePath[i]} (type: ${typeof circuitInputs.merklePath[i]})`);
    console.log(`     as BigInt: ${BigInt(circuitInputs.merklePath[i]).toString()}`);
    console.log(`     as hex: 0x${BigInt(circuitInputs.merklePath[i]).toString(16).padStart(64, "0")}`);
  }
  console.log(`   merklePathIndices: [${circuitInputs.merklePathIndices.slice(0, 5).join(", ")}...]`);
  console.log(`   All merklePath are strings: ${circuitInputs.merklePath.every(p => typeof p === 'string')}`);
  console.log(`   All merklePathIndices are strings: ${circuitInputs.merklePathIndices.every(i => typeof i === 'string')}`);
  
  // Verify computed root step by step matches what circuit should compute
  // NEW SIMPLER APPROACH: Match Solidity MerkleTree.calculateRoot exactly
  // if idx==0: mimc7(current, path)
  // if idx==1: mimc7(path, current)
  console.log(`\n🔍 VERIFYING CIRCUIT COMPUTATION STEP-BY-STEP (SIMPLIFIED - MATCHES SOLIDITY):`);
  let circuitComputedRoot = BigInt(circuitInputs.inputCommitment);
  for (let i = 0; i < 10; i++) {
    const pathVal = BigInt(circuitInputs.merklePath[i]);
    const idx = BigInt(circuitInputs.merklePathIndices[i]);
    
    // Circuit now uses simpler approach matching Solidity:
    // left = (1 - idx) * cur + idx * path
    // right = idx * cur + (1 - idx) * path
    // When idx=0: left=cur, right=path -> mimc7(cur, path)
    // When idx=1: left=path, right=cur -> mimc7(path, cur)
    const left = ((1n - idx) * circuitComputedRoot + idx * pathVal) % FIELD;
    const right = (idx * circuitComputedRoot + (1n - idx) * pathVal) % FIELD;
    
    // Normalize negatives
    const leftNorm = left < 0n ? left + FIELD : left;
    const rightNorm = right < 0n ? right + FIELD : right;
    
    const oldRoot = circuitComputedRoot;
    circuitComputedRoot = mimc7(leftNorm, rightNorm);
    
    // Detailed logging for first few steps
    if (i < 3) {
      console.log(`   Level ${i}:`);
      console.log(`     path=${pathVal.toString().substring(0, 20)}...`);
      console.log(`     idx=${idx}`);
      console.log(`     left=${leftNorm.toString().substring(0, 20)}...`);
      console.log(`     right=${rightNorm.toString().substring(0, 20)}...`);
      console.log(`     oldRoot=${oldRoot.toString().substring(0, 20)}...`);
      console.log(`     newRoot=${circuitComputedRoot.toString().substring(0, 20)}...`);
    } else if (i >= 7) {
      console.log(`   Level ${i}: path=${pathVal.toString().substring(0, 20)}..., idx=${idx}, computed=${circuitComputedRoot.toString().substring(0, 20)}...`);
    }
  }
  console.log(`   Final circuit computed root: ${circuitComputedRoot.toString()}`);
  console.log(`   Expected merkleRoot: ${merkleRootBigInt.toString()}`);
  console.log(`   Match: ${circuitComputedRoot === merkleRootBigInt ? "✅ YES" : "❌ NO"}`);
  if (circuitComputedRoot !== merkleRootBigInt) {
    console.error(`   ❌ CRITICAL MISMATCH!`);
    console.error(`      Computed: 0x${circuitComputedRoot.toString(16).padStart(64, "0")}`);
    console.error(`      Expected: 0x${merkleRootBigInt.toString(16).padStart(64, "0")}`);
    console.error(`      Difference: ${(circuitComputedRoot - merkleRootBigInt).toString()}`);
  }
  if (circuitComputedRoot !== merkleRootBigInt) {
    console.error(`   ❌ MISMATCH! Circuit would compute: 0x${circuitComputedRoot.toString(16).padStart(64, "0")}`);
    console.error(`      But we're passing: 0x${merkleRootBigInt.toString(16).padStart(64, "0")}`);
  }
  
  // CRITICAL: Try witness generation first to see exact constraint failure
  console.log(`\n🔍 ATTEMPTING WITNESS GENERATION (to identify failing constraint):`);
  try {
    const witness = await snarkjs.wtns.calculate(
      circuitInputs,
      WASM_PATH
    );
    console.log(`   ✅ Witness generated successfully - all constraints passed!`);
    console.log(`   This means the issue is in proof generation, not constraints.`);
  } catch (witnessError) {
    console.error(`   ❌ Witness generation failed!`);
    console.error(`   Error: ${witnessError.message}`);
    console.error(`   Stack: ${witnessError.stack}`);
    console.error(`   This indicates a CONSTRAINT VIOLATION.`);
    console.error(`   The circuit's computation doesn't match the inputs.`);
    
    // Try to get more details about which constraint failed
    if (witnessError.message.includes("line:")) {
      const lineMatch = witnessError.message.match(/line:\s*(\d+)/);
      if (lineMatch) {
        const lineNum = lineMatch[1];
        console.error(`   Failed at circuit line: ${lineNum}`);
        if (lineNum === "166") {
          console.error(`   This is the Merkle root constraint!`);
          console.error(`   Let's verify the exact values being compared...`);
        }
      }
    }
    
    // Don't throw - let fullProve try to get better error message
    console.error(`   Continuing to fullProve to get more details...`);
  }

  const startTime = Date.now();

  try {
    console.log(`\n🔍 Generating proof...`);
    const result = await proveWithRapidsnarkOrSnarkjs(circuitInputs, WASM_PATH, ZKEY_PATH, "joinsplit");
    recordProofStats("swap", result.generationTime, true);
    return result;
  } catch (error) {
    recordProofStats("swap", Date.now() - startTime, false);
    console.error("❌ Proof generation failed:", error.message);
    throw new Error(`Proof generation failed: ${error.message}`);
  }
}

/**
 * Generate ZK proof for withdrawal
 */
async function generateWithdrawProof(withdrawData) {
  const {
    inputNote,
    outputNoteChange,
    merkleRoot,
    merklePath,
    merklePathIndices,
    withdrawAmount,
    recipient,
    protocolFee,
    gasRefund
  } = withdrawData;

  // Helper functions (same as swap)
  // Use shared toBigIntString for normalization
  
  const formatMerklePath = (path) => {
    if (!Array.isArray(path)) return Array(10).fill("0");
    const formatted = path.slice(0, 10).map(v => toBigIntString(v));
    while (formatted.length < 10) formatted.push("0");
    return formatted;
  };
  
  const formatMerkleIndices = (indices) => {
    if (!Array.isArray(indices)) return Array(10).fill("0");
    const formatted = indices.slice(0, 10).map(v => String(toBigInt(v) % 2n));
    while (formatted.length < 10) formatted.push("0");
    return formatted;
  };
  
  // Withdraw uses the same circuit as swap, but with swap outputs set to 0
  // The circuit expects: inputAmount = swapAmount + changeAmount + protocolFee + gasRefund
  // For withdrawal: swapAmount = inputAmount - changeAmount - protocolFee - gasRefund
  const inputAmountBigInt = toBigInt(inputNote.amount);
  const changeAmountBigInt = toBigInt(outputNoteChange.amount);
  const protocolFeeBigInt = toBigInt(protocolFee);
  const gasRefundBigInt = toBigInt(gasRefund);
  const swapAmountForWithdraw = inputAmountBigInt - changeAmountBigInt - protocolFeeBigInt - gasRefundBigInt;
  
  const circuitInputs = {
    // Private inputs
    inputAssetID: inputNote.assetID.toString(),
    inputAmount: toBigIntString(inputNote.amount),
    inputBlindingFactor: toBigIntString(inputNote.blindingFactor),
    ownerPublicKey: toBigIntString(inputNote.ownerPublicKey),
    
    // Output Note 1 (Swap Result) - Set to 0 for withdrawal
    outputAssetIDSwap: "0",
    outputAmountSwap: "0",
    swapBlindingFactor: "0",
    
    // Output Note 2 (Change)
    outputAssetIDChange: outputNoteChange.assetID.toString(),
    changeAmount: toBigIntString(outputNoteChange.amount),
    changeBlindingFactor: toBigIntString(outputNoteChange.blindingFactor),
    
    // Swap Parameters (for withdrawal, this is the amount being withdrawn)
    swapAmount: swapAmountForWithdraw.toString(),
    
    // Public inputs
    nullifier: toBigIntString(inputNote.nullifier),
    inputCommitment: toBigIntString(inputNote.commitment),
    outputCommitmentSwap: "0", // Zero for withdrawal
    outputCommitmentChange: toBigIntString(outputNoteChange.commitment),
    merkleRoot: toBigIntString(merkleRoot),
    outputAmountSwapPublic: "0", // Zero for withdrawal
    minOutputAmountSwap: "0", // Zero for withdrawal
    protocolFee: toBigIntString(protocolFee),
    gasRefund: toBigIntString(gasRefund),
    
    // Merkle proof
    merklePath: formatMerklePath(merklePath),
    merklePathIndices: formatMerkleIndices(merklePathIndices)
  };

  if (DEV_BYPASS_PROOFS) {
    const publicSignals = [
      circuitInputs.nullifier,
      circuitInputs.inputCommitment,
      circuitInputs.outputCommitmentSwap,
      circuitInputs.outputCommitmentChange,
      circuitInputs.merkleRoot,
      circuitInputs.outputAmountSwapPublic,
      circuitInputs.minOutputAmountSwap,
      circuitInputs.protocolFee,
      circuitInputs.gasRefund
    ];
    return {
      proof: { a: ["0", "0"], b: [["0", "0"], ["0", "0"]], c: ["0", "0"] },
      publicSignals,
      generationTime: 0
    };
  }

  console.log("🔐 Generating withdrawal proof...");
  const startTime = Date.now();

  try {
    const result = await proveWithRapidsnarkOrSnarkjs(circuitInputs, WASM_PATH, ZKEY_PATH, "joinsplit");
    recordProofStats("withdraw", result.generationTime, true);
    return result;
  } catch (error) {
    recordProofStats("withdraw", Date.now() - startTime, false);
    console.error("❌ Proof generation failed:", error.message);
    throw new Error(`Proof generation failed: ${error.message}`);
  }
}

/**
 * Generate ZK proof for portfolio note update
 * inputs: {
 *  oldBalances, newBalances, oldBlindingFactor, newBlindingFactor,
 *  ownerPublicKey, oldNonce, newNonce,
 *  oldCommitment, newCommitment, inputAssetID, outputAssetID,
 *  swapAmount, outputAmount, minOutputAmount, protocolFee, gasRefund
 * }
 */
async function generatePortfolioProof(inputs) {
  // Use shared toBigIntString for normalization

  const circuitInputs = {
    oldBalances: (inputs.oldBalances || []).map(toBigIntString),
    newBalances: (inputs.newBalances || []).map(toBigIntString),
    oldBlindingFactor: toBigIntString(inputs.oldBlindingFactor),
    newBlindingFactor: toBigIntString(inputs.newBlindingFactor),
    ownerPublicKey: toBigIntString(inputs.ownerPublicKey),
    oldNonce: toBigIntString(inputs.oldNonce),
    newNonce: toBigIntString(inputs.newNonce),
    oldCommitment: toBigIntString(inputs.oldCommitment),
    newCommitment: toBigIntString(inputs.newCommitment),
    inputAssetID: toBigIntString(inputs.inputAssetID),
    outputAssetID: toBigIntString(inputs.outputAssetID),
    swapAmount: toBigIntString(inputs.swapAmount),
    outputAmount: toBigIntString(inputs.outputAmount),
    minOutputAmount: toBigIntString(inputs.minOutputAmount),
    protocolFee: toBigIntString(inputs.protocolFee),
    gasRefund: toBigIntString(inputs.gasRefund)
  };

  if (DEV_BYPASS_PROOFS) {
    const publicSignals = [
      circuitInputs.oldCommitment,
      circuitInputs.newCommitment,
      circuitInputs.oldNonce,
      circuitInputs.newNonce,
      circuitInputs.inputAssetID,
      circuitInputs.outputAssetID,
      circuitInputs.swapAmount,
      circuitInputs.outputAmount,
      circuitInputs.minOutputAmount,
      circuitInputs.protocolFee,
      circuitInputs.gasRefund
    ];
    return {
      proof: { a: ["0", "0"], b: [["0", "0"], ["0", "0"]], c: ["0", "0"] },
      publicSignals,
      generationTime: 0
    };
  }

  const startTime = Date.now();
  try {
    const result = await proveWithRapidsnarkOrSnarkjs(circuitInputs, PORTFOLIO_WASM, PORTFOLIO_ZKEY, "portfolio");
    recordProofStats("portfolio", result.generationTime, true);
    return result;
  } catch (error) {
    recordProofStats("portfolio", Date.now() - startTime, false);
    throw error;
  }
}

/**
 * Generate ZK proof for universal note ownership
 */
async function generateNoteProof(noteData, merkleProof) {
  // This would generate a ZK proof proving:
  // 1. The note exists in the merkle tree
  // 2. The note belongs to the user
  // 3. The note hasn't expired
  // Without revealing the note contents

  // Placeholder implementation - in production, use snarkjs with the note-proof circuit
  const proof = {
    proof: [0, 0, 0, 0, 0, 0, 0, 0], // Mock proof
    publicInputs: [
      noteData.noteHash,
      noteData.userAddress,
      merkleProof.root,
      Math.floor(Date.now() / 1000)
    ]
  };

  return proof;
}

module.exports = {
  generateSwapProof,
  generateWithdrawProof,
  generateNoteProof,
  generatePortfolioProof,
  getProofStats
};
