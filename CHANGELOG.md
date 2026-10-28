# Changelog

## 2.0.1
- Update notice: the window now reads «A new version of ADMaps Pathfinder is available: X (current: Y).»

## 2.0.0
The module rewritten for Foundry v13 and any game system.
- Pathfinding around walls (A*) for dragged tokens; no path — no move, the unreachable part drawn dashed.
- Large tokens never stop with a wall inside them; keyboard and scripted moves that would end clipped are refused.
- Players' tokens walk around visible enemies in a started combat.
- Alt goes straight through walls and enemies — for everyone, the GM only or no one (a setting).
- The drag ghost no longer clears the fog of war; no coloured path cells while dragging (a setting).
- Facing: the token art turns toward where the token walks, instantly and in the same update as the move; and toward
  the player's last target.
- routinglib (Manuel Vögele, MIT) now ships inside the module as a patched copy — the routinglib module is no longer
  needed.
- Works with libWrapper when it is installed.
- Update notice: the GM is told on load when a newer release is out.
- API for systems and modules: ghost tokens, service moves, the large-token footprint test.
