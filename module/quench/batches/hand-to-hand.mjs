import CarlDice from "../../dice/dice.mjs";
import {
  isHandToHand,
  takesDamageEffects,
  withoutOutclassedUnarmed,
} from "../../helpers/hand-to-hand.mjs";
import { attackChoices } from "../../helpers/weapons.mjs";
import {
  createTestCharacter,
  createTestItem,
  deleteTestActor,
  pressDialog,
  useQuenchTimeout,
  waitFor,
  withDialog,
} from "../helpers.mjs";

/** An Attack Skill with this exact name and Rank. */
function attackSkill(actor, name, rank, extra = {}) {
  return createTestItem(actor, "skill", name, {
    name,
    system: { category: "attack", rank, ...extra },
  });
}

/** A hand-to-hand one (the Hand-to-Hand box ticked). */
function handToHand(actor, name, rank, extra = {}) {
  return attackSkill(actor, name, rank, { isHandToHand: true, ...extra });
}

/** Unarmed Combat as the pack has it: hand-to-hand, No Damage Effects. */
function unarmedCombat(actor, rank) {
  return handToHand(actor, "Unarmed Combat", rank, { noDamageEffects: true });
}

const PACK = "carl-rpg.skills-and-spells";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.hand-to-hand",
    (context) => {
      const { describe, it, assert } = context;

      describe("Hand-to-hand Combat Skills (p.179)", function () {
        useQuenchTimeout(this);

        it("the Hand-to-Hand box marks one, homebrew included; the No Damage Effects box, not the name, refuses Damage Effects", async function () {
          const actor = await createTestCharacter("h2h box");
          try {
            const homebrew = await handToHand(actor, "Flying Elbow", 1);
            const unarmed = await unarmedCombat(actor, 1);
            const sword = await attackSkill(actor, "Longsword", 1);
            assert.isTrue(isHandToHand(homebrew));
            assert.isTrue(isHandToHand(unarmed));
            assert.isFalse(isHandToHand(sword), "box unticked");
            assert.isFalse(takesDamageEffects(unarmed));
            assert.isTrue(takesDamageEffects(homebrew));
            const slap = await attackSkill(actor, "Gentle Slap", 1, { noDamageEffects: true });
            assert.isFalse(takesDamageEffects(slap), "a homebrew Skill with the box");
            const plainUnarmed = await handToHand(actor, "Unarmed Combat", 1);
            assert.isTrue(takesDamageEffects(plainUnarmed), "the name alone does nothing");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the compendium's five hand-to-hand Skills (p.179) have the box ticked, and only they do", async function () {
          const index = await game.packs
            .get(PACK)
            .getIndex({ fields: ["system.category", "system.isHandToHand"] });
          const ticked = index
            .filter((e) => e.system?.isHandToHand)
            .map((e) => e.name)
            .sort();
          assert.deepEqual(ticked, [
            "Foot Soldier",
            "Noggin Nocker",
            "Pugilism",
            "Unarmed Combat",
            "Wrasslin'",
          ]);
        });

        it("the compendium's Skills have their setting boxes ticked: Needs no weapon, No Damage Effects, Commands pets", async function () {
          const index = await game.packs
            .get(PACK)
            .getIndex({
              fields: ["system.noWeapon", "system.noDamageEffects", "system.commandsPets"],
            });
          const ticked = (box) =>
            index
              .filter((e) => e.system?.[box])
              .map((e) => e.name)
              .sort();
          assert.deepEqual(ticked("noWeapon"), [
            "Back Claw",
            "Bite",
            "Improvised Weapons",
            "Slice Attack",
          ]);
          assert.deepEqual(ticked("noDamageEffects"), ["Unarmed Combat"]);
          assert.deepEqual(ticked("commandsPets"), ["Animal Handling"]);
        });

        it("the Attacks list drops Unarmed Combat only when another hand-to-hand Skill outranks it", async function () {
          const actor = await createTestCharacter("h2h list");
          try {
            const unarmed = await unarmedCombat(actor, 3);
            const sword = await attackSkill(actor, "Longsword", 8);
            const list = () =>
              withoutOutclassedUnarmed(
                actor,
                actor.items.filter((i) => i.type === "skill"),
              );
            assert.include(list(), unarmed, "a weapon Skill doesn't count");

            const pugilism = await handToHand(actor, "Pugilism", 3);
            assert.include(list(), unarmed, "equal isn't higher");

            await pugilism.update({ "system.rank": 4 });
            await waitFor(() => !list().includes(unarmed), {
              message: "Rank 4 Pugilism should outclass Rank 3 Unarmed Combat",
            });
            assert.includeMembers(list(), [sword, pugilism]);

            // A homebrew one counts too, once its box is ticked.
            await pugilism.update({ "system.rank": 1 });
            const elbow = await attackSkill(actor, "Flying Elbow", 6);
            await waitFor(() => list().includes(unarmed));
            await elbow.update({ "system.isHandToHand": true });
            await waitFor(() => !list().includes(unarmed), {
              message: "a ticked homebrew Skill should outclass it too",
            });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the drop-out is the No Damage Effects box's: a homebrew Skill with it drops, an Unarmed Combat without it stays", async function () {
          const actor = await createTestCharacter("h2h list box");
          try {
            const shove = await handToHand(actor, "Feeble Shove", 2, { noDamageEffects: true });
            const plain = await handToHand(actor, "Unarmed Combat", 2);
            const pugilism = await handToHand(actor, "Pugilism", 5);
            const list = () =>
              withoutOutclassedUnarmed(
                actor,
                actor.items.filter((i) => i.type === "skill"),
              );
            assert.notInclude(list(), shove, "a homebrew Skill with the box, outranked");
            assert.include(list(), plain, "Unarmed Combat by name, without the box");
            assert.include(list(), pugilism);
            const lone = await attackSkill(actor, "Weak Jab", 1, { noDamageEffects: true });
            assert.include(list(), lone, "not hand-to-hand: never dropped");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("gone from the Attack! choices, still on the Skills tab", async function () {
          const actor = await createTestCharacter("h2h sheet");
          const sheet = actor.sheet;
          try {
            const unarmed = await unarmedCombat(actor, 3);
            const pugilism = await handToHand(actor, "Pugilism", 5);
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const offered = attackChoices(actor).map((c) => c.skill.id);
            assert.include(offered, pugilism.id);
            assert.notInclude(offered, unarmed.id);
            assert.exists(
              sheet.element.querySelector(
                `section.tab[data-tab="skills"] [data-item-id="${unarmed.id}"]`,
              ),
            );
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });

        it("Unarmed Combat is never offered a Damage Effect, and a Damage Effect can't run through it", async function () {
          const actor = await createTestCharacter("h2h effects");
          try {
            const unarmed = await unarmedCombat(actor, 3);
            const pugilism = await handToHand(actor, "Pugilism", 3);
            const onlyUnarmed = await createTestItem(actor, "damageEffect", "fist of nope", {
              system: { rank: 1, parentSkills: [unarmed.name] },
            });
            await createTestItem(actor, "damageEffect", "iron punch", {
              system: { rank: 1, parentSkills: [unarmed.name, pugilism.name] },
            });

            assert.isNull(await CarlDice.rollDamageEffect(actor, onlyUnarmed), "refused");

            const radios = (d) => d.element.querySelectorAll('input[name="damageEffectId"]').length;
            await withDialog(
              () => CarlDice.rollAttack(actor, unarmed),
              (d) => {
                assert.equal(radios(d), 0, "Unarmed Combat: no Damage Effect list");
                pressDialog(d, "cancel");
              },
              "carl-roll-dialog",
            );
            await withDialog(
              () => CarlDice.rollAttack(actor, pugilism),
              (d) => {
                assert.isAbove(radios(d), 0, "Pugilism still gets its Damage Effects");
                pressDialog(d, "cancel");
              },
              "carl-roll-dialog",
            );

            // A homebrew Skill with the No Damage Effects box: none offered either.
            // (Hand-to-hand, so it needs no weapon to roll.)
            const slap = await handToHand(actor, "Gentle Slap", 3, { noDamageEffects: true });
            await createTestItem(actor, "damageEffect", "slap boost", {
              system: { rank: 1, parentSkills: [slap.name] },
            });
            await withDialog(
              () => CarlDice.rollAttack(actor, slap),
              (d) => {
                assert.equal(
                  radios(d),
                  0,
                  "a homebrew No Damage Effects Skill: no Damage Effect list",
                );
                pressDialog(d, "cancel");
              },
              "carl-roll-dialog",
            );

            // Not even one handed in directly (a macro).
            const message = await CarlDice.rollAttack(actor, unarmed, {
              damageEffectItem: onlyUnarmed,
              skipDialog: true,
            });
            try {
              assert.isNull(
                message.getFlag("carl-rpg", "aiReroll")?.damageEffectItemId ?? null,
                "the Damage Effect was dropped",
              );
            } finally {
              await message?.delete();
            }
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: Hand-to-Hand" },
  );
}
