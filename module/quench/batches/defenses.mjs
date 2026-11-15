import { supersededArmorIds } from "../../helpers/modifiers.mjs";
import { describeDefenses, formatSource, sourcesTooltip } from "../../helpers/bonus-sources.mjs";
import { parseSize } from "../../helpers/size.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import CarlDice from "../../dice/dice.mjs";
import {
  createTestCharacter, createTestItem, deleteTestActor, useQuenchTimeout, waitFor,
} from "../helpers.mjs";

/** A change entry, as content authors it. */
function change(targetType, target, value, mode = "add") {
  return { targetType, target, mode, value: String(value) };
}

/** A Race carrying these changes (and a Size). */
function race(actor, label, changes, size = "Medium (4)") {
  return createTestItem(actor, "race", label, { name: label, system: { size, changes } });
}

/** A Skill at this Rank with these per-tier changes ({5: [...], 10: [...]}). */
function skill(actor, name, rank, tiers = {}, changes = []) {
  const upgrades = Object.entries(tiers).map(([rankThreshold, list]) => ({
    rankThreshold: Number(rankThreshold), changes: list,
  }));
  return createTestItem(actor, "skill", name, {
    name, system: { rank, category: "passive", isPassive: true, changes, upgrades },
  });
}

/** Equipped gear with these changes. */
function gear(actor, label, changes, { isArmor = false, equipped = true } = {}) {
  return createTestItem(actor, "item", label, { name: label, system: { equipped, isArmor, changes } });
}

const RUNNING = { 5: [change("resource", "move", 5)], 10: [change("resource", "move", 10)], 15: [change("resource", "move", 15)] };

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.defenses",
    (context) => {
      const { describe, it, assert } = context;

      describe("Move and Step", function () {
        useQuenchTimeout(this);

        it("add their bonuses: Tigran's +10ft, and Running's tiers add up", async function () {
          const actor = await createTestCharacter("move");
          try {
            assert.equal(actor.system.moveEffective, 20, "the base alone");
            assert.equal(actor.system.stepEffective, 10);
            await race(actor, "Tigran", [change("resource", "move", 10)]);
            assert.equal(actor.system.moveEffective, 30, "Tigran Move 30");
            const running = await skill(actor, "Running", 10, RUNNING);
            assert.equal(actor.system.moveEffective, 45, "Running Rank 10: +5 +10");
            await running.update({ "system.rank": 15 });
            assert.equal(actor.system.moveEffective, 60, "Rank 15: +30 in all");
            assert.equal(actor.system.details.move, 20, "the base is never written");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Fatigued halves Move (down to 5ft, once); Held blocks Move and Step; Stiff Legs only the Step", async function () {
          const actor = await createTestCharacter("move debuffs", { system: { details: { move: 35 } } });
          try {
            await addConditionToActor(actor, "fatigued");
            await addConditionToActor(actor, "fatigued");
            assert.equal(actor.system.moveEffective, 15, "35 / 2 = 17.5, down to 15 - halved once for two stacks");
            assert.isNotEmpty(actor.system.moveHalvedBy);
            assert.equal(actor.system.moveBlockedBy, "");

            await actor.update({ "system.conditions": [] });
            await addConditionToActor(actor, "stiffLegs");
            assert.equal(actor.system.moveBlockedBy, "");
            assert.isNotEmpty(actor.system.stepBlockedBy);

            await actor.update({ "system.conditions": [] });
            await addConditionToActor(actor, "held");
            const held = game.i18n.localize(CONFIG.CARLRPG.debuffs.held.label);
            assert.equal(actor.system.moveBlockedBy, held);
            assert.equal(actor.system.stepBlockedBy, held);
            assert.equal(actor.system.moveEffective, 35, "the value is kept for when it ends");
            const { move, step } = describeDefenses(actor.system);
            assert.include(move.blocked, held);
            assert.include(step.tooltip, held);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Size from the Race", function () {
        useQuenchTimeout(this);

        it("reads a Size from text", function () {
          assert.equal(parseSize("Medium (4)"), 4);
          assert.equal(parseSize("Medium (4), mostly due to wings"), 4);
          assert.equal(parseSize("Large"), 5);
          assert.isNull(parseSize("Unchanged, but size changes when shifting"));
          assert.isNull(parseSize(""));
        });

        it("adding a Race sets the Character's Size; an 'Unchanged' Race leaves it", async function () {
          const big = await createTestCharacter("size large");
          const same = await createTestCharacter("size unchanged", { system: { details: { size: 3 } } });
          try {
            await race(big, "Ogreish", [], "Large (5)");
            await waitFor(() => big.system.details.size === 5, { message: "Size never became 5" });
            await race(same, "Shifter", [], "Unchanged, but size changes when shifting");
            await new Promise((r) => setTimeout(r, 100));
            assert.equal(same.system.details.size, 3);
          } finally {
            await deleteTestActor(big);
            await deleteTestActor(same);
          }
        });
      });

      describe("DR", function () {
        useQuenchTimeout(this);

        it("a crawler's base DR is 0, whatever is saved: its DR is only its bonuses", async function () {
          const actor = await createTestCharacter("dr locked", { system: { dr: 5 } });
          try {
            assert.equal(actor.system.dr, 0);
            assert.equal(actor.system.drEffective, 0);
            assert.equal(actor._source.system.dr, 5, "the saved value is left for the 0.7.0 migration");
            await race(actor, "Tigran", [change("resource", "dr", 1)]);
            assert.equal(actor.system.drEffective, 1);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Iron Skin doubles the whole DR: Race and gear DR", async function () {
          const actor = await createTestCharacter("dr x2");
          try {
            await race(actor, "Tigran", [change("resource", "dr", 1)]);
            await gear(actor, "Helm", [change("resource", "dr", 2)], { isArmor: true });
            assert.equal(actor.system.drEffective, 3);
            await actor.update({ "system.conditions": [{
              key: "custom", label: "Iron Skin", stacks: 1, source: "Iron Skin Potion",
              changes: [change("resource", "dr", 2, "multiply")],
            }] });
            assert.equal(actor.system.drEffective, 6, "(1 + 2) x 2");
            const tip = describeDefenses(actor.system).dr.tooltip;
            assert.include(tip, "Base 0");
            assert.include(tip, "Tigran +1");
            assert.include(tip, "Helm +2");
            assert.include(tip, "Iron Skin ×2");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("only the best piece of worn armor adds its DR; other DR and the armor's other changes still count", async function () {
          const actor = await createTestCharacter("armor");
          try {
            const helm = await gear(actor, "Helm", [change("resource", "dr", 2), change("stat", "str", 1)], { isArmor: true });
            const plate = await gear(actor, "Plate", [change("resource", "dr", 3)], { isArmor: true });
            await gear(actor, "Lucky Charm", [change("resource", "dr", 1)]);
            assert.equal(actor.system.drEffective, 4, "Plate 3 + the charm 1, not the Helm's 2");
            assert.equal(actor.system.stats.str.bonus, 1, "the Helm's other change still applies");
            assert.deepEqual([...supersededArmorIds(actor.items, {})], [helm.id]);

            await plate.update({ "system.equipped": false });
            assert.equal(actor.system.drEffective, 3, "with the Plate off, the Helm counts");
            await plate.update({ "system.equipped": true, "system.isArmor": false });
            assert.equal(actor.system.drEffective, 6, "gear not marked as armor stacks as before");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("ranks armor by the DR it gives now; a losing piece keeps its conditional DR", async function () {
          const actor = await createTestCharacter("armor gates");
          try {
            const helm = await gear(actor, "Helm", [change("resource", "dr", 2)], { isArmor: true });
            await gear(actor, "Runed Plate", [
              { ...change("resource", "dr", 4), levelGate: 10 },
              { ...change("resource", "dr", 3), conditions: [{ label: "vs Fire" }] },
            ], { isArmor: true });
            assert.equal(actor.system.drEffective, 2, "the Plate's +4 needs Level 10, so the Helm's +2 counts");
            assert.deepEqual([...supersededArmorIds(actor.items, { lvl: 1 })], [actor.items.getName("Runed Plate").id]);
            assert.isTrue(actor.system.conditionalModifiers.some((m) => m.target === "dr" && m.value === "3"),
              "the losing Plate's conditional row still reaches the roll dialog");

            await actor.update({ "system.attributes.level.value": 10 });
            assert.equal(actor.system.drEffective, 4, "at Level 10 the Plate wins");
            assert.deepEqual([...supersededArmorIds(actor.items, { lvl: 10 })], [helm.id]);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Evade", function () {
        useQuenchTimeout(this);

        it("a Longsword's Rank 15 +1 adds to Dodge's, which no longer overrides it", async function () {
          const actor = await createTestCharacter("evade");
          try {
            await skill(actor, "Dodge", 10, { 10: [change("rollMode", "evadeBonus", 1)] }, [change("rollMode", "evadeBonus", 1)]);
            assert.equal(actor.system.bonuses.evadeBonus, 2, "Dodge Rank 10: +2");
            await skill(actor, "Longsword", 15, { 15: [change("rollMode", "evadeBonus", 1)] });
            assert.equal(actor.system.bonuses.evadeBonus, 3);
            const tip = describeDefenses(actor.system).evade.tooltip;
            assert.include(tip, "Dodge +1");
            assert.include(tip, "Longsword (Rank 15) +1");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Elf (High)'s 1d4 is in the Evade roll and on the button, not in the static number", async function () {
          const actor = await createTestCharacter("evade dice");
          try {
            await race(actor, "Elf (High)", [change("rollMode", "evadeDice", "1d4")]);
            assert.deepEqual(actor.system.evadeDice.map((d) => d.formula), ["1d4"]);
            assert.isUndefined(actor.system.bonuses.evadeBonus, "the dice aren't summed into the bonus");
            const result = await CarlDice.rollEvadeCheck(actor, { skipDialog: true, post: false, isAction: false });
            assert.include(result.roll.formula, "1d4");
            assert.equal(describeDefenses(actor.system).evade.dice, " +1d4");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Source tooltips", function () {
        it("format each kind of source", function () {
          assert.equal(formatSource({ label: "Tigran", value: 10, mode: "add" }), "Tigran +10");
          assert.equal(formatSource({ label: "Curse", value: 2, mode: "subtract" }), "Curse -2");
          assert.equal(formatSource({ label: "Iron Skin", value: 2, mode: "multiply" }), "Iron Skin ×2");
          assert.equal(formatSource({ label: "Elf (High)", value: "1d4", mode: "add" }), "Elf (High) +1d4");
          assert.equal(sourcesTooltip("Base 20", [{ label: "Tigran", value: 10, mode: "add" }], ["", "x"]), "Base 20 · Tigran +10 · x");
        });

        it("Move lists its base and each source", async function () {
          const actor = await createTestCharacter("move tooltip");
          try {
            await race(actor, "Tigran", [change("resource", "move", 10)]);
            await skill(actor, "Running", 5, RUNNING);
            const { move } = describeDefenses(actor.system);
            assert.isTrue(move.shown);
            assert.equal(move.tooltip, "Base 20 · Tigran +10 · Running (Rank 5) +5");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Compendium content (after npm run build:packs)", function () {
        useQuenchTimeout(this);

        /** Every change an item makes at the given Rank. */
        async function changesOf(packId, name) {
          const pack = game.packs.get(`carl-rpg.${packId}`);
          const entry = pack?.index.find((e) => e.name === name);
          return entry ? pack.getDocument(entry._id) : null;
        }

        it("Tigran, Running, Dodge and Elf (High) carry their Move, Evade and dice", async function () {
          const tigran = await changesOf("classes-and-races", "Tigran");
          if (!tigran?.system.changes.some((c) => c.target === "move")) this.skip();
          assert.isTrue(tigran.system.changes.some((c) => c.target === "move" && c.value === "10"));
          const dodge = await changesOf("skills-and-spells", "Dodge");
          const modes = dodge.system.upgrades.flatMap((u) => u.changes.map((c) => c.mode));
          assert.notInclude(modes, "override", "Dodge adds, never overrides");
          const elf = await changesOf("classes-and-races", "Elf (High)");
          assert.isTrue(elf.system.changes.some((c) => c.target === "evadeDice" && c.value === "1d4"));
          const oakhide = await changesOf("skills-and-spells", "Oakhide");
          assert.isTrue(oakhide.system.isToggled);
        });
      });
    },
    { displayName: "CarlRPG: Defenses and movement" },
  );
}
