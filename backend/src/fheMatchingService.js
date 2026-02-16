/**
 * FHE Matching Service
 * 
 * Handles FHE-encrypted order matching off-chain
 * - Receives encrypted orders
 * - Performs FHE computation to match orders
 * - Returns encrypted match results
 * 
 * Architecture:
 * - Runs on FHE stakers/validators
 * - Can use Zama fhEVM (when available) or custom FHE implementation
 * - Computes on encrypted data without decryption
 */

const express = require('express');
const { ethers } = require('ethers');
const router = express.Router();

// In-memory order book for internal FHE matching (key: "inputAssetID-outputAssetID" or "outputAssetID-inputAssetID")
const orderBook = new Map();
const MAX_ORDERS_PER_PAIR = 50;

function orderBookKey(inputAssetID, outputAssetID) {
  return `${inputAssetID}-${outputAssetID}`;
}

/**
 * Register an FHE order and check for a counter-order match.
 * @param {Object} order - FHE-encrypted order { fheEncryptedInputAmount, fheEncryptedMinOutput, inputAssetID, outputAssetID }
 * @returns {Promise<{ matched: boolean, matchResult?: Object }>}
 */
async function registerOrderAndTryMatch(order) {
  const key = orderBookKey(order.inputAssetID, order.outputAssetID);
  const reverseKey = orderBookKey(order.outputAssetID, order.inputAssetID);
  const reverseList = orderBook.get(reverseKey);
  if (reverseList && reverseList.length > 0) {
    const existing = reverseList[reverseList.length - 1];
    const result = await matchOrdersFHE(order, existing);
    if (result.matched) {
      reverseList.pop();
      if (reverseList.length === 0) orderBook.delete(reverseKey);
      else orderBook.set(reverseKey, reverseList);
      return { matched: true, matchResult: result };
    }
  }
  const list = orderBook.get(key) || [];
  list.push({ ...order, ts: Date.now() });
  if (list.length > MAX_ORDERS_PER_PAIR) list.shift();
  orderBook.set(key, list);
  return { matched: false };
}

/**
 * Match two FHE-encrypted orders
 * @param {Object} order1 - First order (FHE-encrypted)
 * @param {Object} order2 - Second order (FHE-encrypted)
 * @returns {Object} Match result
 */
async function matchOrdersFHE(order1, order2) {
  console.log('🔄 Matching FHE-encrypted orders...');
  
  // TODO: Use actual FHE library (Zama tfhe-rs or custom)
  // For now: Mock implementation
  
  // In production:
  // 1. Load FHE-encrypted data
  // 2. Perform FHE computation:
  //    - Check if asset IDs match (can be done on encrypted data)
  //    - Compare amounts (FHE comparison)
  //    - Compute swap output (FHE arithmetic)
  // 3. Return encrypted result
  
  // Mock: Check asset IDs match (these are not encrypted)
  const assetsMatch = 
    order1.inputAssetID === order2.outputAssetID &&
    order1.outputAssetID === order2.inputAssetID;
  
  if (!assetsMatch) {
    return {
      matched: false,
      fheEncryptedResult: '0x',
      executionId: ethers.ZeroHash
    };
  }
  
  // Mock: Assume amounts match (in production, use FHE comparison)
  // FHE computation would be:
  // matched = FHE_GT(order1.inputAmount, order2.minOutput) && 
  //           FHE_GT(order2.inputAmount, order1.minOutput)
  
  const executionId = ethers.keccak256(
    ethers.concat([
      ethers.toUtf8Bytes(order1.fheEncryptedInputAmount),
      ethers.toUtf8Bytes(order2.fheEncryptedInputAmount),
      ethers.toUtf8Bytes(Date.now().toString())
    ])
  );
  
  // Mock: Return encrypted match result
  const fheEncryptedResult = ethers.hexlify(
    ethers.toUtf8Bytes(`FHE_MATCH:${executionId}`)
  );
  
  console.log('✅ Orders matched via FHE');
  
  return {
    matched: true,
    fheEncryptedResult,
    executionId
  };
}

// API Endpoints

/**
 * POST /fhe/match
 * Match two FHE-encrypted orders
 */
router.post('/match', async (req, res) => {
  try {
    const { order1, order2 } = req.body;
    
    if (!order1 || !order2) {
      return res.status(400).json({ error: 'Missing order data' });
    }
    
    const result = await matchOrdersFHE(order1, order2);
    res.json(result);
  } catch (error) {
    console.error('❌ FHE matching error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /fhe/register
 * Register an FHE-encrypted order for internal matching. If a counter-order exists, returns match.
 */
router.post('/register', async (req, res) => {
  try {
    const order = req.body;
    if (!order || order.inputAssetID === undefined || order.outputAssetID === undefined) {
      return res.status(400).json({ error: 'Missing order or asset IDs' });
    }
    const { matched, matchResult } = registerOrderAndTryMatch(order);
    res.json({ matched, matchResult: matchResult || null });
  } catch (error) {
    console.error('❌ FHE register error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /fhe/health
 * Health check for FHE service
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'FHE Matching Service',
    fheEnabled: true,
    // TODO: Check if FHE library is loaded
    fheLibrary: 'mock' // 'zama' | 'custom' | 'mock'
  });
});

/**
 * POST /fhe/compute
 * Generic FHE computation endpoint
 */
router.post('/compute', async (req, res) => {
  try {
    const { operation, encryptedInputs } = req.body;
    
    if (!operation || !encryptedInputs) {
      return res.status(400).json({ error: 'Missing operation or inputs' });
    }
    
    // TODO: Perform actual FHE computation based on operation
    // Operations: 'match', 'add', 'compare', 'multiply', etc.
    
    console.log(`🔄 FHE computation: ${operation}`);
    
    // Mock result
    const result = {
      operation,
      fheEncryptedResult: ethers.hexlify(ethers.randomBytes(32)),
      executionId: ethers.keccak256(ethers.toUtf8Bytes(Date.now().toString()))
    };
    
    res.json(result);
  } catch (error) {
    console.error('❌ FHE computation error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
module.exports.registerOrderAndTryMatch = registerOrderAndTryMatch;