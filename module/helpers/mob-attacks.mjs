/**
 * A Mob's Attacks as items (`mobAttack`, module/data/mob-attack.mjs;
 * docs/mob-sheet.md): reading them, and converting the printed-text list
 * Mobs used to carry (`system.attacks`) into them.
 *
 * The old list (name, to-hit, damage, damage type, range, effect) is
 * converted by one function (legacyAttackItems) with three callers:
 *  - a Mob created with a list (a macro, a Mob from an old compendium, a
 *    test) - module/data/mob.mjs's _preCreate;
 *  - the 0.7.0 world migration (module/helpers/migration.mjs);
 *  - the PDF importer, which makes and refreshes an imported Mob's Attacks
 *    (module/pdf-import/importer.mjs syncAttacks).
 * Area is guessed from the text as before (module/helpers/area.mjs); the
 * printed effect becomes the description. Whether its effect is a Debuff,
 * and when it lands, isn't guessed here: the migration lists the Mobs to
 * check. A list that already carries them keeps them (the PDF importer reads
 * Table 11 Debuffs and Armor-Piercing from the text,
 * module/pdf-import/debuff-text.mjs).
 */
import { isAreaMobAttack } from "./area.mjs";
import { RollParts } from "../dice/roll-parts.mjs";

const SCOPE = "carl-rpg";
export const MOB_ATTACK_TYPE = "mobAttack";

/** The flag a converted Attack carries: its index in the old list. */
export const LEGACY_FLAG = "legacyAttack";

/**
 * A Mob's Attacks, in their sheet order.
 * @param {Actor} actor
 * @returns {Item[]}
 */
export function mobAttacksOf(actor) {
  return (actor?.items?.filter((i) => i.type === MOB_ATTACK_TYPE) ?? [])
    .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
}

/**
 * An Attack's kind, for its chip on the sheet: Area if it's marked so,
 * Melee within 5 ft (the book prints "5ft range" for nearly every melee
 * Attack) or when it says melee, touch or reach, Ranged otherwise.
 * @param {{isArea?: boolean, range?: string}} attack
 * @returns {"area"|"melee"|"ranged"}
 */
export function attackKind(attack) {
  if (attack?.isArea) return "area";
  const range = String(attack?.range ?? "").trim().toLowerCase();
  if (!range || /\b(melee|touch|reach|adjacent)\b/.test(range)) return "melee";
  const feet = Number(range.match(/(\d+)\s*(?:ft|feet|foot)\b/)?.[1]);
  return Number.isFinite(feet) && feet > 5 ? "ranged" : "melee";
}

/**
 * Text from an HTML description (the printed effect, for chat cards).
 * @param {string} html
 * @returns {string}
 */
export function effectText(html) {
  const div = document.createElement("div");
  div.innerHTML = String(html ?? "");
  return div.textContent.replace(/\s+/g, " ").trim();
}

/**
 * What a roll, a declaration and the cards read from an Attack: its fields
 * in the shape the old list had, plus its Area, Splash and Debuffs.
 * @param {Item} item  A `mobAttack` item.
 * @returns {{id: string, name: string, toHit: string, damage: string, damageType: string, range: string,
 *   effect: string, isArea: boolean, splash: boolean, armorPiercing: boolean, targetEffects: object[]}}
 */
export function mobAttackData(item) {
  const sys = item.system;
  return {
    id: item.id,
    name: item.name,
    toHit: sys.toHit ?? "",
    damage: sys.damage ?? "",
    damageType: sys.damageType ?? "",
    range: sys.range ?? "",
    effect: effectText(sys.description),
    isArea: !!sys.isArea,
    splash: !!sys.isArea && !!sys.splash,
    armorPiercing: !!sys.armorPiercing,
    targetEffects: (sys.targetEffects ?? []).filter((te) => te.debuffKey).map((te) => ({
      id: te.id, debuffKey: te.debuffKey, stacks: te.stacks || 1, trigger: te.trigger || "hit", label: te.label || "",
      sourceLabel: item.name,
    })),
  };
}

/**
 * The Attack a roll asks for: by item id, or (tests, macros) by its place
 * in the Mob's Attacks.
 * @param {Actor} actor
 * @param {string|number} ref
 * @returns {Item|null}
 */
export function resolveMobAttack(actor, ref) {
  if (typeof ref === "number") return mobAttacksOf(actor)[ref] ?? null;
  const item = actor?.items?.get(ref);
  return item?.type === MOB_ATTACK_TYPE ? item : null;
}

/**
 * What a roll reads, for a Mob's Attack (an item) or a Vehicle's built-in
 * weapon (its own printed list, `system.attacks` - unchanged, docs/
 * mob-sheet.md Q4; a GM-crewed vehicle fires one as a Mob Attack).
 * @param {Actor} actor
 * @param {string|number} ref  An item id, or a place: in a Mob's Attacks,
 *   or in a Vehicle's weapons list.
 * @returns {object|null}  mobAttackData's shape.
 */
export function mobAttackFor(actor, ref) {
  if (actor?.type === "vehicle") {
    const weapon = actor.system.attacks?.[Number(ref)];
    if (!weapon) return null;
    return {
      id: null,
      name: weapon.name || game.i18n.localize("CARLRPG.MobAttack.Unnamed"),
      toHit: weapon.toHit ?? "",
      damage: weapon.damage ?? "",
      damageType: weapon.damageType ?? "",
      range: weapon.range ?? "",
      effect: weapon.effect ?? "",
      isArea: isAreaMobAttack(weapon),
      splash: false,
      targetEffects: [],
    };
  }
  const item = resolveMobAttack(actor, ref);
  return item ? mobAttackData(item) : null;
}

/**
 * Items for the old list's entries.
 * @param {object[]} attacks  The old `system.attacks` entries.
 * @param {{startSort?: number, indexes?: number[]}} [options]  indexes: which
 *   entries (by position) to make; all by default.
 * @returns {object[]}  Item data, each flagged with its index in the list.
 */
export function legacyAttackItems(attacks, { startSort = 0, indexes = null } = {}) {
  const esc = foundry.utils.escapeHTML;
  return (attacks ?? []).flatMap((attack, index) => {
    if (indexes && !indexes.includes(index)) return [];
    const text = [attack?.range, attack?.effect, attack?.damage].join(" ");
    const isArea = isAreaMobAttack(attack ?? {});
    const effect = String(attack?.effect ?? "").trim();
    const triggers = CONFIG.CARLRPG.mobAttackTriggers ?? {};
    const targetEffects = (Array.isArray(attack?.targetEffects) ? attack.targetEffects : []).filter(
      (te) => Object.hasOwn(CONFIG.CARLRPG.debuffs, te?.debuffKey ?? "") && Object.hasOwn(triggers, te?.trigger ?? "hit"),
    );
    return [{
      _id: foundry.utils.randomID(),
      name: String(attack?.name ?? "").trim() || game.i18n.localize("CARLRPG.MobAttack.Unnamed"),
      type: MOB_ATTACK_TYPE,
      img: "icons/svg/sword.svg",
      sort: startSort + (index + 1) * 1000,
      system: {
        toHit: String(attack?.toHit ?? ""),
        damage: String(attack?.damage ?? ""),
        damageType: Object.hasOwn(CONFIG.CARLRPG.damageTypes, attack?.damageType ?? "") ? attack.damageType : "",
        range: String(attack?.range ?? ""),
        isArea,
        splash: isArea && /\bsplash\b/i.test(text),
        armorPiercing: !!attack?.armorPiercing,
        targetEffects,
        description: effect ? `<p>${esc(effect)}</p>` : "",
      },
      flags: { [SCOPE]: { [LEGACY_FLAG]: index } },
    }];
  });
}

/**
 * Convert a Mob's old Attacks list into items, then clear the list. Safe to
 * run again: an entry already converted (its index flagged on an item) isn't
 * made twice, and the list is cleared last.
 * @param {Actor} actor  A Mob - world, synthetic (a token) or in a compendium.
 * @param {{attacks?: object[]}} [options]  The list to convert (default: the actor's own).
 * @returns {Promise<number>}  How many Attacks were made.
 */
export async function convertLegacyAttacks(actor, { attacks = actor.system?.attacks ?? [] } = {}) {
  if (!attacks.length) return 0;
  const done = new Set(actor.items.filter((i) => i.type === MOB_ATTACK_TYPE)
    .map((i) => i.getFlag(SCOPE, LEGACY_FLAG)).filter((n) => Number.isInteger(n)));
  const indexes = attacks.map((_, i) => i).filter((i) => !done.has(i));
  const startSort = Math.max(0, ...actor.items.map((i) => i.sort ?? 0));
  const items = legacyAttackItems(attacks, { startSort, indexes });
  if (items.length) await actor.createEmbeddedDocuments("Item", items, { keepId: true, carlMigration: true });
  await actor.update({ "system.attacks": [] }, { carlMigration: true });
  return items.length;
}

/**
 * Whether a Mob's old Attacks need the GM's eye after conversion: an Area
 * guessed from the text, or an effect that names a Debuff (its trigger has
 * to be set by hand).
 * @param {object[]} attacks
 * @returns {string[]}  The names of the Attacks to check.
 */
export function attacksToCheck(attacks) {
  const debuffNames = Object.values(CONFIG.CARLRPG.debuffs ?? {})
    .map((d) => game.i18n.localize(d.label ?? "").toLowerCase())
    .filter((name) => name.length > 2);
  return (attacks ?? []).filter((attack) => {
    if (isAreaMobAttack(attack ?? {})) return true;
    const effect = String(attack?.effect ?? "").toLowerCase();
    return debuffNames.some((name) => effect.includes(name));
  }).map((attack) => String(attack?.name ?? "").trim() || game.i18n.localize("CARLRPG.MobAttack.Unnamed"));
}

/**
 * A Mob Attack's printed damage, rolled: "F" is the Floor (p.267: "add the
 * current Floor Number to values with '+F'"), read from the roll data's
 * `floor`. A formula that won't roll warns and gives null.
 * @param {object} rollData  The Mob's roll data (or one with at least `floor`).
 * @param {string} damage  The printed formula ("2d6+F").
 * @param {string} label  The roll term's label.
 * @returns {Promise<{roll: Roll, total: number, breakdown: string}|null>}
 */
export async function rollMobDamage(rollData, damage, label) {
  const parts = new RollParts(rollData);
  parts.add(String(damage).replace(/\bF\b/g, "@floor"), label);
  try {
    return await parts.evaluate();
  } catch (err) {
    ui.notifications.warn(game.i18n.format("CARLRPG.MobAttack.BadDamage", { formula: damage }));
    return null;
  }
}
