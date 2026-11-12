/**
 * Using a consumable (Item Rules, p.99): Potions, Scrolls, Spellbooks and
 * other single-use items such as Bandages. A gear item is a consumable when
 * its `system.consumable.kind` is set (module/data/item.mjs).
 *
 * - Potion / other: its effects (heal, mend, Mana, cures, a permanent Stat
 *   or Skill boost, a timed Buff) go to the one targeted token, or else the
 *   user's own crawler - "pour it into a nearby party member's gullet".
 *   Whoever can update the recipient applies them at once; otherwise the
 *   card offers Apply to the GM or the recipient's owner
 *   (module/chat/consumable-card.mjs).
 * - Potion Sickness: "Crawlers cannot consume more than one potion every
 *   other round in combat. Attempting to do so will lead to Potion
 *   Sickness, which inflicts the Poison Debuff and lasts 15 seconds." The
 *   potion still works; Poisoned is added for 2 round ends (15 seconds is a
 *   round and a half, a round being 10 seconds).
 * - Scroll: casts its Spell at the scroll's fixed Rank with no Mana
 *   (module/helpers/scroll-cast.mjs), then turns to dust. A Spell with no
 *   roll (Hole) or a switched one (Shield) posts its effect at that Rank.
 * - Spellbook: teaches its Spell at the book's Rank (1d6-1, minimum 1, when
 *   the book doesn't say), then disappears. A Spell already known is only
 *   raised, never lowered.
 *
 * Every refusal happens before anything is used up.
 */
import CarlDice, { isBlockedByDebuff } from "../dice/dice.mjs";
import { CARLRPG } from "./config.mjs";
import { findConditionWithMechanic, conditionLabel } from "./debuff-effects.mjs";
import { cleanSkillLikeCopy, findOwnedSkillLike, findSkillLikeItem, learnSkillLike } from "./race-class-grants.mjs";
import { skillRankCap } from "./modifiers.mjs";
import { buildConditionEntry } from "./conditions.mjs";
import { durationSeconds } from "./expiry.mjs";
import { buildScrollCast } from "./scroll-cast.mjs";
import { queueForActor } from "./actor-queue.mjs";
import { createCardMessage, esc } from "../chat/chat-card.mjs";
import { showCarlDialog, rollButton, cancelButton } from "../apps/carl-dialog.mjs";
import { postConsumableCard } from "../chat/consumable-card.mjs";

// "Each crawler may only consume two Stat potions and two Skill potions
// during the entirety of their short life" (p.218).
export const PERMANENT_POTION_LIMIT = 2;
// Potion Sickness: "lasts 15 seconds" - through the end of the next round.
const SICKNESS_ROUND_ENDS = 2;

/**
 * "Scroll of Bang Bro (Rank 3)" -> {name: "Bang Bro", rank: 3}; also
 * "Spellbook of Hole", "Magic Tome: Hole".
 * @param {string} itemName
 * @returns {{name: string, rank: number|null}}
 */
export function parseSpellItemName(itemName) {
  const match = String(itemName ?? "").match(
    /^\s*(?:spell\s*)?(?:scroll|spellbook|spell\s+book|book|magic\s+tome|tome)\s*(?:of|:)?\s+(.+?)(?:\s*\(\s*rank\s*(\d+)\s*\))?\s*$/i,
  );
  if (!match) return { name: "", rank: null };
  return { name: match[1].trim(), rank: match[2] ? Number(match[2]) : null };
}

/**
 * The Spell a Scroll or Spellbook refers to: its linked uuid if that still
 * resolves to a Spell, else a Spell found by name (compendiums, then the
 * world's Items).
 * @param {Item} item  The Scroll or Spellbook.
 * @returns {Promise<{source: Item|null, name: string, rank: number|null}>}
 */
export async function resolveConsumableSpell(item) {
  const spec = item.system.consumable?.spell ?? {};
  const parsed = parseSpellItemName(item.name);
  const name = spec.name || parsed.name;
  const rank = spec.rank ?? parsed.rank;
  let source = spec.uuid ? await fromUuid(spec.uuid).catch(() => null) : null;
  if (source?.type !== "spell") source = name ? await findSkillLikeItem(name) : null;
  if (source?.type !== "spell") source = null;
  return { source, name: source?.name ?? name, rank };
}

/**
 * The card for a Scroll whose Spell has no roll: what it does at the
 * scroll's Rank (its description plus every Upgrade that Rank unlocks).
 * @param {Actor} actor
 * @param {Item} spell  The scroll's unsaved Spell (scroll-cast.mjs).
 * @param {number} rank
 * @returns {Promise<ChatMessage>}
 */
async function postScrollEffect(actor, spell, rank) {
  const upgrades = (spell.system.upgrades ?? [])
    .filter((u) => rank >= u.rankThreshold && u.description)
    .map((u) => `<p><strong>${game.i18n.format("CARLRPG.Consumable.UpgradeRank", { rank: u.rankThreshold })}</strong> ${u.description}</p>`)
    .join("");
  return createCardMessage({
    title: spell.name,
    subtitle: game.i18n.format("CARLRPG.Consumable.ScrollCast", { rank }),
    img: spell.img,
    body: `${spell.system.description ?? ""}${upgrades}`,
    actor,
  });
}

/** Use up one: quantity - 1, or delete the item when it was the last. */
export async function consumeOne(item) {
  const quantity = Number(item.system.quantity ?? 1);
  if (quantity > 1) await item.update({ "system.quantity": quantity - 1 });
  else await item.delete();
}

/** The one targeted token's actor, else the user's own crawler. */
function targetedRecipient(actor) {
  const targets = [...(game.user.targets ?? [])].filter((t) => t.actor);
  return targets.length === 1 ? targets[0].actor : actor;
}

/**
 * Who gets it, when a token other than the user's is targeted. Foundry keeps
 * the last Attack's target, so drinking it yourself is the default and
 * giving it is the deliberate choice.
 * @returns {Promise<Actor|null>} null when cancelled.
 */
async function chooseRecipient(item, actor, target) {
  const choice = await showCarlDialog({
    title: item.name,
    content: `<p>${game.i18n.format("CARLRPG.Consumable.ChooseRecipient", { item: esc(item.name), name: esc(target.name) })}</p>`,
    buttons: [
      { action: "self", icon: "fa-solid fa-flask", label: game.i18n.localize("CARLRPG.Consumable.UseYourself"), default: true, callback: () => "self" },
      { action: "give", icon: "fa-solid fa-hand-holding-medical", label: game.i18n.format("CARLRPG.Consumable.GiveTo", { name: target.name }), callback: () => "give" },
      cancelButton(),
    ],
  });
  if (choice === "self") return actor;
  if (choice === "give") return target;
  return null;
}

/** "Choose a Skill and gain 3 Ranks in it" - pick one of the recipient's own. */
async function chooseSkill(recipient, item) {
  const owned = recipient.items
    .filter((i) => i.type === "skill" || i.type === "spell")
    .sort((a, b) => a.name.localeCompare(b.name));
  const options = owned.map((i) => `<option value="${esc(i.name)}">${esc(i.name)}</option>`).join("");
  const result = await showCarlDialog({
    title: item.name,
    content: `<div class="carl-dialog-body">
      <p>${game.i18n.localize("CARLRPG.Consumable.ChooseSkillHint")}</p>
      <div class="form-group"><label>${game.i18n.localize("CARLRPG.Consumable.ChooseSkill")}</label>
        <select name="skill"><option value=""></option>${options}</select></div>
      <div class="form-group"><label>${game.i18n.localize("CARLRPG.Consumable.OtherSkill")}</label>
        <input type="text" name="other" /></div>
    </div>`,
    buttons: [rollButton({ label: "CARLRPG.Consumable.Drink" }), cancelButton()],
  });
  if (!result) return null;
  return (result.other || result.skill || "").trim() || null;
}

/**
 * Use a consumable from `actor`'s inventory - the sheet's Use buttons and
 * CarlRPGItem#roll call this.
 * @param {Actor} actor  Whoever is using it (the item's owner).
 * @param {Item} item
 * @param {{skipDialog?: boolean}} [options]  skipDialog: no "give it to them?"
 *   confirmation and no roll dialog (scripts, tests). A Skill potion with no
 *   Skill set is then refused rather than asking.
 * @returns {Promise<ChatMessage|null>}
 */
export async function useConsumable(actor, item, { skipDialog = false } = {}) {
  const kind = item.system.consumable?.kind;
  if (!kind) return null;
  // One use at a time per item: a double-click must not get two uses out of
  // the last one.
  if (inUse.has(item.uuid)) return null;
  if ((item.system.quantity ?? 1) < 1) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Consumable.NoneLeft", { item: item.name }));
    return null;
  }
  // "They must be conscious and not impaired, Dying, or the like."
  if (isBlockedByDebuff(actor)) return null;
  inUse.add(item.uuid);
  try {
    if (kind === "scroll") return await useScroll(actor, item, { skipDialog });
    if (kind === "spellbook") return await readSpellbook(actor, item);
    return await drinkOrUse(actor, item, { skipDialog });
  } finally {
    inUse.delete(item.uuid);
  }
}

// Items being used on this client right now (by uuid).
const inUse = new Set();

async function drinkOrUse(actor, item, { skipDialog }) {
  const effects = item.toObject().system.consumable;
  let recipient = targetedRecipient(actor);
  if (recipient.uuid !== actor.uuid && !skipDialog) {
    recipient = await chooseRecipient(item, actor, recipient);
    if (!recipient) return null;
  }

  // A healing-only potion can't help someone who can't be healed (The
  // Taint) - keep it for later instead.
  const heal = effects.heal ?? {};
  const onlyHeals = (heal.full || heal.slots || heal.mend)
    && !effects.mana?.full && !effects.mana?.amount && !effects.cures?.length
    && !effects.permanent?.kind && !effects.buff?.label && !effects.buff?.changes?.length;
  const taint = onlyHeals ? findConditionWithMechanic(recipient.system, "noHealing") : null;
  if (taint) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Heal.BlockedByDebuff", { name: recipient.name, debuff: conditionLabel(taint) }));
    return null;
  }

  const permanent = effects.permanent ?? {};
  if (permanent.kind) {
    if (recipient.type !== "character") {
      ui.notifications.warn(game.i18n.format("CARLRPG.Consumable.CrawlersOnly", { item: item.name }));
      return null;
    }
    if ((recipient.system.permanentPotions?.[permanent.kind] ?? 0) >= PERMANENT_POTION_LIMIT) {
      ui.notifications.warn(game.i18n.format(`CARLRPG.Consumable.LimitReached.${permanent.kind}`, { name: recipient.name }));
      return null;
    }
    if (permanent.kind === "stat" && !CARLRPG.statAbbreviations[permanent.target]) {
      ui.notifications.warn(game.i18n.format("CARLRPG.Consumable.NoStat", { item: item.name }));
      return null;
    }
    if (permanent.kind === "skill" && !permanent.target) {
      const chosen = skipDialog ? null : await chooseSkill(recipient, item);
      if (!chosen) return null;
      permanent.target = chosen;
    }
    // A Skill already at its ceiling would gain nothing, and the potion
    // would still count toward the two-ever limit - keep it instead.
    if (permanent.kind === "skill" && skillAtCap(recipient, permanent.target)) {
      ui.notifications.warn(game.i18n.format("CARLRPG.Consumable.SkillAtCap", { name: recipient.name, skill: permanent.target }));
      return null;
    }
  }

  const isPotion = effects.kind === "potion";
  // When it was drunk, for Potion Sickness - even if someone else clicks
  // Apply a round later.
  const drankAt = isPotion ? potionMoment(recipient) : null;
  const applyNow = recipient.isOwner;
  let lines = null;
  if (applyNow) lines = await applyConsumableEffects(recipient, effects, { itemName: item.name, isPotion, drankAt });
  const card = { name: item.name, img: item.img };
  await consumeOne(item);
  return postConsumableCard({ actor, recipient, item: card, effects, isPotion, drankAt, lines });
}

/**
 * The fight and round a crawler drinks in, or null outside a started combat.
 * @param {Actor} recipient
 * @returns {{combatId: string, round: number}|null}
 */
export function potionMoment(recipient) {
  const combat = game.combats.find((c) => c.started && c.combatants.some((cb) => cb.actor?.uuid === recipient.uuid));
  return combat ? { combatId: combat.id, round: combat.round } : null;
}

/**
 * Apply a consumable's effects to its recipient, in one update. Run by
 * whoever can update the recipient (module/chat/consumable-card.mjs's Apply
 * for anyone else).
 * @param {Actor} recipient
 * @param {object} effects  A snapshot of the item's system.consumable.
 * @param {{itemName?: string, isPotion?: boolean, drankAt?: {combatId: string, round: number}|null}} [options]
 *   drankAt: when it was drunk (potionMoment) - defaults to now.
 * @returns {Promise<string[]>} Result lines (HTML-safe).
 */
export function applyConsumableEffects(recipient, effects, { itemName = "", isPotion = false, drankAt } = {}) {
  return queueForActor(recipient.uuid, () => runConsumableEffects(recipient, effects, { itemName, isPotion, drankAt }));
}

async function runConsumableEffects(recipient, effects, { itemName, isPotion, drankAt }) {
  const sys = recipient.system;
  const name = esc(recipient.name);
  const lines = [];
  const updates = {};
  const original = sys.toObject().conditions ?? [];
  let conditions = foundry.utils.deepClone(original);
  const fmt = (key, data = {}) => game.i18n.format(`CARLRPG.Consumable.Result.${key}`, { name, ...data });

  // Heal: N Health Bar slots, or full.
  const heal = effects.heal ?? {};
  if (heal.full || heal.slots) {
    const taint = findConditionWithMechanic(sys, "noHealing");
    if (taint) {
      lines.push(fmt("HealBlocked", { debuff: esc(conditionLabel(taint)) }));
    } else {
      const max = sys.hb?.effectiveMax ?? sys.hb?.max ?? 0;
      const current = sys.hb?.value ?? 0;
      const next = Math.max(current, heal.full ? max : Math.min(current + Number(heal.slots), max));
      if (next > current) {
        updates["system.hb.value"] = next;
        lines.push(fmt("Healed", { slots: next - current }));
      } else {
        lines.push(fmt("AlreadyHealthy"));
      }
    }
  }

  // Mend one Minor Injury - or, for "any", the worse of a Major or Minor.
  if (heal.mend) {
    const order = heal.mend === "any" ? ["majorInjury", "minorInjury"] : ["minorInjury"];
    const index = order.map((key) => conditions.findIndex((c) => c.key === key)).find((i) => i >= 0);
    if (index !== undefined) {
      const [mended] = conditions.splice(index, 1);
      lines.push(fmt("Mended", { debuff: esc(conditionLabel(mended)) }));
    }
  }

  // Mana: +N, or full.
  const mana = effects.mana ?? {};
  if (mana.full || mana.amount) {
    const max = sys.mana?.max ?? 0;
    const current = sys.mana?.value ?? 0;
    const next = Math.max(current, mana.full ? max : Math.min(current + Number(mana.amount), max));
    if (next > current) {
      updates["system.mana.value"] = next;
      lines.push(fmt("Mana", { amount: next - current }));
    }
  }

  // Cures: remove every entry of each listed Debuff.
  for (const key of effects.cures ?? []) {
    const cured = conditions.filter((c) => c.key === key);
    if (!cured.length) continue;
    conditions = conditions.filter((c) => c.key !== key);
    lines.push(fmt("Cured", { debuff: esc(conditionLabel(cured[0])) }));
  }

  // Permanent +N Stat or Skill, two of each per crawler, ever.
  const permanent = effects.permanent ?? {};
  if (permanent.kind && permanent.value) {
    const used = sys.permanentPotions?.[permanent.kind] ?? 0;
    if (recipient.type !== "character") {
      lines.push(fmt("CrawlersOnly"));
    } else if (used >= PERMANENT_POTION_LIMIT) {
      lines.push(fmt(`LimitReached.${permanent.kind}`));
    } else if (permanent.kind === "stat" && sys.stats?.[permanent.target]) {
      const value = (sys.stats[permanent.target].value ?? 0) + Number(permanent.value);
      updates[`system.stats.${permanent.target}.value`] = Math.max(1, value);
      updates["system.permanentPotions.stat"] = used + 1;
      lines.push(fmt("Stat", {
        stat: game.i18n.localize(CARLRPG.statAbbreviations[permanent.target] ?? permanent.target),
        value: Number(permanent.value),
      }));
    } else if (permanent.kind === "skill" && permanent.target) {
      const raised = await raiseSkill(recipient, permanent.target, Number(permanent.value));
      lines.push(raised.line);
      // Only a potion that did something counts toward the limit.
      if (raised.changed) updates["system.permanentPotions.skill"] = used + 1;
    }
  }

  // Timed Buff: a condition entry carrying its changes until it expires.
  // The same Buff again refreshes it rather than stacking.
  const buff = effects.buff ?? {};
  if (buff.label || buff.changes?.length) {
    const label = buff.label || itemName;
    const seconds = durationSeconds(buff.duration, buff.unit);
    const expiresAt = seconds ? game.time.worldTime + seconds : null;
    const existing = conditions.find((c) => c.key === "custom" && c.label === label && c.source === itemName);
    if (existing) {
      existing.expiresAt = expiresAt;
      existing.changes = foundry.utils.deepClone(buff.changes ?? []);
      lines.push(fmt("BuffRefreshed", { buff: esc(label) }));
    } else {
      conditions.push({
        id: foundry.utils.randomID(), key: "custom", label, stacks: 1, remaining: null, source: itemName,
        durationType: null, expiresAt, changes: foundry.utils.deepClone(buff.changes ?? []),
      });
      lines.push(fmt("Buff", { buff: esc(label) }));
    }
  }

  // Potion Sickness: a second potion within two rounds of the last, in the
  // same fight.
  if (isPotion) {
    const moment = drankAt === undefined ? potionMoment(recipient) : drankAt;
    if (moment) {
      const last = recipient.getFlag("carl-rpg", "lastPotion");
      if (last?.combatId === moment.combatId && moment.round - last.round < 2) {
        const sick = buildConditionEntry("poisoned", { source: game.i18n.localize("CARLRPG.Consumable.PotionSickness") });
        Object.assign(sick, { id: foundry.utils.randomID(), durationType: "rounds", remaining: SICKNESS_ROUND_ENDS });
        conditions.push(sick);
        lines.push(fmt("Sickness"));
      }
      updates["flags.carl-rpg.lastPotion"] = { combatId: moment.combatId, round: moment.round };
    }
  }

  if (JSON.stringify(conditions) !== JSON.stringify(original)) updates["system.conditions"] = conditions;
  if (Object.keys(updates).length) await recipient.update(updates);
  return lines;
}

/** Whether the actor's own copy of this Skill is already at its ceiling. */
function skillAtCap(actor, skillName) {
  const owned = findOwnedSkillLike(actor, skillName);
  return !!owned && (owned.system.rank ?? 0) >= skillRankCap(actor.system, skillName);
}

/**
 * +N Ranks to a Skill from a Skill potion: raise it if owned, else learn it
 * at N. Capped at the Skill's normal ceiling (15, or a Race/Class's raised
 * cap) - the book gives no separate cap for potions.
 * @returns {Promise<{line: string, changed: boolean}>}
 */
async function raiseSkill(actor, skillName, value) {
  const cap = skillRankCap(actor.system, skillName);
  const owned = findOwnedSkillLike(actor, skillName);
  const name = esc(actor.name);
  if (owned) {
    const current = owned.system.rank ?? 0;
    const next = Math.min(cap, current + value);
    if (next <= current) {
      return { line: game.i18n.format("CARLRPG.Consumable.Result.SkillAtCap", { name, skill: esc(owned.name), rank: current }), changed: false };
    }
    await owned.update({ "system.rank": next });
    return { line: game.i18n.format("CARLRPG.Consumable.Result.Skill", { name, skill: esc(owned.name), rank: next }), changed: true };
  }
  const rank = Math.min(cap, value);
  const created = await learnSkillLike(actor, skillName, rank);
  return { line: game.i18n.format("CARLRPG.Consumable.Result.Skill", { name, skill: esc(created?.name ?? skillName), rank }), changed: true };
}

/**
 * Teach a Spell at a Rank: raise an owned copy if it's lower, else copy the
 * source onto the actor.
 * @param {Actor} actor
 * @param {Item} source  A Spell.
 * @param {number} rank
 * @returns {Promise<{line: string, changed: boolean}>}
 */
export async function learnSpell(actor, source, rank) {
  const owned = findOwnedSkillLike(actor, source.name, ["spell"]);
  const data = { name: esc(actor.name), spell: esc(source.name), rank };
  if (owned) {
    if ((owned.system.rank ?? 0) >= rank) {
      return { line: game.i18n.format("CARLRPG.Consumable.Result.SpellKnown", { ...data, rank: owned.system.rank }), changed: false };
    }
    await owned.update({ "system.rank": rank });
    return { line: game.i18n.format("CARLRPG.Consumable.Result.SpellRaised", data), changed: true };
  }
  await actor.createEmbeddedDocuments("Item", [cleanSkillLikeCopy(source, rank)]);
  return { line: game.i18n.format("CARLRPG.Consumable.Result.SpellLearned", data), changed: true };
}

async function readSpellbook(actor, item) {
  const { source, name, rank: bookRank } = await resolveConsumableSpell(item);
  if (!source) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Consumable.NoSpell", { item: item.name, spell: name || "?" }));
    return null;
  }
  // Already known at least as well as the book could teach (a random Rank
  // is at most 5) - keep the book for someone it would help.
  const known = findOwnedSkillLike(actor, source.name, ["spell"]);
  if (known && (known.system.rank ?? 0) >= (bookRank ?? 5)) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Consumable.SpellbookKnown", { name: actor.name, spell: source.name, rank: known.system.rank }));
    return null;
  }
  // "To randomly generate the Skill Rank, roll 1d6-1 with a minimum Rank of 1."
  let roll = null;
  let rank = bookRank;
  if (!rank) {
    roll = await new Roll("1d6 - 1").evaluate();
    rank = Math.max(1, roll.total);
  }
  const { line } = await learnSpell(actor, source, rank);
  const card = { name: item.name, img: item.img };
  await consumeOne(item);
  return postConsumableCard({
    actor, recipient: actor, item: card, effects: null, lines: [line],
    rolls: roll ? [roll] : [],
    rollMeta: roll ? [{ label: game.i18n.localize("CARLRPG.Consumable.RandomRank"), breakdown: "1d6 - 1 (min 1)" }] : [],
  });
}

async function useScroll(actor, item, { skipDialog }) {
  const { source, name, rank } = await resolveConsumableSpell(item);
  if (!source) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Consumable.NoSpell", { item: item.name, spell: name || "?" }));
    return null;
  }
  if (!rank) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Consumable.NoRank", { item: item.name }));
    return null;
  }
  const { item: spell, castAs } = buildScrollCast(actor, source.toObject(), rank);
  const keywords = spell.system.castingKeywords ?? [];
  let message;
  if (keywords.includes("attack")) message = await CarlDice.rollAttack(actor, spell, { castAs, skipDialog });
  else if (keywords.includes("heal")) message = await CarlDice.rollHeal(actor, spell, { castAs });
  // A Spell with no Check to roll (Hole, Wall of Fire) or one you switch on
  // and off (Shield) just takes effect: the card states it at the scroll's
  // Rank, with that Rank's Upgrades, for the table to run.
  else if (spell.system.isPassive || spell.system.isToggled) message = await postScrollEffect(actor, spell, rank);
  else message = await CarlDice.rollSkillCheck(actor, spell, { castAs, skipDialog });
  // A cancelled dialog (or a blocked cast) leaves the scroll unused.
  if (!message) return null;
  await consumeOne(item);
  return message;
}
