import CarlDice from "../dice/dice.mjs";
import { createCardMessage } from "../chat/chat-card.mjs";
import { bakeItemGrants } from "../helpers/race-class-grants.mjs";
import { applyRaceSize } from "../helpers/size.mjs";
import { useConsumable } from "../helpers/consumables.mjs";
import { isPet } from "../helpers/actor-kinds.mjs";
import { describePetCommand, petFight } from "../helpers/pet-command.mjs";
import { refuseOutsideHotlist } from "../helpers/hotlist.mjs";
import { freeSlotFor, hotlistWithout, isItemWorn, placeInFreeSlot, takeOutOfSlots } from "../helpers/equip-slots.mjs";
import { refuseWhileSwapping } from "../helpers/swap-lock.mjs";
import { canAct, combatantInFight, gearRecord, spendAction } from "../helpers/actions.mjs";
import { HANDS, accessoryKindOf, canWear, fitsSlot, isConsumable, isTwoHanded, slotsOf } from "../helpers/gear.mjs";

/** "Head, Accessory": where a piece of gear is worn, for a warning. */
function slotsOfProbe(item) {
  return slotsOf(item).map((s) => game.i18n.localize(CONFIG.CARLRPG.wearSlots[s] ?? s)).join(", ");
}

/**
 * Extend the basic Item document.
 * @extends {Item}
 */
export class CarlRPGItem extends Item {
  /** @override */
  prepareData() {
    super.prepareData();
  }

  /**
   * A Spell can't be cast without Ranks (p.58/p.201), and a crawler only owns
   * a Spell once they've learned it - so a Spell added to an actor at Rank 0
   * (every compendium Spell is authored that way, including the starting
   * Heal) arrives at Rank 1. A Rank set on purpose afterwards is left alone.
   * @override
   */
  async _preCreate(data, options, user) {
    const allowed = await super._preCreate(data, options, user);
    if (allowed === false) return false;
    if (this.type === "spell" && this.parent && (this.system.rank ?? 0) < 1) {
      this.updateSource({ "system.rank": 1 });
    }
  }

  /**
   * Bake a newly-owned class/race item's eligible stat/skillRank grants
   * into the actor's base values (see module/helpers/race-class-grants.mjs)
   * - a one-time permanent bump, not a live bonus - and a new Race's Size
   * becomes the Character's (helpers/size.mjs) - unless the creator passes
   * `carlKeepSize` (an import that brings its own Size). No-ops for every
   * other item type/ownership state.
   * @override
   */
  async _onCreate(data, options, userId) {
    super._onCreate(data, options, userId);
    if (game.user.id !== userId) return;
    if (this.type === "class" || this.type === "race") await bakeItemGrants(this);
    if (this.type === "race" && !options.carlKeepSize) await applyRaceSize(this);
  }

  /**
   * If a GM hand-edits an owned class/race item's own Changes array (adding
   * a new stat/skillRank grant after the item was already added), bake the
   * new entry the same way item creation does - array fields don't have
   * their own per-element create hook, so this is the only place a
   * post-hoc addition gets picked up.
   * @override
   */
  async _onUpdate(changed, options, userId) {
    super._onUpdate(changed, options, userId);
    // A migration's write (helpers/migration.mjs) never bakes: it doesn't
    // add grants, and a copy that was never baked mustn't start now.
    if (game.user.id !== userId || options.carlMigration) return;
    if ((this.type === "class" || this.type === "race") && foundry.utils.hasProperty(changed, "system.changes")) {
      await bakeItemGrants(this);
    }
  }

  /**
   * Equipping, however it's done (the Equipment Doll, the Equipped box, a
   * macro):
   *  - refused while a Hotlist swap is under way on this client
   *    (swap-lock.mjs), unless it's the swap's own write;
   *  - takes the item out of the Hotlist - worn gear and the Hotlist are
   *    exclusive ("Items in Hotlists do not grant you any added benefits",
   *    p.98). Done here, before the update, so the Hotlist is already clean
   *    when `await item.update(...)` returns (_onUpdate isn't awaited).
   * @override
   */
  async _preUpdate(changed, options, user) {
    if ((await super._preUpdate(changed, options, user)) === false) return false;
    // Where it's worn changed while it's worn: off whatever it no longer fits.
    const slotFields = ["system.slots", "system.twoHanded", "system.accessoryKind"].some((p) => foundry.utils.hasProperty(changed, p));
    if (this.type === "item" && slotFields && !options.carlMigration && this.actor?.type === "character" && isItemWorn(this.actor, this.id)) {
      await this.#refitWorn(changed, options);
    }
    const equipped = foundry.utils.getProperty(changed, "system.equipped");
    if (this.type !== "item" || !this.actor || equipped === undefined || equipped === this.system.equipped) return;
    // The Equipped box (or a macro) - not the doll, a swap, an undo or a
    // migration, which place the item themselves (docs/gear-slots.md).
    const byBox = !options.carlMigration && !options.carlInAction && !options.carlSwap && !options.carlUndo;
    // Its slots may be set in this same update.
    const probe = byBox && equipped
      ? { id: this.id, name: this.name, type: this.type, actor: this.actor,
        system: foundry.utils.mergeObject(this.toObject(), changed, { inplace: false }).system }
      : null;
    // Gear with no slot can't be worn until one is set; a consumable never is.
    if (probe && !canWear(probe)) {
      const key = isConsumable(probe) ? "CARLRPG.Gear.ConsumableNotWorn" : "CARLRPG.Gear.NoSlot";
      ui.notifications?.warn(game.i18n.format(key, { item: this.name }));
      if (this.sheet?.rendered) this.sheet.render();
      return false;
    }
    // On a Character it goes in its first free slot - or not at all: no
    // second helmet worn beside the first (p.98).
    const placing = !!probe && this.actor.type === "character" && !isItemWorn(this.actor, this.id);
    const boxSlot = placing ? freeSlotFor(this.actor, probe) : null;
    if (placing && !boxSlot) {
      const where = slotsOfProbe(probe);
      ui.notifications?.warn(game.i18n.format("CARLRPG.Gear.NoFreeSlot", { item: this.name, slots: where }));
      if (this.sheet?.rendered) this.sheet.render();
      return false;
    }
    if (!options.carlSwap && !options.carlUndo && refuseWhileSwapping(this.actor)) {
      // The box was ticked in the form but nothing was saved: redraw it.
      if (this.sheet?.rendered) this.sheet.render();
      return false;
    }
    // Putting gear on or taking it off in a fight is the Retrieve Action
    // (p.86; helpers/actions.mjs). The equip helpers (equip-slots.mjs) and
    // a swap pay for it as their own Action (carlInAction / carlSwap); this
    // is the Item sheet's Equipped box, or a macro - one Action for the whole
    // batch (Foundry hands every item in one update the same options).
    const paid = options.carlSwap || options.carlInAction || options.carlUndo || options.carlRetrieveCharged;
    if (!paid && combatantInFight(this.actor)) {
      if (!canAct(this.actor, "other")) {
        if (this.sheet?.rendered) this.sheet.render();
        return false;
      }
      options.carlRetrieveCharged = true;
      await spendAction(this.actor, "other", game.i18n.format("CARLRPG.Actions.Label.Retrieve", { item: this.name }), {
        undo: [gearRecord(this.actor)],
      });
    }
    if (boxSlot) await placeInFreeSlot(this.actor, boxSlot, probe);
    // Unticked on a Character: out of its slot too.
    if (!equipped && byBox && this.actor.type === "character") await takeOutOfSlots(this.actor, this);
    if (equipped) {
      const hotlist = hotlistWithout(this.actor, this.id);
      if (hotlist) await this.actor.update({ "system.hotlist": hotlist });
    }
  }

  /**
   * Its slots, Two-handed or Belt/Cape changed while it's worn on a
   * Character (docs/gear-slots.md): out of any doll slot it no longer fits,
   * a second Belt or Cape out of the Accessories, and a now two-handed item
   * in a hand takes the other hand - or comes off if that's full. Taken off
   * everywhere, it's unequipped in this same update.
   * @param {object} changed
   * @param {object} options
   */
  async #refitWorn(changed, options) {
    const actor = this.actor;
    const probe = { id: this.id, name: this.name, type: this.type, actor,
      system: foundry.utils.mergeObject(this.toObject(), changed, { inplace: false }).system };
    const gearSlots = { ...actor.system.gearSlots };
    for (const [key, id] of Object.entries(gearSlots)) {
      if (id === this.id && !fitsSlot(probe, { slotType: "gear", slotKey: key })) gearSlots[key] = "";
    }
    if (isTwoHanded(probe) && HANDS.some((hand) => gearSlots[hand] === this.id)) {
      const other = HANDS.find((hand) => gearSlots[hand] !== this.id);
      if (other && gearSlots[other] && actor.items.get(gearSlots[other])) {
        for (const hand of HANDS) if (gearSlots[hand] === this.id) gearSlots[hand] = "";
      } else if (other) gearSlots[other] = this.id;
    }
    let accessories = actor.system.accessories ?? [];
    if (accessories.includes(this.id)) {
      const kind = accessoryKindOf(probe);
      const clash = kind && accessories.some((id) => id !== this.id && accessoryKindOf(actor.items.get(id)) === kind);
      if (!fitsSlot(probe, { slotType: "accessory", slotKey: "0" }) || clash) accessories = accessories.filter((id) => id !== this.id);
    }
    const moved = JSON.stringify(gearSlots) !== JSON.stringify(actor.system.gearSlots)
      || accessories.length !== (actor.system.accessories ?? []).length;
    if (!moved) return;
    await actor.update({ "system.gearSlots": gearSlots, "system.accessories": accessories });
    if (!isItemWorn(actor, this.id)) {
      foundry.utils.setProperty(changed, "system.equipped", false);
      // Not a Retrieve: the sheet edit took it off.
      options.carlInAction = true;
      ui.notifications?.info(game.i18n.format("CARLRPG.Gear.TakenOff", { item: this.name }));
    }
  }

  /** @override */
  getRollData() {
    const rollData = { ...super.getRollData() };
    if (!this.actor) return rollData;
    Object.assign(rollData, this.actor.getRollData());
    return rollData;
  }

  /**
   * Skill/Spell/Damage Effect: trigger a Skill Check or Attack roll (see
   * module/dice/dice.mjs). Gear/Features: post their description to chat.
   * @override
   */
  async roll() {
    if (!this.actor) {
      return ui.notifications.warn(game.i18n.localize("CARLRPG.Warning.RollNeedsOwner"));
    }

    // A Mob's Attack: declared or posted against the targets (Mobs never roll).
    if (this.type === "mobAttack") return CarlDice.rollMobAttack(this.actor, this.id);

    // "If a Spell ain't in your Hotlist, you can't cast it until you Retrieve
    // it" (p.86) - in a fight. A Spell already switched on can be switched off.
    if (this.type === "spell" && !this.system.active && refuseOutsideHotlist(this.actor, this)) return null;

    if (this.type === "skill" || this.type === "spell") warnPetCommand(this);

    if (this.type === "skill" || this.type === "spell") {
      // Skills flag themselves directly via category "attack" (isAttack
      // used to exist as a separate boolean, but an audit found every
      // authored Skill kept it in lockstep with category - it was pure
      // duplication, removed). Spells instead carry a castingKeywords
      // array (module/data/spell.mjs) - "attack" there is the equivalent
      // signal (Fire Fingers, Magic Missile, Fireball, Fear all set it)
      // and must route the same way: rollAttack is what actually rolls
      // to-hit vs. Evade, rolls damage, and detects a Critical Hit, all of
      // which the target-effects pipeline (module/chat/target-effects-card.mjs)
      // depends on.
      const isSkillAttack = this.type === "skill" && this.system.category === "attack";
      const isSpellAttack = this.type === "spell" && this.system.castingKeywords?.includes("attack");
      if (isSkillAttack || isSpellAttack) {
        return CarlDice.rollAttack(this.actor, this);
      }

      // Same routing gap as "attack" above (see docs/known-gaps.md 1.1/1.2):
      // Heal Self is authored isPassive:true (it's not a Skill Check you can
      // fail), which would otherwise hit rollSkillCheck's PassiveNoCheck
      // warning and never actually heal. "heal" bypasses that the same way
      // "attack" bypasses it, routing into the dedicated Heal roll flow
      // instead (module/dice/dice.mjs's rollHeal).
      const isSpellHeal = this.type === "spell" && this.system.castingKeywords?.includes("heal");
      if (isSpellHeal) {
        return CarlDice.rollHeal(this.actor, this);
      }

      // Toggled ongoing-effect spells (docs/known-gaps.md 1.4) - cast to
      // activate/deactivate rather than a one-shot Skill Check, so this bypasses
      // rollSkillCheck's isPassive rejection the same way isSpellHeal does above.
      const isSpellToggle = this.type === "spell" && this.system.isToggled;
      if (isSpellToggle) {
        return CarlDice.rollToggleSpell(this.actor, this);
      }
      return CarlDice.rollSkillCheck(this.actor, this);
    }

    if (this.type === "damageEffect") {
      // "Choose one available Damage Effect before you make the Attack
      // Skill Check" (Playing the Game) - rolling a Damage Effect directly
      // resolves which owned Skill/Spell it's attached to (parentSkills)
      // and rolls THAT Attack with this Damage Effect applied, rather than
      // posting a description-only card.
      return CarlDice.rollDamageEffect(this.actor, this);
    }

    // A consumable (Potion, Scroll, Spellbook...) is used, not described -
    // module/helpers/consumables.mjs.
    if (this.type === "item" && this.system.consumable?.kind) {
      return useConsumable(this.actor, this);
    }

    return createCardMessage({
      title: this.name,
      img: this.img,
      body: this.system.description ?? "",
      actor: this.actor,
    });
  }
}

/**
 * A reminder, not a block (the system has no Action economy): a Pet in a
 * running fight only acts once Command Pet says so, and a "restricted" one
 * only Evades, Moves or Attacks (p.232, module/helpers/pet-command.mjs).
 * @param {Item} item  A Skill or Spell about to be used.
 */
function warnPetCommand(item) {
  const pet = item.actor;
  if (!isPet(pet) || pet.system.isMount) return;
  const fight = petFight(pet);
  if (!fight) return;
  const command = describePetCommand(pet);
  const isAttack = (item.type === "skill" && item.system.category === "attack")
    || (item.type === "spell" && item.system.castingKeywords?.includes("attack"));
  if (!command.active || pet.system.command.combatId !== fight.id || ["stayingOut", "hiding"].includes(command.state)) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Pet.Command.WarnNotFighting", { name: pet.name }));
  } else if (command.state === "restricted" && !isAttack) {
    ui.notifications.warn(game.i18n.format("CARLRPG.Pet.Command.WarnRestricted", { name: pet.name }));
  }
}
