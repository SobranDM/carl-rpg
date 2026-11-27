/**
 * The Loot Forge (docs/loot-and-achievements.md): one window for every way
 * the GM shapes loot - a rolled box's gold and items, and each magic item's
 * name, where it's worn and its enchantments (X, the Stat or Skill, the
 * damage type...), with rerolls for the lot, one item or one effect, items
 * dropped in from the sidebar or a compendium, and items taken out.
 *
 * Used to prepare a Box's contents (its sheet; an achievement's box for one
 * crawler, the Achievements window) and to Reforge one magic item (`single`).
 * Save hands the draft to `onSave`. The recipient - the crawler it's for -
 * is fixed by the caller: auto-fill and percentage Stats use them.
 *
 * A magic item also takes the GM's own description and an image, and - a
 * weapon - Two-Handed, Armor-Piercing and on-hit Debuffs (ruled
 * 2026-11-21). Rerolling it keeps the description and image.
 *
 * Works on a LootDraft (helpers/loot.mjs generateLoot): {tierKey, gold, entries}.
 */
import {
  baseOfDraft,
  drawWeaponBase,
  enchantmentLine,
  generateLoot,
  generateMagicDraft,
  isWeaponTheme,
  MAGIC_ITEM_IMG,
  magicItemUpdate,
  ownDescription,
  rerollEnchantment,
} from "../helpers/loot.mjs";
import { labelChoices } from "../helpers/html.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Enchantments with a number to set: an X, a Rank, DR. */
const VALUE_KINDS = ["stat", "skill", "passiveSkill", "dr", "inherentSpell"];
/** Enchantments that are their own words. */
const TEXT_KINDS = ["buff", "externalBuff", "text", "unique"];

/**
 * A description with nothing in it - no words, no picture - as "": an
 * editor saved empty hands in "<p></p>".
 * @param {unknown} html
 * @returns {string}
 */
function blankAsEmpty(html) {
  const text = String(html ?? "");
  if (!text) return "";
  const div = document.createElement("div");
  div.innerHTML = text;
  return div.textContent.trim() || div.querySelector("img, video, iframe, hr, table") ? text : "";
}

export default class LootForge extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} config
   * @param {{tierKey: string, gold?: number, entries: object[]}} config.draft  Copied, not changed.
   * @param {Actor|null} [config.recipient]  Whose loot it is: auto-fill uses them.
   * @param {((draft: object) => Promise<void>)|null} [config.onSave]  Save.
   * @param {boolean} [config.single]  One magic item: no tier, gold or other entries.
   * @param {string|null} [config.title]
   */
  constructor({
    draft,
    recipient = null,
    onSave = null,
    single = false,
    title = null,
    ...options
  } = {}) {
    super(options);
    this.draft = foundry.utils.deepClone(draft);
    this.draft.gold ??= 0;
    this.recipient = recipient;
    this.onSave = onSave;
    this.single = single;
    this.customTitle = title;
    /** True while Save runs: a second click does nothing. */
    this.busy = false;
  }

  /** The draft as opened: closing saves only if it's changed since. */
  #opened = "";

  /** Saved already (by Save, or on closing): closing doesn't save again. */
  #saved = false;

  /**
   * Run Save once: further clicks while it runs are ignored.
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
   * Save rewrites the item (name, Bonuses, description, where it's worn,
   * image, weapon parts; anything else is kept). The Forge starts from the
   * item as it is now - a name, description, image or Debuff changed on its
   * sheet since is kept; only its enchantments come from the draft. The
   * owner, if a Character, is the recipient for auto-fill and percentage
   * Stats.
   * @param {Item} item  An Item with a magic draft (flags.carl-rpg.magicDraft).
   * @returns {Promise<LootForge|null>}
   */
  static async reforge(item) {
    const stored = item?.getFlag("carl-rpg", "magicDraft");
    if (!game.user.isGM || !stored) return null;
    const sys = item.system;
    const draft = {
      ...foundry.utils.deepClone(stored),
      name: item.name,
      img: item.img,
      description: ownDescription(sys.description, stored),
      weaponSkill: sys.weaponSkill ?? "",
      slots: [...(sys.slots ?? [])],
      accessoryKind: sys.accessoryKind ?? "",
      twoHanded: !!sys.twoHanded,
      armorPiercing: !!sys.armorPiercing,
      targetEffects: foundry.utils.deepClone(item._source.system.targetEffects ?? []),
    };
    const owner = item.parent?.type === "character" ? item.parent : null;
    return LootForge.open({
      draft: { tierKey: draft.tierKey, gold: 0, entries: [draft] },
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
      addArrayItem: LootForge.#onAddArrayItem,
      deleteArrayItem: LootForge.#onDeleteArrayItem,
      // Not "save": a description editor's own save button is
      // data-action="save", and would save and close the Forge.
      saveForge: LootForge.#onSave,
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
    const skillNames = (this.recipient?.items ?? [])
      .filter((i) => ["skill", "spell"].includes(i.type))
      .map((i) => i.name)
      .sort((a, b) => a.localeCompare(b));
    // A weapon's Skill: the book's weapon Skills and the recipient's own
    // Attack Skills, as the item sheet offers.
    const weaponSkillNames = [
      ...new Set([
        ...cfg.weaponSkills,
        ...(this.recipient?.items ?? [])
          .filter((i) => i.type === "skill" && i.system.category === "attack")
          .map((i) => i.name),
      ]),
    ].sort((a, b) => a.localeCompare(b));
    const entries = this.draft.entries.map((entry, index) => {
      const isMagic = entry.kind === "magic";
      return {
        ...entry,
        index,
        isMagic,
        slot: entry.slots?.[0] ?? "",
        // "Enchanted Mundane Item or Weapon" (Table 38) can be a weapon.
        canBeWeapon: isMagic && entry.itemType === "mundane",
        isWeapon: isMagic && !!entry.weaponSkill,
        imgShown: entry.img || MAGIC_ITEM_IMG,
        description: entry.description ?? "",
        targetEffects: entry.targetEffects ?? [],
        targetEffectsPath: `entries.${index}.targetEffects`,
        // A new Debuff lands with this weapon only, on an Amazing Success,
        // as the item sheet makes a weapon's (item-sheet.mjs debuffTemplate).
        debuffTemplate: JSON.stringify({
          debuffKey: "",
          stacks: 1,
          critOnly: false,
          amazingSuccessOnly: true,
          label: "",
          skills: entry.weaponSkill ? [entry.weaponSkill] : [],
          handToHandOnly: false,
        }),
        isAccessory: entry.slots?.[0] === "accessory",
        label: isMagic ? entry.name : entryLabel(entry),
        qtyEditable: entry.kind === "item" || entry.kind === "text",
        enchantments: isMagic
          ? entry.enchantments.map((e, j) => ({
              ...e,
              prefix: `entries.${index}.enchantments.${j}`,
              effectIndex: j,
              // Something Unique shows how powerful it is: xN (p.220).
              kindLabel:
                e.kind === "unique"
                  ? game.i18n.format("CARLRPG.Loot.Forge.UniqueTimes", {
                      times: e.multiplier ?? 1,
                    })
                  : loc(`CARLRPG.Loot.Forge.Kind.${e.kind}`),
              line: enchantmentLine(e),
              hasValue: VALUE_KINDS.includes(e.kind),
              statTarget: e.kind === "stat",
              skillTarget: e.kind === "skill" || e.kind === "passiveSkill",
              damageTarget: e.kind === "resistance",
              spellTarget: e.kind === "inherentSpell",
              textField: TEXT_KINDS.includes(e.kind),
              // A percentage Stat: its % beside the number it came to.
              percentNote: e.kind === "stat" && !!e.percent,
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
      entries,
      skillNames,
      weaponSkillNames,
      statChoices: cfg.stats,
      damageChoices: cfg.damageTypes,
      slotChoices: { "": "CARLRPG.Loot.Forge.NoSlot", ...cfg.wearSlots },
      accessoryChoices: cfg.accessoryKinds,
      // The Debuff editor's choices (target-effects-editor.hbs).
      config: cfg,
    };
  }

  /**
   * The draft as first drawn, to tell on closing whether anything changed:
   * taken through the form, so what it fills in itself (a blank description,
   * a quantity of 1) doesn't count as a change. Items dropped from the
   * sidebar, a compendium or a sheet join the loot.
   * @override
   */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#applyForm(new foundry.applications.ux.FormDataExtended(this.element));
    this.#opened = JSON.stringify(this.draft);
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
    this.#applyForm(formData);
    // A new Weapon Skill shows or hides the weapon's parts; a new image, its
    // preview; a box ticked, its Debuff's summary line; a saved Description,
    // its text (a closed editor shows what it was drawn with, and there's no
    // document update here to redraw it, as on a sheet).
    const name = event?.target?.getAttribute?.("name") ?? event?.target?.name ?? "";
    const redraws = [
      ".weaponSkill",
      ".img",
      ".critOnly",
      ".amazingSuccessOnly",
      ".stacks",
      ".description",
    ];
    if (event?.target instanceof HTMLSelectElement || redraws.some((s) => name.endsWith(s)))
      this.#redraw();
  }

  /**
   * The form's fields, into the draft.
   * @param {foundry.applications.ux.FormDataExtended} formData
   */
  #applyForm(formData) {
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
      // A weapon is wielded with its Skill, so it's Held (gear.mjs slotsOf).
      if (changes.weaponSkill !== undefined) {
        const was = entry.weaponSkill ?? "";
        entry.weaponSkill = String(changes.weaponSkill).trim();
        if (entry.weaponSkill) entry.slots = ["held"];
        // Its Debuffs that were "only with" it follow the new name.
        for (const te of entry.targetEffects ?? []) {
          if (was && entry.weaponSkill && te.skills?.includes(was))
            te.skills = te.skills.map((s) => (s === was ? entry.weaponSkill : s));
        }
      }
      if (changes.accessoryKind !== undefined) entry.accessoryKind = changes.accessoryKind;
      if (changes.description !== undefined) entry.description = blankAsEmpty(changes.description);
      if (changes.img !== undefined) entry.img = String(changes.img ?? "").trim();
      if (changes.twoHanded !== undefined) entry.twoHanded = !!changes.twoHanded;
      if (changes.armorPiercing !== undefined) entry.armorPiercing = !!changes.armorPiercing;
      for (const [k, te] of Object.entries(changes.targetEffects ?? {})) {
        const debuff = entry.targetEffects?.[Number(k)];
        if (!debuff) continue;
        if (te.debuffKey !== undefined) debuff.debuffKey = String(te.debuffKey);
        if (te.stacks !== undefined)
          debuff.stacks = Math.max(1, Math.floor(Number(te.stacks) || 1));
        if (te.critOnly !== undefined) debuff.critOnly = !!te.critOnly;
        if (te.amazingSuccessOnly !== undefined)
          debuff.amazingSuccessOnly = !!te.amazingSuccessOnly;
        if (te.label !== undefined) debuff.label = String(te.label);
      }
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
  }

  /**
   * Closing with the X (or Escape) saves too, when the GM has changed
   * something - unless Save did already. Unchanged, nothing is saved: a box
   * only looked at stays as it was (still rolled when opened, if it was).
   * @override
   */
  async _preClose(options) {
    await super._preClose(options);
    if (this.#saved || this.busy || !this.onSave || !game.user.isGM) return;
    // What's typed but not yet handed in: a field still focused, an open
    // Description editor.
    // An open editor's text goes through #takeEditors, which knows whether
    // anything was typed in it; the form would hand it in regardless.
    if (this.element) {
      const object = { ...new foundry.applications.ux.FormDataExtended(this.element).object };
      for (const editor of this.element.querySelectorAll("prose-mirror[name]"))
        if (editor.open) delete object[editor.getAttribute("name")];
      this.#applyForm({ object });
    }
    this.#takeEditors();
    if (JSON.stringify(this.draft) === this.#opened) return;
    // A save that fails (the box or item deleted meanwhile) mustn't keep the
    // window from closing.
    try {
      await this.onSave(foundry.utils.deepClone(this.draft));
    } catch (err) {
      console.error("carl-rpg | Loot Forge: saving on close failed", err);
      ui.notifications.error(game.i18n.localize("CARLRPG.Loot.Forge.CloseSaveFailed"));
    }
    this.#saved = true;
  }

  /**
   * Draw the window again with the draft's changes - unless it has been
   * closed meanwhile (a reroll or a refit still running when the GM closed
   * it), which would open it again.
   */
  #redraw() {
    if (!this.rendered) return;
    this.#takeEditors();
    this.render();
  }

  /**
   * An open Description editor's text, into the draft. A toggled editor
   * only hands its text to the form when it's saved, and a redraw or Save
   * would otherwise lose what's been typed in it since.
   */
  #takeEditors() {
    for (const editor of this.element?.querySelectorAll("prose-mirror[name]") ?? []) {
      const m = editor.getAttribute("name").match(/^entries\.(\d+)\.description$/);
      const entry = m ? this.draft.entries[Number(m[1])] : null;
      if (!entry || !editor.open) continue;
      const value = String(editor.value ?? "");
      // Opened but nothing typed: what's stored stands (an empty editor
      // would otherwise hand in "<p></p>", and count as a change).
      if (value === this.#openedText.get(editor)) continue;
      entry.description = blankAsEmpty(value);
    }
  }

  /** Each Description editor's text as it was opened (#takeEditors). */
  #openedText = new WeakMap();

  /** A Debuff row just added: opened on the next draw, ready to fill in. */
  #openRow = null;

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    // The editor's "open" doesn't bubble, so each is listened to itself.
    for (const editor of this.element.querySelectorAll("prose-mirror[name]")) {
      editor.addEventListener("open", () =>
        this.#openedText.set(editor, String(editor.value ?? "")),
      );
    }
    if (!this.#openRow) return;
    const row = this.element.querySelector(`details[data-row-key="${this.#openRow}"]`);
    if (row) row.open = true;
    this.#openRow = null;
  }

  /** The index of the entry an action's element belongs to. */
  static #entryIndex(target) {
    return Number(target.closest("[data-index]")?.dataset.index);
  }

  static async #onRerollAll() {
    const fresh = await generateLoot(this.draft.tierKey, {
      recipient: this.recipient,
      theme: this.draft.theme ?? "",
    });
    if (fresh) this.draft = fresh;
    this.#redraw();
  }

  static async #onAddMagic() {
    // A Weapon Box's, a weapon like its own (generateLoot).
    const theme = this.draft.theme ?? "";
    const base = isWeaponTheme(theme) ? await drawWeaponBase(this.draft.tierKey, theme) : null;
    const magic = await generateMagicDraft(this.draft.tierKey, {
      recipient: this.recipient,
      base,
    });
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
    // A Weapon Box's weapon stays that weapon, with new enchantments.
    const base = baseOfDraft(entry);
    const magic = await generateMagicDraft(entry.tierKey ?? this.draft.tierKey, {
      recipient: this.recipient,
      base,
    });
    // A new item, but the GM's own words and image stay (ruled 2026-11-21).
    if (magic) {
      if (entry.description) magic.description = entry.description;
      if (entry.img) magic.img = entry.img;
      this.draft.entries.splice(index, 1, magic);
    }
    this.#redraw();
  }

  static async #onRerollEffect(event, target) {
    const entry = this.draft.entries[LootForge.#entryIndex(target)];
    const effect = Number(target.closest("[data-effect]")?.dataset.effect);
    if (entry?.kind !== "magic" || !Number.isInteger(effect)) return;
    await rerollEnchantment(entry, effect, { recipient: this.recipient });
    this.#redraw();
  }

  /**
   * The Debuff editor's Add (target-effects-editor.hbs): a new row, from its
   * template, in the draft list its path names.
   */
  static #onAddArrayItem(event, target) {
    const path = target.dataset.path;
    if (!path?.startsWith("entries.")) return;
    let template = {};
    try {
      template = JSON.parse(target.dataset.template || "{}");
    } catch {
      template = {};
    }
    const list = foundry.utils.getProperty(this.draft, path) ?? [];
    const id = foundry.utils.randomID();
    list.push({ ...template, id });
    this.#openRow = id;
    foundry.utils.setProperty(this.draft, path, list);
    this.#redraw();
  }

  /** The Debuff editor's Remove: that row, from the draft list. */
  static #onDeleteArrayItem(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const list = foundry.utils.getProperty(this.draft, target.dataset.path ?? "");
    const index = Number(target.dataset.index);
    if (!Array.isArray(list) || !Number.isInteger(index)) return;
    list.splice(index, 1);
    this.#redraw();
  }

  static async #onSave() {
    return this.#once(async () => {
      this.#takeEditors();
      await this.onSave?.(foundry.utils.deepClone(this.draft));
      this.#saved = true;
      this.close();
    });
  }
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
