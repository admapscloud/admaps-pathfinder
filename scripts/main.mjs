import { MODULE_ID, registerSettings } from "./settings.mjs";
import { installPathfinding, footprintBlockedAt, registerGhost, registerSkip, isBypass, useRouting } from "./pathfinding.mjs";
import { installFacing } from "./facing.mjs";
import { registerUpdateNotice } from "./update.mjs";
import { bootRoutinglib, routingApi } from "../lib/routinglib/js/main.js";

// Build mark: `__ADM_BUILD` in the console shows which code the client really loaded (Electron caches scripts).
globalThis.__ADM_BUILD = Object.assign(globalThis.__ADM_BUILD ?? {}, { [MODULE_ID]: "2026-10-28" });

Hooks.once("init", () => {
	registerSettings();
	registerUpdateNotice();

	// The search always runs on the module's own copy of routinglib (lib/routinglib, the patched fork): the standalone
	// routinglib module is not needed. If it is on anyway, it keeps window.routinglib for whoever calls it, and the
	// copy stays private — two copies would swap window.routinglib under each other.
	bootRoutinglib(MODULE_ID, { publish: !game.modules.get("routinglib")?.active });
	useRouting(routingApi);

	// An older adm-daggerheart installs its own copy of the search and the turning on its init (before modules): two
	// would search and turn twice.
	if (globalThis.__ADM_PATHFINDING_V1?.installed) {
		console.warn(`${MODULE_ID} | the system's own pathfinding is installed — the module stands aside`);
	} else {
		installPathfinding();
		installFacing();
	}

	game.modules.get(MODULE_ID).api = { footprintBlockedAt, registerGhost, registerSkip, isBypass };
});
