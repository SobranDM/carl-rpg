/**
 * An Achievement (docs/loot-and-achievements.md; Achievements & Loot Boxes,
 * p.21; Appendix 3). A definition lives in the Items sidebar or a
 * compendium; awarding one (helpers/achievements.mjs awardAchievement) puts
 * a copy on the crawler.
 *  - `description`: what the crawler did (and the quip).
 *  - `reward`: the Reward line - a loot box ("You've received a Bronze
 *    Crafter's Box!"), a title or perk, or nothing.
 *  - `grade`: CONFIG.CARLRPG.lootBoxTiers - its icon, and its box's tier.
 *  - `lootBox`: awarding it gives a loot box, titled from the Reward line.
 * On an awarded copy:
 *  - `awardedFloor`: the Floor it was awarded on.
 *  - `seen`: its owner has closed its splash (apps/achievement-splash.mjs).
 *  - `rewarded`: its loot box has been opened (or it gives none).
 */
export default class CarlRPGAchievement extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const fields = foundry.data.fields;
    return {
      description: new fields.HTMLField({ required: true, blank: true }),
      reward: new fields.StringField({ required: true, blank: true, initial: "" }),
      grade: new fields.StringField({
        required: true,
        blank: false,
        initial: "bronze",
        choices: () => Object.keys(CONFIG.CARLRPG.lootBoxTiers),
      }),
      lootBox: new fields.BooleanField({ required: true, initial: false }),
      awardedFloor: new fields.NumberField({
        required: true,
        nullable: true,
        integer: true,
        initial: null,
      }),
      seen: new fields.BooleanField({ required: true, initial: true }),
      rewarded: new fields.BooleanField({ required: true, initial: false }),
    };
  }
}
