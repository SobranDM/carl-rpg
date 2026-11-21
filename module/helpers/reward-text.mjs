/**
 * Reading an achievement's Reward line (Node-safe: the rulebook importer
 * uses it too). "You've received a Bronze Crafter's Box!" is a Bronze box
 * called "Bronze Crafter's Box" (Appendix 3; p.21's tiers).
 */

/** The box tiers, as the book writes them, by key (CONFIG.CARLRPG.lootBoxTiers). */
const TIER_WORDS = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
  platinum: "Platinum",
  legendary: "Legendary",
  celestial: "Celestial",
};

/**
 * The loot box a Reward line gives, if it gives one.
 * @param {string} reward  "You've received a Bronze Crafter's Box!"
 * @returns {{tier: string, title: string}|null}  {tier: "bronze", title: "Bronze Crafter's Box"}
 */
export function rewardBox(reward) {
  const text = String(reward ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const words = Object.values(TIER_WORDS).join("|");
  const match = text.match(new RegExp(`\\b((${words})\\b[^.!?]*?\\bBox(?:es)?)\\b`, "i"));
  if (!match) return null;
  const word = match[2].toLowerCase();
  const tier = Object.keys(TIER_WORDS).find((k) => k === word) ?? null;
  if (!tier) return null;
  const title = match[1].replace(/^\w/, (c) => c.toUpperCase());
  return { tier, title };
}
