# ADMaps Pathfinder

To install the **ADMaps Pathfinder** module:
1. Go to the **Add-on Modules** tab in Foundry VTT.
2. Paste the manifest link below into the **Manifest URL** field at the bottom.
3. Click **Install**.

The module will be automatically downloaded and installed. Once complete, enable it in your world settings like any other module.

**Manifest URL:**

```
https://github.com/admapscloud/admaps-pathfinder/releases/latest/download/module.json
```

---

Tokens that walk around walls when you drag them, and turn toward where they go. Works with any game system.

## Requirements

- Foundry VTT v13
- [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) is recommended, not required.
- The **routinglib** module is **not** needed: the module carries its own copy (see [Third-party library](#third-party-library)).

## Pathfinding

- **Around walls.** A dragged token walks cell by cell around walls (A* search) on square grids. Hex and gridless
  scenes keep Foundry's own movement.
- **No way through — no move.** When there is no path, the unreachable part of the ruler is drawn dashed and the token
  stays where it is, instead of walking a straight line through the wall.
- **Large tokens** (2×2 and bigger) never stop with a wall running inside them: the path ends at the last cell where
  the whole token fits. A keyboard or scripted move that would end clipped is refused.
- **Enemies in combat.** In a started combat, players' tokens walk around visible hostile tokens at the same height
  (square grid). Hidden and invisible tokens do not give themselves away. Players pass through each other.
- **Alt goes straight through** — walls, enemies and the path search are off while Alt is held. Who may do it is a
  setting: everyone, the GM only, or no one.
- **The drag ghost keeps the fog:** while a token is dragged, its preview copy neither sees nor clears the fog of war.
- **No coloured path cells** while dragging (a setting).
- Heights: with [Wall Height](https://foundryvtt.com/packages/wall-height), walls block by the token's own height
  span, so a token standing on top of a wall passes over it.

## Facing

- **Face the way of movement.** The token art is mirrored toward where the token walks, left or right — by the path it
  really takes, so a detour around a wall that ends to the right looks right. Only the mirror flips; the token's size
  never changes. The turn is instant and goes into the same update as the move, so one Ctrl+Z takes back both.
  The token art should look right.
- **Face the target.** A player's token (the selected one, else their character's) turns toward their last target.

## Settings

All in **Configure Settings → ADMaps Pathfinder**: pathfinding, who may use Alt, walking around enemies, the drag
ghost and the fog, coloured path cells, facing the way of movement, facing the target, and the update notice.

## For system and module developers

`game.modules.get("admaps-pathfinder").api`:

- `registerGhost(doc => boolean)` — tokens that move straight through walls (scenery, spirits): no path search, no
  footprint check, no turning. A single token can be made one with the flag `flags.admaps-pathfinder.ghost = true`.
- `registerSkip((doc, options) => boolean)` — updates that are not the token walking (the system shifting a token for
  its own reasons): no footprint check, no turning.
- `footprintBlockedAt(tokenDoc, x, y, elevation?)` — whether a large token may not stand at that top-left point
  (a wall would be inside it); for pickers that place a token.
- `isBypass()` — whether moves are unconstrained right now (Alt where allowed, or the GM's Unconstrained Movement).

`window.routinglib` and the `routinglib.ready` hook work as with the routinglib module, for code that calls the library
directly.

## Update notice

When a newer release is out, the GM gets a window on load with the installed and the new version and how to update.
«Don't show again» hides it until the next release; the module setting **Update notice** turns it off.

## Third-party library

Path search uses **[routinglib](https://github.com/manuelVo/foundryvtt-routinglib)** by Manuel Vögele, MIT licence.
A modified copy ships inside this module in `lib/routinglib` with its licence (`lib/routinglib/LICENSE`); every change
is marked `PATCHED` in the code. The changes: wall heights in the wall tests and the graph cache, enemy cells to walk
around, large tokens tested cell by cell, floors and terrain read from ADMaps Tools when it is installed, the search
run in short slices so the frame rate holds. If the standalone routinglib module is also enabled, ADMaps Pathfinder
still searches with its own copy and leaves `window.routinglib` to the standalone one.

## License

MIT © 2026 [ADMaps](https://admaps.cloud/). The routinglib copy in `lib/routinglib` is MIT © 2021 Manuel Vögele.
