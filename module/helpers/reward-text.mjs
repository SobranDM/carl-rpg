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

/**
 * A box's theme, from its title (ruled 2026-11-27): the words between its
 * tier and "Box" - "Bronze Goblin Box" is "Goblin", "Gold crafter’s box" is
 * "Crafter's" (each word capitalised, curly apostrophes made straight). A
 * title with no tier word counts only when it's short ("Goblin Box"), so a
 * whole sentence isn't read as a theme. "" for none ("Silver Box").
 * @param {string} title
 * @returns {string}
 */
export function boxTheme(title) {
  const text = String(title ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const before = text.match(/^(.*?)\bBox(?:es)?\b/i)?.[1];
  if (before === undefined) return "";
  let words = before.split(" ").filter(Boolean);
  const tiers = Object.values(TIER_WORDS).map((w) => w.toLowerCase());
  const last = words.findLastIndex((w) => tiers.includes(w.toLowerCase()));
  if (last >= 0) words = words.slice(last + 1);
  else if (words.length > 3) return "";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
