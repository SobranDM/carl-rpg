/**
 * CarlRPG Quench test suite - registration aggregator.
 *
 * Built directly into the carl-rpg system (not a separate Foundry module,
 * unlike the sibling wwn-system-tests/deltagreen-system-tests projects) per
 * an explicit maintainer decision, so smoke-testing rules/combat/character-
 * advancement changes doesn't require re-testing everything by hand.
 *
 * Registering the `quenchReady` listener below is always harmless and free
 * even when the Quench module isn't installed/active - the hook simply
 * never fires. This whole directory has exactly one inbound reference from
 * the rest of the system: the `registerCarlRpgQuenchTests()` call in
 * module/carl-rpg.mjs. Whenever real CI/distribution tooling gets built for
 * this system, excluding Quench tests from what ships is a two-line job:
 * drop that one import line and exclude this directory from the build.
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

export function registerCarlRpgQuenchTests() {
  Hooks.on("quenchReady", (quench) => {
    for (const register of BATCH_REGISTRARS) register(quench);
    console.log(`CarlRPG | Registered ${BATCH_REGISTRARS.length} Quench batches`);
  });
}
