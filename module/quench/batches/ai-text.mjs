import {
  aiTextContent,
  aiTextDirection,
  aiTextOf,
  hideAiText,
  showAiText,
} from "../../apps/ai-text-tooltip.mjs";
import { blurbFor, findAiTexts, nameKey } from "../../pdf-import/parse-ai-text.mjs";
import { parseMobs } from "../../pdf-import/parse-mobs.mjs";
import {
  AI_TEXT_NOTICE_ID,
  announceAiText,
  MIGRATIONS,
  migrationPlan,
} from "../../helpers/migration.mjs";
import {
  createTestCharacter,
  createTestMob,
  deleteTestActor,
  useQuenchTimeout,
  withSetting,
} from "../helpers.mjs";

const AI = "<p><strong>Quench Mob. Level 3.</strong> Quench says hi.</p>";

// Made-up pages in the books' layout - no rulebook text is committed here.
const AI_BOLD = "TextbookNew-Bold";
const AI_REG = "TextbookNew-Regular";
const PROSE = "ClassicoURW-Reg";

/**
 * Lines as scan.mjs lays them out, with their typefaces: [text, face,
 * size, gap] - gap the space above (null for a column's top).
 */
function page(rows, n = 1) {
  let y = 740;
  const lines = rows.map(([text, face = PROSE, size = 10.5, gap = 13]) => {
    y -= gap ?? 0;
    return { text, x: 60, y, size, col: 0, page: n, gap, ...(face ? { face } : {}) };
  });
  lines[0].gap = null;
  return { page: n, width: 612, height: 792, items: [], lines };
}

/** A stat block's lines. */
const statBlock = (name, classLine, level) => [
  [name, AI_BOLD, 12, 34],
  [classLine, "TextbookNew-Italic", 10.5, 14],
  ["2 2 2", AI_REG, 10, 20],
  ["33% 67% 100%", AI_REG, 6, 12],
  ["Level Surprise Evade Move DR", AI_BOLD, 10, 15],
  [`${level} 12+F 11+F 20+S 1`, AI_REG, 9.5, 15],
  ["Str Int Con Dex Cha", "TextbookNew-Bold-SC700", 10, 15],
  ["5 (+2) 1 (+1) 6 (+3) 2 (+1) 1 (+1)", AI_REG, 10, 15],
  ["Slap: 12+F to hit, 1d6+2 Bludgeoning, 5ft range", AI_REG, 10, 18],
];

// The core book's way: narration, then the AI's bold header and its text.
const CORE_PAGE = page([
  ["TEST GLOOPS", "NeueKabel-ExtraBold", 16, 30],
  ["Test Gloops drip from every ceiling here.", PROSE, 10.5, 15],
  ["Test Gloop. Level 4.", AI_BOLD, 10, 31],
  ["Quench text: a gloop is mostly regret and", AI_REG, 10, 17.5],
  ["falls to hit the floor at Level 5 speed.", AI_REG, 10, 13],
  ["Quench text: a second paragraph.", AI_REG, 10, 17.5],
  ...statBlock("Test Gloop", "Mob; Small (2), Ooze", 4),
]);

// The Toolkit's way: a name wrapping over two lines above "Level 9
// Neighborhood Boss!".
const TOOLKIT_PAGE = page(
  [
    ["TEST THRONE ROOM", "CitrusGothic-Regular", 15, 30],
    ["The queen holds court here.", PROSE, 10.5, 15],
    ["The Test Queen. Former Gloop, Current", AI_REG, 10.5, 22],
    ["Ruler of Every Drip", AI_REG, 10.5, 13],
    ["Level 9 Neighborhood Boss!", AI_REG, 10.5, 17.5],
    ["Quench text: she drips with authority.", AI_REG, 10.5, 17.5],
    ...statBlock("Test Queen", "Neighborhood Boss; Large (5), Ooze", 9),
  ],
  2,
);

/** A found blurb's matching fields, for blurbFor. */
const keyed = (b) => ({ parts: [], level: 0, order: 0, section: null, ...b });

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

      describe("Updating to 0.8.2", function () {
        useQuenchTimeout(this);

        it("a world with content gets a card in chat saying to re-import", async function () {
          const entry = MIGRATIONS.find((m) => m.id === AI_TEXT_NOTICE_ID);
          assert.equal(entry?.version, "0.8.2");
          const others = MIGRATIONS.filter((m) => m.id !== AI_TEXT_NOTICE_ID).map((m) => m.id);
          assert.deepEqual(
            migrationPlan({ done: others, hasContent: true }).run.map((m) => m.id),
            [AI_TEXT_NOTICE_ID],
          );
          assert.lengthOf(
            migrationPlan({ done: others, hasContent: false }).run,
            0,
            "a new world: no card",
          );
          const before = new Set(game.messages.keys());
          const result = await announceAiText();
          assert.deepEqual(result, { changed: 0, errors: 0 }, "nothing in the world changes");
          const card = game.messages.find((m) => !before.has(m.id));
          assert.exists(card);
          assert.include(card.content, "Mobs get AI Text");
          assert.include(card.content, "re-import mobs from the core rulebook");
          assert.isTrue(!card.whisper?.length, "in chat for everyone");
        });
      });

      describe("The rulebook import", function () {
        it("the core book's way: the bold header, then its text, kept out of the Notes", function () {
          const [gloop] = parseMobs([CORE_PAGE]);
          const s = gloop.data.system;
          assert.equal(gloop.name, "Test Gloop");
          assert.include(s.aiText, "<p><strong>Test Gloop. Level 4.</strong></p>");
          assert.include(s.aiText, "mostly regret", "its text");
          assert.include(
            s.aiText,
            "falls to hit the floor at Level 5 speed.",
            "no new header, or stat line, mid-text",
          );
          assert.include(
            s.aiText,
            "<p>Quench text: a second paragraph.</p>",
            "a wider gap: a paragraph",
          );
          assert.notInclude(s.aiText, "Slap", "not the stat block");
          assert.include(s.biography, "drip from every ceiling", "the book's prose stays in Notes");
          assert.notInclude(s.biography, "mostly regret", "the AI's doesn't");
        });

        it("the Toolkit's way: a two-line name above a Boss's Level", function () {
          const [queen] = parseMobs([TOOLKIT_PAGE]);
          assert.equal(queen.name, "Test Queen");
          assert.include(
            queen.data.system.aiText,
            "<strong>The Test Queen. Former Gloop, Current Ruler of Every Drip Level 9 Neighborhood Boss!</strong>",
          );
          assert.include(queen.data.system.aiText, "drips with authority");
        });

        it("only the AI's typeface is AI Text", function () {
          const prose = page([
            ["TEST GLOOPS", "NeueKabel-ExtraBold", 16, 30],
            ["Test Gloop. Level 4.", PROSE, 10.5, 31],
            ["The book's own words, not the AI's.", PROSE, 10.5, 17.5],
            ...statBlock("Test Gloop", "Mob; Small (2), Ooze", 4),
          ]);
          assert.lengthOf(findAiTexts([prose]), 0);
          assert.equal(parseMobs([prose])[0].data.system.aiText, "");
          const unread = page([
            ["Test Gloop. Level 4.", null, 10, 31],
            ["No typeface was read for this page.", null, 10, 17.5],
          ]);
          assert.lengthOf(findAiTexts([unread]), 0);
        });

        it("names meet whatever their plural, capitals, hyphens or 'The'", function () {
          assert.equal(nameKey("Brain Boilers"), nameKey("Brain Boiler"));
          assert.equal(nameKey("Torpedoes"), nameKey("Torpedo"));
          assert.equal(nameKey("Gumshoes"), nameKey("Gumshoe"));
          assert.equal(nameKey("The Cardium Clam"), nameKey("Cardium Clam"));
          assert.equal(nameKey("Melon Baller Marvin"), nameKey("Melon-Baller Marvin"));
          assert.notEqual(nameKey("Rat Brute"), nameKey("Rat Shaman"));
        });

        it("a Mob takes the blurb that names it: whole name, title, or a part", function () {
          const blurbs = [
            keyed({ whole: "rat brute", primary: "rat brute", level: 4, order: 10 }),
            keyed({
              whole: "godpapa john rat brute",
              primary: "godpapa john",
              parts: ["godpapa john", "rat brute"],
              level: 8,
              order: 12,
            }),
            keyed({
              whole: "stoker non sparkly vampire",
              primary: "stoker",
              parts: ["stoker", "non sparkly vampire"],
              level: 18,
              order: 40,
            }),
            keyed({
              whole: "mick moran hulking crocodilian chef",
              primary: "mick moran",
              level: 12,
              order: 60,
            }),
          ];
          const pick = (name, level, order) => blurbFor({ name, level, order }, blurbs)?.whole;
          assert.equal(pick("Rat Brute", 4, 13), "rat brute", "its own, over a named one's");
          assert.equal(pick("Non-Sparkly Vampire", 18, 41), "stoker non sparkly vampire");
          assert.equal(
            pick("Mick Moran, Hulking Crockodilian Chef", 12, 61),
            "mick moran hulking crocodilian chef",
            "by the name before the title, whatever the title's spelling",
          );
          assert.isUndefined(pick("Rat Shaman", 5, 14), "no blurb names it");
        });

        it("failing a name: one that begins the Mob's, or a misprint, at its Level", function () {
          const blurbs = [
            keyed({ whole: "troglodyte", primary: "troglodyte", level: 6, order: 5 }),
            keyed({ whole: "grease gremlin", primary: "grease gremlin", level: 38, order: 50 }),
          ];
          const pick = (name, level) => blurbFor({ name, level, order: 20 }, blurbs)?.whole;
          assert.equal(pick("Troglodyte Basher", 6), "troglodyte");
          assert.isUndefined(pick("Troglodyte Pygmy", 2), "not at another Level");
          assert.equal(pick("Grease Gremilin", 38), "grease gremlin");
          assert.isUndefined(pick("Grease Gremilin", 18), "a misprint only at its Level");
        });

        it("the same name twice: its own Neighborhood's first, then the nearest", function () {
          const here = { floor: 1, kind: "neighborhood", name: "Here" };
          const there = { floor: 1, kind: "neighborhood", name: "There" };
          const blurbs = [
            keyed({ whole: "rat brute", primary: "rat brute", order: 100, section: there }),
            keyed({ whole: "rat brute", primary: "rat brute", order: 10, section: here }),
            keyed({ whole: "rat brute", primary: "rat brute", order: 98, section: here }),
          ];
          assert.equal(blurbFor({ name: "Rat Brute", order: 99, section: here }, blurbs).order, 98);
          assert.equal(
            blurbFor({ name: "Rat Brute", order: 101, section: there }, blurbs).order,
            100,
          );
        });
      });
    },
    { displayName: "Carl RPG: Mobs - AI Text" },
  );
}
