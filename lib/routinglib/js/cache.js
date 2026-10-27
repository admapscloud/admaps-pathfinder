import {resetJobs} from "./background.js";
import {getPixelsFromGridPositionObj, getCenterFromGridPositionObj} from "./foundry_fixes.js";
import {getSnapPointForTokenDataObj, getTokenShapeForTokenData, isModuleActive, settingsScope} from "./util.js";

import * as GridlessPathfinding from "../wasm/gridless_pathfinding.js";

export let cache;

export function initializeCaches() {
	if (canvas.grid.type === CONST.GRID_TYPES.GRIDLESS) {
		cache = new GridlessCache();
	} else {
		cache = new GriddedCache();
	}
}

export function wipeCaches() {
	// PATCHED (admaps-pathfinder): no cache yet — the world was loaded with no scene (main.js initializeIfReady).
	cache?.reset();
	resetJobs();
}

class Cache {
	constructor() {
		this.reset();
	}

	reset() {
		this.levelIndexes = detectLevels();
		this.graphs = [];
		// PATCHED (adm): per-cell surface height for the terrain-mode graph (see main.js).
		this.terrainElev = new Map();
		// PATCHED (adm): results of floor-by-floor search steps (LayeredPathfinder): keyed by "size|height" — "cell+floor →
		// neighbor" → floor or null. Lives until the cache reset — walls, doors and regions reset it (main.js), like the graphs.
		this.layeredMemo = new Map();
		// PATCHED (adm): whole hybrid search results (HybridPathfinder) and floors per segment of ordinary paths.
		this.hybridResults = new Map();
		this.segFloorMemo = new Map();
	}

	getLevelIndexForElevation(elevation) {
		let start = 0;
		let end = this.levelIndexes.length;
		// Bisect levelindexes to find the correct index for the current elevation
		while (start !== end) {
			const center = (start + end) >> 1; // Integer division by 2
			const border = this.levelIndexes[center];
			if (elevation == border.elevation) {
				if (border.isTop) {
					start = center - 1;
					end = center - 1;
				} else {
					start = center;
					end = center;
				}
			} else if (elevation < border.elevation) {
				end = center;
			} else {
				start = center + 1;
			}
		}
		return start;
	}
}

export class GriddedCache extends Cache {
	reset() {
		super.reset();
		// gridWidth limits x-axis (rows, i), gridHeight limits y-axis (columns, j)
		if (canvas.grid.isHexagonal && !canvas.grid.columnar) {
			this.gridWidth = Math.ceil(canvas.dimensions.height / ((3 / 4) * canvas.grid.sizeY));
		} else {
			this.gridWidth = Math.ceil(canvas.dimensions.height / canvas.grid.sizeY);
		}
		if (canvas.grid.isHexagonal && canvas.grid.columnar) {
			this.gridHeight = Math.ceil(canvas.dimensions.width / ((3 / 4) * canvas.grid.sizeX));
		} else {
			this.gridHeight = Math.ceil(canvas.dimensions.width / canvas.grid.sizeX);
		}
	}

	static getSnapPointIndexForTokenData(tokenData) {
		if (canvas.grid.type === CONST.GRID_TYPES.GRIDLESS) return 0;
		if (canvas.grid.isHexagonal) {
			if (tokenData.hexSizeSupport?.altSnappingFlag) {
				return tokenData.hexSizeSupport.borderSize % 2;
			} else {
				return 0;
			}
		}
		const snapIdx = tokenData.width % 2 | (tokenData.height % 2 << 1);
		// Encode token dimensions into the index so that tokens of different
		// sizes (e.g. 1x1 vs 3x3) don't share the same cached graph.
		// The snap-point index uses bits 0-1, width uses bits 2-9, height uses bits 10-17.
		const w = Math.max(1, Math.min(255, Math.round(tokenData.width)));
		const h = Math.max(1, Math.min(255, Math.round(tokenData.height)));
		return snapIdx | (w << 2) | (h << 10);
	}

	getInitializedNode(pos, sizeIndex, levelIndex, tokenData) {
		let sizeGraphs = this.graphs[sizeIndex];
		if (!sizeGraphs) {
			sizeGraphs = [];
			this.graphs[sizeIndex] = sizeGraphs;
		}
		// PATCHED (adm): the cache key INCLUDES the token's height span, not just the level.
		// Levels are laid out by wall boundaries, and an explicit bottom=0 on a wall
		// puts the ground and the roof into ONE levelIndex — a graph first built
		// by a token on the roof (walls are transparent there) was handed to a token on the ground:
		// routinglib returned a "straight line" through the wall, the preview trusted it, and the real
		// drop ran into the core's genuine collision.
		// In terrain mode the height comes from the cells, not from the token — the graph is shared by
		// surface-standing tokens of this size and height FROM THE SAME START ELEVATION: a cell cut through
		// its center by a plateau edge is plateau for a token standing on the plateau and ground for one
		// standing on the ground (adm-levels, 17.09.2026).
		const levelKey = tokenData.terrain
			? "T|" + (tokenData.losDiff ?? 0) + "|" + (tokenData.elevation ?? 0)
			: levelIndex + "|" + (tokenData.elevation ?? 0) + "|" + (tokenData.losTop ?? tokenData.elevation ?? 0);
		let graph = sizeGraphs[levelKey];
		if (!graph) {
			graph = this.makeEmptyGraph();
			sizeGraphs[levelKey] = graph;
		}
		let node = graph[pos.y][pos.x];
		if (!node) {
			const neighbors = [];
			const tw = tokenData.width || 1;
			const th = tokenData.height || 1;
			for (const neighborPos of canvas.grid.getAdjacentOffsets({i: pos.x, j: pos.y})
					.map(a => { return {x: a.i, y: a.j} })) {
				if (
					neighborPos.x < 0 ||
					neighborPos.y < 0 ||
					(neighborPos.x + th - 1) >= this.gridWidth ||
					(neighborPos.y + tw - 1) >= this.gridHeight
				) {
					continue;
				}
				if (!stepCollidesWithWall(pos, neighborPos, tokenData, true)) {
					const isDiagonal =
						pos.x !== neighborPos.x &&
						pos.y !== neighborPos.y &&
						canvas.grid.type === CONST.GRID_TYPES.SQUARE;
					neighbors.push({...neighborPos, isDiagonal});
				}
			}
			node = {...pos, neighbors};
			graph[pos.y][pos.x] = node;
		}
		return node;
	}

	makeEmptyGraph() {
		const graph = new Array(this.gridHeight);
		for (let y = 0; y < this.gridHeight; y++) {
			graph[y] = new Array(this.gridWidth);
		}
		return graph;
	}
}

class GridlessCache extends Cache {
	getGraphFor(tokenSize, levelIndex, elevation) {
		let levelGraphs = this.graphs[levelIndex];
		if (!levelGraphs) {
			levelGraphs = new Map();
			this.graphs[levelIndex] = levelGraphs;
		}
		let graph = levelGraphs[tokenSize];
		if (!graph) {
			const tokenCalcSize =
				tokenSize * canvas.grid.size * game.settings.get(settingsScope.namespace, "gridlessTokenSizeRatio");
			const walls = canvas.walls.placeables;
			const wallHeightEnabled = isModuleActive("wall-height");
			graph = GridlessPathfinding.initializeGraph(
				walls,
				tokenCalcSize,
				elevation,
				wallHeightEnabled,
			);
			levelGraphs[tokenSize] = graph;
		}
		return graph;
	}
}

class LevelBorder {
	constructor(elevation, isTop) {
		this.elevation = elevation;
		this.isTop = isTop;
	}
}

function detectLevels() {
	const levelBorders = new Map();
	levelBorders[-Infinity] = {hasTop: false, hasBottom: true};
	levelBorders[Infinity] = {hasTop: true, hasBottom: false};
	const levelBorderElevations = [-Infinity, Infinity];
	if (isModuleActive("wall-height")) {
		for (const wall of canvas.walls.placeables) {
			const wallHeight = wall.document.flags["wall-height"];
			const top = wallHeight?.top ?? Infinity;
			const topBorder = levelBorders[top];
			if (!topBorder) {
				levelBorders[top] = {hasTop: true, hasBottom: false};
				levelBorderElevations.push(top);
			} else {
				topBorder.hasTop = true;
			}
			const bottom = wallHeight?.bottom ?? -Infinity;
			const bottomBorder = levelBorders[bottom];
			if (!bottomBorder) {
				levelBorders[bottom] = {hasTop: false, hasBottom: true};
				levelBorderElevations.push(bottom);
			} else {
				bottomBorder.hasBottom = true;
			}
		}
	}
	// Levels must be sorted because it will be bisected later
	levelBorderElevations.sort();
	const levels = [];
	for (const elevation of levelBorderElevations) {
		const border = levelBorders[elevation];
		if (border.hasBottom) {
			levels.push(new LevelBorder(elevation, false));
		}
		if (border.hasTop) {
			levels.push(new LevelBorder(elevation, true));
		}
	}
	return levels;
}

/**
 * PATCHED (adm): the token's vertical height span for a step FROM cell `from`.
 * Normally — the token's elevation and its top. In terrain mode — the surface height under
 * the token in this cell (adm-levels) plus the token's height. We take the cell we step FROM, like
 * real movement does: from the top step (15) a 0–15 wall can be passed, from the ground (0) it cannot;
 * you can jump down from a plateau, but you cannot climb onto it over a wall.
 */
export function stepSpan(from, tokenData) {
	if (!tokenData.terrain) {
		const b = tokenData.elevation ?? 0;
		return {b, t: tokenData.losTop ?? b};
	}
	const w = tokenData.width || 1;
	const h = tokenData.height || 1;
	// Start elevation is part of the key: adm-levels' answer for a cell on a plateau edge depends on it.
	const key = from.x + "," + from.y + "," + w + "," + h + "," + (tokenData.elevation ?? 0);
	let b = cache?.terrainElev?.get(key);
	if (b === undefined) {
		const tl = getPixelsFromGridPositionObj(from);
		const cx = tl.x + w * canvas.grid.sizeX / 2;
		const cy = tl.y + h * canvas.grid.sizeY / 2;
		try { b = Number(globalThis.__admSurfaceFloorAt(cx, cy, tokenData.elevation ?? 0)); } catch (e) { b = NaN; }
		if (!Number.isFinite(b)) b = tokenData.elevation ?? 0;
		cache?.terrainElev?.set(key, b);
	}
	return {b, t: b + (tokenData.losDiff ?? 0)};
}

/**
 * PATCHED (adm): one stub source for all wall probes. Each probe used to create a new PointVisionSource (a deep
 * copy of the default data, shader layers), and a single pathfinding run makes thousands of probes. It only carries the
 * height span for wall-height (source.object); probes run one at a time.
 */
let admProbeSource = null;
function probeSourceFor(span) {
	admProbeSource ??= new foundry.canvas.sources.PointVisionSource({});
	admProbeSource.object = {b: span.b, t: span.t};
	return admProbeSource;
}

export function stepCollidesWithWall(from, to, tokenData, adjustPos = false, spanOverride = null) {
	// PATCHED (adm): in terrain mode stairs/ramps are entered and left only along the slope, through their ends.
	// Before, a step was checked only against walls at the source cell's height: a route climbed halfway up the stairs
	// from the hold and stepped off sideways — 10 feet down, into a pocket between walls unreachable on foot (24.09.2026).
	// adm-levels decides (__admRampStepBlocked): it holds the stairs data. Center — middle of the token shape, as in stepSpan.
	// spanOverride — floor-by-floor search (LayeredPathfinder): it knows the floors of both cells and checks stairs itself.
	if (!spanOverride && tokenData.terrain && typeof globalThis.__admRampStepBlocked === "function") {
		const w = tokenData.width || 1;
		const h = tokenData.height || 1;
		const ox = w * canvas.grid.sizeX / 2;
		const oy = h * canvas.grid.sizeY / 2;
		const a = getPixelsFromGridPositionObj(from);
		const b = getPixelsFromGridPositionObj(to);
		try {
			if (globalThis.__admRampStepBlocked(a.x + ox, a.y + oy, b.x + ox, b.y + oy, tokenData.elevation ?? 0)) return true;
		} catch (e) { /* could not decide — fall back to the wall check */ }
	}
	const span = spanOverride ?? stepSpan(from, tokenData);
	// For large tokens (width>1 or height>1) we check collision
	// for every cell: a ray from the center of the cell's current position → center of the target one.
	// For large tokens we do NOT apply adjustPos — a 1px shift may
	// land on a wall of a neighboring cell inside the token.
	if (tokenData.width > 1 || tokenData.height > 1) {
		const stepDx = to.x - from.x;
		const stepDy = to.y - from.y;
		// PATCHED (adm): wall-height reads the height span from source.object.{b,t} —
		// without it the height filter is skipped and the wall blocks at any height.
		const source = probeSourceFor(span);
		for (let cy = 0; cy < tokenData.width; cy++) {
			for (let cx = 0; cx < tokenData.height; cx++) {
				const cellFrom = {x: from.x + cx, y: from.y + cy};
				const cellTo = {x: cellFrom.x + stepDx, y: cellFrom.y + stepDy};
				const cellStartPx = getCenterFromGridPositionObj(cellFrom);
				const cellEndPx = getCenterFromGridPositionObj(cellTo);
				const startPt = {...cellStartPx};
				// PATCHED (adm): the height span goes on the START POINT, not only on source.object —
				// setSourceElevation (wall-height) overwrites object.b/t with the values of
				// origin.b/t. Bare t=b=elevation gave "15 ≤ 15" → blocked on the roof.
				startPt.b = span.b;
				startPt.t = span.t;
				if (CONFIG.Canvas.polygonBackends.move.testCollision(startPt, cellEndPx, {
					mode: "any",
					type: "move",
					source,
				})) {
						return true;
				}
			}
		}
		return false;
	}

	// 1x1 token — original logic via the snap point
	const stepStart = getSnapPointForTokenDataObj(getPixelsFromGridPositionObj(from), tokenData);
	const stepEnd = getSnapPointForTokenDataObj(getPixelsFromGridPositionObj(to), tokenData);
	let adjustedStart;
	if (adjustPos) {
		adjustedStart = {
			x: stepStart.x + Math.sign(stepStart.x - stepEnd.x),
			y: stepStart.y + Math.sign(stepStart.y - stepEnd.y),
		};
	} else {
		adjustedStart = stepStart;
	}
	// PATCHED (adm): see the comment in the large-token branch — height span on the point.
	adjustedStart.b = span.b;
	adjustedStart.t = span.t;
	// PATCHED (adm): wall-height reads the height span from source.object.{b,t} —
	// without it the height filter is skipped and the wall blocks at any height.
	const source = probeSourceFor(span);
	return CONFIG.Canvas.polygonBackends.move.testCollision(adjustedStart, stepEnd, {
		mode: "any",
		type: "move",
		source,
	});
}
