/**
 * The system's sound effects (assets/sounds), each one mutable per user in
 * their own settings (ruled 2026-11-19):
 *  - achievement: for the crawler's player, when its New Achievement! splash
 *    shows (apps/achievement-splash.mjs);
 *  - levelUp: for the crawler's player, when the crawler gains a Level;
 *  - lootBox: for everyone, when a box opens in the Opening Session
 *    (apps/opening-session.mjs).
 * Each plays on the client that should hear it - nothing is broadcast.
 */

const SCOPE = "carl-rpg";
const PATH = "systems/carl-rpg/assets/sounds";

export const SOUNDS = {
  achievement: { src: `${PATH}/achievement.wav`, setting: "muteAchievementSound" },
  levelUp: { src: `${PATH}/level-up-epic-brass.wav`, setting: "muteLevelUpSound" },
  lootBox: { src: `${PATH}/lootbox-reveal.wav`, setting: "muteLootBoxSound" },
};

/** Register each sound's mute setting, this user's own (init). */
export function registerSoundSettings() {
  for (const [key, sound] of Object.entries(SOUNDS)) {
    game.settings.register(SCOPE, sound.setting, {
      name: `CARLRPG.Sound.${key}.Name`,
      hint: `CARLRPG.Sound.${key}.Hint`,
      scope: "client",
      config: true,
      type: Boolean,
      default: false,
    });
  }
}

/**
 * How long after a sound starts that it isn't started again, while it
 * loads (once it's playing, it isn't started again until it ends).
 */
export const soundTiming = { guardMs: 1500 };

/** Each sound's last start here: {at: ms, sound: Sound|null}. */
const started = new Map();

/**
 * Play a sound here, unless this user muted it - or it's already playing:
 * several Levels, achievements or boxes at once (two crawlers leveled by
 * one Boss kill, a run of Level edits) make one sound, not a pile of them.
 * @param {keyof SOUNDS} key
 * @returns {Promise<object>|null}  The sound starting (AudioHelper.play), or
 *   null if muted or already playing.
 */
export function playSound(key) {
  const sound = SOUNDS[key];
  if (!sound || game.settings.get(SCOPE, sound.setting)) return null;
  const last = started.get(key);
  if (last && (last.sound?.playing || Date.now() - last.at < soundTiming.guardMs)) return null;
  const entry = { at: Date.now(), sound: null };
  started.set(key, entry);
  const playing = foundry.audio.AudioHelper.play({ src: sound.src, volume: 0.8 }, false);
  Promise.resolve(playing)
    .then((s) => {
      entry.sound = s ?? null;
    })
    .catch(() => {});
  return playing ?? null;
}

/**
 * Does a crawler's Level gain sound here? On its player's client - a
 * non-GM owner of the Character.
 * @param {Actor} actor
 * @returns {boolean}
 */
export function levelUpSoundsHere(actor) {
  return (
    actor?.type === "character" &&
    !game.user.isGM &&
    actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
  );
}

/**
 * The Level-up sound, however the Level was gained (grinding, a Boss kill,
 * the GM's edit): CarlRPGActor#_preUpdate puts the gain in the update's
 * options (`carlLevelDelta`), which reach every client. Call from `ready`.
 */
export function registerSoundHooks() {
  Hooks.on("updateActor", (actor, changed, options) => {
    if ((options?.carlLevelDelta?.[actor.id] ?? 0) > 0 && levelUpSoundsHere(actor)) {
      playSound("levelUp");
    }
  });
}
