import CarlRPGItemBase from "./item-base.mjs";
import { defineChangesField } from "./shared/change-entry.mjs";
import { defineGearTargetEffectsField } from "./shared/upgrade-tier.mjs";

export default class CarlRPGItem extends CarlRPGItemBase {

  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    const schema = super.defineSchema();

    schema.quantity = new fields.NumberField({ ...requiredInteger, initial: 1, min: 0 });
    schema.weight = new fields.NumberField({ required: true, nullable: false, initial: 0, min: 0 });
    schema.equipped = new fields.BooleanField({ required: true, initial: false });
    // A weapon: the Attack Skill it's wielded with (e.g. "Longsword"). An
    // Attack with that Skill needs it in hand or in the Hotlist
    // (module/helpers/weapons.mjs). Blank for anything that isn't a weapon.
    schema.weaponSkill = new fields.StringField({ required: true, blank: true, initial: "" });
    // Where it can be worn (Gear Slots, p.98-99; module/helpers/gear.mjs):
    // one or more of CONFIG.CARLRPG.wearSlots ("Accessory or Head"; all for
    // "Any"). Empty: it can't be worn until one is set (a Weapon Skill
    // always makes it Held). DR from worn gear stacks across slot types,
    // but only the best piece within one counts (modifiers.mjs
    // supersededArmorIds; p.225). The old "Armor" box is gone with that.
    schema.slots = new fields.ArrayField(
      new fields.StringField({ required: true, blank: false, choices: () => Object.keys(CONFIG.CARLRPG.wearSlots) }),
      { required: true, initial: [] },
    );
    // Held in both hands ("Limitation: Two-Handed", p.98).
    schema.twoHanded = new fields.BooleanField({ required: true, initial: false });
    // An Accessory's kind: one Belt and one Cape at most (p.99).
    schema.accessoryKind = new fields.StringField({
      required: true, blank: true, initial: "", choices: () => Object.keys(CONFIG.CARLRPG.accessoryKinds),
    });
    // On-hit Debuffs it gives its holder's or wearer's Attacks while
    // equipped ("AS: Target gains Burned", p.116; p.223), optionally only
    // with listed Attack Skills (modifiers.mjs attackTargetEffects).
    schema.targetEffects = defineGearTargetEffectsField();
    // A weapon whose Attacks are Armor-Piercing: they ignore DR, except DR
    // from gear marked Anti-Piercing (modifiers.mjs attackIsArmorPiercing).
    schema.armorPiercing = new fields.BooleanField({ required: true, initial: false });
    // Anti-Piercing (p.95): "The DR of a piece of armor with this quality
    // applies against Armor-Piercing damage" - this piece's DR still counts
    // against an Armor-Piercing hit (modifiers.mjs, drAntiPiercing).
    schema.antiPiercing = new fields.BooleanField({ required: true, initial: false });

    // A usable, single-use item (Item Rules, p.99): Potions, Scrolls,
    // Spellbooks and other consumables like Bandages. Blank kind = ordinary
    // gear. Using one: module/helpers/consumables.mjs.
    const text = () => new fields.StringField({ required: true, blank: true, initial: "" });
    const optionalInt = (extra = {}) => new fields.NumberField({ required: true, nullable: true, integer: true, initial: null, ...extra });
    schema.consumable = new fields.SchemaField({
      // "potion" counts toward Potion Sickness; "other" (Bandages, ...) doesn't.
      kind: new fields.StringField({
        required: true, blank: true, initial: "",
        choices: ["", "potion", "scroll", "spellbook", "other"],
      }),
      heal: new fields.SchemaField({
        slots: optionalInt({ min: 0 }),
        full: new fields.BooleanField({ required: true, initial: false }),
        // "minor": mend one Minor Injury; "any": one Minor or Major Injury.
        mend: new fields.StringField({ required: true, blank: true, initial: "", choices: ["", "minor", "any"] }),
      }),
      mana: new fields.SchemaField({
        amount: optionalInt({ min: 0 }),
        full: new fields.BooleanField({ required: true, initial: false }),
      }),
      // Debuff keys this cures (a Poison Antidote: poisoned).
      cures: new fields.ArrayField(new fields.StringField({ required: true, blank: false }), { required: true, initial: [] }),
      // A permanent +N Stat or Skill potion. A blank Skill target is chosen
      // when it's drunk ("Choose a Skill and gain 3 Ranks in it").
      permanent: new fields.SchemaField({
        kind: new fields.StringField({ required: true, blank: true, initial: "", choices: ["", "stat", "skill"] }),
        target: text(),
        value: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 1 }),
      }),
      // A timed Buff (Iron Skin: DR x2 for 30 minutes) - a condition entry
      // carrying these changes until it expires.
      buff: new fields.SchemaField({
        label: text(),
        duration: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0, min: 0 }),
        unit: new fields.StringField({ required: true, blank: false, initial: "minutes", choices: ["rounds", "minutes", "hours"] }),
        changes: defineChangesField(),
        // Restored at the end of each round while it lasts ("Restores 15
        // Mana per round for 10 rounds" - Good Mana Refill Potion).
        perRound: new fields.SchemaField({
          hb: optionalInt({ min: 0 }),
          mana: optionalInt({ min: 0 }),
        }),
      }),
      // The Spell a Scroll casts or a Spellbook teaches. Blank name/rank are
      // read from the item name ("Scroll of Bang Bro (Rank 3)").
      spell: new fields.SchemaField({
        name: text(),
        uuid: text(),
        rank: optionalInt({ min: 1, max: 20 }),
      }),
    });

    return schema;
  }
}
