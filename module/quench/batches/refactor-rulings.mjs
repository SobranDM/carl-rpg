import CarlDice from "../../dice/dice.mjs";
import {
  addConditionToActor, changeConditions, conditionOps, opsAllowed,
} from "../../helpers/conditions.mjs";
import { isUntrained } from "../../helpers/rules.mjs";
import { bareSkillLikeData } from "../../helpers/race-class-grants.mjs";
import { useConsumable } from "../../helpers/consumables.mjs";
import {
  createTestCharacter, createTestMob, createTestItem, deleteTestActor, useQuenchTimeout, withFakeTargets,
} from "../helpers.mjs";

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
    },
    { displayName: "CarlRPG: 0.7.1 rulings (conditions writer, Ranks, Opposed, Mend)" },
  );
}
