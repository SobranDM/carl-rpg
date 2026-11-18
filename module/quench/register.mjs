/**
 * CarlRPG Quench test suite - registration aggregator.
 *
 * Built directly into the carl-rpg system (not a separate Foundry module,
 * unlike the sibling wwn-system-tests/deltagreen-system-tests projects) per
 * an explicit maintainer decision, so smoke-testing rules/combat/character-
 * advancement changes doesn't require re-testing everything by hand.
 *
 * This directory is excluded from the release zip
 * (.github/workflows/release.yml's zip step is a path whitelist that never
 * names it) and is only ever reached via the dynamic `import()` inside
 * module/carl-rpg.mjs's `quenchReady` hook handler, so it's never fetched
 * on a normal end-user install.
 */
import registerRules from "./batches/rules.mjs";
import registerModifiers from "./batches/modifiers.mjs";
import registerDamagePipeline from "./batches/damage-pipeline.mjs";
import registerRollParts from "./batches/roll-parts.mjs";
import registerConditionsPure from "./batches/conditions-pure.mjs";
import registerDicePure from "./batches/dice-pure.mjs";
import registerDataModels from "./batches/data-models.mjs";
import registerRaceClassGrants from "./batches/race-class-grants.mjs";
import registerDiceIntegration from "./batches/dice-integration.mjs";
import registerConditionsIntegration from "./batches/conditions-integration.mjs";
import registerActorDocument from "./batches/actor-document.mjs";
import registerActorSheet from "./batches/actor-sheet.mjs";
import registerItemDocument from "./batches/item-document.mjs";
import registerItemSheet from "./batches/item-sheet.mjs";
import registerDerivedData from "./batches/derived-data.mjs";
import registerRest from "./batches/rest.mjs";
import registerChatCards from "./batches/chat-cards.mjs";
import registerDebuffEffectsPure from "./batches/debuff-effects-pure.mjs";
import registerDebuffAutomation from "./batches/debuff-automation.mjs";
import registerRulesFixes from "./batches/rules-fixes.mjs";
import registerTableBatch from "./batches/table-batch.mjs";
import registerFavorImmunity from "./batches/favor-immunity.mjs";
import registerConsumables from "./batches/consumables.mjs";
import registerCrawlerForgeImport from "./batches/crawlerforge-import.mjs";
import registerPdfImport from "./batches/pdf-import.mjs";
import registerLootBox from "./batches/loot-box.mjs";
import registerPets from "./batches/pets.mjs";
import registerVehicles from "./batches/vehicles.mjs";
import registerHotlist from "./batches/hotlist.mjs";
import registerRollDialog from "./batches/roll-dialog.mjs";
import registerHandToHand from "./batches/hand-to-hand.mjs";
import registerMigration from "./batches/migration.mjs";
import registerWeapons from "./batches/weapons.mjs";
import registerDefenses from "./batches/defenses.mjs";
import registerChargen from "./batches/chargen.mjs";
import registerCombatPhases from "./batches/combat-phases.mjs";
import registerActionTracking from "./batches/action-tracking.mjs";
import registerIntervene from "./batches/intervene.mjs";
import registerMobAttacks from "./batches/mob-attacks.mjs";
import registerSkillSheet from "./batches/skill-sheet.mjs";
import registerGearSheet from "./batches/gear-sheet.mjs";
import registerMobDebuffs from "./batches/mob-debuffs.mjs";

const BATCH_REGISTRARS = [
  registerRules,
  registerModifiers,
  registerDamagePipeline,
  registerRollParts,
  registerConditionsPure,
  registerDicePure,
  registerDataModels,
  registerRaceClassGrants,
  registerDiceIntegration,
  registerConditionsIntegration,
  registerActorDocument,
  registerActorSheet,
  registerItemDocument,
  registerItemSheet,
  registerDerivedData,
  registerRest,
  registerChatCards,
  registerDebuffEffectsPure,
  registerDebuffAutomation,
  registerRulesFixes,
  registerTableBatch,
  registerFavorImmunity,
  registerConsumables,
  registerCrawlerForgeImport,
  registerPdfImport,
  registerLootBox,
  registerPets,
  registerVehicles,
  registerHotlist,
  registerRollDialog,
  registerHandToHand,
  registerMigration,
  registerWeapons,
  registerDefenses,
  registerChargen,
  registerCombatPhases,
  registerActionTracking,
  registerIntervene,
  registerMobAttacks,
  registerSkillSheet,
  registerGearSheet,
  registerMobDebuffs,
];

export function registerCarlRpgQuenchTests(quench) {
  for (const register of BATCH_REGISTRARS) register(quench);
  console.log(`CarlRPG | Registered ${BATCH_REGISTRARS.length} Quench batches`);
}
