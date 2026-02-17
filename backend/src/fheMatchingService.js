

const express = require('express');
const { ethers } = require('ethers');
const router = express.Router();

const orderBook = new Map();
const MAX_ORDERS_PER_PAIR = 50;

function orderBookKey(inputAssetID, outputAssetID) {
  return `${inputAssetID}-${outputAssetID}`;
}

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

async function matchOrdersFHE(order1, order2) {
  console.log('🔄 Matching FHE-encrypted orders...');

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

  const executionId = ethers.keccak256(
    ethers.concat([
      ethers.toUtf8Bytes(order1.fheEncryptedInputAmount),
      ethers.toUtf8Bytes(order2.fheEncryptedInputAmount),
      ethers.toUtf8Bytes(Date.now().toString())
    ])
  );

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

router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'FHE Matching Service',
    fheEnabled: true,

    fheLibrary: 'mock' 

  });
});

router.post('/compute', async (req, res) => {
  try {
    const { operation, encryptedInputs } = req.body;
    
    if (!operation || !encryptedInputs) {
      return res.status(400).json({ error: 'Missing operation or inputs' });
    }

    console.log(`🔄 FHE computation: ${operation}`);

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