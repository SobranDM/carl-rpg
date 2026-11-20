/**
 * The Loot Forge (docs/loot-and-achievements.md): one window for every way
 * the GM shapes loot - a rolled box's gold and items, and each magic item's
 * name, where it's worn and its enchantments (X, the Stat or Skill, the
 * damage type...), with rerolls for the lot, one item or one effect, items
 * dropped in from the sidebar or a compendium, and items taken out.
 *
 * Modes:
 *  - "loot" (GM Toolbox Roll Loot): Give to a character, Create in World,
 *    Post to Chat.
 *  - "save" (a Box's prepared contents; Reforge of one magic item): Save,
 *    which hands the draft to `onSave`. `single` shows one magic item only.
 *
 * Works on a LootDraft (helpers/loot.mjs generateLoot): {tierKey, gold, entries}.
 */
import {
  autofillMagicDraft,
  createLootInWorld,
  enchantmentLine,
  generateLoot,
  generateMagicDraft,
  grantLoot,
  magicItemUpdate,
  postLootCard,
  rerollEnchantment,
} from "../helpers/loot.mjs";
import { labelChoices } from "../helpers/html.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Enchantments with a number to set: an X, a Rank, DR. */
const VALUE_KINDS = ["stat", "skill", "passiveSkill", "dr", "inherentSpell"];
/** Enchantments that are their own words. */
const TEXT_KINDS = ["buff", "externalBuff", "text", "unique"];

export default class LootForge extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} config
   * @param {{tierKey: string, gold?: number, entries: object[]}} config.draft  Copied, not changed.
   * @param {"loot"|"save"} [config.mode]
   * @param {Actor|null} [config.recipient]  Whose loot it is: auto-fill and Give use them.
   * @param {((draft: object) => Promise<void>)|null} [config.onSave]  "save" mode's Save.
   * @param {boolean} [config.single]  One magic item: no tier, gold or other entries.
   * @param {string|null} [config.title]
   */
  constructor({
    draft,
    mode = "loot",
    recipient = null,
    onSave = null,
    single = false,
    title = null,
    ...options
  } = {}) {
    super(options);
    this.draft = foundry.utils.deepClone(draft);
    this.draft.gold ??= 0;
    this.mode = mode;
    this.recipient = recipient;
    this.onSave = onSave;
    this.single = single;
    this.customTitle = title;
    /** True while loot is being handed out: a second click does nothing. */
    this.busy = false;
  }

  /**
   * Run a hand-out action once: further clicks while it runs are ignored.
   * @param {() => Promise<void>} fn
   */
  async #once(fn) {
    if (this.busy) return;
    this.busy = true;
    try {
      await fn();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Open a Forge.
   * @param {ConstructorParameters<typeof LootForge>[0]} config
   * @returns {Promise<LootForge>}
   */
  static async open(config) {
    const app = new LootForge(config);
    await app.render({ force: true });
    return app;
  }

  /**
   * Reforge a rolled magic item (GM): its draft in a one-item Forge, and
   * Save rewrites the item (name, Bonuses, description, where it's worn;
   * its image and anything else are kept). The owner, if a Character, is
   * the recipient for auto-fill and percentage Stats.
   * @param {Item} item  An Item with a magic draft (flags.carl-rpg.magicDraft).
   * @returns {Promise<LootForge|null>}
   */
  static async reforge(item) {
    const draft = item?.getFlag("carl-rpg", "magicDraft");
    if (!game.user.isGM || !draft) return null;
    const owner = item.parent?.type === "character" ? item.parent : null;
    return LootForge.open({
      draft: { tierKey: draft.tierKey, gold: 0, entries: [draft] },
      mode: "save",
      single: true,
      recipient: owner,
      title: game.i18n.format("CARLRPG.Loot.Forge.ReforgeTitle", { name: item.name }),
      onSave: async (saved) => {
        if (saved.entries[0]) await item.update(magicItemUpdate(saved.entries[0]));
      },
    });
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["carl-rpg", "carl-loot-forge"],
    window: { title: "CARLRPG.Loot.Forge.Title", icon: "fas fa-hammer", resizable: true },
    position: { width: 600, height: "auto" },
    form: { handler: LootForge.#onFormChange, submitOnChange: true, closeOnSubmit: false },
    actions: {
      rerollAll: LootForge.#onRerollAll,
      addMagic: LootForge.#onAddMagic,
      removeEntry: LootForge.#onRemoveEntry,
      rerollEntry: LootForge.#onRerollEntry,
      rerollEffect: LootForge.#onRerollEffect,
      give: LootForge.#onGive,
      createWorld: LootForge.#onCreateWorld,
      postChat: LootForge.#onPostChat,
      save: LootForge.#onSave,
    },
  };

  /** @override */
  static PARTS = {
    body: {
      template: "systems/carl-rpg/templates/apps/loot-forge.hbs",
      scrollable: [".carl-forge-entries"],
    },
  };

  /** @override */
  get title() {
    return this.customTitle ?? game.i18n.localize("CARLRPG.Loot.Forge.Title");
  }

  /** @override */
  async _prepareContext(options) {
    const loc = (key) => game.i18n.localize(key);
    const cfg = CONFIG.CARLRPG;
    const characters = game.actors.filter((a) => a.type === "character");
    const skillNames = (this.recipient?.items ?? [])
      .filter((i) => ["skill", "spell"].includes(i.type))
      .map((i) => i.name)
      .sort((a, b) => a.localeCompare(b));
    const entries = this.draft.entries.map((entry, index) => {
      const isMagic = entry.kind === "magic";
      return {
        ...entry,
        index,
        isMagic,
        slot: entry.slots?.[0] ?? "",
        isAccessory: entry.slots?.[0] === "accessory",
        label: isMagic ? entry.name : entryLabel(entry),
        qtyEditable: entry.kind === "item" || entry.kind === "text",
        enchantments: isMagic
          ? entry.enchantments.map((e, j) => ({
              ...e,
              prefix: `entries.${index}.enchantments.${j}`,
              effectIndex: j,
              kindLabel: loc(`CARLRPG.Loot.Forge.Kind.${e.kind}`),
              line: enchantmentLine(e),
              hasValue: VALUE_KINDS.includes(e.kind),
              statTarget: e.kind === "stat",
              skillTarget: e.kind === "skill" || e.kind === "passiveSkill",
              damageTarget: e.kind === "resistance",
              spellTarget: e.kind === "inherentSpell",
              textField: TEXT_KINDS.includes(e.kind),
              percentNote: e.kind === "stat" && (e.value === null || e.value === undefined),
            }))
          : [],
      };
    });
    return {
      appId: this.id,
      single: this.single,
      tierChoices: labelChoices(cfg.lootBoxTiers),
      tierKey: this.draft.tierKey,
      gold: this.draft.gold,
      showRecipient: !this.single,
      recipientId: this.recipient?.id ?? "",
      recipientChoices: {
        "": loc("CARLRPG.Loot.Forge.NoRecipient"),
        ...Object.fromEntries(characters.map((a) => [a.id, a.name])),
      },
      entries,
      skillNames,
      statChoices: cfg.stats,
      damageChoices: cfg.damageTypes,
      slotChoices: { "": "CARLRPG.Loot.Forge.NoSlot", ...cfg.wearSlots },
      accessoryChoices: cfg.accessoryKinds,
      lootMode: this.mode === "loot",
      saveMode: this.mode === "save",
      canGive: this.mode === "loot" && !!this.recipient,
    };
  }

  /**
   * Items dropped from the sidebar, a compendium or a sheet join the loot.
   * @override
   */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    if (this.single) return;
    this.element.addEventListener("dragover", (event) => event.preventDefault());
    this.element.addEventListener("drop", (event) => this.#onDrop(event));
  }

  async #onDrop(event) {
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    if (data?.type !== "Item" || !data.uuid) return;
    event.preventDefault();
    const doc = await fromUuid(data.uuid);
    if (!doc) return;
    this.draft.entries.push({
      kind: "item",
      uuid: doc.uuid,
      name: doc.name,
      img: doc.img,
      quantity: 1,
    });
    this.#redraw();
  }

  /**
   * Keep the draft up to date as the form changes. A change to a select
   * (the tier, a slot, a Stat...) redraws; typing doesn't, so it keeps focus.
   */
  static async #onFormChange(event, form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    const draft = this.draft;
    if (data.tierKey) draft.tierKey = data.tierKey;
    if (data.gold !== undefined) draft.gold = Math.max(0, Math.floor(Number(data.gold) || 0));
    for (const [i, changes] of Object.entries(data.entries ?? {})) {
      const entry = draft.entries[Number(i)];
      if (!entry) continue;
      if (changes.name !== undefined) entry.name = String(changes.name);
      if (changes.quantity !== undefined)
        entry.quantity = Math.max(1, Math.floor(Number(changes.quantity) || 1));
      if (changes.slot !== undefined) entry.slots = changes.slot ? [changes.slot] : [];
      if (changes.accessoryKind !== undefined) entry.accessoryKind = changes.accessoryKind;
      if (entry.slots?.[0] !== "accessory") entry.accessoryKind = "";
      for (const [j, e] of Object.entries(changes.enchantments ?? {})) {
        const ench = entry.enchantments?.[Number(j)];
        if (!ench) continue;
        if (e.value !== undefined)
          ench.value = e.value === null || e.value === "" ? null : Number(e.value);
        if (e.target !== undefined && String(e.target) !== ench.target) {
          ench.target = String(e.target);
          // A renamed Inherent Spell no longer links the rolled one.
          if (ench.kind === "inherentSpell") ench.spellUuid = "";
        }
        if (e.text !== undefined) ench.text = String(e.text);
      }
    }
    // Last: the form still shows the old recipient's choices, which the
    // edits above have just copied back in.
    if (data.recipientId !== undefined && data.recipientId !== (this.recipient?.id ?? "")) {
      this.recipient = game.actors.get(data.recipientId) ?? null;
      for (const entry of draft.entries) {
        if (entry.kind === "magic") await refitForRecipient(entry, this.recipient);
      }
    }
    if (event?.target instanceof HTMLSelectElement) this.#redraw();
  }

  /**
   * Draw the window again with the draft's changes - unless it has been
   * closed meanwhile (a reroll or a refit still running when the GM closed
   * it), which would open it again.
   */
  #redraw() {
    if (this.rendered) this.render();
  }

  /** The index of the entry an action's element belongs to. */
  static #entryIndex(target) {
    return Number(target.closest("[data-index]")?.dataset.index);
  }

  static async #onRerollAll() {
    const fresh = await generateLoot(this.draft.tierKey, { recipient: this.recipient });
    if (fresh) this.draft = fresh;
    this.#redraw();
  }

  static async #onAddMagic() {
    const magic = await generateMagicDraft(this.draft.tierKey, { recipient: this.recipient });
    if (!magic) {
      ui.notifications.warn(game.i18n.localize("CARLRPG.Loot.Forge.NoMagicAtTier"));
      return;
    }
    this.draft.entries.push(magic);
    this.#redraw();
  }

  static #onRemoveEntry(event, target) {
    this.draft.entries.splice(LootForge.#entryIndex(target), 1);
    this.#redraw();
  }

  static async #onRerollEntry(event, target) {
    const index = LootForge.#entryIndex(target);
    const entry = this.draft.entries[index];
    if (entry?.kind !== "magic") return;
    const magic = await generateMagicDraft(entry.tierKey ?? this.draft.tierKey, {
      recipient: this.recipient,
    });
    if (magic) this.draft.entries.splice(index, 1, magic);
    this.#redraw();
  }

  static async #onRerollEffect(event, target) {
    const entry = this.draft.entries[LootForge.#entryIndex(target)];
    const effect = Number(target.closest("[data-effect]")?.dataset.effect);
    if (entry?.kind !== "magic" || !Number.isInteger(effect)) return;
    await rerollEnchantment(entry, effect, { recipient: this.recipient });
    this.#redraw();
  }

  static async #onGive() {
    return this.#once(async () => {
      if (!this.recipient) {
        ui.notifications.warn(game.i18n.localize("CARLRPG.Loot.Forge.PickRecipient"));
        return;
      }
      await grantLoot(this.draft, this.recipient);
      await postLootCard(this.draft, { actor: this.recipient });
      ui.notifications.info(
        game.i18n.format("CARLRPG.Loot.Forge.Given", { name: this.recipient.name }),
      );
      this.close();
    });
  }

  static async #onCreateWorld() {
    return this.#once(async () => {
      const items = await createLootInWorld(this.draft);
      ui.notifications.info(
        game.i18n.format("CARLRPG.Loot.Forge.Created", { count: items.length }),
      );
      if (this.draft.gold) {
        ui.notifications.warn(
          game.i18n.format("CARLRPG.Loot.Forge.GoldNotItem", { gold: this.draft.gold }),
        );
      }
      this.close();
    });
  }

  static async #onPostChat() {
    await postLootCard(this.draft);
  }

  static async #onSave() {
    return this.#once(async () => {
      await this.onSave?.(foundry.utils.deepClone(this.draft));
      this.close();
    });
  }
}

/**
 * A magic draft made over for a new recipient: a percentage Stat is worked
 * out from their Stat again (p.220), and a +X Skill they don't have goes to
 * one they do; then the rest is filled in as for a fresh roll.
 * @param {object} entry  A magic draft (changed in place).
 * @param {Actor|null} recipient
 */
async function refitForRecipient(entry, recipient) {
  const owned = new Set(
    (recipient?.items ?? []).filter((i) => i.type === "skill").map((i) => i.name),
  );
  for (const e of entry.enchantments) {
    if (e.kind === "stat" && e.percent) e.value = null;
    if (e.kind === "skill" && recipient && !owned.has(e.target)) e.target = "";
  }
  await autofillMagicDraft(entry, { recipient });
}

/** A non-magic entry's name as shown. */
function entryLabel(entry) {
  if (entry.kind === "spellScroll" || entry.kind === "spellbook") {
    return game.i18n.format(
      entry.kind === "spellScroll" ? "CARLRPG.Loot.ScrollName" : "CARLRPG.Loot.SpellbookName",
      {
        spell: entry.spellName,
        rank: entry.rank,
      },
    );
  }
  return entry.name;
}
