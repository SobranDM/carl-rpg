/**
 * "Which token/actor should this roll act for" - a standalone helper with no
 * dependency on any specific chat-card feature, since more than one Opposed
 * Check button (Evade today, others later - see docs/known-gaps.md 5) needs
 * to answer this same question when a user clicks a button that isn't tied
 * to a sheet they already have open.
 *
 * No such resolution existed anywhere in the codebase before this (confirmed
 * via a full-codebase grep for canvas.tokens.controlled/game.user.character)
 * - every prior roll flow is always invoked from that actor's own sheet.
 */

/**
 * @param {User} [user]  Defaults to the current user.
 * @returns {{actor: Actor, token: TokenDocument|null}|null}
 *   `null` if nothing could be resolved - a warning has already been shown
 *   via ui.notifications in that case, so callers can just bail silently.
 */
export function resolveActingActor(user = game.user) {
  if (user.isGM) {
    const controlled = canvas.tokens?.controlled?.[0] ?? null;
    if (!controlled?.actor) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.TokenResolution.NoGMSelection"));
      return null;
    }
    return { actor: controlled.actor, token: controlled.document };
  }

  const owned = (canvas.tokens?.controlled ?? []).find((t) => t.actor?.isOwner);
  if (owned) return { actor: owned.actor, token: owned.document };

  if (user.character) {
    const activeToken = user.character.getActiveTokens?.(true, true)?.[0] ?? null;
    return { actor: user.character, token: activeToken?.document ?? null };
  }

  ui.notifications.warn(game.i18n.localize("CARLRPG.TokenResolution.NoActor"));
  return null;
}
