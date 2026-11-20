/**
 * A vehicle's built-in weapons (system.attacks - the book's "Mounted
 * Weapons", crafted with Engineering, p.73; a ship's cannons). The book
 * gives them no stats beyond damage and range, so each names the Attack
 * Skill and Stat its gunner rolls with. A crawler (or Pet) occupant fires
 * one as their own Attack - d20 + their Rank in that Skill + the Stat Mod
 * vs. the target's Evade - using it is exempt from the driver's
 * Disadvantage ("use one of your vehicle's built-in weapons", p.72), and
 * an untrained gunner rolls with Disadvantage. A GM-crewed vehicle fires
 * the same entry as a Mob Attack (its to-hit) through CarlDice.rollMobAttack.
 *
 * The weapon is built as an unsaved Attack Skill on the gunner at their
 * Rank, the way a Scroll's Spell is (module/helpers/scroll-cast.mjs) - it's
 * passed as `castAs`, which skips Mana and the Advancement use-mark.
 */
import CarlDice from "../dice/dice.mjs";
import { rollsLikeCrawler } from "./actor-kinds.mjs";
import { buildItemSkillEntry, ownedRank } from "./modifiers.mjs";
import { findOwnedSkillLike } from "./race-class-grants.mjs";
import { vehicleOccupants } from "./vehicle-state.mjs";
import { cancelButton, showCarlDialog } from "../apps/carl-dialog.mjs";

/**
 * The unsaved Attack Skill for a gunner firing one built-in weapon, and its
 * castAs (see CarlDice.rollAttack).
 * @param {Actor} vehicle
 * @param {number} index
 * @param {Actor} gunner
 * @returns {{item: Item, castAs: object}|null}
 */
export function buildWeaponFire(vehicle, index, gunner) {
  const weapon = vehicle.system.attacks?.[index];
  if (!weapon) return null;
  // The gunner's Rank as their rolls read it: worn gear's "+N" included.
  const owned = weapon.skill ? findOwnedSkillLike(gunner, weapon.skill) : null;
  const rank = owned ? ownedRank(gunner, owned) : 0;
  const data = {
    _id: foundry.utils.randomID(),
    name: game.i18n.format("CARLRPG.Vehicle.WeaponName", {
      weapon: weapon.name || "?",
      vehicle: vehicle.name,
    }),
    type: "skill",
    img: vehicle.img,
    system: {
      rank,
      category: "attack",
      governingStat: weapon.stat || "dex",
      range: weapon.range ?? "",
      marked: false,
      baseDamage: {
        dice: String(weapon.damage ?? "").replace(/\bF\b/g, "@floor"),
        stat: "",
        damageType: weapon.damageType ?? "",
      },
    },
  };
  const item = new Item.implementation(data, { parent: gunner });
  const { skillEntry, conditionalModifiers } = buildItemSkillEntry(gunner.system, item);
  return {
    item,
    castAs: {
      skillEntry,
      conditionalModifiers,
      free: true,
      spellData: data,
      rank,
      builtIn: { vehicleUuid: vehicle.uuid, index },
    },
  };
}

/**
 * The occupants this user can fire a weapon as: crawlers and Pets aboard
 * that they own (all of them, for the GM).
 * @param {Actor} vehicle
 * @returns {Actor[]}
 */
export function gunnersFor(vehicle) {
  return vehicleOccupants(vehicle)
    .map((o) => o.actor)
    .filter((a) => a && rollsLikeCrawler(a) && (game.user.isGM || a.isOwner));
}

/**
 * Fire one built-in weapon at the user's targets: as their selected token's
 * actor if it's aboard, the only occupant they can, or the one they pick.
 * @param {Actor} vehicle
 * @param {number} index
 * @param {{gunner?: Actor, skipDialog?: boolean}} [options]
 * @returns {Promise<ChatMessage|null>}
 */
export async function fireVehicleWeapon(
  vehicle,
  index,
  { gunner = null, skipDialog = false } = {},
) {
  const gunners = gunnersFor(vehicle);
  if (!gunners.length) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Vehicle.NoGunner", { vehicle: vehicle.name }));
    return null;
  }
  let shooter = gunner && gunners.includes(gunner) ? gunner : null;
  if (!shooter) {
    const selected = (canvas.tokens?.controlled ?? []).map((t) => t.actor);
    shooter =
      gunners.find((g) => selected.includes(g)) ?? (gunners.length === 1 ? gunners[0] : null);
  }
  if (!shooter) shooter = await pickGunner(gunners);
  if (!shooter) return null;
  const fire = buildWeaponFire(vehicle, index, shooter);
  if (!fire) return null;
  return CarlDice.rollAttack(shooter, fire.item, { skipDialog, castAs: fire.castAs });
}

/** Ask which occupant fires. */
async function pickGunner(gunners) {
  const options = gunners
    .map((g, i) => `<option value="${i}">${foundry.utils.escapeHTML(g.name)}</option>`)
    .join("");
  const result = await showCarlDialog({
    title: game.i18n.localize("CARLRPG.Vehicle.PickGunner"),
    content: `<div class="carl-dialog-body"><div class="form-group">
      <label>${game.i18n.localize("CARLRPG.Vehicle.Gunner")}</label><select name="gunner">${options}</select>
    </div></div>`,
    buttons: [
      {
        action: "fire",
        icon: "fa-solid fa-crosshairs",
        label: "CARLRPG.Vehicle.Fire",
        default: true,
        callback: (event, button) => Number(button.form.elements.gunner.value),
      },
      cancelButton(),
    ],
  });
  return Number.isInteger(result) ? (gunners[result] ?? null) : null;
}
