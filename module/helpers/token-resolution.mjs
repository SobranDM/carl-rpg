import { fightOf } from "./fights.mjs";
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

/**
 * Find this actor/token's Combatant in a Combat, if any - the shared lookup
 * for combat-scoped state that must outlive a single roll (the Nat-20/
 * Amazing-Success Evade->Advantage entitlement; see module/chat/
 * evade-link-card.mjs and module/dice/dice.mjs's rollAttack). Deliberately
 * built standalone, same reuse rationale as resolveActingActor above.
 *
 * Combat-only by design (docs/taunt-and-nat20-advantage-prompt.md): returns
 * null with no fight, no actor, or when this actor/token isn't seated in the
 * Combat at all - callers no-op silently rather than falling back to Actor
 * flags. No cleanup is ever needed for state stored on the Combatant this
 * resolves to: Foundry deletes embedded Combatants along with their parent
 * Combat automatically.
 * @param {{actor: Actor, token: TokenDocument|null}} resolved
 * @param {Combat|null} [combat]  Defaults to the actor's own fight
 *   (fights.mjs fightOf - not the one the tracker shows; ruled 2026-11-19).
 * @returns {Combatant|null}
 */
export function resolveCombatantFor({ actor, token } = {}, combat = fightOf(actor)) {
  if (!combat || !actor) return null;
  if (token) {
    const byToken = combat.combatants.find(
      (c) => c.tokenId === token.id && c.sceneId === (token.parent?.id ?? null),
    );
    if (byToken) return byToken;
  }
  // The actor itself: an unlinked token's own actor is its own, so two
  // Goblins from one stat block aren't mistaken for each other.
  return combat.combatants.find((c) => c.actor === actor) ?? null;
}

/**
 * The Actor behind a token or actor uuid (sync), or null - a token's uuid
 * gives its own (synthetic) actor.
 * @param {string|null|undefined} uuid
 * @returns {Actor|null}
 */
export function actorFromUuid(uuid) {
  if (!uuid) return null;
  try {
    const doc = fromUuidSync(uuid);
    return doc instanceof Actor ? doc : (doc?.actor ?? null);
  } catch {
    return null;
  }
}

/**
 * Whether a user (this one by default) owns the actor behind a token or
 * actor uuid. A GM always does.
 * @param {string|null|undefined} uuid
 * @param {User} [user]
 * @returns {boolean}
 */
export function ownsUuid(uuid, user = game.user) {
  if (user.isGM) return true;
  return !!actorFromUuid(uuid)?.testUserPermission(user, "OWNER");
}

/**
 * The own (synthetic) actors of unlinked tokens - absent from game.actors -
 * on these scenes, optionally only the tokens passing `test`.
 * @param {Iterable<Scene>} [scenes]
 * @param {(token: TokenDocument) => boolean} [test]
 * @returns {Actor[]}
 */
export function unlinkedTokenActors(scenes = game.scenes, test = () => true) {
  const actors = [];
  for (const scene of scenes) {
    for (const token of scene.tokens) {
      if (!token.actorLink && token.actor && test(token)) actors.push(token.actor);
    }
  }
  return actors;
}
