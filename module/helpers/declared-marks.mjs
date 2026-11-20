/**
 * A green check on each Mob token that has declared this round (Mob Action
 * Declaration, p.81; docs/combat-phases.md) - the GM's bookkeeping, so it is
 * drawn for GMs only, and only while the round is in Declaration. A Boss with
 * more than one declared Attack gets the count beside the check.
 *
 * Drawn client-side as a child of the token (no document writes), from the
 * combat's `declared` flag (module/helpers/declarations.mjs), and redrawn on
 * every token refresh and combat change.
 */
import { currentPhase, isPhased } from "./combat-phases.mjs";
import { declaredAttacks } from "./declarations.mjs";

const MARK = "carlDeclaredMark";

/**
 * How many Attacks each token id has declared, across the phased combats
 * in Declaration on the viewed scene.
 * @returns {Map<string, number>}
 */
export function declaredCounts() {
  const counts = new Map();
  const sceneId = canvas.scene?.id;
  for (const combat of game.combats) {
    if (!isPhased(combat) || currentPhase(combat) !== "declare") continue;
    for (const d of declaredAttacks(combat)) {
      if (!d.tokenId || (d.sceneId && d.sceneId !== sceneId)) continue;
      counts.set(d.tokenId, (counts.get(d.tokenId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Add, update or remove one token's mark.
 * @param {Token} token  Anything PIXI.Container-like with `w` and `h`.
 * @param {number} count  0 removes it.
 */
export function drawMark(token, count) {
  let mark = token.getChildByName?.(MARK) ?? null;
  if (!count) {
    if (mark) mark.destroy({ children: true });
    return;
  }
  const size = Math.max(16, Math.round(Math.min(token.w, token.h) * 0.28));
  if (!mark || mark.carlCount !== count || mark.carlSize !== size) {
    if (mark) mark.destroy({ children: true });
    mark = new PIXI.Container();
    mark.name = MARK;
    mark.eventMode = "none";
    mark.carlCount = count;
    mark.carlSize = size;

    const r = size / 2;
    const badge = new PIXI.Graphics();
    badge.lineStyle(Math.max(1, size / 12), 0x0b3d16, 1);
    badge.beginFill(0x2ecc40, 1);
    badge.drawCircle(r, r, r);
    badge.endFill();
    badge.lineStyle(Math.max(2, size / 7), 0xffffff, 1, 0.5);
    badge.moveTo(r * 0.5, r * 1.02);
    badge.lineTo(r * 0.85, r * 1.38);
    badge.lineTo(r * 1.5, r * 0.62);
    mark.addChild(badge);

    if (count > 1) {
      const text = new PIXI.Text(String(count), {
        fontFamily: "Signika, sans-serif",
        fontSize: Math.round(size * 0.7),
        fontWeight: "bold",
        fill: 0xffffff,
        stroke: 0x0b3d16,
        strokeThickness: Math.max(2, size / 8),
      });
      text.anchor.set(1, 0.5);
      text.position.set(-2, r);
      mark.addChild(text);
    }
    token.addChild(mark);
  }
  mark.position.set(token.w - size * 0.85, -size * 0.15);
}

/** Redraw every token's mark on the canvas. */
export function refreshDeclaredMarks() {
  if (!canvas.ready || !game.user.isGM) return;
  const counts = declaredCounts();
  for (const token of canvas.tokens.placeables) drawMark(token, counts.get(token.id) ?? 0);
}

/** Wire the marks to token and combat changes. Call once from the `ready` hook. */
export function registerDeclaredMarks() {
  if (!game.user.isGM) return;
  const all = foundry.utils.debounce(refreshDeclaredMarks, 30);
  Hooks.on("refreshToken", (token) => {
    if (!canvas.ready) return;
    drawMark(token, declaredCounts().get(token.id) ?? 0);
  });
  for (const hook of [
    "canvasReady",
    "updateCombat",
    "deleteCombat",
    "createCombatant",
    "deleteCombatant",
  ]) {
    Hooks.on(hook, all);
  }
  // A world loaded mid-Declaration: draw what's already declared.
  all();
}

export { MARK as DECLARED_MARK_NAME };
