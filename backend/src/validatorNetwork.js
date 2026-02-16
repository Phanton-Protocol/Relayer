/**
 * Validator Network Client
 * 
 * Collects signatures from multiple validators in parallel for instant verification.
 */

const axios = require('axios');

class ValidatorNetwork {
  constructor(validatorUrls, thresholdBps = 6600) {
    this.validators = validatorUrls; // Array of validator endpoints
    this.thresholdBps = thresholdBps; // 6600 = 66%
    this.timeout = Number(process.env.VALIDATOR_TIMEOUT_MS || 20000); // 20 seconds max per validator
    this.maxRetries = Number(process.env.VALIDATOR_RETRIES || 3);
    this.retryBaseMs = Number(process.env.VALIDATOR_RETRY_BASE_MS || 500);
  }

  /**
   * Submit proof to all validators and collect signatures
   * @returns {Object} { valid, signatures, totalVotingPower }
   */
  async verifyProof(proof, publicInputs) {
    console.log(`\n📡 Broadcasting to ${this.validators.length} validators...`);
    const startTime = Date.now();

    // Send to all validators in parallel
    const requests = this.validators.map(url => 
      this.requestValidation(url, proof, publicInputs)
    );

    // Wait for all responses (with timeout)
    const results = await Promise.allSettled(requests);

    // Log all validator responses for debugging
    results.forEach((result, i) => {
      const url = this.validators[i];
      if (result.status === 'fulfilled' && result.value) {
        console.log(`🧾 Validator response from ${url}:`, result.value);
      } else if (result.status === 'fulfilled') {
        console.log(`🧾 Validator response from ${url}: null`);
      } else {
        console.log(`🧾 Validator error from ${url}:`, result.reason?.message || result.reason);
      }
    });

    // Filter successful validations
    const validations = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    console.log(`✅ Received ${validations.length}/${this.validators.length} responses (${Date.now() - startTime}ms)`);

    // Coordinator returns aggregated response (multiple stakers in one)
    const aggregated = validations.find(v => v.aggregated);
    if (aggregated) {
      const totalVotingPower = BigInt(aggregated.totalVotingPower);
      const validVotingPower = BigInt(aggregated.validVotingPower);
      const thresholdMet = totalVotingPower > 0n && (validVotingPower * 10000n) >= (totalVotingPower * BigInt(this.thresholdBps));
      if (!thresholdMet) {
        console.log(`❌ Coordinator threshold NOT met - proof REJECTED`);
        return {
          valid: false,
          signatures: [],
          totalVotingPower: aggregated.totalVotingPower,
          validVotingPower: aggregated.validVotingPower,
          reason: 'Threshold not met'
        };
      }
      const validSignatures = (aggregated.signatures || []).filter(s => s.signature);
      console.log(`✅ Coordinator proof ACCEPTED (${validSignatures.length} stakers)`);
      return {
        valid: true,
        signatures: validSignatures,
        totalVotingPower: aggregated.totalVotingPower,
        validVotingPower: aggregated.validVotingPower
      };
    }

    // Standard validators: calculate total voting power
    let totalVotingPower = 0n;
    let validVotingPower = 0n;
    
    for (const v of validations) {
      const power = BigInt(v.votingPower);
      totalVotingPower += power;
      if (v.valid) {
        validVotingPower += power;
      }
    }

    if (totalVotingPower === 0n) {
      console.log(`❌ No validator voting power - proof REJECTED`);
      return {
        valid: false,
        signatures: [],
        totalVotingPower: "0",
        validVotingPower: "0",
        reason: 'No validator voting power'
      };
    }

    // Check if threshold is met
    const validPercentage = Number((validVotingPower * 10000n) / totalVotingPower) / 100;
    const thresholdMet = (validVotingPower * 10000n) >= (totalVotingPower * BigInt(this.thresholdBps));

    console.log(`📊 Consensus: ${validPercentage.toFixed(2)}% voted VALID (threshold: ${this.thresholdBps / 100}%)`);

    if (!thresholdMet) {
      console.log(`❌ Threshold NOT met - proof REJECTED`);
      return {
        valid: false,
        signatures: [],
        totalVotingPower: totalVotingPower.toString(),
        validVotingPower: validVotingPower.toString(),
        reason: 'Threshold not met'
      };
    }

    // Filter only VALID signatures
    const validSignatures = validations
      .filter(v => v.valid)
      .map(v => ({
        validator: v.validator,
        votingPower: v.votingPower,
        signature: v.signature,
        timestamp: v.timestamp
      }));

    console.log(`✅ Proof ACCEPTED with ${validSignatures.length} signatures`);

    return {
      valid: true,
      signatures: validSignatures,
      totalVotingPower: totalVotingPower.toString(),
      validVotingPower: validVotingPower.toString()
    };
  }

  /**
   * Request validation from a single validator
   */
  async requestValidation(validatorUrl, proof, publicInputs) {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await axios.post(
          `${validatorUrl}/verify`,
          { proof, publicInputs },
          { timeout: this.timeout }
        );
        return response.data;
      } catch (err) {
        console.warn(`⚠️  Validator ${validatorUrl} attempt ${attempt}/${this.maxRetries} failed: ${err.message}`);
        if (attempt < this.maxRetries) {
          const delay = this.retryBaseMs * (2 ** (attempt - 1));
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    return null;
  }

  /**
   * Health check all validators
   */
  async checkHealth() {
    console.log(`\n🏥 Checking ${this.validators.length} validators...`);
    
    const checks = this.validators.map(async (url) => {
      try {
        const response = await axios.get(`${url}/health`, { timeout: 2000 });
        console.log(`  ✅ ${url}: ${response.data.validator}`);
        return { url, status: 'online', data: response.data };
      } catch (err) {
        console.log(`  ❌ ${url}: ${err.message}`);
        return { url, status: 'offline', error: err.message };
      }
    });

    return await Promise.all(checks);
  }
}

module.exports = ValidatorNetwork;
