import CarlRPGItemBase from "./item-base.mjs";

/**
 * Boons: Race/Class/patron-deity benefits. Supports the Acolyte/Devotee/
 * Zealot-style tiered-benefit pattern (Crawler Advancement, p. 168) via
 * `tier` without building a full Race/Class system. The underlying Item
 * type id stays "feature" (matches system.json/compendium data already
 * using it) - only the field's value domain and user-facing labels are
 * DCC-native now instead of the generic boilerplate "Feature" framing.
 */
export default class CarlRPGFeature extends CarlRPGItemBase {

  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = super.defineSchema();

    schema.tier = new fields.StringField({
      required: false, blank: true, initial: "",
      choices: ["", "acolyte", "devotee", "zealot"],
    });

    return schema;
  }
}
