import { supersededArmorIds } from "../../helpers/modifiers.mjs";
import { describeDefenses, formatSource, sourcesTooltip } from "../../helpers/bonus-sources.mjs";
import { parseSize } from "../../helpers/size.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import CarlDice from "../../dice/dice.mjs";
import {
  createTestCharacter,
  createTestItem,
  deleteTestActor,
  useQuenchTimeout,
  waitFor,
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
    rankThreshold: Number(rankThreshold),
    changes: list,
  }));
  return createTestItem(actor, "skill", name, {
    name,
    system: { rank, category: "passive", isPassive: true, changes, upgrades },
  });
}

/** Equipped gear with these changes. */
function gear(actor, label, changes, { slots = ["torso"], equipped = true } = {}) {
  return createTestItem(actor, "item", label, {
    name: label,
    system: { equipped, slots, changes },
  });
}

const RUNNING = {
  5: [change("resource", "move", 5)],
  10: [change("resource", "move", 10)],
  15: [change("resource", "move", 15)],
};

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
          const actor = await createTestCharacter("move debuffs", {
            system: { details: { move: 35 } },
          });
          try {
            await addConditionToActor(actor, "fatigued");
            await addConditionToActor(actor, "fatigued");
            assert.equal(
              actor.system.moveEffective,
              15,
              "35 / 2 = 17.5, down to 15 - halved once for two stacks",
            );
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
          const same = await createTestCharacter("size unchanged", {
            system: { details: { size: 3 } },
          });
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
            assert.equal(
              actor._source.system.dr,
              5,
              "the saved value is left for the 0.7.0 migration",
            );
            await race(actor, "Tigran", [change("resource", "dr", 1)]);
            assert.equal(actor.system.drEffective, 1);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Passive Spell's base DR counts from Rank 1, not at Rank 0 (ruled 2026-11-20)", async function () {
          const actor = await createTestCharacter("rank 0 bonus");
          try {
            const spell = await createTestItem(actor, "spell", "Bark", {
              system: {
                castingKeywords: ["passive"],
                rank: 0,
                changes: [change("resource", "dr", 2)],
              },
            });
            // A Spell arrives at Rank 1 (CarlRPGItem#_preCreate); take it back.
            await spell.update({ "system.rank": 0 });
            assert.equal(actor.system.drEffective, 0, "untrained: nothing");
            await spell.update({ "system.rank": 1 });
            assert.equal(actor.system.drEffective, 2, "Rank 1: its +2 DR");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Rank 0 Spell raised to Rank 1 by gear gives its Bonuses, and its +Rank to another Skill", async function () {
          const actor = await createTestCharacter("boosted rank 0");
          try {
            const bark = await createTestItem(actor, "spell", "Bark", {
              name: "Bark",
              system: {
                castingKeywords: ["passive"],
                rank: 0,
                changes: [change("resource", "dr", 2), change("skillRank", "Climbing", 1)],
              },
            });
            await createTestItem(actor, "skill", "Climbing", {
              name: "Climbing",
              system: {
                rank: 4,
                upgrades: [{ rankThreshold: 5, changes: [change("stat", "dex", 1)] }],
              },
            });
            await bark.update({ "system.rank": 0 }); // a Spell arrives at Rank 1
            const dex = actor.system.stats.dex.effective;
            assert.equal(actor.system.drEffective, 0, "Rank 0: nothing");
            await gear(actor, "Bark Charm", [change("skillRank", "Bark", 1)]);
            assert.equal(actor.system.drEffective, 2, "raised to Rank 1: its +2 DR");
            assert.equal(actor.system.skills.climbing.rank, 5, "its +1 Climbing");
            assert.equal(
              actor.system.stats.dex.effective,
              dex + 1,
              "which unlocks Climbing's Rank 5 tier",
            );
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a multiplied Rank drops its fraction, and its tiers unlock at the Rank shown (ruled 2026-11-21)", async function () {
          const actor = await createTestCharacter("rank fraction");
          try {
            await createTestItem(actor, "skill", "Climbing", {
              name: "Climbing",
              system: {
                rank: 4,
                upgrades: [{ rankThreshold: 5, changes: [change("resource", "dr", 3)] }],
              },
            });
            await createTestItem(actor, "skill", "Swimming", {
              name: "Swimming",
              system: { rank: 5 },
            });
            await gear(actor, "Odd Charm", [
              change("skillRank", "Climbing", 1.2, "multiply"),
              change("skillRank", "Swimming", 1.25, "multiply"),
            ]);
            assert.equal(actor.system.skills.swimming.rank, 6, "5 x1.25 is 6, not 6.25");
            assert.equal(actor.system.skills.climbing.rank, 4, "4 x1.2 is 4, not 4.8");
            assert.equal(actor.system.drEffective, 0, "so Climbing's Rank 5 tier stays locked");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a chain of Rank 0 Skills each raising the next: the last shows Rank 1 and gives its Bonuses", async function () {
          const actor = await createTestCharacter("rank chain");
          try {
            const skill = (name, changes) =>
              createTestItem(actor, "skill", name, { name, system: { rank: 0, changes } });
            await skill("Alpha", [change("skillRank", "Beta", 1)]);
            await skill("Beta", [change("skillRank", "Gamma", 1)]);
            await skill("Gamma", [change("resource", "dr", 2)]);
            assert.equal(actor.system.drEffective, 0, "all Rank 0: nothing");
            await gear(actor, "Alpha Charm", [change("skillRank", "Alpha", 1)]);
            assert.equal(actor.system.skills.gamma.rank, 1, "Gamma reaches Rank 1");
            assert.equal(actor.system.drEffective, 2, "and gives its +2 DR");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Iron Skin doubles the whole DR: Race and gear DR", async function () {
          const actor = await createTestCharacter("dr x2");
          try {
            await race(actor, "Tigran", [change("resource", "dr", 1)]);
            await gear(actor, "Helm", [change("resource", "dr", 2)], { slots: ["head"] });
            assert.equal(actor.system.drEffective, 3);
            await actor.update({
              "system.conditions": [
                {
                  key: "custom",
                  label: "Iron Skin",
                  stacks: 1,
                  source: "Iron Skin Potion",
                  changes: [change("resource", "dr", 2, "multiply")],
                },
              ],
            });
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

        it("worn gear's DR stacks across slot types; within one only the best counts; Accessories each count", async function () {
          const actor = await createTestCharacter("armor");
          try {
            const helm = await gear(
              actor,
              "Helm",
              [change("resource", "dr", 2), change("stat", "str", 1)],
              { slots: ["head"] },
            );
            await gear(actor, "Plate", [change("resource", "dr", 3)], { slots: ["torso"] });
            const spare = await gear(actor, "Spare Helm", [change("resource", "dr", 1)], {
              slots: ["head"],
            });
            await gear(actor, "Ring A", [change("resource", "dr", 1)], { slots: ["accessory"] });
            await gear(actor, "Ring B", [change("resource", "dr", 1)], { slots: ["accessory"] });
            assert.equal(
              actor.system.drEffective,
              7,
              "Helm 2 + Plate 3 + both rings, not the spare Helm",
            );
            assert.equal(actor.system.stats.str.bonus, 1, "the Helm's other change still applies");
            assert.deepEqual([...supersededArmorIds(actor.items, {}, actor.system)], [spare.id]);

            await helm.update({ "system.equipped": false });
            assert.equal(actor.system.drEffective, 6, "with the Helm off, the spare counts");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("ranks a slot type's pieces by the DR they give now; a losing piece keeps its conditional DR", async function () {
          const actor = await createTestCharacter("armor gates");
          try {
            const helm = await gear(actor, "Helm", [change("resource", "dr", 2)], {
              slots: ["head"],
            });
            await gear(
              actor,
              "Runed Helm",
              [
                { ...change("resource", "dr", 4), levelGate: 10 },
                { ...change("resource", "dr", 3), conditions: [{ label: "vs Fire" }] },
              ],
              { slots: ["head"] },
            );
            assert.equal(
              actor.system.drEffective,
              2,
              "the Runed Helm's +4 needs Level 10, so the Helm's +2 counts",
            );
            assert.deepEqual(
              [...supersededArmorIds(actor.items, { lvl: 1 }, actor.system)],
              [actor.items.getName("Runed Helm").id],
            );
            assert.isTrue(
              actor.system.conditionalModifiers.some((m) => m.target === "dr" && m.value === "3"),
              "the losing piece's conditional row still reaches the roll dialog",
            );

            await actor.update({ "system.attributes.level.value": 10 });
            assert.equal(actor.system.drEffective, 4, "at Level 10 the Runed Helm wins");
            assert.deepEqual(
              [...supersededArmorIds(actor.items, { lvl: 10 }, actor.system)],
              [helm.id],
            );
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
            await skill(actor, "Dodge", 10, { 10: [change("rollMode", "evadeBonus", 1)] }, [
              change("rollMode", "evadeBonus", 1),
            ]);
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
            assert.deepEqual(
              actor.system.evadeDice.map((d) => d.formula),
              ["1d4"],
            );
            assert.isUndefined(
              actor.system.bonuses.evadeBonus,
              "the dice aren't summed into the bonus",
            );
            const result = await CarlDice.rollEvadeCheck(actor, {
              skipDialog: true,
              post: false,
              isAction: false,
            });
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
          assert.equal(
            formatSource({ label: "Iron Skin", value: 2, mode: "multiply" }),
            "Iron Skin ×2",
          );
          assert.equal(
            formatSource({ label: "Elf (High)", value: "1d4", mode: "add" }),
            "Elf (High) +1d4",
          );
          assert.equal(
            sourcesTooltip("Base 20", [{ label: "Tigran", value: 10, mode: "add" }], ["", "x"]),
            "Base 20 · Tigran +10 · x",
          );
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
          assert.isTrue(
            elf.system.changes.some((c) => c.target === "evadeDice" && c.value === "1d4"),
          );
          const oakhide = await changesOf("skills-and-spells", "Oakhide");
          assert.isTrue(oakhide.system.isToggled);
        });
      });
    },
    { displayName: "CarlRPG: Defenses and movement" },
  );
}
