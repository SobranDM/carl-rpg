import { defineChangesField } from "./shared/change-entry.mjs";

export default class CarlRPGItemBase extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = {};

    // Rich text: also listed in system.json's htmlFields for every Item type,
    // which is what has the server sanitize it.
    schema.description = new fields.HTMLField({ required: true, blank: true });

    // Always-active-while-owned bonuses (gear, features). Skills/Spells/Damage
    // Effects instead gate their bonuses behind Rank via `upgrades` (see
    // ranked-item-base.mjs) but still inherit this for any Rank-0/base effect.
    schema.changes = defineChangesField();

    return schema;
  }

  prepareBaseData() {
    super.prepareBaseData();
  }
}
