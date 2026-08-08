// lib/vipTier.js — computes a customer's VIP tier from their lifetime spend.
// Pure function, no DB access — callers pass in the total spend (and optionally a
// custom tier list loaded from the settings table) they've already queried.
const DEFAULT_TIERS = [
  { level: 0, name: 'สมาชิกทั่วไป', icon: '🥉', minSpend: 0 },
  { level: 1, name: 'Silver', icon: '🥈', minSpend: 1000 },
  { level: 2, name: 'Gold', icon: '🥇', minSpend: 5000 },
  { level: 3, name: 'Platinum', icon: '💎', minSpend: 20000 },
];

// Admin-editable tiers arrive as [{ name, icon, minSpend }, ...] (no explicit level —
// the admin UI just orders them). Normalize into the shape computeVipTier expects:
// sorted ascending by minSpend, with a 0-based level assigned by that order.
function normalizeTiers(rawTiers) {
  if (!Array.isArray(rawTiers) || !rawTiers.length) return DEFAULT_TIERS;
  const cleaned = rawTiers
    .filter(t => t && typeof t.name === 'string' && t.name.trim())
    .map(t => ({ name: t.name.trim(), icon: t.icon || '🥉', minSpend: Number(t.minSpend) || 0 }))
    .sort((a, b) => a.minSpend - b.minSpend)
    .map((t, i) => ({ level: i, ...t }));
  return cleaned.length ? cleaned : DEFAULT_TIERS;
}

function computeVipTier(totalSpend, rawTiers) {
  const TIERS = normalizeTiers(rawTiers);
  let current = TIERS[0];
  for (const t of TIERS) {
    if (totalSpend >= t.minSpend) current = t;
  }
  const next = TIERS.find(t => t.level === current.level + 1) || null;
  return {
    level: current.level,
    name: current.name,
    icon: current.icon,
    totalSpend,
    nextTier: next ? { name: next.name, minSpend: next.minSpend, remaining: Math.max(0, next.minSpend - totalSpend) } : null,
  };
}

module.exports = { computeVipTier, normalizeTiers, DEFAULT_TIERS };
