import {
  CHARGEN_STAGES,
  STAT_ORDER,
  allChargenProblems,
  applyChargen,
  backgroundOptions,
  chargenProblems,
  chargenSkills,
  chargenTable,
  newChargenState,
  parseBackgroundResult,
  rollStats,
  skillsTakenElsewhere,
} from "../../helpers/chargen.mjs";
import CrawlerCreation from "../../apps/crawler-creation.mjs";
import { slugifySkillName } from "../../helpers/modifiers.mjs";
import { findOwnedSkillLike } from "../../helpers/race-class-grants.mjs";
import { isInHotlist } from "../../helpers/hotlist.mjs";
import {
  createTestCharacter,
  createTestItem,
  deleteTestActor,
  settle,
  useQuenchTimeout,
  waitFor,
  withSetting,
} from "../helpers.mjs";

/** Change a wizard field as a user would, then let it redraw. */
async function changeField(app, selector, apply) {
  const el = app.element.querySelector(selector);
  apply(el);
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(150);
}

/** The wizard window for an actor, if open. */
function wizardFor(actor) {
  return foundry.applications.instances.get(`carl-chargen-${actor.id}`) ?? null;
}

/** A finished human state: no Skill twice, Standard Array. */
function humanState(actor, overrides = {}) {
  const state = newChargenState(actor);
  Object.assign(
    state,
    {
      name: actor.name,
      crawlerNumber: "5550001",
      stages: {
        childhood: {
          background: "Latchkey Kid",
          rolled: false,
          skills: ["Streetwise", "Perception"],
        },
        adolescence: { background: "Jock", rolled: false, skills: ["Endurance", "Jumping"] },
        career: { background: "Medical", rolled: false, skills: ["First Aid", "Detect Lies"] },
        hobby: { background: "Gamer", rolled: false, skills: ["Aiming", "Tactics"] },
      },
      combat: {
        type: "weapon",
        weapon: "Longsword",
        weaponName: "Tire Iron",
        spell: "Fire Fingers",
        handToHand: "Pugilism",
      },
      statMethod: "array",
      arrayStats: { str: "6", int: "5", con: "4", dex: "3", cha: "2" },
      past: {
        pastTrauma: "I witnessed a death.",
        looseEnds: "I didn't finish writing my novel.",
        regrets: "I never said goodbye.",
      },
      stuff: { clothing: "Jogging attire", weapon: "", item: "Lighter", weird: "A duck call" },
    },
    overrides,
  );
  return state;
}

/** Run fn, then delete the chat messages it posted. */
async function quietly(fn) {
  const made = [];
  const hook = Hooks.on("createChatMessage", (m) => made.push(m));
  try {
    return await fn();
  } finally {
    Hooks.off("createChatMessage", hook);
    for (const m of made) await m.delete();
  }
}

/** An owned Skill-like item's Rank, or null. */
function rankOf(actor, name, types) {
  return findOwnedSkillLike(actor, name, types)?.system.rank ?? null;
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.chargen",
    (context) => {
      const { describe, it, assert } = context;

      describe("Background tables", function () {
        useQuenchTimeout(this);

        it("reads a result as its background and three Skills", function () {
          assert.deepEqual(
            parseBackgroundResult(
              "Latchkey Kid: Streetwise (CHA), Perception (INT), or Stealth (DEX)",
            ),
            {
              name: "Latchkey Kid",
              skills: [
                { name: "Streetwise", stat: "cha" },
                { name: "Perception", stat: "int" },
                { name: "Stealth", stat: "dex" },
              ],
            },
          );
          assert.deepEqual(
            parseBackgroundResult(
              "Teacher's Pet: Catcher (None), Perception (INT), or Good First Impression (CHA)",
            ).skills.map((s) => s.name),
            ["Catcher", "Perception", "Good First Impression"],
          );
          assert.isNull(parseBackgroundResult("I witnessed a death."));
        });

        it("every background on all eight tables has three Skills that exist in the Skills pack", async function () {
          const pack = game.packs.get("carl-rpg.skills-and-spells");
          const known = new Set((await pack.getIndex()).map((e) => slugifySkillName(e.name)));
          for (const [kind, stages] of Object.entries(CHARGEN_STAGES)) {
            for (const stage of stages) {
              const options = backgroundOptions(await chargenTable(stage.table));
              assert.lengthOf(options, kind === "human" ? 12 : 6, stage.table);
              for (const option of options) {
                assert.lengthOf(option.skills, 3, `${stage.table}: ${option.name}`);
                for (const skill of option.skills)
                  assert.isTrue(
                    known.has(slugifySkillName(skill.name)),
                    `${option.name}: ${skill.name}`,
                  );
              }
            }
          }
        });
      });

      describe("What blocks finishing", function () {
        useQuenchTimeout(this);

        it("a finished state has no problems", async function () {
          const actor = await createTestCharacter("chargen ok");
          try {
            assert.deepEqual(allChargenProblems(humanState(actor)), []);
            assert.lengthOf(
              chargenSkills(humanState(actor)),
              11,
              "eight background Skills, two combat Skills and Heal",
            );
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("no double-dipping, the array used once each, and an attack Spell needs INT 4", async function () {
          const actor = await createTestCharacter("chargen problems");
          try {
            const dup = humanState(actor);
            dup.stages.hobby = {
              background: "Pop Culture",
              rolled: false,
              skills: ["Perception", "Investigation"],
            };
            assert.isNotEmpty(chargenProblems(dup, "backgrounds"), "Perception twice");
            assert.isTrue(skillsTakenElsewhere(dup, "hobby").has("perception"));

            const fists = humanState(actor);
            fists.stages.childhood = {
              background: "Problem Child",
              rolled: false,
              skills: ["Pugilism", "Deception"],
            };
            fists.combat.type = "handToHand";
            assert.isNotEmpty(
              chargenProblems(fists, "combat"),
              "Pugilism from Childhood and as the combat Skill",
            );

            const sword = humanState(actor);
            sword.stages.career = {
              background: "Service Industry",
              rolled: false,
              skills: ["Dagger", "Endurance"],
            };
            assert.isNotEmpty(
              chargenProblems(sword, "backgrounds"),
              "Endurance from two backgrounds",
            );

            const array = humanState(actor, {
              arrayStats: { str: "6", int: "6", con: "4", dex: "3", cha: "2" },
            });
            assert.isNotEmpty(chargenProblems(array, "stats"));

            const spell = humanState(actor, {
              arrayStats: { str: "6", int: "3", con: "4", dex: "5", cha: "2" },
            });
            spell.combat.type = "spell";
            assert.isNotEmpty(chargenProblems(spell, "stats"), "INT 3 can't take an attack Spell");
            spell.arrayStats = { str: "2", int: "4", con: "3", dex: "5", cha: "6" };
            assert.isEmpty(chargenProblems(spell, "stats"));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the settings take a method away", async function () {
          const actor = await createTestCharacter("chargen settings");
          try {
            await withSetting("chargenStatMethods", "roll", async () => {
              assert.isNotEmpty(
                chargenProblems(humanState(actor), "stats"),
                "the array isn't allowed",
              );
              assert.equal(newChargenState(actor).statMethod, "roll");
            });
            await withSetting("chargenBackgroundMethods", "roll", async () => {
              assert.isNotEmpty(
                chargenProblems(humanState(actor), "backgrounds"),
                "chosen, not rolled",
              );
              const rolled = humanState(actor);
              for (const stage of Object.values(rolled.stages)) stage.rolled = true;
              assert.isEmpty(chargenProblems(rolled, "backgrounds"));
            });
            await withSetting("allowAnimalCrawlers", false, async () => {
              assert.isNotEmpty(
                chargenProblems(humanState(actor, { kind: "animal", size: 2 }), "crawler"),
              );
            });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("rolled Stats are 2 to 6, one per Stat", async function () {
          const stats = await quietly(() => rollStats());
          assert.sameMembers(Object.keys(stats), STAT_ORDER);
          for (const value of Object.values(stats))
            assert.isTrue(value >= 2 && value <= 6, String(value));
        });
      });

      describe("Making the crawler", function () {
        useQuenchTimeout(this);

        it("a weapon crawler: Skills at their stage's Rank, the weapon in hand, full Health and Mana", async function () {
          const actor = await createTestCharacter("chargen weapon");
          try {
            await quietly(() => applyChargen(actor, humanState(actor)));
            assert.equal(rankOf(actor, "Streetwise"), 1, "Childhood: Rank 1");
            assert.equal(rankOf(actor, "Jumping"), 1, "Adolescence: Rank 1");
            assert.equal(rankOf(actor, "First Aid"), 3, "Career: Rank 3");
            assert.equal(rankOf(actor, "Tactics"), 2, "Hobby: Rank 2");
            assert.isNull(rankOf(actor, "Stealth"), "the third Skill isn't taken");
            assert.equal(rankOf(actor, "Unarmed Combat"), 3);
            assert.equal(rankOf(actor, "Longsword"), 3);
            assert.equal(rankOf(actor, "Heal", ["spell"]), 1);
            assert.isTrue(
              isInHotlist(actor, findOwnedSkillLike(actor, "Heal", ["spell"])),
              "Heal in the Hotlist",
            );

            const weapon = actor.items.find((i) => i.type === "item" && i.name === "Tire Iron");
            assert.exists(weapon, "the weapon, by its own name");
            assert.equal(weapon.system.weaponSkill, "Longsword");
            assert.equal(actor.system.gearSlots.mainHand, weapon.id, "in the Main Hand");
            // From the Gear compendium's basic Longsword when it's built: its
            // icon and source, the player's name kept.
            const basic = (await game.packs.get("carl-rpg.gear")?.getIndex())?.find(
              (e) => e.name === "Longsword",
            );
            if (basic) {
              assert.equal(weapon.img, basic.img, "the compendium weapon's icon");
              assert.equal(weapon._stats.compendiumSource, basic.uuid);
              assert.isFalse(weapon.system.twoHanded);
            }
            const clothes = actor.items.find((i) => i.name === "Jogging attire");
            assert.equal(actor.system.gearSlots.torso, clothes?.id, "the clothes on the Torso");
            assert.isTrue(clothes?.system.equipped, "clothes worn");
            assert.isTrue(actor.items.some((i) => i.name === "Lighter"));

            assert.deepEqual(
              STAT_ORDER.map((k) => actor.system.stats[k].value),
              [6, 5, 4, 3, 2],
            );
            assert.equal(actor.system.details.aiFavor, 1);
            assert.equal(actor.system.details.size, 4);
            assert.equal(actor.system.details.crawlerNumber, "5550001");
            assert.equal(actor.system.hb.value, actor.system.hb.effectiveMax);
            assert.equal(actor.system.mana.value, 5, "Mana = INT");
            assert.include(actor.system.story, "I witnessed a death.");
            assert.include(actor.system.story, "Latchkey Kid");
            const story = actor.system.story;
            assert.isBelow(
              story.indexOf("Background"),
              story.indexOf(game.i18n.localize("CARLRPG.Actor.PastTrauma")),
              "the backgrounds come first, under Background",
            );
            assert.notInclude(story, game.i18n.localize("CARLRPG.Actor.Notes"));
            assert.isTrue(actor.getFlag("carl-rpg", "chargen").done);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Spell crawler gets the Spell at 3 and 5 Mana Potions in the Hotlist; hand-to-hand gets its Damage Effect", async function () {
          const caster = await createTestCharacter("chargen spell");
          const brawler = await createTestCharacter("chargen fists");
          try {
            const spell = humanState(caster, {
              arrayStats: { str: "2", int: "6", con: "4", dex: "5", cha: "3" },
            });
            spell.combat.type = "spell";
            await quietly(() => applyChargen(caster, spell));
            assert.equal(rankOf(caster, "Fire Fingers", ["spell"]), 3);
            const potions = caster.items.find((i) => i.name === "Mana Potion");
            assert.equal(potions?.system.quantity, 5);
            assert.isTrue(isInHotlist(caster, potions), "the potions in one Hotlist slot");
            assert.isFalse(
              caster.items.some((i) => i.name === "Tire Iron"),
              "no weapon",
            );

            const fists = humanState(brawler);
            fists.combat.type = "handToHand";
            await quietly(() => applyChargen(brawler, fists));
            assert.equal(rankOf(brawler, "Pugilism"), 3);
            assert.equal(rankOf(brawler, "Iron Punch", ["damageEffect"]), 3);
          } finally {
            await deleteTestActor(caster);
            await deleteTestActor(brawler);
          }
        });

        it("the outfit goes on a Torso holding only a deleted item's id", async function () {
          const actor = await createTestCharacter("chargen torso");
          try {
            await actor.update({ "system.gearSlots.torso": "goneGoneGoneGone" });
            await quietly(() => applyChargen(actor, humanState(actor)));
            const clothes = actor.items.find((i) => i.name === "Jogging attire");
            assert.equal(actor.system.gearSlots.torso, clothes?.id);
            assert.isTrue(clothes?.system.equipped);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Starting Stuff lands right however the created items come back ordered", async function () {
          // Foundry doesn't always return created documents in the order
          // asked for; matching them by position once put the clothes in the
          // Main Hand. Reverse them here to prove each is found by its role.
          const actor = await createTestCharacter("chargen order");
          const create = actor.createEmbeddedDocuments.bind(actor);
          actor.createEmbeddedDocuments = async (...args) => (await create(...args)).reverse();
          try {
            const state = humanState(actor, {
              arrayStats: { str: "2", int: "6", con: "4", dex: "5", cha: "3" },
            });
            await quietly(() => applyChargen(actor, state));
            const weapon = actor.items.find((i) => i.name === "Tire Iron");
            assert.equal(
              actor.system.gearSlots.mainHand,
              weapon?.id,
              "the weapon, not the clothes, in the Main Hand",
            );
            assert.isTrue(
              actor.items.find((i) => i.name === "Jogging attire")?.system.equipped,
              "clothes worn",
            );

            const caster = await createTestCharacter("chargen order spell");
            caster.createEmbeddedDocuments = async (...args) =>
              (await Actor.prototype.createEmbeddedDocuments.apply(caster, args)).reverse();
            try {
              const spell = humanState(caster, {
                arrayStats: { str: "2", int: "6", con: "4", dex: "5", cha: "3" },
              });
              spell.combat.type = "spell";
              await quietly(() => applyChargen(caster, spell));
              assert.isTrue(
                isInHotlist(
                  caster,
                  caster.items.find((i) => i.name === "Mana Potion"),
                ),
                "the potions, not another item, in the Hotlist",
              );
              assert.isFalse(
                caster.items.some((i) => i.name === "Lighter" && isInHotlist(caster, i)),
                "the Lighter stays out",
              );
            } finally {
              await deleteTestActor(caster);
            }
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("an animal crawler: Slice Attack, no AI Favor, its Size, the animal backgrounds' Ranks", async function () {
          const actor = await createTestCharacter("chargen animal");
          try {
            const state = humanState(actor, {
              kind: "animal",
              size: 2,
              stages: {
                youth: { background: "Runt", rolled: true, skills: ["Hide in Shadows", "Stealth"] },
                training: {
                  background: "Clever",
                  rolled: true,
                  skills: ["Investigation", "Dodge"],
                },
                adult: { background: "Guard", rolled: true, skills: ["Catcher", "Taunt"] },
                quirk: { background: "Curious", rolled: true, skills: ["Climbing", "Swimming"] },
              },
            });
            assert.deepEqual(allChargenProblems(state), []);
            await quietly(() => applyChargen(actor, state));
            assert.equal(rankOf(actor, "Slice Attack"), 3);
            assert.isNull(rankOf(actor, "Unarmed Combat"));
            assert.equal(rankOf(actor, "Catcher"), 3, "Adult: Rank 3");
            assert.equal(rankOf(actor, "Swimming"), 2, "Quirk: Rank 2");
            assert.equal(actor.system.details.aiFavor, 0);
            assert.equal(actor.system.details.size, 2);

            const strike = { ...state.combat, type: "strike", strike: "Bite" };
            assert.equal(
              chargenSkills({ ...state, combat: strike }).find((s) => s.name === "Bite")?.rank,
              3,
              "an animal can take Bite as its second combat Skill",
            );
            assert.isNotEmpty(
              chargenProblems({ ...humanState(actor), combat: strike }, "combat"),
              "a human can't",
            );
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("Running it again", function () {
        useQuenchTimeout(this);

        it("a crawler already done is refused; one left half made is finished without doubling its gear or story", async function () {
          const actor = await createTestCharacter("chargen retry");
          try {
            const state = humanState(actor);
            await quietly(() => applyChargen(actor, state));
            let refused = false;
            try {
              await applyChargen(actor, state);
            } catch {
              refused = true;
            }
            assert.isTrue(
              refused,
              "done: no second run (the GM and the player both pressing Create)",
            );

            // As if it had failed before the end: not done, but its first write made.
            await actor.update({ "flags.carl-rpg.chargen.done": false });
            const items = actor.items.size;
            await quietly(() => applyChargen(actor, state));
            assert.equal(actor.items.size, items, "no gear or Skills made twice");
            assert.lengthOf(
              actor.items.filter((i) => i.name === "Lighter"),
              1,
            );
            assert.equal(
              actor.system.story.split("Latchkey Kid").length - 1,
              1,
              "the story written once",
            );
            assert.isTrue(actor.getFlag("carl-rpg", "chargen").done);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Skill already owned is raised to the wizard's Rank, never lowered; the Hotlist stays ten slots", async function () {
          const actor = await createTestCharacter("chargen owned");
          try {
            await createTestItem(actor, "skill", "Pugilism", {
              name: "Pugilism",
              system: { rank: 1, category: "attack" },
            });
            await createTestItem(actor, "skill", "Streetwise", {
              name: "Streetwise",
              system: { rank: 5, category: "utility" },
            });
            // A Hotlist full of items that are gone: those slots are free.
            await actor.update({
              "system.hotlist": Array.from({ length: 10 }, () => foundry.utils.randomID()),
            });
            const state = humanState(actor);
            state.combat.type = "handToHand";
            await quietly(() => applyChargen(actor, state));
            assert.equal(rankOf(actor, "Pugilism"), 3, "raised to the combat Rank");
            assert.equal(rankOf(actor, "Streetwise"), 5, "not lowered to Childhood's 1");
            assert.lengthOf(
              actor.items.filter((i) => i.name === "Pugilism"),
              1,
              "not made twice",
            );
            assert.lengthOf(actor.system.hotlist, 10, "never past the last slot");
            assert.isTrue(
              isInHotlist(actor, findOwnedSkillLike(actor, "Heal", ["spell"])),
              "Heal took a freed slot",
            );
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("The wizard", function () {
        useQuenchTimeout(this);

        it("the sheet offers Create Crawler; the wizard's Create button makes the crawler", async function () {
          const actor = await createTestCharacter("chargen wizard");
          let app;
          try {
            await actor.sheet.render({ force: true });
            await waitFor(() => actor.sheet.rendered);
            assert.exists(
              actor.sheet.element.querySelector('[data-action="createCrawler"]'),
              "the header button",
            );
            await actor.sheet.close();

            app = CrawlerCreation.open(actor);
            await waitFor(() => app.rendered);
            assert.exists(app.element.querySelector('input[name="name"]'), "step 1");
            app.draft = humanState(actor);
            app.step = 6;
            await app.render();
            const create = app.element.querySelector('[data-action="create"]');
            assert.isFalse(create.disabled);
            await quietly(async () => {
              create.click();
              await waitFor(() => actor.getFlag("carl-rpg", "chargen")?.done, {
                message: "never created",
              });
              await waitFor(() => !app.rendered, { message: "the wizard didn't close" });
            });
            assert.equal(rankOf(actor, "Longsword"), 3);

            // Done: the button is gone, for the GM too (these tests run as GM).
            await waitFor(() => actor.sheet.rendered, { message: "the sheet didn't reopen" });
            await actor.sheet.render();
            await waitFor(
              () => !actor.sheet.element.querySelector('[data-action="createCrawler"]'),
              { message: "Create Crawler still offered after creation" },
            );
          } finally {
            if (app?.rendered) await app.close();
            if (actor.sheet?.rendered) await actor.sheet.close();
            await deleteTestActor(actor);
          }
        });

        it("the pages: a rolled background shows its Skills; two can be ticked, not three; under rolling only, it can't be rerolled", async function () {
          const actor = await createTestCharacter("chargen pages");
          let app;
          try {
            app = CrawlerCreation.open(actor);
            await waitFor(() => app.rendered);
            const next = app.element.querySelector('[data-action="next"]');
            await changeField(app, 'input[name="name"]', (el) => {
              el.value = "Driven";
            });
            assert.equal(app.draft.name, "Driven");
            assert.strictEqual(
              app.element.querySelector('[data-action="next"]'),
              next,
              "typing doesn't redraw the page, so a click on Next isn't lost",
            );
            await changeField(app, 'input[name="name"]', (el) => {
              el.value = "";
            });
            assert.isTrue(next.disabled, "no name: Next is off, without a redraw");
            assert.isFalse(
              app.element.querySelector(".carl-chargen-problems").hidden,
              "and the problem shows",
            );
            await changeField(app, 'input[name="name"]', (el) => {
              el.value = "Driven";
            });
            assert.isFalse(next.disabled);

            app.element.querySelector('[data-action="next"]').click();
            await waitFor(
              () =>
                app.element.querySelector('[data-action="rollBackground"][data-stage="childhood"]'),
              { message: "no Backgrounds page" },
            );
            await quietly(async () => {
              app.element
                .querySelector('[data-action="rollBackground"][data-stage="childhood"]')
                .click();
              await waitFor(() => app.draft.stages.childhood?.rolled, { message: "never rolled" });
            });
            const boxes = () => [
              ...app.element.querySelectorAll('input[name^="stage.childhood.skill."]'),
            ];
            await waitFor(() => boxes().length === 3, { message: "the background's three Skills" });
            for (const i of [0, 1, 2]) {
              const box = app.element.querySelector(`input[name="stage.childhood.skill.${i}"]`);
              if (!box.disabled)
                await changeField(app, `input[name="stage.childhood.skill.${i}"]`, (el) => {
                  el.checked = true;
                });
            }
            assert.lengthOf(app.draft.stages.childhood.skills, 2, "two at most");
            assert.lengthOf(
              boxes().filter((b) => b.disabled && !b.checked),
              1,
              "the third is shut",
            );

            await withSetting("chargenBackgroundMethods", "roll", async () => {
              await app.render();
              await settle(100);
              assert.notExists(
                app.element.querySelector('[data-action="rollBackground"][data-stage="childhood"]'),
                "a roll stands",
              );
              assert.exists(
                app.element.querySelector(
                  '[data-action="rollBackground"][data-stage="adolescence"]',
                ),
                "the next one can roll",
              );
              assert.isTrue(
                app.element.querySelector('select[name="stage.childhood.background"]').disabled,
                "no choosing",
              );
            });
          } finally {
            if (app?.rendered) await app.close();
            await deleteTestActor(actor);
          }
        });

        it("a Character made from the Actors sidebar opens the wizard; an imported one doesn't offer it", async function () {
          const actor = await createTestCharacter("chargen auto");
          const imported = await createTestCharacter("chargen imported", {
            flags: { "carl-rpg": { chargen: { done: true, imported: true } } },
          });
          try {
            await actor.sheet.render({ force: true, renderContext: "createActor" });
            await waitFor(() => wizardFor(actor)?.rendered, { message: "the wizard never opened" });

            await imported.sheet.render({ force: true, renderContext: "createActor" });
            await waitFor(() => imported.sheet.rendered);
            await settle(100);
            assert.isNull(wizardFor(imported), "already made");
          } finally {
            await wizardFor(actor)?.close();
            for (const a of [actor, imported]) {
              if (a.sheet?.rendered) await a.sheet.close();
              await deleteTestActor(a);
            }
          }
        });
      });
    },
    { displayName: "CarlRPG: Character creation" },
  );
}
