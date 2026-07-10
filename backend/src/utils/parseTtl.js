function parseTtl(ttl) {
  const match = String(ttl).match(/^(\d+)([smhd])$/i);
  if (!match) {
    throw new Error(`Unsupported token ttl: ${ttl}`);
  }

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
}

module.exports = parseTtl;
