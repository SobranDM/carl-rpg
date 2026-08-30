/**
 * Define a set of template paths to pre-load
 * Pre-loaded templates are compiled and cached for fast access when rendering
 * @return {Promise}
 */
export const preloadHandlebarsTemplates = async function () {
  await foundry.applications.handlebars.loadTemplates([
    // Shared item-sheet partials (invoked via {{> "systems/carl-rpg/..."}}).
    'systems/carl-rpg/templates/item/parts/ranked-fields.hbs',
    'systems/carl-rpg/templates/item/parts/changes-editor.hbs',
    'systems/carl-rpg/templates/item/parts/target-effects-editor.hbs',
    // Shared actor-sheet partials (invoked via {{> "systems/carl-rpg/..."}}).
    'systems/carl-rpg/templates/actor/parts/stats-column.hbs',
    'systems/carl-rpg/templates/actor/parts/skills-section-body.hbs',
    'systems/carl-rpg/templates/actor/parts/spells-section-body.hbs',
    'systems/carl-rpg/templates/actor/parts/damage-effect-row.hbs',
    'systems/carl-rpg/templates/actor/parts/hb-bar.hbs',
    'systems/carl-rpg/templates/actor/parts/shield-bar.hbs',
    // Chat / dialog templates.
    'systems/carl-rpg/templates/chat/card-shell.hbs',
    'systems/carl-rpg/templates/chat/target-effects-footer.hbs',
    'systems/carl-rpg/templates/chat/heal-footer.hbs',
    'systems/carl-rpg/templates/chat/damage-footer.hbs',
    'systems/carl-rpg/templates/dialog/roll-options.hbs',
    // GM Toolbox.
    'systems/carl-rpg/templates/apps/gm-toolbox.hbs',
    'systems/carl-rpg/templates/apps/spend-stat-points.hbs',
  ]);

  // Named partials (registered for `{{> partialName}}` / block-partial
  // `{{#> partialName}}...{{/partialName}}` syntax).
  return foundry.applications.handlebars.loadTemplates({
    carlChatRollRow: 'systems/carl-rpg/templates/chat/roll-row.hbs',
    carlCollapsibleSection: 'systems/carl-rpg/templates/actor/parts/collapsible-section.hbs',
  });
};
