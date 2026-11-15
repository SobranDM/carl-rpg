import CarlDice from "../dice/dice.mjs";
import { createCardMessage } from "../chat/chat-card.mjs";
import { bakeItemGrants } from "../helpers/race-class-grants.mjs";
import { applyRaceSize } from "../helpers/size.mjs";
import { useConsumable } from "../helpers/consumables.mjs";
import { isPet } from "../helpers/actor-kinds.mjs";
import { describePetCommand, petFight } from "../helpers/pet-command.mjs";
import { refuseOutsideHotlist } from "../helpers/hotlist.mjs";
import { hotlistWithout } from "../helpers/equip-slots.mjs";
import { refuseWhileSwapping } from "../helpers/swap-lock.mjs";

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
    if (game.user.id !== userId) return;
    if ((this.type === "class" || this.type === "race") && foundry.utils.hasProperty(changed, "system.changes")) {
      await bakeItemGrants(this);
    }
  }

  /**
   * Equipping, however it's done (the Slot column, the Item sheet's box, a
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
    const equipped = foundry.utils.getProperty(changed, "system.equipped");
    if (this.type !== "item" || !this.actor || equipped === undefined || equipped === this.system.equipped) return;
    if (!options.carlSwap && refuseWhileSwapping(this.actor)) {
      // The box was ticked in the form but nothing was saved: redraw it.
      if (this.sheet?.rendered) this.sheet.render();
      return false;
    }
    if (equipped) {
      const hotlist = hotlistWithout(this.actor, this.id);
      if (hotlist) await this.actor.update({ "system.hotlist": hotlist });
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
