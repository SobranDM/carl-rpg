import CarlDice from "../../dice/dice.mjs";
import { isHandToHand, takesDamageEffects, withoutOutclassedUnarmed } from "../../helpers/hand-to-hand.mjs";
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
  return createTestItem(actor, "skill", name, { name, system: { category: "attack", rank, ...extra } });
}

/** A hand-to-hand one (the Hand-to-Hand box ticked). */
function handToHand(actor, name, rank) {
  return attackSkill(actor, name, rank, { isHandToHand: true });
}

const PACK = "carl-rpg.skills-and-spells";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.hand-to-hand",
    (context) => {
      const { describe, it, assert } = context;

      describe("Hand-to-hand Combat Skills (p.179)", function () {
        useQuenchTimeout(this);

        it("the Hand-to-Hand box marks one, homebrew included; only Unarmed Combat refuses Damage Effects", async function () {
          const actor = await createTestCharacter("h2h box");
          try {
            const homebrew = await handToHand(actor, "Flying Elbow", 1);
            const unarmed = await handToHand(actor, "Unarmed Combat", 1);
            const sword = await attackSkill(actor, "Longsword", 1);
            assert.isTrue(isHandToHand(homebrew));
            assert.isTrue(isHandToHand(unarmed));
            assert.isFalse(isHandToHand(sword), "box unticked");
            assert.isFalse(takesDamageEffects(unarmed));
            assert.isTrue(takesDamageEffects(homebrew));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the compendium's five hand-to-hand Skills (p.179) have the box ticked, and only they do", async function () {
          const index = await game.packs.get(PACK).getIndex({ fields: ["system.category", "system.isHandToHand"] });
          const ticked = index.filter((e) => e.system?.isHandToHand).map((e) => e.name).sort();
          assert.deepEqual(ticked, ["Foot Soldier", "Noggin Nocker", "Pugilism", "Unarmed Combat", "Wrasslin'"]);
        });

        it("the Attacks list drops Unarmed Combat only when another hand-to-hand Skill outranks it", async function () {
          const actor = await createTestCharacter("h2h list");
          try {
            const unarmed = await handToHand(actor, "Unarmed Combat", 3);
            const sword = await attackSkill(actor, "Longsword", 8);
            const list = () => withoutOutclassedUnarmed(actor, actor.items.filter((i) => i.type === "skill"));
            assert.include(list(), unarmed, "a weapon Skill doesn't count");

            const pugilism = await handToHand(actor, "Pugilism", 3);
            assert.include(list(), unarmed, "equal isn't higher");

            await pugilism.update({ "system.rank": 4 });
            await waitFor(() => !list().includes(unarmed), { message: "Rank 4 Pugilism should outclass Rank 3 Unarmed Combat" });
            assert.includeMembers(list(), [sword, pugilism]);

            // A homebrew one counts too, once its box is ticked.
            await pugilism.update({ "system.rank": 1 });
            const elbow = await attackSkill(actor, "Flying Elbow", 6);
            await waitFor(() => list().includes(unarmed));
            await elbow.update({ "system.isHandToHand": true });
            await waitFor(() => !list().includes(unarmed), { message: "a ticked homebrew Skill should outclass it too" });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("on the sheet: gone from the Combat tab's Attacks, still on Skills & Spells", async function () {
          const actor = await createTestCharacter("h2h sheet");
          const sheet = actor.sheet;
          try {
            const unarmed = await handToHand(actor, "Unarmed Combat", 3);
            const pugilism = await handToHand(actor, "Pugilism", 5);
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const attacks = sheet.element.querySelector(".carl-combat-attacks");
            assert.exists(attacks.querySelector(`[data-item-id="${pugilism.id}"]`));
            assert.notExists(attacks.querySelector(`[data-item-id="${unarmed.id}"]`));
            assert.exists(sheet.element.querySelector(`section.tab[data-tab="skills"] [data-item-id="${unarmed.id}"]`));
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });

        it("Unarmed Combat is never offered a Damage Effect, and a Damage Effect can't run through it", async function () {
          const actor = await createTestCharacter("h2h effects");
          try {
            const unarmed = await handToHand(actor, "Unarmed Combat", 3);
            const pugilism = await handToHand(actor, "Pugilism", 3);
            const onlyUnarmed = await createTestItem(actor, "damageEffect", "fist of nope", {
              system: { rank: 1, parentSkills: [unarmed.name] },
            });
            await createTestItem(actor, "damageEffect", "iron punch", {
              system: { rank: 1, parentSkills: [unarmed.name, pugilism.name] },
            });

            assert.isNull(await CarlDice.rollDamageEffect(actor, onlyUnarmed), "refused");

            const radios = (d) => d.element.querySelectorAll('input[name="damageEffectId"]').length;
            await withDialog(() => CarlDice.rollAttack(actor, unarmed), (d) => {
              assert.equal(radios(d), 0, "Unarmed Combat: no Damage Effect list");
              pressDialog(d, "cancel");
            }, "carl-roll-dialog");
            await withDialog(() => CarlDice.rollAttack(actor, pugilism), (d) => {
              assert.isAbove(radios(d), 0, "Pugilism still gets its Damage Effects");
              pressDialog(d, "cancel");
            }, "carl-roll-dialog");

            // Not even one handed in directly (a macro).
            const message = await CarlDice.rollAttack(actor, unarmed, { damageEffectItem: onlyUnarmed, skipDialog: true });
            try {
              assert.isNull(message.getFlag("carl-rpg", "aiReroll")?.damageEffectItemId ?? null, "the Damage Effect was dropped");
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
