function toBigInt(value) {
  if (value == null || value === "") return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);

  if (value instanceof Uint8Array || Array.isArray(value)) {
    const bytes = Array.isArray(value) ? value : Array.from(value);
    const hex = bytes
      .map((b) => {
        const num = Number(b);
        if (!Number.isFinite(num) || num < 0 || num > 255) {
          throw new Error(`Invalid byte value: ${b}`);
        }
        return num.toString(16).padStart(2, "0");
      })
      .join("");
    return BigInt("0x" + hex);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    if (trimmed.startsWith("0x")) return BigInt(trimmed);
    if (trimmed.includes(",")) {
      const parts = trimmed
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (parts.length > 1 && parts.every((p) => /^[0-9]+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
        const hex = parts.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
        return BigInt("0x" + hex);
      }
      if (parts.length >= 1 && parts.every((p) => /^[0-9]+$/.test(p))) {
        return BigInt(parts.join(""));
      }
    }
    if (/^[0-9]+$/.test(trimmed)) return BigInt(trimmed);
  }

  const asString = String(value);
  if (asString.startsWith("0x")) return BigInt(asString);
  return BigInt(asString);
}

function toBigIntString(value) {
  return toBigInt(value).toString();
}

module.exports = { toBigInt, toBigIntString };
