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
import { importBook } from "../../pdf-import/importer.mjs";
import { imageDraws, imageToRGBA, imageTransform, orientRGBA, pickMapDraw } from "../../pdf-import/maps.mjs";
import {
  imagePpis,
  judgeImageQuality,
  LOW_QUALITY_PPI,
  LowQualityPdfError,
  samplePages,
} from "../../pdf-import/quality.mjs";
import { parseSizeText } from "../../helpers/size-text.mjs";
import { mobAttacksOf } from "../../helpers/mob-attacks.mjs";
import { useQuenchTimeout } from "../helpers.mjs";

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
      const { describe, it, assert, after } = context;

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
            const html = found.data.text.content;
            assert.include(html, "You pressed every button in the cockpit. Some of them twice.");
            assert.include(html, "<strong>Reward:</strong> You've received a Bronze Button Box!");
            assert.include(html, "<strong>Contents:</strong> One big red button");
            assert.notInclude(html, "body prose");
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
            isDrmText("Downloaded by Jo O'Neil-Smith Jr. on 2030-01-02. Unauthorized distribution prohibited."),
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
            ["Comma Golem", "Gap Rat", "Test Captain", "Shifty Blob", "Test Questmaster", "Kibril Atheras Darkoak"],
            "the Vehicle is skipped",
          );
          assert.include(byName("Comma Golem"), { size: 5, creatureType: "Construct", isElite: false });
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
          assert.include(glare, { name: "Glare", toHit: "14+F", damage: "1d4", damageType: "psychic" });
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
          assert.isFalse(judgeImageQuality(Array(30).fill(200)).lowQuality, "full quality (200 ppi)");
          assert.isTrue(judgeImageQuality(Array(30).fill(72)).lowQuality, "Core LQ (72 ppi)");
          assert.isTrue(judgeImageQuality(Array(30).fill(100)).lowQuality, "Starter Set LQ (100 ppi)");
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
          const message = game.i18n.format("CARLRPG.PdfImport.LowQuality", { title: "Test Book", ppi: 72 });
          assert.include(message, "Test Book");
          assert.include(message, "72");
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
          const rgb = imageToRGBA({ width: 2, height: 1, kind: 2, data: new Uint8Array([255, 0, 0, 0, 0, 255]) });
          assert.deepEqual([...rgb], [255, 0, 0, 255, 0, 0, 255, 255]);
          const rgba = imageToRGBA({ width: 1, height: 1, kind: 3, data: new Uint8Array([1, 2, 3, 4]) });
          assert.deepEqual([...rgba], [1, 2, 3, 4], "alpha kept (a soft mask pdf.js already applied)");
          const bits = imageToRGBA({ width: 2, height: 1, kind: 1, data: new Uint8Array([0b01000000]) });
          assert.deepEqual([...bits], [0, 0, 0, 255, 255, 255, 255, 255]);
          // Drawn a quarter turn clockwise: red on top, blue below.
          const out = orientRGBA(rgb, 2, 1, imageTransform([0, -100, 50, 0, 0, 100], 2, 1));
          assert.deepEqual([out.width, out.height], [1, 2]);
          assert.deepEqual([...out.data], [255, 0, 0, 255, 0, 0, 255, 255]);
        });
      });

      describe("importBook", function () {
        useQuenchTimeout(this);
        const title = "Quench PDF Import Test Book";

        after(async function () {
          for (const folder of game.folders.filter((f) => f.name === title)) {
            const docs = folder.contents;
            if (docs.length) await docs[0].constructor.deleteDocuments(docs.map((d) => d.id));
            await folder.delete();
          }
        });

        it("creates documents in book folders, then updates them on re-import", async function () {
          const found = {
            gear: parseGear([GEAR_PAGE]),
            spells: [],
            mobs: parseMobs([MOB_PAGE]),
            achievements: parseAchievements([achievementPage(0)]),
          };
          const kinds = ["gear", "mobs", "achievements"];
          const first = await importBook({ title, found, kinds, maps: [] });
          assert.deepEqual(first.items, { created: 1, updated: 0, skipped: [] });
          assert.deepEqual(first.mobs, { created: 2, updated: 0, skipped: [] });
          assert.deepEqual(first.achievements, { created: 1, updated: 0, skipped: [] });

          const blob = game.actors.find((a) => a.name === "Test Blob" && a.folder?.name === title);
          assert.equal(blob.system.hb.max, 3);
          assert.equal(blob.system.stats.con.value, 6);
          assert.equal(blob.flags["carl-rpg"].pdfImport.book, "quench-pdf-import-test-book");
          const printed = found.mobs.find((m) => m.name === "Test Blob").data.system.attacks;
          assert.isAbove(printed.length, 0);
          assert.lengthOf(mobAttacksOf(blob), printed.length, "its Attacks are items");
          assert.equal(mobAttacksOf(blob)[0].name, printed[0].name);
          assert.lengthOf(blob.system.attacks, 0, "and not the old list");

          const second = await importBook({ title, found, kinds, maps: [] });
          assert.deepEqual(second.items, { created: 0, updated: 1, skipped: [] });
          assert.deepEqual(second.mobs, { created: 0, updated: 2, skipped: [] });
          assert.deepEqual(second.achievements, { created: 0, updated: 1, skipped: [] });
          assert.lengthOf(mobAttacksOf(blob), printed.length, "a re-import doesn't double them");

          // The GM's work on an Attack survives a re-import; Attacks deleted are made again.
          await mobAttacksOf(blob)[0].update({ "system.targetEffects": [{ debuffKey: "poisoned", trigger: "majorFail" }] });
          await importBook({ title, found, kinds, maps: [] });
          assert.equal(mobAttacksOf(blob)[0].system.targetEffects[0]?.trigger, "majorFail", "never replaced");
          await blob.deleteEmbeddedDocuments("Item", mobAttacksOf(blob).map((a) => a.id));
          await importBook({ title, found, kinds, maps: [] });
          assert.lengthOf(mobAttacksOf(blob), printed.length, "made again once deleted");
        });

        it("leaves a document the GM edited alone on re-import", async function () {
          const found = {
            gear: parseGear([GEAR_PAGE]),
            spells: [],
            mobs: parseMobs([MOB_PAGE]),
            achievements: [],
          };
          const kinds = ["gear", "mobs"];
          await importBook({ title, found, kinds, maps: [] });
          const blob = game.actors.find((a) => a.name === "Test Blob" && a.folder?.name === title);
          await blob.update({ "system.stats.con.value": 9 });

          const again = await importBook({ title, found, kinds, maps: [] });
          assert.deepEqual(again.mobs.skipped, ["Test Blob"]);
          assert.equal(again.mobs.updated, 1, "the unedited Mob still updates");
          assert.equal(blob.system.stats.con.value, 9, "the GM's edit survives");
        });
      });
    },
    { displayName: "CarlRPG: Rulebook PDF Import" },
  );
}
