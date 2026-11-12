import { findGutter, layoutLines, titleCase } from "../../pdf-import/page-text.mjs";
import { parseAchievements } from "../../pdf-import/parse-achievements.mjs";
import { bulletToChanges, parseGear } from "../../pdf-import/parse-gear.mjs";
import { parseMobs } from "../../pdf-import/parse-mobs.mjs";
import { importBook } from "../../pdf-import/importer.mjs";
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
          assert.equal(s.size, "Small (2)");
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
          assert.deepEqual(first.items, { created: 1, updated: 0 });
          assert.deepEqual(first.mobs, { created: 2, updated: 0 });
          assert.deepEqual(first.achievements, { created: 1, updated: 0 });

          const blob = game.actors.find((a) => a.name === "Test Blob" && a.folder?.name === title);
          assert.equal(blob.system.hb.max, 3);
          assert.equal(blob.system.stats.con.value, 6);
          assert.equal(blob.flags["carl-rpg"].pdfImport.book, "quench-pdf-import-test-book");

          const second = await importBook({ title, found, kinds, maps: [] });
          assert.deepEqual(second.items, { created: 0, updated: 1 });
          assert.deepEqual(second.mobs, { created: 0, updated: 2 });
          assert.deepEqual(second.achievements, { created: 0, updated: 1 });
        });
      });
    },
    { displayName: "CarlRPG: Rulebook PDF Import" },
  );
}
