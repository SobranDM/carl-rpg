/**
 * Timers and cooldowns (docs/rules-fixes.md B, rulings Q3/Q4): the text
 * parser (module/helpers/timer-text.mjs), timed Debuffs on the world clock
 * (conditions.mjs, expiry.mjs), timed toggled Spells (spell-timers.mjs) and
 * cooldowns - their start, chip, warn-and-ask, the "Used before cooldown."
 * note, once per round and once per scene with New scene
 * (cooldowns.mjs).
 *
 * The world clock: long durations are checked by their `expiresAt`/`endsAt`
 * and by calling the sweep's own per-actor function with a later time, so
 * the real clock never jumps minutes ahead (that would end the world's real
 * timed effects for good). The one real advance (a "5 seconds" Spell) and
 * the combat rounds are wound back by the same amount afterwards.
 */
import CarlDice from "../../dice/dice.mjs";
import { parseTimerText, resolveTimerSeconds } from "../../helpers/timer-text.mjs";
import { addConditionToActor } from "../../helpers/conditions.mjs";
import { dropExpiredConditions } from "../../helpers/expiry.mjs";
import { processCombatEnd } from "../../helpers/round-end.mjs";
import { SPELL_TIMER_PATH, expireSpellTimers, spellTimerFor } from "../../helpers/spell-timers.mjs";
import {
  SCENE_EPOCH_SETTING, activeCooldown, cooldownChipHtml, cooldownLabel, sceneEpoch, startNewScene,
} from "../../helpers/cooldowns.mjs";
import { hotlistRows } from "../../helpers/hotlist.mjs";
import CarlToolbox from "../../apps/gm-toolbox.mjs";
import {
  createTestCharacter, createTestCombat, createTestItem, deleteTestActor, deleteTestCombat, pressDialog,
  useQuenchTimeout, waitFor, withDialog, withPinnedDice, PIN_D20_MID,
} from "../helpers.mjs";

const CONFIRM = "carl-cooldown-confirm";
const cooldownOf = (item) => foundry.utils.getProperty(item, "flags.carl-rpg.cooldown") ?? null;
const timerOf = (item) => foundry.utils.getProperty(item, SPELL_TIMER_PATH) ?? null;
const keys = (actor) => (actor.system.conditions ?? []).map((c) => c.key);
const earlyText = () => game.i18n.localize("CARLRPG.Cooldown.UsedEarly");

/** Move the world clock and put it back afterwards. */
async function withClockMoved(seconds, fn) {
  const before = game.time.worldTime;
  try {
    await game.time.advance(seconds);
    await waitFor(() => game.time.worldTime >= before + seconds, { message: "world time never moved" });
    return await fn();
  } finally {
    const back = before - game.time.worldTime;
    if (back) await game.time.advance(back);
  }
}

/** Run a fight and wind the clock back to where it was once it's over. */
async function inFight(actor, fn) {
  const before = game.time.worldTime;
  const { combat } = await createTestCombat(actor);
  try {
    await combat.startCombat();
    return await fn(combat);
  } finally {
    await deleteTestCombat(combat);
    const back = before - game.time.worldTime;
    if (back) await game.time.advance(back);
  }
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.timers",
    (context) => {
      const { describe, it, assert } = context;

      describe("timer-text: reading durations and cooldowns", function () {
        // [text, expected fields, seconds at Rank 3 / Intelligence 12]
        const CASES = [
          // Cooldowns
          ["5 minutes", { seconds: 300 }, 300],
          ["Once per round.", { perRound: true }, null],
          ["Once per round", { perRound: true }, null],
          ["5 hours", { seconds: 18000 }, 18000],
          ["15 minutes", { seconds: 900 }, 900],
          ["Once per scene", { perScene: true }, null],
          ["30 hours", { seconds: 108000 }, 108000],
          ["10 minutes", { seconds: 600 }, 600],
          ["1 hour, once per 50ft-square area", { seconds: 3600, partial: true }, 3600],
          // Durations
          ["2 rounds", { rounds: 2 }, 20],
          ["2 minutes", { seconds: 120 }, 120],
          ["Until you enter a saferoom or descend to a new floor.", { manual: true }, null],
          ["Until the end of two full rounds of combat or 20 seconds", { rounds: 2, seconds: 20 }, 20],
          ["Until the end of the combat or 5 minutes.", { untilCombatEnd: true, seconds: 300 }, 300],
          ["Until the end of combat or 5 minutes.", { untilCombatEnd: true, seconds: 300 }, 300],
          ["A number of seconds equal to your Intelligence.", { perInt: 1 }, 12],
          ["A number of seconds equal to the caster's Intelligence x3.", { perInt: 3 }, 36],
          ["5 seconds", { seconds: 5 }, 5],
          ["5 minutes + 1 minute per Rank", { seconds: 300, perRank: 60 }, 480],
          ["3 rounds", { rounds: 3 }, 30],
          ["2 minutes, or until the caster chooses to end the effect.", { seconds: 120, casterMayEnd: true }, 120],
          ["1 round", { rounds: 1 }, 10],
          ["1 minute", { seconds: 60 }, 60],
          ["1 minute per Rank", { perRank: 60 }, 180],
        ];
        const DEFAULTS = {
          seconds: null, rounds: null, perRank: null, perInt: null,
          untilCombatEnd: false, perScene: false, perRound: false, casterMayEnd: false, partial: false, manual: false,
        };

        for (const [text, fields, seconds] of CASES) {
          it(`reads "${text}"`, function () {
            const parsed = parseTimerText(text);
            assert.deepEqual(parsed, { ...DEFAULTS, ...fields, text });
            assert.strictEqual(resolveTimerSeconds(parsed, { rank: 3, intelligence: 12 }), seconds);
          });
        }

        it("blank text is no timer at all; other words are manual", function () {
          assert.isNull(parseTimerText(""));
          assert.isNull(parseTimerText("   "));
          assert.isTrue(parseTimerText("Once per Floor").manual);
        });

        it("'Until the end of the combat' alone ends with the fight, with no time of its own", function () {
          const parsed = parseTimerText("Until the end of the combat.");
          assert.isTrue(parsed.untilCombatEnd);
          assert.isFalse(parsed.manual);
          assert.isNull(resolveTimerSeconds(parsed));
        });

        it("every cooldown and duration in the compendium reads as a time, a marker or manual", async function () {
          const texts = new Set();
          for (const pack of game.packs.filter((p) => p.documentName === "Item" && p.metadata.packageName === "carl-rpg")) {
            const index = await pack.getIndex({ fields: ["system.cooldown", "system.duration"] });
            for (const entry of index) {
              for (const text of [entry.system?.cooldown, entry.system?.duration]) if (text) texts.add(text);
            }
          }
          const listed = new Set(CASES.map(([text]) => text));
          const unlisted = [...texts].filter((t) => !listed.has(t));
          assert.isEmpty(unlisted, `compendium texts with no test case: ${unlisted.join(" | ")}`);
        });
      });

      describe("Debuffs on the world clock", function () {
        useQuenchTimeout(this);

        it("Shit-Faced (10 minutes) and Sore as Shit (1 hour) gained outside a fight carry an end time", async function () {
          const actor = await createTestCharacter("clocked");
          try {
            const now = game.time.worldTime;
            await addConditionToActor(actor, "shitFaced");
            await addConditionToActor(actor, "soreAsShit");
            const byKey = Object.fromEntries(actor.system.conditions.map((c) => [c.key, c]));
            assert.approximately(byKey.shitFaced.expiresAt, now + 600, 1);
            assert.approximately(byKey.soreAsShit.expiresAt, now + 3600, 1);
            assert.isNull(byKey.shitFaced.remaining, "the Conditions tab shows its end time instead");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("the expiry sweep ends Shit-Faced when the clock reaches its 10 minutes, not before", async function () {
          const actor = await createTestCharacter("sweep");
          try {
            await addConditionToActor(actor, "shitFaced");
            const ends = actor.system.conditions[0].expiresAt;
            assert.deepEqual(await dropExpiredConditions(actor, ends - 1), []);
            assert.include(keys(actor), "shitFaced");
            assert.lengthOf(await dropExpiredConditions(actor, ends), 1);
            assert.notInclude(keys(actor), "shitFaced");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a round-counted Debuff keeps counting rounds (no end time)", async function () {
          const actor = await createTestCharacter("rounds");
          try {
            await addConditionToActor(actor, "blinded");
            const [entry] = actor.system.conditions;
            assert.equal(entry.remaining, 2);
            assert.notExists(entry.expiresAt);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("'until the end of the combat or 5 minutes' (Burned): an end time, and still ends with the combat", async function () {
          const actor = await createTestCharacter("burning");
          const { combat } = await createTestCombat(actor);
          try {
            const now = game.time.worldTime;
            await addConditionToActor(actor, "burned");
            assert.approximately(actor.system.conditions[0].expiresAt, now + 300, 1);
            await processCombatEnd(combat);
            assert.notInclude(keys(actor), "burned");
          } finally {
            await deleteTestCombat(combat);
            await deleteTestActor(actor);
          }
        });
      });

      describe("timed toggled Spells", function () {
        useQuenchTimeout(this);

        const toggled = (actor, duration, extra = {}) => createTestItem(actor, "spell", "Timed", {
          system: { isToggled: true, active: false, rank: 1, manaCost: 0, duration, ...extra },
        });

        it("switching on stamps its end time - per Rank and Intelligence worked out at the cast", async function () {
          const actor = await createTestCharacter("caster", { system: { stats: { int: { value: 5 } } } });
          try {
            const bang = await toggled(actor, "5 minutes + 1 minute per Rank", { rank: 3 });
            const water = await toggled(actor, "A number of seconds equal to the caster's Intelligence x3.");
            const rounds = await toggled(actor, "2 rounds");
            const torch = await toggled(actor, "Until you enter a saferoom or descend to a new floor.");
            const now = game.time.worldTime;
            const int = actor.system.stats.int.effective ?? actor.system.stats.int.value;
            assert.approximately(spellTimerFor(actor, bang, { now, fight: null }).endsAt, now + 300 + 60 * 3, 0.001);
            assert.approximately(spellTimerFor(actor, water, { now, fight: null }).endsAt, now + 3 * int, 0.001);
            assert.approximately(spellTimerFor(actor, rounds, { now, fight: null }).endsAt, now + 20, 0.001);
            assert.isNull(spellTimerFor(actor, torch, { now, fight: null }), "not a time: switched off by hand");

            await CarlDice.rollToggleSpell(actor, bang);
            assert.isTrue(bang.system.active);
            assert.approximately(timerOf(bang).endsAt, game.time.worldTime + 480, 1);
            await CarlDice.rollToggleSpell(actor, bang);
            assert.isFalse(bang.system.active);
            assert.isNull(timerOf(bang), "off by hand clears its timer");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a '5 seconds' Spell switches itself off when the clock moves past it (clock wound back after)", async function () {
          const actor = await createTestCharacter("shell");
          try {
            const shell = await toggled(actor, "5 seconds");
            await CarlDice.rollToggleSpell(actor, shell);
            assert.isTrue(shell.system.active);
            await withClockMoved(10, () => waitFor(() => !actor.items.get(shell.id).system.active, {
              message: "the sweep never switched it off",
            }));
            assert.isNull(timerOf(actor.items.get(shell.id)));
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a longer one ends through the sweep's own function at its end time, not before", async function () {
          const actor = await createTestCharacter("oak");
          try {
            const oak = await toggled(actor, "2 minutes");
            await CarlDice.rollToggleSpell(actor, oak);
            const ends = timerOf(oak).endsAt;
            assert.deepEqual(await expireSpellTimers(actor, ends - 1), []);
            assert.isTrue(oak.system.active);
            assert.deepEqual(await expireSpellTimers(actor, ends), [oak.name]);
            assert.isFalse(oak.system.active);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("'until the end of the combat or 5 minutes': ends with the fight it was cast in, or on the clock outside one", async function () {
          const actor = await createTestCharacter("paw");
          try {
            const paw = await toggled(actor, "Until the end of the combat or 5 minutes.");
            await inFight(actor, async (combat) => {
              await CarlDice.rollToggleSpell(actor, paw);
              assert.isTrue(paw.system.active);
              assert.equal(timerOf(paw).combatId, combat.id);
              assert.approximately(timerOf(paw).endsAt, game.time.worldTime + 300, 1);
              await processCombatEnd(combat);
              assert.isFalse(actor.items.get(paw.id).system.active, "the combat ended first");
            });
            await CarlDice.rollToggleSpell(actor, paw);
            assert.isNull(timerOf(paw).combatId, "outside a fight, only the 5 minutes");
            assert.isFalse((await expireSpellTimers(actor, timerOf(paw).endsAt - 1)).length > 0);
            await expireSpellTimers(actor, timerOf(paw).endsAt);
            assert.isFalse(paw.system.active, "the 5 minutes ran out first");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("cooldowns", function () {
        useQuenchTimeout(this);

        it("using a Skill starts its cooldown; its row and the Hotlist show the chip", async function () {
          const actor = await createTestCharacter("cooler");
          try {
            const skill = await createTestItem(actor, "skill", "Ping", { system: { rank: 1, cooldown: "5 minutes" } });
            const spell = await createTestItem(actor, "spell", "Wisp", { system: { rank: 1, manaCost: 0, cooldown: "15 minutes" } });
            await actor.update({ "system.hotlist": [spell.id] });
            const now = game.time.worldTime;
            await withPinnedDice(PIN_D20_MID, async () => {
              await CarlDice.rollSkillCheck(actor, skill, { skipDialog: true });
              await CarlDice.rollSkillCheck(actor, spell, { skipDialog: true });
            });
            assert.equal(cooldownOf(skill).kind, "time");
            assert.approximately(cooldownOf(skill).endsAt, now + 300, 1);
            assert.equal(cooldownLabel(activeCooldown(skill)), game.i18n.format("CARLRPG.Cooldown.Chip.Minutes", { amount: 5 }));
            assert.include(cooldownChipHtml(skill), "carl-cooldown-chip");

            const row = hotlistRows(actor).find((r) => r.itemId === spell.id);
            assert.equal(row.cooldown, game.i18n.format("CARLRPG.Cooldown.Chip.Minutes", { amount: 15 }));

            await actor.sheet.render({ force: true });
            try {
              await waitFor(() => actor.sheet.element?.querySelector(`[data-item-id="${skill.id}"] .carl-cooldown-chip`), {
                message: "the Skill row shows no chip",
              });
              const chip = actor.sheet.element.querySelector(`[data-item-id="${skill.id}"] .carl-cooldown-chip`);
              assert.include(chip.textContent, game.i18n.format("CARLRPG.Cooldown.Chip.Minutes", { amount: 5 }));
              assert.exists(actor.sheet.element.querySelector(`.carl-hotlist-row[data-item-id="${spell.id}"] .carl-cooldown-chip`));
            } finally {
              await actor.sheet.close();
            }
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("used again while cooling down: refusing at the prompt spends nothing", async function () {
          const actor = await createTestCharacter("refuser", { system: { stats: { int: { value: 6 } } } });
          try {
            const spell = await createTestItem(actor, "spell", "Zap", { system: { rank: 1, manaCost: 2, cooldown: "5 minutes", governingStat: "int" } });
            await actor.update({ "system.mana.value": actor.system.mana.max });
            await withPinnedDice(PIN_D20_MID, () => CarlDice.rollSkillCheck(actor, spell, { skipDialog: true }));
            const mana = actor.system.mana.value;
            const started = cooldownOf(spell);
            const messages = game.messages.size;

            const result = await withDialog(() => CarlDice.rollSkillCheck(actor, spell, { skipDialog: true }), (dialog) => {
              assert.include(dialog.element.textContent, spell.name);
              pressDialog(dialog, "cancel");
            }, CONFIRM);
            assert.isNull(result);
            assert.equal(actor.system.mana.value, mana, "no Mana spent");
            assert.equal(game.messages.size, messages, "no card");
            assert.deepEqual(cooldownOf(spell), started, "the cooldown didn't restart");
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("used anyway: it's rolled, the card says 'Used before cooldown.', and a fresh cooldown starts", async function () {
          const actor = await createTestCharacter("sneaky", { system: { stats: { int: { value: 6 } } } });
          try {
            const spell = await createTestItem(actor, "spell", "Zap", { system: { rank: 1, manaCost: 2, cooldown: "5 minutes", governingStat: "int" } });
            await actor.update({ "system.mana.value": actor.system.mana.max });
            const first = await withPinnedDice(PIN_D20_MID, () => CarlDice.rollSkillCheck(actor, spell, { skipDialog: true }));
            assert.notInclude(first.content, earlyText());
            const mana = actor.system.mana.value;
            const message = await withPinnedDice(PIN_D20_MID, () => withDialog(
              () => CarlDice.rollSkillCheck(actor, spell, { skipDialog: true }),
              (dialog) => pressDialog(dialog, "useAnyway"),
              CONFIRM,
            ));
            assert.exists(message);
            assert.include(message.content, earlyText());
            assert.include(message.getFlag("carl-rpg", "aiReroll").body, earlyText(), "kept for a reroll or Intervene");
            assert.equal(actor.system.mana.value, mana - 2);
            assert.isAtLeast(cooldownOf(spell).endsAt, game.time.worldTime + 299);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("an opposed Check folded into another card carries the note in its debuffNote", async function () {
          const actor = await createTestCharacter("taunter");
          try {
            const skill = await createTestItem(actor, "skill", "Taunt", { system: { rank: 1, cooldown: "10 minutes" } });
            await withPinnedDice(PIN_D20_MID, () => CarlDice.rollOpposedSkillCheck(actor, skill, { difficulty: 10, skipDialog: true, post: false }));
            assert.equal(cooldownOf(skill).kind, "time");
            const result = await withPinnedDice(PIN_D20_MID, () => withDialog(
              () => CarlDice.rollOpposedSkillCheck(actor, skill, { difficulty: 10, skipDialog: true, post: false }),
              (dialog) => pressDialog(dialog, "useAnyway"),
              CONFIRM,
            ));
            assert.include(result.debuffNote, earlyText());
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a Damage Effect picked for an Attack starts its own cooldown, and is asked about the next time", async function () {
          const actor = await createTestCharacter("striker");
          try {
            const skill = await createTestItem(actor, "skill", "Punch", {
              name: "Quench Punch", system: { category: "attack", isHandToHand: true, rank: 1, governingStat: "" },
            });
            const de = await createTestItem(actor, "damageEffect", "Powerful Strike", {
              system: { rank: 1, parentSkills: ["Quench Punch"], cooldown: "30 hours" },
            });
            const now = game.time.worldTime;
            const message = await withPinnedDice(PIN_D20_MID, () => CarlDice.rollAttack(actor, skill, { skipDialog: true, damageEffectItem: de }));
            assert.exists(message);
            assert.approximately(cooldownOf(de).endsAt, now + 30 * 3600, 1);
            assert.isNull(cooldownOf(skill), "the Skill has no cooldown");

            const refused = await withDialog(
              () => CarlDice.rollAttack(actor, skill, { skipDialog: true, damageEffectItem: de }),
              (dialog) => {
                assert.include(dialog.element.textContent, de.name);
                pressDialog(dialog, "cancel");
              },
              CONFIRM,
            );
            assert.isNull(refused);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("a toggled Spell's cooldown starts when it's switched on, not off; its card carries the note", async function () {
          const actor = await createTestCharacter("toggler");
          try {
            const spell = await createTestItem(actor, "spell", "Oakhide", {
              system: { isToggled: true, rank: 1, manaCost: 0, duration: "2 minutes", cooldown: "10 minutes" },
            });
            await CarlDice.rollToggleSpell(actor, spell);
            const started = cooldownOf(spell);
            assert.equal(started.kind, "time");
            await CarlDice.rollToggleSpell(actor, spell); // off: free, no prompt
            assert.isFalse(spell.system.active);
            assert.deepEqual(cooldownOf(spell), started);
            const card = await withDialog(() => CarlDice.rollToggleSpell(actor, spell), (dialog) => pressDialog(dialog, "useAnyway"), CONFIRM);
            assert.include(card.content, earlyText());
            assert.isTrue(spell.system.active);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("once per round: lasts until the next round of the fight; outside a fight nothing is counted", async function () {
          const actor = await createTestCharacter("crossbow");
          try {
            const skill = await createTestItem(actor, "skill", "Crossbow", { system: { rank: 1, cooldown: "Once per round." } });
            await withPinnedDice(PIN_D20_MID, () => CarlDice.rollSkillCheck(actor, skill, { skipDialog: true }));
            assert.isNull(activeCooldown(skill), "no rounds outside a fight");

            await inFight(actor, async (combat) => {
              await withPinnedDice(PIN_D20_MID, () => CarlDice.rollSkillCheck(actor, skill, { skipDialog: true }));
              assert.deepInclude(cooldownOf(skill), { kind: "round", combatId: combat.id, round: combat.round });
              assert.equal(cooldownLabel(activeCooldown(skill)), game.i18n.localize("CARLRPG.Cooldown.Chip.Round"));
              const round = combat.round;
              await combat.nextRound();
              await waitFor(() => combat.round === round + 1, { message: "the round never moved" });
              assert.isNull(activeCooldown(skill), "the next round has begun");
            });
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("once per scene: until the fight ends, or outside a fight until the GM's New scene", async function () {
          const actor = await createTestCharacter("fireball");
          const epoch = sceneEpoch();
          try {
            const skill = await createTestItem(actor, "skill", "Cockroach", { system: { rank: 1, cooldown: "Once per scene" } });
            await withPinnedDice(PIN_D20_MID, () => CarlDice.rollSkillCheck(actor, skill, { skipDialog: true }));
            assert.deepInclude(cooldownOf(skill), { kind: "scene", combatId: null, epoch });
            assert.equal(cooldownLabel(activeCooldown(skill)), game.i18n.localize("CARLRPG.Cooldown.Chip.Scene"));
            assert.isFunction(CarlToolbox.DEFAULT_OPTIONS.actions.newScene, "the Toolbox's New scene button");
            await startNewScene();
            assert.isNull(activeCooldown(skill), "New scene clears it");

            let combatId = null;
            await inFight(actor, async (combat) => {
              combatId = combat.id;
              // New scene cleared it, so no prompt.
              await withPinnedDice(PIN_D20_MID, () => CarlDice.rollSkillCheck(actor, skill, { skipDialog: true }));
              assert.equal(cooldownOf(skill).combatId, combat.id);
              assert.exists(activeCooldown(skill), "still this scene while the fight lasts");
            });
            assert.notExists(game.combats.get(combatId));
            assert.isNull(activeCooldown(skill), "the fight is over");
          } finally {
            await game.settings.set("carl-rpg", SCENE_EPOCH_SETTING, epoch);
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: timers and cooldowns" },
  );
}
