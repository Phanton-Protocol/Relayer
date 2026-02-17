require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { z } = require("zod");
const snarkjs = require("snarkjs");
const {
  initDb,
  saveIntent,
  getIntent,
  saveReceipt,
  getReceipt,
  listReceipts,
  saveQuote,
  exportAll,
  saveCommitment,
  listCommitments,
  getCommitment
} = require("./db");
const { mimc7 } = require("./mimc7");
const { toBigInt, toBigIntString } = require("./utils/bigint");
const ValidatorNetwork = require("./validatorNetwork");
const { generateSwapProof, generatePortfolioProof, getProofStats } = require("./zkProofs");
const fheMatchingRouter = require("./fheMatchingService");
const { registerOrderAndTryMatch } = require("./fheMatchingService");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: true, credentials: true }));
app.use("/fhe", fheMatchingRouter);

loadConfig();

const PORT = process.env.PORT || 5050;
const RPC_URL = process.env.RPC_URL;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const SHIELDED_POOL_ADDRESS = process.env.SHIELDED_POOL_ADDRESS;
const NOTE_STORAGE_ADDRESS = process.env.NOTE_STORAGE_ADDRESS;
const OFFCHAIN_ORACLE_ADDRESS = process.env.OFFCHAIN_ORACLE_ADDRESS;
const ORACLE_SIGNER_PRIVATE_KEY = process.env.ORACLE_SIGNER_PRIVATE_KEY;
const CHAIN_ID = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : 97;
const RELAYER_DRY_RUN = process.env.RELAYER_DRY_RUN === "true";
const DEV_BYPASS_VALIDATORS = process.env.DEV_BYPASS_VALIDATORS === "true";
const DEV_BYPASS_PROOFS = process.env.DEV_BYPASS_PROOFS === "true";
const SWAP_ADAPTOR_ADDRESS = process.env.SWAP_ADAPTOR_ADDRESS;
const RELAYER_STAKING_ADDRESS = process.env.RELAYER_STAKING_ADDRESS;
const VALIDATOR_COORDINATOR_WS_URL = process.env.VALIDATOR_COORDINATOR_WS_URL;
const QUOTE_MODE = process.env.QUOTE_MODE || (CHAIN_ID === 97 ? "mock" : "dex");
const PROVER_WASM = process.env.PROVER_WASM || path.join(__dirname, "..", "..", "circuits", "joinsplit_js", "joinsplit.wasm");
const PROVER_ZKEY = process.env.PROVER_ZKEY || path.join(__dirname, "..", "..", "circuits", "joinsplit_0001.zkey");
const DB_PATH = (process.env.VERCEL || process.env.RENDER) ? "/tmp/relayer.db" : (process.env.DB_PATH || path.join(__dirname, "..", "data", "relayer.db"));

const db = initDb(DB_PATH);

// Initialize Validator Network
const VALIDATOR_URLS = process.env.VALIDATOR_URLS
  ? process.env.VALIDATOR_URLS.split(',').map((u) => u.trim()).filter(Boolean)
  : []; // Set VALIDATOR_URLS on Render (e.g. https://phantom-validator.onrender.com)
const validatorNetwork = new ValidatorNetwork(VALIDATOR_URLS, 6600); // 66% threshold

const INTENT_DOMAIN = {
  name: "ShadowDeFiRelayer",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: SHIELDED_POOL_ADDRESS || ethers.ZeroAddress,
};
const DEPOSIT_DOMAIN = {
  name: "ShadowDeFiRelayer",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: SHIELDED_POOL_ADDRESS || ethers.ZeroAddress,
};

const INTENT_TYPES = {
  SwapIntent: [
    { name: "nullifier", type: "bytes32" },
    { name: "minOutputAmount", type: "uint256" },
    { name: "protocolFee", type: "uint256" },
    { name: "gasRefund", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
const DEPOSIT_TYPES = {
  Deposit: [
    { name: "depositor", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "commitment", type: "bytes32" },
    { name: "assetID", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const receipts = new Map();
const intents = new Map();
/** Pending shadow deposits: shadowAddress -> { depositor, token, amount, commitment, assetID, deadline } for sweeper */
const shadowDeposits = new Map();

/** Normalize address - frontend may send token objects with .address instead of string */
function toAddress(v) {
  if (!v) return ethers.ZeroAddress;
  if (typeof v === "string") return v;
  return (v?.address != null ? String(v.address) : ethers.ZeroAddress) || ethers.ZeroAddress;
}

function getShadowSeed({ depositor, commitment, deadline }) {
  return ethers.keccak256(ethers.concat([
    ethers.getBytes(ethers.isHexString(RELAYER_PRIVATE_KEY) ? RELAYER_PRIVATE_KEY : "0x" + Buffer.from(RELAYER_PRIVATE_KEY, "utf8").toString("hex")),
    ethers.getBytes(ethers.zeroPadValue(depositor, 32)),
    ethers.getBytes(commitment),
    ethers.toBeHex(deadline, 32),
  ]));
}

async function sweepShadowDeposit(shadowAddress, deposit) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const seed = getShadowSeed(deposit);
  const shadowSigner = new ethers.Wallet(seed, provider);
  const poolAbi = [
    "function depositForBNB(address depositor,bytes32 commitment,uint256 assetID) external payable",
    "function depositFor(address depositor,address token,uint256 amount,bytes32 commitment,uint256 assetID) external",
  ];
  const pool = new ethers.Contract(SHIELDED_POOL_ADDRESS, poolAbi, shadowSigner);

  if (deposit.token === ethers.ZeroAddress) {
    const feeWei = await getDepositFeeBNBWei();
    const totalValue = BigInt(deposit.amount) + feeWei;
    const tx = await pool.depositForBNB(
      deposit.depositor,
      deposit.commitment,
      deposit.assetID,
      { value: totalValue }
    );
    const receipt = await tx.wait();
    storeCommitmentsFromReceipt(receipt);
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber, from: shadowSigner.address };
  }

  const erc20Abi = [
    "function allowance(address owner,address spender) view returns (uint256)",
    "function approve(address spender,uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)"
  ];
  const token = new ethers.Contract(deposit.token, erc20Abi, shadowSigner);
  const allowance = await token.allowance(shadowSigner.address, SHIELDED_POOL_ADDRESS);
  if (allowance < BigInt(deposit.amount)) {
    const approveTx = await token.approve(SHIELDED_POOL_ADDRESS, deposit.amount);
    await approveTx.wait();
  }
  const tx = await pool.depositFor(
    deposit.depositor,
    deposit.token,
    deposit.amount,
    deposit.commitment,
    deposit.assetID
  );
  const receipt = await tx.wait();
  storeCommitmentsFromReceipt(receipt);
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, from: shadowSigner.address };
}
const poolInterface = new ethers.Interface([
  "event CommitmentAdded(bytes32 indexed commitment, uint256 index)",
  "event Deposit(address indexed depositor, address indexed token, uint256 assetID, uint256 amount, bytes32 commitment, uint256 commitmentIndex)",
  "event ShieldedSwapJoinSplit(bytes32 indexed nullifier, bytes32 indexed inputCommitment, bytes32 indexed outputCommitmentSwap, bytes32 outputCommitmentChange, uint256 inputAssetID, uint256 outputAssetIDSwap, uint256 outputAssetIDChange, uint256 inputAmount, uint256 swapAmount, uint256 changeAmount, uint256 outputAmountSwap, address relayer)",
  "event ShieldedWithdraw(bytes32 indexed nullifier, bytes32 indexed inputCommitment, bytes32 indexed outputCommitmentChange, address recipient, uint256 inputAssetID, uint256 withdrawAmount, uint256 changeAmount, address relayer)"
]);

const dexApiToken = "https://api.dexscreener.com/latest/dex/tokens/";
const DEPOSIT_FEE_USD = 2n * 10n ** 8n; // $2 (8 decimals)
const WBNB_BSC_MAINNET = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const WBNB_BSC_TESTNET = "0xae13d989dac2f0debff460ac112a837c89baa7cd";

async function getDepositFeeBNBWei() {
  const wbnb = CHAIN_ID === 56 ? WBNB_BSC_MAINNET : WBNB_BSC_TESTNET;
  const chainSlug = CHAIN_ID === 56 ? "bsc" : "bsc-testnet";
  try {
    const price = await getDexPriceUsd(wbnb, chainSlug);
    if (!price || price === 0n) throw new Error("No BNB price");
    return (DEPOSIT_FEE_USD * 10n ** 18n) / price;
  } catch (e) {
    const fallback = CHAIN_ID === 97 ? 3333333333333333n : 3333333333333333n; // ~$2 at $600/BNB
    return fallback;
  }
}

const quoteSchema = z.object({
  tokenIn: z.string(),
  tokenOut: z.string(),
  amountIn: z.string(),
  tokenInDecimals: z.number().int().min(0).max(36).optional(),
  tokenOutDecimals: z.number().int().min(0).max(36).optional(),
  slippageBps: z.number().int().min(0).max(2000).default(1000),
  chainSlug: z.string().optional(),
});

const intentSchema = z.object({
  userAddress: z.string(),
  nullifier: z.string(),
  minOutputAmount: z.string(),
  protocolFee: z.string(),
  gasRefund: z.string(),
  deadline: z.number().int(),
});

// Proof can be Solidity format: a/c as [x,y], b as [[x,y],[x,y]] (strings)
const proofShape = z.object({
  a: z.union([z.string(), z.tuple([z.string(), z.string()])]),
  b: z.union([z.string(), z.array(z.array(z.string()).length(2)).length(2)]),
  c: z.union([z.string(), z.tuple([z.string(), z.string()])]),
}).passthrough();

const swapSchema = z.object({
  intentId: z.string(),
  intent: intentSchema,
  intentSig: z.string(),
  swapData: z.object({
    proof: proofShape,
    publicInputs: z.any(),
    swapParams: z.any(),
    relayer: z.string().optional(),
    encryptedPayload: z.string().optional(),
  }),
});

// Use shared toBigIntString from utils/bigint

const normalizeMerklePath = (path) => {
  if (!Array.isArray(path)) return Array(10).fill("0");
  const formatted = path.slice(0, 10).map((v) => toBigIntString(v));
  while (formatted.length < 10) formatted.push("0");
  return formatted;
};

const normalizeMerkleIndices = (indices) => {
  if (!Array.isArray(indices)) return Array(10).fill("0");
  const formatted = indices.slice(0, 10).map((v) => String(toBigInt(v) % 2n));
  while (formatted.length < 10) formatted.push("0");
  return formatted;
};

const normalizeJoinSplitPublicInputs = (pi, label) => {
  const merklePath = normalizeMerklePath(pi.merklePath);
  const merklePathIndices = normalizeMerkleIndices(pi.merklePathIndices);
  const count = 15 + merklePath.length + merklePathIndices.length;
  if (count !== 35) {
    throw new Error(`${label}: publicInputs must be 35 elements (got ${count})`);
  }
  return { merklePath, merklePathIndices };
};

const buildJoinSplitPublicSignals = (pi) => ([
  toBigIntString(pi.nullifier),
  toBigIntString(pi.inputCommitment),
  toBigIntString(pi.outputCommitmentSwap),
  toBigIntString(pi.outputCommitmentChange),
  toBigIntString(pi.merkleRoot),
  toBigIntString(pi.outputAmountSwap),
  toBigIntString(pi.minOutputAmountSwap),
  toBigIntString(pi.protocolFee),
  toBigIntString(pi.gasRefund)
]);

const computeMerkleRootFromPath = (leafValue, merklePath, merklePathIndices) => {
  let current = toBigInt(leafValue);
  for (let i = 0; i < 10; i++) {
    const pathVal = toBigInt(merklePath[i] ?? "0");
    const idx = toBigInt(merklePathIndices[i] ?? "0");
    if (idx === 0n) {
      current = mimc7(current, pathVal);
    } else {
      current = mimc7(pathVal, current);
    }
  }
  return current;
};

const fetchMerkleProofFromChain = async (commitment) => {
  if (!RPC_URL || !SHIELDED_POOL_ADDRESS) {
    throw new Error("RPC_URL/SHIELDED_POOL_ADDRESS not configured");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const abi = [
    "function commitmentCount() view returns (uint256)",
    "function commitments(uint256) view returns (bytes32)"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, provider);
  const count = Number(await contract.commitmentCount());
  const commitments = [];
  for (let i = 0; i < count; i += 1) {
    commitments.push(await contract.commitments(i));
  }
  const targetIndex = commitments.findIndex((c) => c.toLowerCase() === String(commitment).toLowerCase());
  if (targetIndex === -1) {
    throw new Error(`Commitment not found on-chain: ${commitment}`);
  }
  const { path, indices, root } = buildMerklePath(commitments, targetIndex);
  return { merklePath: path, merklePathIndices: indices, merkleRoot: root };
};

const withdrawSchema = z.object({
  withdrawData: z.object({
    proof: proofShape,
    publicInputs: z.any(),
    relayer: z.string().optional(),
    recipient: z.string(),
    encryptedPayload: z.string().optional(),
  }),
});

const depositSchema = z.object({
  depositor: z.string(),
  token: z.string(),
  amount: z.string(),
  commitment: z.string(),
  assetID: z.number().int(),
  deadline: z.number().int(),
  signature: z.string(),
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/deposit/required-fee-bnb", async (req, res) => {
  try {
    const feeWei = await getDepositFeeBNBWei();
    res.json({ feeWei: feeWei.toString(), feeUsd: "2" });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to get deposit fee" });
  }
});

app.post("/quote", async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { tokenIn, tokenOut, amountIn, tokenInDecimals, tokenOutDecimals, slippageBps, chainSlug } = parsed.data;

  // If SwapAdaptor is configured, use on-chain router quoting for exact output matching.
  if (SWAP_ADAPTOR_ADDRESS && RPC_URL) {
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const adaptorAbi = [
        "function getExpectedOutput((address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint24 fee,uint160 sqrtPriceLimitX96,bytes path)) view returns (uint256)"
      ];
      const adaptor = new ethers.Contract(SWAP_ADAPTOR_ADDRESS, adaptorAbi, provider);
      const amountInBn = parseAmount(amountIn);
      // Path can be provided by client by encoding address[] in swapParams.path; here we default to empty.
      const swapParams = {
        tokenIn,
        tokenOut,
        amountIn: amountInBn,
        minAmountOut: 0,
        fee: 0,
        sqrtPriceLimitX96: 0,
        path: req.body?.path || "0x"
      };
      const outAmount = BigInt((await adaptor.getExpectedOutput(swapParams)).toString());
      const minOut = (outAmount * BigInt(10000 - slippageBps)) / 10000n;
      const payload = {
        amountOut: outAmount.toString(),
        minAmountOut: minOut.toString(),
        priceIn: "0",
        priceOut: "0",
        fees: {
          oracleFee: "0",
          swapFee: "0",
          totalFee: "0",
          oracleFeeUsd: "0"
        }
      };
      saveQuote(db, ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload))), null, payload);
      return res.json(payload);
    } catch (e) {
      console.warn("On-chain quote via SwapAdaptor failed, falling back:", e.message);
    }
  }

  let priceIn;
  let priceOut;

  // Try DEXScreener API first for real-time prices
  try {
    priceIn = await getDexPriceUsd(tokenIn, chainSlug);
    priceOut = await getDexPriceUsd(tokenOut, chainSlug);
  } catch (dexError) {
    console.warn(`DEXScreener failed: ${dexError.message}, trying PancakeSwap fallback`);

    // Fallback: Use realistic mock prices for testnet (DEXScreener often doesn't have testnet data)
    const mockPrices = {
      "0x0000000000000000000000000000000000000000": 60000000000n, // BNB = $600
      "0xae13d989dac2f0debff460ac112a837c89baa7cd": 60000000000n, // WBNB = $600
      "0x7ef95a0fee0dd31b22626fa2e10ee6a223f8a684": 100000000n,   // tUSDT = $1
      "0x64544969ed7ebf5f083679233325356ebe738930": 100000000n,   // tUSDC = $1
      "0x78867bbeef44f2326bf8ddd1941a4439382ef2a7": 100000000n,   // tBUSD = $1
      "0xfa60d973f7642b748046464e165a65b7323b0dee": 500000000n,   // tCAKE = $5
      "0x8babbb98678facc7342735486c851abd7a0d17ca": 300000000000n, // tETH = $3000
      "0x6ce8da28e2f864420840cf74474eff5fd80e65b8": 6000000000000n, // tBTCB = $60000
      // Mainnet tokens (use real DEXScreener prices when available)
      "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": 60000000000n, // WBNB mainnet
      "0x55d398326f99059ff775485246999027b3197955": 100000000n,   // USDT mainnet
      "0xe9e7cea3dedca5984780bafc599bd69add087d56": 100000000n,   // BUSD mainnet
      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": 100000000n,   // USDC mainnet
      "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": 500000000n,   // CAKE mainnet
      "0x2170ed0880ac9a755fd29b2688956bd959f933f8": 300000000000n, // ETH mainnet
      "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c": 6000000000000n, // BTCB mainnet
    };

    priceIn = mockPrices[tokenIn.toLowerCase()] || 100000000n;
    priceOut = mockPrices[tokenOut.toLowerCase()] || 100000000n;

    console.log(`Using fallback prices: tokenIn=${tokenIn} @ $${Number(priceIn) / 1e8}, tokenOut=${tokenOut} @ $${Number(priceOut) / 1e8}`);
  }

  const amountInBn = parseAmount(amountIn);
  const inDecimals = BigInt(tokenInDecimals ?? 18);
  const outDecimals = BigInt(tokenOutDecimals ?? 18);
  const usdValue = (amountInBn * priceIn) / 10n ** inDecimals;
  const outAmount = (usdValue * 10n ** outDecimals) / priceOut;
  const minOut = (outAmount * BigInt(10000 - slippageBps)) / 10000n;
  const oracleFeeUsd = calcOracleFeeUsd(usdValue);
  const oracleFeeToken = (oracleFeeUsd * 10n ** inDecimals) / priceIn;
  const swapFeeToken = (amountInBn * 5n) / 100000n;
  const totalFeeToken = oracleFeeToken + swapFeeToken;

  const payload = {
    amountOut: outAmount.toString(),
    minAmountOut: minOut.toString(),
    priceIn: priceIn.toString(),
    priceOut: priceOut.toString(),
    fees: {
      oracleFee: oracleFeeToken.toString(),
      swapFee: swapFeeToken.toString(),
      totalFee: totalFeeToken.toString(),
      oracleFeeUsd: oracleFeeUsd.toString()
    }
  };
  saveQuote(db, ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload))), null, payload);
  res.json(payload);
});

app.post("/intent", async (req, res) => {
  const parsed = intentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const payload = parsed.data;
  const intentId = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify({ ...payload, t: Date.now() }))
  );
  intents.set(intentId, payload);
  saveIntent(db, intentId, payload.userAddress, payload);
  res.json({ intentId, intent: payload, domain: INTENT_DOMAIN, types: INTENT_TYPES });
});

app.post("/swap", async (req, res) => {
  const parsed = swapSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { intentId, intent, intentSig, swapData } = parsed.data;
  const cached = intents.get(intentId) || getIntent(db, intentId)?.payload;
  if (!cached) {
    return res.status(404).json({ error: "Unknown intentId" });
  }

  const signerAddr = ethers.verifyTypedData(INTENT_DOMAIN, INTENT_TYPES, intent, intentSig);
  if (signerAddr.toLowerCase() !== intent.userAddress.toLowerCase()) {
    return res.status(400).json({ error: "Invalid intent signature" });
  }

  // Register for internal FHE matching when encrypted payload is present
  try {
    const pi = swapData?.publicInputs || {};
    const enc = swapData?.encryptedPayload;
    if (enc && enc !== "0x" && enc.length > 10 && pi.inputAssetID != null && pi.outputAssetIDSwap != null) {
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const [fheEncryptedInputAmount, fheEncryptedMinOutput] = coder.decode(["bytes", "bytes"], enc);
      const { matched } = await registerOrderAndTryMatch({
        fheEncryptedInputAmount: ethers.hexlify(fheEncryptedInputAmount),
        fheEncryptedMinOutput: ethers.hexlify(fheEncryptedMinOutput),
        inputAssetID: String(pi.inputAssetID),
        outputAssetID: String(pi.outputAssetIDSwap)
      });
      if (matched) console.log("✅ Internal FHE match found (order book); executing via DEX path.");
    }
  } catch (e) {
    // Non-fatal
  }

  let txResult;
  try {
    txResult = RELAYER_DRY_RUN
      ? await simulateSwap(intentId)
      : await submitSwap(swapData);
  } catch (err) {
    console.error("[Swap] Error:", err.message);
    return res.status(500).json({ error: err.message || "swap failed" });
  }

  const receipt = buildReceipt(intentId, swapData, txResult);
  receipts.set(intentId, receipt);
  saveReceipt(db, intentId, intent.userAddress, receipt);

  res.json({
    version: "1.0",
    intentId,
    swapOutput: {
      amount: receipt.outputAmountSwap || "0",
      assetId: receipt.outputAssetIdSwap || 0,
      minAmount: intent.minOutputAmount,
    },
    commitments: {
      swap: receipt.outputCommitmentSwap || ethers.ZeroHash,
      change: receipt.outputCommitmentChange || ethers.ZeroHash,
    },
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    encryptedPayload: receipt.encryptedPayload,
  });
});

app.post("/withdraw", async (req, res) => {
  const parsed = withdrawSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { withdrawData } = parsed.data;
  try {
    const txResult = RELAYER_DRY_RUN
      ? await simulateSwap(ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(withdrawData))))
      : await submitWithdraw(withdrawData);
    res.json(txResult);
  } catch (err) {
    res.status(500).json({ error: err.message || "withdraw failed" });
  }
});

const portfolioSwapSchema = z.object({
  swapData: z.any()
}).passthrough();

app.post("/portfolio/swap", async (req, res) => {
  const parsed = portfolioSwapSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const txResult = await submitPortfolioSwap(parsed.data.swapData);
    res.json(txResult);
  } catch (err) {
    res.status(500).json({ error: err.message || "portfolio swap failed" });
  }
});

const portfolioDepositSchema = z.object({
  depositData: z.any()
}).passthrough();

app.post("/portfolio/deposit", async (req, res) => {
  const parsed = portfolioDepositSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const txResult = await submitPortfolioDeposit(parsed.data.depositData);
    res.json(txResult);
  } catch (err) {
    res.status(500).json({ error: err.message || "portfolio deposit failed" });
  }
});

const portfolioWithdrawSchema = z.object({
  withdrawData: z.any()
}).passthrough();

app.post("/portfolio/withdraw", async (req, res) => {
  const parsed = portfolioWithdrawSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const txResult = await submitPortfolioWithdraw(parsed.data.withdrawData);
    res.json(txResult);
  } catch (err) {
    res.status(500).json({ error: err.message || "portfolio withdraw failed" });
  }
});

app.get("/relayer/network", (req, res) => {
  res.json({
    rpcUrl: RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545",
    chainId: CHAIN_ID || 97
  });
});

app.get("/relayer", (req, res) => {
  if (!RELAYER_PRIVATE_KEY) return res.status(500).json({ error: "Relayer not configured" });
  const relayer = new ethers.Wallet(RELAYER_PRIVATE_KEY);
  res.json({
    relayer: relayer.address,
    dryRun: RELAYER_DRY_RUN,
    bypassValidators: DEV_BYPASS_VALIDATORS,
    bypassProofs: DEV_BYPASS_PROOFS,
    validatorUrls: VALIDATOR_URLS,
    coordinatorWsUrl: VALIDATOR_COORDINATOR_WS_URL || null
  });
});

app.get("/verification-key", (req, res) => {
  const vkPath = path.join(__dirname, "..", "..", "circuits", "verification_key.json");
  if (!fs.existsSync(vkPath)) return res.status(404).json({ error: "Verification key not found" });
  res.json(JSON.parse(fs.readFileSync(vkPath, "utf8")));
});

async function getStakingContract(provider) {
  let stakingAddr = RELAYER_STAKING_ADDRESS;
  if (!stakingAddr && SHIELDED_POOL_ADDRESS) {
    try {
      const pool = new ethers.Contract(SHIELDED_POOL_ADDRESS, ["function relayerRegistry() view returns (address)"], provider);
      stakingAddr = await pool.relayerRegistry();
    } catch (_) {}
  }
  if (!stakingAddr || stakingAddr === ethers.ZeroAddress) {
    throw new Error("Pool has no staking contract. Set RELAYER_STAKING_ADDRESS.");
  }
  return new ethers.Contract(stakingAddr, [
    "function totalStaked() view returns (uint256)",
    "function minStake() view returns (uint256)",
    "function token() view returns (address)",
    "function stakedBalance(address) view returns (uint256)",
    "function getRewardTokens() view returns (address[])"
  ], provider);
}

app.get("/staking/stats", async (req, res) => {
  if (!SHIELDED_POOL_ADDRESS || !RPC_URL) return res.status(500).json({ error: "Pool not configured" });
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const staking = await getStakingContract(provider);
    const [totalStaked, minStake, tokenAddr, rewardTokens] = await Promise.all([
      staking.totalStaked(),
      staking.minStake(),
      staking.token(),
      staking.getRewardTokens().catch(() => [])
    ]);
    res.json({
      stakingAddress: staking.target,
      protocolTokenAddress: tokenAddr,
      totalStaked: totalStaked.toString(),
      minStake: minStake.toString(),
      rewardTokenCount: rewardTokens?.length ?? 0
    });
  } catch (err) {
    console.error("[staking/stats]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/staking/balance", async (req, res) => {
  const addr = req.query.address;
  if (!addr || !ethers.isAddress(addr)) return res.status(400).json({ error: "Missing or invalid address" });
  if (!SHIELDED_POOL_ADDRESS || !RPC_URL) return res.status(500).json({ error: "Pool not configured" });
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const staking = await getStakingContract(provider);
    const [staked, minStake] = await Promise.all([
      staking.stakedBalance(addr),
      staking.minStake()
    ]);
    res.json({
      address: addr,
      staked: staked.toString(),
      minStake: minStake.toString(),
      isValid: staked >= minStake
    });
  } catch (err) {
    console.error("[staking/balance]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/relayer/proof-stats", (req, res) => {
  try {
    res.json(getProofStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/relayer/staking-status", async (req, res) => {
  if (!RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) return res.status(500).json({ error: "Relayer or pool not configured" });
  if (!RPC_URL) return res.status(500).json({ error: "RPC_URL not configured" });
  try {
    const relayer = new ethers.Wallet(RELAYER_PRIVATE_KEY);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    let stakingAddr = RELAYER_STAKING_ADDRESS;
    if (!stakingAddr) {
      try {
        const poolAbi = ["function relayerRegistry() view returns (address)"];
        const pool = new ethers.Contract(SHIELDED_POOL_ADDRESS, poolAbi, provider);
        stakingAddr = await pool.relayerRegistry();
      } catch (e) {
        return res.status(500).json({ error: `Pool read failed: ${e.message}. Check SHIELDED_POOL_ADDRESS and RPC_URL.` });
      }
      if (!stakingAddr || stakingAddr === ethers.ZeroAddress) {
        return res.status(500).json({ error: "Pool has no staking contract. Set RELAYER_STAKING_ADDRESS on Render (Environment)." });
      }
    }
    const stakingAbi = [
      "function stakedBalance(address) view returns (uint256)",
      "function minStake() view returns (uint256)",
      "function totalStaked() view returns (uint256)",
      "function isRelayer(address) view returns (bool)"
    ];
    const staking = new ethers.Contract(stakingAddr, stakingAbi, provider);
    const [staked, minStake, totalStaked, isValid] = await Promise.all([
      staking.stakedBalance(relayer.address),
      staking.minStake(),
      staking.totalStaked(),
      staking.isRelayer(relayer.address)
    ]);
    res.json({
      relayer: relayer.address,
      stakingAddress: stakingAddr,
      staked: staked.toString(),
      minStake: minStake.toString(),
      totalStaked: totalStaked.toString(),
      isRelayerValid: isValid
    });
  } catch (err) {
    console.error("[staking-status]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Portfolio swap fee: contract expects protocolFee = feeOracle.calculateFee + swapFee (0.005%)
app.get("/portfolio/swap-fee", async (req, res) => {
  if (!SHIELDED_POOL_ADDRESS || !RPC_URL) {
    return res.status(500).json({ error: "Pool not configured" });
  }
  try {
    const inputAssetId = parseInt(req.query.inputAssetId ?? "0", 10);
    const amount = req.query.amount ?? "0";
    const amountBigInt = BigInt(amount);
    if (amountBigInt === 0n) return res.json({ protocolFee: "0", swapFee: "0", totalProtocolFee: "0" });

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const poolAbi = [
      "function assetRegistry(uint256) view returns (address)",
      "function feeOracle() view returns (address)"
    ];
    const feeOracleAbi = ["function calculateFee(address token, uint256 amount) view returns (uint256)"];
    const pool = new ethers.Contract(SHIELDED_POOL_ADDRESS, poolAbi, provider);
    const inputToken = await pool.assetRegistry(inputAssetId);
    const feeOracleAddress = await pool.feeOracle();
    const feeOracle = new ethers.Contract(feeOracleAddress, feeOracleAbi, provider);

    let protocolFeeFromOracle = 0n;
    try {
      protocolFeeFromOracle = BigInt((await feeOracle.calculateFee(inputToken, amount)).toString());
      if (protocolFeeFromOracle > amountBigInt) protocolFeeFromOracle = amountBigInt; // FeeOracle caps to amount
    } catch (e) {
      console.warn("FeeOracle.calculateFee failed, using 0:", e.message);
    }
    const SWAP_FEE_NUMERATOR = 5n;
    const SWAP_FEE_DENOMINATOR = 100000n;
    const swapFee = (amountBigInt * SWAP_FEE_NUMERATOR) / SWAP_FEE_DENOMINATOR;
    const totalProtocolFee = protocolFeeFromOracle + swapFee;

    res.json({
      protocolFee: protocolFeeFromOracle.toString(),
      swapFee: swapFee.toString(),
      totalProtocolFee: totalProtocolFee.toString()
    });
  } catch (err) {
    console.error("swap-fee error:", err);
    res.status(500).json({ error: err.message || "Failed to compute swap fee" });
  }
});

app.post("/shadow-address", async (req, res) => {
  const parsed = depositSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (!SHIELDED_POOL_ADDRESS || !RELAYER_PRIVATE_KEY || !RPC_URL) {
    return res.status(500).json({ error: "Relayer env not configured" });
  }
  const payload = parsed.data;
  if (payload.deadline < Math.floor(Date.now() / 1000)) {
    return res.status(400).json({ error: "Deposit request expired" });
  }
  const signerAddr = ethers.verifyTypedData(DEPOSIT_DOMAIN, DEPOSIT_TYPES, {
    depositor: payload.depositor,
    token: payload.token,
    amount: payload.amount,
    commitment: payload.commitment,
    assetID: Number(payload.assetID),
    deadline: payload.deadline,
  }, payload.signature);
  if (signerAddr.toLowerCase() !== payload.depositor.toLowerCase()) {
    return res.status(400).json({ error: "Invalid deposit signature" });
  }
  const seed = getShadowSeed(payload);
  const shadowWallet = new ethers.Wallet(seed);
  const shadowAddress = shadowWallet.address;
  shadowDeposits.set(shadowAddress.toLowerCase(), {
    depositor: payload.depositor,
    token: payload.token,
    amount: payload.amount,
    commitment: payload.commitment,
    assetID: Number(payload.assetID),
    deadline: payload.deadline,
  });
  const out = { shadowAddress };
  if (payload.token === ethers.ZeroAddress) {
    try {
      out.feeWei = (await getDepositFeeBNBWei()).toString();
    } catch (_) {}
  }
  res.json(out);
});

app.post("/shadow-sweep", async (req, res) => {
  if (!SHIELDED_POOL_ADDRESS || !RELAYER_PRIVATE_KEY || !RPC_URL) {
    return res.status(500).json({ error: "Relayer env not configured" });
  }
  const { shadowAddress, commitment } = req.body || {};
  let entry;
  let entryAddress = shadowAddress;
  if (shadowAddress) {
    entry = shadowDeposits.get(String(shadowAddress).toLowerCase());
  } else if (commitment) {
    for (const [addr, data] of shadowDeposits.entries()) {
      if (String(data.commitment).toLowerCase() === String(commitment).toLowerCase()) {
        entry = data;
        entryAddress = addr;
        break;
      }
    }
  }
  if (!entry) {
    return res.status(404).json({ error: "Shadow deposit not found" });
  }
  if (entry.deadline < Math.floor(Date.now() / 1000)) {
    return res.status(400).json({ error: "Shadow deposit expired" });
  }
  try {
    const result = await sweepShadowDeposit(entryAddress, entry);
    shadowDeposits.delete(String(entryAddress).toLowerCase());
    res.json({ shadowAddress: entryAddress, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message || "Shadow sweep failed" });
  }
});

app.post("/deposit", async (req, res) => {
  const parsed = depositSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (!SHIELDED_POOL_ADDRESS || !RELAYER_PRIVATE_KEY || !RPC_URL) {
    return res.status(500).json({ error: "Relayer env not configured" });
  }
  const payload = parsed.data;
  if (payload.deadline < Math.floor(Date.now() / 1000)) {
    return res.status(400).json({ error: "Deposit expired" });
  }
  const signerAddr = ethers.verifyTypedData(DEPOSIT_DOMAIN, DEPOSIT_TYPES, {
    depositor: payload.depositor,
    token: payload.token,
    amount: payload.amount,
    commitment: payload.commitment,
    assetID: Number(payload.assetID),
    deadline: payload.deadline,
  }, payload.signature);
  if (signerAddr.toLowerCase() !== payload.depositor.toLowerCase()) {
    return res.status(400).json({ error: "Invalid deposit signature" });
  }
  const txResult = await submitDeposit(payload);
  res.json(txResult);
});

app.get("/receipt/:intentId", (req, res) => {
  const receipt = receipts.get(req.params.intentId) || getReceipt(db, req.params.intentId);
  if (!receipt) return res.status(404).json({ error: "Not found" });
  res.json(receipt);
});

app.get("/history/:address", (req, res) => {
  const address = req.params.address;
  const list = listReceipts(db, address, 50);
  res.json(list);
});

app.get("/export", (req, res) => {
  const data = exportAll(db);
  res.json(data);
});

app.get("/merkle/:commitment", async (req, res) => {
  try {
    const commitment = req.params.commitment;

    // ALWAYS sync commitments from the pool contract to ensure we have the latest state
    if (!RPC_URL || !SHIELDED_POOL_ADDRESS) {
      return res.status(500).json({ error: "RPC_URL/SHIELDED_POOL_ADDRESS not configured" });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const abi = [
      "function commitmentCount() view returns (uint256)",
      "function commitments(uint256) view returns (bytes32)",
      "function merkleRoot() view returns (bytes32)"
    ];
    const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, provider);

    // Get on-chain root for verification
    const onChainRoot = await contract.merkleRoot();

    // Sync ALL commitments from contract (in-memory first; persist to DB when writable)
    const count = Number(await contract.commitmentCount());
    console.log(`[Merkle] Syncing ${count} commitments from contract...`);

    try {
      const clearStmt = db.prepare("DELETE FROM commitments");
      clearStmt.run();
      console.log(`[Merkle] Cleared old commitments from database`);
    } catch (e) {
      console.log(`[Merkle] Note: Could not clear old commitments (using in-memory only): ${e.message}`);
    }

    const syncedCommitments = [];
    for (let i = 0; i < count; i += 1) {
      const c = await contract.commitments(i);
      try {
        saveCommitment(db, i, c, null);
      } catch (e) {
        // DB read-only: continue with in-memory list only
      }
      syncedCommitments.push({ idx: i, commitment: c });
      if (i < 3 || (i < 10 && i % 2 === 0) || i === count - 1) {
        console.log(`[Merkle]   [${i}]: ${c}`);
      }
    }
    console.log(`[Merkle] ✅ Synced ${count} commitments from contract`);

    if (syncedCommitments.length !== count) {
      throw new Error(`Failed to sync all commitments: got ${syncedCommitments.length}, expected ${count}`);
    }

    // Find the commitment in synced list (exact or case-insensitive)
    const row = syncedCommitments.find(r => r.commitment === commitment)
      || syncedCommitments.find(r => r.commitment.toLowerCase() === commitment.toLowerCase());
    if (!row) {
      console.error(`[Merkle] ❌ Commitment not found: ${commitment}`);
      return res.status(404).json({
        error: "commitment not found after sync",
        syncedCount: syncedCommitments.length,
        searched: commitment,
        available: syncedCommitments.map(r => r.commitment)
      });
    }

    // Use in-memory synced list for tree (always matches contract order)
    const commitments = syncedCommitments.sort((a, b) => Number(a.idx) - Number(b.idx)).map(r => r.commitment);
    console.log(`[Merkle] Building tree with ${commitments.length} commitments (contract has ${count}), looking for index ${row.idx}`);

    // Verify commitment at target index matches
    if (commitments[row.idx]?.toLowerCase() !== commitment.toLowerCase()) {
      console.error(`[Merkle] ❌ Commitment mismatch at index ${row.idx}`);
      console.error(`[Merkle]   Expected: ${commitment}`);
      console.error(`[Merkle]   Got: ${commitments[row.idx]}`);
      throw new Error(`Commitment mismatch at index ${row.idx}`);
    }

    // ALWAYS use MiMC7 - this is what the circuit requires (hardcoded in joinsplit.circom)
    // The circuit uses MiMC7 for Merkle tree verification, so we MUST use MiMC7 paths
    const { path, indices, root } = buildMerklePath(commitments, row.idx);

    const mimc7Match = root.toLowerCase() === onChainRoot.toLowerCase();

    console.log(`[Merkle] Built tree (MiMC7): root=${root.substring(0, 20)}...`);
    console.log(`[Merkle] On-chain root:      ${onChainRoot.substring(0, 20)}...`);
    console.log(`[Merkle] MiMC7 root matches: ${mimc7Match ? "✅ YES" : "❌ NO"}`);

    if (!mimc7Match) {
      console.error(`[Merkle] ❌ CRITICAL: MiMC7 root does not match on-chain root`);
      console.error(`[Merkle]   MiMC7 root: ${root}`);
      console.error(`[Merkle]   On-chain:   ${onChainRoot}`);
      return res.status(500).json({
        error: "merkle root mismatch",
        mimc7Root: root,
        onChainRoot
      });
    }

    console.log(`[Merkle] ✅ Contract uses MiMC7 - perfect match!`);
    res.json({
      commitment,
      index: row.idx,
      merkleRoot: root,
      merklePath: path,
      merklePathIndices: indices
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "merkle failed" });
  }
});

app.post("/oracle/update", async (req, res) => {
  const { tokenAddress, chainSlug } = req.body || {};
  if (!tokenAddress) return res.status(400).json({ error: "tokenAddress required" });
  if (!OFFCHAIN_ORACLE_ADDRESS || !ORACLE_SIGNER_PRIVATE_KEY || !RPC_URL) {
    return res.status(500).json({ error: "Oracle env not configured" });
  }

  const price = await getDexPriceUsd(tokenAddress, chainSlug);
  const tx = await updateOraclePrice(tokenAddress, price);
  res.json({ txHash: tx.hash, price: price.toString() });
});

app.post("/prove", async (req, res) => {
  const inputs = req.body;
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      inputs,
      PROVER_WASM,
      PROVER_ZKEY
    );
    const formatted = formatProofForContract(proof);
    res.json({ proof: formatted, publicSignals });
  } catch (err) {
    res.status(500).json({ error: err.message || "prove failed" });
  }
});

const portfolioProofSchema = z.object({
  oldBalances: z.array(z.any()),
  newBalances: z.array(z.any()),
  oldBlindingFactor: z.any(),
  newBlindingFactor: z.any(),
  ownerPublicKey: z.any(),
  oldNonce: z.any(),
  newNonce: z.any(),
  oldCommitment: z.any(),
  newCommitment: z.any(),
  inputAssetID: z.any(),
  outputAssetID: z.any(),
  swapAmount: z.any(),
  outputAmount: z.any(),
  minOutputAmount: z.any(),
  protocolFee: z.any(),
  gasRefund: z.any()
}).passthrough();

app.post("/portfolio/prove", async (req, res) => {
  const parsed = portfolioProofSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }
  try {
    const result = await generatePortfolioProof(parsed.data);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "portfolio prove failed" });
  }
});

// Schema for /swap/generate-proof: accepts backend (nested) or frontend (flattened) style
const generateProofBodySchema = z.object({
  // Nested (backend) style
  inputNote: z.object({
    assetID: z.union([z.string(), z.number()]),
    amount: z.union([z.string(), z.number()]),
    blindingFactor: z.string(),
    ownerPublicKey: z.string(),
    nullifier: z.string(),
    commitment: z.string(),
  }).optional(),
  outputNoteSwap: z.object({
    assetID: z.union([z.string(), z.number()]),
    amount: z.union([z.string(), z.number()]),
    blindingFactor: z.string(),
    commitment: z.string(),
  }).optional(),
  outputNoteChange: z.object({
    assetID: z.union([z.string(), z.number()]),
    amount: z.union([z.string(), z.number()]),
    blindingFactor: z.string(),
    commitment: z.string(),
  }).optional(),
  merkleRoot: z.string().optional(),
  merklePath: z.array(z.string()).optional(),
  merklePathIndices: z.array(z.union([z.string(), z.number()])).optional(),
  swapAmount: z.string().optional(),
  minOutputAmount: z.string().optional(),
  protocolFee: z.string().optional(),
  gasRefund: z.string().optional(),
  // Flattened (frontend) style – normalized to nested in handler
  inputAssetId: z.union([z.string(), z.number()]).optional(),
  inputAmount: z.string().optional(),
  inputBlinding: z.string().optional(),
  inputOwnerKey: z.string().optional(),
  nullifier: z.string().optional(),
  inputCommitment: z.string().optional(),
  outputAssetIdSwap: z.union([z.string(), z.number()]).optional(),
  outputAmountSwap: z.string().optional(),
  swapBlindingFactor: z.string().optional(),
  outputCommitmentSwap: z.string().optional(),
  outputAssetIdChange: z.union([z.string(), z.number()]).optional(),
  outputAmountChange: z.string().optional(),
  changeBlindingFactor: z.string().optional(),
  outputCommitmentChange: z.string().optional(),
  minOutputAmountSwap: z.string().optional(),
}).passthrough();

app.post("/swap/generate-proof", async (req, res) => {
  const parsed = generateProofBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }
  const body = parsed.data;
  const hasNested = body.inputNote && body.outputNoteSwap && body.outputNoteChange;
  const hasFlattened = body.inputAmount != null && body.inputBlinding != null && body.inputOwnerKey != null
    && body.nullifier != null && body.inputCommitment != null
    && body.outputAmountSwap != null && body.swapBlindingFactor != null && body.outputCommitmentSwap != null
    && body.outputAmountChange != null && body.changeBlindingFactor != null && body.outputCommitmentChange != null
    && body.merkleRoot != null && body.swapAmount != null;
  if (!hasNested && !hasFlattened) {
    return res.status(400).json({ error: "Invalid request", message: "Provide either (inputNote, outputNoteSwap, outputNoteChange) or flattened circuit inputs." });
  }
  let swapData;
  if (hasNested) {
    swapData = {
      inputNote: body.inputNote,
      outputNoteSwap: body.outputNoteSwap,
      outputNoteChange: body.outputNoteChange,
      merkleRoot: body.merkleRoot,
      merklePath: body.merklePath || [],
      merklePathIndices: body.merklePathIndices || [],
      swapAmount: body.swapAmount,
      minOutputAmount: body.minOutputAmount,
      protocolFee: body.protocolFee || "0",
      gasRefund: body.gasRefund || "0",
    };
  } else {
    swapData = {
      inputNote: {
        assetID: body.inputAssetId,
        amount: body.inputAmount,
        blindingFactor: body.inputBlinding,
        ownerPublicKey: body.inputOwnerKey,
        nullifier: body.nullifier,
        commitment: body.inputCommitment,
      },
      outputNoteSwap: {
        assetID: body.outputAssetIdSwap,
        amount: body.outputAmountSwap,
        blindingFactor: body.swapBlindingFactor,
        commitment: body.outputCommitmentSwap,
      },
      outputNoteChange: {
        assetID: body.outputAssetIdChange,
        amount: body.outputAmountChange,
        blindingFactor: body.changeBlindingFactor,
        commitment: body.outputCommitmentChange,
      },
      merkleRoot: body.merkleRoot,
      merklePath: body.merklePath || [],
      merklePathIndices: body.merklePathIndices || [],
      swapAmount: body.swapAmount,
      minOutputAmount: body.minOutputAmount || body.minOutputAmountSwap,
      protocolFee: body.protocolFee || "0",
      gasRefund: body.gasRefund || "0",
    };
  }
  try {
    const result = await generateSwapProof(swapData);
    res.json({ proof: result.proof, publicSignals: result.publicSignals, generationTime: result.generationTime });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: "Proof generation failed", message: err.message });
    }
  }
});

const dashboardDist = path.join(__dirname, "..", "..", "dist");
if (fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.get("*", (req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
}

function startServer(tryPort) {
  const server = app.listen(tryPort, () => {
    console.log(`Relayer API running on :${tryPort}`);
    console.log(`ShieldedPool: ${process.env.SHIELDED_POOL_ADDRESS || "(not set)"}`);
  });
  server.on("error", (err) => {
    const portNum = Number(tryPort);
    if (err.code === "EADDRINUSE" && portNum < Number(PORT) + 10) {
      console.warn(`Port ${tryPort} in use, trying ${portNum + 1}...`);
      startServer(portNum + 1);
    } else if (err.code === "EADDRINUSE") {
      console.error(`Port in use. Free it: netstat -ano | findstr ":5050" then taskkill /PID <pid> /F (run PowerShell as Administrator if needed)`);
      process.exit(1);
    } else {
      throw err;
    }
  });
}

if (!process.env.VERCEL) {
  startServer(PORT);
}

module.exports = { app };

async function getDexPriceUsd(tokenAddress, chainSlug) {
  const { data } = await axios.get(`${dexApiToken}${tokenAddress}`);
  if (!data?.pairs?.length) throw new Error("No Dexscreener pairs");
  const pairs = chainSlug ? data.pairs.filter((p) => p.chainId === chainSlug) : data.pairs;
  if (!pairs.length) throw new Error("No pairs for chain");
  const best = pairs.reduce((a, b) => {
    const la = Number(a?.liquidity?.usd || 0);
    const lb = Number(b?.liquidity?.usd || 0);
    return lb > la ? b : a;
  }, pairs[0]);
  if (!best?.priceUsd) throw new Error("No priceUsd");
  return BigInt(Math.floor(Number(best.priceUsd) * 1e8));
}

const encodeGroth16Proof = (proof) => {
  const coder = ethers.AbiCoder?.defaultAbiCoder
    ? ethers.AbiCoder.defaultAbiCoder()
    : ethers.utils.defaultAbiCoder;
  const a = [
    String(proof?.a?.[0] ?? 0),
    String(proof?.a?.[1] ?? 0)
  ];
  // Handle both nested [[a,b],[c,d]] and flat [a,b,c,d] pi_b formats from snarkjs
  let b;
  if (Array.isArray(proof?.b?.[0]) && Array.isArray(proof?.b?.[1])) {
    b = [
      [String(proof.b[0][0] ?? 0), String(proof.b[0][1] ?? 0)],
      [String(proof.b[1][0] ?? 0), String(proof.b[1][1] ?? 0)]
    ];
  } else if (Array.isArray(proof?.b) && proof.b.length >= 4) {
    const flat = proof.b;
    b = [
      [String(flat[0] ?? 0), String(flat[1] ?? 0)],
      [String(flat[2] ?? 0), String(flat[3] ?? 0)]
    ];
  } else {
    b = [
      [String(proof?.b?.[0]?.[0] ?? 0), String(proof?.b?.[0]?.[1] ?? 0)],
      [String(proof?.b?.[1]?.[0] ?? 0), String(proof?.b?.[1]?.[1] ?? 0)]
    ];
  }
  const c = [
    String(proof?.c?.[0] ?? 0),
    String(proof?.c?.[1] ?? 0)
  ];
  return {
    a: coder.encode(["uint256[2]"], [a]),
    b: coder.encode(["uint256[2][2]"], [b]),
    c: coder.encode(["uint256[2]"], [c])
  };
};

const getThresholdVerifier = async (signer) => {
  const poolAbi = ["function thresholdVerifier() view returns (address)"];
  const pool = new ethers.Contract(SHIELDED_POOL_ADDRESS, poolAbi, signer);
  return await pool.thresholdVerifier();
};

const submitThresholdValidations = async (signer, proof, publicSignals, signatures, label) => {
  const thresholdVerifierAddress = await getThresholdVerifier(signer);
  if (!thresholdVerifierAddress || thresholdVerifierAddress === ethers.ZeroAddress) {
    console.warn(`⚠️ Threshold verifier not set on pool (${label})`);
    return;
  }
  const usableSignatures = (signatures || []).filter((s) => s && s.timestamp != null);
  if (usableSignatures.length === 0) {
    console.warn(`⚠️ No usable validator signatures (${label})`);
    return;
  }
  const tvAbi = [
    "function submitValidations((bytes,bytes,bytes) proof, uint256[] publicInputs, (address validator, uint256 votingPower, bytes signature, uint256 timestamp)[] signatures, bool isValid)"
  ];
  const tv = new ethers.Contract(thresholdVerifierAddress, tvAbi, signer);
  const proofForTV = encodeGroth16Proof(proof);
  const proofTuple = [proofForTV.a, proofForTV.b, proofForTV.c];
  const pubInputs = publicSignals.map((x) => toBigInt(x));
  const formattedSignatures = usableSignatures.map((s) => ([
    s.validator,
    s.votingPower,
    s.signature,
    s.timestamp
  ]));
  const tx = await tv.submitValidations(proofTuple, pubInputs, formattedSignatures, true);
  await tx.wait();
  console.log(`✅ Submitted threshold validations (${label})`);
};

const submitSelfThresholdValidation = async (signer, proof, publicSignals, label) => {
  const thresholdVerifierAddress = await getThresholdVerifier(signer);
  if (!thresholdVerifierAddress || thresholdVerifierAddress === ethers.ZeroAddress) {
    console.warn(`⚠️ Threshold verifier not set on pool (${label})`);
    return;
  }
  const tvAbi = [
    "function submitValidations((bytes,bytes,bytes) proof, uint256[] publicInputs, (address validator, uint256 votingPower, bytes signature, uint256 timestamp)[] signatures, bool isValid)",
    "function stakingContract() view returns (address)"
  ];
  const tv = new ethers.Contract(thresholdVerifierAddress, tvAbi, signer);
  let stakingAddress;
  try {
    stakingAddress = await tv.stakingContract();
  } catch (e) {
    // Threshold verifier is a direct verifier (e.g. Groth16VerifierAdapter) - no staking, no validation submission needed
    console.warn(`⚠️ Threshold verifier has no stakingContract (direct verifier mode) - skipping validation submission`);
    return;
  }
  let votingPower = 0n;
  if (stakingAddress && stakingAddress !== ethers.ZeroAddress) {
    const stakingAbi = ["function stakedBalance(address) view returns (uint256)"];
    const staking = new ethers.Contract(stakingAddress, stakingAbi, signer);
    votingPower = await staking.stakedBalance(signer.address);
  }
  if (votingPower === 0n) {
    console.warn(`⚠️ Relayer has no voting power (${label})`);
    return;
  }

  const proofForTV = encodeGroth16Proof(proof);
  const pubInputs = publicSignals.map((x) => toBigInt(x));
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const proofHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes", "bytes", "bytes", "uint256[]"],
      [proofForTV.a, proofForTV.b, proofForTV.c, pubInputs]
    )
  );
  const messageHash = ethers.solidityPackedKeccak256(
    ["bytes32", "bool", "uint256"],
    [proofHash, true, timestamp]
  );
  const sig = await signer.signMessage(ethers.getBytes(messageHash));
  const flatSig = ethers.Signature.from(sig);
  const vByte = (flatSig.v >= 27 ? flatSig.v : flatSig.v + 27);
  const sigBytes = ethers.concat([flatSig.r, flatSig.s, ethers.toBeHex(vByte, 1)]);
  const validatorSig = {
    validator: signer.address,
    votingPower,
    signature: sigBytes,
    timestamp
  };
  await submitThresholdValidations(signer, proof, publicSignals, [validatorSig], label);
};

async function submitSwap(swapData) {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) {
    throw new Error("Relayer env not configured");
  }

  console.log("\n🔐 Phase 2: Collecting validator signatures...");

  const pi = swapData.publicInputs || {};
  const publicSignals = buildJoinSplitPublicSignals(pi);

  // STEP 1: Get validator consensus (MANDATORY)
  const validationResult = DEV_BYPASS_VALIDATORS
    ? { valid: true, signatures: [], reason: "DEV_BYPASS_VALIDATORS" }
    : await validatorNetwork.verifyProof(swapData.proof, publicSignals);

  if (!validationResult.valid) {
    throw new Error(`Validator consensus failed: ${validationResult.reason || 'Threshold not met'}`);
  }

  console.log(`✅ Validator consensus achieved (${validationResult.signatures.length} signatures)`);

  // STEP 2: Submit to contract with validator signatures
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const abi = [
    "function shieldedSwapJoinSplit(((bytes,bytes,bytes),(bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256[10],uint256[10]),(address,address,uint256,uint256,uint24,uint160,bytes),address,bytes,bytes32,uint256,uint256)) external"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);

  console.log("📤 Submitting transaction to ShieldedPool...");
  const toBytes32 = (v) => {
    if (v === undefined || v === null) return ethers.ZeroHash;
    const bi = toBigInt(v);
    return ethers.zeroPadValue(ethers.toBeHex(bi), 32);
  };
  const toU256 = (v) => toBigInt(v ?? "0");

  const { merklePath, merklePathIndices } = normalizeJoinSplitPublicInputs(pi, "swap");
  console.log(`📏 Swap public inputs count: ${15 + merklePath.length + merklePathIndices.length}`);
  const proofTuple = DEV_BYPASS_PROOFS
    ? ["0x", "0x", "0x"]
    : (() => {
        const encoded = encodeGroth16Proof(swapData.proof);
        return [encoded.a, encoded.b, encoded.c];
      })();
  const publicInputsTuple = [
    toBytes32(pi.nullifier),
    toBytes32(pi.inputCommitment),
    toBytes32(pi.outputCommitmentSwap),
    toBytes32(pi.outputCommitmentChange),
    toBytes32(pi.merkleRoot),
    toU256(pi.inputAssetID),
    toU256(pi.outputAssetIDSwap),
    toU256(pi.outputAssetIDChange),
    toU256(pi.inputAmount),
    toU256(pi.swapAmount),
    toU256(pi.changeAmount),
    toU256(pi.outputAmountSwap),
    toU256(pi.minOutputAmountSwap),
    toU256(pi.gasRefund),
    toU256(pi.protocolFee),
    merklePath.map((x) => toU256(x)),
    merklePathIndices.map((x) => toU256(x))
  ];
  const swapParamsTuple = [
    toAddress(swapData.swapParams?.tokenIn),
    toAddress(swapData.swapParams?.tokenOut),
    toU256(swapData.swapParams?.amountIn),
    toU256(swapData.swapParams?.minAmountOut),
    Number(swapData.swapParams?.fee || 0),
    toU256(swapData.swapParams?.sqrtPriceLimitX96 || 0),
    swapData.swapParams?.path || "0x"
  ];
  const swapDataForContract = [
    proofTuple,
    publicInputsTuple,
    swapParamsTuple,
    (swapData.relayer && swapData.relayer !== ethers.ZeroAddress) ? swapData.relayer : signer.address,
    swapData.encryptedPayload || "0x",
    ethers.ZeroHash,
    0,
    0
  ];

  if (DEV_BYPASS_VALIDATORS) {
    await submitSelfThresholdValidation(signer, swapData.proof, publicSignals, "swap bypass");
  } else if (validationResult.signatures.length > 0) {
    await submitThresholdValidations(signer, swapData.proof, publicSignals, validationResult.signatures, "swap");
  }

  const tx = await contract.shieldedSwapJoinSplit(swapDataForContract);

  console.log("⏳ Waiting for confirmation...");
  const receipt = await tx.wait();

  console.log(`✅ Transaction confirmed: ${receipt.hash}`);
  try {
    storeCommitmentsFromReceipt(receipt);
  } catch (e) {
    console.log(`[Swap] Could not store commitments: ${e.message}`);
  }

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    validatorSignatures: validationResult.signatures.length
  };
}

async function submitWithdraw(withdrawData) {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) {
    throw new Error("Relayer env not configured");
  }

  console.log("\n🔐 Phase 2: Collecting validator signatures for withdrawal...");

  const pi = withdrawData.publicInputs || {};
  const publicSignals = buildJoinSplitPublicSignals(pi);

  // STEP 1: Get validator consensus (MANDATORY)
  const validationResult = DEV_BYPASS_VALIDATORS
    ? { valid: true, signatures: [], reason: "DEV_BYPASS_VALIDATORS" }
    : await validatorNetwork.verifyProof(withdrawData.proof, publicSignals);

  if (!validationResult.valid) {
    throw new Error(`Validator consensus failed: ${validationResult.reason || 'Threshold not met'}`);
  }

  console.log(`✅ Validator consensus achieved (${validationResult.signatures.length} signatures)`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const toBytes32 = (v) => {
    if (v === undefined || v === null) return ethers.ZeroHash;
    const bi = toBigInt(v);
    return ethers.zeroPadValue(ethers.toBeHex(bi), 32);
  };
  const toU256 = (v) => toBigInt(v ?? "0");
  let { merklePath, merklePathIndices } = normalizeJoinSplitPublicInputs(pi, "withdraw");
  let merkleRoot = pi.merkleRoot;
  console.log(`📏 Withdraw public inputs count: ${15 + merklePath.length + merklePathIndices.length}`);

  const computedRoot = computeMerkleRootFromPath(pi.inputCommitment, merklePath, merklePathIndices);
  const expectedRoot = toBigInt(merkleRoot);
  if (computedRoot !== expectedRoot) {
    console.warn("⚠️ Merkle proof mismatch for withdrawal inputs. Refreshing from chain...");
    const refreshed = await fetchMerkleProofFromChain(pi.inputCommitment);
    merklePath = normalizeMerklePath(refreshed.merklePath);
    merklePathIndices = normalizeMerkleIndices(refreshed.merklePathIndices);
    merkleRoot = refreshed.merkleRoot;
  }

  if (DEV_BYPASS_VALIDATORS) {
    await submitSelfThresholdValidation(signer, withdrawData.proof, publicSignals, "withdraw bypass");
  } else if (validationResult.signatures.length > 0) {
    await submitThresholdValidations(signer, withdrawData.proof, publicSignals, validationResult.signatures, "withdraw");
  }

  // STEP 2: Submit to contract
  const abi = [
    "function shieldedWithdraw(((bytes,bytes,bytes),(bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256[10],uint256[10]),address,address,bytes)) external"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);

  console.log("📤 Submitting withdrawal to ShieldedPool...");
  const withdrawProofTuple = DEV_BYPASS_PROOFS
    ? ["0x", "0x", "0x"]
    : (() => {
        const encoded = encodeGroth16Proof(withdrawData.proof);
        return [encoded.a, encoded.b, encoded.c];
      })();
  const withdrawPublicInputsTuple = [
    toBytes32(pi.nullifier),
    toBytes32(pi.inputCommitment),
    toBytes32(pi.outputCommitmentSwap),
    toBytes32(pi.outputCommitmentChange),
    toBytes32(merkleRoot),
    toU256(pi.inputAssetID),
    toU256(pi.outputAssetIDSwap),
    toU256(pi.outputAssetIDChange),
    toU256(pi.inputAmount),
    toU256(pi.swapAmount),
    toU256(pi.changeAmount),
    toU256(pi.outputAmountSwap),
    toU256(pi.minOutputAmountSwap),
    toU256(pi.gasRefund),
    toU256(pi.protocolFee),
    merklePath.map((x) => toU256(x)),
    merklePathIndices.map((x) => toU256(x))
  ];
  const recipient = ethers.getAddress(withdrawData.recipient);
  const withdrawDataForContract = [
    withdrawProofTuple,
    withdrawPublicInputsTuple,
    recipient,
    (withdrawData.relayer && withdrawData.relayer !== ethers.ZeroAddress) ? withdrawData.relayer : signer.address,
    withdrawData.encryptedPayload || "0x"
  ];
  const tx = await contract.shieldedWithdraw(withdrawDataForContract);

  console.log("⏳ Waiting for confirmation...");
  const receipt = await tx.wait();

  console.log(`✅ Withdrawal confirmed: ${receipt.hash}`);
  try {
    storeCommitmentsFromReceipt(receipt);
  } catch (e) {
    console.log(`[Withdraw] Could not store commitments: ${e.message}`);
  }

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    validatorSignatures: validationResult.signatures.length
  };
}

async function submitPortfolioSwap(swapData) {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) {
    throw new Error("Relayer env not configured");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const abi = [
    "function portfolioSwap(((bytes,bytes,bytes),(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),(address,address,uint256,uint256,uint24,uint160,bytes),address,address,bytes)) external"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);

  const pi = swapData.publicInputs || {};
  const toBytes32 = (v) => {
    if (v === undefined || v === null) return ethers.ZeroHash;
    const bi = toBigInt(v);
    return ethers.zeroPadValue(ethers.toBeHex(bi), 32);
  };
  const toU256 = (v) => toBigInt(v ?? "0");
  const proofTuple = DEV_BYPASS_PROOFS
    ? ["0x", "0x", "0x"]
    : (() => {
        const encoded = encodeGroth16Proof(swapData.proof);
        return [encoded.a, encoded.b, encoded.c];
      })();
  const publicInputsTuple = [
    toBytes32(pi.oldCommitment),
    toBytes32(pi.newCommitment),
    toU256(pi.oldNonce),
    toU256(pi.newNonce),
    toU256(pi.inputAssetID),
    toU256(pi.outputAssetID),
    toU256(pi.swapAmount),
    toU256(pi.outputAmount),
    toU256(pi.minOutputAmount),
    toU256(pi.protocolFee),
    toU256(pi.gasRefund)
  ];
  const swapParamsTuple = [
    toAddress(swapData.swapParams?.tokenIn),
    toAddress(swapData.swapParams?.tokenOut),
    toU256(swapData.swapParams?.amountIn),
    toU256(swapData.swapParams?.minAmountOut),
    Number(swapData.swapParams?.fee || 0),
    toU256(swapData.swapParams?.sqrtPriceLimitX96 || 0),
    swapData.swapParams?.path || "0x"
  ];
  const dataForContract = [
    proofTuple,
    publicInputsTuple,
    swapParamsTuple,
    swapData.owner || signer.address,
    swapData.relayer || signer.address,
    swapData.encryptedPayload || "0x"
  ];
  try {
    const tx = await contract.portfolioSwap(dataForContract);
    const receipt = await tx.wait();
    let noteStored = false;
    const owner = swapData.owner || signer.address;
    if (NOTE_STORAGE_ADDRESS && swapData.encryptedNextNote) {
      try {
        const nsAbi = ["function storeNoteFor(address owner, bytes calldata encryptedNote) external"];
        const ns = new ethers.Contract(NOTE_STORAGE_ADDRESS, nsAbi, signer);
        const enc = typeof swapData.encryptedNextNote === "string" ? swapData.encryptedNextNote : ethers.hexlify(swapData.encryptedNextNote);
        await (await ns.storeNoteFor(owner, enc)).wait();
        noteStored = true;
      } catch (nsErr) {
        console.warn("[PortfolioSwap] NoteStorage.storeNoteFor failed:", nsErr.message);
      }
    }
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber, noteStored };
  } catch (err) {
    const decoded = decodeSwapError(err);
    console.error("[PortfolioSwap] Revert:", decoded);
    throw new Error(decoded || err.message || "Portfolio swap failed");
  }
}

/** Decode common revert reasons from portfolio swap failures */
function decodeSwapError(err) {
  const msg = err.reason || err.shortMessage || err.message || "";
  if (!err?.data) return msg;
  const data = typeof err.data === "string" ? err.data : err.data?.data || err.data;
  if (!data || data === "0x") return msg;
  if (data.length >= 74) {
    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint8"], "0x" + data.slice(10, 74));
      const code = Number(decoded[0]);
      const codes = {
        5: "PoolErr(5): Protocol fee mismatch — backend fee ≠ contract. Check /portfolio/swap-fee and FeeOracle.",
        6: "PoolErr(6): Invalid proof — verify proof inputs and circuit match.",
        11: "PoolErr(11): Invalid asset — assetRegistry not set for this assetId.",
        15: "PoolErr(15): Slippage exceeded — swap output < minOutputAmount. Increase slippage or retry.",
        24: "PoolErr(24): Portfolio state mismatch — commitment/nonce changed. Refresh and rebuild proof.",
        25: "PoolErr(25): Invalid nonce — newNonce must equal oldNonce + 1."
      };
      return codes[code] || `PoolErr(${code})`;
    } catch (_) {}
  }
  if (typeof data === "string" && data.includes("PancakeRouter")) return "PancakeSwap: Output < minAmountOut. Price moved or wrong path. Increase slippage.";
  if (msg.includes("FeeOracle")) return "FeeOracle: " + (msg || "Oracle price stale or missing.");
  if (msg.includes("PancakeSwapAdaptor")) return "Adaptor: " + (msg || "Swap failed.");
  return msg;
}

async function submitPortfolioDeposit(depositData) {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) {
    throw new Error("Relayer env not configured");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const readAbi = [
    "function userPortfolioCommitment(address) view returns (bytes32)",
    "function userPortfolioNonce(address) view returns (uint256)"
  ];
  const readContract = new ethers.Contract(SHIELDED_POOL_ADDRESS, readAbi, provider);
  const owner = depositData.owner || signer.address;
  const [storedCommitment, storedNonce] = await Promise.all([
    readContract.userPortfolioCommitment(owner),
    readContract.userPortfolioNonce(owner)
  ]);
  const pi = depositData.publicInputs || {};
  const expectedOldCommitment = storedCommitment === ethers.ZeroHash ? ethers.ZeroHash : storedCommitment;
  const expectedOldNonce = Number(storedNonce);
  const toBytes32ForCmp = (v) => {
    if (v === undefined || v === null) return ethers.ZeroHash;
    const bi = toBigInt(v);
    return ethers.zeroPadValue(ethers.toBeHex(bi), 32);
  };
  const sentOldCommitment = toBytes32ForCmp(pi.oldCommitment);
  const sentOldNonce = Number(toBigInt(pi.oldNonce ?? "0"));
  if (sentOldCommitment !== expectedOldCommitment || sentOldNonce !== expectedOldNonce) {
    throw new Error(
      `Portfolio state mismatch (PoolErr 24): on-chain commitment=${expectedOldCommitment}, nonce=${expectedOldNonce}; ` +
      `sent commitment=${sentOldCommitment}, nonce=${sentOldNonce}. Ensure frontend fetches on-chain state before building proof.`
    );
  }
  const abi = [
    "function portfolioDeposit(address,uint256,((bytes,bytes,bytes),(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),(address,address,uint256,uint256,uint24,uint160,bytes),address,address,bytes)) external payable"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);
  const toBytes32 = (v) => {
    if (v === undefined || v === null) return ethers.ZeroHash;
    const bi = toBigInt(v);
    return ethers.zeroPadValue(ethers.toBeHex(bi), 32);
  };
  const toU256 = (v) => toBigInt(v ?? "0");
  const proofTuple = DEV_BYPASS_PROOFS
    ? ["0x", "0x", "0x"]
    : (() => {
        const encoded = encodeGroth16Proof(depositData.proof);
        return [encoded.a, encoded.b, encoded.c];
      })();
  const publicInputsTuple = [
    toBytes32(pi.oldCommitment),
    toBytes32(pi.newCommitment),
    toU256(pi.oldNonce),
    toU256(pi.newNonce),
    toU256(pi.inputAssetID),
    toU256(pi.outputAssetID),
    toU256(pi.swapAmount),
    toU256(pi.outputAmount),
    toU256(pi.minOutputAmount),
    toU256(pi.protocolFee),
    toU256(pi.gasRefund)
  ];
  const swapParamsTuple = [
    toAddress(depositData.swapParams?.tokenIn),
    toAddress(depositData.swapParams?.tokenOut),
    toU256(depositData.swapParams?.amountIn || 0),
    toU256(depositData.swapParams?.minAmountOut || 0),
    Number(depositData.swapParams?.fee || 0),
    toU256(depositData.swapParams?.sqrtPriceLimitX96 || 0),
    depositData.swapParams?.path || "0x"
  ];
  const dataForContract = [
    proofTuple,
    publicInputsTuple,
    swapParamsTuple,
    depositData.owner || signer.address,
    depositData.relayer || signer.address,
    depositData.encryptedPayload || "0x"
  ];
  const tx = await contract.portfolioDeposit(
    depositData.token || ethers.ZeroAddress,
    toU256(depositData.amount || 0),
    dataForContract,
    { value: depositData.token === ethers.ZeroAddress ? toU256(depositData.amount || 0) : 0 }
  );
  const receipt = await tx.wait();
  let noteStored = false;
  if (NOTE_STORAGE_ADDRESS && depositData.encryptedNextNote) {
    try {
      const nsAbi = ["function storeNoteFor(address owner, bytes calldata encryptedNote) external"];
      const ns = new ethers.Contract(NOTE_STORAGE_ADDRESS, nsAbi, signer);
      const enc = typeof depositData.encryptedNextNote === "string" ? depositData.encryptedNextNote : ethers.hexlify(depositData.encryptedNextNote);
      await (await ns.storeNoteFor(owner, enc)).wait();
      noteStored = true;
    } catch (nsErr) {
      console.warn("[PortfolioDeposit] NoteStorage.storeNoteFor failed:", nsErr.message);
    }
  }
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, noteStored };
}

async function submitPortfolioWithdraw(withdrawData) {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) {
    throw new Error("Relayer env not configured");
  }
  if (!withdrawData?.proof || !withdrawData?.publicInputs) {
    throw new Error("portfolio withdraw requires proof and publicInputs");
  }
  if (!withdrawData.recipient || !ethers.isAddress(withdrawData.recipient)) {
    throw new Error("portfolio withdraw requires valid recipient address");
  }
  if (!withdrawData.owner || !ethers.isAddress(withdrawData.owner)) {
    throw new Error("portfolio withdraw requires valid owner address");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

  const pi = withdrawData.publicInputs || {};
  const toBytes32 = (v) => {
    if (v === undefined || v === null) return ethers.ZeroHash;
    const bi = toBigInt(v);
    return ethers.zeroPadValue(ethers.toBeHex(bi), 32);
  };
  const toU256 = (v) => toBigInt(v ?? "0");

  let proofEncoded;
  try {
    proofEncoded = DEV_BYPASS_PROOFS
      ? { a: "0x", b: "0x", c: "0x" }
      : encodeGroth16Proof(withdrawData.proof);
  } catch (e) {
    throw new Error(`Proof encoding failed: ${e.message}. Proof format: a=${Array.isArray(withdrawData.proof?.a) ? "array" : typeof withdrawData.proof?.a}, b=${Array.isArray(withdrawData.proof?.b) ? (Array.isArray(withdrawData.proof.b[0]) ? "nested" : "flat") : typeof withdrawData.proof?.b}`);
  }

  const dataForContract = {
    proof: { a: proofEncoded.a, b: proofEncoded.b, c: proofEncoded.c },
    publicInputs: {
      oldCommitment: toBytes32(pi.oldCommitment),
      newCommitment: toBytes32(pi.newCommitment),
      oldNonce: toU256(pi.oldNonce),
      newNonce: toU256(pi.newNonce),
      inputAssetID: toU256(pi.inputAssetID),
      outputAssetID: toU256(pi.outputAssetID),
      swapAmount: toU256(pi.swapAmount),
      outputAmount: toU256(pi.outputAmount),
      minOutputAmount: toU256(pi.minOutputAmount),
      protocolFee: toU256(pi.protocolFee),
      gasRefund: toU256(pi.gasRefund)
    },
    recipient: ethers.getAddress(withdrawData.recipient),
    owner: ethers.getAddress(withdrawData.owner || signer.address),
    relayer: ethers.getAddress(withdrawData.relayer || signer.address),
    encryptedPayload: withdrawData.encryptedPayload || "0x"
  };

  const artifactPath = path.join(__dirname, "..", "..", "artifacts", "contracts", "core", "ShieldedPool.sol", "ShieldedPool.json");
  const artifact = fs.existsSync(artifactPath) ? JSON.parse(fs.readFileSync(artifactPath, "utf8")) : null;
  const portfolioWithdrawAbi = artifact?.abi?.find((x) => x.type === "function" && x.name === "portfolioWithdraw");
  const abi = portfolioWithdrawAbi ? [portfolioWithdrawAbi] : [
    "function portfolioWithdraw((tuple(bytes a,bytes b,bytes c),tuple(bytes32 oldCommitment,bytes32 newCommitment,uint256 oldNonce,uint256 newNonce,uint256 inputAssetID,uint256 outputAssetID,uint256 swapAmount,uint256 outputAmount,uint256 minOutputAmount,uint256 protocolFee,uint256 gasRefund),address recipient,address owner,address relayer,bytes encryptedPayload)) external"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);

  const tx = await contract.portfolioWithdraw(dataForContract);
  const receipt = await tx.wait();
  let noteStored = false;
  const owner = ethers.getAddress(withdrawData.owner || signer.address);
  if (NOTE_STORAGE_ADDRESS && withdrawData.encryptedNextNote) {
    try {
      const nsAbi = ["function storeNoteFor(address owner, bytes calldata encryptedNote) external"];
      const ns = new ethers.Contract(NOTE_STORAGE_ADDRESS, nsAbi, signer);
      const enc = typeof withdrawData.encryptedNextNote === "string" ? withdrawData.encryptedNextNote : ethers.hexlify(withdrawData.encryptedNextNote);
      await (await ns.storeNoteFor(owner, enc)).wait();
      noteStored = true;
    } catch (nsErr) {
      console.warn("[PortfolioWithdraw] NoteStorage.storeNoteFor failed:", nsErr.message);
    }
  }
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, noteStored };
}

async function submitDeposit(payload) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

  // Shadow address flow: relayer deposits on behalf of user
  if (payload.token === ethers.ZeroAddress) {
    // BNB deposit via shadow address - value = amount + $2 fee
    const feeWei = await getDepositFeeBNBWei();
    const totalValue = BigInt(payload.amount) + feeWei;
    const abi = [
      "function depositForBNB(address depositor,bytes32 commitment,uint256 assetID) external payable"
    ];
    const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);
    const tx = await contract.depositForBNB(
      payload.depositor,
      payload.commitment,
      payload.assetID,
      { value: totalValue }
    );
    const receipt = await tx.wait();
    try {
      storeCommitmentsFromReceipt(receipt);
    } catch (e) {
      console.log(`[Deposit] Could not store commitments (e.g. read-only DB): ${e.message}`);
    }
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  } else {
    // ERC20 deposit via shadow address
    const abi = [
      "function depositFor(address depositor,address token,uint256 amount,bytes32 commitment,uint256 assetID) external"
    ];
    const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);
    const tx = await contract.depositFor(
      payload.depositor,
      payload.token,
      payload.amount,
      payload.commitment,
      payload.assetID
    );
    const receipt = await tx.wait();
    try {
      storeCommitmentsFromReceipt(receipt);
    } catch (e) {
      console.log(`[Deposit] Could not store commitments (e.g. read-only DB): ${e.message}`);
    }
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  }
}

function storeCommitmentsFromReceipt(receipt) {
  if (!receipt?.logs) return;
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== SHIELDED_POOL_ADDRESS?.toLowerCase()) continue;
    try {
      const parsed = poolInterface.parseLog(log);
      if (parsed?.name === "CommitmentAdded") {
        const commitment = parsed.args.commitment;
        const idx = Number(parsed.args.index);
        saveCommitment(db, idx, commitment, receipt.hash);
      }
      if (parsed?.name === "Deposit") {
        const commitment = parsed.args.commitment;
        const idx = Number(parsed.args.commitmentIndex);
        saveCommitment(db, idx, commitment, receipt.hash);
      }
    } catch (_) { }
  }
}

function buildLeaves(rows) {
  const depth = 10;
  const size = 1 << depth;
  const leaves = new Array(size).fill(0n);
  for (const row of rows) {
    const idx = Number(row.idx);
    if (idx >= 0 && idx < size) {
      leaves[idx] = toBigInt(row.commitment);
    }
  }
  return leaves;
}

// Rebuild tree using contract's _addCommitmentToTree() logic (keccak256 chain)
// This matches what the DEPLOYED contract uses for deposits
// Contract code: merkleRoot = keccak256(abi.encodePacked(merkleRoot, commitment, index));
function rebuildKeccak256Tree(commitments) {
  let root = ethers.ZeroHash; // Start with 0x0

  // Build the chain exactly as contract does
  for (let idx = 0; idx < commitments.length; idx++) {
    const commitment = commitments[idx];
    // Contract: merkleRoot = keccak256(abi.encodePacked(merkleRoot, commitment, index));
    const packed = ethers.solidityPacked(
      ["bytes32", "bytes32", "uint256"],
      [root, commitment, idx]
    );
    root = ethers.keccak256(packed);
  }

  return root;
}

// Rebuild tree using contract's IncrementalMerkleTree.insert() logic
// This matches what swaps/withdrawals use (tree.insert())
// Note: The deployed contract uses keccak256 for deposits, but swaps expect MiMC7
// This creates a mismatch - we need to use keccak256 to match the deployed contract
function rebuildIncrementalTree(commitments) {
  const depth = 10;

  // Initialize zeros (same as contract)
  const zeros = [0n];
  let currentZero = 0n;
  for (let i = 1; i < depth; i++) {
    currentZero = mimc7(currentZero, currentZero);
    zeros.push(currentZero);
  }

  // Initialize filledSubtrees (same as contract's storage)
  const filledSubtrees = new Array(depth).fill(null);

  // Store every node we compute so we can build paths to CURRENT root for any leaf
  // nodeValues[level][position] = value at that (level, position); level 0 = leaves
  const nodeValues = [];
  for (let i = 0; i <= depth; i++) nodeValues[i] = {};

  // Insert each commitment EXACTLY as contract's IncrementalMerkleTree.insert() does
  let root = zeros[depth - 1];

  for (let idx = 0; idx < commitments.length; idx++) {
    const leaf = toBigInt(commitments[idx]);
    nodeValues[0][idx] = leaf; // store leaf
    let currentHash = leaf;
    let currentIndex = idx;

    for (let i = 0; i < depth; i++) {
      if (currentIndex % 2 === 0) {
        filledSubtrees[i] = currentHash;
        currentHash = mimc7(currentHash, zeros[i]);
      } else {
        if (filledSubtrees[i] === null) {
          throw new Error(`filledSubtrees[${i}] is null for index ${idx} - tree state inconsistent`);
        }
        currentHash = mimc7(filledSubtrees[i], currentHash);
      }
      currentIndex = Math.floor(currentIndex / 2);
      const posAtNextLevel = idx >> (i + 1);
      nodeValues[i + 1][posAtNextLevel] = currentHash;
    }

    root = currentHash;
  }

  return { root, filledSubtrees, nodeValues, zeros };
}

// Build full Merkle tree (all levels) from commitments; used to get path to CURRENT root
function buildFullMerkleTree(commitments) {
  const depth = 10;
  const numLeaves = 1 << depth; // 1024
  const zeros = [0n];
  let currentZero = 0n;
  for (let i = 1; i < depth; i++) {
    currentZero = mimc7(currentZero, currentZero);
    zeros.push(currentZero);
  }
  // Level 0 = leaves
  const levels = [];
  const level0 = [];
  for (let i = 0; i < numLeaves; i++) {
    level0.push(i < commitments.length ? toBigInt(commitments[i]) : zeros[0]);
  }
  levels.push(level0);
  // Levels 1..depth-1: hash pairs
  for (let lev = 1; lev < depth; lev++) {
    const prev = levels[lev - 1];
    const size = prev.length >> 1;
    const curr = [];
    for (let j = 0; j < size; j++) {
      curr.push(mimc7(prev[2 * j], prev[2 * j + 1]));
    }
    levels.push(curr);
  }
  // Top level: single root
  const top = levels[depth - 1];
  const root = mimc7(top[0], top[1]);
  return { levels, zeros, root };
}

// Build Merkle path that verifies against the CURRENT root (incremental tree)
// Uses node values stored during rebuildIncrementalTree so path matches contract exactly
function buildMerklePath(commitments, targetIndex) {
  const depth = 10;
  if (targetIndex < 0 || targetIndex >= commitments.length) {
    throw new Error(`buildMerklePath: index ${targetIndex} out of range [0, ${commitments.length})`);
  }

  const { root, nodeValues, zeros } = rebuildIncrementalTree(commitments);

  const path = [];
  const indices = [];

  for (let i = 0; i < depth; i++) {
    const pos = targetIndex >> i;
    const siblingPos = pos ^ 1;
    const sibling = (nodeValues[i] && nodeValues[i][siblingPos] !== undefined)
      ? nodeValues[i][siblingPos]
      : zeros[i];
    path.push(`0x${sibling.toString(16).padStart(64, "0")}`);
    indices.push(pos % 2); // 0 = we are left, 1 = we are right
  }

  return { path, indices, root: `0x${root.toString(16).padStart(64, "0")}` };
}



async function simulateSwap(intentId) {
  const fake = ethers.keccak256(ethers.toUtf8Bytes(intentId));
  return { txHash: fake, blockNumber: 0 };
}

function buildReceipt(intentId, swapData, txResult) {
  const inputs = swapData.publicInputs || {};
  return {
    version: "1.0",
    intentId,
    nullifier: inputs.nullifier || ethers.ZeroHash,
    inputCommitment: inputs.inputCommitment || ethers.ZeroHash,
    outputCommitmentSwap: inputs.outputCommitmentSwap || ethers.ZeroHash,
    outputCommitmentChange: inputs.outputCommitmentChange || ethers.ZeroHash,
    inputAssetId: inputs.inputAssetID || 0,
    outputAssetIdSwap: inputs.outputAssetIDSwap || 0,
    outputAssetIdChange: inputs.outputAssetIDChange || 0,
    inputAmount: String(inputs.inputAmount || "0"),
    swapAmount: String(inputs.swapAmount || "0"),
    changeAmount: String(inputs.changeAmount || "0"),
    outputAmountSwap: String(inputs.outputAmountSwap || "0"),
    protocolFee: String(inputs.protocolFee || "0"),
    gasRefund: String(inputs.gasRefund || "0"),
    txHash: txResult.txHash,
    blockNumber: txResult.blockNumber,
    encryptedPayload: swapData.encryptedPayload || "0x",
    relayer: swapData.relayer || ethers.ZeroAddress,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function parseAmount(value) {
  if (typeof value !== "string") return BigInt(value);
  if (value.includes(".")) {
    return ethers.parseUnits(value, 18);
  }
  return BigInt(value);
}

function calcOracleFeeUsd(usdValue) {
  // Minimum fee: $10 (with 8 decimals = 10 * 10^8)
  const feeFloor = 10n * 10n ** 8n;
  // Percentage fee: 0.5% of USD value (5 / 1000 = 0.005 = 0.5%)
  const percentageFee = (usdValue * 5n) / 1000n;
  // Return whichever is higher
  return percentageFee > feeFloor ? percentageFee : feeFloor;
}

async function updateOraclePrice(tokenAddress, price) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(ORACLE_SIGNER_PRIVATE_KEY, provider);
  const oracleAbi = [
    "function updatePrice((address token,uint256 price,uint256 timestamp,uint256 nonce) update, bytes signature) external",
  ];
  const oracle = new ethers.Contract(OFFCHAIN_ORACLE_ADDRESS, oracleAbi, signer);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = timestamp;

  const domain = {
    name: "OffchainPriceOracle",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: OFFCHAIN_ORACLE_ADDRESS,
  };
  const types = {
    PriceUpdate: [
      { name: "token", type: "address" },
      { name: "price", type: "uint256" },
      { name: "timestamp", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const value = {
    token: tokenAddress,
    price: price.toString(),
    timestamp,
    nonce,
  };
  const signature = await signer.signTypedData(domain, types, value);
  return oracle.updatePrice(value, signature);
}

function loadConfig() {
  const cfgPath = path.join(__dirname, "..", "config.json");
  if (!fs.existsSync(cfgPath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    Object.entries(raw).forEach(([k, v]) => {
      if (process.env[k] === undefined) process.env[k] = String(v);
    });
    if (raw.SHIELDED_POOL_ADDRESS) {
      process.env.SHIELDED_POOL_ADDRESS = String(raw.SHIELDED_POOL_ADDRESS);
    }
    if (raw.RELAYER_STAKING_ADDRESS) {
      process.env.RELAYER_STAKING_ADDRESS = String(raw.RELAYER_STAKING_ADDRESS);
    }
    // PORT from config overrides env (avoids Chrome ERR_UNSAFE_PORT on 5060)
    if (raw.PORT != null) process.env.PORT = String(raw.PORT);
  } catch (_) { }
}

function formatProofForContract(proof) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const a = coder.encode(["uint256[2]"], [[proof.pi_a[0], proof.pi_a[1]]]);
  const b = coder.encode(
    ["uint256[2][2]"],
    [[[proof.pi_b[0][0], proof.pi_b[0][1]], [proof.pi_b[1][0], proof.pi_b[1][1]]]]
  );
  const c = coder.encode(["uint256[2]"], [[proof.pi_c[0], proof.pi_c[1]]]);
  return { a, b, c };
}
