import CarlDice from "../../dice/dice.mjs";
import { assignItemToSlot } from "../../helpers/equip-slots.mjs";
import { placeInHotlist } from "../../helpers/hotlist.mjs";
import {
  attackChoices,
  attackReadiness,
  isWeaponFor,
  needsWeapon,
} from "../../helpers/weapons.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestPet,
  deleteTestActor,
  openDialog,
  pressDialog,
  settle,
  useQuenchTimeout,
  waitFor,
  withDialog,
} from "../helpers.mjs";

/** An Attack Skill with this exact name. */
function attack(actor, name, system = {}) {
  return createTestItem(actor, "skill", name, {
    name,
    system: { category: "attack", rank: 2, ...system },
  });
}

/** A gear item that's a weapon for this Skill name. */
function weapon(actor, label, weaponSkill) {
  return createTestItem(actor, "item", label, { system: { weaponSkill } });
}

/** Run `fn`, returning the chat messages it posted (then deleting them). */
async function postedBy(fn) {
  const made = [];
  const hook = Hooks.on("createChatMessage", (message) => made.push(message));
  let result;
  try {
    result = await fn();
    await settle(150);
  } finally {
    Hooks.off("createChatMessage", hook);
  }
  for (const message of made) await message.delete().catch(() => null);
  return { result, count: made.length };
}

/** Whether a system dialog with this class is open. */
const dialogOpen = (cssClass) =>
  [...foundry.applications.instances.values()].some(
    (app) =>
      app instanceof foundry.applications.api.DialogV2 &&
      app.rendered &&
      app.element.classList.contains(cssClass),
  );

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.weapons",
    (context) => {
      const { describe, it, assert } = context;

      describe("which Attacks need a weapon", function () {
        useQuenchTimeout(this);

        it("a crawler's Weapon Skill does; hand-to-hand, Needs no weapon Skills and Spells don't", async function () {
          const actor = await createTestCharacter("needs");
          const pet = await createTestPet("needs");
          try {
            assert.isTrue(needsWeapon(actor, await attack(actor, "Longsword")));
            assert.isFalse(
              needsWeapon(actor, await attack(actor, "Pugilism", { isHandToHand: true })),
            );
            assert.isFalse(
              needsWeapon(actor, await attack(actor, "Improvised Weapons", { noWeapon: true })),
            );
            assert.isFalse(
              needsWeapon(actor, await attack(actor, "Tail Swipe", { noWeapon: true })),
              "a homebrew one, by its box",
            );
            assert.isTrue(
              needsWeapon(actor, await attack(actor, "Bite")),
              "the name alone does nothing",
            );
            const spell = await createTestItem(actor, "spell", "zap", {
              system: { castingKeywords: ["attack"] },
            });
            assert.isFalse(needsWeapon(actor, spell));
            assert.isFalse(
              needsWeapon(
                actor,
                await createTestItem(actor, "skill", "sneak", { system: { category: "utility" } }),
              ),
            );
            assert.isFalse(needsWeapon(pet, await attack(pet, "Longsword")), "only crawlers");
          } finally {
            await deleteTestActor(actor);
            await deleteTestActor(pet);
          }
        });

        it("a weapon matches its Weapon Skill by name, any case", async function () {
          const actor = await createTestCharacter("match");
          try {
            const sword = await attack(actor, "Longsword");
            assert.isTrue(isWeaponFor(await weapon(actor, "blade", "longsword"), sword));
            assert.isFalse(isWeaponFor(await weapon(actor, "axe", "Axe"), sword));
            assert.isFalse(
              isWeaponFor(await createTestItem(actor, "item", "rock"), sword),
              "not a weapon",
            );
            // A blank Weapon Skill slugifies to "unknown", as does a Skill
            // named with no letters or digits - still not a weapon.
            const symbols = await attack(actor, "???");
            assert.isFalse(
              isWeaponFor(await weapon(actor, "shield", ""), symbols),
              "blank never matches",
            );
            assert.isFalse(
              isWeaponFor(await weapon(actor, "potion", "   "), symbols),
              "whitespace is blank",
            );
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("attackReadiness and the Attack! choices", function () {
        useQuenchTimeout(this);

        it("ready with the weapon in either hand; from the Hotlist it's swapped; otherwise not ready", async function () {
          const actor = await createTestCharacter("ready");
          try {
            const sword = await attack(actor, "Longsword");
            assert.isFalse(attackReadiness(actor, sword).ready, "no weapon");

            const blade = await weapon(actor, "blade", "Longsword");
            await placeInHotlist(actor, 3, blade);
            let readiness = attackReadiness(actor, sword);
            assert.isTrue(readiness.ready);
            assert.equal(readiness.swap?.index, 3);
            assert.equal(readiness.swap?.item.id, blade.id);

            await assignItemToSlot(actor, { slotType: "gear", slotKey: "offHand" }, blade);
            readiness = attackReadiness(actor, sword);
            assert.isTrue(readiness.ready, "Off Hand counts");
            assert.isNull(readiness.swap);
            assert.equal(readiness.weapon?.id, blade.id);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the Attack! choices are only the Attacks the crawler can make", async function () {
          const actor = await createTestCharacter("choices");
          try {
            const sword = await attack(actor, "Longsword");
            const axe = await attack(actor, "Axe");
            const fists = await attack(actor, "Pugilism", { isHandToHand: true });
            await placeInHotlist(actor, 0, await weapon(actor, "hatchet", "Axe"));
            const offered = attackChoices(actor);
            assert.sameMembers(
              offered.map((c) => c.skill.id),
              [axe.id, fists.id],
            );
            assert.notInclude(
              offered.map((c) => c.skill.id),
              sword.id,
              "no Longsword to hand",
            );
            assert.exists(
              offered.find((c) => c.skill.id === axe.id).swap,
              "the hatchet comes out of the Hotlist",
            );
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("making an Attack", function () {
        useQuenchTimeout(this);

        it("from the Skills tab, an Attack with no weapon warns and opens no dialog", async function () {
          const actor = await createTestCharacter("unarmed");
          const warnings = [];
          const original = ui.notifications.warn;
          ui.notifications.warn = (message, ...rest) => {
            warnings.push(message);
            return original.call(ui.notifications, message, ...rest);
          };
          try {
            const sword = await attack(actor, "Longsword");
            const { result, count } = await postedBy(() => sword.roll());
            assert.isNull(result);
            assert.equal(count, 0, "nothing rolled");
            assert.isFalse(dialogOpen("carl-roll-dialog"), "no Attack dialog");
            assert.isTrue(
              warnings.some((w) => w.includes(sword.name)),
              "a warning names the Skill",
            );
          } finally {
            ui.notifications.warn = original;
            await deleteTestActor(actor);
          }
        });

        it("a homebrew Tail Swipe with Needs no weapon attacks with nothing in hand or Hotlist", async function () {
          const actor = await createTestCharacter("tail swipe");
          try {
            const swipe = await attack(actor, "Tail Swipe", { noWeapon: true });
            assert.deepEqual(attackReadiness(actor, swipe), {
              ready: true,
              weapon: null,
              swap: null,
            });
            assert.include(
              attackChoices(actor).map((c) => c.skill.id),
              swipe.id,
              "offered by Attack!",
            );
            await withDialog(
              () => CarlDice.rollAttack(actor, swipe),
              (d) => {
                assert.exists(d.element, "the Attack dialog opens");
                pressDialog(d, "cancel");
              },
              "carl-roll-dialog",
            );
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Hotlist weapon is swapped into the Main Hand as part of the Attack; what was there takes its slot", async function () {
          const actor = await createTestCharacter("swap in");
          try {
            const sword = await attack(actor, "Longsword", { isHandToHand: false });
            const blade = await weapon(actor, "blade", "Longsword");
            const torch = await createTestItem(actor, "item", "torch");
            await assignItemToSlot(actor, { slotType: "gear", slotKey: "mainHand" }, torch);
            await placeInHotlist(actor, 2, blade);
            const { result, count } = await postedBy(() =>
              CarlDice.rollAttack(actor, sword, { skipDialog: true }),
            );
            assert.exists(result, "the Attack was made");
            assert.isAtLeast(count, 1);
            assert.equal(actor.system.gearSlots.mainHand, blade.id, "the blade is in hand");
            assert.equal(actor.system.hotlist[2], torch.id, "the torch took its slot");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the dialog says the weapon will be swapped in; cancelling leaves everything where it was", async function () {
          const actor = await createTestCharacter("swap cancel");
          try {
            const sword = await attack(actor, "Longsword");
            const blade = await weapon(actor, "blade", "Longsword");
            await placeInHotlist(actor, 0, blade);
            const result = await withDialog(
              () => CarlDice.rollAttack(actor, sword),
              (dialog) => {
                const note = dialog.element.querySelector(".carl-dialog-weapon-note");
                assert.exists(note);
                assert.include(note.textContent, blade.name);
                pressDialog(dialog, "cancel");
              },
              "carl-roll-dialog",
            );
            assert.isNull(result);
            assert.equal(actor.system.gearSlots.mainHand, "", "nothing swapped");
            assert.equal(actor.system.hotlist[0], blade.id);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a box ticked in the dialog still applies after the Hotlist swap", async function () {
          const actor = await createTestCharacter("swap ticks");
          const made = [];
          const hook = Hooks.on("createChatMessage", (message) => made.push(message));
          try {
            const sword = await attack(actor, "Longsword", {
              changes: [
                {
                  targetType: "skillRank",
                  target: "Longsword",
                  mode: "add",
                  value: "3",
                  conditions: [{ id: "flank", label: "Flanking" }],
                },
              ],
            });
            const changeId = sword.system.changes[0].id;
            const blade = await weapon(actor, "blade", "Longsword");
            await placeInHotlist(actor, 0, blade);
            await withDialog(
              () => CarlDice.rollAttack(actor, sword),
              (dialog) => {
                const box = dialog.element.querySelector(
                  `input[name="conditions.${changeId}.flank"]`,
                );
                assert.exists(box, "the Flanking box is offered");
                box.checked = true;
                pressDialog(dialog, "roll");
              },
              "carl-roll-dialog",
            );
            await settle(150);
            assert.equal(actor.system.gearSlots.mainHand, blade.id, "swapped in");
            const card = made.find((m) => m.flags?.["carl-rpg"]?.aiReroll?.kind === "attack");
            assert.exists(card, "the Attack card");
            assert.include(
              card.flags["carl-rpg"].aiReroll.checked,
              changeId,
              "the ticked box applied",
            );
          } finally {
            Hooks.off("createChatMessage", hook);
            for (const message of made) await message.delete().catch(() => null);
            await deleteTestActor(actor);
          }
        });

        it("Attack!: radios, highest Rank picked first; pick another, its Damage Effects appear, then the Attack is made with it", async function () {
          const actor = await createTestCharacter("attack button");
          try {
            // Wrasslin' ties Pugilism's Rank: the tie goes alphabetically.
            const grapple = await attack(actor, "Wrasslin'", { isHandToHand: true, rank: 4 });
            const fists = await attack(actor, "Pugilism", { isHandToHand: true, rank: 4 });
            const sword = await attack(actor, "Longsword");
            await attack(actor, "Axe"); // no axe: not offered
            const blade = await weapon(actor, "blade", "Longsword");
            await placeInHotlist(actor, 0, blade);
            const strike = await createTestItem(actor, "damageEffect", "big swing", {
              system: { rank: 1, parentSkills: [sword.name] },
            });

            const { result, count } = await postedBy(async () => {
              const pending = CarlDice.chooseAttack(actor);
              const dialog = await openDialog("carl-roll-dialog");
              const radios = [...dialog.element.querySelectorAll("input[data-carl-attack-skill]")];
              assert.deepEqual(
                radios.map((r) => r.value),
                [fists.id, grapple.id, sword.id],
                "highest Rank first, a tie alphabetical",
              );
              assert.isTrue(radios[0].checked, "and picked from the start");
              assert.isFalse(
                dialog.element.querySelector('button[data-action="roll"]').disabled,
                "ready to roll",
              );
              assert.exists(
                dialog.element.querySelector('select[name="advantage"]'),
                "its options already show",
              );

              const swordRadio = radios.find((r) => r.value === sword.id);
              swordRadio.checked = true;
              swordRadio.dispatchEvent(new Event("change", { bubbles: true }));
              await waitFor(
                () =>
                  dialog.element.querySelector(
                    `input[name="damageEffectId"][value="${strike.id}"]`,
                  ),
                { message: "the Longsword's Damage Effect never appeared" },
              );
              assert.exists(
                dialog.element.querySelector(".carl-dialog-weapon-note"),
                "it says the blade is swapped in",
              );
              const picker = dialog.element.querySelector(".carl-dialog-attack-skill");
              assert.equal(
                picker.querySelector(":scope > label").textContent.trim(),
                game.i18n.localize("CARLRPG.Weapon.AttackSkill"),
              );
              assert.isTrue(
                picker.nextElementSibling?.classList.contains("carl-dialog-damage-effect"),
                "the Damage Effects come right under the Skill",
              );
              assert.isFalse(dialog.element.querySelector('button[data-action="roll"]').disabled);
              pressDialog(dialog, "roll");
              return pending;
            });
            assert.exists(result);
            assert.isAtLeast(count, 1);
            assert.equal(actor.system.gearSlots.mainHand, blade.id, "swapped in for the Attack");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Attack! with nothing usable warns and opens no dialog", async function () {
          const actor = await createTestCharacter("no attacks");
          try {
            await attack(actor, "Longsword");
            assert.isNull(await CarlDice.chooseAttack(actor));
            assert.isFalse(dialogOpen("carl-roll-dialog"));
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: weapons and the Attack! button" },
  );
}
