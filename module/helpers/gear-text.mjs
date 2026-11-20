/**
 * Where gear is worn, read from text (docs/gear-slots.md): the book's
 * "Gear Slot:" line and an item's name. No imports and no Foundry globals,
 * so the PDF parsers (module/pdf-import - also run under Node by
 * tools/pdf-import) can use it. module/helpers/gear.mjs builds on it.
 */

/** Where gear can be worn (CONFIG.CARLRPG.wearSlots' keys, in that order). */
export const WEAR_SLOT_KEYS = Object.freeze([
  "head",
  "torso",
  "arms",
  "held",
  "gloves",
  "legs",
  "feet",
  "accessory",
]);

/** The book's "Gear Slot:" words -> where-worn keys. */
const SLOT_WORDS = {
  head: ["head", "neck"],
  torso: ["torso"],
  arms: ["arms", "arm"],
  legs: ["legs", "leg"],
  feet: ["feet", "foot"],
  gloves: ["gloves", "glove"],
  held: ["hand", "hands", "holding"],
  accessory: ["accessory", "accessories"],
};

/**
 * A "Gear Slot:" value as the book prints it ("Head", "Accessory or Head",
 * "Hands/Holding", "Hand/Holding (requires two hands)", "Any").
 * @param {string} text
 * @returns {{slots: string[], twoHanded: boolean}|null}  null if it names none.
 */
export function parseGearSlotLine(text) {
  const s = String(text ?? "").toLowerCase();
  if (!s.trim()) return null;
  const twoHanded = /two[- ]hand|requires two hands|both hands/.test(s);
  if (/\bany\b/.test(s)) return { slots: [...WEAR_SLOT_KEYS], twoHanded };
  const words = s.match(/[a-z]+/g) ?? [];
  const slots = Object.entries(SLOT_WORDS)
    .filter(([, names]) => names.some((n) => words.includes(n)))
    .map(([key]) => key);
  return slots.length ? { slots, twoHanded } : null;
}

/**
 * Names that say where gear goes (the 0.7.0 migration's guess; the user's
 * ruling: "Gloves or Gauntlets are Glove Slot; Boots, Slippers, and Shoes
 * are all Foot Slot..."). Singular; a trailing "s" or "es" matches too.
 */
export const SLOT_NAME_TERMS = Object.freeze({
  gloves: ["glove", "gauntlet", "mitt", "mitten"],
  feet: ["boot", "shoe", "slipper", "sandal", "sock", "sneaker", "clog"],
  head: [
    "helm",
    "helmet",
    "hat",
    "cap",
    "hood",
    "crown",
    "mask",
    "circlet",
    "headband",
    "bandana",
    "necklace",
    "choker",
    "amulet",
    "goggle",
  ],
  torso: [
    "shirt",
    "armor",
    "armour",
    "breastplate",
    "vest",
    "jerkin",
    "robe",
    "blouse",
    "tunic",
    "coat",
    "jacket",
    "cuirass",
    "mail",
    "hauberk",
  ],
  arms: ["bracer", "vambrace", "armband", "elbowpad"],
  legs: ["pants", "trousers", "greave", "kilt", "skirt", "legging", "jeans", "shorts", "boxer"],
  held: ["shield", "buckler"],
  accessory: [
    "ring",
    "brooch",
    "belt",
    "cape",
    "cloak",
    "tattoo",
    "patch",
    "piercing",
    "earring",
    "bracelet",
    "pendant",
    "charm",
    "badge",
    "amulet",
  ],
});

/** Accessory kinds by name. */
const KIND_TERMS = { belt: ["belt"], cape: ["cape", "cloak"] };

const termMatches = (word, term) => word === term || word === `${term}s` || word === `${term}es`;

/**
 * Where a name says gear goes: its head noun - the last word naming a slot,
 * before any "of ..." ("Gauntlets of Ogre Power": Gloves; "Ring Mail
 * Shirt": Torso).
 * @param {string} name
 * @returns {{slots: string[], accessoryKind: string}|null}
 */
export function slotsFromName(name) {
  const head = String(name ?? "")
    .toLowerCase()
    .split(/\bof\b|,|\(/)[0];
  const words = head.match(/[a-z]+/g) ?? [];
  for (let i = words.length - 1; i >= 0; i--) {
    const slots = Object.entries(SLOT_NAME_TERMS)
      .filter(([, terms]) => terms.some((t) => termMatches(words[i], t)))
      .map(([key]) => key);
    if (!slots.length) continue;
    const accessoryKind =
      Object.entries(KIND_TERMS).find(([, terms]) =>
        terms.some((t) => termMatches(words[i], t)),
      )?.[0] ?? "";
    return { slots, accessoryKind };
  }
  return null;
}
