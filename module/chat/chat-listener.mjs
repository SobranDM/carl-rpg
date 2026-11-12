/**
 * Single delegated chat-card click router (adapted from foundryvtt-wwn's
 * module/chat/chat-listener.mjs) replacing what used to be four separate
 * per-file Hooks.on("renderChatMessageHTML", ...) registrations (damage/
 * target-effects/heal/evade-link), each independently wiring its own
 * button(s) via btn.addEventListener.
 *
 * Unlike WWN's own listener - which does ONLY click dispatch, since WWN's
 * damage-apply UI is deliberately repeatable with no per-viewer gating -
 * every button in this system needs real GM/owner visibility gating and
 * one-shot "already applied" idempotency (a target's owner, or the GM, can
 * click; nobody else can; and it can't be double-clicked after scrolling
 * back into view). Each feature file (module/chat/damage-card.mjs etc.)
 * exports a small array of registry entries describing exactly that, and
 * this module is the only place that actually iterates them.
 *
 * @typedef {object} ChatActionEntry
 * @property {string} action           Matches a button's data-action.
 * @property {string} buttonSelector   e.g. ".carl-apply-damage"
 * @property {string} wrapperSelector  Removed from the DOM when !canAct(message).
 * @property {(message: ChatMessage) => boolean} canAct
 * @property {string} doneFlag         Disables+relabels once this flag is set.
 * @property {() => string} doneLabel  innerHTML for the disabled/done state.
 * @property {string} [supersededFlag] Checked only when doneFlag isn't set -
 *   a distinct disabled state for "a later roll made this moot," not "used."
 * @property {() => string} [supersededLabel]
 * @property {(message: ChatMessage) => string|null} [liveLabel]  innerHTML
 *   for the still-clickable state when it depends on the message (e.g. "Roll
 *   Free Evade"); null keeps the template's own label.
 * @property {(event: PointerEvent, message: ChatMessage) => Promise<void>} onClick
 */
import { damageActionEntries } from "./damage-card.mjs";
import { targetEffectsActionEntries } from "./target-effects-card.mjs";
import { healActionEntries } from "./heal-card.mjs";
import { evadeActionEntries } from "./evade-link-card.mjs";
import { tauntActionEntries } from "./taunt-card.mjs";
import { markChoiceActionEntries } from "./mark-choice-card.mjs";
import { grindSurplusActionEntries } from "./grind-surplus-card.mjs";
import { attackTargetsActionEntries, decorateTargetRows } from "./attack-targets-card.mjs";
import { aiRerollActionEntries, decorateAiReroll } from "./ai-favor-reroll.mjs";

const REGISTRY = [
  ...damageActionEntries,
  ...targetEffectsActionEntries,
  ...healActionEntries,
  ...evadeActionEntries,
  ...tauntActionEntries,
  ...markChoiceActionEntries,
  ...grindSurplusActionEntries,
  ...attackTargetsActionEntries,
  ...aiRerollActionEntries,
];
const BY_ACTION = new Map(REGISTRY.map((entry) => [entry.action, entry]));

function isBlocked(entry, message) {
  // A card replaced by an AI Favor reroll (module/chat/ai-favor-reroll.mjs)
  // no longer does anything - its replacement does.
  if (message.getFlag("carl-rpg", "aiRerolled")) return true;
  // A `custom` entry's buttons are drawn per viewer by its own decorator
  // (e.g. module/chat/attack-targets-card.mjs's per-target rows), and its
  // handler re-checks everything for the button clicked.
  if (entry.custom) return false;
  return !entry.canAct(message)
    || !!message.getFlag("carl-rpg", entry.doneFlag)
    || !!(entry.supersededFlag && message.getFlag("carl-rpg", entry.supersededFlag));
}

/** Registers the single delegated listener - call once, from init. */
export function registerChatListener() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    // Generic convention for any GM-only appended content (e.g. the folded
    // damage digest, module/chat/damage-card.mjs) - not one specific selector.
    if (!game.user.isGM) {
      html.querySelectorAll(".carl-gm-only").forEach((el) => el.remove());
    }

    // Per-viewer content drawn from flags (an Attack card's target rows).
    decorateTargetRows(message, html);
    // The AI Favor reroll button, or a replaced card's "rerolled" state -
    // after the rows, so it can switch their buttons off too.
    decorateAiReroll(message, html);

    for (const entry of REGISTRY) {
      if (entry.custom) continue;
      const btn = html.querySelector(entry.buttonSelector);
      if (!btn) continue;

      if (!entry.canAct(message)) {
        html.querySelector(entry.wrapperSelector)?.remove();
        continue;
      }
      if (message.getFlag("carl-rpg", entry.doneFlag)) {
        btn.disabled = true;
        btn.innerHTML = entry.doneLabel();
        continue;
      }
      if (entry.supersededFlag && message.getFlag("carl-rpg", entry.supersededFlag)) {
        btn.disabled = true;
        btn.innerHTML = entry.supersededLabel();
        continue;
      }
      // Else: leave the button live - the delegated click listener below
      // dispatches it.
      const liveLabel = entry.liveLabel?.(message);
      if (liveLabel) btn.innerHTML = liveLabel;
    }

    html.addEventListener("click", (event) => {
      const target = event.target.closest("[data-action]");
      if (!target || !html.contains(target)) return;

      // Pure client-side UI, no flags/permissions involved - handled here
      // rather than via the registry.
      if (target.dataset.action === "toggleDescription") {
        event.preventDefault();
        const drawer = target.closest(".carl-chat-desc-drawer");
        if (!drawer) return;
        const collapsed = drawer.classList.toggle("collapsed");
        target.setAttribute("aria-expanded", String(!collapsed));
        return;
      }

      const entry = BY_ACTION.get(target.dataset.action);
      // Don't preventDefault for an unrecognized action - keeps Foundry
      // core's own .dice-roll click-to-expand-tooltip behavior working for
      // roll-row.hbs's data-action="expandRoll", which nothing here handles.
      if (!entry) return;
      event.preventDefault();
      if (isBlocked(entry, message)) return; // re-check at click time: closes
                                              // a race if two clients click
                                              // near-simultaneously.
      void entry.onClick(event, message, target);
    });
  });
}
