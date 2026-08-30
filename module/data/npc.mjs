import CarlRPGActorBase from "./actor-base.mjs";
import { getStatMod } from "../helpers/rules.mjs";
import { aggregateActorBonuses, computeActiveShieldSlots } from "../helpers/modifiers.mjs";

/**
 * Mob/NPC actor. Deliberately minimal - full Mob stat-block automation
 * (Evade formulas, quality tiers, AI behavior, etc. from the bestiary
 * chapters) is out of scope for this pass; this exists so a GM can stat up
 * a Mob using the same Stat/Skill/modifier machinery as a Character.
 */
export default class CarlRPGNPC extends CarlRPGActorBase {

  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    const schema = super.defineSchema();

    schema.mobTier = new fields.StringField({
      required: false, blank: true, initial: "",
      choices: ["", "neighborhood", "borough", "city", "province", "country", "floor"],
    });

    const statKeys = Object.keys(CONFIG.CARLRPG.stats);
    const statsSchema = {};
    for (const stat of statKeys) {
      statsSchema[stat] = new fields.SchemaField({
        // See character.mjs: value is the editable base, bonus/effective/mod
        // are derived-only every pass and must never be written back to value.
        value: new fields.NumberField({ ...requiredInteger, initial: 3, min: 1 }),
        bonus: new fields.NumberField({ ...requiredInteger, initial: 0 }),
        effective: new fields.NumberField({ ...requiredInteger, initial: 3 }),
        mod: new fields.NumberField({ ...requiredInteger, initial: 0 }),
        label: new fields.StringField({ required: true, blank: true }),
      });
    }
    schema.stats = new fields.SchemaField(statsSchema);

    // Active Debuffs/Buffs (Table 11) - same shape as character.mjs. Needed
    // here too since Mobs/NPCs are the far more common target of an Attack's
    // "Apply to Target(s)" button (module/chat/target-effects-card.mjs) than
    // other player characters.
    schema.conditions = new fields.ArrayField(
      new fields.SchemaField({
        id: new fields.StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
        key: new fields.StringField({ required: true, blank: false }), // key into CONFIG.CARLRPG.debuffs, or "custom"
        label: new fields.StringField({ required: false, blank: true, initial: "" }),
        stacks: new fields.NumberField({ ...requiredInteger, initial: 1, min: 1 }),
        remaining: new fields.NumberField({ required: false, nullable: true, integer: true, initial: null }),
        source: new fields.StringField({ required: false, blank: true, initial: "" }),
      }),
      { required: false, initial: [] }
    );

    return schema;
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    if (!this.stats) return;

    // See CarlRPGCharacter#prepareDerivedData - aggregateActorBonuses never
    // mutates this.stats[*].value directly, only the derived-only bonus/mod.
    aggregateActorBonuses(this);

    for (const key in this.stats) {
      if (!this.stats[key]) continue;
      const bonus = this.bonuses?.[`stats.${key}`] ?? 0;
      const effective = this.stats[key].value + bonus;
      this.stats[key].bonus = bonus;
      this.stats[key].effective = effective;
      this.stats[key].mod = getStatMod(effective);
      this.stats[key].label = game.i18n.localize(CONFIG.CARLRPG.stats[key]) ?? key;
    }

    this.hb.slotValue = this.stats.con?.mod ?? 0;
    this.hb.bonusMax = this.bonuses?.["hb.max"] ?? 0;
    this.hb.effectiveMax = this.hb.max + this.hb.bonusMax;
    this.mana.max = (this.stats.int?.value ?? 0) + (this.bonuses?.["mana.max"] ?? 0);

    // Shield-style pool (docs/known-gaps.md 1.4) - see character.mjs. NPCs
    // almost never own a toggled shield spell, but the schema is shared via
    // actor-base.mjs, so this must derive correctly if one somehow does.
    this.shield.slotValue = this.stats.con?.mod ?? 0;
    this.shield.effectiveMax = computeActiveShieldSlots(this.parent?.items ? Array.from(this.parent.items) : []);
    if (this.shield.value > this.shield.effectiveMax) this.shield.value = this.shield.effectiveMax;
  }

  getRollData() {
    const data = {};
    if (this.stats) {
      data.stats = {};
      for (let [k, v] of Object.entries(this.stats)) {
        data.stats[k] = foundry.utils.deepClone(v);
      }
    }
    if (this.skills) data.skills = foundry.utils.deepClone(this.skills);
    // Floor is a single world-wide value, owned by the GM Toolbox - never
    // stored per-actor. See CarlRPGCharacter#getRollData.
    data.floor = game.settings.get("carl-rpg", "currentFloor");
    return data;
  }
}
