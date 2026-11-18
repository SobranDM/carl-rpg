import { CarlRPGActorSheet } from "../../sheets/actor-sheet.mjs";
import CarlSpendStatPointsDialog from "../../apps/spend-stat-points-dialog.mjs";
import CarlDice from "../../dice/dice.mjs";
import { PVE_INITIATIVE } from "../../documents/combat.mjs";
import { isCrawler, isMinion, isPet, rollsLikeCrawler, diesAtZeroHb } from "../../helpers/actor-kinds.mjs";
import { petLevelAfter, bondedPets } from "../../helpers/pets.mjs";
import {
  canCommandPet, commandStateForDegree, commandDifficulty, commandPet, describePetCommand, petFight,
} from "../../helpers/pet-command.mjs";
import { baseBudget } from "../../helpers/actions.mjs";
import { crawlerAttackDifficulty, mobAttackRow, rowEvadeDifficulty } from "../../helpers/attack-targets.mjs";
import { shouldBeDefeated } from "../../helpers/defeat.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  createTestPet,
  deleteTestActor,
  deleteTestCombat,
  dropOnSheet,
  PIN_D20_MID,
  settle,
  useQuenchTimeout,
  waitFor,
  withPinnedDice,
  withSetting,
} from "../helpers.mjs";

/** Owned skill-like Item by name (exact). */
const owned = (actor, name) => actor.items.find((i) => i.name === name);

/** A started combat with these actors as combatants. */
async function startedCombat(...actors) {
  const combat = await Combat.create({});
  await combat.createEmbeddedDocuments("Combatant", actors.map((a) => ({ actorId: a.id })));
  await combat.startCombat();
  return combat;
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.pets",
    (context) => {
      const { describe, it, assert } = context;

      describe("Pet data", function () {
        useQuenchTimeout(this);

        it("starts as the book's Level 1 Pet, Calm, on a linked token, with full HB and Slice Attack", async function () {
          const pet = await createTestPet("defaults");
          try {
            const sys = pet.system;
            assert.equal(sys.attributes.level.value, 1);
            assert.deepEqual(
              Object.fromEntries(Object.entries(sys.stats).map(([k, s]) => [k, s.value])),
              { str: 2, dex: 2, con: 2, int: 1, cha: 1 },
            );
            for (const stat of Object.values(sys.stats)) assert.equal(stat.mod, 1, "every Mod is +1");
            assert.equal(sys.attitude, "calm");
            assert.isFalse(sys.isMount);
            assert.isTrue(pet.prototypeToken.actorLink);
            assert.equal(sys.hb.max, 3, "Size 3 at Level 1");
            assert.equal(sys.hb.value, 3, "starts at full HB");
            await waitFor(() => owned(pet, "Slice Attack"), { message: "Slice Attack never granted" });
          } finally {
            await deleteTestActor(pet);
          }
        });

        it("HB slots: Size + Level - 1, up to 10; a mount stays at its Size; the override wins", async function () {
          const pet = await createTestPet("hb", { system: { size: 3, attributes: { level: { value: 5 } } } });
          try {
            assert.equal(pet.system.hb.max, 7);
            await pet.update({ "system.size": 5, "system.attributes.level.value": 10 });
            assert.equal(pet.system.hb.max, 10, "capped at 10");
            await pet.update({ "system.isMount": true });
            assert.equal(pet.system.hb.max, 5, "a mount's HB is its Size");
            await pet.update({ "system.hbSlotsOverride": 8 });
            assert.equal(pet.system.hb.max, 8);
          } finally {
            await deleteTestActor(pet);
          }
        });

        it("Roles: Tank adds the Floor to DR; Aggressive adds Floor damage and Back Claw/Bite", async function () {
          await withSetting("currentFloor", 4, async () => {
            const pet = await createTestPet("roles", { system: { dr: 1 } });
            try {
              await pet.update({ "system.role": "tank" });
              assert.equal(pet.system.drEffective, 5);
              assert.equal(pet.system.specialAbilityAllowed, 1);

              await pet.update({ "system.role": "aggressive" });
              assert.equal(pet.system.drEffective, 1);
              assert.equal(pet.system.specialAbilityAllowed, 0);
              await waitFor(() => owned(pet, "Bite") && owned(pet, "Back Claw"), { message: "Bite / Back Claw never granted" });
              const bite = pet.system.skills.bite;
              assert.exists(bite.damage.flatBonuses.find((t) => t.formula === "4"), "+F damage on Bite");

              await pet.update({ "system.role": "utility" });
              assert.equal(pet.system.specialAbilityAllowed, 2);
            } finally {
              await deleteTestActor(pet);
            }
          });
        });

        it("Special Abilities: Move 60, Resistance, alternate Move, Taunt", async function () {
          const pet = await createTestPet("abilities");
          try {
            await pet.update({
              "system.specialAbilities.move60": true,
              "system.specialAbilities.resistance": "fire",
              "system.specialAbilities.altMove": "flight",
              "system.specialAbilities.tauntOrCatcher": "taunt",
            });
            assert.equal(pet.system.moveEffective, 60);
            assert.equal(pet.system.resistancesEffective.fire, "resist");
            assert.equal(pet.system.altMoveValue, 50);
            assert.equal(pet.system.specialAbilityCount, 4);
            await waitFor(() => owned(pet, "Taunt"), { message: "Taunt never granted" });

            const sheet = pet.sheet;
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const traits = sheet.element.querySelectorAll(".carl-pet-traits li");
            assert.equal(traits.length, 4, "each chosen ability is listed on the Abilities tab");
            await sheet.close();
          } finally {
            await deleteTestActor(pet);
          }
        });
      });

      describe("Rank = Floor", function () {
        useQuenchTimeout(this);

        it("a Pet's Skill reads the Floor as its Rank; the same Skill on a crawler keeps its own", async function () {
          await withSetting("currentFloor", 7, async () => {
            const pet = await createTestPet("rank");
            const crawler = await createTestCharacter("rank");
            try {
              const upgrades = [
                { rankThreshold: 5, description: "five", changes: [] },
                { rankThreshold: 10, description: "ten", changes: [] },
                { rankThreshold: 15, description: "fifteen", changes: [] },
              ];
              const petSkill = await createTestItem(pet, "skill", "pet bite", { system: { rank: 0, category: "attack", upgrades } });
              const crawlerSkill = await createTestItem(crawler, "skill", "crawler bite", { system: { rank: 2, category: "attack", upgrades } });
              assert.equal(petSkill.system.rank, 7);
              assert.equal(petSkill.system.unlockedUpgrades.length, 1, "the Rank 5 Upgrade only");
              assert.equal(petSkill._source.system.rank, 0, "nothing is written");
              assert.equal(crawlerSkill.system.rank, 2);

              await game.settings.set("carl-rpg", "currentFloor", 12);
              assert.equal(pet.items.get(petSkill.id).system.rank, 12, "follows a Floor change");
              await game.settings.set("carl-rpg", "currentFloor", 0);
              assert.equal(pet.items.get(petSkill.id).system.rank, 1, "Floor 0 counts as Rank 1");
            } finally {
              await deleteTestActor(pet);
              await deleteTestActor(crawler);
            }
          });
        });

        it("a Pet's Skills never advance: no use-mark, no Advancement Check", async function () {
          const pet = await createTestPet("advance");
          try {
            const skill = await createTestItem(pet, "skill", "pet trick", { system: { category: "utility" } });
            assert.isFalse(CarlDice.isAdvancedByUse(skill));
            await CarlDice.markForAdvancement(skill);
            assert.isFalse(pet.items.get(skill.id).system.marked);
            const result = await CarlDice.rollAdvancementCheck(pet, skill, { silent: true });
            assert.isFalse(result.success);
            assert.isNull(result.roll);
          } finally {
            await deleteTestActor(pet);
          }
        });
      });

      describe("Levelling and Stat Points", function () {
        useQuenchTimeout(this);

        it("petLevelAfter: 2 Levels per crawler Level until 15, then 1", function () {
          assert.equal(petLevelAfter(1, 1), 3);
          assert.equal(petLevelAfter(13, 1), 15);
          assert.equal(petLevelAfter(14, 1), 15);
          assert.equal(petLevelAfter(15, 2), 17);
          assert.equal(petLevelAfter(1, 8), 16);
        });

        it("a crawler's Level gain levels its Pets (not its mount, not another crawler's Pet)", async function () {
          const owner = await createTestCharacter("owner");
          const other = await createTestCharacter("other");
          const pet = await createTestPet("levels", { system: { ownerId: owner.id } });
          const mount = await createTestPet("mount", { system: { ownerId: owner.id, isMount: true } });
          const stranger = await createTestPet("stranger", { system: { ownerId: other.id } });
          try {
            assert.sameMembers(bondedPets(owner).map((p) => p.id), [pet.id, mount.id]);
            await owner.update({ "system.attributes.level.value": 2 });
            await waitFor(() => pet.system.attributes.level.value === 3, { message: "the Pet never levelled" });
            assert.equal(pet.system.bankedStatPoints, 6, "3 Stat Points per Pet Level");
            await settle(100);
            assert.equal(mount.system.attributes.level.value, 1);
            assert.equal(stranger.system.attributes.level.value, 1);
          } finally {
            for (const a of [pet, mount, stranger, owner, other]) await deleteTestActor(a);
          }
        });

        it("the Spend Stat Points dialog won't raise a Pet's INT", async function () {
          const pet = await createTestPet("spend", { system: { bankedStatPoints: 2 } });
          const dialog = new CarlSpendStatPointsDialog(pet);
          try {
            await dialog.render({ force: true });
            await waitFor(() => dialog.rendered);
            dialog.element.querySelector('[data-action="incrementStat"][data-key="int"]').click();
            await settle(100);
            assert.equal(pet.system.stats.int.value, 1);
            assert.equal(pet.system.bankedStatPoints, 2);
            dialog.element.querySelector('[data-action="incrementStat"][data-key="str"]').click();
            await waitFor(() => pet.system.stats.str.value === 3, { message: "STR never rose" });
            assert.equal(pet.system.bankedStatPoints, 1);
          } finally {
            await dialog.close();
            await deleteTestActor(pet);
          }
        });

        it("a Pet dies at 0 HB: no Dying", async function () {
          const pet = await createTestPet("zero");
          try {
            await pet.update({ "system.hb.value": 0 });
            assert.notExists(pet.system.conditions.find((c) => c.key === "dying"));
            assert.isTrue(shouldBeDefeated(pet));
          } finally {
            await deleteTestActor(pet);
          }
        });
      });

      describe("Pets in combat", function () {
        useQuenchTimeout(this);

        it("actor kinds", function () {
          assert.isTrue(rollsLikeCrawler("pet"));
          assert.isTrue(rollsLikeCrawler({ type: "pet" }));
          assert.isTrue(rollsLikeCrawler("character"));
          assert.isFalse(rollsLikeCrawler("mob"));
          assert.isFalse(isCrawler("pet"));
          assert.isTrue(isPet("pet"));
          assert.isTrue(diesAtZeroHb("pet"));
          assert.isFalse(diesAtZeroHb("character"));
        });

        it("a Pet acts in the Crawler phase; crawlers + Pets alone is still PvP", async function () {
          const mob = await createTestMob("pve");
          const crawler = await createTestCharacter("pve");
          const pet = await createTestPet("pve", { system: { ownerId: crawler.id } });
          let pve;
          let pvp;
          try {
            pve = await Combat.create({});
            await pve.createEmbeddedDocuments("Combatant", [{ actorId: mob.id }]);
            await pve.createEmbeddedDocuments("Combatant", [crawler, pet].map((a) => ({ actorId: a.id })));
            await settle(150);
            assert.isFalse(pve.isPvP);
            assert.equal(pve.combatants.find((c) => c.actorId === pet.id).initiative, PVE_INITIATIVE.character);

            pvp = await Combat.create({});
            await pvp.createEmbeddedDocuments("Combatant", [crawler, pet].map((a) => ({ actorId: a.id })));
            assert.isTrue(pvp.isPvP);
          } finally {
            await deleteTestCombat(pve);
            await deleteTestCombat(pvp);
            for (const a of [mob, pet, crawler]) await deleteTestActor(a);
          }
        });

        it("a Mob's Attack on a Pet offers the owner Roll Evade; a Pet's own Attack counts as a crawler's", async function () {
          const pet = await createTestPet("target");
          try {
            const { row } = mobAttackRow({ id: "t0", target: { uuid: pet.uuid, actor: pet }, base: 14, ownRows: [] });
            assert.isTrue(row.isCharacter, "defends like a crawler");
            const evade = crawlerAttackDifficulty(pet, 1);
            assert.equal(evade.difficulty, 10 + pet.system.stats.dex.mod + 1);
            assert.equal(rowEvadeDifficulty({ isCharacter: true, difficulty: 9 }, { attackerType: "pet", attackTotal: 17 }), 17,
              "a Pet attacking a crawler uses the PvP Evade rule");
          } finally {
            await deleteTestActor(pet);
          }
        });
      });

      describe("Command Pet", function () {
        useQuenchTimeout(this);

        it("maps every Degree of Success, against 10 + INT Mod + Floor", async function () {
          assert.equal(commandStateForDegree("criticalHit"), "free");
          assert.equal(commandStateForDegree("amazingSuccess"), "free");
          assert.equal(commandStateForDegree("standardSuccess"), "restricted");
          assert.equal(commandStateForDegree("nearMissFail"), "stayingOut");
          assert.equal(commandStateForDegree("standardFail"), "stayingOut");
          assert.equal(commandStateForDegree("majorFail"), "hiding");
          assert.equal(commandStateForDegree("criticalFail"), "hiding");
          await withSetting("currentFloor", 3, async () => {
            const pet = await createTestPet("dc");
            try {
              assert.equal(commandDifficulty(pet), 14);
            } finally {
              await deleteTestActor(pet);
            }
          });
        });

        it("a trained crawler's Animal Handling records the result for this fight, and a repeat is refused", async function () {
          await withSetting("currentFloor", 1, async () => {
            const owner = await createTestCharacter("handler");
            const pet = await createTestPet("trained", { system: { ownerId: owner.id } });
            const [skill] = await owner.createEmbeddedDocuments("Item", [{
              name: "Animal Handling", type: "skill", system: { rank: 10, governingStat: "cha", category: "utility" },
            }]);
            const combat = await startedCombat(owner);
            try {
              assert.strictEqual(petFight(pet), combat, "the fight its crawler is in");
              // d20 10 + Rank 10 + CHA +2 = 22 vs 12: Amazing Success.
              const state = await withPinnedDice(PIN_D20_MID, () => commandPet(pet, { skipDialog: true }));
              assert.equal(state, "free");
              assert.equal(pet.system.command.state, "free");
              assert.equal(pet.system.command.combatId, combat.id);
              assert.isTrue(describePetCommand(pet).active);
              assert.isTrue(owner.items.get(skill.id).system.marked, "the crawler's Skill is used");
              await waitFor(() => pet.statuses.has(CONFIG.CARLRPG.petCommandStates.free.status),
                { message: "the token status never turned on" });

              const again = await commandPet(pet, { skipDialog: true });
              assert.isNull(again, "already settled for this fight");
            } finally {
              await deleteTestCombat(combat);
              await deleteTestActor(pet);
              await deleteTestActor(owner);
            }
          });
        });

        it("an untrained crawler rolls with Disadvantage and nothing is created or marked; staying out can retry", async function () {
          await withSetting("currentFloor", 4, async () => {
            const owner = await createTestCharacter("untrained");
            const pet = await createTestPet("untrained", { system: { ownerId: owner.id } });
            const combat = await startedCombat(owner, pet);
            try {
              const itemsBefore = owner.items.size;
              // 2d20kl, both 10, + CHA +2 = 12 vs 15: a Standard Fail - stays out.
              const state = await withPinnedDice(PIN_D20_MID, () => commandPet(pet, { skipDialog: true }));
              assert.equal(state, "stayingOut");
              assert.equal(owner.items.size, itemsBefore);
              const retry = await withPinnedDice(PIN_D20_MID, () => commandPet(pet, { skipDialog: true }));
              assert.equal(retry, "stayingOut", "staying out may be tried again");
            } finally {
              await deleteTestCombat(combat);
              await deleteTestActor(pet);
              await deleteTestActor(owner);
            }
          });
        });

        it("is refused outside a fight, without a crawler, and for a mount", async function () {
          const owner = await createTestCharacter("nofight");
          const pet = await createTestPet("nofight", { system: { ownerId: owner.id } });
          const orphan = await createTestPet("orphan");
          // A GM with an assigned crawler becomes a new Pet's crawler by default.
          await orphan.update({ "system.ownerId": "" });
          const mount = await createTestPet("mount", { system: { ownerId: owner.id, isMount: true } });
          try {
            assert.isNull(await commandPet(pet, { skipDialog: true }));
            assert.equal(pet.system.command.state, "");
            assert.isNull(await commandPet(orphan, { skipDialog: true }));
            assert.isNull(await commandPet(mount, { skipDialog: true }));
          } finally {
            for (const a of [pet, orphan, mount, owner]) await deleteTestActor(a);
          }
        });

        it("ending the fight clears every result from it, even a Pet that never joined", async function () {
          const owner = await createTestCharacter("reset");
          const pet = await createTestPet("reset", { system: { ownerId: owner.id } });
          const combat = await startedCombat(owner);
          try {
            await pet.update({ "system.command": { state: "hiding", combatId: combat.id, round: 1 } });
            await waitFor(() => pet.statuses.has(CONFIG.CARLRPG.petCommandStates.hiding.status));
            await deleteTestCombat(combat);
            await waitFor(() => pet.system.command.state === "", { message: "the result was never cleared" });
            await waitFor(() => !pet.statuses.has(CONFIG.CARLRPG.petCommandStates.hiding.status),
              { message: "the token status never turned off" });
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(pet);
            await deleteTestActor(owner);
          }
        });

        it("a result from a fight that no longer exists shows as none", async function () {
          const pet = await createTestPet("stale");
          try {
            await pet.update({ "system.command": { state: "restricted", combatId: "notARealCombat1", round: 2 } });
            assert.isFalse(describePetCommand(pet).active);
          } finally {
            await deleteTestActor(pet);
          }
        });
      });

      describe("Minions (p.233)", function () {
        useQuenchTimeout(this);

        it("a Pet with the Minion box is a minion; a mount never is", async function () {
          const minion = await createTestPet("minion", { system: { isMinion: true } });
          const pet = await createTestPet("pet");
          const mount = await createTestPet("mount", { system: { isMinion: true, isMount: true } });
          try {
            assert.isTrue(isMinion(minion));
            assert.isFalse(isMinion(pet));
            assert.isFalse(isMinion(mount));
            assert.isTrue(describePetCommand(minion).minion);
          } finally {
            for (const a of [minion, pet, mount]) await deleteTestActor(a);
          }
        });

        it("no Command Check: it's refused, and the minion fights with its two Actions anyway", async function () {
          const owner = await createTestCharacter("controller");
          const minion = await createTestPet("minion", { system: { ownerId: owner.id, isMinion: true } });
          const pet = await createTestPet("pet", { system: { ownerId: owner.id } });
          const combat = await startedCombat(owner, minion, pet);
          try {
            assert.isFalse(canCommandPet(minion));
            assert.isNull(await commandPet(minion, { skipDialog: true }));
            assert.equal(minion.system.command.state, "", "nothing recorded");
            const budget = (actor) => baseBudget(combat, combat.combatants.find((c) => c.actor === actor)).action;
            assert.equal(budget(minion), 2, "a minion: two Actions");
            assert.equal(budget(pet), 0, "an uncommanded Pet: none");
          } finally {
            await deleteTestCombat(combat);
            for (const a of [minion, pet, owner]) await deleteTestActor(a);
          }
        });
      });

      describe("Pet sheet", function () {
        useQuenchTimeout(this);

        it("uses the Pet layout on core ActorSheetV2: setup on Details, no grinding, Pet Gear, Floor Ranks without marks", async function () {
          const pet = await createTestPet("sheet");
          const sheet = pet.sheet;
          try {
            await createTestItem(pet, "skill", "sheet trick", { system: { category: "utility" } });
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            assert.instanceOf(sheet, foundry.applications.sheets.ActorSheetV2);
            assert.instanceOf(sheet, CarlRPGActorSheet);
            assert.exists(sheet.element.querySelector(".carl-pet-header"));
            assert.exists(sheet.element.querySelector(".carl-pet-statblock-row"));
            assert.notExists(sheet.element.querySelector(".carl-grind-level"));
            const gearTab = sheet.element.querySelector('nav [data-tab="items"]');
            assert.include(gearTab.textContent, game.i18n.localize("CARLRPG.Tab.PetGear"));
            // Set-once fields live on the Details tab, not in the header.
            const detailsTab = sheet.element.querySelector('nav [data-tab="pet"]');
            assert.include(detailsTab.textContent, game.i18n.localize("CARLRPG.Tab.Details"));
            const details = sheet.element.querySelector('section.tab[data-tab="pet"]');
            for (const name of ["system.ownerId", "system.attitude", "system.role", "system.size", "system.isMount", "system.move"]) {
              assert.exists(details.querySelector(`[name="${name}"]`), `${name} on Details`);
              assert.notExists(sheet.element.querySelector(`.carl-pet-header [name="${name}"]`), `${name} not in the header`);
            }
            assert.exists(sheet.element.querySelector(".carl-pet-header .carl-pet-command"), "Command Pet stays in the header");
            assert.notExists(sheet.element.querySelector('[data-action="toggleMark"]'));
          } finally {
            await sheet.close();
            await deleteTestActor(pet);
          }
        });

        it("refuses a Class or Race drop", async function () {
          const pet = await createTestPet("drop");
          const race = await Item.create({ name: `Quench race ${foundry.utils.randomID()}`, type: "race" });
          const sheet = pet.sheet;
          try {
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            const { result } = await dropOnSheet(sheet, sheet.element, race.toDragData());
            assert.isNull(result);
            assert.notExists(pet.items.find((i) => i.type === "race"));
          } finally {
            await sheet.close();
            await deleteTestActor(pet);
            await race.delete();
          }
        });
      });
    },
    { displayName: "CarlRPG: Pets" },
  );
}
