import { CarlRPGActor } from './documents/actor.mjs';
import { CarlRPGItem } from './documents/item.mjs';
import { CarlRPGActorSheet } from './sheets/actor-sheet.mjs';
import { CarlRPGItemSheet } from './sheets/item-sheet.mjs';
import { preloadHandlebarsTemplates } from './helpers/templates.mjs';
import { CARLRPG } from './helpers/config.mjs';
import * as models from './data/_module.mjs';
import CarlDice from './dice/dice.mjs';
import CarlToolbox from './apps/gm-toolbox.mjs';
import CarlSpendStatPointsDialog from './apps/spend-stat-points-dialog.mjs';
import { registerTargetEffectsChatListener } from './chat/target-effects-card.mjs';
import { registerHealChatListener } from './chat/heal-card.mjs';
import { registerDamageChatListener } from './chat/damage-card.mjs';

Hooks.once('init', function () {
  game.carlrpg = {
    CarlRPGActor,
    CarlRPGItem,
    CarlDice,
    CarlToolbox,
    CarlSpendStatPointsDialog,
    rollItemMacro,
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
  });

  CONFIG.CARLRPG = CARLRPG;

  // "Apply to Target(s)" button on Attack chat cards (module/chat/
  // target-effects-card.mjs) - wires click handling and GM/owner visibility
  // gating per-viewer, since the chat card's stored HTML is identical for
  // everyone.
  registerTargetEffectsChatListener();

  // "Apply Healing" / "Mend Debuff" buttons on Heal chat cards (module/chat/
  // heal-card.mjs) - same per-viewer wiring purpose as the line above.
  registerHealChatListener();

  // "Apply Damage" button on Attack chat cards (module/chat/damage-card.mjs,
  // docs/known-gaps.md 1.3/1.7) - same per-viewer wiring purpose as above.
  registerDamageChatListener();

  // PvE has no traditional initiative roll (see Playing the Game, p. 80-86);
  // this formula only matters for the PvP exception, which does use d20+DEX.
  CONFIG.Combat.initiative = {
    formula: '1d20 + @stats.dex.mod',
    decimals: 2,
  };

  CONFIG.Actor.documentClass = CarlRPGActor;
  Object.assign(CONFIG.Actor.dataModels, {
    character: models.CarlRPGCharacter,
    npc: models.CarlRPGNPC,
  });

  CONFIG.Item.documentClass = CarlRPGItem;
  Object.assign(CONFIG.Item.dataModels, {
    item: models.CarlRPGItem,
    feature: models.CarlRPGFeature,
    skill: models.CarlRPGSkill,
    damageEffect: models.CarlRPGDamageEffect,
    spell: models.CarlRPGSpell,
  });

  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, 'carl-rpg', CarlRPGActorSheet, {
    types: ['character', 'npc'],
    makeDefault: true,
    label: 'CARLRPG.SheetLabels.Actor',
  });
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Item, 'carl-rpg', CarlRPGItemSheet, {
    types: ['item', 'feature', 'skill', 'damageEffect', 'spell'],
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

Handlebars.registerHelper('toLowerCase', function (str) {
  return str.toLowerCase();
});

Hooks.once('ready', function () {
  Hooks.on('hotbarDrop', (bar, data, slot) => createItemMacro(data, slot));

  // Persistent floating GM Toolbox singleton (see module/apps/gm-toolbox.mjs).
  // Rendered once and left alone thereafter - same lifecycle as core's own
  // ui.players/ui.hotbar. If a GM closes it, the left-edge scene control
  // icon registered above reopens it.
  if (game.user.isGM) {
    game.carlrpg.toolbox = new CarlToolbox();
    game.carlrpg.toolbox.render({ force: true });
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
