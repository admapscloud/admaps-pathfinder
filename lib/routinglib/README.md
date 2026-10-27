# routinglib (patched fork)

A copy of [routinglib](https://github.com/manuelVo/foundryvtt-routinglib) 1.1.1 by Manuel Vögele, MIT licence (see
`LICENSE`), patched for ADMaps Pathfinder: wall-height spans in the wall probes and the graph cache, enemy cells to walk
around (`options.admBlockers`), the terrain and floor search that reads adm-levels when it is on, large tokens tested
cell by cell, the background search run in 16 ms slices. Every change is marked `PATCHED`.

The module always searches with this copy; the standalone routinglib module is not needed. To the outside it is the
library's own API — `window.routinglib` and the `routinglib.ready` hook — unless the standalone module is enabled too:
then that one keeps `window.routinglib`, and this copy stays private to ADMaps Pathfinder.
