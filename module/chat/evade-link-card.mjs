/**
 * The "Roll Evade" button on an Attack chat card (docs/known-gaps.md 5) -
 * lets a defending token actively roll a live Evade Check (Interrupt
 * Action, Carl RPG p.81) instead of silently accepting CarlDice.rollAttack's
 * static-Difficulty auto-resolution.
 *
 * Rolling Evade is the authoritative determination for this specific
 * Attack: once rolled, the original Attack card's own "Apply Damage"/
 * "Apply to Target(s)" buttons are marked superseded (disabled, relabeled -
 * see damageActionEntries/targetEffectsActionEntries' supersededFlag), and
 * this roll's own "Evade Outcome" card carries whatever actually applies
 * instead - the (possibly Major/Critical-Fail-adjusted) damage, and the
 * original attack's on-hit targetEffects forwarded onto this card whenever
 * the evade fails (an evaded-clean result means nothing applies at all).
 * The Evade Outcome card's damage/target-effect buttons reuse module/chat/
 * damage-card.mjs's/target-effects-card.mjs's existing footer builders and
 * registry entries verbatim (same flag shapes) - no new apply-side code.
 */
import CarlDice from "../dice/dice.mjs";
import { degreeBadge, isHitDegree } from "../helpers/rules.mjs";
import { resolveActingActor, resolveCombatantFor } from "../helpers/token-resolution.mjs";
import { addConditionToActor } from "../helpers/conditions.mjs";
import { buildDamageFooter } from "./damage-card.mjs";
import { buildTargetEffectsFooter } from "./target-effects-card.mjs";
import { createRollMessage } from "./chat-card.mjs";
import { updateCardMessage } from "../helpers/chat-socket.mjs";

const EVADE_FOOTER_TEMPLATE = "systems/carl-rpg/templates/chat/evade-footer.hbs";
const CONSEQUENCE_FOOTER_TEMPLATE = "systems/carl-rpg/templates/chat/evade-consequence-footer.hbs";

/**
 * Render the "Roll Evade" footer. Rendered whenever rollAttack snapshotted
 * at least one target - see CarlDice.rollAttack.
 * @returns {Promise<string>}
 */
export async function buildEvadeLinkFooter() {
  const { renderTemplate } = foundry.applications.handlebars;
  return renderTemplate(EVADE_FOOTER_TEMPLATE, {});
}

/**
 * Render the "Add Minor/Major Injury Debuff" footer for an Evade-outcome
 * card that came back Major or Critical Fail.
 * @param {string} debuffKey  "minorInjury" | "majorInjury"
 * @returns {Promise<string>}
 */
async function buildEvadeConsequenceFooter(debuffKey) {
  const { renderTemplate } = foundry.applications.handlebars;
  const debuffButtonLabel = game.i18n.localize(
    debuffKey === "majorInjury" ? "CARLRPG.Evade.AddMajorInjury" : "CARLRPG.Evade.AddMinorInjury"
  );
  return renderTemplate(CONSEQUENCE_FOOTER_TEMPLATE, { debuffButtonLabel });
}

/**
 * Resolve a snapshotted token/actor UUID back to its Actor, if it (and its
 * scene) still exist. Tokens/scenes can be deleted between roll time and
 * click time - callers must tolerate nulls.
 * @param {string} uuid
 * @returns {Promise<Actor|null>}
 */
async function resolveTargetActor(uuid) {
  if (!uuid) return null;
  const doc = await fromUuid(uuid);
  if (!doc) return null;
  return doc instanceof Actor ? doc : (doc.actor ?? null);
}

/**
 * @param {ChatMessage} message
 * @param {string} flagKey  A flag holding either one UUID or an array of them.
 * @returns {boolean} Whether the current user may act on this button - a GM
 *   always can; otherwise only if they own at least one snapshotted actor.
 */
export function canActOnUuidFlag(message, flagKey) {
  if (game.user.isGM) return true;
  const uuids = [message.getFlag("carl-rpg", flagKey)].flat().filter(Boolean);
  return uuids.some((uuid) => {
    try {
      const doc = fromUuidSync(uuid);
      const actor = doc instanceof Actor ? doc : doc?.actor;
      return !!actor?.isOwner;
    } catch (e) {
      return false;
    }
  });
}

/**
 * Considerate Play and PvP (Carl RPG p.87): when both the attacker and the
 * defender are Characters, the attacker's own rolled Attack total becomes
 * the Evade Difficulty. Otherwise (Evade Interrupt Action, p.81, vs. a
 * Mob on either side), the already-computed static formula applies.
 * @param {{attackerType: string, defenderType: string, attackTotal: number, targetDifficulty: number|null}} args
 * @returns {number|null}
 */
export function resolveEvadeDifficulty({ attackerType, defenderType, attackTotal, targetDifficulty }) {
  return (attackerType === "character" && defenderType === "character") ? attackTotal : targetDifficulty;
}

/**
 * Roll a live Evade Check for the acting user's resolved token/actor against
 * this specific Attack's Difficulty, mark the original Attack card's own
 * damage/target-effect buttons superseded, and post ONE combined card
 * carrying both the Evade roll itself and the final outcome: evaded clean,
 * hit as normal, or hit with Major/Critical Fail consequences (extra/doubled
 * damage plus a convenience Debuff button - never auto-applied, matching
 * CarlDice.rollEvadeCheck's own "GM judgment call" design). The original
 * attack's on-hit targetEffects are forwarded onto this card whenever the
 * evade fails, so they aren't silently dropped now that this roll (not the
 * static auto-resolution) determines whether the attack actually landed.
 * @param {PointerEvent} event
 * @param {ChatMessage} message  The original Attack chat message.
 */
async function onRollEvade(event, message) {
  event.preventDefault();
  const resolved = resolveActingActor();
  if (!resolved) return;

  const attackTotal = message.getFlag("carl-rpg", "attackTotal");
  const targetDifficulty = message.getFlag("carl-rpg", "targetDifficulty") ?? null;
  const attackerType = message.getFlag("carl-rpg", "attackerType");
  const difficulty = resolveEvadeDifficulty({
    attackerType, defenderType: resolved.actor.type, attackTotal, targetDifficulty,
  });

  const rollData = await CarlDice.rollEvadeCheck(resolved.actor, { difficulty, skipDialog: false, post: false });
  if (!rollData) return; // Dialog cancelled - nothing to record.
  const { roll, breakdown, degree } = rollData;

  // Nat-20/Amazing-Success on Evade grants Advantage on the evader's NEXT
  // Attack Skill Check against THIS SAME Mob (Degrees of Success table,
  // p.79) - tracked on the evader's own Combatant so it survives to that
  // later, separate roll (see module/dice/dice.mjs's rollAttack, which reads
  // it back). Combat-only by design (docs/taunt-and-nat20-advantage-prompt.md):
  // no game.combat means nothing to write. The evader is writing to their
  // OWN Combatant, so this should already be permitted without the
  // ChatMessage-flavored socket relay above - checked, not assumed.
  if (degree === "criticalHit" || degree === "amazingSuccess") {
    const attackerUuid = message.getFlag("carl-rpg", "attackerUuid");
    const combatant = resolveCombatantFor(resolved);
    if (attackerUuid && combatant?.canUserModify(game.user, "update")) {
      await combatant.setFlag("carl-rpg", "advantageVsUuid", attackerUuid);
    }
  }

  // One combined write: this Evade roll is now authoritative for this
  // Attack, so the original card's own damage/target-effect buttons stop
  // being separately clickable.
  await updateCardMessage(message, {
    flags: { "carl-rpg": { evadeRolled: true, damageSuperseded: true, targetEffectsSuperseded: true } },
  });

  const baseDamageByType = message.getFlag("carl-rpg", "damageByType") ?? {};
  const isMagic = message.getFlag("carl-rpg", "damageIsMagic") ?? true;
  const originalTargetEffects = message.getFlag("carl-rpg", "targetEffects") ?? [];
  const floor = game.settings.get("carl-rpg", "currentFloor");

  let adjusted = {};
  let debuffKey = null;
  let subtitleKey = "CARLRPG.Evade.Evaded";
  if (isHitDegree(degree)) {
    // Evaded clean - no damage, no target effects, no consequence.
  } else if (degree === "majorFail") {
    // "Takes extra damage equal to the current Floor Number" (p.79) - added
    // as untyped ("") damage, the same convention computeDamageApplication
    // already treats as generic/typeless.
    adjusted = { ...baseDamageByType, "": (baseDamageByType[""] ?? 0) + floor };
    debuffKey = "minorInjury";
    subtitleKey = "CARLRPG.Evade.HitMajorFail";
  } else if (degree === "criticalFail") {
    adjusted = Object.fromEntries(Object.entries(baseDamageByType).map(([k, v]) => [k, v * 2]));
    debuffKey = "majorInjury";
    subtitleKey = "CARLRPG.Evade.HitCriticalFail";
  } else {
    // standardFail / nearMissFail - hit as normal, unmodified damage.
    adjusted = { ...baseDamageByType };
    subtitleKey = "CARLRPG.Evade.HitNormal";
  }

  const hasAdjustedDamage = Object.values(adjusted).some((v) => v);
  // The attack still connects whenever Evade fails in any of its 3 failure
  // buckets - the on-hit targetEffects the original card would have applied
  // still apply, just via this card's own (reused, unmodified) button.
  const forwardTargetEffects = !isHitDegree(degree) && originalTargetEffects.length > 0;
  const footerParts = [];
  const flags = {};
  const defenderUuid = resolved.token?.uuid ?? resolved.actor.uuid;
  if (hasAdjustedDamage) {
    // Same flag shape damage-card.mjs already reads - its existing
    // damageActionEntries/Apply Damage button picks this up with no further
    // wiring needed here.
    flags.targetUuids = [defenderUuid];
    flags.damageByType = adjusted;
    flags.damageIsMagic = isMagic;
    footerParts.push(await buildDamageFooter(adjusted));
  }
  if (forwardTargetEffects) {
    flags.targetUuids = [defenderUuid];
    flags.targetEffects = originalTargetEffects;
    footerParts.push(await buildTargetEffectsFooter(originalTargetEffects));
  }
  if (debuffKey) {
    flags.debuffKey = debuffKey;
    flags.debuffActorUuid = defenderUuid;
    footerParts.push(await buildEvadeConsequenceFooter(debuffKey));
  }
  // The original Attack rolled no damage at all (it missed the static
  // formula outright) and Critical Fail's "double nothing" stays empty -
  // say so plainly rather than showing a damage footer for a zero roll.
  const body = (!hasAdjustedDamage && (debuffKey || forwardTargetEffects))
    ? `<p>${game.i18n.localize("CARLRPG.Evade.NoBaseDamage")}</p>`
    : "";

  await createRollMessage({
    rolls: [roll],
    rollMeta: [{ label: game.i18n.localize("CARLRPG.Roll.Evade"), breakdown }],
    title: game.i18n.format("CARLRPG.Evade.OutcomeTitle", { name: resolved.actor.name }),
    img: resolved.actor.img,
    subtitle: game.i18n.localize(subtitleKey),
    badge: degreeBadge(degree),
    body,
    footer: footerParts.length ? footerParts.join("") : undefined,
    flags,
    actor: resolved.actor,
    token: resolved.token,
  });
}

/**
 * Add the Debuff a Major/Critical Fail outcome calls for - one click,
 * exactly like every other Condition write in this codebase
 * (module/helpers/conditions.mjs's addConditionToActor); never silent.
 * @param {PointerEvent} event
 * @param {ChatMessage} message  The Evade-outcome chat message.
 */
async function onAddEvadeDebuff(event, message) {
  event.preventDefault();
  const uuid = message.getFlag("carl-rpg", "debuffActorUuid");
  const debuffKey = message.getFlag("carl-rpg", "debuffKey");
  const actor = await resolveTargetActor(uuid);
  if (!actor) {
    ui.notifications.warn(game.i18n.localize("CARLRPG.Evade.NoActor"));
    return;
  }

  await addConditionToActor(actor, debuffKey, { source: game.i18n.localize("CARLRPG.Roll.Evade") });
  await updateCardMessage(message, { flags: { "carl-rpg": { debuffAdded: true } } });
  ui.notifications.info(game.i18n.format("CARLRPG.Evade.DebuffAddedNotice", { name: actor.name }));
}

/**
 * Registry entries consumed by the shared registerChatListener (module/chat/
 * chat-listener.mjs) - preserves both buttons' GM/owner visibility gating
 * and one-shot idempotency exactly as before, now registry-shaped.
 */
export const evadeActionEntries = [
  {
    action: "rollEvade",
    buttonSelector: ".carl-roll-evade",
    wrapperSelector: ".carl-evade-link",
    canAct: (m) => canActOnUuidFlag(m, "targetUuids"),
    doneFlag: "evadeRolled",
    doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Evade.Rolled")}`,
    onClick: onRollEvade,
  },
  {
    action: "addEvadeDebuff",
    buttonSelector: ".carl-add-evade-debuff",
    wrapperSelector: ".carl-evade-consequence",
    canAct: (m) => canActOnUuidFlag(m, "debuffActorUuid"),
    doneFlag: "debuffAdded",
    doneLabel: () => `<i class="fas fa-check"></i> ${game.i18n.localize("CARLRPG.Evade.DebuffAdded")}`,
    onClick: onAddEvadeDebuff,
  },
];
