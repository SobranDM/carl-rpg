const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;
import DragDropMixin from "./mixins/drag-drop-mixin.mjs";
import LootForge from "../apps/loot-forge.mjs";
import { injectBloodSplatter } from "../helpers/window-chrome.mjs";
import {
  generateLootBoxItems,
  isLootBoxItem,
  rerollLootItem,
  takeLootItem,
} from "../helpers/loot-box.mjs";
import { enrichDescription } from "../helpers/rich-text.mjs";
import { keepStoredForBlankNumbers, mergeSystemSubmit } from "../helpers/form-arrays.mjs";
import { itemFor } from "../helpers/sheet-rows.mjs";
import { labelChoices } from "../helpers/html.mjs";

/**
 * Loot Box sheet: pick a tier, roll loot (GM), take items out (everyone).
 * Kept apart from CarlRPGActorSheet - a box shares none of its tabs.
 * @extends {ActorSheetV2}
 * @mixes {HandlebarsApplication}
 * @mixes {DragDropMixin}
 */
export class CarlRPGLootBoxSheet extends DragDropMixin(HandlebarsApplicationMixin(ActorSheetV2)) {
  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["carl-rpg", "sheet", "actor", "loot-box"],
    position: { width: 560, height: 640 },
    form: {
      submitOnChange: true,
    },
    actions: {
      generateLoot: CarlRPGLootBoxSheet.#onGenerateLoot,
      rerollItem: CarlRPGLootBoxSheet.#onRerollItem,
      takeItem: CarlRPGLootBoxSheet.#onTakeItem,
      editItem: CarlRPGLootBoxSheet.#onEditItem,
      deleteItem: CarlRPGLootBoxSheet.#onDeleteItem,
      reforgeItem: CarlRPGLootBoxSheet.#onReforgeItem,
    },
  };

  /** @override */
  static PARTS = {
    box: {
      template: "systems/carl-rpg/templates/actor/loot-box.hbs",
      scrollable: [".carl-loot-list"],
    },
  };

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.actor;

    context.actor = actor;
    context.system = actor.system;
    context.config = CONFIG.CARLRPG;
    context.isGM = game.user.isGM;
    context.tierChoices = labelChoices(CONFIG.CARLRPG.lootBoxTiers);

    // "Take" puts the item on the user's assigned Character; without one
    // they can still drag a card onto any sheet they own.
    const character = game.user.character;
    context.takeTarget = character && character.isOwner ? character.name : null;

    const items = Array.from(actor.items).sort((a, b) => (a.sort || 0) - (b.sort || 0));
    context.items = await Promise.all(
      items.map(async (item) => ({
        id: item.id,
        name: item.name,
        img: item.img || Item.DEFAULT_ICON,
        tierLabel: CONFIG.CARLRPG.lootBoxTiers[item.getFlag("carl-rpg", "lootTier")]?.label ?? "",
        // A rolled magic item: the GM can reroll or reforge it.
        isMagic: !!item.getFlag("carl-rpg", "magicDraft"),
        // A loot item's GM Secrets are the GM's, even to a player who owns the box.
        descriptionHTML: await enrichDescription(item.system.description, item, {
          secrets: game.user.isGM,
        }),
      })),
    );

    context.descriptionHTML = await enrichDescription(actor.system.description, actor);

    return context;
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    injectBloodSplatter(this);
  }

  /**
   * Observers drag loot out too - that's how a player without an assigned
   * Character picks which sheet gets it.
   * @override
   */
  _canDragStart(selector) {
    return this.actor.testUserPermission(game.user, "OBSERVER");
  }

  /**
   * Stocking the box by hand (GM): drop an Item from the sidebar, a
   * compendium or a Character to add a copy. From another Loot Box, it moves.
   * @override
   */
  async _onDropItem(event, item) {
    if (!this.actor.isOwner || item.parent?.uuid === this.actor.uuid) return null;
    if (isLootBoxItem(item)) return takeLootItem(item, this.actor);
    const itemData = game.items.fromCompendium(item, { clearFolder: true });
    const [created] = await this.actor.createEmbeddedDocuments("Item", [itemData]);
    return created ?? null;
  }

  /**
   * @param {HTMLElement} target
   * @returns {Item|undefined}
   */
  #itemFor(target) {
    return itemFor(this.actor, target);
  }

  /**
   * A cleared number input (Crawlers) keeps the stored value, and the
   * submission is merged onto what's stored, as the other sheets do
   * (helpers/form-arrays.mjs).
   * @override
   */
  _processFormData(event, form, formData) {
    keepStoredForBlankNumbers(formData.object, this.actor.system, form);
    const data = super._processFormData(event, form, formData);
    if (data.system && typeof data.system === "object") {
      data.system = mergeSystemSubmit(this.actor.system, data.system, { objectArraysOnly: true });
    }
    return data;
  }

  /** @private */
  static async #onGenerateLoot(event, target) {
    event.preventDefault();
    if (!game.user.isGM) return;
    target.disabled = true;
    try {
      await generateLootBoxItems(this.actor);
    } finally {
      target.disabled = false;
    }
  }

  /** @private */
  static async #onRerollItem(event, target) {
    event.preventDefault();
    if (!game.user.isGM) return;
    const item = this.#itemFor(target);
    if (item) await rerollLootItem(item);
  }

  /** @private */
  static async #onTakeItem(event, target) {
    event.preventDefault();
    const item = this.#itemFor(target);
    const character = game.user.character;
    if (!item) return;
    if (!character) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.LootBox.NoCharacter"));
      return;
    }
    await takeLootItem(item, character);
  }

  /**
   * Opens the Item sheet: editable for the GM (to rebalance before handing
   * it out), read-only for everyone else.
   * @private
   */
  static #onEditItem(event, target) {
    event.preventDefault();
    this.#itemFor(target)?.sheet.render(true);
  }

  /** @private */
  static async #onReforgeItem(event, target) {
    event.preventDefault();
    const item = this.#itemFor(target);
    if (item) await LootForge.reforge(item);
  }

  /** @private */
  static async #onDeleteItem(event, target) {
    event.preventDefault();
    if (!this.actor.isOwner) return;
    await this.#itemFor(target)?.delete();
  }
}
