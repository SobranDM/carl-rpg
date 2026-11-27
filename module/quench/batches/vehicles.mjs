import { CarlRPGActorSheet } from "../../sheets/actor-sheet.mjs";
import {
  isVehicle,
  rollsLikeCrawler,
  diesAtZeroHb,
  takesConditions,
} from "../../helpers/actor-kinds.mjs";
import {
  vehicleStatus,
  vehicleSeatOf,
  tableSixMove,
  stepUpDegree,
  drivingOutcome,
} from "../../helpers/vehicle-state.mjs";
import {
  boardVehicle,
  exitVehicle,
  setDriver,
  applyVehiclePreset,
  activateNitrous,
} from "../../helpers/vehicles.mjs";
import { collectVehicleRows } from "../../helpers/vehicle-rows.mjs";
import {
  rollDrivingCheck,
  commitDrivingRound,
  drivingCardCurrent,
} from "../../helpers/vehicle-driving.mjs";
import { ramFormula, rollRam } from "../../helpers/vehicle-ram.mjs";
import { applyRow } from "../../chat/attack-targets-card.mjs";
import { activeRows, childRowId } from "../../helpers/attack-targets.mjs";
import { buildWeaponFire } from "../../helpers/vehicle-weapons.mjs";
import { assignItemToSlot } from "../../helpers/equip-slots.mjs";
import {
  attackDifficultyParts,
  crawlerAttackRow,
  mobAttackRow,
} from "../../helpers/attack-targets.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import { applyDamageToActor } from "../../chat/damage-card.mjs";
import { shouldBeDefeated } from "../../helpers/defeat.mjs";
import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  createTestVehicle,
  deleteTestActor,
  deleteTestCombat,
  dropOnSheet,
  PIN_D20_MID,
  settle,
  useQuenchTimeout,
  waitFor,
  withFakeTargets,
  withPinnedDice,
  withSetting,
} from "../helpers.mjs";

/**
 * Driving's and Chopper Pilot's Upgrade tiers' vehicle fields, as the pack
 * has them (p.187, p.190) - what CONFIG gave them before 0.7.0.
 */
const BOOK_TIERS = {
  Driving: [
    { rankThreshold: 5, description: "", vehicleAttackOk: true },
    { rankThreshold: 10, description: "", vehicleMove: 5, vehicleEvadeAdvantage: true },
    { rankThreshold: 15, description: "", vehicleMove: 5, vehicleStuntAdvantage: true },
  ],
  "Chopper Pilot": [
    { rankThreshold: 5, description: "", vehicleMove: 5 },
    { rankThreshold: 10, description: "", vehicleAttackOk: true },
    { rankThreshold: 15, description: "", vehicleMove: 5, vehicleStuntAdvantage: true },
  ],
};

/** A crawler owning a Skill by exact name at a Rank (the book's tiers for Driving and Chopper Pilot). */
async function crawlerWithSkill(
  label,
  name,
  rank,
  stat = "dex",
  upgrades = BOOK_TIERS[name] ?? [],
) {
  const actor = await createTestCharacter(label);
  await actor.createEmbeddedDocuments("Item", [
    { name, type: "skill", system: { rank, governingStat: stat, category: "utility", upgrades } },
  ]);
  return actor;
}

/** A vehicle with this crawler at the wheel. */
async function drivenVehicle(driver, data = {}) {
  const vehicle = await createTestVehicle("driven", data);
  await vehicle.update({
    "system.occupants": [{ uuid: driver.uuid, role: "driver", name: driver.name }],
    "system.parked": false,
  });
  return vehicle;
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.vehicles",
    (context) => {
      const { describe, it, assert } = context;

      describe("Vehicle data (Stage 1)", function () {
        useQuenchTimeout(this);

        it("starts as an object: 10 slots of its Size, linked token, Psychic immune, no Mana", async function () {
          const v = await createTestVehicle("defaults");
          try {
            const sys = v.system;
            assert.isTrue(v.prototypeToken.actorLink);
            assert.equal(sys.size, 5);
            assert.equal(sys.hb.max, 10);
            assert.equal(sys.hb.value, 10);
            assert.equal(sys.hb.slotValue, 5, "each slot holds the Size");
            assert.equal(sys.resistancesEffective.psychic, "immune");
            assert.equal(sys.mana.max, 0);
            assert.isTrue(sys.parked);
            await v.update({ "system.hbSlotValueOverride": 6 });
            assert.equal(v.system.hb.slotValue, 6);
            assert.isTrue(isVehicle(v));
            assert.isFalse(rollsLikeCrawler(v));
            assert.isTrue(diesAtZeroHb(v));
            assert.isFalse(takesConditions(v));
          } finally {
            await deleteTestActor(v);
          }
        });

        it("a Roll Cage adds 1 DR; damage loses slots of its Size; Psychic does nothing", async function () {
          const v = await createTestVehicle("damage", { system: { dr: 3 } });
          try {
            await v.update({ "system.upgrades.rollCage": true });
            assert.equal(v.system.drEffective, 4);
            await v.update({ "system.upgrades.rollCage": false });
            await applyDamageToActor(v, { bludgeoning: 13 }, false);
            assert.equal(v.system.hb.value, 8, "13 - DR 3 = 10 = two slots of 5");
            await applyDamageToActor(v, { psychic: 40 }, true);
            assert.equal(v.system.hb.value, 8);
          } finally {
            await deleteTestActor(v);
          }
        });

        it("a Table 7 preset fills in its stats", async function () {
          const v = await createTestVehicle("preset");
          try {
            await applyVehiclePreset(v, "motorcycle");
            const s = v.system;
            assert.deepEqual(
              [s.move, s.size, s.dr, s.occupancy, s.cargo, s.driveSkill],
              [120, 4, 1, 2, 0, "Chopper Pilot"],
            );
          } finally {
            await deleteTestActor(v);
          }
        });

        it("boarding: a sheet drop, one driver at a time, capacity, getting out", async function () {
          const v = await createTestVehicle("board", { system: { occupancy: 2 } });
          const a = await createTestCharacter("rider a");
          const b = await createTestCharacter("rider b");
          const c = await createTestCharacter("rider c");
          const sheet = v.sheet;
          try {
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            await dropOnSheet(sheet, sheet.element, a.toDragData());
            await waitFor(() => v.system.occupants.length === 1, {
              message: "the drop never boarded",
            });
            assert.equal(v.system.occupants[0].uuid, a.uuid);
            assert.equal(vehicleSeatOf(a)?.vehicle, v);

            await boardVehicle(v, b, { role: "driver" });
            assert.equal(v.system.occupants.length, 2);
            assert.equal(v.system.occupants.find((o) => o.uuid === b.uuid).role, "driver");
            assert.isFalse(await boardVehicle(v, c), "full");

            await setDriver(v, a.uuid);
            assert.equal(v.system.occupants.find((o) => o.uuid === a.uuid).role, "driver");
            assert.equal(
              v.system.occupants.find((o) => o.uuid === b.uuid).role,
              "passenger",
              "the old driver takes a seat",
            );
            // Seats are looked up from an index, kept until a vehicle changes.
            assert.equal(vehicleSeatOf(a)?.role, "driver", "the index follows a change of seat");
            assert.strictEqual(
              vehicleSeatOf(a),
              vehicleSeatOf(a),
              "and isn't rebuilt between changes",
            );

            await exitVehicle(v, b);
            assert.equal(v.system.occupants.length, 1);
            assert.isNull(vehicleSeatOf(b));
          } finally {
            await sheet.close();
            for (const x of [v, a, b, c]) await deleteTestActor(x);
          }
        });

        it("takes no Debuffs and can't be a combatant", async function () {
          const v = await createTestVehicle("objects");
          let combat;
          try {
            await addConditionToActor(v, "stunned");
            assert.notProperty(v.system, "conditions");
            combat = await Combat.create({});
            const created = await combat.createEmbeddedDocuments("Combatant", [{ actorId: v.id }]);
            assert.equal(created.length, 0);
            assert.equal(combat.combatants.size, 0);
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(v);
          }
        });

        it("the sheet: Vehicle, Cargo, Details and Description tabs; Cargo takes gear only", async function () {
          const v = await createTestVehicle("sheet");
          const skill = await Item.create({
            name: `Quench skill ${foundry.utils.randomID()}`,
            type: "skill",
          });
          const sheet = v.sheet;
          try {
            await sheet.render({ force: true });
            await waitFor(() => sheet.rendered);
            assert.instanceOf(sheet, CarlRPGActorSheet);
            const tabs = [...sheet.element.querySelectorAll("nav [data-tab]")].map(
              (el) => el.dataset.tab,
            );
            assert.sameMembers(tabs, ["abilities", "items", "pet", "description"]);
            assert.include(
              sheet.element.querySelector('nav [data-tab="abilities"]').textContent,
              game.i18n.localize("CARLRPG.Tab.Vehicle"),
            );
            assert.exists(sheet.element.querySelector(".carl-vehicle-header .carl-vehicle-move"));
            assert.exists(
              sheet.element.querySelector('section[data-tab="pet"] [name="system.move"]'),
              "base Move is set up on Details",
            );
            const { result } = await dropOnSheet(sheet, sheet.element, skill.toDragData());
            assert.isNull(result);
            assert.equal(v.items.size, 0);
          } finally {
            await sheet.close();
            await deleteTestActor(v);
            await skill.delete();
          }
        });
      });

      describe("Driving and combat rules (Stage 2)", function () {
        useQuenchTimeout(this);

        it("Move: the driver's Ranks add 5ft each, Nitrous doubles it, parked is 0", async function () {
          const ace = await crawlerWithSkill("ace", "Driving", 15);
          const v = await drivenVehicle(ace, { system: { move: 80 } });
          try {
            let s = vehicleStatus(v);
            assert.equal(s.driveBonus, 10, "Driving Rank 10 and 15");
            assert.equal(s.maxMove, 90);
            assert.equal(s.attackDifficulty, 10 + 18, "10 + Move ÷ 5, no Floor");
            assert.equal(s.evadeBuff, 9);
            assert.equal(s.ramDice, 5 + 9);
            await v.update({ "system.upgrades.nitrous.installed": true });
            await activateNitrous(v);
            assert.isFalse(v.system.upgrades.nitrous.installed, "one charge");
            s = vehicleStatus(v);
            assert.isTrue(s.nitrousActive);
            assert.equal(s.maxMove, 180);
            await v.update({ "system.parked": true });
            s = vehicleStatus(v);
            assert.equal(s.currentMove, 0);
            assert.equal(s.attackDifficulty, 10);
          } finally {
            await deleteTestActor(v);
            await deleteTestActor(ace);
          }
        });

        it("Driving and Chopper Pilot as before: Attacks at 5 / 10, Evade Advantage at Driving 10, stunts at 15", async function () {
          const has = (rows, id) => rows.some((r) => r.id === id);
          for (const [name, attackRank, evadeRank] of [
            ["Driving", 5, 10],
            ["Chopper Pilot", 10, null],
          ]) {
            const driver = await crawlerWithSkill(`book ${name}`, name, 0);
            const v = await drivenVehicle(driver, { system: { move: 80, driveSkill: name } });
            try {
              const skill = driver.items.find((i) => i.name === name);
              const sword = await createTestItem(driver, "skill", "sword", {
                system: { category: "attack" },
              });
              for (const rank of [0, 4, 5, 9, 10, 14, 15]) {
                await skill.update({ "system.rank": rank });
                const at = `${name} Rank ${rank}`;
                const moveRanks = name === "Driving" ? [10, 15] : [5, 15];
                assert.equal(
                  vehicleStatus(v).driveBonus,
                  moveRanks.filter((r) => rank >= r).length * 5,
                  `${at}: Move`,
                );
                assert.equal(
                  has(
                    collectVehicleRows(driver, "attack", { skillItem: sword }),
                    "vehicle-driving",
                  ),
                  rank < attackRank,
                  `${at}: Attack Disadvantage`,
                );
                assert.equal(
                  has(collectVehicleRows(driver, "evade"), "vehicle-driving-evade"),
                  evadeRank !== null && rank >= evadeRank,
                  `${at}: Evade Advantage`,
                );
                assert.equal(
                  has(collectVehicleRows(driver, "check", { skillItem: skill }), "vehicle-stunt"),
                  rank >= 15,
                  `${at}: stunt`,
                );
                assert.isTrue(
                  has(collectVehicleRows(driver, "evade"), "vehicle-driving"),
                  `${at}: the driver's own Evade keeps its Disadvantage`,
                );
              }
            } finally {
              await deleteTestActor(v);
              await deleteTestActor(driver);
            }
          }
        });

        it("a homebrew driving Skill: its tiers give the Move, Attacks, Evade and stunt Advantage at their Ranks", async function () {
          await withSetting("currentFloor", 1, async () => {
            const pilot = await crawlerWithSkill("mech", "Mech Pilot", 4, "dex", [
              { rankThreshold: 5, description: "", vehicleMove: 10, vehicleStuntAdvantage: true },
              {
                rankThreshold: 10,
                description: "",
                vehicleAttackOk: true,
                vehicleEvadeAdvantage: true,
              },
              { rankThreshold: 15, description: "", vehicleMove: 20 },
            ]);
            const v = await drivenVehicle(pilot, {
              system: { move: 50, driveSkill: "Mech Pilot" },
            });
            const cards = [];
            const hookId = Hooks.on("createChatMessage", (m) => {
              if (m.flags?.["carl-rpg"]?.driving?.vehicleUuid === v.uuid) cards.push(m);
            });
            try {
              const mech = pilot.items.find((i) => i.name === "Mech Pilot");
              const sword = await createTestItem(pilot, "skill", "sword", {
                system: { category: "attack" },
              });
              const has = (rows, id) => rows.some((r) => r.id === id);
              const perks = () => ({
                move: vehicleStatus(v).driveBonus,
                attackDisadvantage: has(
                  collectVehicleRows(pilot, "attack", { skillItem: sword }),
                  "vehicle-driving",
                ),
                evadeAdvantage: has(collectVehicleRows(pilot, "evade"), "vehicle-driving-evade"),
                stunt: has(
                  collectVehicleRows(pilot, "check", { skillItem: mech }),
                  "vehicle-stunt",
                ),
              });
              assert.deepEqual(
                perks(),
                { move: 0, attackDisadvantage: true, evadeAdvantage: false, stunt: false },
                "Rank 4",
              );
              assert.isFalse(
                has(collectVehicleRows(pilot, "check", { skillItem: mech }), "vehicle-driving"),
                "driving it is no Disadvantage",
              );
              await mech.update({ "system.rank": 5 });
              assert.deepEqual(
                perks(),
                { move: 10, attackDisadvantage: true, evadeAdvantage: false, stunt: true },
                "Rank 5",
              );
              await mech.update({ "system.rank": 10 });
              assert.deepEqual(
                perks(),
                { move: 10, attackDisadvantage: false, evadeAdvantage: true, stunt: true },
                "Rank 10",
              );
              await mech.update({ "system.rank": 15 });
              assert.deepEqual(
                perks(),
                { move: 30, attackDisadvantage: false, evadeAdvantage: true, stunt: true },
                "Rank 15",
              );
              assert.equal(vehicleStatus(v).maxMove, 80);

              // The Driving Check rolls it: d20 10 + Rank 15 + DEX 2 = 27 vs 12.
              const degree = await withPinnedDice(PIN_D20_MID, () =>
                rollDrivingCheck(v, { skipDialog: true }),
              );
              assert.equal(degree, "amazingSuccess", "rolled with Mech Pilot");
              assert.exists(
                collectVehicleRows(pilot, "check", { skillItem: mech }).find(
                  (r) => r.id === "vehicle-amazing",
                ),
              );

              // Another vehicle's Skill gives none of it.
              await v.update({ "system.driveSkill": "Driving" });
              assert.deepEqual(
                perks(),
                { move: 0, attackDisadvantage: true, evadeAdvantage: false, stunt: false },
                "not this vehicle's Skill",
              );
            } finally {
              Hooks.off("createChatMessage", hookId);
              for (const m of cards) await m.delete();
              await deleteTestActor(v);
              await deleteTestActor(pilot);
            }
          });
        });

        it("a mounted weapon (its box, homebrew too) spares the driver's Disadvantage; an unmarked one doesn't", async function () {
          const driver = await crawlerWithSkill("joust", "Driving", 0);
          const v = await drivenVehicle(driver, { system: { move: 50 } });
          try {
            const pole = await createTestItem(driver, "skill", "Jousting Pole", {
              system: { category: "attack", mounted: true },
            });
            const lance = await createTestItem(driver, "skill", "Lance", {
              name: "Lance",
              system: { category: "attack" },
            });
            const has = (rows, id) => rows.some((r) => r.id === id);
            assert.isFalse(
              has(collectVehicleRows(driver, "attack", { skillItem: pole }), "vehicle-driving"),
              "mounted",
            );
            assert.isTrue(
              has(collectVehicleRows(driver, "attack", { skillItem: lance }), "vehicle-driving"),
              "named Lance, box unticked",
            );
            assert.isTrue(
              has(collectVehicleRows(driver, "check", { skillItem: pole }), "vehicle-driving"),
              "only its Attacks",
            );
          } finally {
            await deleteTestActor(v);
            await deleteTestActor(driver);
          }
        });

        it("an old driving-Skill key reads as the Skill's name; a blank one can't be driven", async function () {
          const model = CONFIG.Actor.dataModels.vehicle;
          assert.equal(model.migrateData({ driveSkill: "driving" }).driveSkill, "Driving");
          assert.equal(
            model.migrateData({ driveSkill: "chopperPilot" }).driveSkill,
            "Chopper Pilot",
          );
          assert.equal(model.migrateData({ driveSkill: "Mech Pilot" }).driveSkill, "Mech Pilot");
          const old = await createTestVehicle("old key", {
            system: { driveSkill: "chopperPilot" },
          });
          const driver = await crawlerWithSkill("blank", "Driving", 5);
          const v = await drivenVehicle(driver, { system: { driveSkill: "" } });
          try {
            assert.equal(old.system.driveSkill, "Chopper Pilot");
            assert.isNull(
              await rollDrivingCheck(v, { skipDialog: true }),
              "no Skill named: no Check",
            );
          } finally {
            await deleteTestActor(old);
            await deleteTestActor(v);
            await deleteTestActor(driver);
          }
        });

        it("Table 6: every result's Move, and Shock Absorbers step a Fail up", function () {
          assert.equal(tableSixMove(80, "criticalHit", "move"), 120);
          assert.equal(tableSixMove(80, "criticalHit", "favor"), 80);
          assert.equal(tableSixMove(80, "amazingSuccess"), 80);
          assert.equal(tableSixMove(80, "standardSuccess"), 80);
          assert.equal(tableSixMove(80, "nearMissFail"), 75);
          assert.equal(tableSixMove(80, "standardFail"), 40);
          assert.equal(tableSixMove(80, "majorFail"), 40);
          assert.equal(tableSixMove(80, "criticalFail"), 0);
          assert.equal(tableSixMove(80, ""), 80);
          assert.equal(drivingOutcome("majorFail").damageSlots, 1);
          assert.equal(drivingOutcome("criticalFail").damageSlots, 3);
          assert.equal(stepUpDegree("majorFail"), "standardFail");
          assert.equal(stepUpDegree("criticalFail"), "majorFail");
        });

        it("a Driving Check records this round's result; an Amazing Success gives Advantage on the next one", async function () {
          await withSetting("currentFloor", 1, async () => {
            const driver = await crawlerWithSkill("driver", "Driving", 10);
            const v = await drivenVehicle(driver, { system: { move: 80 } });
            try {
              // d20 10 + Rank 10 + DEX +2 = 22 vs 12: Amazing Success.
              const degree = await withPinnedDice(PIN_D20_MID, () =>
                rollDrivingCheck(v, { skipDialog: true }),
              );
              assert.equal(degree, "amazingSuccess");
              assert.equal(v.system.round.degree, "amazingSuccess");
              assert.isTrue(v.system.nextCheckAdvantage);
              assert.isFalse(v.system.parked);
              const driving = driver.items.find((i) => i.name === "Driving");
              const rows = collectVehicleRows(driver, "check", { skillItem: driving });
              assert.exists(rows.find((r) => r.id === "vehicle-amazing"));

              await commitDrivingRound(v, "standardFail");
              assert.isFalse(v.system.nextCheckAdvantage);
              assert.equal(vehicleStatus(v).currentMove, 40 + 2, "half of (80 + 5 from Rank 10)");
            } finally {
              await deleteTestActor(v);
              await deleteTestActor(driver);
            }
          });
        });

        it("only the card whose result the vehicle has this round can change it", async function () {
          await withSetting("currentFloor", 1, async () => {
            const driver = await crawlerWithSkill("stale", "Driving", 10);
            const v = await drivenVehicle(driver, { system: { move: 80 } });
            const cards = [];
            const hookId = Hooks.on("createChatMessage", (m) => {
              if (m.flags?.["carl-rpg"]?.driving?.vehicleUuid === v.uuid) cards.push(m);
            });
            try {
              const driving = (m) => m.flags["carl-rpg"].driving;
              await withPinnedDice(PIN_D20_MID, () => rollDrivingCheck(v, { skipDialog: true }));
              await waitFor(() => cards.length === 1);
              assert.isTrue(drivingCardCurrent(driving(cards[0])), "the latest Check's card");
              assert.equal(v.system.round.checkId, driving(cards[0]).checkId);

              await withPinnedDice(PIN_D20_MID, () => rollDrivingCheck(v, { skipDialog: true }));
              await waitFor(() => cards.length === 2);
              assert.isFalse(drivingCardCurrent(driving(cards[0])), "replaced by a later Check");
              assert.isTrue(drivingCardCurrent(driving(cards[1])));

              await commitDrivingRound(v, "standardFail");
              assert.isFalse(
                drivingCardCurrent(driving(cards[1])),
                "a result set by hand replaces it too",
              );
              assert.isFalse(
                drivingCardCurrent({ mode: "table6", vehicleUuid: v.uuid }),
                "an old card with no Check id",
              );
              assert.isTrue(
                drivingCardCurrent({ mode: "stop", vehicleUuid: v.uuid }),
                "a stopping card never sets the round",
              );
            } finally {
              Hooks.off("createChatMessage", hookId);
              for (const m of cards) await m.delete();
              await deleteTestActor(v);
              await deleteTestActor(driver);
            }
          });
        });

        it("a new fight round redraws the Driving cards on screen, and only those", async function () {
          await withSetting("currentFloor", 1, async () => {
            const driver = await crawlerWithSkill("redraw", "Driving", 10);
            const v = await drivenVehicle(driver, { system: { move: 80 } });
            const cards = [];
            const hookId = Hooks.on("createChatMessage", (m) => {
              if (m.flags?.["carl-rpg"]?.driving?.vehicleUuid === v.uuid) cards.push(m);
            });
            const updateMessage = ui.chat.updateMessage;
            const redrawn = [];
            try {
              for (let i = 0; i < 2; i++)
                await withPinnedDice(PIN_D20_MID, () => rollDrivingCheck(v, { skipDialog: true }));
              await waitFor(() => cards.length === 2);
              const drawn = (m) => document.querySelectorAll(`[data-message-id="${m.id}"]`);
              await waitFor(() => drawn(cards[0]).length && drawn(cards[1]).length, {
                message: "the cards were never drawn",
              });
              // The first card as if scrolled out of the log.
              for (const li of drawn(cards[0])) li.remove();

              ui.chat.updateMessage = function (message, ...rest) {
                redrawn.push(message.id);
                return updateMessage.call(this, message, ...rest);
              };
              Hooks.callAll("updateCombat", { id: "fake" }, { round: 2 }, {}, game.user.id);
              assert.include(redrawn, cards[1].id, "the card on screen is redrawn");
              assert.notInclude(redrawn, cards[0].id, "a card not on screen isn't added back");
            } finally {
              delete ui.chat.updateMessage;
              Hooks.off("createChatMessage", hookId);
              for (const m of cards) await m.delete();
              await deleteTestActor(v);
              await deleteTestActor(driver);
            }
          });
        });

        it("the driver's Disadvantage: not on driving, built-in weapons or (from Driving Rank 5) Attacks; not for passengers", async function () {
          const driver = await crawlerWithSkill("rows", "Driving", 0);
          const passenger = await createTestCharacter("rows passenger");
          const v = await drivenVehicle(driver, { system: { move: 50 } });
          try {
            await v.update({
              "system.occupants": [
                ...v.system.toObject().occupants,
                { uuid: passenger.uuid, role: "passenger", name: passenger.name },
              ],
            });
            const driving = driver.items.find((i) => i.name === "Driving");
            const sword = await createTestItem(driver, "skill", "sword", {
              system: { category: "attack" },
            });
            const has = (rows, id) => rows.some((r) => r.id === id);
            assert.isTrue(
              has(collectVehicleRows(driver, "check"), "vehicle-driving"),
              "a Stat Check",
            );
            assert.isFalse(
              has(collectVehicleRows(driver, "check", { skillItem: driving }), "vehicle-driving"),
              "driving itself",
            );
            assert.isTrue(
              has(collectVehicleRows(driver, "attack", { skillItem: sword }), "vehicle-driving"),
            );
            assert.isFalse(
              has(
                collectVehicleRows(driver, "attack", { skillItem: sword, builtIn: true }),
                "vehicle-driving",
              ),
            );
            await driving.update({ "system.rank": 5 });
            assert.isFalse(
              has(collectVehicleRows(driver, "attack", { skillItem: sword }), "vehicle-driving"),
              "Driving Rank 5",
            );
            assert.isTrue(
              has(collectVehicleRows(driver, "check"), "vehicle-driving"),
              "still on other Checks",
            );
            assert.isFalse(
              has(collectVehicleRows(passenger, "check"), "vehicle-driving"),
              "passengers act freely",
            );
            const evade = collectVehicleRows(passenger, "evade").find(
              (r) => r.id === "vehicle-evade-buff",
            );
            assert.equal(evade?.value, 5, "Move 50 ÷ 10");
            await v.update({ "system.parked": true });
            assert.isFalse(
              has(collectVehicleRows(driver, "check"), "vehicle-driving"),
              "a parked car isn't driven",
            );
          } finally {
            await deleteTestActor(v);
            await deleteTestActor(driver);
            await deleteTestActor(passenger);
          }
        });

        it("attacking a vehicle: a crawler's Difficulty has no Floor; a Mob hits if its to-hit reaches it", async function () {
          await withSetting("currentFloor", 6, async () => {
            const v = await createTestVehicle("target", { system: { move: 80, parked: false } });
            try {
              const parts = attackDifficultyParts(v, 6);
              assert.equal(parts.base, 26);
              assert.equal(parts.rows[0]?.value, -16, "head-on drops the Move part");
              const target = { uuid: v.uuid, actor: v };
              assert.isFalse(mobAttackRow({ id: "t0", target, base: 20, ownRows: [] }).row.hit);
              const hit = mobAttackRow({ id: "t0", target, base: 30, ownRows: [] }).row;
              assert.isTrue(hit.hit);
              assert.isFalse(hit.isCharacter, "no Roll Evade for a vehicle");
            } finally {
              await deleteTestActor(v);
            }
          });
        });

        it("a Near Miss on an occupant hits the vehicle instead", async function () {
          const rider = await createTestCharacter("occupant");
          const v = await createTestVehicle("shield");
          try {
            await v.update({
              "system.occupants": [{ uuid: rider.uuid, role: "passenger", name: rider.name }],
            });
            const row = crawlerAttackRow({
              id: "t0",
              target: { uuid: rider.uuid, actor: rider },
              difficulty: 15,
              attackTotal: 14,
              naturalRoll: 10,
            });
            assert.isTrue(row.hit);
            assert.equal(row.redirectUuid, v.uuid);
            assert.isTrue(
              row.isCharacter,
              "still a crawler (a reroll rebuilds from this) - redirectUuid hides Roll Evade",
            );
            const miss = crawlerAttackRow({
              id: "t0",
              target: { uuid: rider.uuid, actor: rider },
              difficulty: 15,
              attackTotal: 10,
              naturalRoll: 10,
            });
            assert.isFalse(miss.hit);
            assert.isNull(miss.redirectUuid);
          } finally {
            await deleteTestActor(v);
            await deleteTestActor(rider);
          }
        });
      });

      describe("Ramming and exploding (Stage 3)", function () {
        useQuenchTimeout(this);

        it("ram dice: (Size + Move ÷ 10)d6 - Size 4 at Move 50 is 9d6; + Floor with a Ram Plate", async function () {
          const driver = await createTestCharacter("rammer");
          const v = await drivenVehicle(driver, { system: { size: 4, move: 50 } });
          try {
            assert.equal(ramFormula(v), "9d6");
            await v.update({ "system.upgrades.ramPlate": true });
            assert.equal(ramFormula(v), "9d6 + @floor");
          } finally {
            await deleteTestActor(v);
            await deleteTestActor(driver);
          }
        });

        it("a ram hits its target, recoils on the rammer (half its damage, half its Move) and passes half to its occupants", async function () {
          await withSetting("currentFloor", 1, async () => {
            const driver = await crawlerWithSkill("ram driver", "Driving", 10);
            const passenger = await createTestCharacter("ram passenger");
            const target = await createTestMob("ram target", { system: { size: "Medium (4)" } });
            const v = await drivenVehicle(driver, { system: { size: 4, move: 50, dr: 2 } });
            try {
              await v.update({
                "system.occupants": [
                  ...v.system.toObject().occupants,
                  { uuid: passenger.uuid, role: "passenger", name: passenger.name },
                ],
              });
              // d20 10 + Driving 10 + DEX 2 = 22 vs the Mob's Evade 10 + 1 + F 1.
              const message = await withFakeTargets([{ actor: target }], () =>
                withPinnedDice(PIN_D20_MID, () => rollRam(v, { skipDialog: true })),
              );
              assert.exists(message, "the ram was rolled");
              const flags = () => game.messages.get(message.id).flags["carl-rpg"];
              const ram = flags().ram;
              assert.equal(
                message.rolls[1].formula,
                "9d6",
                "Size 4 + (50 + 5 from Driving Rank 10) ÷ 10",
              );
              const rows = Object.values(flags().targetRows);
              const hit = rows.find((r) => r.role === "target");
              const recoil = rows.find((r) => r.role === "recoil");
              assert.isTrue(hit.hit);
              assert.isTrue(recoil.hit);
              assert.isFalse(ram.larger, "same Size: not larger");
              assert.equal(recoil.damageOverride.bludgeoning, Math.floor(ram.raw / 2));

              const hbBefore = target.system.hb.value;
              await applyRow(game.messages.get(message.id), hit);
              assert.isBelow(target.system.hb.value, hbBefore, "the target takes the ram");

              await applyRow(game.messages.get(message.id), recoil);
              assert.equal(v.system.round.ramFactor, 0.5, "the rammer halves its Move");
              const share = Math.max(0, Math.floor(Math.floor(ram.raw / 2) / 2) - 2);
              const occupantRows = Object.values(flags().targetRows).filter(
                (r) => r.role === "occupant",
              );
              if (share > 0) {
                assert.equal(occupantRows.length, 2, "one row per occupant");
                assert.sameMembers(
                  occupantRows.map((r) => r.id),
                  [childRowId(recoil.id, 0), childRowId(recoil.id, 1)],
                );
                assert.isTrue(occupantRows.every((r) => r.damageOverride.bludgeoning === share));
              } else {
                assert.equal(occupantRows.length, 0);
              }
            } finally {
              for (const x of [v, driver, passenger, target]) await deleteTestActor(x);
            }
          });
        });

        it("rows added by an applied row get ids fixed by it: distinct per parent, numeric, after their parents", function () {
          assert.equal(childRowId("t0", 0), "t100");
          assert.equal(childRowId("t0", 1), "t101");
          assert.equal(childRowId("t1", 0), "t200");
          // Two vehicle rows applied at once (two users, or a player through
          // the GM) add rows that can't collide.
          const fromTarget = [0, 1, 2].map((i) => childRowId("t0", i));
          const fromRecoil = [0, 1, 2].map((i) => childRowId("t1", i));
          assert.lengthOf(new Set([...fromTarget, ...fromRecoil]), 6);
          const rows = Object.fromEntries(
            ["t1", "t0", ...fromRecoil, ...fromTarget].map((id) => [id, { id }]),
          );
          assert.deepEqual(
            activeRows(rows).map((r) => r.id),
            ["t0", "t1", ...fromTarget, ...fromRecoil],
          );
        });

        it("at 0 HB it explodes once: one row per occupant, no Evade, and everyone is out", async function () {
          const a = await createTestCharacter("blast a");
          const b = await createTestMob("blast b");
          const v = await createTestVehicle("boom", { system: { size: 3 } });
          try {
            await v.update({
              "system.occupants": [
                { uuid: a.uuid, role: "driver", name: a.name },
                { uuid: b.uuid, role: "passenger", name: b.name },
              ],
            });
            const before = game.messages.size;
            await v.update({ "system.hb.value": 0 });
            await waitFor(
              () =>
                game.messages.contents
                  .slice(before)
                  .some((m) => m.getFlag("carl-rpg", "explosion")),
              { message: "no explosion card" },
            );
            const card = game.messages.contents
              .slice(before)
              .find((m) => m.getFlag("carl-rpg", "explosion"));
            const rows = Object.values(card.getFlag("carl-rpg", "targetRows"));
            assert.equal(rows.length, 2);
            assert.isTrue(rows.every((r) => r.hit && !r.isCharacter));
            assert.exists(card.getFlag("carl-rpg", "damageByType").fire);
            await waitFor(() => v.system.occupants.length === 0);
            assert.isTrue(shouldBeDefeated(v));
            await v.update({ "system.hb.value": 0, "system.model": "wreck" });
            await settle(150);
            const blasts = game.messages.contents
              .slice(before)
              .filter((m) => m.getFlag("carl-rpg", "explosion"));
            assert.equal(blasts.length, 1, "only once");
          } finally {
            for (const x of [v, a, b]) await deleteTestActor(x);
          }
        });
      });

      describe("Built-in weapons and upgrades (Stage 4)", function () {
        useQuenchTimeout(this);

        it("a built-in weapon is fired with the gunner's Rank and Stat, and spares the driver's Disadvantage", async function () {
          const gunner = await crawlerWithSkill("gunner", "Aiming", 4, "dex");
          const v = await drivenVehicle(gunner);
          try {
            await v.update({
              "system.attacks": [
                {
                  name: "Turret",
                  damage: "4d12",
                  damageType: "piercing",
                  range: "100ft",
                  skill: "Aiming",
                  stat: "dex",
                },
              ],
            });
            const fire = buildWeaponFire(v, 0, gunner);
            assert.equal(fire.item.system.rank, 4);
            assert.equal(fire.item.system.governingStat, "dex");
            assert.equal(fire.item.system.baseDamage.dice, "4d12");
            assert.deepEqual(fire.castAs.builtIn, { vehicleUuid: v.uuid, index: 0 });
            const rows = collectVehicleRows(gunner, "attack", {
              skillItem: fire.item,
              builtIn: true,
            });
            assert.notExists(rows.find((r) => r.id === "vehicle-driving"));
          } finally {
            await deleteTestActor(v);
            await deleteTestActor(gunner);
          }
        });

        it('a gunner\'s worn "+2 Handgun" gear raises the Rank a built-in gun fires at', async function () {
          const gunner = await crawlerWithSkill("bonus gunner", "Handgun", 3, "dex");
          const v = await drivenVehicle(gunner);
          try {
            await v.update({
              "system.attacks": [
                {
                  name: "Gun",
                  damage: "2d6",
                  damageType: "piercing",
                  range: "50ft",
                  skill: "Handgun",
                  stat: "dex",
                },
              ],
            });
            const sight = await createTestItem(gunner, "item", "Gun Sight", {
              name: "Gun Sight",
              system: {
                slots: ["head"],
                changes: [{ targetType: "skillRank", target: "Handgun", mode: "add", value: "2" }],
              },
            });
            assert.equal(
              buildWeaponFire(v, 0, gunner).item.system.rank,
              3,
              "carried, it gives nothing",
            );
            await assignItemToSlot(gunner, { slotType: "gear", slotKey: "head" }, sight);
            const fire = buildWeaponFire(v, 0, gunner);
            assert.equal(fire.item.system.rank, 5, "worn: Rank 3 + 2");
            assert.equal(fire.castAs.rank, 5);
          } finally {
            await deleteTestActor(v);
            await deleteTestActor(gunner);
          }
        });
      });

      describe("the compendium (needs `npm run build:packs`)", function () {
        useQuenchTimeout(this);

        it("Driving's and Chopper Pilot's tiers carry their vehicle perks; Lance is mounted", async function () {
          const pack = game.packs.get("carl-rpg.skills-and-spells");
          assert.exists(pack);
          const doc = async (name) => {
            const entry = pack.index.find((e) => e.name === name);
            return entry ? pack.getDocument(entry._id) : null;
          };
          const perks = (u) => ({
            rank: u.rankThreshold,
            move: u.vehicleMove,
            attackOk: u.vehicleAttackOk,
            evade: u.vehicleEvadeAdvantage,
            stunt: u.vehicleStuntAdvantage,
          });
          const tiers = async (name) =>
            (await doc(name))?.system.upgrades.map(perks).sort((a, b) => a.rank - b.rank);
          assert.deepEqual(await tiers("Driving"), [
            { rank: 5, move: 0, attackOk: true, evade: false, stunt: false },
            { rank: 10, move: 5, attackOk: false, evade: true, stunt: false },
            { rank: 15, move: 5, attackOk: false, evade: false, stunt: true },
          ]);
          assert.deepEqual(await tiers("Chopper Pilot"), [
            { rank: 5, move: 5, attackOk: false, evade: false, stunt: false },
            { rank: 10, move: 0, attackOk: true, evade: false, stunt: false },
            { rank: 15, move: 5, attackOk: false, evade: false, stunt: true },
          ]);
          assert.isTrue((await doc("Lance"))?.system.mounted);
        });
      });
    },
    { displayName: "CarlRPG: Vehicles" },
  );
}
