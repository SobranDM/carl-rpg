import { CarlRPGActor } from './documents/actor.mjs';
import { CarlRPGItem } from './documents/item.mjs';
import { CarlRPGCombat, CarlRPGCombatant } from './documents/combat.mjs';
import { CarlRPGActorSheet } from './sheets/actor-sheet.mjs';
import { CarlRPGItemSheet } from './sheets/item-sheet.mjs';
import { CarlRPGLootBoxSheet } from './sheets/loot-box-sheet.mjs';
import { preloadHandlebarsTemplates } from './helpers/templates.mjs';
import { CARLRPG } from './helpers/config.mjs';
import * as models from './data/_module.mjs';
import CarlDice from './dice/dice.mjs';
import CarlToolbox from './apps/gm-toolbox.mjs';
import CarlSpendStatPointsDialog from './apps/spend-stat-points-dialog.mjs';
import { registerChatListener } from './chat/chat-listener.mjs';
import { registerChatSocket } from './helpers/chat-socket.mjs';
import { registerLootBoxSocket } from './helpers/loot-box.mjs';
import { bakeItemGrants } from './helpers/race-class-grants.mjs';
import { importCrawlerForgeCrawler } from './helpers/crawlerforge-import.mjs';
import { openRulebookImporter, RulebookImportMenu } from './pdf-import/import-dialog.mjs';

Hooks.once('init', function () {
  game.carlrpg = {
    CarlRPGActor,
    CarlRPGItem,
    CarlDice,
    CarlToolbox,
    CarlSpendStatPointsDialog,
    rollItemMacro,
    importCrawlerForgeCrawler,
    openRulebookImporter,
  };

  // World-scope state for the GM Toolbox (module/apps/gm-toolbox.mjs).
  // gameTimer tracks REAL wall-clock time (Date.now()), unrelated to
  // Foundry's own in-world game.time used by the toolbox's Rest buttons.
  game.settings.register('carl-rpg', 'gameTimer', {
    scope: 'world',
    config: false,
    type: Object,
    default: { running: false, startedAt: null, notified: false },
  });
  game.settings.register('carl-rpg', 'currentFloor', {
    scope: 'world',
    config: false,
    type: Number,
    default: 1,
    // The Toolbox re-renders itself after changing this (see gm-toolbox.mjs),
    // but nothing else does - an Actor sheet only reads this setting fresh
    // at render time (module/sheets/actor-sheet.mjs's _prepareContext), so an
    // already-open sheet would otherwise keep showing the stale Floor until
    // some unrelated update happened to re-render it. onChange fires on every
    // connected client (including whoever changed it), covering both the
    // GM's own view and any player's open sheet.
    // Re-derive (not just re-render) every open sheet's actor: a Boss-tier
    // Mob's HB-slot count now bakes in the current Floor (mob.mjs's
    // hbSlotsRule), so a bare render() would otherwise keep showing a stale
    // slot count until some unrelated update forced a fresh
    // prepareDerivedData pass. Mobs are almost always unlinked tokens
    // (absent from game.actors entirely), hence the separate scene sweep.
    onChange: () => {
      for (const actor of game.actors) {
        actor.prepareData();
        if (actor.sheet?.rendered) actor.sheet.render();
      }
      for (const scene of game.scenes) {
        for (const tokenDoc of scene.tokens) {
          if (tokenDoc.actorLink) continue;
          const actor = tokenDoc.actor;
          if (!actor) continue;
          actor.prepareData();
          if (actor.sheet?.rendered) actor.sheet.render();
        }
      }
    },
  });

  // "Import Rulebook PDF" (module/pdf-import/): GM-only, also reachable from
  // the Items sidebar header button below.
  game.settings.registerMenu('carl-rpg', 'rulebookImport', {
    name: 'CARLRPG.PdfImport.Title',
    label: 'CARLRPG.PdfImport.Open',
    hint: 'CARLRPG.PdfImport.MenuHint',
    icon: 'fa-solid fa-file-pdf',
    type: RulebookImportMenu,
    restricted: true,
  });

  CONFIG.CARLRPG = CARLRPG;

  // Dev-only Quench integration tests (module/quench/). Registering this
  // listener costs nothing when Quench isn't active - the event simply never
  // fires, and the dynamic import below is only attempted once it does.
  // module/quench/ is deliberately excluded from the release zip
  // (.github/workflows/release.yml's zip step is a path whitelist that never
  // names it), so a normal end-user install never has these files on disk;
  // the try/catch keeps that expected 404 from surfacing as an error in the
  // rare case Quench is active in someone else's non-dev world.
  Hooks.once('quenchReady', async (quench) => {
    try {
      const { registerCarlRpgQuenchTests } = await import('./quench/register.mjs');
      registerCarlRpgQuenchTests(quench);
    } catch (err) {
      console.warn('CarlRPG | Quench dev-test batches unavailable (expected on a normal release install):', err);
    }
  });

  // Single delegated click router for every chat-card button (Apply to
  // Target(s), Apply Healing/Mend Debuff, Apply Damage, Roll Evade/Add
  // Injury Debuff) - wires click handling and GM/owner visibility gating
  // per-viewer, since the chat card's stored HTML is identical for everyone.
  // See module/chat/chat-listener.mjs.
  registerChatListener();

  // PvE has no initiative roll (Playing the Game, p.80-86) - CarlRPGCombat
  // gives Mobs-first fixed values instead. This formula is only rolled for
  // PvP (crawlers only), every round (p.87).
  CONFIG.Combat.initiative = {
    formula: '1d20 + @stats.dex.mod',
    decimals: 2,
  };
  // End-of-round/end-of-combat Debuff automation (module/helpers/round-end.mjs).
  CONFIG.Combat.documentClass = CarlRPGCombat;
  CONFIG.Combatant.documentClass = CarlRPGCombatant;

  CONFIG.Actor.documentClass = CarlRPGActor;
  Object.assign(CONFIG.Actor.dataModels, {
    character: models.CarlRPGCharacter,
    mob: models.CarlRPGMob,
    lootBox: models.CarlRPGLootBox,
  });

  CONFIG.Item.documentClass = CarlRPGItem;
  Object.assign(CONFIG.Item.dataModels, {
    item: models.CarlRPGItem,
    feature: models.CarlRPGFeature,
    skill: models.CarlRPGSkill,
    damageEffect: models.CarlRPGDamageEffect,
    spell: models.CarlRPGSpell,
    class: models.CarlRPGClass,
    race: models.CarlRPGRace,
  });

  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, 'carl-rpg', CarlRPGActorSheet, {
    types: ['character', 'mob'],
    makeDefault: true,
    label: 'CARLRPG.SheetLabels.Actor',
  });
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, 'carl-rpg', CarlRPGLootBoxSheet, {
    types: ['lootBox'],
    makeDefault: true,
    label: 'CARLRPG.SheetLabels.LootBox',
  });
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Item, 'carl-rpg', CarlRPGItemSheet, {
    types: ['item', 'feature', 'skill', 'damageEffect', 'spell', 'class', 'race'],
    makeDefault: true,
    label: 'CARLRPG.SheetLabels.Item',
  });

  return preloadHandlebarsTemplates();
});

// Left-edge scene control icon that opens/closes the GM Toolbox - the only
// reopen affordance once a GM has closed it (the singleton itself survives
// close, only its window is torn down). No persisted toggle state is
// needed: the button always fires (it's deliberately left out of
// `activeTool` - see module/apps/gm-toolbox.mjs docs) and just checks the
// toolbox's own `.rendered` state each click.
Hooks.on('getSceneControlButtons', (controls) => {
  if (!game.user.isGM) return;
  controls.carlrpg = {
    name: 'carlrpg',
    title: 'CARLRPG.Toolbox.Title',
    icon: 'fas fa-dice-d20',
    visible: true,
    tools: {
      toolbox: {
        name: 'toolbox',
        title: 'CARLRPG.Toolbox.Title',
        icon: 'fas fa-dice-d20',
        button: true,
        onChange: () => {
          const toolbox = game.carlrpg.toolbox;
          if (toolbox.rendered) toolbox.close();
          else toolbox.render({ force: true });
        },
      },
    },
  };
});

// "Import CrawlerForge" button in the Actors sidebar header: reads a
// crawlerforge.com crawler Export file into a new Character (see
// module/helpers/crawlerforge-import.mjs). Only shown to users who can
// create Actors.
Hooks.on('renderActorDirectory', (app, html) => {
  if (!game.user.can('ACTOR_CREATE')) return;
  const actions = html.querySelector('.directory-header .header-actions');
  if (!actions || actions.querySelector('.carl-crawlerforge-import')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.classList.add('carl-crawlerforge-import');
  button.innerHTML = `<i class="fa-solid fa-file-import"></i> ${game.i18n.localize('CARLRPG.CrawlerForge.Import')}`;
  button.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const json = JSON.parse(await foundry.utils.readTextFromFile(file));
        const actor = await importCrawlerForgeCrawler(json);
        ui.notifications.info(game.i18n.format('CARLRPG.CrawlerForge.Imported', { name: actor.name }));
        actor.sheet.render({ force: true });
      } catch (err) {
        console.error('CarlRPG | CrawlerForge import failed', err);
        ui.notifications.error(game.i18n.format('CARLRPG.CrawlerForge.Failed', { error: err.message }));
      }
    });
    input.click();
  });
  actions.append(button);
});

// "Import Rulebook PDF" button in the Items sidebar header: reads the GM's
// own copy of a rulebook into world Items, Mobs, Journal pages and Scenes
// (see module/pdf-import/import-dialog.mjs). GM-only.
Hooks.on('renderItemDirectory', (app, html) => {
  if (!game.user.isGM) return;
  const actions = html.querySelector('.directory-header .header-actions');
  if (!actions || actions.querySelector('.carl-pdf-import-button')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.classList.add('carl-pdf-import-button');
  button.innerHTML = `<i class="fa-solid fa-file-pdf"></i> ${game.i18n.localize('CARLRPG.PdfImport.Open')}`;
  button.addEventListener('click', () => openRulebookImporter());
  actions.append(button);
});

Handlebars.registerHelper('toLowerCase', function (str) {
  return str.toLowerCase();
});

// Resolves a system.conditions[].key entry to its localized "what this does"
// description, for a hover tooltip on the Conditions tab (see
// templates/actor/parts/conditions.hbs) - CONFIG.CARLRPG.debuffs.effect is
// otherwise never displayed anywhere. Prefers the debuff's `mobEffect` over
// `effect` when the actor is a Mob (see that CONFIG's own docstring for why
// several debuffs need a differently-worded description for a creature that
// never rolls its own d20 Checks); falls back to `effect` for every debuff
// that has no Mob-specific wording, and for any Character.
Handlebars.registerHelper('debuffEffectHint', function (debuffs, key, isMob) {
  const preset = debuffs?.[key];
  if (!preset) return '';
  const effectKey = (isMob && preset.mobEffect) ? preset.mobEffect : preset.effect;
  return effectKey ? game.i18n.localize(effectKey) : '';
});

// Narrows the Change Entry editor's Mode <select> to whichever
// CARLRPG.changeModes options actually work for a given targetType - see
// CARLRPG.changeModesByTarget (module/helpers/config.mjs) for why (Override/
// Upgrade/Downgrade are semantically broken for stat/resource/rollMode/
// custom/advancementBonus, correct only for skillRank). Falls back to the
// full, unfiltered list for any targetType with no entry in that map (e.g.
// "skillDamage", which implements Multiply/Override itself).
//
// One exception carved out of the "stat" narrowing: a Class/Race item's own
// "stat" ChangeEntry doesn't go through modifiers.mjs's live, zeroed-
// per-pass bonus accumulator at all - module/helpers/race-class-grants.mjs
// bakes it straight into the actor's real, persisted stats.<key>.value
// instead (a one-time base bump - see that file's docstring and
// modifiers.mjs's `isBakedGrant`), so `current`/`base` there is always the
// genuine base value, not a zeroed bag. Override/Upgrade/Downgrade/Multiply
// are all correct against that real base, so a Class/Race item's "stat"
// change keeps the full six-option list.
//
// If a previously-saved ChangeEntry's `mode` falls outside the narrowed list
// (a pre-fix save on a non-Class/Race item), it's simply not one of the
// rendered <option>s - the browser shows the first option (Add) instead
// rather than erroring; the actor's stored `mode` value itself is untouched
// until this sheet is next submitted (submitOnChange posts the whole form),
// at which point it self-heals to whatever the dropdown was showing (Add).
Handlebars.registerHelper('changeModeChoices', function (allModes, modesByTarget, targetType, itemType) {
  if (targetType === "stat" && (itemType === "class" || itemType === "race")) return allModes;
  const allowed = modesByTarget?.[targetType];
  if (!allowed) return allModes;
  const filtered = {};
  for (const key of allowed) {
    if (key in allModes) filtered[key] = allModes[key];
  }
  return filtered;
});

Hooks.once('ready', function () {
  // Relays a player's chat-card button click (Apply Damage, Roll Evade,
  // etc.) to the active GM's client when the clicking user lacks direct
  // update permission on that ChatMessage (module/helpers/chat-socket.mjs) -
  // needs game.users/game.socket live, hence `ready` rather than `init`.
  registerChatSocket();
  // Players taking items out of a Loot Box they only observe (see
  // module/helpers/loot-box.mjs).
  registerLootBoxSocket();

  Hooks.on('hotbarDrop', (bar, data, slot) => createItemMacro(data, slot));

  // Persistent floating GM Toolbox singleton (see module/apps/gm-toolbox.mjs).
  // Rendered once and left alone thereafter - same lifecycle as core's own
  // ui.players/ui.hotbar. If a GM closes it, the left-edge scene control
  // icon registered above reopens it.
  if (game.user.isGM) {
    game.carlrpg.toolbox = new CarlToolbox();
    game.carlrpg.toolbox.render({ force: true });

    // One-time-per-load catch-up sweep: bake any not-yet-baked Race/Class
    // stat/skillRank grants on every Character actor (module/helpers/
    // race-class-grants.mjs) - covers actors that already owned a Race/
    // Class item before this fix existed, and re-checks level-gated grants
    // in case Level changed while offline. Idempotent (each grant is only
    // ever baked once, tracked via a flag on its granting item), so safe to
    // run on every world load; only the GM runs it, to avoid every
    // connected client redundantly racing the same writes. Awaited
    // sequentially, one item at a time - two concurrent bakes touching the
    // same actor's same Stat would otherwise race (each reading the same
    // stale base before either write lands, so one delta silently loses).
    (async () => {
      for (const actor of game.actors) {
        if (actor.type !== 'character') continue;
        for (const item of actor.items) {
          if (item.type === 'class' || item.type === 'race') await bakeItemGrants(item);
        }
      }
    })();
  }
});

async function createItemMacro(data, slot) {
  if (data.type !== 'Item') return;
  if (!data.uuid.includes('Actor.') && !data.uuid.includes('Token.')) {
    return ui.notifications.warn(
      'You can only create macro buttons for owned Items'
    );
  }
  const item = await Item.fromDropData(data);
  const command = `game.carlrpg.rollItemMacro("${data.uuid}");`;
  let macro = game.macros.find(
    (m) => m.name === item.name && m.command === command
  );
  if (!macro) {
    macro = await Macro.create({
      name: item.name,
      type: 'script',
      img: item.img,
      command: command,
      flags: { 'carl-rpg.itemMacro': true },
    });
  }
  game.user.assignHotbarMacro(macro, slot);
  return false;
}

function rollItemMacro(itemUuid) {
  const dropData = {
    type: 'Item',
    uuid: itemUuid,
  };
  Item.fromDropData(dropData).then((item) => {
    if (!item || !item.parent) {
      const itemName = item?.name ?? itemUuid;
      return ui.notifications.warn(
        `Could not find item ${itemName}. You may need to delete and recreate this macro.`
      );
    }
    item.roll();
  });
}
