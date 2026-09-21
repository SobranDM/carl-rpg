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
import registerItemDocument from "./batches/item-document.mjs";
import registerDerivedData from "./batches/derived-data.mjs";
import registerRest from "./batches/rest.mjs";
import registerChatCards from "./batches/chat-cards.mjs";

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
  registerItemDocument,
  registerDerivedData,
  registerRest,
  registerChatCards,
];

export function registerCarlRpgQuenchTests(quench) {
  for (const register of BATCH_REGISTRARS) register(quench);
  console.log(`CarlRPG | Registered ${BATCH_REGISTRARS.length} Quench batches`);
}
