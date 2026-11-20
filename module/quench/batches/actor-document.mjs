import {
  createTestCharacter,
  createTestItem,
  createTestMob,
  deleteTestActor,
  settle,
  useQuenchTimeout,
  waitFor,
  withSetting,
} from "../helpers.mjs";
import { tokenDefaultsFor } from "../../documents/actor.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.actor-document",
    (context) => {
      const { describe, it, assert } = context;

      describe("_preCreate: token defaults by actor type", function () {
        useQuenchTimeout(this);
        const { TOKEN_DISPLAY_MODES: MODES, TOKEN_DISPOSITIONS: DISPOSITIONS } = CONST;
        // A world's Prototype Token Overrides (core setting) win over our
        // defaults; a path it sets for the type isn't asserted.
        const overridden = (type) => {
          const setting = game.settings.get("core", "prototypeTokenOverrides");
          const flat = {
            ...foundry.utils.flattenObject(setting?.base ?? {}),
            ...foundry.utils.flattenObject(setting?.[type] ?? {}),
          };
          return new Set(
            Object.entries(flat)
              .filter(([, v]) => v !== undefined && v !== null)
              .map(([k]) => k),
          );
        };
        const expectDefaults = (actor) => {
          const skip = overridden(actor.type);
          const token = actor.prototypeToken;
          for (const [path, value] of Object.entries(
            foundry.utils.flattenObject(tokenDefaultsFor(actor.type)),
          )) {
            if (skip.has(path)) continue;
            assert.strictEqual(
              foundry.utils.getProperty(token, path),
              value,
              `${actor.type}: prototypeToken.${path}`,
            );
          }
        };

        it("Characters and Pets: linked, vision on, Friendly, name on hover to anyone, bars on hover to the owner", async function () {
          assert.include(tokenDefaultsFor("character"), {
            actorLink: true,
            disposition: DISPOSITIONS.FRIENDLY,
            displayName: MODES.HOVER,
            displayBars: MODES.OWNER_HOVER,
          });
          assert.isTrue(tokenDefaultsFor("pet").sight.enabled);
          for (const type of ["character", "pet"]) {
            const actor = await createTestCharacter(type, { type });
            try {
              expectDefaults(actor);
              assert.isTrue(actor.prototypeToken.actorLink);
            } finally {
              await deleteTestActor(actor);
            }
          }
        });

        it("Mobs: unlinked, no vision, Hostile", async function () {
          assert.include(tokenDefaultsFor("mob"), {
            actorLink: false,
            disposition: DISPOSITIONS.HOSTILE,
          });
          const actor = await createTestCharacter("mob", { type: "mob" });
          try {
            expectDefaults(actor);
            assert.isFalse(actor.prototypeToken.actorLink);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("Vehicles and Loot Boxes: linked, no vision, Neutral; a Loot Box shows no bars", async function () {
          assert.strictEqual(tokenDefaultsFor("lootBox").displayBars, MODES.NONE);
          for (const type of ["vehicle", "lootBox"]) {
            const actor = await createTestCharacter(type, { type });
            try {
              expectDefaults(actor);
              assert.isTrue(actor.prototypeToken.actorLink);
            } finally {
              await deleteTestActor(actor);
            }
          }
        });

        it("keeps token settings the creation data gives (an import or a copy)", async function () {
          const actor = await createTestCharacter("mob", {
            type: "mob",
            prototypeToken: { actorLink: true, disposition: DISPOSITIONS.NEUTRAL },
          });
          try {
            assert.isTrue(actor.prototypeToken.actorLink, "a given actorLink is kept");
            if (!overridden("mob").has("disposition"))
              assert.strictEqual(actor.prototypeToken.disposition, DISPOSITIONS.NEUTRAL);
            if (!overridden("mob").has("sight.enabled"))
              assert.isFalse(
                actor.prototypeToken.sight.enabled,
                "an unset field still gets its default",
              );
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("_preUpdate: +3 Stat points per Level (p.169)", function () {
        useQuenchTimeout(this);

        it("accrues 3 x levelDelta into bankedStatPoints on a Level increase", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({ "system.attributes.level.value": 5 });
            assert.equal(actor.system.bankedStatPoints, 12); // 3 x (5 - 1)
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("does not claw back points on a Level decrease (GM correcting a mistake)", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({ "system.attributes.level.value": 5 });
            assert.equal(actor.system.bankedStatPoints, 12);
            await actor.update({ "system.attributes.level.value": 3 });
            assert.equal(
              actor.system.bankedStatPoints,
              12,
              "a Level decrease must not reduce banked points",
            );
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("does not fire on an update that never touches Level", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({ "system.biography": "Some text." });
            assert.equal(actor.system.bankedStatPoints, 0);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("accumulates correctly across multiple sequential Level-ups", async function () {
          const actor = await createTestCharacter();
          try {
            await actor.update({ "system.attributes.level.value": 2 });
            assert.equal(actor.system.bankedStatPoints, 3);
            await actor.update({ "system.attributes.level.value": 5 });
            assert.equal(actor.system.bankedStatPoints, 12); // 3 + 3*3
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("_onUpdate: level-gated grant recheck", function () {
        useQuenchTimeout(this);

        it("bakes a levelGate'd grant automatically once Level crosses the gate via a real actor.update", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "race", "race", {
              system: {
                changes: [
                  { targetType: "stat", target: "dex", mode: "add", value: "2", levelGate: 50 },
                ],
              },
            });
            await settle();
            assert.equal(actor.system.stats.dex.value, 3);

            await actor.update({ "system.attributes.level.value": 50 });
            // _onUpdate's recheckLevelGatedGrants->bakeItemGrants chain isn't awaited by actor.update() - poll instead of a fixed settle().
            await waitFor(() => actor.system.stats.dex.value !== 3);
            assert.equal(
              actor.system.stats.dex.value,
              5,
              "the _onUpdate hook should auto-recheck level-gated grants",
            );
          } finally {
            await deleteTestActor(actor);
          }
        });
      });

      describe("a Floor change re-derives from the stored data (carl-rpg.mjs currentFloor onChange)", function () {
        useQuenchTimeout(this);

        it("a Boss at full HB keeps it when the Floor goes down and back up, linked and on an unlinked token", async function () {
          await withSetting("currentFloor", 3, async () => {
            // Table 50: a Neighborhood Boss is 10 + Floor slots.
            const boss = await createTestMob("floor boss", {
              system: { level: 27, mobTier: "neighborhood" },
            });
            const scene = await Scene.create({ name: `Quench floor ${foundry.utils.randomID()}` });
            try {
              await boss.update({ "system.hb.value": 13 });
              assert.equal(boss.system.hb.effectiveMax, 13, "test setup: Floor 3");
              const [token] = await scene.createEmbeddedDocuments("Token", [
                { actorId: boss.id, actorLink: false },
              ]);
              assert.equal(
                token.actor.system.hb.value,
                13,
                "test setup: the token's Boss is at full HB",
              );

              await game.settings.set("carl-rpg", "currentFloor", 1);
              assert.equal(boss.system.hb.value, 11, "Floor 1: 11 slots");
              assert.equal(token.actor.system.hb.value, 11, "the token's too");

              await game.settings.set("carl-rpg", "currentFloor", 3);
              assert.equal(boss.system.hb.value, 13, "back at Floor 3: full again");
              assert.equal(boss._source.system.hb.value, 13, "never stored lower");
              assert.equal(token.actor.system.hb.value, 13, "the token's Boss too");
            } finally {
              await scene.delete();
              await deleteTestActor(boss);
            }
          });
        });
      });

      describe("rollMarkedAdvancementChecks: rankFilter", function () {
        useQuenchTimeout(this);

        it("lte4 only rolls marked items at Rank <=4; gte5 only Rank >=5", async function () {
          const actor = await createTestCharacter();
          try {
            await createTestItem(actor, "skill", "Low Rank", {
              name: "Low Rank",
              system: { rank: 2, marked: true },
            });
            await createTestItem(actor, "skill", "High Rank", {
              name: "High Rank",
              system: { rank: 5, marked: true },
            });
            await createTestItem(actor, "skill", "Unmarked", {
              name: "Unmarked",
              system: { rank: 8, marked: false },
            });

            const low = await actor.rollMarkedAdvancementChecks({ rankFilter: "lte4" });
            assert.lengthOf(low, 1);
            assert.equal(low[0].item.name, "Low Rank");

            const high = await actor.rollMarkedAdvancementChecks({ rankFilter: "gte5" });
            assert.lengthOf(high, 1);
            assert.equal(high[0].item.name, "High Rank");
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: documents/actor.mjs" },
  );
}
