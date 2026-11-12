/**
 * Achievement pop-ups (Core Rulebook Appendix 3, and the sample boxes in
 * the floor chapters):
 *
 *   NEW ACHIEVEMENT!
 *   <Title>
 *   <What the crawler did, and a quip>
 *   REWARD?:
 *   You've received a Bronze Crafter's Box!
 *   Contents—<what is inside>
 *
 * The boxes are art: often tilted, and set across both columns. So each box
 * is read on its own, from the "NEW ACHIEVEMENT!" banner down, in the
 * banner's own rotated frame, instead of from the column layout.
 */

import { escapeHtml, joinText } from "./page-text.mjs";

const ANCHOR_RE = /^NEW ACHIEVE/;
const SKIP_RE = /^(NEW ACHIEVE\w*!?|MENT!)$/;
// How far below and beside the banner a box reaches, in points.
const BOX = { below: 175, left: 90, right: 270 };

/**
 * @param {object[]} pages  From scan.mjs readPages.
 * @returns {{name: string, page: number, data: object}[]}
 */
export function parseAchievements(pages) {
  const found = [];
  for (const page of pages) {
    const anchors = page.items.filter((i) => ANCHOR_RE.test(i.str.trim()));
    if (!anchors.length) continue;
    // Boxes are set in their own fonts and sizes; page prose (and its bold
    // labels) next to a box is not.
    const body = mostCommon(page.items, (i) => i.font);
    const bodySize = mostCommon(page.items, (i) => i.size.toFixed(1));
    const items = page.items.filter(
      (i) => /^REWARD/.test(i.str.trim()) || (i.font !== body && i.size.toFixed(1) !== bodySize),
    );
    for (const anchor of anchors) {
      const box = readBox(items, anchor, anchors);
      if (box) found.push({ ...box, page: page.page });
    }
  }
  return found.map(toPage);
}

/** The value of `key` shared by the most text on the page. */
function mostCommon(items, key) {
  const counts = new Map();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + item.str.length);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Rotate an item into the anchor's frame: u runs along the banner, v up. */
function toFrame(item, anchor) {
  const t = (anchor.angle * Math.PI) / 180;
  const dx = item.x - anchor.x;
  const dy = item.y - anchor.y;
  return { u: dx * Math.cos(t) + dy * Math.sin(t), v: -dx * Math.sin(t) + dy * Math.cos(t) };
}

function readBox(items, anchor, anchors) {
  // A box ends where the next banner below it (same tilt) begins.
  let floor = -BOX.below;
  for (const other of anchors) {
    if (other === anchor || Math.abs(other.angle - anchor.angle) > 1.5) continue;
    const { u, v } = toFrame(other, anchor);
    if (v < -5 && v > floor && Math.abs(u) < BOX.right) floor = v + 5;
  }

  const inBox = [];
  for (const item of items) {
    if (Math.abs(item.angle - anchor.angle) > 1.5 || SKIP_RE.test(item.str.trim())) continue;
    const { u, v } = toFrame(item, anchor);
    if (v < -2 && v > floor && u > -BOX.left && u < BOX.right) inBox.push({ ...item, u, v });
  }
  if (!inBox.length) return null;

  // Rows in the banner's frame, top to bottom; repeated text drawn twice
  // (the art draws "REWARD?:" twice) is kept once.
  inBox.sort((a, b) => b.v - a.v || a.u - b.u);
  const rows = [];
  for (const item of inBox) {
    const row = rows.at(-1);
    if (row && Math.abs(row.v - item.v) <= Math.max(2, item.size * 0.4)) {
      if (!row.items.some((i) => i.str === item.str && Math.abs(i.u - item.u) < 1))
        row.items.push(item);
    } else rows.push({ v: item.v, size: item.size, items: [item] });
  }
  const lines = rows.map((row) => ({
    size: Math.max(...row.items.map((i) => i.size)),
    text: row.items
      .sort((a, b) => a.u - b.u)
      .map((i) => i.str.trim())
      .join(" ")
      .replace(/\s+/g, " "),
  }));

  // The title is the largest text in the box.
  const titleSize = Math.max(...lines.filter((l) => !/^REWARD/.test(l.text)).map((l) => l.size));
  const title = joinText(lines.filter((l) => l.size === titleSize).map((l) => l.text));
  const rest = lines.filter((l) => l.size !== titleSize);
  const rewardAt = rest.findIndex((l) => /^REWARD\??:?$/.test(l.text));
  const before = rewardAt >= 0 ? rest.slice(0, rewardAt) : rest;
  const after = rewardAt >= 0 ? rest.slice(rewardAt + 1) : [];
  const contentsAt = after.findIndex((l) => /^Contents\s*[—-]/.test(l.text));
  return {
    title,
    description: joinText(before.map((l) => l.text)),
    reward: joinText((contentsAt >= 0 ? after.slice(0, contentsAt) : after).map((l) => l.text)),
    contents:
      contentsAt >= 0
        ? joinText(after.slice(contentsAt).map((l) => l.text)).replace(/^Contents\s*[—-]\s*/, "")
        : "",
  };
}

function toPage({ title, description, reward, contents, page }) {
  const html = [`<p>${escapeHtml(description)}</p>`];
  if (reward) html.push(`<p><strong>Reward:</strong> ${escapeHtml(reward)}</p>`);
  if (contents) html.push(`<p><strong>Contents:</strong> ${escapeHtml(contents)}</p>`);
  return {
    name: title,
    page,
    data: { name: title, type: "text", text: { content: html.join(""), format: 1 } },
  };
}
