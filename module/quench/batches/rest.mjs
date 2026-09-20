import { shortRestUpdates } from "../../helpers/rest.mjs";
import { createTestCharacter, deleteTestActor } from "../helpers.mjs";

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.rest",
    (context) => {
      const { describe, it, assert } = context;

      describe("shortRestUpdates (p.94: +5 HB, +half Mana, both clamped to max)", function () {
        it("adds 5 HB slots, clamped at effectiveMax", async function () {
          const actor = await createTestCharacter("character", { system: { hb: { value: 3, max: 10 } } });
          try {
            assert.equal(shortRestUpdates(actor)["system.hb.value"], 8);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("clamps at effectiveMax rather than overshooting", async function () {
          const actor = await createTestCharacter("character", { system: { hb: { value: 8, max: 10 } } });
          try {
            assert.equal(shortRestUpdates(actor)["system.hb.value"], 10);
          } finally {
            await deleteTestActor(actor);
          }
        });

        it("restores half of max Mana (floored), clamped at max", async function () {
          const actor = await createTestCharacter("character", { system: { stats: { int: { value: 10 } }, mana: { value: 2 } } });
          try {
            // mana.max derives from effective INT (10) -> restore floor(10/2)=5 -> 2+5=7.
            assert.equal(shortRestUpdates(actor)["system.mana.value"], 7);
          } finally {
            await deleteTestActor(actor);
          }
        });
      });
    },
    { displayName: "CarlRPG: rest.mjs" },
  );
}
