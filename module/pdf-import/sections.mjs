/**
 * Where in the dungeon each part of a book is: its Floor, and the
 * Neighborhood or Quest within it - read from the headings on the pages
 * themselves, never from page numbers (a later printing moves them). Used
 * to file imported Mobs (importer.mjs).
 *
 * Both books' layouts are read:
 *  - a Floor's title, set large: "The Third Floor: The Over City" on a
 *    Core Rulebook chapter opener, "The First Floor" in the Starter Set
 *    Gamemaster's Toolkit;
 *  - a Floor heading over a list of Mobs ("FIRST FLOOR MOBS", the Toolkit's
 *    Threat Appendix): that Floor, no Neighborhood;
 *  - a section heading, "Neighborhood: Heavensworth" (Core) or
 *    "NEIGHBORHOOD: BOGBRICKS" (Toolkit), "Quest: ...", which may wrap onto
 *    more lines at the same size ("(Land Quadrant)", "PERCEPTION"); Core
 *    prints "Floor: 3 - Theme: ..." under it;
 *  - a chapter or appendix title ("CHAPTER 5", "Appendix 1: Iconic Gear",
 *    "Threat Appendix") ends the Floor, unless it opens one.
 * Contents pages set these in small type with dot leaders, and running
 * headers sit in the margins (not in a page's lines): neither counts.
 *
 * Pure (no Foundry globals), so the Node preview tool runs it too.
 */

import { titleCase } from "./page-text.mjs";

/** Floor and Neighborhood headings are set at least this large (body text is ~10.5pt). */
const HEADING_SIZE = 18;
/** A Floor or chapter title (Core's section headings are as large: told apart by their words). */
const TITLE_SIZE = 24;

const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
];
const FLOOR_RE = /^(?:the\s+)?(\w+)\s+floor\b\s*(?::\s*(.+))?(.*)$/i;
// What may follow "<Ordinal> Floor" in a Floor heading: nothing (a title), or a list's name.
const FLOOR_LIST_RE = /^(?:|mobs|bosses|mobs and bosses)$/i;
const SECTION_RE = /^(neighborhood|quest)\s*:\s*(.*)$/i;
const END_RE = /^(?:chapter\s+\d+\b.*|appendix\b.*|.*\bappendix)$/i;
const FLOOR_LINE_RE = /^Floor:\s*(\d+)\b/i;
// A contents line: dot leaders, or a page number at the end.
const CONTENTS_RE = /\.{4,}|\s\d{1,3}$/;

/** A Floor's number from "Third", "3rd" or "3", else null. */
export function floorNumber(word) {
  const w = String(word ?? "").toLowerCase();
  const n = ORDINALS.indexOf(w);
  if (n >= 0) return n + 1;
  const m = w.match(/^(\d+)(?:st|nd|rd|th)?$/);
  return m ? Number(m[1]) : null;
}

/** "CHAPTER 9CHAPTER 9" (a title drawn twice, for its shadow) -> "CHAPTER 9". */
function undouble(text) {
  const t = String(text ?? "").trim();
  const half = t.length / 2;
  return Number.isInteger(half) && t.slice(0, half) === t.slice(half) ? t.slice(0, half).trim() : t;
}

/** Book text set in capitals ("THE IRON TANGLE") reads as a title; other text is kept. */
function tidy(text) {
  const t = text.replace(/\s+/g, " ").trim();
  return /\b[A-Z]{3,}\b/.test(t) ? titleCase(t) : t;
}

/**
 * @typedef {object} Section
 * @property {number|null} floor       The Floor's number, or null (not on a Floor).
 * @property {string} floorTitle       "The Over City", or "".
 * @property {"neighborhood"|"quest"|""} kind
 * @property {string} name             "Heavensworth", or "".
 * @property {number} order            Where the section starts in the book (for sorting).
 */

/**
 * Read every page's Floor and section headings.
 * @param {object[]} pages  From scan.mjs readPages: {page, lines, items}.
 * @returns {(page: number, lineIndex: number) => Section}  The section in
 *   force at a line of a page (its index in page.lines).
 */
export function findSections(pages) {
  const titles = new Map(); // floor number -> title
  /** @type {{page: number, at: number, section: Section}[]} */
  const marks = [];
  let current = { floor: null, floorTitle: "", kind: "", name: "", order: 0 };
  let order = 0;
  const set = (page, at, next) => {
    current = { ...current, ...next, order: ++order };
    if (current.floor && !current.floorTitle && titles.has(current.floor))
      current.floorTitle = titles.get(current.floor);
    marks.push({ page, at, section: current });
  };
  const startFloor = (page, at, floor, title) => {
    if (title) titles.set(floor, title);
    set(page, at, { floor, floorTitle: title || titles.get(floor) || "", kind: "", name: "" });
  };

  for (const page of pages) {
    const lines = page.lines ?? [];
    // A Floor's title may be drawn where no line holds it (Core's Fifth
    // Floor opener): then it opens the Floor from the top of the page.
    const bigTexts = [
      ...lines.filter((l) => l.size >= TITLE_SIZE).map((l) => undouble(l.text)),
      ...(page.items ?? []).filter((i) => i.size >= TITLE_SIZE).map((i) => undouble(i.str)),
    ];
    const pageFloor = bigTexts
      .map((t) => t.match(FLOOR_RE))
      .find((m) => m && floorNumber(m[1]) && !m[3]?.trim());
    const floorOf = (m) => ({ floor: floorNumber(m[1]), title: m[2] ? tidy(m[2]) : "" });
    if (pageFloor && !lines.some((l) => l.size >= TITLE_SIZE && FLOOR_RE.test(undouble(l.text)))) {
      const { floor, title } = floorOf(pageFloor);
      startFloor(page.page, -1, floor, title);
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.size < HEADING_SIZE) continue;
      const text = undouble(line.text);
      if (CONTENTS_RE.test(text)) continue;
      let m;
      if (line.size >= TITLE_SIZE && END_RE.test(text)) {
        // A chapter opener that opens a Floor keeps it (the title follows).
        if (!pageFloor) set(page.page, i, { floor: null, floorTitle: "", kind: "", name: "" });
        continue;
      }
      if ((m = text.match(FLOOR_RE)) && floorNumber(m[1]) && FLOOR_LIST_RE.test(m[3].trim())) {
        // "The Third Floor: The Over City", or "FIRST FLOOR MOBS".
        const { floor, title } = floorOf(m);
        startFloor(page.page, i, floor, line.size >= TITLE_SIZE ? title : "");
        continue;
      }
      if ((m = text.match(SECTION_RE))) {
        // The name may wrap onto following lines of the same size.
        const parts = [m[2]];
        let j = i + 1;
        while (
          j < lines.length &&
          Math.abs(lines[j].size - line.size) < 0.5 &&
          lines[j].col === line.col &&
          !SECTION_RE.test(lines[j].text) &&
          !FLOOR_RE.test(lines[j].text)
        ) {
          parts.push(lines[j].text);
          j++;
        }
        const name = tidy(
          parts
            .filter(Boolean)
            .join(" ")
            .replace(/\s+(™|®)/g, "$1"),
        );
        if (!name) continue;
        // Core prints the Floor under the heading: "Floor: 3 - Theme: ...".
        const floorLine = lines
          .slice(j, j + 3)
          .map((l) => l.text.match(FLOOR_LINE_RE))
          .find(Boolean);
        const floor = floorLine ? Number(floorLine[1]) : current.floor;
        set(page.page, i, {
          floor,
          floorTitle: floor === current.floor ? current.floorTitle : (titles.get(floor) ?? ""),
          kind: m[1].toLowerCase(),
          name,
        });
        i = j - 1;
      }
    }
  }

  const empty = { floor: null, floorTitle: "", kind: "", name: "", order: 0 };
  return (page, lineIndex) => {
    let found = empty;
    for (const mark of marks) {
      if (mark.page < page || (mark.page === page && mark.at <= lineIndex)) found = mark.section;
      else break;
    }
    return found;
  };
}

/**
 * The folder path a Mob in this section is filed under: its Floor, then its
 * Neighborhood or Quest. Not on a Floor: the catch-all (`otherLabel`).
 * @param {Section} section
 * @param {{floor: (n: number) => string, other: string, neighborhood?: string, quest?: string}} labels
 * @returns {{key: string, name: string, sort: number}[]}  Outermost first;
 *   `key` is stable across imports, `sort` keeps the book's order.
 */
export function sectionFolders(
  section,
  { floor: floorLabel, other, neighborhood = "Neighborhood", quest = "Quest" },
) {
  const path = [];
  if (section?.floor) {
    const title = section.floorTitle ? `: ${section.floorTitle}` : "";
    path.push({
      key: `floor-${section.floor}`,
      name: `${floorLabel(section.floor)}${title}`,
      sort: section.floor,
    });
  } else path.push({ key: "other", name: other, sort: 1000 });
  if (section?.kind && section.name) {
    const label = section.kind === "quest" ? quest : neighborhood;
    path.push({
      key: `${path[0].key}/${section.kind}/${section.name.toLowerCase()}`,
      name: `${label}: ${section.name}`,
      sort: section.order,
    });
  }
  return path;
}
