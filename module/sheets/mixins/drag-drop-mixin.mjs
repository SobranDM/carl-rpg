/**
 * Adds Foundry v14's standard drag-and-drop workflow
 * (foundry.applications.ux.DragDrop) to a DocumentSheetV2-based Actor/Item
 * sheet. Unlike the legacy AppV1 ActorSheet/ItemSheet, ApplicationV2 sheets
 * don't get item-drop handling for free - each system has to wire it up
 * itself. Pattern adapted from the draw-steel sibling system's
 * module/applications/api/document-sheet.mjs (DSDocumentSheet), trimmed down
 * to what this system actually needs (no pseudo-documents, no edit/play mode).
 *
 * Usage: `class CarlRPGActorSheet extends DragDropMixin(HandlebarsApplicationMixin(DocumentSheetV2)) { ... }`
 * Subclasses override `_onDropItem`/`_onDropActor`/`_onDropActiveEffect`/
 * `_onDropFolder` for document-specific behavior; the defaults here are
 * no-ops (matching core's own convention for these hooks).
 *
 * @param {typeof foundry.applications.api.DocumentSheetV2} Base
 */
export default function DragDropMixin(Base) {
  const { ux } = foundry.applications;

  return class CarlDragDropSheet extends Base {
    /** @inheritdoc */
    static DEFAULT_OPTIONS = {
      dragDrop: [{ dragSelector: "[data-item-id]", dropSelector: null }],
    };

    /** @type {InstanceType<typeof foundry.applications.ux.DragDrop>[]} */
    #dragDrop = this.#createDragDropHandlers();

    /** @inheritdoc */
    async _onRender(context, options) {
      await super._onRender(context, options);
      this.#dragDrop.forEach((d) => d.bind(this.element));
    }

    /**
     * Create drag-and-drop workflow handlers for this Application.
     * @returns {InstanceType<typeof foundry.applications.ux.DragDrop>[]}
     */
    #createDragDropHandlers() {
      return (this.options.dragDrop ?? []).map((d) => {
        d.permissions = {
          dragstart: this._canDragStart.bind(this),
          drop: this._canDragDrop.bind(this),
        };
        d.callbacks = {
          dragstart: this._onDragStart.bind(this),
          drop: this._onDrop.bind(this),
        };
        return new ux.DragDrop.implementation(d);
      });
    }

    /**
     * Define whether a user is able to begin a dragstart workflow for a given drag selector.
     * @param {string} selector
     * @returns {boolean}
     * @protected
     */
    _canDragStart(selector) {
      return this.document.isOwner;
    }

    /**
     * Define whether a user is able to conclude a drag-and-drop workflow for a given drop selector.
     * @param {string} selector
     * @returns {boolean}
     * @protected
     */
    _canDragDrop(selector) {
      return this.isEditable;
    }

    /**
     * Drag an embedded Item off this sheet (e.g. for hotbar macro creation).
     * @param {DragEvent} event
     * @protected
     */
    async _onDragStart(event) {
      const target = event.currentTarget;
      if ("link" in event.target.dataset) return;
      const itemId = target.dataset.itemId ?? target.closest("[data-item-id]")?.dataset.itemId;
      const item = itemId ? this.document.items?.get(itemId) : null;
      if (!item) return;
      event.dataTransfer.setData("text/plain", JSON.stringify(item.toDragData()));
    }

    /**
     * Core drop handler: resolve the dropped Document and dispatch to a
     * type-specific handler.
     * @param {DragEvent} event
     * @protected
     */
    async _onDrop(event) {
      if (!this.isEditable) return;
      const data = ux.TextEditor.implementation.getDragEventData(event);
      const documentClass = foundry.utils.getDocumentClass(data.type);
      if (!documentClass) return;
      const document = await documentClass.fromDropData(data);
      if (!document) return;
      switch (document.documentName) {
        case "Item": return this._onDropItem(event, document);
        case "Actor": return this._onDropActor(event, document);
        case "ActiveEffect": return this._onDropActiveEffect(event, document);
        case "Folder": return this._onDropFolder(event, document);
        default: return null;
      }
    }

    /**
     * Handle a dropped Item. Default no-op; overridden by Actor sheets to
     * create an embedded copy (or sort, if dropped from the same Actor).
     * @param {DragEvent} event
     * @param {Item} item
     * @returns {Promise<Item|Item[]|null>}
     * @protected
     */
    async _onDropItem(event, item) {
      return null;
    }

    /**
     * Handle a dropped Actor. Default no-op.
     * @param {DragEvent} event
     * @param {Actor} actor
     * @returns {Promise<Actor|null>}
     * @protected
     */
    async _onDropActor(event, actor) {
      return null;
    }

    /**
     * Handle a dropped ActiveEffect. Default no-op - this system doesn't use
     * ActiveEffect documents for its modifier engine (see
     * module/helpers/modifiers.mjs) but core still allows dragging them.
     * @param {DragEvent} event
     * @param {ActiveEffect} effect
     * @returns {Promise<ActiveEffect|null>}
     * @protected
     */
    async _onDropActiveEffect(event, effect) {
      return null;
    }

    /**
     * Handle a dropped Folder. Default no-op.
     * @param {DragEvent} event
     * @param {Folder} folder
     * @returns {Promise<Folder|null>}
     * @protected
     */
    async _onDropFolder(event, folder) {
      return null;
    }
  };
}
