/**
 * Skills found by name, one way (2026-11-18 second-pass review): by slug
 * (modifiers.mjs slugifySkillName), Unicode-aware, on a real owned item.
 *  - Taunt and Catcher (ownedSkill) any case, in any script; gear's
 *    "+1 Catcher" alone gives no Catcher;
 *  - two Skills of one name: the skill bag counts one (no doubled dice);
 *  - an ASCII name slugs as it always did;
 *  - a Damage Effect fits a Spell parent too (damageEffectFits): nested
 *    under it on the sheet, offered when casting;
 *  - a Spell's Favored Class matches in any case.
 */
import CarlDice, { applyFavoredClassSurcharge } from "../../dice/dice.mjs";
import { assignItemToSlot } from "../../helpers/equip-slots.mjs";
import {
  damageEffectFits,
  effectiveRank,
  ownedSkill,
  sameSkillName,
  slugifySkillName,
} from "../../helpers/modifiers.mjs";
import { catcherDr, catcherRank } from "../../helpers/reaction-resolve.mjs";
import {
  createTestCharacter,
  createTestItem,
  deleteTestActor,
  useQuenchTimeout,
  waitFor,
} from "../helpers.mjs";

/** slugifySkillName before it was Unicode-aware - ASCII names must slug the same. */
const legacySlug = (name) =>
  String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "") || "unknown";

/** A Skill with exactly this name. */
const skill = (actor, name, system = {}) =>
  createTestItem(actor, "skill", name, { name, system: { rank: 1, ...system } });

/** Worn gear giving "+N" to a Skill. */
async function wornBonus(actor, target, value) {
  const gear = await createTestItem(actor, "item", `+${value} ${target}`, {
    system: {
      slots: ["head"],
      changes: [{ targetType: "skillRank", target, mode: "add", value: String(value) }],
    },
  });
  await assignItemToSlot(actor, { slotType: "gear", slotKey: "head" }, gear);
  return gear;
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.skill-names",
    (context) => {
      const { describe, it, assert } = context;

      describe("slugs", function () {
        useQuenchTimeout(this);

        it("an ASCII name slugs as before - every Skill/Spell in the pack, and odd spellings", async function () {
          const names = [
            "Fire Fingers",
            "  Multi   Space  ",
            "Wrasslin'",
            "Hand-to-Hand Combat",
            "Boring Ol' Mage",
            "a.b_c",
            "",
            "???",
          ];
          const index = await game.packs.get("carl-rpg.skills-and-spells")?.getIndex();
          for (const entry of index ?? []) names.push(entry.name);
          for (const name of names.filter((n) => /^[\x00-\x7f]*$/.test(n))) {
            assert.equal(slugifySkillName(name), legacySlug(name), name);
          }
        });

        it("accents drop, other scripts keep their letters, symbols-only matches nothing", function () {
          assert.equal(slugifySkillName("Épée"), "epee");
          assert.equal(slugifySkillName("Таунт Ловца"), "таунт-ловца");
          assert.notEqual(
            slugifySkillName("Таунт"),
            slugifySkillName("Ловец"),
            'no longer both "unknown"',
          );
          assert.isTrue(sameSkillName("ÉPÉE!", "epee"));
          assert.isFalse(sameSkillName("???", "!!!"), 'both "unknown", but not a match');
          assert.isFalse(sameSkillName("", ""));
        });
      });

      describe("Taunt and Catcher (ownedSkill)", function () {
        useQuenchTimeout(this);

        it("found in another case, with stray spaces, and in Cyrillic", async function () {
          const actor = await createTestCharacter("names");
          try {
            const taunt = await skill(actor, "taunt", { rank: 3 });
            const catcher = await skill(actor, "catcher ", { rank: 5 });
            const cyrillic = await skill(actor, "Ловец", { rank: 2 });
            const other = await skill(actor, "Щит", { rank: 7 });
            assert.equal(ownedSkill(actor, "Taunt")?.item.id, taunt.id);
            assert.equal(ownedSkill(actor, "Taunt")?.rank, 3);
            assert.equal(ownedSkill(actor, "CATCHER")?.item.id, catcher.id);
            assert.equal(catcherRank(actor), 5);
            assert.equal(catcherDr(actor), 5);
            assert.equal(ownedSkill(actor, "ловец")?.item.id, cyrillic.id);
            assert.equal(
              ownedSkill(actor, "ловец")?.rank,
              2,
              "its own bag entry, not merged with Щит",
            );
            assert.equal(ownedSkill(actor, "щит")?.rank, 7);
            assert.isNull(ownedSkill(actor, "Taunt", ["spell"]), "types narrow it");
            assert.isNull(ownedSkill(actor, "???"));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it('gear\'s "+1 Catcher" alone gives no Catcher DR; on top of the Skill it counts', async function () {
          const actor = await createTestCharacter("gear catcher");
          try {
            await wornBonus(actor, "Catcher", 5);
            assert.equal(
              actor.system.skills[slugifySkillName("Catcher")]?.rank,
              5,
              "the bag has the bonus",
            );
            assert.isNull(ownedSkill(actor, "Catcher"));
            assert.equal(catcherRank(actor), 0);
            assert.equal(catcherDr(actor), 0);
            const own = await skill(actor, "Catcher", { rank: 0 });
            assert.equal(catcherRank(actor), 5, "Rank 0 + 5 from gear");
            await own.update({ "system.rank": 4 });
            assert.equal(catcherRank(actor), 9);
            assert.equal(catcherDr(actor), 5, "Rank 9: one step");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("two Skills of one name", function () {
        useQuenchTimeout(this);

        it("the bag counts the higher Rank once: its base dice once, its Rank; the other keeps its own", async function () {
          const actor = await createTestCharacter("duplicates");
          try {
            const name = "Pugilism Dup QA";
            const fists = {
              category: "attack",
              isHandToHand: true,
              baseDamage: { dice: "1d6", damageType: "bludgeoning" },
            };
            const low = await skill(actor, name, { ...fists, rank: 5 });
            const high = await skill(actor, name.toUpperCase(), {
              ...fists,
              rank: 10,
              upgrades: [
                {
                  rankThreshold: 5,
                  changes: [
                    {
                      targetType: "skillDamage",
                      target: name,
                      mode: "add",
                      value: "1d4",
                      damageDiceKind: "base",
                    },
                  ],
                },
              ],
            });
            await low.update({
              "system.upgrades": [
                {
                  rankThreshold: 5,
                  changes: [
                    {
                      targetType: "skillDamage",
                      target: name,
                      mode: "add",
                      value: "1d8",
                      damageDiceKind: "base",
                    },
                  ],
                },
              ],
            });
            const entry = actor.system.skills[slugifySkillName(name)];
            assert.equal(entry.itemId, high.id);
            assert.equal(entry.rank, 10, "not mixed");
            assert.deepEqual(
              entry.damage.baseDice.map((d) => d.formula),
              ["1d6", "1d4"],
              "one base 1d6, and only the counted copy's own tier",
            );
            assert.equal(effectiveRank(high), 10);
            assert.equal(effectiveRank(low), 5, "the other reads its own Rank");
            assert.equal(
              ownedSkill(actor, name)?.item.id,
              high.id,
              "ownedSkill picks the counted one",
            );
            await high.update({ "system.rank": 1 });
            assert.equal(
              actor.system.skills[slugifySkillName(name)].itemId,
              low.id,
              "now the other is higher",
            );
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Damage Effects with a Spell parent", function () {
        useQuenchTimeout(this);

        it("nested under the Spell on the sheet, not Unassigned, and offered when casting", async function () {
          const actor = await createTestCharacter("spell de", { system: { mana: { value: 20 } } });
          const sheet = actor.sheet;
          try {
            const spell = await createTestItem(actor, "spell", "Zap QA", {
              name: "Zap QA",
              system: { rank: 1, manaCost: 1, baseDamage: { dice: "1d6", damageType: "electric" } },
            });
            const de = await createTestItem(actor, "damageEffect", "Arc QA", {
              name: "Arc QA",
              system: { rank: 1, parentSkills: ["zap  qa"] },
            });
            assert.isTrue(damageEffectFits(de, spell), "by slug, any case");
            assert.isFalse(damageEffectFits(de, de), "a Damage Effect isn't a parent");

            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const spellRow = sheet.element.querySelector(`li.item[data-item-id="${spell.id}"]`);
            assert.exists(spellRow, "the Spell's row");
            let next = spellRow.nextElementSibling;
            while (
              next &&
              !next.querySelector(".carl-nested-damage-effects") &&
              !next.matches("li.item")
            )
              next = next.nextElementSibling;
            assert.exists(
              next?.querySelector(`.carl-nested-damage-effects li[data-item-id="${de.id}"]`),
              "nested under the Spell",
            );
            assert.notExists(
              sheet.element.querySelector(
                `.carl-unmatched-damage-effects li[data-item-id="${de.id}"]`,
              ),
              "not Unassigned",
            );

            const args = await CarlDice.rollAttack(actor, spell, { promptArgsOnly: true });
            assert.include(
              (args?.damageEffectChoices ?? []).map((c) => c.id),
              de.id,
              "offered when casting",
            );
          } finally {
            await sheet.close();
            await deleteTestActor(actor);
          }
        });
      });

      describe("Favored Classes", function () {
        it("a Spell's Favored Class matches the Class in any case; any other Class pays +1 Mana (p.201)", function () {
          const actor = {
            system: { classItem: { name: "Boring Ol' Mage", system: { classTypes: ["mage"] } } },
          };
          const caster = (name, classTypes) => ({
            system: { classItem: { name, system: { classTypes } } },
          });
          const mageSpell = { system: { favoredClasses: ["Mage"] } };
          assert.equal(
            applyFavoredClassSurcharge(mageSpell, caster("Boring Ol' Mage", ["Mage"]), 3),
            3,
            "a Class whose category is favored pays the base cost",
          );
          assert.equal(
            applyFavoredClassSurcharge(mageSpell, caster("Brawler", ["Fighter"]), 3),
            4,
            "a Fighter Class pays 1 more",
          );
          assert.equal(
            applyFavoredClassSurcharge({ system: { favoredClasses: ["Mage"] } }, actor, 2),
            2,
            "a Mage: no surcharge",
          );
          assert.equal(
            applyFavoredClassSurcharge(
              { system: { favoredClasses: ["boring ol mage"] } },
              actor,
              2,
            ),
            2,
            "by the Class's own name",
          );
          assert.equal(
            applyFavoredClassSurcharge({ system: { favoredClasses: ["Cleric"] } }, actor, 2),
            3,
            "another Class pays 1 more",
          );
        });
      });
    },
    {
      displayName:
        "CarlRPG: Skill names (slugs, Taunt/Catcher, duplicates, Spell Damage Effects, Favored Classes)",
    },
  );
}
