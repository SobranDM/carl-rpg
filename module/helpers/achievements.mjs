import { copyData } from "./packs.mjs";
import { currentFloor } from "./floor.mjs";
import { boxName, giveBox } from "./boxes.mjs";
import { rewardBox } from "./reward-text.mjs";
import { createCardMessage } from "../chat/chat-card.mjs";
import { enrichDescription } from "./rich-text.mjs";
import { esc } from "./html.mjs";
import { queueForActor } from "./actor-queue.mjs";

/**
 * Achievements (data/achievement.mjs; docs/loot-and-achievements.md):
 * awarding one to a crawler (GM), taking it back, and the settings.
 *
 * An awarded copy carries its definition's uuid in a flag, so the GM's
 * grid (apps/achievement-grid.mjs) can tell who has which. Its splash
 * (apps/achievement-splash.mjs) shows only to the crawler's player, and
 * stays until they close it (ruled 2026-11-19).
 */

const SCOPE = "carl-rpg";
/** The flag on an awarded copy: its definition's uuid. */
export const SOURCE_FLAG = "achievementSource";

/** Register the achievement settings (init). */
export function registerAchievementSettings() {
  // Ruled 2026-11-19: off, no chat card at all; on, a public one.
  game.settings.register(SCOPE, "postAchievementsToChat", {
    name: "CARLRPG.Achievement.Settings.PostToChat",
    hint: "CARLRPG.Achievement.Settings.PostToChatHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
  // The compendium the GM's grid also lists achievements from.
  game.settings.register(SCOPE, "achievementGridPack", {
    scope: "client",
    config: false,
    type: String,
    default: "",
  });
}

/**
 * The definition an awarded copy came from.
 * @param {Item} copy
 * @returns {string}  Its uuid, or "".
 */
export function definitionOf(copy) {
  return copy?.getFlag(SCOPE, SOURCE_FLAG) ?? "";
}

/**
 * A crawler's copy of an achievement, if it has been awarded it.
 * @param {Actor} actor
 * @param {string} definitionUuid
 * @returns {Item|null}
 */
export function awardedCopy(actor, definitionUuid) {
  return (
    actor?.items.find((i) => i.type === "achievement" && definitionOf(i) === definitionUuid) ?? null
  );
}

/**
 * A crawler's awarded achievements, newest first.
 * @param {Actor} actor
 * @returns {Item[]}
 */
export function achievementsOf(actor) {
  return (actor?.items ?? [])
    .filter((i) => i.type === "achievement")
    .sort((a, b) => (b._stats?.createdTime ?? 0) - (a._stats?.createdTime ?? 0));
}

/**
 * The loot box an achievement gives: its tier is the achievement's grade,
 * its title the Reward line's box ("Bronze Crafter's Box"), else "<Tier> Box".
 * @param {Item} achievement
 * @returns {{tierKey: string, name: string}|null}  Null if it gives none.
 */
export function achievementBox(achievement) {
  const sys = achievement.system;
  if (!sys.lootBox) return null;
  const fromReward = rewardBox(sys.reward);
  return { tierKey: sys.grade, name: fromReward?.title || sys.reward.trim() || boxName(sys.grade) };
}

/**
 * Award an achievement to a crawler (GM): a copy on them - unseen, so its
 * splash shows to their player - and, if it gives one, a loot box from it
 * (opened later). Posted to chat if the world setting says so. Awarding
 * one they already have does nothing; it runs in the crawler's queue, so
 * two clicks can't award it twice.
 * @param {Item} definition  An Achievement in the sidebar or a compendium.
 * @param {Actor} actor  A Character.
 * @returns {Promise<Item|null>}  The copy.
 */
export async function awardAchievement(definition, actor) {
  if (!game.user.isGM || definition?.type !== "achievement" || actor?.type !== "character") {
    return null;
  }
  return queueForActor(actor.uuid, () => award(definition, actor));
}

/** awardAchievement, in the crawler's queue. */
async function award(definition, actor) {
  if (awardedCopy(actor, definition.uuid)) return null;
  const data = copyData(definition);
  const box = achievementBox(definition);
  foundry.utils.mergeObject(data, {
    flags: { [SCOPE]: { [SOURCE_FLAG]: definition.uuid } },
    system: { awardedFloor: currentFloor(), seen: false, rewarded: !box },
  });
  const [copy] = await actor.createEmbeddedDocuments("Item", [data]);
  if (!copy) return null;
  if (box) {
    await giveBox(actor, {
      tierKey: box.tierKey,
      name: box.name,
      source: { kind: "achievement", uuid: copy.uuid },
    });
  }
  if (game.settings.get(SCOPE, "postAchievementsToChat")) await postAchievementCard(copy, actor);
  return copy;
}

/**
 * The achievement an Item names: a definition as it is, an awarded copy's
 * definition (a copy dragged from another crawler's sheet).
 * @param {Item} item
 * @returns {Promise<Item|null>}
 */
export async function definitionFor(item) {
  if (item?.type !== "achievement") return null;
  if (!item.parent) return item;
  const def = await fromUuid(definitionOf(item));
  return def?.type === "achievement" ? def : null;
}

/**
 * Take an awarded achievement back (GM): the copy, and its loot box if it
 * hasn't been opened.
 * @param {Item} copy
 * @returns {Promise<void>}
 */
export async function revokeAchievement(copy) {
  const actor = copy?.parent;
  if (!game.user.isGM || copy?.type !== "achievement" || !actor) return;
  const boxes = actor.items.filter((i) => i.type === "box" && i.system.source.uuid === copy.uuid);
  if (boxes.length)
    await actor.deleteEmbeddedDocuments(
      "Item",
      boxes.map((b) => b.id),
    );
  await copy.delete();
}

/** The public chat card for an awarded achievement (the world setting). */
async function postAchievementCard(copy, actor) {
  const sys = copy.system;
  const description = await enrichDescription(sys.description, copy);
  const reward = sys.reward
    ? `<p><strong>${esc(game.i18n.localize("CARLRPG.Achievement.Reward"))}:</strong> ${esc(sys.reward)}</p>`
    : "";
  return createCardMessage({
    title: game.i18n.localize("CARLRPG.Achievement.New"),
    subtitle: game.i18n.format("CARLRPG.Achievement.CardSubtitle", {
      name: actor.name,
      achievement: copy.name,
    }),
    img: copy.img,
    body: `<h3>${esc(copy.name)}</h3>${description}${reward}`,
  });
}
