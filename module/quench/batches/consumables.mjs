import { useConsumable, parseSpellItemName, PERMANENT_POTION_LIMIT } from "../../helpers/consumables.mjs";
import { expiredConditionIds, expireConditions, dropExpiredConditions } from "../../helpers/expiry.mjs";
import { applyConsumableEffects } from "../../helpers/consumables.mjs";
import { buildScrollCast } from "../../helpers/scroll-cast.mjs";
import { processActorRoundEnd, processCombatEnd } from "../../helpers/round-end.mjs";
import { resolveCastContext } from "../../dice/dice.mjs";
import { postConsumableCard, consumableActionEntries } from "../../chat/consumable-card.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import { rerollMessage } from "../../chat/ai-favor-reroll.mjs";
import {
  createTestCharacter, createTestMob, createTestItem, createTestCombat, deleteTestActor, deleteTestCombat,
  waitFor, withFakeTargets, withPinnedDice, withSetting, PIN_D20_MID, useQuenchTimeout,
} from "../helpers.mjs";

const MAGIC_MISSILE = "Compendium.carl-rpg.skills-and-spells.Item.mK52l4gB8AAiWOCw";
const HEAL_SELF = "Compendium.carl-rpg.skills-and-spells.Item.oWy4kMpmaSJ7RUD8";
const HOLE = "Compendium.carl-rpg.skills-and-spells.Item.NwEkYkSI1oC6Mf36";
// A Spell cast with an ordinary Check: no "attack" or "heal" keyword, not Passive or toggled.
const PANTY_DROPPER = "Compendium.carl-rpg.skills-and-spells.Item.DUR5prpDmb3qdj5r";

const keys = (actor) => (actor.system.conditions ?? []).map((c) => c.key);

/** Chat messages created while `fn` runs are removed afterwards. */
async function quietly(fn) {
  const before = new Set(game.messages.map((m) => m.id));
  try {
    return await withFakeTargets([], fn);
  } finally {
    const extra = game.messages.filter((m) => !before.has(m.id)).map((m) => m.id);
    if (extra.length) await ChatMessage.deleteDocuments(extra);
  }
}

/** A gear item with consumable data. */
function consumableItem(actor, label, consumable, extra = {}) {
  return createTestItem(actor, "item", label, { system: { quantity: 1, consumable, ...extra } });
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.consumables",
    (context) => {
      const { describe, it, assert } = context;

      describe("Time and condition plumbing", function () {
        useQuenchTimeout(this);

        it("a combat round advances world time by 10 seconds (p.62)", async function () {
          const actor = await createTestCharacter();
          const { combat } = await createTestCombat(actor);
          try {
            await combat.startCombat();
            const before = game.time.worldTime;
            await combat.nextRound();
            await waitFor(() => game.time.worldTime !== before, { message: "world time never moved" });
            assert.equal(game.time.worldTime - before, 10);
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("editing a condition on the Conditions tab keeps the fields it doesn't show", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({ "system.conditions": [{
              key: "custom", label: "Iron Skin", stacks: 1, remaining: null, source: "Iron Skin Potion", expiresAt: 999999,
              changes: [{ targetType: "resource", target: "dr", mode: "multiply", value: "2" }],
            }] });
            const data = actor.sheet._processFormData(null, null, { object: {
              "system.conditions.0.label": "Renamed", "system.conditions.0.stacks": 1,
              "system.conditions.0.remaining": null, "system.conditions.0.source": "Iron Skin Potion",
            } });
            await actor.update(data);
            const [entry] = actor.system.conditions;
            assert.equal(entry.label, "Renamed");
            assert.equal(entry.key, "custom");
            assert.equal(entry.expiresAt, 999999);
            assert.lengthOf(entry.changes, 1);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("schema defaults", async function () {
          const actor = await createTestCharacter();
          try {
            const item = await createTestItem(actor, "item", "plain");
            assert.equal(item.system.consumable.kind, "");
            assert.isNull(item.system.consumable.heal.slots);
            assert.deepEqual(item.system.consumable.cures, []);
            assert.deepEqual(actor.system.permanentPotions, { stat: 0, skill: 0 });
            await addConditionToActor(actor, "blinded");
            const [entry] = actor.system.conditions;
            assert.isNull(entry.expiresAt);
            assert.isNull(entry.durationType);
            assert.deepEqual(entry.changes, []);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("reads a Scroll or Spellbook's Spell and Rank from its name", function () {
          assert.deepEqual(parseSpellItemName("Scroll of Bang Bro (Rank 3)"), { name: "Bang Bro", rank: 3 });
          assert.deepEqual(parseSpellItemName("Spellbook of Hole"), { name: "Hole", rank: null });
          assert.deepEqual(parseSpellItemName("Healing Potion"), { name: "", rank: null });
        });
      });

      describe("Potions", function () {
        useQuenchTimeout(this);

        it("a healing potion heals and mends, is used up one at a time, and is gone after the last", async function () {
          const actor = await createTestCharacter("drinker", { system: { hb: { value: 3 } } });
          try {
            await addConditionToActor(actor, "minorInjury");
            const potion = await consumableItem(actor, "heal", { kind: "potion", heal: { slots: 5, mend: "minor" } }, { quantity: 2 });
            await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            assert.equal(actor.system.hb.value, 8);
            assert.notInclude(keys(actor), "minorInjury");
            assert.equal(actor.items.get(potion.id)?.system.quantity, 1);
            await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            assert.equal(actor.system.hb.value, actor.system.hb.effectiveMax ?? actor.system.hb.max, "clamped at max");
            assert.notExists(actor.items.get(potion.id), "the last one is used up");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("two Uses at once of the last potion only use it once", async function () {
          const actor = await createTestCharacter("eager", { system: { hb: { value: 2 } } });
          try {
            const potion = await consumableItem(actor, "last", { kind: "potion", heal: { slots: 3 } });
            await quietly(() => Promise.all([
              useConsumable(actor, potion, { skipDialog: true }),
              useConsumable(actor, potion, { skipDialog: true }),
            ]));
            assert.equal(actor.system.hb.value, 5, "healed once");
            assert.notExists(actor.items.get(potion.id));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a healing-only potion under The Taint is refused and kept", async function () {
          const actor = await createTestCharacter("tainted", { system: { hb: { value: 2 } } });
          try {
            const taintKey = Object.entries(CONFIG.CARLRPG.debuffs).find(([, d]) => d.mechanics?.noHealing)?.[0];
            await addConditionToActor(actor, taintKey);
            const potion = await consumableItem(actor, "heal", { kind: "potion", heal: { slots: 3 } });
            assert.isNull(await quietly(() => useConsumable(actor, potion, { skipDialog: true })));
            assert.exists(actor.items.get(potion.id), "kept");
            assert.equal(actor.system.hb.value, 2);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Mana potion restores to full; an Antidote cures Poisoned", async function () {
          const actor = await createTestCharacter("caster", { system: { mana: { value: 0 } } });
          try {
            const mana = await consumableItem(actor, "mana", { kind: "potion", mana: { full: true } });
            await quietly(() => useConsumable(actor, mana, { skipDialog: true }));
            assert.equal(actor.system.mana.value, actor.system.mana.max);
            await addConditionToActor(actor, "poisoned");
            const antidote = await consumableItem(actor, "antidote", { kind: "other", cures: ["poisoned"] });
            await quietly(() => useConsumable(actor, antidote, { skipDialog: true }));
            assert.notInclude(keys(actor), "poisoned");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("permanent Stat potions: two per crawler, ever - the third is refused and kept", async function () {
          const actor = await createTestCharacter();
          try {
            const start = actor.system.stats.cha.value;
            const potion = await consumableItem(actor, "cha", { kind: "potion", permanent: { kind: "stat", target: "cha", value: 2 } }, { quantity: 3 });
            for (let i = 0; i < PERMANENT_POTION_LIMIT; i++) await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            assert.equal(actor.system.stats.cha.value, start + 4);
            assert.equal(actor.system.permanentPotions.stat, 2);
            const third = await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            assert.isNull(third);
            assert.equal(actor.system.stats.cha.value, start + 4);
            assert.equal(actor.items.get(potion.id)?.system.quantity, 1, "not used up");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Skill potion raises an owned Skill, or teaches one it doesn't have", async function () {
          const actor = await createTestCharacter();
          try {
            const skill = await createTestItem(actor, "skill", "Lockpicking", { name: "Quench Lockpicking", system: { rank: 2 } });
            const raise = await consumableItem(actor, "raise", { kind: "potion", permanent: { kind: "skill", target: "Quench Lockpicking", value: 3 } });
            await quietly(() => useConsumable(actor, raise, { skipDialog: true }));
            assert.equal(actor.items.get(skill.id).system.rank, 5);
            const teach = await consumableItem(actor, "teach", { kind: "potion", permanent: { kind: "skill", target: "Quench Brand New Skill", value: 2 } });
            await quietly(() => useConsumable(actor, teach, { skipDialog: true }));
            assert.equal(actor.items.find((i) => i.name === "Quench Brand New Skill")?.system.rank, 2);
            assert.equal(actor.system.permanentPotions.skill, 2);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Skill potion for a Skill already at its cap is refused, kept and not counted", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "skill", "Maxed", { name: "Quench Maxed Skill", system: { rank: 15 } });
            const potion = await consumableItem(actor, "maxed", { kind: "potion", permanent: { kind: "skill", target: "Quench Maxed Skill", value: 3 } });
            assert.isNull(await quietly(() => useConsumable(actor, potion, { skipDialog: true })));
            assert.exists(actor.items.get(potion.id), "kept");
            assert.equal(actor.system.permanentPotions.skill, 0, "not counted");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Iron Skin doubles DR until it expires; a second drink refreshes it", async function () {
          const actor = await createTestCharacter("iron", { system: { dr: 2 } });
          try {
            const buff = {
              kind: "potion",
              buff: { label: "Iron Skin", duration: 30, unit: "minutes", changes: [{ targetType: "resource", target: "dr", mode: "multiply", value: "2" }] },
            };
            const potion = await consumableItem(actor, "iron", buff, { quantity: 2 });
            await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            assert.equal(actor.system.drEffective, 4);
            await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            const buffs = actor.system.conditions.filter((c) => c.label === "Iron Skin");
            assert.lengthOf(buffs, 1, "refreshed, not stacked");
            assert.equal(actor.system.drEffective, 4);

            const later = buffs[0].expiresAt + 1;
            assert.include(expiredConditionIds(actor.system.conditions, later), buffs[0].id);
            await expireConditions(actor, later);
            assert.lengthOf(actor.system.conditions, 0);
            assert.equal(actor.system.drEffective, 2);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Mana Refill in a fight restores Mana at each round end for its rounds, then ends", async function () {
          const actor = await createTestCharacter("refill", { system: { mana: { value: 0 }, stats: { int: { value: 20 } } } });
          const { combat } = await createTestCombat(actor);
          try {
            await combat.startCombat();
            const max = actor.system.mana.max;
            assert.isAtLeast(max, 16, "room for a first restore that isn't clamped");
            const potion = await consumableItem(actor, "refill", {
              kind: "potion",
              buff: { label: "Mana Refill", duration: 2, unit: "rounds", perRound: { mana: 15 } },
            });
            await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            const entry = actor.system.conditions.find((c) => c.label === "Mana Refill");
            assert.exists(entry);
            assert.equal(entry.durationType, "rounds", "counts round ends in a fight");
            assert.equal(entry.remaining, 2);
            assert.isNull(entry.expiresAt);
            assert.equal(actor.system.mana.value, 0, "nothing until a round ends");

            await quietly(() => processActorRoundEnd(actor));
            assert.equal(actor.system.mana.value, 15);
            await quietly(() => processActorRoundEnd(actor));
            assert.equal(actor.system.mana.value, Math.min(30, max), "clamped at max");
            assert.notExists(actor.system.conditions.find((c) => c.label === "Mana Refill"), "gone after its rounds");
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("outside a fight, a per-round restore lands all at once and leaves nothing behind", async function () {
          const actor = await createTestCharacter("calm", { system: { mana: { value: 0 }, stats: { int: { value: 20 } } } });
          try {
            const potion = await consumableItem(actor, "refill", {
              kind: "potion",
              buff: { label: "Mana Refill", duration: 10, unit: "rounds", perRound: { mana: 15 } },
            });
            await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            assert.equal(actor.system.mana.value, Math.min(150, actor.system.mana.max));
            assert.isAbove(actor.system.mana.value, 0);
            assert.notExists(actor.system.conditions.find((c) => c.label === "Mana Refill"));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("outside a fight, a round-measured Buff with bonuses runs on the clock", async function () {
          const actor = await createTestCharacter("calm", { system: { dr: 2 } });
          try {
            const potion = await consumableItem(actor, "brief", {
              kind: "potion",
              buff: { label: "Brief Skin", duration: 10, unit: "rounds", changes: [{ targetType: "resource", target: "dr", mode: "multiply", value: "2" }] },
            });
            const before = game.time.worldTime;
            await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            const entry = actor.system.conditions.find((c) => c.label === "Brief Skin");
            assert.isNull(entry.durationType);
            assert.equal(entry.expiresAt, before + 100, "10 rounds of 10 seconds");
            assert.equal(actor.system.drEffective, 4);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a round-end heal ends every 'until healed' Debuff; damage it offsets still ends Terrified", async function () {
          const actor = await createTestCharacter("mixed", { system: { hb: { value: 5 } } });
          try {
            await actor.update({ "system.conditions": [
              { key: "sepsis", label: "", stacks: 1, source: "Quench" },
              { key: "terrified", label: "", stacks: 1, source: "Quench", remaining: 2 },
              { key: "poisoned", label: "", stacks: 1, source: "Quench" },
              { key: "custom", label: "Regeneration", stacks: 1, source: "Quench", durationType: "rounds", remaining: 3, perRound: { hb: 2 } },
            ] });
            await quietly(() => withSetting("currentFloor", 1, () => withPinnedDice(PIN_D20_MID, () => processActorRoundEnd(actor))));
            assert.notInclude(keys(actor), "sepsis", "healed - Sepsis ends");
            assert.notInclude(keys(actor), "terrified", "the Poison still took slots");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("when the fight ends, a round-counted restore pays out what it still owes; bonuses carry on on the clock", async function () {
          const actor = await createTestCharacter("payout", { system: { mana: { value: 0 }, dr: 2, stats: { int: { value: 30 } } } });
          const { combat } = await createTestCombat(actor);
          try {
            await combat.startCombat();
            const refill = await consumableItem(actor, "refill", {
              kind: "potion", buff: { label: "Mana Refill", duration: 10, unit: "rounds", perRound: { mana: 2 } },
            });
            const skin = await consumableItem(actor, "skin", {
              kind: "other", buff: { label: "Brief Skin", duration: 5, unit: "rounds", changes: [{ targetType: "resource", target: "dr", mode: "multiply", value: "2" }] },
            });
            await quietly(() => useConsumable(actor, refill, { skipDialog: true }));
            await quietly(() => useConsumable(actor, skin, { skipDialog: true }));
            await quietly(() => processActorRoundEnd(actor));
            assert.equal(actor.system.mana.value, 2, "one round's restore");

            const now = game.time.worldTime;
            await quietly(() => processCombatEnd(combat));
            assert.equal(actor.system.mana.value, 20, "the other 9 rounds paid at once");
            assert.notExists(actor.system.conditions.find((c) => c.label === "Mana Refill"));
            const skinEntry = actor.system.conditions.find((c) => c.label === "Brief Skin");
            assert.exists(skinEntry, "bonuses carry on");
            assert.isNull(skinEntry.durationType);
            assert.equal(skinEntry.expiresAt, now + 40, "its 4 remaining rounds, on the clock");
            assert.equal(actor.system.drEffective, 4);
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("in a fight, a per-round restore measured in minutes counts rounds too", async function () {
          const actor = await createTestCharacter("minutes");
          const { combat } = await createTestCombat(actor);
          try {
            await combat.startCombat();
            const potion = await consumableItem(actor, "trickle", {
              kind: "potion", buff: { label: "Trickle", duration: 1, unit: "minutes", perRound: { mana: 1 } },
            });
            await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            const entry = actor.system.conditions.find((c) => c.label === "Trickle");
            assert.equal(entry.durationType, "rounds");
            assert.equal(entry.remaining, 6, "one minute is six rounds");
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("an Apply clicked after its fight ended treats the potion as drunk outside one", async function () {
          const actor = await createTestCharacter("late", { system: { mana: { value: 0 }, stats: { int: { value: 30 } } } });
          try {
            const effects = { kind: "potion", buff: { label: "Mana Refill", duration: 10, unit: "rounds", perRound: { mana: 2 } } };
            await applyConsumableEffects(actor, effects, {
              itemName: "Late Refill", isPotion: true, drankAt: { combatId: "a-finished-fight", round: 3 },
            });
            assert.equal(actor.system.mana.value, 20, "all at once");
            assert.notExists(actor.system.conditions.find((c) => c.label === "Mana Refill"));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a per-round heal doesn't revive the dead", async function () {
          const crawler = await createTestCharacter("dead");
          const mob = await createTestMob("dead mob");
          try {
            const regen = { key: "custom", label: "Regeneration", stacks: 1, source: "Quench", durationType: "rounds", remaining: 3, perRound: { hb: 2 } };
            await crawler.update({ "system.hb.value": 0 });
            const dying = crawler.system.conditions.find((c) => c.key === "dying");
            await crawler.setFlag("carl-rpg", "dyingAnnounced", dying.id);
            await crawler.update({ "system.conditions": [...crawler.system.toObject().conditions, regen] });
            await mob.update({ "system.hb.value": 0, "system.conditions": [regen] });
            await quietly(() => processActorRoundEnd(crawler));
            await quietly(() => processActorRoundEnd(mob));
            assert.equal(crawler.system.hb.value, 0, "a crawler whose countdown ran out stays down");
            assert.equal(mob.system.hb.value, 0, "a Mob at 0 stays down");
          } finally {
            await deleteTestActor(crawler);
            await deleteTestActor(mob);
          }
        });

        it("healed out of Dying but knocked back to 0 by damage the same round end: Dying again", async function () {
          const actor = await createTestCharacter("unlucky");
          try {
            await actor.update({ "system.hb.value": 0 });
            await actor.update({ "system.conditions": [...actor.system.toObject().conditions,
              { key: "poisoned", label: "", stacks: 1, source: "Quench" },
              { key: "custom", label: "Regeneration", stacks: 1, source: "Quench", durationType: "rounds", remaining: 3, perRound: { hb: 1 } },
            ] });
            // A high Floor makes the Poison hit hard and the CON save fail.
            await quietly(() => withSetting("currentFloor", 20, () => withPinnedDice(PIN_D20_MID, () => processActorRoundEnd(actor))));
            assert.equal(actor.system.hb.value, 0);
            assert.include(keys(actor), "dying", "Dying again");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a restore each round with no duration is refused and kept", async function () {
          const actor = await createTestCharacter();
          try {
            const potion = await consumableItem(actor, "forever", { kind: "potion", buff: { perRound: { mana: 5 } } });
            assert.isNull(await quietly(() => useConsumable(actor, potion, { skipDialog: true })));
            assert.exists(actor.items.get(potion.id));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a per-round heal that lifts a Dying crawler ends Dying before the countdown ticks", async function () {
          const actor = await createTestCharacter("saved");
          try {
            await actor.update({ "system.hb.value": 0 });
            assert.include(keys(actor), "dying");
            await actor.update({ "system.conditions": [...actor.system.toObject().conditions, {
              key: "custom", label: "Regeneration", stacks: 1, source: "Quench", durationType: "rounds", remaining: 3,
              perRound: { hb: 2 },
            }] });
            const result = await quietly(() => processActorRoundEnd(actor));
            assert.equal(actor.system.hb.value, 2);
            assert.notInclude(keys(actor), "dying");
            assert.isFalse(result.lines.some((l) => l.includes(game.i18n.format("CARLRPG.RoundEnd.DyingDead", { name: "" }).trim())), "never declared dead");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Potion Sickness: a second potion within two rounds Poisons for two round ends", async function () {
          const actor = await createTestCharacter("greedy", { system: { hb: { value: 2 } } });
          const { combat } = await createTestCombat(actor);
          try {
            await combat.startCombat();
            const potion = await consumableItem(actor, "sip", { kind: "potion", heal: { slots: 1 } }, { quantity: 3 });
            await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            assert.notInclude(keys(actor), "poisoned", "the first is fine");
            await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            const sick = actor.system.conditions.find((c) => c.key === "poisoned");
            assert.exists(sick);
            assert.equal(sick.durationType, "rounds");
            assert.equal(sick.remaining, 2);

            await quietly(() => withPinnedDice(PIN_D20_MID, () => processActorRoundEnd(actor)));
            await quietly(() => withPinnedDice(PIN_D20_MID, () => processActorRoundEnd(actor)));
            assert.notInclude(keys(actor), "poisoned", "gone after two round ends");

            // Two rounds after the last potion is fine again. (Reset first:
            // the Poison ticks may have left the crawler Dying.)
            await actor.update({ "system.hb.value": 10, "system.conditions": [] });
            await actor.setFlag("carl-rpg", "lastPotion", { combatId: combat.id, round: combat.round - 2 });
            await quietly(() => useConsumable(actor, potion, { skipDialog: true }));
            assert.notInclude(keys(actor), "poisoned");
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("goes to the one targeted token; a permanent potion for a Mob is refused and kept", async function () {
          const actor = await createTestCharacter("giver");
          const friend = await createTestCharacter("friend", { system: { hb: { value: 4 } } });
          const mob = await createTestMob("mob");
          try {
            const potion = await consumableItem(actor, "heal", { kind: "potion", heal: { slots: 3 } });
            const before = game.messages.size;
            await withFakeTargets([{ actor: friend }], () => useConsumable(actor, potion, { skipDialog: true }));
            assert.equal(friend.system.hb.value, 7);
            const stat = await consumableItem(actor, "stat", { kind: "potion", permanent: { kind: "stat", target: "str", value: 1 } });
            const refused = await withFakeTargets([{ actor: mob }], () => useConsumable(actor, stat, { skipDialog: true }));
            assert.isNull(refused);
            assert.exists(actor.items.get(stat.id), "not used up");
            const extra = game.messages.contents.slice(before).map((m) => m.id);
            if (extra.length) await ChatMessage.deleteDocuments(extra);
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(friend);
            await deleteTestActor(mob);
          }
        });
      });

      describe("Scrolls and Spellbooks", function () {
        useQuenchTimeout(this);

        it("a Scroll's Spell is built at the scroll's Rank, with its unlocked Upgrade damage", async function () {
          const actor = await createTestCharacter();
          try {
            const source = await fromUuid(MAGIC_MISSILE);
            const { item, castAs } = buildScrollCast(actor, source.toObject(), 5);
            assert.equal(item.system.rank, 5);
            assert.notEqual(item.id, source.id, "a fresh id");
            assert.equal(castAs.skillEntry.rank, 5);
            assert.isAtLeast(castAs.skillEntry.damage.baseDice.length, 2, "base dice plus the Rank 5 +1d4");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("casting from a Scroll costs no Mana, marks nothing, and uses the scroll up", async function () {
          const actor = await createTestCharacter("scribe", { system: { mana: { value: 9 } } });
          try {
            const scroll = await consumableItem(actor, "Scroll of Magic Missile", { kind: "scroll", spell: { uuid: MAGIC_MISSILE, rank: 5 } });
            const message = await quietly(async () => {
              const m = await withPinnedDice(PIN_D20_MID, () => useConsumable(actor, scroll, { skipDialog: true }));
              return m ? { flags: foundry.utils.deepClone(m.flags) } : null;
            });
            assert.exists(message);
            assert.equal(actor.system.mana.value, 9);
            assert.notExists(actor.items.find((i) => i.name === "Magic Missile"), "the Spell isn't added to the caster");
            assert.notExists(actor.items.get(scroll.id), "the scroll turns to dust");
            assert.equal(message.flags["carl-rpg"].aiReroll?.castAs?.rank, 5, "a reroll can rebuild it");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("an AI Favor reroll of a Scroll's Attack rebuilds its Spell", async function () {
          const actor = await createTestCharacter("lucky", { system: { details: { aiFavor: 1 } } });
          try {
            const scroll = await consumableItem(actor, "Scroll of Magic Missile", { kind: "scroll", spell: { uuid: MAGIC_MISSILE, rank: 5 } });
            await quietly(async () => {
              const original = await withPinnedDice(PIN_D20_MID, () => useConsumable(actor, scroll, { skipDialog: true }));
              assert.isTrue(await withPinnedDice(PIN_D20_MID, () => rerollMessage(original)));
              assert.equal(actor.system.details.aiFavor, 0);
              assert.isTrue(original.getFlag("carl-rpg", "aiRerolled"));
            });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Scroll of a Spell with no roll (Hole) states its effect and is used up", async function () {
          const actor = await createTestCharacter();
          try {
            const scroll = await consumableItem(actor, "Scroll of Hole", { kind: "scroll", spell: { uuid: HOLE, rank: 10 } });
            const card = await quietly(async () => {
              const m = await useConsumable(actor, scroll, { skipDialog: true });
              return m ? m.content : null;
            });
            assert.exists(card);
            assert.include(card, "Rank 10", "the Rank 10 Upgrade is listed");
            assert.notExists(actor.items.get(scroll.id));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a healing Scroll heals without Mana; a Scroll whose Spell can't be found is kept", async function () {
          const actor = await createTestCharacter("healer", { system: { mana: { value: 9 } } });
          try {
            const scroll = await consumableItem(actor, "Scroll of Heal Self", { kind: "scroll", spell: { uuid: HEAL_SELF, rank: 1 } });
            await quietly(() => useConsumable(actor, scroll, { skipDialog: true }));
            assert.equal(actor.system.mana.value, 9);
            assert.notExists(actor.items.get(scroll.id));
            const lost = await consumableItem(actor, "Scroll of Quench Nonexistent Spell (Rank 2)", { kind: "scroll" });
            assert.isNull(await quietly(() => useConsumable(actor, lost, { skipDialog: true })));
            assert.exists(actor.items.get(lost.id), "kept");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Spellbook teaches its Spell, raises a lower one, never lowers one, and rolls a blank Rank", async function () {
          const actor = await createTestCharacter();
          try {
            const book = (rank) => consumableItem(actor, "book", { kind: "spellbook", spell: { uuid: HOLE, rank } });
            const hole = () => actor.items.find((i) => i.type === "spell" && i.name === "Hole");
            await quietly(async () => useConsumable(actor, await book(2), { skipDialog: true }));
            assert.equal(hole()?.system.rank, 2);
            await quietly(async () => useConsumable(actor, await book(4), { skipDialog: true }));
            assert.equal(hole().system.rank, 4);
            const lesser = await book(1);
            assert.isNull(await quietly(() => useConsumable(actor, lesser, { skipDialog: true })));
            assert.equal(hole().system.rank, 4, "never lowered");
            assert.exists(actor.items.get(lesser.id), "a book that can't teach more is kept");

            const blank = await consumableItem(actor, "blank", { kind: "spellbook", spell: { uuid: MAGIC_MISSILE } });
            await quietly(() => useConsumable(actor, blank, { skipDialog: true }));
            const learned = actor.items.find((i) => i.type === "spell" && i.name === "Magic Missile");
            assert.isAtLeast(learned.system.rank, 1);
            assert.isAtMost(learned.system.rank, 5);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });


      describe("Paths a GM-only run would otherwise skip", function () {
        useQuenchTimeout(this);

        it("a potion for someone else waits for Apply, then lands - judged from the round it was drunk", async function () {
          const giver = await createTestCharacter("giver");
          const friend = await createTestCharacter("friend", { system: { hb: { value: 3 } } });
          try {
            await quietly(async () => {
              const effects = { kind: "potion", heal: { slots: 2 } };
              const message = await postConsumableCard({
                actor: giver, recipient: friend, item: { name: "Test Potion", img: "icons/svg/heal.svg" },
                effects, isPotion: true, drankAt: { combatId: "quench-combat", round: 3 }, lines: null,
              });
              assert.isFalse(message.getFlag("carl-rpg", "consumableApplied"));
              assert.equal(message.getFlag("carl-rpg", "consumableDrankAt").round, 3);
              assert.include(message.content, "carl-apply-consumable", "the card offers Apply");

              // The last potion was the round before it was drunk: Sickness,
              // whenever Apply is clicked.
              await friend.setFlag("carl-rpg", "lastPotion", { combatId: "quench-combat", round: 2 });
              const apply = consumableActionEntries.find((e) => e.action === "applyConsumable");
              await apply.onClick({ preventDefault() {} }, message);
              assert.equal(friend.system.hb.value, 5);
              assert.include(keys(friend), "poisoned");
              assert.isTrue(message.getFlag("carl-rpg", "consumableApplied"), "marked once the effects are in");
            });
          } finally {
            await deleteTestActor(giver);
            await deleteTestActor(friend);
          }
        });

        it("moving the clock ends a timed effect on its own", async function () {
          const actor = await createTestCharacter("timed");
          try {
            await actor.update({ "system.conditions": [{
              key: "custom", label: "Quench Short Buff", stacks: 1, remaining: null, source: "Quench",
              expiresAt: game.time.worldTime + 5,
            }] });
            await quietly(async () => {
              await game.time.advance(10);
              await waitFor(() => !actor.system.conditions.length, { message: "the expiry sweep never removed it" });
            });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a rest's first step ends only what runs out before the rest does", async function () {
          const actor = await createTestCharacter("rester");
          try {
            const now = game.time.worldTime;
            await actor.update({ "system.conditions": [
              { key: "custom", label: "Ends during the rest", stacks: 1, source: "Quench", expiresAt: now + 60 },
              { key: "custom", label: "Outlasts the rest", stacks: 1, source: "Quench", expiresAt: now + 99999 },
              { key: "minorInjury", label: "", stacks: 1, source: "Quench" },
            ] });
            const ended = await dropExpiredConditions(actor, now + 3600);
            assert.deepEqual(ended, ["Ends during the rest"]);
            assert.sameMembers(actor.system.conditions.map((c) => c.label || c.key), ["Outlasts the rest", "minorInjury"]);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("combat ending clears Potion Sickness's round-counted Poison, but not ordinary Poison", async function () {
          const actor = await createTestCharacter("sick");
          const { combat } = await createTestCombat(actor);
          try {
            await actor.update({ "system.conditions": [
              { key: "poisoned", label: "", stacks: 1, source: "Potion Sickness", durationType: "rounds", remaining: 2 },
              { key: "poisoned", label: "", stacks: 1, source: "A spider" },
            ] });
            await quietly(() => processCombatEnd(combat));
            assert.deepEqual(actor.system.conditions.map((c) => c.source), ["A spider"]);
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });

        it("a Scroll of a Spell with an ordinary Check rolls it, free, and is used up", async function () {
          const actor = await createTestCharacter("charmer", { system: { mana: { value: 9 } } });
          try {
            const scroll = await consumableItem(actor, "Scroll of Panty Dropper", { kind: "scroll", spell: { uuid: PANTY_DROPPER, rank: 2 } });
            const flags = await quietly(async () => {
              const m = await withPinnedDice(PIN_D20_MID, () => useConsumable(actor, scroll, { skipDialog: true }));
              return m ? foundry.utils.deepClone(m.flags) : null;
            });
            assert.exists(flags, "a Check card was posted");
            assert.equal(flags["carl-rpg"].aiReroll?.kind, "check");
            assert.equal(actor.system.mana.value, 9);
            assert.notExists(actor.items.get(scroll.id));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Scroll keeps the caster's general bonuses but not their own copy's Spell bonuses", async function () {
          const actor = await createTestCharacter("bonused");
          try {
            await createTestItem(actor, "item", "Flanking Gloves", { system: { equipped: true, changes: [{
              label: "Quench Flanking", targetType: "custom", target: "attackBonus", mode: "add", value: "2",
              conditions: [{ label: "Flanking" }],
            }] } });
            await createTestItem(actor, "spell", "own copy", { name: "Magic Missile", system: { rank: 2, changes: [{
              label: "Quench Own Copy", targetType: "skillDamage", target: "Magic Missile", mode: "add", value: "1",
              conditions: [{ label: "Own copy" }],
            }] } });
            const source = await fromUuid(MAGIC_MISSILE);
            const { item, castAs } = buildScrollCast(actor, source.toObject(), 5);
            const labels = resolveCastContext(actor, item, castAs).conditionalModifiers.map((cm) => cm.label);
            assert.include(labels, "Quench Flanking");
            assert.notInclude(labels, "Quench Own Copy");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("clicking a consumable's icon uses it; plain gear still just posts its description", async function () {
          const actor = await createTestCharacter("clicker", { system: { hb: { value: 3 } } });
          try {
            const potion = await consumableItem(actor, "heal", { kind: "potion", heal: { slots: 2 } });
            const rope = await createTestItem(actor, "item", "Rope");
            await quietly(async () => {
              await potion.roll();
              assert.equal(actor.system.hb.value, 5);
              assert.notExists(actor.items.get(potion.id));
              const card = await rope.roll();
              assert.exists(card, "a description card");
              assert.exists(actor.items.get(rope.id), "not used up");
            });
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("The Consumables compendium", function () {
        useQuenchTimeout(this);

        it("every entry is a consumable, and its scrolls and spellbooks link to real Spells", async function () {
          const pack = game.packs.get("carl-rpg.consumables");
          assert.exists(pack, "run npm run build:packs with the world closed");
          const docs = await pack.getDocuments();
          assert.isAtLeast(docs.length, 10);
          for (const doc of docs) {
            assert.equal(doc.type, "item", doc.name);
            assert.isNotEmpty(doc.system.consumable.kind, `${doc.name} has a Consumable kind`);
            if (["scroll", "spellbook"].includes(doc.system.consumable.kind)) {
              const spell = await fromUuid(doc.system.consumable.spell.uuid);
              assert.equal(spell?.type, "spell", `${doc.name} links to a Spell`);
            }
          }
        });
      });
    },
    { displayName: "CarlRPG: Consumables" },
  );
}
