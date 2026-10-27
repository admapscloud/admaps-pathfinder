import {initializeBackground, createAsyncPathfinder, cancelJob} from "./background.js";
import {cache, GriddedCache, initializeCaches, wipeCaches} from "./cache.js";
import {GriddedPathfinder, GridlessPathfinder, HybridPathfinder} from "./pathfinder.js";

import initGridlessPathfinding from "../wasm/gridless_pathfinding.js";
import {getAltOrientationFlagForToken, getHexTokenSize, isModuleActive, settingsScope} from "./util.js";

// PATCHED (adm): build marker — `__ADM_BUILD` in the console shows which code the client actually loaded (Electron
// caches JS, a full relaunch is needed).
globalThis.__ADM_BUILD = Object.assign(globalThis.__ADM_BUILD ?? {}, {routinglibInPathfinder: "2026-10-27"});

let foundryReady = false;
let wasmReady = false;

function initializePathfinder(from, to, options) {
	const token = options.token;

	let elevation = options.elevation;
	let tokenData;

	if (token) {
		tokenData = {width: token.document.width, height: token.document.height};
		if (!elevation) {
			elevation =
				isModuleActive("wall-height") && WallHeight._blockSightMovement
					? token.losHeight
					: token.document.elevation;
		}
		if (canvas.grid.isHexagonal) {
			tokenData.size = getHexTokenSize(token);
			tokenData.altOrientation = getAltOrientationFlagForToken(token, tokenData.size);
		}
	} else {
		tokenData = {width: 1, height: 1};
		elevation = elevation ?? 0;
		if (canvas.grid.isHexagonal) {
			tokenData.size = 1;
			tokenData.altOrientation = false;
		}
	}

	tokenData.elevation = elevation;
	// PATCHED (adm): the token's vertical height span for wall-height. A wall blocks
	// only if the segment [feet, head] lies ENTIRELY within the wall's range —
	// a token at a height equal to the wall's top stands ON it and passes. Without the span
	// the stub source in stepCollidesWithWall carries no height, wall-height
	// skips the filter (no source.object), and walls with top=15 blocked paths
	// at height 15, even though actual movement gets through.
	tokenData.losTop = (token ? token.losHeight : undefined) ?? elevation;

	// PATCHED (adm): TERRAIN MODE. The graph used to be built at a single height — the one the token is standing at
	// right now. For a token on the ground (0), a plateau with 0–15 walls was closed off on all
	// sides, and no path up the stairs was found: the graph did not know that on the top step the token is already at 15
	// and passes the wall. Now, if the token stands on a surface (is not
	// flying), the height is taken per cell from adm-levels (plateau/stairs/water), and
	// the token's own height is kept. A flying token searches the old way, at its own elevation.
	// The caller can opt out: options.admTerrain === false.
	if (token && options.admTerrain !== false && typeof globalThis.__admSurfaceFloorAt === "function") {
		const doc = token.document;
		const base = Number(doc.elevation ?? 0) || 0;
		const cx = doc.x + (doc.width || 1) * canvas.grid.sizeX / 2;
		const cy = doc.y + (doc.height || 1) * canvas.grid.sizeY / 2;
		let surface = NaN;
		try { surface = Number(globalThis.__admSurfaceFloorAt(cx, cy, base)); } catch (e) { /* no data — the old way */ }
		if (Number.isFinite(surface) && Math.abs(surface - base) < 0.5) {
			tokenData.terrain = true;
			tokenData.losDiff = Math.max(0, (Number(token.losHeight ?? base) || base) - base);
		}
	}

	const levelIndex = cache.getLevelIndexForElevation(elevation);
	if (canvas.grid.type === CONST.GRID_TYPES.GRIDLESS) {
		const tokenSize = Math.max(tokenData.width, tokenData.height);
		const graph = cache.getGraphFor(tokenSize, levelIndex, elevation);
		return new GridlessPathfinder(graph, from, to, options);
	} else {
		const sizeIndex = GriddedCache.getSnapPointIndexForTokenData(tokenData);
		const flat = new GriddedPathfinder(sizeIndex, levelIndex, from, to, token, tokenData, options);
		// PATCHED (adm): "terrain mode" on a square grid is a HYBRID (pathfinder.js HybridPathfinder): first this
		// regular search, and only if its path ends on the wrong floor — a per-floor search. The first version (per-floor
		// right away) targeted a dissolved roof instead of the room behind the door and caused lag — rolled back 24.09.2026.
		if (tokenData.terrain && canvas.grid.type === CONST.GRID_TYPES.SQUARE
			&& typeof globalThis.__admStepFloor === "function") {
			return new HybridPathfinder(flat, from, to, token, tokenData, options);
		}
		return flat;
	}
}

function calculatePath(from, to, options = {}) {
	const pathfinder = initializePathfinder(from, to, options);
	return createAsyncPathfinder(pathfinder);
}

function calculatePathBlocking(from, to, options = {}) {
	if (!options.maxDistance) {
		throw "A maximum distance (options.maxDistance) must be specified when calling `calculatePathBlocking`. To calculte long paths, please use the ";
	}
	const pathfinder = initializePathfinder(from, to, options);

	let path = undefined;
	while (path === undefined) {
		path = pathfinder.step();
	}

	if (path === null) {
		return null;
	}

	return pathfinder.postProcessResult(path);
}

/**
 * PATCHED (admaps-pathfinder): this copy inside the module does not start on load; the module starts it on its init,
 * always — its search runs on this copy alone (`routingApi`), whatever else is installed. To the outside it is the
 * library as ever — `window.routinglib` and the "routinglib.ready" hook — unless the standalone routinglib module is on:
 * then that one keeps `window.routinglib` for whoever calls it, and this copy stays private.
 * @param {string} namespace         whose namespace holds the setting (the module's id)
 * @param {object} [options]
 * @param {boolean} [options.publish]  set window.routinglib and call "routinglib.ready"
 */
let booted = false;
let published = false;
let api = null;
export function bootRoutinglib(namespace, {publish = true} = {}) {
	if (booted) return;
	booted = true;
	published = publish;
	settingsScope.namespace = namespace;
	game.settings.register(namespace, "gridlessTokenSizeRatio", {
		scope: "world",
		config: false,
		type: Number,
		default: 0.9,
		onChange: () => {
			if (canvas.grid.type === CONST.GRID_TYPES.GRIDLESS) {
				cache.reset();
			}
		},
	});

	Hooks.once("ready", async () => {
		foundryReady = true;
		initializeIfReady();
	});

	initGridlessPathfinding().then(() => {
		wasmReady = true;
		initializeIfReady();
	});
}

function initializeIfReady() {
	if (!foundryReady || !wasmReady) return;
	// PATCHED (admaps-pathfinder): a world loaded with no scene on the canvas has no grid — the cache would throw here,
	// and the library would never start. The canvasReady hook below builds it when a scene is first drawn.
	if (canvas.grid) initializeCaches();
	initializeBackground();
	api = {calculatePath, calculatePathBlocking, cancelPathfinding};
	if (published) window.routinglib = api;

	Hooks.on("canvasInit", wipeCaches);
	// TODO There's no point in re-running jobs when switching scenes. Better cancel them all in that case
	Hooks.on("canvasReady", initializeCaches);
	Hooks.on("createWall", wipeCaches);
	Hooks.on("updateWall", wipeCaches);
	Hooks.on("deleteWall", wipeCaches);
	// PATCHED (adm): the "terrain mode" graph depends on adm-levels regions (shape, height,
	// type). A visibility-only change (Alt+W toggles it on all regions) does not count.
	Hooks.on("createRegion", wipeCaches);
	Hooks.on("deleteRegion", wipeCaches);
	Hooks.on("updateRegion", (doc, changes) => {
		if (changes && ("shapes" in changes || "elevation" in changes || "flags" in changes)) wipeCaches();
	});
	// PATCHED (adm): an adm-levels region bound to a tile is switched on and off by the tile's visibility — the floors
	// change, while search results are cached (pathfinder.js HybridPathfinder).
	Hooks.on("updateTile", (doc, changes) => {
		if (changes && "hidden" in changes) wipeCaches();
	});

	if (published) Hooks.callAll("routinglib.ready");
}

function cancelPathfinding(promise) {
	return cancelJob(promise);
}

/** PATCHED (admaps-pathfinder): this copy's API once it is up (after `ready` and the wasm), else null. */
export function routingApi() {
	return api;
}
