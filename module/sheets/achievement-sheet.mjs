const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;
import { injectBloodSplatter } from "../helpers/window-chrome.mjs";
import { enrichDescription } from "../helpers/rich-text.mjs";
import { labelChoices } from "../helpers/html.mjs";

/**
 * An Achievement's sheet (data/achievement.mjs). The GM edits it: name,
 * grade (its icon and box tier), the Reward line, whether it gives a loot
 * box, the description, and a GM note (the book's "Contents"). A player
 * reads it - without the GM note.
 * @extends {ItemSheetV2}
 * @mixes {HandlebarsApplication}
 */
export class CarlRPGAchievementSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["carl-rpg", "sheet", "item", "carl-achievement-sheet"],
    position: { width: 480, height: "auto" },
    form: { submitOnChange: true },
  };

  /** @override */
  static PARTS = {
    body: { template: "systems/carl-rpg/templates/item/achievement-sheet.hbs" },
  };

  /**
   * The GM writes achievements; a player only reads one.
   * @override
   */
  get isEditable() {
    return game.user.isGM && super.isEditable;
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.item;
    const sys = item.system;
    context.item = item;
    context.system = sys;
    context.isGM = game.user.isGM;
    context.gradeChoices = labelChoices(CONFIG.CARLRPG.lootBoxTiers);
    context.gradeLabel = CONFIG.CARLRPG.lootBoxTiers[sys.grade]?.label ?? sys.grade;
    context.awarded = !!item.parent;
    context.descriptionHTML = await enrichDescription(sys.description, item, {
      secrets: game.user.isGM,
    });
    return context;
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    injectBloodSplatter(this);
  }
}
