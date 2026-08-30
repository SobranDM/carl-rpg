import CarlDice from "../dice/dice.mjs";
import { createCardMessage } from "../chat/chat-card.mjs";

/**
 * Extend the basic Item document.
 * @extends {Item}
 */
export class CarlRPGItem extends Item {
  /** @override */
  prepareData() {
    super.prepareData();
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

    if (this.type === "skill" || this.type === "spell") {
      // Skills flag themselves directly (isAttack / category "attack").
      // Spells instead carry a castingKeywords array (module/data/spell.mjs)
      // - "attack" there is the equivalent signal (Fire Fingers, Magic
      // Missile, Fireball, Fear all set it) and must route the same way:
      // rollAttack is what actually rolls to-hit vs. Evade, rolls damage,
      // and detects a Critical Hit, all of which the target-effects
      // pipeline (module/chat/target-effects-card.mjs) depends on.
      const isSkillAttack = this.type === "skill"
        && (this.system.isAttack || this.system.category === "attack");
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
      // Damage Effects are selected at attack time (see CarlDice.rollAttack's
      // damageEffectItem option), not rolled standalone.
      return createCardMessage({
        title: this.name,
        img: this.img,
        body: this.system.description ?? "",
        actor: this.actor,
      });
    }

    return createCardMessage({
      title: this.name,
      img: this.img,
      body: this.system.description ?? "",
      actor: this.actor,
    });
  }
}
