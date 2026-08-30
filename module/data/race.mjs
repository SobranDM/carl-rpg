import CarlRPGItemBase from "./item-base.mjs";

/**
 * Race (Race & Class Selection, p. 127-141): a flat, one-time, permanent
 * grant every Character has from creation and can change (alongside Class)
 * starting at the Third Floor milestone. Like Class, a Race has no Rank
 * progression or Upgrade tiers - its `changes` (inherited from
 * CarlRPGItemBase) are simply always active while the Race item is owned.
 */
export default class CarlRPGRace extends CarlRPGItemBase {

  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = super.defineSchema();

    // Earth Races get access to Earth Classes; Alien Races are locked out
    // of them (p. 127-141). Not enforced - just surfaced so a future
    // selection UI can check it.
    schema.isEarthBased = new fields.BooleanField({ required: false, initial: false });
    schema.isAlien = new fields.BooleanField({ required: false, initial: false });

    // Named size tier as given in the book (e.g. "Large (5)") - not a
    // structured size/reach mechanic.
    schema.size = new fields.StringField({ required: false, blank: true, initial: "" });

    schema.prerequisites = new fields.StringField({ required: false, blank: true, initial: "" });

    return schema;
  }
}
