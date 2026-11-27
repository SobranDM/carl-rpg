const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;
import LootForge from "../apps/loot-forge.mjs";
import {
  boxDraftForForge,
  boxView,
  clearBoxContents,
  confirmClearBox,
  openBox,
  prepareBox,
} from "../helpers/boxes.mjs";
import { injectBloodSplatter } from "../helpers/window-chrome.mjs";
import { enrichDescription } from "../helpers/rich-text.mjs";
import { labelChoices } from "../helpers/html.mjs";

/**
 * A Box's sheet (data/box.mjs). A player sees its art, title, tier and
 * description - never what's in it (ruled 2026-11-19), and can't change it.
 * The GM also sees where it came from and its contents: rolled when it's
 * opened, or prepared in the Loot Forge; and can open it now.
 * @extends {ItemSheetV2}
 * @mixes {HandlebarsApplication}
 */
export class CarlRPGBoxSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["carl-rpg", "sheet", "item", "carl-box-sheet"],
    position: { width: 460, height: "auto" },
    form: { submitOnChange: true },
    actions: {
      prepareContents: CarlRPGBoxSheet.#onPrepareContents,
      clearContents: CarlRPGBoxSheet.#onClearContents,
      openBox: CarlRPGBoxSheet.#onOpenBox,
    },
  };

  /** @override */
  static PARTS = {
    body: { template: "systems/carl-rpg/templates/item/box-sheet.hbs" },
  };

  /**
   * Only the GM edits a Box (documents/item.mjs refuses a player's write).
   * @override
   */
  get isEditable() {
    return game.user.isGM && super.isEditable;
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.item;
    const view = boxView(item, game.user.isGM);
    context.item = item;
    context.system = item.system;
    context.view = view;
    context.isGM = game.user.isGM;
    context.tierChoices = labelChoices(CONFIG.CARLRPG.lootBoxTiers);
    context.descriptionHTML = await enrichDescription(item.system.description, item, {
      secrets: game.user.isGM,
    });
    return context;
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    injectBloodSplatter(this);
  }

  /**
   * Prepare the contents in the Loot Forge: what's prepared already, or a
   * fresh roll for the box's crawler. Saving stores them on the box.
   * @private
   */
  static async #onPrepareContents(event, target) {
    if (!game.user.isGM) return;
    const box = this.item;
    const draft = await boxDraftForForge(box);
    if (!draft) return;
    await LootForge.open({
      draft,
      recipient: box.parent?.type === "character" ? box.parent : null,
      title: game.i18n.format("CARLRPG.Box.PrepareTitle", { name: box.name }),
      onSave: (saved) => prepareBox(box, saved),
    });
  }

  /** @private */
  static async #onClearContents(event, target) {
    if (!game.user.isGM) return;
    const crawler = this.item.parent?.name;
    const ok = crawler
      ? await confirmClearBox(event, crawler)
      : await confirmClearBox(event, this.item.name, { box: true });
    if (!ok) return;
    await clearBoxContents(this.item);
  }

  /** @private */
  static async #onOpenBox(event, target) {
    if (!game.user.isGM) return;
    target.disabled = true;
    let result = null;
    try {
      result = await openBox(this.item);
    } finally {
      if (result) this.close();
      else target.disabled = false;
    }
  }
}
