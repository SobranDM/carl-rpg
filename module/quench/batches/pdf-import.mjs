import {
  findGutter,
  isBoilerplate,
  isDrmText,
  joinText,
  layoutLines,
  stripDrm,
  titleCase,
  toTextItems,
} from "../../pdf-import/page-text.mjs";
import { parseAchievements } from "../../pdf-import/parse-achievements.mjs";
import { bulletToChanges, parseGear } from "../../pdf-import/parse-gear.mjs";
import { parseMobs } from "../../pdf-import/parse-mobs.mjs";
import { findBookPack, importBook, matchCandidates } from "../../pdf-import/importer.mjs";
import {
  DEBUFF_KEYS,
  debuffKeyFor,
  itemTargetEffects,
  parseDebuffText,
  splitArmorPiercing,
} from "../../pdf-import/debuff-text.mjs";
import { buildMatcher, normalizeName, TIERS } from "../../pdf-import/compendium-match.mjs";
import {
  FINGERPRINT_VERSION,
  fingerprint,
  importState,
  importStamp,
  restamp,
  writtenFields,
} from "../../pdf-import/fingerprint.mjs";
import {
  BOOKS,
  bookIdOf,
  identifyBook,
  identifyPdf,
  UnknownBookError,
} from "../../pdf-import/books.mjs";
import * as scan from "../../pdf-import/scan.mjs";
import { findSections, floorNumber, sectionFolders } from "../../pdf-import/sections.mjs";
import {
  imageDraws,
  imageToRGBA,
  imageTransform,
  orientRGBA,
  pickMapDraw,
} from "../../pdf-import/maps.mjs";
import {
  imagePpis,
  judgeImageQuality,
  LOW_QUALITY_PPI,
  LowQualityPdfError,
  samplePages,
} from "../../pdf-import/quality.mjs";
import { parseSizeText } from "../../helpers/size-text.mjs";
import { legacyAttackItems, mobAttacksOf } from "../../helpers/mob-attacks.mjs";
import { pressDialog, useQuenchTimeout, withDialog } from "../helpers.mjs";
import { chooseContent, resolveMaps } from "../../pdf-import/import-dialog.mjs";
import { closePdfDocument, getPdfJs, loadPdfDocument } from "../../pdf-import/pdf-loader.mjs";

/**
 * A one-page PDF with a correct cross-reference table, as a File - for
 * opening and closing a real pdf.js document.
 */
function tinyPdfFile() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((obj, i) => {
    const at = body.length;
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([body], "quench-tiny.pdf", { type: "application/pdf" });
}

// Every block below is made up in the books' layout. No rulebook text is
// committed here: the books are not ours to redistribute.

/** Lines as page-text.mjs lays them out: one column, 13pt leading. */
function page(rows, { page: n = 1 } = {}) {
  let y = 700;
  const lines = rows.map(([text, size = 10.5, x = 60]) => {
    y -= size > 12 ? 20 : 13;
    return { text, x, y, size, col: 0, page: n, gap: 13 };
  });
  lines[0].gap = null;
  return { page: n, width: 612, height: 792, items: [], lines };
}

const MOB_PAGE = page([
  ["TEST HEAP MONSTERS", 16],
  ["They wobble, and they mean it."],
  ["Test Blob", 12],
  ["Mob; Small (2), Ooze"],
  ["2 2 2", 10],
  ["33% 67% 100%", 6],
  ["Level Surprise Evade Move DR", 10],
  ["4 12+F 11+F 20+S 1", 9.5],
  ["Str Int Con Dex Cha", 10],
  ["5 (+2) 1 (+1) 6 (+3) 2 (+1) 1 (+1)", 10],
  ["Slap: 12+F to hit, 1d6+2 Bludgeoning, Line of", 10],
  ["Sight range", 10],
  ["On an Evade Major Fail or worse, the crawler gains the", 10],
  ["Sticky Debuff.", 10],
  ["Notes: Wobbly—It wobbles when hit.", 10],
  ["Test Blob Queen", 12],
  ["Borough Boss; Large (5), Ooze"],
  ["5 5", 10],
  ["50% 100%", 6],
  ["Level Surprise Evade Move DR", 10],
  ["12 13+F 12+F 20+S 3", 9.5],
  ["Str Int Con Dex Cha", 10],
  ["20 (+5) 4 (+2) 15 (+4 3 (+2) 9 (+3)", 10],
  ["Engulf: None, 2d10+5 Acid, Auto-hits a Held foe", 10],
  ["Spit: 13+F to hit, 1d6+3 30ft range", 10],
]);

const GEAR_PAGE = page([
  ["APPENDIX 9: TEST GEAR", 32],
  ["TEST WIDGET OF", 16],
  ["NEVER-", 16],
  ["ENDING DOOM", 16],
  ["Gear Slot: Head"],
  ["A widget for testing."],
  ["• +2 Strength"],
  ["• +1 Test Poke Skill"],
  ["• Resistance to Fire and Ice damage"],
  ["• Glows faintly"],
]);

/** Text items laid out along a banner tilted by `angle` degrees. */
function tiltedBox(angle, [ax, ay]) {
  const t = (angle * Math.PI) / 180;
  const at = (u, v) => ({
    x: ax + u * Math.cos(t) - v * Math.sin(t),
    y: ay + u * Math.sin(t) + v * Math.cos(t),
  });
  const item = (str, u, v, size, font) => ({
    str,
    ...at(u, v),
    width: str.length * size * 0.5,
    size,
    angle,
    font,
  });
  return [
    item("NEW ACHIEVEMENT!", 0, 0, 16.5, "banner"),
    item("Test Pilot!", 40, -18, 13, "title"),
    item("You pressed every button in the cockpit.", -30, -40, 10, "box"),
    item("Some of them twice.", -30, -53, 10, "box"),
    item("REWARD?:", 50, -70, 10.5, "label"),
    item("You've received a Bronze Button Box!", 0, -82, 10, "box"),
    item("Contents—One big red button", 0, -95, 10, "box"),
  ];
}

/** A page with one achievement box and page prose running beside it. */
function achievementPage(angle) {
  const prose = Array.from({ length: 30 }, (_, i) => ({
    str: "body prose that is not in the box",
    x: 330,
    y: 520 - i * 13,
    width: 200,
    size: 10.5,
    angle: 0,
    font: "body",
  }));
  return {
    page: 1,
    width: 612,
    height: 792,
    items: [...tiltedBox(angle, [300, 500]), ...prose],
    lines: [],
  };
}

/** Stat blocks in the print variants the books use (all made up). */
const VARIANT_PAGE = page([
  ["TEST VARIANT MONSTERS", 16],
  ["Comma Golem", 12],
  ["Mob, Large (5), Construct"],
  ["3 3", 10],
  ["50% 100%", 6],
  ["LEVEL SURPRISE EVADE MOVE DR", 10],
  ["3 11+F 12+F 20+S 0", 10],
  ["STR INT CON DEX CHA", 10],
  ["7 (+3) 1 (+1) 5 (+2) 2 (+1) 1 (+1)", 10],
  ["Stomp: 15+5 to hit, 2d6+F Acid, 5ft range", 10],
  ["Glare: 14+F, 1d4 Psychic, 30ft range", 10],
  ["Wink: See below, 1d6+3 Psychic, 15ft Cone", 10],
  ["The target must make a free Int Stat Check.", 10],
  ["Gap Rat", 12],
  ["Mob Petite (3), Animal"],
  ["1", 10],
  ["100%", 6],
  ["Level Surprise Evade Move DR", 10],
  ["1 10+F 11+F 20+S 0", 10],
  ["Str Int Con Dex Cha", 10],
  ["1 (+1) 1 (+1) 1 (+1) 3 (+2) 1 (+1)", 10],
  ["Bite: 11+F to hit, 1d4+1 Piercing, 5ft range", 10],
  ["Test Captain", 12],
  ["Elite; Medium, (4), Humanoid"],
  ["Level Surprise Evade Move DR", 10],
  ["8 13+F 13+F 20+S 2", 10],
  ["Shifty Blob", 12],
  ["Mob; Small (2) to Huge (6), Shapeshifter"],
  ["Level Surprise Evade Move DR", 10],
  ["5 12+F 12+F 20+S 1", 10],
  ["Test Questmaster", 12],
  ["Quest Boss; Medium (4), Humanoid"],
  ["Level Surprise Evade Move DR", 10],
  ["60 20+F 20+F 20+S 4", 10],
  ["Kibril Atheras Darkoak", 12],
  ["Quest Boss; Medium (4), Humanoid"],
  ["Level Surprise Evade Move DR", 10],
  ["60 16+F 16+F 20+S 4", 10],
  ["Test Wagon", 12],
  ["Vehicle; Huge (6), Vehicle"],
  ["Level Surprise Evade Move DR", 10],
  ["4 10+F 10+F 40+S 3", 10],
]);

const LOOT_PAGE = page([
  ["GOLD BOXES", 16],
  ["Gear Slot: Arms"],
  ["Gold boxes hold good loot."],
  ["• Golden Ring of +3 to a Stat"],
  ["FACTION WARS ITEMS", 16],
  ["Gear Slot: Head"],
  ["Items for the war."],
  ["TEST CROWN OF PLACEHOLDING", 16],
  ["Gear Slot: Head"],
  ["A crown for testing."],
  ["• +5 to the Test Smash Skill"],
  ["• +1 to all Skill or Stat Checks"],
]);

/** A Mob whose Attacks carry Table 11 Debuffs and Armor-Piercing (made up). */
const DEBUFF_MOB_PAGE = page([
  ["TEST STABBY MONSTERS", 16],
  ["Test Stabber", 12],
  ["Mob; Small (2), Humanoid"],
  ["Level Surprise Evade Move DR", 10],
  ["3 11+F 12+F 20+S 0", 10],
  ["Stab: 12+F to hit, 1d4+1 Piercing, 5ft range, Armor-", 10],
  ["Piercing", 10],
  ["On an Evade Major Fail or worse, the crawler gains the", 10],
  ["Poison Debuff.", 10],
  ["Kick 11+F to hit, 1d6 Bludgeoning, 5ft range", 10],
  ["Any hit crawler gains the Staggered and Woozy Debuffs.", 10],
  ["Glare: 13+F to hit, 1d4 Psychic, 30ft range", 10],
  ["Any hit crawler must make an Int Stat Check. On Fail, they", 10],
  ["gain the Woozy Debuff.", 10],
]);

const DEBUFF_GEAR_PAGE = page([
  ["APPENDIX 9: TEST GEAR", 32],
  ["TEST KNUCKLES OF BONKING", 16],
  ["Gear Slot: Hands"],
  ["Knuckles for testing."],
  [
    "• On an Amazing Success with any Hand-to-Hand Attack you make, the target gains the Woozy Debuff",
  ],
  ["• On a Critical Hit with any Test Poke Attack you make, the target gains the Blinded Debuff"],
  ["• AS: Target gains Burned"],
]);

/** A minimal stat block (made up): its name, class line and Level. */
function mobRows(name, level) {
  return [
    [name, 12],
    ["Mob; Small (2), Fiend"],
    ["Level Surprise Evade Move DR", 10],
    [`${level} 10+F 10+F 20+S 0`, 10],
  ];
}

/**
 * A made-up book in the Core Rulebook's layout: a contents page, a Mob
 * before any Floor, chapter openers with the Floor's title (one drawn only
 * as a text item), mixed-case section headings with "Floor: N" under them,
 * and an appendix.
 */
const CORE_STYLE_BOOK = [
  page(
    [
      ["CHAPTER 7: THE TEST CITY ........................ 330", 16],
      ["Neighborhood: Fake Town ......................... 332", 12],
      ["Quest: Fake Errand .............................. 340", 12],
      ["Neighborhood: Fake Dots ......................... 350", 20],
    ],
    { page: 1 },
  ),
  page([["EXAMPLE MOBS", 16], ...mobRows("Test Sample", 1)], { page: 2 }),
  page(
    [
      ["Chapter 7", 41],
      ["The Third Floor: The Test City", 32],
    ],
    { page: 3 },
  ),
  page(
    [
      ["Neighborhood: Testville", 32],
      ["Floor: 3 – Theme: Placeholders", 15],
      ...mobRows("Test Imp", 4),
    ],
    {
      page: 4,
    },
  ),
  page(
    [
      ["Quest: Find the Test", 32],
      ["Floor: 3 – Theme: More placeholders", 15],
      ...mobRows("Test Seeker", 5),
    ],
    {
      page: 5,
    },
  ),
  {
    ...page([["CHAPTER 8CHAPTER 8", 90.9]], { page: 6 }),
    // The Floor's title drawn where no line holds it.
    items: [
      { str: "The Fourth Floor: The TEST TANGLE", x: 100, y: 120, size: 32, angle: 0, width: 300 },
    ],
  },
  page([["RIVAL TESTERS", 20], ...mobRows("Test Rival", 6)], { page: 7 }),
  page([["Neighborhood: Backyard Test", 32], ["(Land Quadrant)", 32], ...mobRows("Test Ant", 7)], {
    page: 8,
  }),
  page([["Appendix 1: Test Gear", 32], ...mobRows("Test Mascot", 2)], { page: 9 }),
];

/**
 * A made-up book in the Starter Set Gamemaster's Toolkit's layout: Floor
 * titles with no name, capitalised section headings (one wrapping onto
 * three lines), and an appendix of Mobs listed by Floor.
 */
const TOOLKIT_STYLE_BOOK = [
  page([["First Floor Tests 136", 13], ["ADVERSARIES", 20], ...mobRows("Test Rat", 1)], {
    page: 1,
  }),
  page([["The First Floor", 25]], { page: 2 }),
  page(
    [
      ["NEIGHBORHOOD: TEST BOGS", 20],
      ...mobRows("Test Bogling", 5),
      ...mobRows("Test Bog Brute", 2),
      ...mobRows("Test Bog Ace", 2),
    ],
    {
      page: 3,
    },
  ),
  page(
    [["QUEST:", 20], ["PASSIVE (TESTING)", 20], ["PERCEPTION", 20], ...mobRows("Test Watcher", 3)],
    { page: 4 },
  ),
  page([["The Second Floor", 25], ["THE ANNOUNCEMENT", 20], ...mobRows("Test Herald", 6)], {
    page: 5,
  }),
  page(
    [
      ["Threat Appendix", 25],
      ["RIVAL CRAWLERS", 20],
      ...mobRows("Test Bruiser", 3),
      ["FIRST FLOOR MOBS", 20],
      ...mobRows("Test Bogling Again", 5),
    ],
    {
      page: 6,
    },
  ),
];

/** A pdf.js-like text item at (x, y). */
function textItem(str, x = 60, y = 400) {
  return { str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, fontName: "f1" };
}

// Placeholder download stamps, in the store's two shapes and the older one.
const DRM_STAMPS = [
  "Downloaded by Jane Placeholder on 01/02/2030. Unauthorized distribution prohibited.",
  "Downloaded by Guest User on 12/31/2029. Unauthorized distribution prohibited.",
  "Copyright Example Game Studio. Unauthorized distribution prohibited. 01/02/2030.",
];

/** A stand-in for pdf.js's OPS table (the values only need to differ). */
const OPS = {
  save: 1,
  restore: 2,
  transform: 3,
  paintFormXObjectBegin: 4,
  paintFormXObjectEnd: 5,
  paintImageXObject: 6,
  paintInlineImageXObject: 7,
  beginGroup: 8,
  endGroup: 9,
  showText: 10,
};

/** An operator list from [op, args] pairs. */
function opList(ops) {
  return { fnArray: ops.map(([fn]) => OPS[fn]), argsArray: ops.map(([, args]) => args ?? null) };
}

export default function register(quench) {
  quench.registerBatch(
    "carl-rpg.pdf-import",
    (context) => {
      const { describe, it, assert, before, after } = context;

      describe("page-text", function () {
        it("finds the gutter at the leftmost right-column start", function () {
          const items = [];
          for (let i = 0; i < 8; i++) {
            items.push({
              str: "left column text",
              x: 60,
              y: 700 - i * 13,
              width: 230,
              size: 10.5,
              angle: 0,
            });
            items.push({
              str: "right column text",
              x: 319,
              y: 700 - i * 13,
              width: 230,
              size: 10.5,
              angle: 0,
            });
          }
          items.push({ str: "A Name", x: 313, y: 600, width: 60, size: 12, angle: 0 });
          assert.closeTo(findGutter(items, 612), 311, 0.01);
          const lines = layoutLines(items, { width: 612, height: 792 });
          assert.equal(lines.find((l) => l.text === "A Name").col, 1);
        });

        it("title-cases headings, keeping small words lowercase", function () {
          assert.equal(titleCase("ANKLET OF THE FALLEN OAK"), "Anklet of the Fallen Oak");
          assert.equal(titleCase("THE OVER CITY"), "The Over City");
        });
      });

      describe("parseMobs", function () {
        it("reads a stat block, wrapped attack range and notes", function () {
          const [blob] = parseMobs([MOB_PAGE]);
          const s = blob.data.system;
          assert.equal(blob.name, "Test Blob");
          assert.equal(blob.data.type, "mob");
          assert.equal(s.mobTier, "");
          assert.equal(s.size, 2, "Table 9's value");
          assert.equal(s.creatureType, "Ooze");
          assert.equal(s.level, 4);
          assert.equal(s.move, "20+S");
          assert.equal(s.dr, 1);
          assert.equal(s.hbSlotsOverride, 3);
          assert.deepEqual(
            Object.fromEntries(Object.entries(s.stats).map(([k, v]) => [k, v.value])),
            { str: 5, int: 1, con: 6, dex: 2, cha: 1 },
          );
          assert.lengthOf(s.attacks, 1);
          assert.deepInclude(s.attacks[0], {
            name: "Slap",
            toHit: "12+F",
            damage: "1d6+2",
            damageType: "bludgeoning",
            range: "Line of Sight",
          });
          assert.include(s.attacks[0].effect, "Sticky Debuff");
          assert.include(s.biography, "They wobble");
          assert.include(s.biography, "<strong>Wobbly:</strong>");
        });

        it("reads a Boss tier and tolerates print typos", function () {
          const queen = parseMobs([MOB_PAGE])[1];
          const s = queen.data.system;
          assert.equal(queen.name, "Test Blob Queen");
          assert.equal(s.mobTier, "borough");
          assert.equal(s.stats.con.value, 15);
          assert.deepInclude(s.attacks[0], {
            name: "Engulf",
            toHit: "",
            damage: "2d10+5",
            damageType: "acid",
          });
          assert.deepInclude(s.attacks[1], { name: "Spit", damage: "1d6+3", range: "30ft" });
        });
      });

      describe("parseGear", function () {
        it("joins a wrapped heading and maps simple bullets to changes", function () {
          const [widget] = parseGear([GEAR_PAGE]);
          assert.equal(widget.name, "Test Widget of Never-Ending Doom");
          assert.include(widget.data.system.description, "<strong>Gear Slot:</strong> Head");
          assert.include(widget.data.system.description, "<li>Glows faintly</li>");
          const changes = widget.data.system.changes.map(
            (c) => `${c.targetType}:${c.target}:${c.value}`,
          );
          assert.sameMembers(changes, [
            "stat:str:2",
            "skillRank:Test Poke:1",
            "resistance:fire:resist",
            "resistance:ice:resist",
          ]);
        });

        it("leaves prose bullets alone", function () {
          assert.isEmpty(bulletToChanges("+5% to Strength", "x"));
          assert.isEmpty(bulletToChanges("Always fits", "x"));
          assert.equal(bulletToChanges("−1 Charisma", "x")[0].value, "-1");
        });
      });

      describe("parseAchievements", function () {
        for (const angle of [0, 5, -7]) {
          it(`reads a box tilted ${angle} degrees`, function () {
            const [found] = parseAchievements([achievementPage(angle)]);
            assert.equal(found.name, "Test Pilot!");
            assert.equal(found.data.type, "achievement");
            const sys = found.data.system;
            assert.include(
              sys.description,
              "You pressed every button in the cockpit. Some of them twice.",
            );
            assert.equal(sys.reward, "You've received a Bronze Button Box!");
            assert.equal(sys.grade, "bronze");
            assert.isTrue(sys.lootBox, "the Reward gives a loot box");
            assert.equal(sys.contents, "One big red button");
            assert.notInclude(JSON.stringify(sys), "body prose");
          });
        }
      });

      describe("download stamp (DRM)", function () {
        it("recognises every stamp shape, whatever the name and date", function () {
          for (const stamp of DRM_STAMPS) {
            assert.isTrue(isDrmText(stamp), stamp);
            assert.isTrue(isBoilerplate(stamp), stamp);
          }
          assert.isTrue(
            isDrmText(
              "Downloaded by Jo O'Neil-Smith Jr. on 2030-01-02. Unauthorized distribution prohibited.",
            ),
          );
        });

        it("leaves book text alone", function () {
          for (const prose of [
            "anyone's around to make a copyright claim.",
            "unauthorized underground subway system that",
            "Copyright-infringing merch is downloaded by the crate.",
            "Distribution of loot is prohibited in saferooms.",
          ]) {
            assert.isFalse(isDrmText(prose), prose);
            assert.equal(stripDrm(prose), prose);
          }
        });

        it("drops the stamp when a page's text is read, and from joined text", function () {
          const items = toTextItems({
            items: [textItem("Test Blob", 60, 500), ...DRM_STAMPS.map((s) => textItem(s, 4, 7))],
          });
          assert.deepEqual(
            items.map((i) => i.str),
            ["Test Blob"],
          );
          // Split across lines (should a PDF ever do that), joinText still strips it.
          const joined = joinText([
            "Slap. Downloaded by Jane Placeholder on",
            "01/02/2030. Unauthorized distribution prohibited. Ow.",
          ]);
          assert.notInclude(joined, "Placeholder");
          assert.notInclude(joined, "Unauthorized");
          assert.include(joined, "Ow.");
        });

        it("reads the book's U+2011 hyphens as plain hyphens", function () {
          const [item] = toTextItems({ items: [textItem("Armor‑Piercing")] });
          assert.equal(item.str, "Armor-Piercing");
        });
      });

      describe("parseMobs print variants", function () {
        const mobs = parseMobs([VARIANT_PAGE]);
        const byName = (name) => mobs.find((m) => m.name === name)?.data.system;

        it("reads class lines with a comma, no separator, a stray comma or a size range", function () {
          assert.sameMembers(
            mobs.map((m) => m.name),
            [
              "Comma Golem",
              "Gap Rat",
              "Test Captain",
              "Shifty Blob",
              "Test Questmaster",
              "Kibril Atheras Darkoak",
            ],
            "the Vehicle is skipped",
          );
          assert.include(byName("Comma Golem"), {
            size: 5,
            creatureType: "Construct",
            isElite: false,
          });
          assert.include(byName("Gap Rat"), { size: 3, creatureType: "Animal" });
          assert.include(byName("Test Captain"), {
            size: 4,
            creatureType: "Humanoid",
            isElite: true,
            mobTier: "",
          });
          assert.include(byName("Shifty Blob"), { size: 2, creatureType: "Shapeshifter" });
          assert.include(byName("Test Questmaster"), {
            mobTier: "",
            isElite: true,
            creatureType: "Humanoid Quest Boss",
          });
          // A bespoke tier by name: Kibril's numbers are a Neighborhood Boss's.
          assert.include(byName("Kibril Atheras Darkoak"), {
            mobTier: "neighborhood",
            isElite: false,
            creatureType: "Humanoid Quest Boss",
          });
        });

        it("reads upper-case Level and Stat headers", function () {
          const s = byName("Comma Golem");
          assert.equal(s.level, 3);
          assert.equal(s.dr, 0);
          assert.deepEqual(
            Object.fromEntries(Object.entries(s.stats).map(([k, v]) => [k, v.value])),
            { str: 7, int: 1, con: 5, dex: 2, cha: 1 },
          );
        });

        it("reads to-hit without 'to hit', a plain bonus, 'See below', and +F damage", function () {
          const [stomp, glare, wink] = byName("Comma Golem").attacks;
          assert.include(stomp, {
            name: "Stomp",
            toHit: "15+5",
            damage: "2d6+F",
            damageType: "acid",
            range: "5ft",
          });
          assert.include(glare, {
            name: "Glare",
            toHit: "14+F",
            damage: "1d4",
            damageType: "psychic",
          });
          assert.include(wink, {
            name: "Wink",
            toHit: "",
            damage: "1d6+3",
            damageType: "psychic",
            range: "15ft Cone",
          });
          assert.include(wink.effect, "free Int Stat Check");
        });
      });

      describe("parseGear headings and bullets", function () {
        it("skips loot-box and list headings", function () {
          assert.deepEqual(
            parseGear([LOOT_PAGE]).map((g) => g.name),
            ["Test Crown of Placeholding"],
          );
        });

        it("reads '+N to the X Skill', and no Skill from '+N to all ...'", function () {
          const [crown] = parseGear([LOOT_PAGE]);
          assert.deepEqual(
            crown.data.system.changes.map((c) => `${c.targetType}:${c.target}:${c.value}`),
            ["skillRank:Test Smash:5"],
          );
          assert.include(crown.data.system.description, "+1 to all Skill or Stat Checks");
        });

        it("reads sizes without Foundry", function () {
          assert.equal(parseSizeText("Large (5)"), 5);
          assert.equal(parseSizeText("Medium, (4)"), 4);
          assert.equal(parseSizeText("huge"), 6);
          assert.isNull(parseSizeText("Unchanged"));
        });
      });

      describe("low-quality edition check", function () {
        it("measures pixels per inch of sizeable pictures only", function () {
          const view = [0, 0, 612, 792];
          const draws = imageDraws(
            opList([
              ["save"],
              ["transform", [306, 0, 0, 396, 0, 0]], // a quarter of the page
              ["paintImageXObject", ["img_a", 850, 1100]], // 200 ppi
              ["restore"],
              ["save"],
              ["transform", [20, 0, 0, 20, 0, 0]], // an icon
              ["paintImageXObject", ["img_b", 10, 10]],
              ["restore"],
            ]),
            OPS,
          );
          const ppis = imagePpis(draws, view);
          assert.lengthOf(ppis, 1);
          assert.closeTo(ppis[0], 200, 0.5);
        });

        it("refuses a median under the threshold, and never judges too few pictures", function () {
          assert.isFalse(
            judgeImageQuality(Array(30).fill(200)).lowQuality,
            "full quality (200 ppi)",
          );
          assert.isTrue(judgeImageQuality(Array(30).fill(72)).lowQuality, "Core LQ (72 ppi)");
          assert.isTrue(
            judgeImageQuality(Array(30).fill(100)).lowQuality,
            "Starter Set LQ (100 ppi)",
          );
          assert.isFalse(
            judgeImageQuality([...Array(20).fill(200), ...Array(9).fill(72)]).lowQuality,
            "a few low pictures",
          );
          assert.isFalse(judgeImageQuality([72, 72, 72]).lowQuality, "too few to judge");
          assert.isBelow(LOW_QUALITY_PPI, 200);
          assert.isAbove(LOW_QUALITY_PPI, 100);
        });

        it("samples pages spread through the book", function () {
          assert.deepEqual(samplePages(3), [1, 2, 3]);
          const pages = samplePages(650);
          assert.lengthOf(pages, 30);
          assert.equal(pages[0], 1);
          assert.equal(pages.at(-1), 650);
        });

        it("reports a localised error", function () {
          const message = game.i18n.format("CARLRPG.PdfImport.LowQuality", {
            title: "Test Book",
            ppi: 72,
          });
          assert.include(message, "Test Book");
          // The wording may or may not show the measured resolution ({ppi}).
          assert.notInclude(message, "{ppi}", "no unfilled placeholder");
          assert.notInclude(message, "CARLRPG.");
          assert.instanceOf(new LowQualityPdfError(72), Error);
        });
      });

      describe("map image extraction", function () {
        it("picks the map, not a soft mask's image or the page background", function () {
          const view = [0, 0, 612, 792];
          const draws = imageDraws(
            opList([
              ["save"],
              ["transform", [612, 0, 0, 792, 0, 0]],
              ["paintImageXObject", ["img_bg", 1700, 2200]], // full-page background
              ["restore"],
              ["beginGroup", [{ smask: true }]],
              ["save"],
              ["transform", [560, 0, 0, 700, 20, 40]],
              ["paintImageXObject", ["img_mask", 1555, 1944]], // only shapes transparency
              ["restore"],
              ["endGroup", [{}]],
              ["save"],
              ["transform", [0, -540, 680, 0, 30, 750]], // turned a quarter
              ["paintImageXObject", ["img_map", 1500, 1888]],
              ["restore"],
              ["showText", [[]]], // text drawn over it is not part of the image
            ]),
            OPS,
          );
          assert.deepEqual(
            draws.map((d) => d.objId),
            ["img_bg", "img_map"],
          );
          assert.equal(pickMapDraw(draws, view).objId, "img_map");
        });

        it("turns and fits stored pixels the way the page draws them", function () {
          assert.deepEqual(imageTransform([100, 0, 0, 50, 10, 10], 4, 2), {
            width: 4,
            height: 2,
            matrix: [1, 0, 0, 1, 0, 0],
          });
          const turned = imageTransform([0, -100, 50, 0, 0, 100], 4, 2);
          assert.deepEqual([turned.width, turned.height], [2, 4], "a quarter turn swaps the sides");
          const fit = imageTransform([100, 0, 0, 50, 0, 0], 8000, 4000, 6000);
          assert.deepEqual([fit.width, fit.height], [6000, 3000]);
        });

        it("reads RGB, RGBA and 1-bit pixels and applies a turn", function () {
          // A 2x1 image: red, then blue.
          const rgb = imageToRGBA({
            width: 2,
            height: 1,
            kind: 2,
            data: new Uint8Array([255, 0, 0, 0, 0, 255]),
          });
          assert.deepEqual([...rgb], [255, 0, 0, 255, 0, 0, 255, 255]);
          const rgba = imageToRGBA({
            width: 1,
            height: 1,
            kind: 3,
            data: new Uint8Array([1, 2, 3, 4]),
          });
          assert.deepEqual(
            [...rgba],
            [1, 2, 3, 4],
            "alpha kept (a soft mask pdf.js already applied)",
          );
          const bits = imageToRGBA({
            width: 2,
            height: 1,
            kind: 1,
            data: new Uint8Array([0b01000000]),
          });
          assert.deepEqual([...bits], [0, 0, 0, 255, 255, 255, 255, 255]);
          // Drawn a quarter turn clockwise: red on top, blue below.
          const out = orientRGBA(rgb, 2, 1, imageTransform([0, -100, 50, 0, 0, 100], 2, 1));
          assert.deepEqual([out.width, out.height], [1, 2]);
          assert.deepEqual([...out.data], [255, 0, 0, 255, 0, 0, 255, 255]);
        });
      });

      describe("structured Debuffs (debuff-text)", function () {
        const mob = (text) => parseDebuffText(text, { context: "mob" });
        const summary = (r) => r.effects.map((e) => `${e.trigger}:${e.debuffKey}`);

        it("reads a Mob Attack's Debuffs and when they land", function () {
          assert.deepEqual(
            summary(mob("On an Evade Major Fail or worse, the target gains the Poison Debuff.")),
            ["majorFail:poisoned"],
          );
          assert.deepEqual(
            summary(mob("On an Evade Major Fail or Worse, the crawler gains the Burning Debuff.")),
            ["majorFail:burned"],
          );
          assert.deepEqual(
            summary(mob("Any hit crawler gains the Shocked and Take Down Debuffs.")),
            ["hit:shocked", "hit:takeDown"],
          );
          assert.deepEqual(
            summary(mob("Any crawler who fails to Evade gains The Taint Debuff for a bit.")),
            ["hit:theTaint"],
          );
          assert.deepEqual(
            summary(
              mob(
                "On an Evade Critical Fail, the crawler gains the Long-Term Minor Injury Debuff.",
              ),
            ),
            ["criticalFail:longTermMinorInjury"],
          );
          assert.deepEqual(
            summary(
              mob(
                "Any hit crawler gains the Held Debuff. On an Evade Major Fail or worse, the crawler also gains the Stunned, Woozy, and Sore as Shit Debuffs.",
              ),
            ),
            ["hit:held", "majorFail:stunned", "majorFail:woozy", "majorFail:soreAsShit"],
          );
          assert.deepEqual(
            summary(mob("(test form only) On hit, target gains a Major Injury Debuff (ouch).")),
            ["hit:majorInjury"],
          );
        });

        it("leaves other Debuffs, and gated ones, as text only", function () {
          const cases = [
            [
              "On an Evade Major Fail or worse, the crawler gains the Gooey Test Debuff: Take 1d6+F Acid and gain the Held Debuff.",
              "custom",
            ],
            [
              "Any hit crawler gains the Blinded Debuff: Roll with Disadvantage on everything until healed.",
              "redefined",
            ],
            [
              "Any hit crawler must make a Str Stat Check. On a Fail, they gain the Held Debuff.",
              "check",
            ],
            [
              "The target must make a free Dex Stat Check vs Difficulty 12 or gains the Stunned Debuff.",
              "check",
            ],
            ["Any hit crawler gains the Muted or Queasy Debuff (the goblin's choice).", "choice"],
            [
              "On an Evade Major Fail or worse, the crawler gains one of the following Debuffs: Woozy, Stunned, or Blood Trail.",
              "choice",
            ],
            ["Any crawler who loses 4+ HB slots gains the Muted Debuff.", "hb"],
            [
              "If the test goblin moved this round, any hit crawler gains the Take Down Debuff.",
              "if",
            ],
            ["The goblin cackles, and the crawler gains the Woozy Debuff.", "trigger"],
          ];
          for (const [text, reason] of cases) {
            const read = mob(text);
            assert.isEmpty(read.effects, text);
            assert.equal(read.textOnly[0]?.reason, reason, text);
          }
          assert.isEmpty(
            mob("This attack automatically hits any crawler with the Held Debuff.").effects,
          );
          // A second Attack's line run into this one's effect isn't this one's.
          assert.deepEqual(
            summary(
              mob(
                "Any hit crawler gains the Muted Debuff. Kick 14+F to hit, 1d6 Bludgeoning, 5ft range On an Evade Major Fail or worse, the crawler gains the Blood Trail Debuff.",
              ),
            ),
            ["hit:muted"],
          );
        });

        it("reads gear's Amazing Success and Critical Hit Debuffs, with their Skills", function () {
          const gear = (text) => parseDebuffText(text, { context: "gear" }).effects[0];
          const fist = gear(
            "On an Amazing Success with any Hand-to-Hand Attack you make, the target gains the Woozy Debuff",
          );
          assert.include(fist, {
            debuffKey: "woozy",
            amazingSuccessOnly: true,
            critOnly: false,
            handToHandOnly: true,
          });
          assert.deepEqual(fist.skills, [], "the Hand-to-Hand box, not a list of names");
          const [entry] = itemTargetEffects(
            "On an Amazing Success with any Hand-to-Hand Attack you make, the target gains the Woozy Debuff",
            "gear",
          );
          assert.include(entry, { debuffKey: "woozy", handToHandOnly: true });
          assert.deepEqual(entry.skills, []);
          const any = gear(
            "On an Amazing Success with any Attack you make, the target gains the Queasy Debuff",
          );
          assert.include(any, { debuffKey: "queasy", amazingSuccessOnly: true });
          assert.deepEqual(any.skills, [], "any Attack");
          const crit = gear(
            "On a Critical Hit with any Test Poke Attack you make, the target gains the Blinded Debuff",
          );
          assert.include(crit, { debuffKey: "blinded", critOnly: true, amazingSuccessOnly: false });
          assert.deepEqual(crit.skills, ["Test Poke"]);
          assert.include(gear("AS: Target gains Burned"), {
            debuffKey: "burned",
            amazingSuccessOnly: true,
          });
        });

        it("reads a Spell Upgrade's Debuffs", function () {
          const spell = (text) => parseDebuffText(text, { context: "spell" });
          assert.include(
            spell("+1d3 base damage, and the target gains the Shocked Debuff.").effects[0],
            {
              debuffKey: "shocked",
              critOnly: false,
              amazingSuccessOnly: false,
            },
          );
          assert.include(
            spell(
              "+10ft Cone, and on a Critical Hit, the affected creatures gain the Muted Debuff.",
            ).effects[0],
            { debuffKey: "muted", critOnly: true },
          );
          assert.isEmpty(spell("You heal 1d4 slots and mend a Minor Injury Debuff.").effects);
          assert.equal(
            spell("Those who lose 2 or more Health Bar slots to this test gain the Queasy Debuff.")
              .textOnly[0]?.reason,
            "hb",
          );
        });

        it("maps every Table 11 Debuff, by name and variant, to a configured key", function () {
          for (const key of DEBUFF_KEYS) assert.property(CONFIG.CARLRPG.debuffs, key);
          for (const [key, def] of Object.entries(CONFIG.CARLRPG.debuffs)) {
            assert.equal(debuffKeyFor(game.i18n.localize(def.label)), key, def.label);
          }
          assert.equal(debuffKeyFor("Poison"), "poisoned");
          assert.equal(debuffKeyFor("the Taint"), "theTaint");
          assert.equal(debuffKeyFor("Long Term Major Injury"), "longTermMajorInjury");
          assert.isNull(debuffKeyFor("Swallowed"));
        });

        it("reads Armor-Piercing off an Attack's range", function () {
          assert.deepEqual(splitArmorPiercing("5ft, Armor-Piercing"), {
            range: "5ft",
            armorPiercing: true,
          });
          assert.deepEqual(splitArmorPiercing("10ft, Armor Piercing"), {
            range: "10ft",
            armorPiercing: true,
          });
          assert.deepEqual(splitArmorPiercing("30ft"), { range: "30ft", armorPiercing: false });
        });

        it("puts them on parsed Mob Attacks and their Attack items", function () {
          const [stabber] = parseMobs([DEBUFF_MOB_PAGE]);
          const [stab, kick, glare] = stabber.data.system.attacks;
          const triggers = (attack) =>
            attack.targetEffects.map((te) => `${te.trigger}:${te.debuffKey}`);
          assert.include(stab, { name: "Stab", range: "5ft", armorPiercing: true });
          assert.deepEqual(triggers(stab), ["majorFail:poisoned"]);
          assert.include(
            kick,
            { name: "Kick", toHit: "11+F", damage: "1d6" },
            "a to-hit line missing its colon",
          );
          assert.deepEqual(triggers(kick), ["hit:staggered", "hit:woozy"]);
          assert.isEmpty(glare.targetEffects, "behind a Stat Check: text only");
          assert.include(glare.effect, "Woozy Debuff", "and still in the text");

          const items = legacyAttackItems([
            stab,
            { ...kick, targetEffects: [{ debuffKey: "notADebuff", trigger: "hit" }] },
          ]);
          assert.isTrue(items[0].system.armorPiercing);
          assert.deepEqual(
            items[0].system.targetEffects.map((te) => te.debuffKey),
            ["poisoned"],
          );
          assert.isEmpty(items[1].system.targetEffects, "an unknown Debuff key is dropped");
        });

        it("puts them on parsed gear", function () {
          const [knuckles] = parseGear([DEBUFF_GEAR_PAGE]);
          const effects = knuckles.data.system.targetEffects;
          assert.deepEqual(
            effects.map(
              (te) =>
                `${te.debuffKey}:${te.amazingSuccessOnly}:${te.critOnly}:${te.skills.join("/")}:${te.handToHandOnly}`,
            ),
            [
              "woozy:true:false::true",
              "blinded:false:true:Test Poke:false",
              "burned:true:false::false",
            ],
          );
        });
      });

      describe("compendium copies (compendium-match)", function () {
        it("matches names whatever their apostrophes, dashes, case and parentheticals", function () {
          assert.equal(normalizeName("Test’s  Smite"), normalizeName("test's smite"));
          assert.equal(normalizeName("Test‑Can Lid"), "test-can lid");
          assert.equal(normalizeName("Scroll of Test (Rank 3)"), "scroll of test");
        });

        it("takes the best source first, then the system packs' order, and only the right type", function () {
          const sources = [
            { name: "Test Bolt", type: "spell", tier: TIERS.other, source: "module" },
            { name: "Test Bolt", type: "spell", tier: TIERS.world, source: "world" },
            { name: "Test Bolt", type: "spell", tier: TIERS.rulebook, source: "other book" },
            {
              name: "Test Bolt",
              type: "item",
              tier: TIERS.system,
              order: 0,
              source: "system item",
            },
            {
              name: "Test Bolt",
              type: "spell",
              tier: TIERS.system,
              order: 2,
              source: "system gear pack",
            },
            {
              name: "test bolt",
              type: "spell",
              tier: TIERS.system,
              order: 0,
              source: "system spells pack",
            },
          ];
          const best = (list, types = ["spell"]) =>
            buildMatcher(list)("Test Bolt", types)?.source ?? null;
          assert.equal(best(sources), "system spells pack");
          assert.equal(best(sources.slice(0, 5)), "system gear pack");
          assert.equal(best(sources.slice(0, 3)), "other book");
          assert.equal(best(sources.slice(0, 2)), "world");
          assert.equal(best(sources.slice(0, 1)), "module");
          assert.equal(best(sources, ["item"]), "system item");
          assert.isNull(best(sources, ["skill"]));
        });
      });

      describe("Floor and section headings (sections)", function () {
        const labels = { floor: (n) => `Floor ${n}`, other: "Not on a Floor" };
        const filed = (book) =>
          Object.fromEntries(
            parseMobs(book).map((m) => [
              m.name,
              sectionFolders(m.section, labels)
                .map((f) => f.name)
                .join(" / "),
            ]),
          );

        it("reads Core-style chapter openers and section headings, not the contents page", function () {
          assert.deepEqual(filed(CORE_STYLE_BOOK), {
            "Test Sample": "Not on a Floor",
            "Test Imp": "Floor 3: The Test City / Neighborhood: Testville",
            "Test Seeker": "Floor 3: The Test City / Quest: Find the Test",
            "Test Rival": "Floor 4: The Test Tangle",
            "Test Ant": "Floor 4: The Test Tangle / Neighborhood: Backyard Test (Land Quadrant)",
            "Test Mascot": "Not on a Floor",
          });
          const sectionAt = findSections(CORE_STYLE_BOOK);
          assert.include(
            sectionAt(1, 3),
            { floor: null, kind: "" },
            "a contents line is no heading",
          );
        });

        it("reads Toolkit-style Floor titles, capitalised and wrapped headings, and Floor lists", function () {
          assert.deepEqual(filed(TOOLKIT_STYLE_BOOK), {
            "Test Rat": "Not on a Floor",
            "Test Bogling": "Floor 1 / Neighborhood: Test Bogs",
            "Test Bog Brute": "Floor 1 / Neighborhood: Test Bogs",
            "Test Bog Ace": "Floor 1 / Neighborhood: Test Bogs",
            "Test Watcher": "Floor 1 / Quest: Passive (Testing) Perception",
            "Test Herald": "Floor 2",
            "Test Bruiser": "Not on a Floor",
            "Test Bogling Again": "Floor 1",
          });
        });

        it("reads a Floor's number in words or digits", function () {
          assert.equal(floorNumber("Third"), 3);
          assert.equal(floorNumber("FOURTH"), 4);
          assert.equal(floorNumber("12th"), 12);
          assert.isNull(floorNumber("Ground"));
        });
      });

      describe("import fingerprint", function () {
        it("covers only what the import wrote", function () {
          const data = {
            name: "X",
            type: "item",
            folder: "f",
            flags: { a: 1 },
            system: { a: 1, b: { c: [1, 2] } },
          };
          assert.deepEqual(writtenFields(data), ["name", "system.a", "system.b.c", "type"]);
        });

        it("tells untouched, edited, older and foreign documents apart", function () {
          const source = { name: "X", type: "item", system: { a: 1, b: 2 } };
          const flag = importStamp(source, { name: "X", type: "item", system: { a: 1 } });
          assert.equal(flag.v, FINGERPRINT_VERSION);
          assert.equal(importState(source, flag), "untouched");
          assert.equal(
            importState({ ...source, system: { a: 1, b: 9 } }, flag),
            "untouched",
            "a field it didn't write",
          );
          assert.equal(importState({ ...source, system: { a: 5, b: 2 } }, flag), "edited");
          assert.equal(
            importState({ ...source, system: { a: 5 } }, { hash: "old" }),
            "untouched",
            "pre-0.7.0: once",
          );
          assert.equal(importState(source, undefined), "notImported");
        });

        // A made-up Skill: a bonus and an Upgrade tier with one of its own.
        const sent = {
          name: "Test Skill",
          type: "skill",
          system: {
            changes: [{ targetType: "stat", target: "dex", mode: "add", value: "1" }],
            upgrades: [
              {
                rankThreshold: 5,
                changes: [{ targetType: "stat", target: "str", mode: "add", value: "2" }],
              },
            ],
          },
        };
        // As stored: the data model filled in an id.
        const stored = () => {
          const source = foundry.utils.deepClone(sent);
          source.system.changes[0].id = "aaaa";
          source.system.upgrades[0].changes[0].id = "bbbb";
          return source;
        };

        it("v2: follows arrays of objects into their elements, so a key added later isn't an edit", function () {
          const source = stored();
          const flag = importStamp(source, sent);
          assert.equal(FINGERPRINT_VERSION, 2);
          assert.include(flag.fields, "system.changes.0.value");
          assert.include(flag.fields, "system.changes.length");
          assert.include(flag.fields, "system.upgrades.0.changes.0.value");
          assert.notInclude(flag.fields, "system.changes", "not whole");

          // A later version adds a field to ChangeEntry; its default fills _source.
          const later = stored();
          later.system.changes[0].newField = false;
          later.system.upgrades[0].changes[0].newField = false;
          assert.equal(importState(later, flag), "untouched", "a new key isn't a GM edit");

          const edited = stored();
          edited.system.upgrades[0].changes[0].value = "3";
          assert.equal(importState(edited, flag), "edited");
          const added = stored();
          added.system.changes.push({
            id: "cccc",
            targetType: "stat",
            target: "int",
            mode: "add",
            value: "1",
          });
          assert.equal(importState(added, flag), "edited", "a bonus the GM added");
        });

        it("v1: a matching old hash is untouched and re-stamped as v2; a mismatch stays edited", function () {
          const source = stored();
          const fields = ["name", "system.changes", "system.upgrades", "type"];
          const v1 = { v: 1, fields, hash: fingerprint(source, fields) };
          assert.equal(importState(source, v1), "untouched");
          const edited = stored();
          edited.system.changes[0].value = "4";
          assert.equal(
            importState(edited, v1),
            "edited",
            "a v1 edit isn't forgiven by the version bump",
          );

          const v2 = restamp(source, v1);
          assert.equal(v2.v, FINGERPRINT_VERSION);
          assert.include(v2.fields, "system.changes.0.value");
          assert.notInclude(v2.fields, "system.changes");
          assert.equal(importState(source, v2), "untouched");
          const later = stored();
          later.system.changes[0].newField = false;
          assert.equal(importState(later, v2), "untouched", "re-stamped: new keys no longer count");
          assert.isNull(restamp(source, { hash: "old" }), "no fields: nothing to restamp");
        });

        it("restamp: a migration's write on an untouched document isn't read as an edit", function () {
          const source = stored();
          const flag = importStamp(source, sent);
          const migrated = stored();
          migrated.system.changes[0].value = "2";
          migrated.system.changes.push({
            id: "dddd",
            targetType: "resource",
            target: "dr",
            mode: "add",
            value: "1",
          });
          assert.equal(importState(migrated, flag), "edited", "without a restamp");
          const again = restamp(migrated, flag);
          assert.equal(importState(migrated, again), "untouched");
          assert.include(
            again.fields,
            "system.changes.1.value",
            "the array is re-read as it is now",
          );
          const gm = foundry.utils.deepClone(migrated);
          gm.system.changes[1].value = "5";
          assert.equal(importState(gm, again), "edited");
        });
      });

      describe("which book (books.mjs)", function () {
        // Made-up title pages in the books' layout (no book text): big,
        // slightly slanted cover titles, drawn twice like the real ones.
        const item = (str, size, y, angle = 0) => ({
          str,
          x: 60,
          y,
          size,
          width: str.length * size * 0.5,
          angle,
          font: "",
        });
        const coreCover = [
          item("CORE RULEBOOK", 51, 93, 7),
          item("CORE RULEBOOK", 51, 93, 7),
          item("TEST EDITION", 30, 53, 7),
        ];
        const toolkitCover = [
          item("GAME MASTER’S", 61, 87, 4.5),
          item("CAMPAIGN TOOLKIT", 49, 40, 4.5),
        ];
        const otherCover = [item("CRAWLERS &", 80, 85), item("CUSTOMIZATION", 60, 30)];
        const credits = [item("Test text for the Dungeon Crawler Carl Roleplaying Game.", 10, 600)];
        /** A pdf.js document stand-in: these pages' text, nothing else (no file, no name). */
        const fakePdf = (pages) => ({
          numPages: pages.length,
          getPage: async (n) => ({
            getTextContent: async () => ({
              items: pages[n - 1].map((i) => ({
                str: i.str,
                width: i.width,
                fontName: "",
                transform: [
                  i.size * Math.cos((i.angle * Math.PI) / 180),
                  i.size * Math.sin((i.angle * Math.PI) / 180),
                  -i.size * Math.sin((i.angle * Math.PI) / 180),
                  i.size * Math.cos((i.angle * Math.PI) / 180),
                  i.x,
                  i.y,
                ],
              })),
            }),
            cleanup: () => {},
          }),
        });

        it("reads the book from its title page, with a fixed id", async function () {
          assert.equal(identifyBook([coreCover, credits]), BOOKS.core);
          assert.equal(identifyBook([toolkitCover, credits]), BOOKS.toolkit);
          assert.equal(BOOKS.core.id, "core");
          assert.equal(BOOKS.toolkit.id, "toolkit");
          assert.equal(
            (await identifyPdf(fakePdf([coreCover, credits]))).id,
            "core",
            "from pdf.js text",
          );
          assert.equal((await identifyPdf(fakePdf([toolkitCover, [], credits]))).id, "toolkit");
        });

        it("rejects any other PDF, with a message that echoes nothing from it", async function () {
          assert.isNull(identifyBook([otherCover, credits]), "the Starter Set's Crawlers booklet");
          assert.isNull(identifyBook([coreCover]), "another game's Core Rulebook");
          assert.isNull(identifyBook([credits]));
          let error = null;
          try {
            await identifyPdf(fakePdf([otherCover, credits]));
          } catch (err) {
            error = err;
          }
          assert.instanceOf(error, UnknownBookError);
          assert.notInclude(
            error.message.toUpperCase(),
            "CUSTOMIZATION",
            "nothing read from the PDF",
          );
          assert.notEqual(
            game.i18n.localize("CARLRPG.PdfImport.UnknownBook"),
            "CARLRPG.PdfImport.UnknownBook",
          );
        });

        it("never reads the file name: the same pages are the same book, and the old helper is gone", async function () {
          // identifyPdf is given only the document; whatever the file was
          // called, the same title page gives the same id.
          for (const name of [
            "Carl RPG.pdf",
            "renamed-anything.pdf",
            "Starter Set - Gamemaster's Toolkit.pdf",
          ]) {
            const pdf = Object.assign(fakePdf([coreCover, credits]), { name });
            assert.equal((await identifyPdf(pdf)).id, "core", name);
          }
          assert.isUndefined(scan.bookTitleFromFilename);
        });

        it("reads an earlier development import's file-name key as the book's id", function () {
          assert.equal(bookIdOf("carl-rpg"), "core");
          assert.equal(bookIdOf("starter-set-gamemaster-s-toolkit"), "toolkit");
          assert.equal(bookIdOf("gamemasters-toolkit"), "toolkit");
          assert.equal(bookIdOf("core"), "core");
          assert.equal(
            bookIdOf("carlrpg-starter-set-crawlers"),
            "carlrpg-starter-set-crawlers",
            "not a book of ours",
          );
          assert.isUndefined(bookIdOf(undefined));
        });
      });

      describe("the import dialog", function () {
        useQuenchTimeout(this);

        it("selects all or no maps at once", async function () {
          const found = { gear: [{}], spells: [], mobs: [], achievements: [] };
          const maps = [
            {
              page: 3,
              name: "Test Map A",
              likely: true,
              thumb: URL.createObjectURL(new Blob(["a"], { type: "image/png" })),
            },
            {
              page: 7,
              name: "Test Map B",
              likely: false,
              thumb: URL.createObjectURL(new Blob(["b"], { type: "image/png" })),
            },
          ];
          const boxes = (dialog) => [
            ...dialog.element.querySelectorAll('.carl-pdf-import-map input[type="checkbox"]'),
          ];
          const choice = await withDialog(
            () => chooseContent("Quench Test Book", found, maps),
            async (dialog) => {
              // The blob: thumbnails survive into the dialog (Foundry's HTML
              // cleaning would strip them from string content).
              const srcs = [...dialog.element.querySelectorAll(".carl-pdf-import-map img")].map(
                (i) => i.getAttribute("src"),
              );
              assert.deepEqual(
                srcs,
                maps.map((m) => m.thumb),
                "the thumbnails' blob: URLs are kept",
              );
              assert.deepEqual(
                boxes(dialog).map((b) => b.checked),
                [true, false],
                "likely maps start checked",
              );
              dialog.element.querySelector('[data-map-select="all"]').click();
              assert.isTrue(
                boxes(dialog).every((b) => b.checked),
                "Select all",
              );
              dialog.element.querySelector('[data-map-select="none"]').click();
              assert.isTrue(
                boxes(dialog).every((b) => !b.checked),
                "Select none",
              );
              pressDialog(dialog, "import");
            },
            "carl-pdf-import-dialog",
          );
          for (const m of maps) URL.revokeObjectURL(m.thumb);
          assert.isFalse(Object.values(choice.map ?? {}).some(Boolean), "no maps chosen");
          assert.isTrue(choice.kind?.gear, "the content choice is untouched");
        });

        it("keeps every map thumbnail made before a later page fails, so each can be revoked", async function () {
          const page = {
            view: [0, 0, 612, 792],
            getOperatorList: async () =>
              opList([
                ["save"],
                ["transform", [560, 0, 0, 700, 20, 40]],
                ["paintImageXObject", ["img_map", 2, 2]],
                ["restore"],
              ]),
            objs: {
              get: (id, done) =>
                done({ width: 2, height: 2, kind: 3, data: new Uint8Array(16).fill(200) }),
            },
            commonObjs: { get: () => {} },
            cleanup() {},
          };
          const pdfDoc = {
            getPage: async (n) => {
              if (n === 1) return page;
              throw new Error("Quench: page unreadable");
            },
          };
          const candidates = [
            { page: 1, name: "Test Map A" },
            { page: 2, name: "Test Map B" },
          ];
          const maps = [];
          let error = null;
          try {
            await resolveMaps(pdfDoc, { OPS }, candidates, { update() {} }, maps);
          } catch (err) {
            error = err;
          } finally {
            for (const m of maps) URL.revokeObjectURL(m.thumb);
          }
          assert.equal(error?.message, "Quench: page unreadable");
          assert.lengthOf(maps, 1, "the first map's thumbnail is in the caller's array");
          assert.match(maps[0].thumb, /^blob:/);
        });
      });

      describe("opening and closing the PDF (pdf-loader)", function () {
        useQuenchTimeout(this);

        it("closes a document through its loading task (pdf.js 6 documents have no destroy)", async function () {
          let destroyed = 0;
          const pdfDoc = {
            loadingTask: {
              destroy: async () => {
                destroyed += 1;
              },
            },
          };
          await closePdfDocument(pdfDoc);
          assert.equal(destroyed, 1);
        });

        it("never throws or rejects: nothing open, or a close that fails", async function () {
          await closePdfDocument(null);
          await closePdfDocument({});
          const warn = console.warn;
          console.warn = () => {};
          try {
            await closePdfDocument({
              loadingTask: {
                destroy: async () => {
                  throw new Error("Quench: close failed");
                },
              },
            });
          } finally {
            console.warn = warn;
          }
        });

        it("opens and closes a real document, ending its worker", async function () {
          const { pdfDoc } = await loadPdfDocument(tinyPdfFile());
          assert.equal(pdfDoc.numPages, 1);
          assert.notTypeOf(pdfDoc.destroy, "function", "why the old pdfDoc.destroy() threw");
          await closePdfDocument(pdfDoc);
          assert.isTrue(pdfDoc.loadingTask.destroyed);
        });

        it("a file pdf.js can't open is rejected, and its loading task destroyed", async function () {
          const pdfjs = await getPdfJs();
          // The loading task's class isn't exported: reach its prototype through one.
          const probe = pdfjs.getDocument({ data: new Uint8Array([0]) });
          const proto = Object.getPrototypeOf(probe);
          await probe.destroy().catch(() => {});
          const original = proto.destroy;
          let destroyed = 0;
          proto.destroy = function (...args) {
            destroyed += 1;
            return original.apply(this, args);
          };
          let error = null;
          try {
            await loadPdfDocument(new File([new Uint8Array([1, 2, 3, 4])], "quench-garbage.pdf"));
          } catch (err) {
            error = err;
          } finally {
            proto.destroy = original;
          }
          assert.exists(error, "a garbage file is rejected");
          assert.equal(destroyed, 1, "its worker was ended");
        });
      });

      describe("importBook", function () {
        useQuenchTimeout(this);
        const title = "Quench PDF Import Test Book";
        const otherTitle = "Quench PDF Import Other Book";
        const book = "quench-pdf-import-test-book";
        const otherBook = "quench-pdf-import-other-book";
        const worldItems = [];
        const docsOf = async (b, type) => (await findBookPack(b, type)?.getDocuments()) ?? [];
        const docNamed = async (b, type, name) =>
          (await docsOf(b, type)).find((d) => d.name === name);
        const parsedItem = (name, type, description = "<p>parsed</p>") => ({
          name,
          page: 2,
          data: { name, type, img: "icons/svg/item-bag.svg", system: { description } },
        });
        const none = { gear: [], spells: [], mobs: [], achievements: [] };

        async function cleanUp() {
          for (const b of [book, otherBook]) {
            for (const type of ["Actor", "Item", "JournalEntry"]) {
              const pack = findBookPack(b, type);
              if (!pack) continue;
              if (pack.locked) await pack.configure({ locked: false });
              await pack.deleteCompendium();
            }
            for (const folder of game.folders.filter(
              (f) => f.type === "Compendium" && f.getFlag("carl-rpg", "pdfImport")?.book === b,
            ))
              await folder.delete();
          }
          for (const folder of game.folders.filter((f) => [title, otherTitle].includes(f.name)))
            await folder.delete();
          for (const item of worldItems.splice(0)) if (game.items.get(item.id)) await item.delete();
        }
        before(cleanUp);
        after(cleanUp);

        it("imports into world compendiums named after the book, then updates them", async function () {
          const found = {
            gear: parseGear([GEAR_PAGE]),
            spells: [],
            mobs: parseMobs([MOB_PAGE]),
            achievements: parseAchievements([achievementPage(0)]),
          };
          const kinds = ["gear", "mobs", "achievements"];
          const first = await importBook({ book, title, found, kinds, maps: [] });
          assert.include(first.items, { created: 1, updated: 0 });
          assert.isEmpty(first.items.skipped);
          assert.deepEqual(first.mobs, { created: 2, updated: 0, skipped: [] });
          assert.deepEqual(first.achievements, { created: 1, updated: 0, skipped: [] });

          for (const type of ["Actor", "Item"]) {
            const pack = findBookPack(book, type);
            assert.ok(pack, `a ${type} compendium`);
            assert.equal(pack.metadata.packageType, "world");
            assert.include(pack.metadata.label, title);
          }
          assert.isFalse(
            game.folders.some(
              (f) => f.name === title && ["Actor", "Item", "JournalEntry"].includes(f.type),
            ),
            "no world folders",
          );
          assert.isFalse(
            game.actors.some((a) => a.getFlag("carl-rpg", "pdfImport")?.book === book),
            "nothing in the world",
          );
          assert.isFalse(
            game.packs
              .get("carl-rpg.gear")
              .index.some((e) => e.name === "Test Widget of Never-Ending Doom"),
            "the system's packs are untouched",
          );

          const itemPack = findBookPack(book, "Item");
          const widget = await docNamed(book, "Item", "Test Widget of Never-Ending Doom");
          assert.equal(
            itemPack.folders.get(widget._source.folder)?.name,
            game.i18n.localize("CARLRPG.PdfImport.Kind.gear"),
          );
          const blob = await docNamed(book, "Actor", "Test Blob");
          assert.equal(blob.system.hb.max, 3);
          assert.equal(blob.flags["carl-rpg"].pdfImport.book, book);
          assert.equal(blob.flags["carl-rpg"].pdfImport.v, FINGERPRINT_VERSION);
          const printed = found.mobs.find((m) => m.name === "Test Blob").data.system.attacks;
          assert.lengthOf(mobAttacksOf(blob), printed.length, "its Attacks are items");
          assert.lengthOf(blob.system.attacks, 0, "and not the old list");
          // A Boss's token is linked on create (a unique creature); a plain Mob
          // keeps the unlinked default. The re-import below still counts both
          // as unedited, so the link isn't part of the fingerprint.
          const queen = await docNamed(book, "Actor", "Test Blob Queen");
          assert.isTrue(queen.prototypeToken.actorLink, "a Boss imports linked");
          assert.isFalse(blob.prototypeToken.actorLink, "a Mob imports unlinked");
          const pilot = await docNamed(book, "Item", "Test Pilot!");
          assert.equal(pilot.type, "achievement", "achievements are Achievement items");
          assert.equal(
            itemPack.folders.get(pilot._source.folder)?.name,
            game.i18n.localize("CARLRPG.PdfImport.Kind.achievements"),
          );
          assert.isNull(findBookPack(book, "JournalEntry"), "no achievements journal");

          const second = await importBook({ book, title, found, kinds, maps: [] });
          assert.include(second.items, { created: 0, updated: 1 });
          assert.deepEqual(second.mobs, { created: 0, updated: 2, skipped: [] });
          assert.deepEqual(second.achievements, { created: 0, updated: 1, skipped: [] });
          assert.lengthOf(
            mobAttacksOf(await docNamed(book, "Actor", "Test Blob")),
            printed.length,
            "not doubled",
          );
        });

        it("refreshes the Attacks the GM didn't edit, keeps the ones they did, and remakes deleted ones", async function () {
          const found = { ...none, mobs: parseMobs([DEBUFF_MOB_PAGE]) };
          await importBook({ book, title, found, kinds: ["mobs"], maps: [] });
          let stabber = await docNamed(book, "Actor", "Test Stabber");
          const [stab, kick] = mobAttacksOf(stabber);
          assert.isTrue(stab.system.armorPiercing);
          assert.deepEqual(
            stab.system.targetEffects.map((te) => `${te.trigger}:${te.debuffKey}`),
            ["majorFail:poisoned"],
          );
          assert.deepEqual(
            kick.system.targetEffects.map((te) => `${te.trigger}:${te.debuffKey}`),
            ["hit:staggered", "hit:woozy"],
          );
          const stabId = stab.id;
          // The GM edits Kick, and adds an Attack of their own.
          await kick.update({
            "system.targetEffects": [{ debuffKey: "held", trigger: "majorFail" }],
          });
          await stabber.createEmbeddedDocuments("Item", [
            { name: "GM Bite", type: "mobAttack", system: { damage: "1d4" } },
          ]);

          // A later parse changes every Attack.
          const reprint = parseMobs([DEBUFF_MOB_PAGE]);
          for (const attack of reprint[0].data.system.attacks) attack.damage = "2d6";
          const again = await importBook({
            book,
            title,
            found: { ...none, mobs: reprint },
            kinds: ["mobs"],
            maps: [],
          });
          assert.equal(again.mobs.updated, 1);
          stabber = await docNamed(book, "Actor", "Test Stabber");
          const byName = Object.fromEntries(mobAttacksOf(stabber).map((a) => [a.name, a]));
          assert.equal(byName.Stab.id, stabId, "updated in place");
          assert.equal(byName.Stab.system.damage, "2d6", "an unedited Attack takes the new parse");
          assert.equal(byName.Glare.system.damage, "2d6");
          assert.equal(byName.Kick.system.damage, "1d6", "the GM's edited Attack is kept");
          assert.equal(byName.Kick.system.targetEffects[0]?.debuffKey, "held");
          assert.ok(byName["GM Bite"], "an Attack the GM added stays");
          assert.lengthOf(mobAttacksOf(stabber), 4);

          await stabber.deleteEmbeddedDocuments("Item", [stabId]);
          await importBook({
            book,
            title,
            found: { ...none, mobs: reprint },
            kinds: ["mobs"],
            maps: [],
          });
          stabber = await docNamed(book, "Actor", "Test Stabber");
          assert.ok(
            mobAttacksOf(stabber).find((a) => a.name === "Stab"),
            "made again once deleted",
          );
          assert.lengthOf(mobAttacksOf(stabber), 4);
        });

        it("skips a document the GM edited, not one a newer parse writes more fields on", async function () {
          const found = { ...none, gear: parseGear([GEAR_PAGE]), mobs: parseMobs([MOB_PAGE]) };
          const older = parseMobs([MOB_PAGE]);
          for (const m of older) delete m.data.system.move;
          await importBook({
            book,
            title,
            found: { ...found, mobs: older },
            kinds: ["gear", "mobs"],
            maps: [],
          });
          const blob = await docNamed(book, "Actor", "Test Blob");
          await blob.update({ "system.stats.con.value": 9 });

          const again = await importBook({ book, title, found, kinds: ["gear", "mobs"], maps: [] });
          assert.deepEqual(again.mobs.skipped, ["Test Blob"]);
          assert.equal(
            again.mobs.updated,
            1,
            "the unedited Mob still updates, though the parse now writes Move",
          );
          assert.equal(
            (await docNamed(book, "Actor", "Test Blob")).system.stats.con.value,
            9,
            "the GM's edit survives",
          );
        });

        it("treats a pre-0.7.0 import as untouched once, and leaves the GM's own documents alone", async function () {
          const pack = findBookPack(book, "Item");
          await Item.implementation.createDocuments(
            [
              {
                name: "Test Old Import",
                type: "item",
                system: { description: "<p>changed since</p>" },
                flags: { "carl-rpg": { pdfImport: { book, page: 2, hash: "oldhash" } } },
              },
              { name: "Test GM Item", type: "item", system: { description: "<p>mine</p>" } },
            ],
            { pack: pack.collection },
          );
          const gear = [
            parsedItem("Test Old Import", "item", "<p>new</p>"),
            parsedItem("Test GM Item", "item"),
          ];
          const first = await importBook({
            book,
            title,
            found: { ...none, gear },
            kinds: ["gear"],
            maps: [],
          });
          assert.equal(first.items.updated, 1);
          assert.deepEqual(first.items.skipped, ["Test GM Item"]);
          const old = await docNamed(book, "Item", "Test Old Import");
          assert.equal(old.system.description, "<p>new</p>");
          assert.equal(old.flags["carl-rpg"].pdfImport.v, FINGERPRINT_VERSION, "re-baselined");
          assert.equal(
            (await docNamed(book, "Item", "Test GM Item")).system.description,
            "<p>mine</p>",
          );

          await old.update({ "system.description": "<p>the GM's</p>" });
          const second = await importBook({
            book,
            title,
            found: { ...none, gear },
            kinds: ["gear"],
            maps: [],
          });
          assert.sameMembers(
            second.items.skipped,
            ["Test Old Import", "Test GM Item"],
            "only once",
          );
        });

        it("prefers compendium copies: the system's packs, then another book's, then world Items", async function () {
          // Another book's compendium has one; the world has it and a system Spell too.
          await importBook({
            book: otherBook,
            title: otherTitle,
            found: {
              ...none,
              gear: [parsedItem("Quench Test Ranked", "item", "<p>other book</p>")],
            },
            kinds: ["gear"],
            maps: [],
          });
          worldItems.push(
            ...(await Item.implementation.createDocuments([
              { name: "Fear", type: "spell", system: { description: "<p>world copy</p>" } },
              {
                name: "Quench Test Ranked",
                type: "item",
                system: { description: "<p>world copy</p>" },
              },
              {
                name: "Quench Test Copyable",
                type: "item",
                system: { description: "<p>world copy</p>" },
              },
              {
                name: "Quench Test Own",
                type: "item",
                system: { description: "<p>this book's old import</p>" },
                flags: { "carl-rpg": { pdfImport: { book } } },
              },
            ])),
          );

          const sources = await matchCandidates(book);
          assert.isFalse(
            sources.some((s) => s.name === "Quench Test Own"),
            "never this book's own import",
          );
          assert.isFalse(
            sources.some((s) => s.source === findBookPack(book, "Item").collection),
            "or its compendium",
          );

          const result = await importBook({
            book,
            title,
            found: {
              ...none,
              spells: [parsedItem("Fear", "spell")],
              gear: [
                parsedItem("Quench Test Ranked", "item"),
                parsedItem("Quench Test Copyable", "item"),
                parsedItem("Quench Test Own", "item"),
              ],
            },
            kinds: ["gear", "spells"],
            maps: [],
          });
          assert.include(result.items.matched, { spells: 1, gear: 2 });

          const source = async (name) =>
            (await docNamed(book, "Item", name))?._stats?.compendiumSource ?? "";
          assert.match(
            await source("Fear"),
            /^Compendium\.carl-rpg\.skills-and-spells\./,
            "the system's Spell",
          );
          const fear = await docNamed(book, "Item", "Fear");
          assert.notInclude(fear.system.description, "world copy");
          assert.isTrue(
            fear.system.upgrades.some((u) => (u.targetEffects ?? []).length),
            "with the pack's authored upgrade Debuffs",
          );
          assert.equal(
            findBookPack(book, "Item").folders.get(fear._source.folder)?.name,
            game.i18n.localize("CARLRPG.PdfImport.Kind.spells"),
          );
          assert.include(
            await source("Quench Test Ranked"),
            findBookPack(otherBook, "Item").collection,
            "another book's",
          );
          const copyable = worldItems.find((i) => i.name === "Quench Test Copyable");
          assert.equal(await source("Quench Test Copyable"), copyable.uuid, "a world Item");
          assert.equal(
            (await docNamed(book, "Item", "Quench Test Own")).system.description,
            "<p>parsed</p>",
            "not its own old import",
          );
        });

        it("files Mobs by Floor, then Neighborhood or Quest, by Level, and files unedited ones on re-import", async function () {
          const found = { ...none, mobs: parseMobs(TOOLKIT_STYLE_BOOK) };
          await importBook({ book, title, found, kinds: ["mobs"], maps: [] });
          const pack = findBookPack(book, "Actor");
          const pathOf = (doc) => {
            const names = [];
            for (let id = doc._source.folder; id; id = pack.folders.get(id)?._source.folder) {
              names.unshift(pack.folders.get(id)?.name);
            }
            return names.join(" / ");
          };
          const named = async () =>
            Object.fromEntries((await docsOf(book, "Actor")).map((d) => [d.name, d]));
          const floor = (n) => game.i18n.format("CARLRPG.PdfImport.FloorFolder", { n });
          const other = game.i18n.localize("CARLRPG.PdfImport.OtherMobs");
          let mobs = await named();
          assert.equal(pathOf(mobs["Test Bogling"]), `${floor(1)} / Neighborhood: Test Bogs`);
          assert.equal(
            pathOf(mobs["Test Watcher"]),
            `${floor(1)} / Quest: Passive (Testing) Perception`,
          );
          assert.equal(pathOf(mobs["Test Herald"]), floor(2));
          assert.equal(pathOf(mobs["Test Bogling Again"]), floor(1));
          assert.equal(pathOf(mobs["Test Bruiser"]), other);
          const [ace, brute, bogling] = ["Test Bog Ace", "Test Bog Brute", "Test Bogling"].map(
            (n) => mobs[n].sort,
          );
          assert.isBelow(ace, brute, "same Level: by name");
          assert.isBelow(brute, bogling, "by Level");
          const top = (name) => pack.folders.find((f) => f.name === name && !f._source.folder);
          assert.isBelow(top(floor(1)).sort, top(floor(2)).sort, "Floors in the book's order");
          assert.isBelow(top(floor(2)).sort, top(other).sort);

          // As an earlier import left them: an unedited Mob is filed on
          // re-import; one the GM edited stays where it is.
          await mobs["Test Herald"].update({ folder: null });
          await mobs["Test Bruiser"].update({ folder: null, "system.level": 9 });
          const again = await importBook({ book, title, found, kinds: ["mobs"], maps: [] });
          assert.deepEqual(again.mobs.skipped, ["Test Bruiser"]);
          mobs = await named();
          assert.equal(pathOf(mobs["Test Herald"]), floor(2));
          assert.equal(pathOf(mobs["Test Bruiser"]), "");
          assert.lengthOf(
            pack.folders.filter((f) => f.name === floor(1)),
            1,
            "folders are found again, not made twice",
          );
        });

        it("never matches Mobs across books by name", async function () {
          const higher = parseMobs([DEBUFF_MOB_PAGE]);
          higher[0].data.system.level = 65;
          const other = await importBook({
            book: otherBook,
            title: otherTitle,
            found: { ...none, mobs: higher },
            kinds: ["mobs"],
            maps: [],
          });
          assert.equal(other.mobs.created, 1, "its own Mob, not the other book's");
          assert.notEqual(
            findBookPack(otherBook, "Actor").collection,
            findBookPack(book, "Actor").collection,
          );
          assert.equal((await docNamed(otherBook, "Actor", "Test Stabber")).system.level, 65);
          assert.equal((await docNamed(book, "Actor", "Test Stabber")).system.level, 3);
        });

        it("with no book given, matches every source (nothing is taken for the book's own)", async function () {
          for (const noBook of [undefined, null]) {
            const sources = await matchCandidates(noBook);
            assert.isTrue(
              sources.some((s) => s.source === "carl-rpg.skills-and-spells" && s.name === "Fear"),
              `system packs (${noBook})`,
            );
            assert.isTrue(
              sources.some((s) => s.source === findBookPack(book, "Item").collection),
              "a book's compendium too",
            );
          }
          assert.isNull(findBookPack(undefined, "Item"), "no book, no pack");
        });

        it("an achievement the GM edited isn't overwritten by a re-import", async function () {
          const found = { ...none, achievements: parseAchievements([achievementPage(0)]) };
          await importBook({ book, title, found, kinds: ["achievements"], maps: [] });
          const pilot = await docNamed(book, "Item", "Test Pilot!");
          await pilot.update({ "system.reward": "The GM's own reward" });
          const again = await importBook({ book, title, found, kinds: ["achievements"], maps: [] });
          assert.deepEqual(again.achievements.skipped, ["Test Pilot!"]);
          const kept = await docNamed(book, "Item", "Test Pilot!");
          assert.equal(kept.system.reward, "The GM's own reward");
        });
      });
    },
    { displayName: "CarlRPG: Rulebook PDF Import" },
  );
}
