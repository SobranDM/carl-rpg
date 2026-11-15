# CHANGELOG

## 0.7.0

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
