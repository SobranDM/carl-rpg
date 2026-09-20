import { resolveEvadeDifficulty, canActOnUuidFlag } from "../../chat/evade-link-card.mjs";
import { isCardLocked, canActTaunt } from "../../chat/taunt-card.mjs";
import { canApplyDamage, onApplyDamage } from "../../chat/damage-card.mjs";
import { canApplyTargetEffects, onApplyTargetEffects } from "../../chat/target-effects-card.mjs";
import { canApplyHeal, onApplyHeal } from "../../chat/heal-card.mjs";
import { createTestCharacter, deleteTestActor, settle, useQuenchTimeout } from "../helpers.mjs";

const fakeEvent = { preventDefault() {} };

function fakeMessage(flags = {}) {
  return { getFlag: (ns, key) => flags[key] };
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.chat-cards",
    (context) => {
      const { describe, it, assert } = context;

      describe("resolveEvadeDifficulty (Considerate Play/PvP, p.87)", function () {
        useQuenchTimeout(this);

        it("Character vs. Character: the attacker's own rolled total becomes the Difficulty", function () {
          const result = resolveEvadeDifficulty({ attackerType: "character", defenderType: "character", attackTotal: 18, targetDifficulty: 13 });
          assert.equal(result, 18);
        });

        it("any Mob on either side: the static-formula Difficulty applies unchanged", function () {
          assert.equal(resolveEvadeDifficulty({ attackerType: "mob", defenderType: "character", attackTotal: 18, targetDifficulty: 13 }), 13);
          assert.equal(resolveEvadeDifficulty({ attackerType: "character", defenderType: "mob", attackTotal: 18, targetDifficulty: 13 }), 13);
        });
      });

      describe("isCardLocked (Taunt)", function () {
        useQuenchTimeout(this);

        it("is locked once damage/target-effects/evade has already resolved the card", function () {
          assert.isTrue(isCardLocked(fakeMessage({ damageApplied: true })));
          assert.isTrue(isCardLocked(fakeMessage({ evadeRolled: true })));
        });

        it("is unlocked with none of those flags set", function () {
          assert.isFalse(isCardLocked(fakeMessage({})));
        });
      });

      describe("visibility gates (GM-always-true short circuit)", function () {
        useQuenchTimeout(this);

        it("canActOnUuidFlag / canApplyDamage / canApplyTargetEffects / canApplyHeal / canActTaunt all permit the GM", function () {
          const message = fakeMessage({ targetUuids: [], debuffActorUuid: null, healActorUuid: null });
          assert.isTrue(canActOnUuidFlag(message, "targetUuids"));
          assert.isTrue(canApplyDamage(message));
          assert.isTrue(canApplyTargetEffects(message));
          assert.isTrue(canApplyHeal(message));
          assert.isTrue(canActTaunt());
        });
      });

      describe("onApplyDamage / onApplyTargetEffects / onApplyHeal (DOM-free - a fake event object suffices)", function () {
        useQuenchTimeout(this);

        it("onApplyDamage reduces HB by the pipeline's whole-slot result and flags damageApplied", async function () {
          const target = await createTestCharacter("target", { system: { hb: { value: 10, max: 10 }, dr: 0 } });
          let message;
          try {
            // Untyped ("") damage - the same flag shape as an Amazing Success/
            // Evade Major-Fail +Floor bonus - now that splitDamageEvenly no
            // longer drops the "" key during Apply Damage's re-split.
            message = await ChatMessage.create({
              content: "<div></div>",
              flags: { "carl-rpg": { targetUuids: [target.uuid], damageByType: { "": 12 }, damageIsMagic: true } },
            });
            await onApplyDamage(fakeEvent, message);
            await settle();
            assert.isBelow(target.system.hb.value, 10);
            assert.isTrue(message.getFlag("carl-rpg", "damageApplied"));
          } finally {
            await deleteTestActor(target);
            if (message) await message.delete();
          }
        });

        it("onApplyTargetEffects writes the snapshotted Debuff onto every snapshotted target", async function () {
          const target = await createTestCharacter("target");
          let message;
          try {
            message = await ChatMessage.create({
              content: "<div></div>",
              flags: { "carl-rpg": { targetUuids: [target.uuid], targetEffects: [{ debuffKey: "poisoned", stacks: 1, label: "", sourceLabel: "Test" }] } },
            });
            await onApplyTargetEffects(fakeEvent, message);
            await settle();
            assert.include(target.system.conditions.map((c) => c.key), "poisoned");
            assert.isTrue(message.getFlag("carl-rpg", "targetEffectsApplied"));
          } finally {
            await deleteTestActor(target);
            if (message) await message.delete();
          }
        });

        it("onApplyHeal restores HB up to effectiveMax and flags healApplied", async function () {
          const actor = await createTestCharacter("healed", { system: { hb: { value: 3, max: 10 } } });
          let message;
          try {
            message = await ChatMessage.create({
              content: "<div></div>",
              flags: { "carl-rpg": { healActorUuid: actor.uuid, healAmount: 5 } },
            });
            await onApplyHeal(fakeEvent, message);
            await settle();
            assert.equal(actor.system.hb.value, 8);
            assert.isTrue(message.getFlag("carl-rpg", "healApplied"));
          } finally {
            await deleteTestActor(actor);
            if (message) await message.delete();
          }
        });
      });
    },
    { displayName: "CarlRPG: chat-card gate/apply functions" },
  );
}
