import CarlRPGItemBase from "./item-base.mjs";

/**
 * A Mob's Attack (docs/mob-sheet.md): one line of a stat block (p.267) -
 * "Lava Spit: 13+F to hit, 1d8+3 Fire, 30ft range", with the effect printed
 * under it. Mobs never roll (p.267): the to-hit is the Difficulty of the
 * crawlers' Evades, and the GM rolls only the damage.
 *  - `toHit`, `damage`: as printed ("13+F", "1d8+3"); "F" is the Floor.
 *  - `range`: as printed ("30ft range", "20ft Cone") - nothing reads its shape.
 *  - `isArea` / `splash`: an Area Attack (p.83), and whether it has a Splash zone.
 *  - `targetEffects`: the Debuffs it gives, each with the moment it lands
 *    (`trigger`, CONFIG.CARLRPG.mobAttackTriggers): on a hit, on an Evade
 *    Major Fail or worse, or on a Critical Fail - "often when crawlers fail
 *    spectacularly at Evading an Attack" (p.267).
 *  - `description` (CarlRPGItemBase): the printed effect.
 * Its own entry shape, not the Skills' (whose crit-only / Amazing-Success-
 * only flags are the attacker's roll; a Mob doesn't roll).
 */
export default class CarlRPGMobAttack extends CarlRPGItemBase {

  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = super.defineSchema();

    schema.toHit = new fields.StringField({ required: true, blank: true, initial: "" });
    schema.damage = new fields.StringField({ required: true, blank: true, initial: "" });
    schema.damageType = new fields.StringField({
      required: true, blank: true, initial: "",
      choices: ["", ...Object.keys(CONFIG.CARLRPG.damageTypes)],
    });
    schema.range = new fields.StringField({ required: true, blank: true, initial: "" });
    schema.isArea = new fields.BooleanField({ required: true, initial: false });
    schema.splash = new fields.BooleanField({ required: true, initial: false });
    schema.targetEffects = new fields.ArrayField(new fields.SchemaField({
      id: new fields.StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
      /** Key into CONFIG.CARLRPG.debuffs. */
      debuffKey: new fields.StringField({ required: true, blank: true, initial: "" }),
      stacks: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 1, min: 1 }),
      trigger: new fields.StringField({
        required: true, blank: false, initial: "hit",
        choices: () => Object.keys(CONFIG.CARLRPG.mobAttackTriggers),
      }),
      label: new fields.StringField({ required: true, blank: true, initial: "" }),
    }), { required: true, initial: [] });

    return schema;
  }
}
