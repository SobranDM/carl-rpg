/**
 * A Box (docs/loot-and-achievements.md): an unopened loot box in a crawler's
 * Inventory. "Loot boxes aren't a physical thing... They're delivered
 * directly to the lucky crawler's Inventory" (p.21). The Item's name is the
 * box's title ("Bronze Crafter's Box").
 *  - `tier`: CONFIG.CARLRPG.lootBoxTiers - Bronze to Celestial; its art.
 *  - `source`: what gave it - an achievement (`uuid`: the awarded copy), a
 *    Boss (p.22), or a GM's gift.
 *  - `contents`: "random" (rolled when it's opened, helpers/loot.mjs
 *    generateLoot) or "prepared" by the GM in the Loot Forge (`gold`,
 *    `entries`: a LootDraft's entries). Players never see them (the Box
 *    sheet), and can't change or delete a Box (documents/item.mjs).
 *  - `description`: shown to the player.
 * Opened by helpers/boxes.mjs openBox, which deletes it.
 */
export default class CarlRPGBox extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;
    return {
      description: new fields.HTMLField({ required: true, blank: true }),
      tier: new fields.StringField({
        required: true,
        blank: false,
        initial: "bronze",
        choices: () => Object.keys(CONFIG.CARLRPG.lootBoxTiers),
      }),
      source: new fields.SchemaField({
        kind: new fields.StringField({
          required: true,
          blank: true,
          initial: "",
          choices: ["", "achievement", "boss", "gift"],
        }),
        uuid: new fields.StringField({ required: true, blank: true, initial: "" }),
      }),
      contents: new fields.SchemaField({
        mode: new fields.StringField({
          required: true,
          blank: false,
          initial: "random",
          choices: ["random", "prepared"],
        }),
        gold: new fields.NumberField({
          required: true,
          nullable: false,
          integer: true,
          min: 0,
          initial: 0,
        }),
        entries: new fields.ArrayField(new fields.ObjectField(), { required: true, initial: [] }),
      }),
    };
  }
}
