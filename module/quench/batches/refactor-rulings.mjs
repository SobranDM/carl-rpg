import CarlDice from "../../dice/dice.mjs";
import {
  addConditionToActor, changeConditions, conditionOps, opsAllowed,
} from "../../helpers/conditions.mjs";
import { isUntrained } from "../../helpers/rules.mjs";
import { bareSkillLikeData, cleanSkillLikeCopy, findSkillLikeItem } from "../../helpers/race-class-grants.mjs";
import { copyData, PACKS } from "../../helpers/packs.mjs";
import { fightOf } from "../../helpers/fights.mjs";
import { resolveCombatantFor } from "../../helpers/token-resolution.mjs";
import { itemTooltips, namedItemTooltips } from "../../helpers/rich-text.mjs";
import { useConsumable } from "../../helpers/consumables.mjs";
import {
  createTestCharacter, createTestCombat, createTestMob, createTestItem, deleteTestActor, deleteTestCombat, useQuenchTimeout, waitFor, withFakeTargets,
} from "../helpers.mjs";
import { REFRESHED_ITEMS } from "../../helpers/migration.mjs";

/**
 * The rulings of the 0.7.1 consolidation (docs/refactor-0.7.1.md, ruled
 * 2026-11-19): one writer of system.conditions, a negative Rank, Opposed
 * Checks that aren't Actions, Chargen's bare Spell, Mend under The Taint.
 *
 * Quench runs on the GM's client, so a player's ops reaching the GM
 * (askGM), and the no-GM path, are two-client checks (see the doc).
 */

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

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.refactor-rulings",
    (context) => {
      const { describe, it, assert } = context;

      describe("One writer for system.conditions", function () {
        useQuenchTimeout(this);

        it("conditionOps: removals, changed fields and new entries, by id", function () {
          const before = [{ id: "a", key: "blinded", stacks: 1 }, { id: "b", key: "queasy", stacks: 1 }];
          const after = [{ id: "a", key: "blinded", stacks: 3 }, { id: "c", key: "stunned", stacks: 1 }];
          const ops = conditionOps(before, after);
          assert.deepEqual(ops.find((o) => o.op === "remove")?.ids, ["b"]);
          assert.deepEqual(ops.find((o) => o.op === "patch"), { op: "patch", id: "a", fields: { stacks: 3 } });
          assert.equal(ops.find((o) => o.op === "push")?.entry.id, "c");
          assert.deepEqual(conditionOps(before, before), [], "no change, no ops");
        });

        it("a list worked out from an earlier read keeps what changed meanwhile", async function () {
          const actor = await createTestCharacter("one writer");
          try {
            await addConditionToActor(actor, "blinded");
            await addConditionToActor(actor, "fatigued");
            const before = actor.system.toObject().conditions;
            const blinded = before.find((c) => c.key === "blinded");
            const fatigued = before.find((c) => c.key === "fatigued");
            // Worked out now: Blinded at 3 stacks, a label on Fatigued...
            const after = before.map((c) => (c.id === blinded.id ? { ...c, stacks: 3 } : { ...c, label: "Tired" }));
            // ...while, meanwhile, Fatigued is removed and Woozy added.
            await changeConditions(actor, [{ op: "remove", ids: [fatigued.id] }]);
            await addConditionToActor(actor, "woozy");
            await changeConditions(actor, conditionOps(before, after));
            assert.sameMembers(keys(actor), ["blinded", "woozy"], "the removal and the addition both stand");
            assert.equal(actor.system.conditions.find((c) => c.key === "blinded").stacks, 3, "its own change made");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("restore gives back only what's missing; patch changes only its fields", async function () {
          const actor = await createTestCharacter("restore");
          try {
            await addConditionToActor(actor, "stunned");
            const [stunned] = actor.system.toObject().conditions;
            await changeConditions(actor, [{ op: "restore", entries: [stunned] }]);
            assert.lengthOf(actor.system.conditions, 1, "not duplicated");
            await changeConditions(actor, [{ op: "patch", id: stunned.id, fields: { source: "Test" } }]);
            const entry = actor.system.conditions[0];
            assert.equal(entry.source, "Test");
            assert.equal(entry.key, "stunned", "the rest of it kept");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a 2nd Minor Injury still becomes Long-Term, and Sepsis still adds Staggered", async function () {
          const actor = await createTestCharacter("add rules");
          try {
            await addConditionToActor(actor, "minorInjury");
            await addConditionToActor(actor, "minorInjury");
            assert.include(keys(actor), "longTermMinorInjury");
            assert.notInclude(keys(actor), "minorInjury");
            const sepsis = Object.entries(CONFIG.CARLRPG.debuffs).find(([, d]) => d.mechanics?.alsoApplies?.length);
            if (sepsis) {
              await addConditionToActor(actor, sepsis[0]);
              for (const extra of sepsis[1].mechanics.alsoApplies) assert.include(keys(actor), extra);
            }
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a player who doesn't own a Mob may only remove its one-shot Debuffs, and only in a fight or targeted", async function () {
          const player = game.users.find((u) => !u.isGM);
          if (!player) this.skip();
          const mob = await createTestMob("not theirs");
          try {
            await addConditionToActor(mob, "stunned");
            await addConditionToActor(mob, "blinded");
            const list = mob.system.toObject().conditions;
            const ids = list.map((c) => c.id);
            assert.deepEqual(opsAllowed([{ op: "remove", ids }], list, mob, player), [],
              "not targeted, not in a fight: nothing");
            assert.deepEqual(opsAllowed([{ op: "add", key: "woozy" }], list, mob, player), []);
          } finally {
            await deleteTestActor(mob);
          }
        });
      });

      describe("A negative Rank is untrained (ruled 2026-11-19)", function () {
        it("isUntrained: 0 and below", function () {
          assert.isTrue(isUntrained(0));
          assert.isTrue(isUntrained(-2));
          assert.isTrue(isUntrained(undefined));
          assert.isFalse(isUntrained(1));
        });
      });

      describe("An Opposed Check that isn't an Action (ruled 2026-11-19)", function () {
        useQuenchTimeout(this);

        it("neither applies nor ends Queasy; one that is does both", async function () {
          const actor = await createTestCharacter("queasy opposed");
          try {
            const skill = await createTestItem(actor, "skill", "Driving", { system: { rank: 5 } });
            await addConditionToActor(actor, "queasy");
            const free = await CarlDice.rollOpposedSkillCheck(actor, skill, {
              difficulty: 10, skipDialog: true, post: false, isAction: false,
            });
            assert.isFalse((free.applied ?? []).some((row) => row.key === "queasy"), "no Disadvantage from it");
            assert.include(keys(actor), "queasy", "not ended");
            await CarlDice.rollOpposedSkillCheck(actor, skill, { difficulty: 10, skipDialog: true, post: false });
            assert.notInclude(keys(actor), "queasy", "an Action ends it");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Chargen's missing Spell (ruled 2026-11-19)", function () {
        it("a bare Spell is a Spell, a bare Skill a Utility Skill", function () {
          const spell = bareSkillLikeData("Heal", 1, { type: "spell" });
          assert.equal(spell.type, "spell");
          assert.notProperty(spell.system, "category");
          const skill = bareSkillLikeData("Streetwise", 1);
          assert.equal(skill.type, "skill");
          assert.equal(skill.system.category, "utility");
        });
      });

      describe("Mending under The Taint (ruled 2026-11-19)", function () {
        useQuenchTimeout(this);

        it("a potion that mends is used: the Injury is mended, the healing blocked", async function () {
          const actor = await createTestCharacter("tainted mend", { system: { hb: { value: 2 } } });
          try {
            const taintKey = Object.entries(CONFIG.CARLRPG.debuffs).find(([, d]) => d.mechanics?.noHealing)?.[0];
            await addConditionToActor(actor, taintKey);
            await addConditionToActor(actor, "minorInjury");
            const potion = await createTestItem(actor, "item", "mend", {
              system: { quantity: 1, consumable: { kind: "potion", heal: { slots: 3, mend: "minor" } } },
            });
            assert.isNotNull(await quietly(() => useConsumable(actor, potion, { skipDialog: true })));
            assert.notInclude(keys(actor), "minorInjury", "mended");
            assert.equal(actor.system.hb.value, 2, "not healed");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Finding by name, in the importer's priority (#5)", function () {
        useQuenchTimeout(this);

        it("the system's copy wins over a same-named world Item; a Spell lookup skips a same-named Skill", async function () {
          const pack = game.packs.get(PACKS.skillsAndSpells);
          const index = await pack?.getIndex({ fields: ["type"] });
          const spell = index?.find((e) => e.type === "spell");
          if (!spell) this.skip();
          const [worldSkill] = await Item.createDocuments([{ name: spell.name, type: "skill" }]);
          try {
            const found = await findSkillLikeItem(spell.name);
            assert.equal(found?.pack, pack.collection, "the system compendium's, not the world's");
            const asSpell = await findSkillLikeItem(spell.name, ["spell"]);
            assert.equal(asSpell?.type, "spell");
          } finally {
            await worldSkill.delete();
          }
        });
      });

      describe("Which fight a creature is in (#9)", function () {
        useQuenchTimeout(this);

        it("only a started fight counts, and the Combatant is the actor's own", async function () {
          const actor = await createTestCharacter("fighter");
          const other = await createTestCharacter("bystander");
          let combat;
          try {
            ({ combat } = await createTestCombat(actor));
            assert.isNull(fightOf(actor), "not started");
            await combat.startCombat();
            assert.equal(fightOf(actor), combat);
            assert.isNull(fightOf(other));
            assert.equal(resolveCombatantFor({ actor, token: null })?.actor, actor);
            assert.isNull(resolveCombatantFor({ actor: other, token: null }));
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
            await deleteTestActor(other);
          }
        });
      });

      describe("Copies keep their compendium source (#12)", function () {
        it("copyData and cleanSkillLikeCopy", async function () {
          const pack = game.packs.get(PACKS.skillsAndSpells);
          const entry = (await pack?.getIndex())?.contents?.[0] ?? [...((await pack?.getIndex()) ?? [])][0];
          if (!entry) this.skip();
          const doc = await pack.getDocument(entry._id);
          const data = copyData(doc);
          assert.equal(data._stats.compendiumSource, doc.uuid);
          for (const key of ["_id", "folder", "sort", "ownership"]) assert.notProperty(data, key);
          assert.equal(cleanSkillLikeCopy(doc, 3)._stats.compendiumSource, doc.uuid);
          assert.notProperty(cleanSkillLikeCopy({ name: "X", type: "skill", system: {} }, 1), "_stats", "plain data names none");
        });
      });

      describe("Item descriptions as tooltips (#11)", function () {
        useQuenchTimeout(this);

        it("an item's description, and nothing for one without", async function () {
          const actor = await createTestCharacter("tooltips");
          try {
            const described = await createTestItem(actor, "item", "described", { system: { description: "<p>A sturdy rope.</p>" } });
            const plain = await createTestItem(actor, "item", "plain");
            const tips = await itemTooltips(actor.items);
            assert.include(tips[described.id], "A sturdy rope.");
            assert.notProperty(tips, plain.id);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the Inventory row's whole name cell (icon and name) carries it, as a Foundry tooltip", async function () {
          const actor = await createTestCharacter("tooltip row");
          const sheet = actor.sheet;
          try {
            const quoted = '<p class="x">A "sturdy" rope.</p>';
            const described = await createTestItem(actor, "item", "described", { system: { description: quoted } });
            const plain = await createTestItem(actor, "item", "plain");
            const skill = await createTestItem(actor, "skill", "Tooltip Skill", {
              system: { description: `<p>See @UUID[${actor.uuid}]{its owner}.</p>` },
            });
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered && sheet.element.querySelector(`li[data-item-id="${described.id}"]`));
            const cell = (item) => sheet.element.querySelector(`li[data-item-id="${item.id}"] .item-name`);
            assert.equal(cell(described).dataset.tooltipHtml, quoted, "the description, quotes and all");
            assert.equal(cell(described).dataset.tooltipClass, "carl-item-tooltip");
            assert.isUndefined(cell(plain).dataset.tooltipHtml, "no description, no tooltip");
            const skillName = sheet.element.querySelector(`li[data-item-id="${skill.id}"] h4`);
            assert.include(skillName?.dataset.tooltipHtml ?? "", "content-link", "a Skill's name shows its enriched description");
            assert.isNull(sheet.element.querySelector("li[data-item-id] [title], li[data-item-id][title]"), "no browser title= tooltips on rows");
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });

        it("hovering an Inventory row's name shows Foundry's tooltip with the description; a bare item shows none", async function () {
          const actor = await createTestCharacter("tooltip hover");
          const sheet = actor.sheet;
          const hover = async (element) => {
            game.tooltip.deactivate();
            element.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
            // TooltipManager waits TOOLTIP_ACTIVATION_MS (500) for intent.
            await new Promise((resolve) => setTimeout(resolve, (game.tooltip.constructor.TOOLTIP_ACTIVATION_MS ?? 500) + 200));
          };
          try {
            const described = await createTestItem(actor, "item", "rope", { system: { description: "<p>A sturdy rope.</p>" } });
            const bare = await createTestItem(actor, "item", "lighter");
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered && sheet.element.querySelector(`li[data-item-id="${described.id}"]`));
            const name = (item) => sheet.element.querySelector(`li[data-item-id="${item.id}"] .item-name h4`);
            await hover(name(described).closest(".item-name"));
            assert.equal(game.tooltip.element, name(described).closest(".item-name"), "the name cell's tooltip is up");
            assert.include(game.tooltip.tooltip.innerHTML, "A sturdy rope.");
            await hover(name(bare).closest(".item-name"));
            assert.notEqual(game.tooltip.element, name(bare).closest(".item-name"), "an item with no description has none");
          } finally {
            game.tooltip.deactivate();
            await sheet.close();
            await deleteTestActor(actor);
          }
        });

        it("the Equipment Doll and Hotlist name the item above its description", async function () {
          const items = [{ id: "a", name: "Rope & Hook" }, { id: "b", name: "Lighter" }];
          const named = namedItemTooltips(items, { a: "<p>Sturdy.</p>" });
          assert.equal(named.a, '<strong class="carl-tooltip-name">Rope &amp; Hook</strong><p>Sturdy.</p>');
          assert.equal(named.b, '<strong class="carl-tooltip-name">Lighter</strong>', "the name alone without a description");
        });
      });

      describe("The 0.7.0 refresh migration's items (known-gaps §10)", function () {
        it("every name it refreshes is in its system compendium", async function () {
          for (const [packName, names] of Object.entries(REFRESHED_ITEMS)) {
            const index = await game.packs.get(`carl-rpg.${packName}`)?.getIndex();
            assert.exists(index, `carl-rpg.${packName}`);
            const have = new Set(index.map((e) => e.name));
            for (const name of names) assert.isTrue(have.has(name), `${name} in ${packName}`);
          }
        });
      });
    },
    { displayName: "CarlRPG: 0.7.1 rulings (conditions writer, Ranks, Opposed, Mend, lookups, fights, copies, tooltips)" },
  );
}
