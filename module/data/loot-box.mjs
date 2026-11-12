/**
 * Loot Box: a container Actor the GM fills with rolled loot (see
 * module/helpers/loot-box.mjs) and the party takes items out of. Not built on
 * actor-base.mjs - a box has no Health Bar, Mana or defenses.
 */
export default class CarlRPGLootBox extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;
    const requiredInteger = { required: true, nullable: false, integer: true };
    const schema = {};

    schema.tier = new fields.StringField({
      required: true,
      blank: false,
      initial: "bronze",
      choices: () => Object.keys(CONFIG.CARLRPG.lootBoxTiers),
    });
    // How many items "Generate Loot" rolls - one per crawler, like the book's
    // boxes. Defaults to 1 so a solo test doesn't spawn a pile.
    schema.crawlers = new fields.NumberField({ ...requiredInteger, initial: 1, min: 1, max: 20 });
    schema.description = new fields.StringField({ required: true, blank: true });

    return schema;
  }

  /**
   * Every player can see the box, and the box keeps its own contents (a
   * linked token), so taking an item from a token on the map empties the
   * same box the sidebar shows. Players only get Observer: taking an item
   * goes through takeLootItem's GM relay, so they can't edit or delete loot
   * directly.
   * @override
   */
  async _preCreate(data, options, user) {
    const allowed = await super._preCreate(data, options, user);
    if (allowed === false) return false;
    const updates = { prototypeToken: { actorLink: true } };
    if (data.ownership?.default === undefined) {
      updates.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER };
    }
    if (!data.img) updates.img = "icons/svg/chest.svg";
    this.parent.updateSource(updates);
  }
}
