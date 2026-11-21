/**
 * Carl RPG's tweaks to core ActorSheetV2's own drag-and-drop
 * (foundry.applications.sheets.ActorSheetV2). Core already builds one
 * DragDrop handler per sheet (its `_dragDrop` getter), binds it on every
 * render and routes drops through `_onDrop` -> the `dropActorSheetData`
 * hook -> `_onDropDocument` -> `_onDropItem`/`_onDropActor`/... This mixin
 * only adjusts that one handler - it never adds a second, so a drop is
 * handled exactly once:
 *  - Drag from any row carrying an item id (`[data-item-id]`), not core's
 *    `.draggable` class, which this system's templates don't use.
 *  - Only an owner can start a drag (core lets anyone who can see the
 *    sheet); a sheet can loosen that itself (the Loot Box lets observers).
 *  - Dropped ActiveEffects are ignored - this system's modifiers come from
 *    Item ChangeEntries (module/helpers/modifiers.mjs), not ActiveEffects.
 * Subclasses override `_onDropItem` etc. for their own behavior, as in core.
 *
 * Usage: `class CarlRPGActorSheet extends DragDropMixin(HandlebarsApplicationMixin(ActorSheetV2)) { ... }`
 *
 * @param {typeof foundry.applications.sheets.ActorSheetV2} Base
 */
export default function DragDropMixin(Base) {
  const { ux } = foundry.applications;

  return class CarlDragDropSheet extends Base {
    /** @type {InstanceType<typeof foundry.applications.ux.DragDrop>|null} */
    #carlDragDrop = null;

    /**
     * Core's single DragDrop handler, with this system's drag selector.
     * @override
     */
    get _dragDrop() {
      return (this.#carlDragDrop ??= new ux.DragDrop.implementation({
        dragSelector: "[data-item-id]",
        dropSelector: null,
        permissions: {
          dragstart: this._canDragStart.bind(this),
          drop: this._canDragDrop.bind(this),
        },
        callbacks: {
          dragstart: this._onDragStart.bind(this),
          dragover: this._onDragOver.bind(this),
          drop: this._onDrop.bind(this),
        },
      }));
    }

    /**
     * Only an owner drags Items off this sheet.
     * @override
     */
    _canDragStart(selector) {
      return this.document.isOwner;
    }

    /**
     * This system doesn't use ActiveEffect documents - ignore them.
     * @override
     */
    async _onDropActiveEffect(event, effect) {
      return null;
    }
  };
}
