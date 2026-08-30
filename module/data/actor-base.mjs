export default class CarlRPGActorBase extends foundry.abstract.TypeDataModel {

  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    const schema = {};

    // Health Bar (HB): crawlers track damage in whole slots, not raw HP.
    // hb.max is the BASE slot count (10 by default, GM-editable) - it is
    // never touched by the modifier engine. hb.bonusMax/hb.effectiveMax are
    // derived-only (recomputed every prepareDerivedData pass from item/skill
    // "resource" changes targeting "hb.max") and must never be bound to an
    // editable sheet input - see module/helpers/modifiers.mjs for why base
    // and effective values are kept in separate fields rather than one.
    // hb.value is slots remaining; hb.slotValue (damage one slot absorbs) is
    // derived from CON Mod.
    schema.hb = new fields.SchemaField({
      value: new fields.NumberField({ ...requiredInteger, initial: 10, min: 0 }),
      max: new fields.NumberField({ ...requiredInteger, initial: 10, min: 1 }),
      bonusMax: new fields.NumberField({ ...requiredInteger, initial: 0 }),
      effectiveMax: new fields.NumberField({ ...requiredInteger, initial: 10 }),
      slotValue: new fields.NumberField({ ...requiredInteger, initial: 0 }),
    });

    // Shield-style secondary HP pool (docs/known-gaps.md 1.4) - e.g. the
    // Shield spell. value is persisted (decremented by damage, refilled on
    // (re)activation - see CarlDice.rollToggleSpell); effectiveMax/slotValue
    // are derived every prepareDerivedData pass from whichever owned,
    // currently-active toggled spell grants a shield (module/helpers/
    // modifiers.mjs's computeActiveShieldSlots) - 0 when no such spell is
    // active, meaning the pool is fully inert (see module/helpers/
    // damage-pipeline.mjs). Unlike hb, there's no GM-editable base/bonusMax -
    // it's entirely spell-derived.
    schema.shield = new fields.SchemaField({
      value: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 }),
      effectiveMax: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 }),
      slotValue: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 }),
    });

    // Mana: 1:1 with the Intelligence score (not modifier) per the book, plus
    // any "resource" bonuses targeting "mana.max". Fully derived every pass
    // (the sheet's max input is disabled) so this one field can safely stay
    // a straight computed value rather than needing a separate bonus field.
    schema.mana = new fields.SchemaField({
      value: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 }),
      max: new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 }),
    });

    schema.biography = new fields.StringField({ required: true, blank: true });

    // Persisted sheet UI state for the merged Abilities tab's whole-section
    // drawers (Skills+DamageEffects, Spells) - real schema fields rather than
    // client-only state so a drawer's open/closed state survives a sheet
    // close/reopen and is consistent across anyone viewing the actor. See
    // module/helpers/drawer-toggle.mjs. Per-skill nested-drawer state lives
    // on the Skill item itself instead (module/data/skill.mjs), since that's
    // per-item UI state, not per-actor.
    schema.uiState = new fields.SchemaField({
      skillsExpanded: new fields.BooleanField({ required: true, initial: true }),
      spellsExpanded: new fields.BooleanField({ required: true, initial: true }),
      // Play-mode guard for the Skills/Spells lists: locked (the default)
      // hides each row's edit/delete controls and shows the Advancement
      // mark checkbox; unlocked does the reverse. Toggled via the lock icon
      // in the Skills drawer header (see collapsible-section.hbs), governs
      // both lists (and their nested Damage Effect rows) from one flag.
      itemsLocked: new fields.BooleanField({ required: true, initial: true }),
    });

    // Damage-type pipeline (Playing the Game, p. 93, see docs/known-gaps.md
    // 1.3): raw damage -> dr (flat) -> resistances[type] (half/double/zero)
    // -> remainder applied to HB in whole slots. These are direct,
    // GM/player-editable schema fields, NOT modifier-engine-driven bonuses -
    // Mobs/NPCs are static stat blocks (see npc.mjs's own "deliberately
    // minimal" note), not built up from granting items the way PC bonuses
    // are, and no bestiary content exists yet to need anything fancier.
    // Granting a resistance via an item/feature's ChangeEntry (targetType
    // "resistance") is a plausible future extension, deliberately not built
    // ahead of a real use case - see docs/known-gaps.md 1.3.
    schema.dr = new fields.NumberField({ ...requiredInteger, initial: 0, min: 0 });
    const resistancesSchema = {};
    for (const type of Object.keys(CONFIG.CARLRPG.damageTypes)) {
      resistancesSchema[type] = new fields.StringField({
        required: true, blank: false, initial: "none",
        choices: ["none", "resist", "vulnerable", "immune"],
      });
    }
    schema.resistances = new fields.SchemaField(resistancesSchema);

    return schema;
  }

  prepareBaseData() {
    super.prepareBaseData();
  }
}
