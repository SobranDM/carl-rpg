import {
  aiTextContent,
  aiTextDirection,
  aiTextOf,
  hideAiText,
  showAiText,
} from "../../apps/ai-text-tooltip.mjs";
import {
  createTestCharacter,
  createTestMob,
  deleteTestActor,
  useQuenchTimeout,
  withSetting,
} from "../helpers.mjs";

const AI = "<p><strong>Quench Mob. Level 3.</strong> Quench says hi.</p>";

/** A hovered token's stand-in: what the tooltip reads from a Token. */
const fakeToken = (actor) => ({
  actor,
  hover: true,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
});

/**
 * A Mob's AI Text (0.8.2, ruled 2026-11-21): the field, and the tooltip
 * beside its hovered token.
 */
export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.ai-text",
    (context) => {
      const { describe, it, assert } = context;

      describe("Which tokens show it", function () {
        useQuenchTimeout(this);

        it("a Mob's, when it has some and the GM's setting is on", async function () {
          const mob = await createTestMob("ai", { system: { aiText: AI } });
          const blank = await createTestMob("ai blank", { system: { aiText: "<p> </p>" } });
          const crawler = await createTestCharacter("ai crawler");
          try {
            await withSetting("aiTextTooltips", true, () => {
              assert.equal(aiTextOf(fakeToken(mob)), AI);
              assert.equal(aiTextOf(fakeToken(blank)), "", "an empty paragraph is none");
              assert.equal(aiTextOf(fakeToken(crawler)), "", "only Mobs");
              assert.equal(aiTextOf(null), "");
            });
            await withSetting("aiTextTooltips", false, () => {
              assert.equal(aiTextOf(fakeToken(mob)), "", "the GM turned it off");
            });
          } finally {
            await deleteTestActor(mob);
            await deleteTestActor(blank);
            await deleteTestActor(crawler);
          }
        });

        it("the AI Text field is HTML, kept as written", async function () {
          const mob = await createTestMob("ai field", { system: { aiText: AI } });
          try {
            assert.instanceOf(mob.system.schema.fields.aiText, foundry.data.fields.HTMLField);
            assert.equal(mob.system.aiText, AI);
          } finally {
            await deleteTestActor(mob);
          }
        });
      });

      describe("The tooltip", function () {
        useQuenchTimeout(this);

        it("opens to the token's right, or its left by the screen's edge", function () {
          const dirs = foundry.helpers.interaction.TooltipManager.TOOLTIP_DIRECTIONS;
          assert.equal(aiTextDirection({ left: 100, right: 200 }, 1920), dirs.RIGHT);
          assert.equal(aiTextDirection({ left: 1700, right: 1800 }, 1920), dirs.LEFT);
          assert.equal(
            aiTextDirection({ left: 100, right: 200 }, 400),
            dirs.RIGHT,
            "no room either side: right",
          );
        });

        it("'AI' first, then the text", function () {
          const body = aiTextContent("<p>Quench says hi.</p>");
          assert.equal(
            body.firstElementChild.textContent,
            game.i18n.localize("CARLRPG.AiText.Badge"),
          );
          assert.include(
            body.querySelector(".carl-ai-tooltip-text").textContent,
            "Quench says hi.",
          );
        });

        it("shows beside the token in Foundry's tooltip, and goes", async function () {
          if (!canvas?.ready) this.skip(); // needs a scene on the canvas
          const mob = await createTestMob("ai show", { system: { aiText: AI } });
          try {
            await withSetting("aiTextTooltips", true, async () => {
              assert.isTrue(await showAiText(fakeToken(mob)));
              const tip = game.tooltip.tooltip;
              assert.isTrue(tip.classList.contains("carl-ai-tooltip"));
              assert.include(tip.textContent, "Quench says hi.");
              assert.equal(
                tip.querySelector(".carl-ai-badge")?.textContent,
                game.i18n.localize("CARLRPG.AiText.Badge"),
              );
              hideAiText();
              assert.isFalse(tip.classList.contains("active"));
            });
          } finally {
            hideAiText();
            await deleteTestActor(mob);
          }
        });
      });
    },
    { displayName: "Carl RPG: Mobs - AI Text" },
  );
}
