import { defineChangesField } from "./change-entry.mjs";

/**
 * Active Debuffs/Buffs (Table 11) on a Character or Mob - one shared shape.
 * Most effects come from each entry's CONFIG.CARLRPG.debuffs mechanics
 * (module/helpers/debuff-effects.mjs, round-end.mjs). A few entries carry
 * more of their own:
 *  - `changes`: ChangeEntries applied while the entry exists, like a worn
 *    item's (a Buff potion such as Iron Skin - module/helpers/modifiers.mjs).
 *  - `expiresAt`: world time (seconds) the entry ends at, removed by the
 *    expiry sweep (module/helpers/expiry.mjs). Combat rounds advance world
 *    time 10 seconds each (CONFIG.time.roundTime).
 *  - `durationType`: overrides the preset's, e.g. Potion Sickness's Poisoned
 *    counts down rounds although Poisoned itself lasts until cured.
 *  - `perRound`: HB slots / Mana restored at each round end while it lasts
 *    (a Mana Refill potion - module/helpers/round-end.mjs).
 * @returns {foundry.data.fields.ArrayField}
 */
export function defineConditionsField() {
  const fields = foundry.data.fields;
  return new fields.ArrayField(
    new fields.SchemaField({
      id: new fields.StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
      key: new fields.StringField({ required: true, blank: false }), // key into CONFIG.CARLRPG.debuffs, or "custom"
      label: new fields.StringField({ required: false, blank: true, initial: "" }),
      stacks: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 1, min: 1 }),
      remaining: new fields.NumberField({ required: false, nullable: true, integer: true, initial: null }),
      source: new fields.StringField({ required: false, blank: true, initial: "" }),
      durationType: new fields.StringField({
        required: false, nullable: true, blank: false, initial: null,
        choices: ["rounds", "real-minutes", "until-condition"],
      }),
      expiresAt: new fields.NumberField({ required: false, nullable: true, initial: null }),
      changes: defineChangesField(),
      perRound: new fields.SchemaField({
        hb: new fields.NumberField({ required: false, nullable: true, integer: true, initial: null, min: 0 }),
        mana: new fields.NumberField({ required: false, nullable: true, integer: true, initial: null, min: 0 }),
      }),
    }),
    { required: false, initial: [] },
  );
}
