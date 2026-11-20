# CHANGELOG

## 0.8.0

Mostly behind-the-scenes tidying to make future work easier, plus:

### Sheets

- **Item tooltips:** Hover over an item's icon or name to see its description, or its name if it has none. On the Equipment Doll and the Hotlist, the name sits above the description.
- **Every tooltip is now Foundry's tooltip helper** instead of HTML titles.
- **Descriptions of Races, Classes, Features and Mob Attacks** on the character sheet now show links and inline rolls as their own sheets do.
- **Clearing the Crawler's number on a Loot Box** no longer resets it.

### Combat and rolls

- **Debuff changes are never lost:** When a player and the GM change the same creature's Debuffs at once (a potion as a round ends), both stick. A player's change now waits for the GM's client to apply it; with no GM logged in, it's made as before.
- **Opposed Checks that aren't Actions** (Party Skill Checks, Driving Checks, ramming) no longer suffer or use up Queasy and Staggered.
- **A negative Rank counts as untrained** and roll with Disadvantage.
- **A Natural 20 Evade's Advantage** follows the fight the crawler is in, resolving issues when multiple fights are running.

### Characters and items

- **The Taint stops mending too:** Mending an injury counts as healing, so a potion that heals or mends is kept, and a Heal Spell's Mend Debuff is refused, while The Taint lasts.
- **Items copied from a compendium** remember where they came from, so later updates can refresh them.
- **The GM Toolbox's Grind dialog** shows names with symbols in them correctly.

## 0.7.0

### Before you update

- **Back up your world** before installing 0.7.0. This release reorganises a lot of world data, and some of those changes can only be undone from a backup.
- Requires **Foundry VTT v14**.

### Combat

- **Phased combat** implemented (pp.80-82): Declaration, Reaction, Resolution and Crawler Actions, with an optional Surprise step. It's on by default for fights with a Mob; turn off "Phased combat" in the world settings to keep normal turns.
  - **The Combat Tracker** shows the phase and groups Mobs and Crawlers.
  - **Declaring:** the GM declares Mob Attacks from a panel on the map.
  - **The Reaction card:** crawlers respond to every incoming Attack in one place.
  - **The Damage card:** the GM rolls each Attack once, and Area, Splash, Major Fail and Natural 1 damage are worked out for you.
- **Action tracking** implemented (pp.61, 64, 80-81): Action bubbles in the tracker, spent automatically, with an AI Favor Action. Click a spent bubble to undo what it did, and the GM can adjust Actions from the tracker's right-click menu.
- **Intervene** implemented (p.82): other crawlers in the fight can add +1d6 to a roll with one click.
- **Shield Block** implemented (p.198). One Action rolls a separate Check against every Attack you can block that round, as Evade does. Damage halving, shield damage on failure, Spell blocking and Shield Bash automated. A Repair button on the shield fixes the damage.
- **Armor-Piercing and Anti-Piercing** implemented (p.95, p.225).
- **Taunt range and Catcher DR** automated (p.200, p.187). After a successful Taunt, the GM can also redirect that Mob's Area Attacks.
- **Defenses and movement** automated: bonuses and Debuffs that change Move, Step, Evade and DR now apply on their own.
- **Armor stacks by slot** (p.225): the best piece in each slot counts. Before, only one piece of armor counted at all.
- **The roll dialog:**
  - **Off-Stat rolls** (p.58): pick another Stat for a Skill; the card says which.
  - **The Difficulty is filled in for you** from the book's formulas (p.59): Unopposed, Stat Check, or Opposed against your target. A hint says which. The GM adjusts it for circumstances; the separate situational modifier is gone.
  - **Damage Effects** are buttons that default to None.
  - **Cancel** no longer rolls anyway.
- **AI Favor rerolls** update the original card in place, and Evades rolled from an Attack card stay on that card.
- **Combat rounds move the clock** 10 seconds each (p.62). Healing at the end of a round now ends Dying and other "until healed" Debuffs.

### Characters

- **Create Crawler wizard:** a new Character opens a step-by-step First Floor creation wizard, animal crawlers included. World settings choose how Stats and backgrounds are generated. Crawlers you already have are left alone.
- **A reorganised Character sheet:** the tabs are now Combat, Inventory, Skills, Benefits, Conditions and Details.
  - **The Combat tab comes first,** with your Stats, defenses, an Attack! button and the Hotlist.
  - **The header** gains a Mana bar; Gold moved to the Inventory.
  - **Defense tooltips** say where each bonus comes from.
  - **Token buttons:** the Prototype Token, Configure Token and art buttons are back.
- **The Hotlist** shows what each slot does: Cast, Roll, Use or Ready. Click an empty slot, or star an item, to fill it. In a fight it follows the book: Retrieve cards, weapon swaps, and Spells cast from the Hotlist (p.86). Worn gear stays out of it (p.98).
- **Deity block** on the Benefits tab, with worship tracking and a Receive a Boon button (pp.163-164). Your old Deity text is kept as its notes. Church benefits above your Deity's Tier don't apply.
- **The Details tab:**
  - **Rich text:** Clubs, Sponsors, Important Kills and Story are now rich-text boxes; your old entries are carried over.
  - **Potions Used:** a counter for permanent potions (p.218).
- **Base DR is always 0;** DR now comes from your Race, Class, gear and abilities. Any base DR typed on a Character is cleared, and the GM gets a list of the old values. **Add any you still want as a bonus on an item.**
- **Adding a Race sets your Size.** A Race or Class dragged from another Character now gives its bonuses, and replacing your Race or Class makes the new one active.
- **Clearing a number on a sheet** no longer resets it (a blank Level no longer drops you to Level 1).

### Pets and vehicles

- **Pets are their own actors** (pp.228-232), including mounts and minions.
  - **Implemented:** levelling with their crawler, Roles, and Command Pet.
  - **Your existing Pets and Mounts are converted automatically**, and the old Pet tab is gone. Anything that didn't fit goes into the new actor's Biography.
- **Vehicles are their own actors** (pp.72-76). **Your existing vehicles are converted the same way.**
  - **Implemented:** boarding, driving and Stop Checks, ramming, explosions, built-in weapons and upgrades.

### Mobs

- **A redesigned Mob sheet** to match the Character sheet. Evade and Surprise show the book's formula and the current value, e.g. "13+F (16)".
- **Mob Attacks are items** with their own sheet (p.267), and each Attack on the Mob sheet has an Attack button.
  - **Your existing Mobs' Attacks are converted** automatically, but not their Debuffs. **The GM gets a list of Mobs to check: set their Debuffs by hand.**
- **Mob Debuffs** land automatically by their trigger: on a hit, a bad Evade, or a Critical Fail.
- **Mob Size is a dropdown** of the book's sizes (p.92). Existing sizes are converted; any that can't be read are left blank.

### Gear and items

- **Gear slots** implemented (pp.98-99): the Equipment Doll only accepts gear where it's worn, with two-handed weapons, one belt and one cape. Dragging an item lights up where it fits.
  - **Your existing gear is given slots,** guessed from its "Gear Slot:" line or name. Gear worn where it no longer fits is taken off, and **the GM gets a list of who had gear taken off.**
- **Weapons have a Weapon Skill:** an Attack needs a weapon in hand with a matching Weapon Skill (hand-to-hand and natural attacks excepted).
  - **Filled in from names:** the update fills it in where a weapon's name matches. A "Longsword" or "Greatsword" gets Longsword.
  - **The rest by hand:** the GM gets a list of weapons in hand that still need one. **Open each and set its Weapon Skill.**
- **Potions, scrolls and spellbooks** can be used, with the book's limits and Potion Sickness automated (p.218).
- **Debuffs on weapons:** gear can inflict Debuffs with its wielder's Attacks, optionally only with certain Skills or on an Amazing Success.
- **Gear sheets fit on one page.** "Changes" are now called "Bonuses".
- **Healing and potions** no longer lower Health or Mana that's above its maximum.

### Skills and Spells

- **Healing others** implemented (p.206). Healing Skills and Spells say who they can heal: yourself, others, pets and minions, or anyone. They heal the token you target. Before, a heal cast on someone else healed the caster.
- **Durations and cooldowns** run themselves.
  - **A cooldown chip** shows how long until you can use something again.
  - **Using one early** asks first, and the card says "Used before cooldown." so the GM can see.
- **Timed Debuffs** wear off on their own (Table 11, pp.96-97), however the clock moves: a round, a rest, Foundry's time controls or a calendar module.
- **Debuffs at any Rank:** Skills and Spells can carry Debuffs from Rank 1, not just in their Upgrades.
- **Hand-to-Hand box** on Skills (p.179), ticked on the book's hand-to-hand Skills, including copies you already own.
- **Reorganised sheets:** the description comes first, and each Rank's Upgrades are tidy cards.
- **Rules fixes:**
  - Dodge adds to Evade instead of replacing it.
  - Races, Classes and Skills now carry their DR, Move, Step and Evade bonuses. Copies you already own are refreshed, so hand edits to those bonuses are overwritten.
  - Oakhide is a Spell you switch on.
  - Bang Bro triggers on an Amazing Success.
  - Powerful Strike multiplies only your base damage dice, then adds your modifiers (p.180). Choke Out and Smush multiply the whole hit.
  - Skullcracker's conditional Rank damage die is added, and conditional base dice double on a Critical Hit.
  - Untrained (Rank 0) Skills no longer advance from use on the Third Floor and deeper (p.58).
  - Gear that adds Ranks to a Skill unlocks its Upgrades while you wear it.
  - A Race or Class grant that would take a Skill past 10 stops at 10 without lowering a higher Rank (p.127).

### GM Toolbox

- **One Rest button** replaces Short, Long and Full Day, showing the book's text for each rest (p.94). Rest, Mend and Grind can move the clock forward.
- **Party Skill Check** implemented (p.59).
- **New scene** resets "once per scene" cooldowns.
- **The character picker** splits crawlers into logged in and not logged in, and names who plays each one.

### Compendiums and tokens

- **New Gear compendium:** a basic version of every weapon (plus a Greatsword and Greataxe), mundane armor and a shield, and adventuring gear like torches and rope. The Create Crawler wizard takes your starting weapon from here.
- **New Consumables compendium:** potions, an antidote, bandages, a scroll and a spellbook.
- **Armor-Piercing** marked on Dagger, Javelin, Icicles, Paladin's Smite, Thunderlash and Vine Porn.
- **Token defaults for new actors:**
  - **Characters and Pets** are linked, see, and are Friendly.
  - **Mobs** are unlinked and Hostile.
  - **Vehicles and Loot Boxes** are linked and Neutral.
  - **Names** show on hover.

  Your world's own token settings still win.

### Importing

- **Rulebook import:**
  - **Each book gets its own GM-only compendiums.** Mobs are filed by Floor, then Neighborhood or Quest, for both the core book and the Gamemaster's Toolkit.
  - **Mob Attacks come with their Debuffs and Armor-Piercing,** and Bosses and Elites with linked tokens.
  - **Spells and gear** you already have are copied from our compendiums.
  - **Re-importing** updates only what you haven't edited. Select no maps to skip them.
  - **The download watermark** is left out, and maps come straight from the book's images.
  - **The low-quality (LQ) edition is refused.**
  - **Books imported with 0.6.0** stay in their old folders. Delete those if you re-import, or you'll have two copies.
- **CrawlerForge import:**
  - **Compendium copies:** Skills, Spells and gear come from our compendiums where they match.
  - **Invented Skills and Spells** come in marked "Not in rulebook". CrawlerForge invents a few.
  - **Gear** is put on by the Equipment Doll's rules.
  - **The GM gets a report** of anything that didn't match.

### Not in this release

- **Point Mongo** (Achoobert's module) hasn't been updated: its gear has no slots or Weapon Skill.
- **Deferred:**
  - Third to Fifth Floor crawler creation;
  - mounts and riding;
  - minion details;
  - some vehicle rules (racing, chases, vehicle DR for passengers);
  - light from held torches.
- **Not automated:** Size Advantage, Action types, ammunition, lift limits and "once per Floor" cooldowns.
- **Won't be implemented:** crafting and enchanting. The book leaves too much to the GM.
- **Kept on purpose:** External Buffs stay as text, and the Dying countdown uses your CON Mod. Fights between crawlers use the PvP rules.
- **Timers only move when the clock moves:** when time is advanced, a round passes or someone rests.

## 0.6.0

### New

- Rulebook PDF importer (Settings → Carl RPG; thanks to Achoobert)
  - Import your own copies of the books into your world: gear and Spells become Items, stat blocks become Mob Actors, achievements go into a Journal Entry, and maps become Scenes.
  - Everything goes into folders named after the book. No book content ships with the system.
  - Importing the same book again updates the documents, but leaves alone any you've edited since the last import.
- CrawlerForge importer (Actor Directory button): turns a CrawlerForge crawler export into a Character.
- Loot Boxes: a new lootable actor type. The GM generates loot by tier, and players take items onto their own sheets.
- Character sheet
  - A Hotlist, plus gear and accessory slots that equip whatever you drag onto them.
  - Pet and Mount blocks, story fields, and Clubs, Deity and Important Kills lists.
  - Pronouns, Crawler #, Popularity, AI Favor and Gold in the header.
  - Click a column header to sort Skills, Spells and gear.
- AI Favor rerolls (p.61): crawler Stat, Skill, Opposed, Attack and Evade Checks get a "Reroll (AI Favor)" button.
  - It spends 1 AI Favor and rerolls the d20, keeping all modifiers.
  - Once per Check, never on a Natural 1, and not after the result has been used.

### Rules fixes

- Immunity: a target Immune to every damage type in a hit also ignores that Attack's Debuffs (p.93).
- Damage types: other spellings are read as the book's 13 types. For example, Cold is Ice, Radiant is Holy, Psionic is Psychic and Lightning is Electric, so Resistances apply to them.
- Opposed Spells: opposed Spell Checks now spend Mana.

### Fixes

- Loot taking: a player can only take items out of Loot Boxes, not from other crawlers. If giving an item out fails, it goes back into the box.
- PDF import on prefixed servers: works when Foundry runs under a URL prefix (such as host/foundry/).
- CrawlerForge imports: keep the Hotlist positions and put gold in the Gold field.

### Notes

- License: changes from 2026-11-11 on are MIT with the Commons Clause (no selling).
- Old field data: some character fields moved to system.details.\*. Values entered in the old fields before this release aren't carried over.
