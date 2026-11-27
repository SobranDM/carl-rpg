/**
 * Healing others (docs/rules-fixes.md A; Heal Others / Heal Self / Heal
 * Critter, p.206): who a heal takes (module/helpers/heal-targets.mjs), the
 * heal card's recipients and Apply (module/chat/heal-card.mjs), and the
 * compendium's heals.
 */
import CarlDice from "../../dice/dice.mjs";
import { healsMode, resolveHealRecipients } from "../../helpers/heal-targets.mjs";
import { healDoneFor, healRows, onApplyHeal } from "../../chat/heal-card.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestPet,
  createTestVehicle,
  deleteTestActor,
  useQuenchTimeout,
  withFakeTargets,
} from "../helpers.mjs";

const fakeEvent = { preventDefault() {} };
const target = (actor) => ({ actor, uuid: actor.uuid, name: actor.name });

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.heal-targets",
    (context) => {
      const { describe, it, assert } = context;

      describe("who a heal takes", function () {
        useQuenchTimeout(this);

        it("Heals defaults from Range: Self only is Self, anything else Anyone", function () {
          assert.equal(healsMode({ system: { range: "Self only" } }), "self");
          assert.equal(healsMode({ system: { range: "30 feet" } }), "anyone");
          assert.equal(healsMode({ system: { range: "" } }), "anyone");
          assert.equal(
            healsMode({ system: { range: "Self only", heals: "others" } }),
            "others",
            "set, it wins",
          );
        });

        it("Self only heals the caster, whoever is targeted", async function () {
          const caster = await createTestCharacter("self");
          const ally = await createTestCharacter("ally");
          try {
            const item = { name: "Heal Self", system: { heals: "self" } };
            const { recipients } = resolveHealRecipients(caster, item, [target(ally)]);
            assert.deepEqual(
              recipients.map((r) => r.actor),
              [caster],
            );
          } finally {
            await deleteTestActor(caster);
            await deleteTestActor(ally);
          }
        });

        it("Others: not yourself, pets or minions; needs a target; one at a time below its Burst tier", async function () {
          const caster = await createTestCharacter("others");
          const ally = await createTestCharacter("ally");
          const ally2 = await createTestCharacter("ally2");
          const pet = await createTestPet("pet");
          const minion = await createTestPet("minion", { system: { isMinion: true } });
          try {
            const item = {
              name: "Heal Others",
              system: {
                heals: "others",
                rank: 10,
                upgrades: [{ rankThreshold: 15, healAllTargets: true }],
              },
            };
            assert.exists(resolveHealRecipients(caster, item, []).refusal, "nothing targeted");
            assert.exists(
              resolveHealRecipients(caster, item, [target(caster)]).refusal,
              "yourself",
            );
            assert.exists(resolveHealRecipients(caster, item, [target(pet)]).refusal, "a pet");
            assert.exists(
              resolveHealRecipients(caster, item, [target(minion)]).refusal,
              "a minion",
            );
            assert.exists(
              resolveHealRecipients(caster, item, [target(ally), target(ally2)]).refusal,
              "two at Rank 10",
            );
            assert.deepEqual(
              resolveHealRecipients(caster, item, [target(ally)]).recipients.map((r) => r.actor),
              [ally],
            );

            const burst = { ...item, system: { ...item.system, rank: 15 } };
            assert.deepEqual(
              resolveHealRecipients(caster, burst, [target(ally), target(ally2)]).recipients.map(
                (r) => r.actor,
              ),
              [ally, ally2],
            );
            assert.exists(
              resolveHealRecipients(caster, burst, [target(ally), target(caster)]).refusal,
              "the Burst still not on yourself",
            );
          } finally {
            for (const a of [caster, ally, ally2, pet, minion]) await deleteTestActor(a);
          }
        });

        it("Pets and minions: only them; Anyone: the caster with nothing targeted; never a vehicle", async function () {
          const caster = await createTestCharacter("critter");
          const ally = await createTestCharacter("ally");
          const pet = await createTestPet("pet");
          const minion = await createTestPet("minion", { system: { isMinion: true } });
          const vehicle = await createTestVehicle("car");
          try {
            const critter = { name: "Heal Critter", system: { heals: "pets" } };
            assert.exists(
              resolveHealRecipients(caster, critter, [target(ally)]).refusal,
              "a crawler",
            );
            assert.exists(
              resolveHealRecipients(caster, critter, []).refusal,
              "nothing targeted, caster isn't a pet",
            );
            assert.deepEqual(
              resolveHealRecipients(caster, critter, [target(pet)]).recipients.map((r) => r.actor),
              [pet],
            );
            assert.deepEqual(
              resolveHealRecipients(caster, critter, [target(minion)]).recipients.map(
                (r) => r.actor,
              ),
              [minion],
            );
            assert.deepEqual(
              resolveHealRecipients(pet, critter, []).recipients.map((r) => r.actor),
              [pet],
              "a pet casting it on itself",
            );

            const anyone = { name: "Nature's Breath", system: { range: "5 feet" } };
            assert.deepEqual(
              resolveHealRecipients(caster, anyone, []).recipients.map((r) => r.actor),
              [caster],
            );
            assert.deepEqual(
              resolveHealRecipients(caster, anyone, [target(pet)]).recipients.map((r) => r.actor),
              [pet],
            );
            assert.exists(resolveHealRecipients(caster, anyone, [target(vehicle)]).refusal);
          } finally {
            for (const a of [caster, ally, pet, minion, vehicle]) await deleteTestActor(a);
          }
        });
      });

      describe("the heal card", function () {
        useQuenchTimeout(this);

        it("heals the targeted ally, names them, and Apply heals them - not the caster", async function () {
          const caster = await createTestCharacter("caster", {
            system: { hb: { value: 2, max: 10 } },
          });
          const ally = await createTestCharacter("ally", { system: { hb: { value: 2, max: 10 } } });
          let message;
          try {
            const spell = await createTestItem(caster, "spell", "Heal Others", {
              system: {
                rank: 1,
                manaCost: 0,
                heals: "others",
                healDice: "3",
                castingKeywords: ["heal"],
              },
            });
            message = await withFakeTargets([{ actor: ally }], () =>
              CarlDice.rollHeal(caster, spell, { skipDialog: true }),
            );
            assert.exists(message);
            assert.equal(message.getFlag("carl-rpg", "healActorUuid"), caster.uuid, "the caster");
            assert.deepEqual(
              healRows(message).map((r) => r.uuid),
              [ally.uuid],
            );
            assert.include(message.content, ally.name, "the card names who it heals");

            await onApplyHeal(fakeEvent, message);
            assert.equal(
              ally.system.hb.value,
              Math.min(5, ally.system.hb.effectiveMax ?? ally.system.hb.max),
            );
            assert.equal(caster.system.hb.value, 2, "the caster is untouched");
            assert.isTrue(healDoneFor(message));
            assert.isTrue(message.getFlag("carl-rpg", "healApplied"));
          } finally {
            await message?.delete();
            await deleteTestActor(caster);
            await deleteTestActor(ally);
          }
        });

        it("a refused heal spends nothing and posts nothing", async function () {
          const caster = await createTestCharacter("refused", { system: { mana: { value: 10 } } });
          try {
            const spell = await createTestItem(caster, "spell", "Heal Others", {
              system: {
                rank: 1,
                manaCost: 3,
                heals: "others",
                healDice: "2",
                castingKeywords: ["heal"],
              },
            });
            const mana = caster.system.mana.value;
            const before = game.messages.size;
            // Explicitly nothing targeted: a token another batch left targeted
            // would otherwise be healed.
            const result = await withFakeTargets([], () =>
              CarlDice.rollHeal(caster, spell, { skipDialog: true }),
            );
            assert.isNull(result, "Heal Others with nothing targeted");
            assert.equal(caster.system.mana.value, mana, "no Mana spent");
            assert.isFalse(caster.items.get(spell.id).system.marked, "not marked");
            assert.equal(game.messages.size, before);
          } finally {
            await deleteTestActor(caster);
          }
        });

        it("Heal Critter heals a pet to full - the Health Bar only, no Short Rest", async function () {
          const caster = await createTestCharacter("critter");
          const pet = await createTestPet("hurt");
          let message;
          try {
            await pet.update({ "system.hb.value": 1 });
            await addConditionToActor(pet, "minorInjury");
            const spell = await createTestItem(caster, "spell", "Heal Critter", {
              system: {
                rank: 1,
                manaCost: 0,
                heals: "pets",
                healToFull: true,
                castingKeywords: ["heal"],
              },
            });
            message = await withFakeTargets([{ actor: pet }], () =>
              CarlDice.rollHeal(caster, spell, { skipDialog: true }),
            );
            assert.isTrue(message.getFlag("carl-rpg", "healFull"));
            assert.isFalse(message.getFlag("carl-rpg", "healRest"));
            await onApplyHeal(fakeEvent, message);
            assert.equal(
              pet.system.hb.value,
              pet.system.hb.effectiveMax ?? pet.system.hb.max,
              "full",
            );
            assert.include(
              pet.system.conditions.map((c) => c.key),
              "minorInjury",
              "no Short Rest",
            );
          } finally {
            await message?.delete();
            await deleteTestActor(caster);
            await deleteTestActor(pet);
          }
        });

        it("Heal Others at Rank 15 heals every targeted party member", async function () {
          const caster = await createTestCharacter("burst");
          const a = await createTestCharacter("a", { system: { hb: { value: 1, max: 10 } } });
          const b = await createTestCharacter("b", { system: { hb: { value: 1, max: 10 } } });
          let message;
          try {
            const spell = await createTestItem(caster, "spell", "Heal Others", {
              system: {
                rank: 15,
                manaCost: 0,
                heals: "others",
                healDice: "2",
                castingKeywords: ["heal"],
                upgrades: [{ rankThreshold: 15, healAllTargets: true }],
              },
            });
            message = await withFakeTargets([{ actor: a }, { actor: b }], () =>
              CarlDice.rollHeal(caster, spell, { skipDialog: true }),
            );
            assert.deepEqual(
              healRows(message).map((r) => r.uuid),
              [a.uuid, b.uuid],
            );
            await onApplyHeal(fakeEvent, message);
            assert.equal(a.system.hb.value, 3);
            assert.equal(b.system.hb.value, 3);
            assert.isTrue(healRows(message).every((r) => r.applied));
          } finally {
            await message?.delete();
            for (const x of [caster, a, b]) await deleteTestActor(x);
          }
        });

        it("a card from before recipients were snapshotted still heals its one actor", async function () {
          const actor = await createTestCharacter("legacy", {
            system: { hb: { value: 3, max: 10 } },
          });
          let message;
          try {
            message = await ChatMessage.create({
              content: "<div></div>",
              flags: { "carl-rpg": { healActorUuid: actor.uuid, healFull: true } },
            });
            await onApplyHeal(fakeEvent, message);
            assert.equal(
              actor.system.hb.value,
              actor.system.hb.effectiveMax ?? actor.system.hb.max,
            );
            assert.isTrue(message.getFlag("carl-rpg", "healApplied"));
          } finally {
            await message?.delete();
            await deleteTestActor(actor);
          }
        });
      });

      describe("the compendium's heals (needs `npm run build:packs`)", function () {
        useQuenchTimeout(this);

        it("Heal and Heal Self are Self only, Heal Others is Others (Rank 15 heals every target), Heal Critter is pets, to full", async function () {
          const pack = game.packs.get("carl-rpg.skills-and-spells");
          assert.exists(pack, "the Skills & Spells compendium");
          const byName = async (name) => {
            const entry = pack.index.find((e) => e.name === name);
            return entry ? pack.getDocument(entry._id) : null;
          };
          const heal = await byName("Heal");
          const self = await byName("Heal Self");
          const others = await byName("Heal Others");
          const critter = await byName("Heal Critter");
          assert.equal(heal?.system.heals, "self");
          assert.equal(self?.system.heals, "self");
          assert.equal(others?.system.heals, "others");
          assert.isTrue(
            others?.system.upgrades.find((u) => u.rankThreshold === 15)?.healAllTargets,
          );
          assert.equal(critter?.system.heals, "pets");
          assert.isTrue(critter?.system.healToFull);
        });
      });
    },
    { displayName: "CarlRPG: Healing Others" },
  );
}
