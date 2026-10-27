import {cache, stepCollidesWithWall, stepSpan} from "./cache.js";
import {PriorityQueueSet} from "./data_structures.js";
import {getCenterFromGridPositionObj, getPixelsFromGridPositionObj} from "./foundry_fixes.js";
import {
	applyOffset,
	buildOffset,
	getAreaFromPositionAndShape,
	getTokenShapeForTokenData,
	nodeId,
} from "./util.js";

import * as GridlessPathfinding from "../wasm/gridless_pathfinding.js";

/**
 * PATCHED (adm): cells the search routes around are enemies in combat. The caller decides who counts as an enemy (the
 * adm-daggerheart system, scripts/pathfinding.mjs): options.admBlockers = {key, rects: [{r0, r1, c0, c1, z}]} — rows and
 * columns inclusive (a node's x is the row, y is the column, as everywhere in routinglib) plus the enemy's elevation.
 * The token's shape is h rows × w columns from pos; it is blocked if an enemy stands on the same floor (less than a foot
 * apart) and the rectangles overlap. Moving through an enemy is Alt: the search is then not called at all and the
 * move goes straight (27.09.2026).
 */
function admBlockedAt(blockers, pos, w, h, z) {
	for (const r of blockers.rects) {
		if (Math.abs(r.z - z) >= 1) continue;
		if (pos.x > r.r1 || pos.x + h - 1 < r.r0 || pos.y > r.c1 || pos.y + w - 1 < r.c0) continue;
		return true;
	}
	return false;
}

export class GriddedPathfinder {
	constructor(sizeIndex, levelIndex, from, to, token, tokenData, options) {
		this.sizeIndex = sizeIndex;
		this.levelIndex = levelIndex;
		this.targetPos = to;
		this.startPos = from;
		this.token = token;
		this.tokenData = tokenData;
		this.tokenShape = getTokenShapeForTokenData(tokenData);
		this.startCost = 0; // TODO Allow specifying a start cost
		this.interpolate = options.interpolate ?? true;
		this.maxDistance = options.maxDistance ?? Infinity;
		this.maxDistance = Math.round(this.maxDistance / canvas.scene.dimensions.distance);
		this.ignoreTerrain = options.ignoreTerrain ?? false;
		this.admBlockers = options.admBlockers ?? null; // PATCHED (adm): enemies in combat (admBlockedAt)
		this.reset();
	}

	reset() {
		this.use5105 = game.system.id === "pf2e" || canvas.grid.diagonalRule === "5105";
		this.nextNodes = new PriorityQueueSet(
			(node1, node2) => node1.node === node2.node,
			node => node.estimated,
		);
		this.previousNodes = new Set();
		this.gridWidth = Math.ceil(canvas.dimensions.width / canvas.grid.sizeX);
		this.gridHeight = Math.ceil(canvas.dimensions.height / canvas.grid.sizeY);
		this.startNode = cache.getInitializedNode(
			this.startPos,
			this.sizeIndex,
			this.levelIndex,
			this.tokenData,
		);
		this.nextNodes.pushWithPriority({
			node: this.startNode,
			cost: this.startCost,
			estimated: this.startCost + this.estimateCost(this.startPos, this.targetPos),
			previous: null,
		});
	}

	step() {
		const currentNode = this.nextNodes.pop();
		if (!currentNode) {
			return null;
		}
		if (currentNode.cost > this.maxDistance) {
			return null;
		}
		if (currentNode.node.x === this.targetPos.x && currentNode.node.y === this.targetPos.y) {
			return currentNode;
		}
		this.previousNodes.add(nodeId(currentNode.node));
		const tokenArea = getAreaFromPositionAndShape(currentNode.node, this.tokenShape);
		for (const neighbor of currentNode.node.neighbors) {
			const neighborNode = cache.getInitializedNode(
				neighbor,
				this.sizeIndex,
				this.levelIndex,
				this.tokenData,
			);
			if (this.previousNodes.has(nodeId(neighborNode))) {
				continue;
			}
			// PATCHED (adm): skip a cell held by an enemy in combat (to move through it, use Alt).
			if (this.admBlockers && this.admBlocked(neighborNode)) {
				continue;
			}
			let cost;
			if (window.terrainRuler && !this.ignoreTerrain) {
				const offset = buildOffset(currentNode.node, neighbor);
				cost = this.terrainCostForStep(tokenArea, offset, currentNode.cost);
			} else {
				// Count 5-10-5 diagonals as 1.5 (so two add up to 3) and 5-5-5 diagonals as 1.0001 (to discourage unnecessary diagonals)
				cost = neighbor.isDiagonal ? (this.use5105 ? 1.5 : 1.0001) : 1;
			}

			cost += currentNode.cost;
			this.nextNodes.pushWithPriority({
				node: neighborNode,
				cost: cost,
				estimated: cost + this.estimateCost(neighborNode, this.targetPos),
				previous: currentNode,
			});
		}
		return undefined;
	}

	terrainCostForStep(tokenArea, offset, previousDistance = 0) {
		let distance = 0;
		for (const srcCell of tokenArea) {
			const dstCell = applyOffset(srcCell, offset);
			// TODO Cache the result of source->destination measurements to speed up the pathfinding for large tokens
			const ray = new Ray(
				getCenterFromGridPositionObj(srcCell),
				getCenterFromGridPositionObj(dstCell),
			);
			const options = {};
			let halfStep = previousDistance % 1;
			if (halfStep > 0.25 && halfStep < 0.75) {
				options.terrainRulerInitialState = {noDiagonals: 1};
			}
			let measured = terrainRuler.measureDistances([{ray}], {token: this.token})[0];
			// TODO Maybe terrain ruler could just return the distance in cells in the first place
			measured = Math.round(measured / canvas.dimensions.distance);
			if (ray.terrainRulerFinalState?.noDiagonals === 1) {
				measured += 0.5;
			}
			distance = Math.max(distance, measured);
		}
		return distance;
	}

	postProcessResult(firstNode) {
		const path = [];
		const cost = Math.floor(firstNode.cost) * canvas.dimensions.distance;
		let currentNode = firstNode;
		while (currentNode) {
			if (this.interpolate) {
				if (
					path.length >= 2 &&
					this.flatBetween(path[path.length - 2], currentNode.node) &&
					!stepCollidesWithWall(path[path.length - 2], currentNode.node, this.tokenData) &&
					!this.admLineBlocked(path[path.length - 2], currentNode.node)
				) {
					// Replace last waypoint if the current waypoint leads to a valid path that isn't longer than the old path
					if (window.terrainRuler) {
						const startNode = path[path.length - 2];
						const middleNode = path[path.length - 1];
						const endNode = currentNode.node;

						const startArea = getAreaFromPositionAndShape(startNode, this.tokenShape);
						const startMiddleOffset = {
							x: middleNode.x - startNode.x,
							y: middleNode.y - startNode.y,
						};
						const startEndOffset = buildOffset(startNode, endNode);
						const middleArea = getAreaFromPositionAndShape(middleNode, this.tokenShape);
						const middleEndOffset = buildOffset(middleNode, endNode);

						// TODO Cache the measurement for use in the next loop to improve performance - this can possibly be done withing terrainCostForStep
						const middleDistance = this.terrainCostForStep(startArea, startMiddleOffset);
						const oldDistance =
							middleDistance + this.terrainCostForStep(middleArea, middleEndOffset, middleDistance);
						const newDistance = this.terrainCostForStep(startArea, startEndOffset);

						if (newDistance <= oldDistance) {
							path.pop();
						}
					} else {
						path.pop();
					}
				}
			}

			path.push({x: currentNode.node.x, y: currentNode.node.y});
			currentNode = currentNode.previous;
		}
		path.reverse();
		return {path, cost};
	}

	/** PATCHED (adm): the token's floor in a cell — in terrain mode the cell's own floor, otherwise the token's own
	 *  elevation (tokenData.elevation can be eye height: routinglib takes losHeight when the wall-height setting
	 *  "vision blocks movement" is on). */
	admFloorAt(pos) {
		return this.tokenData.terrain ? stepSpan(pos, this.tokenData).b : (Number(this.token?.document?.elevation) || 0);
	}

	/** PATCHED (adm): the token's shape at cell pos touches an enemy in combat on its own floor. */
	admBlocked(pos) {
		const td = this.tokenData;
		return admBlockedAt(this.admBlockers, pos, td.width || 1, td.height || 1, this.admFloorAt(pos));
	}

	/**
	 * PATCHED (adm): do not straighten the path through an enemy: the cell path goes around it, but a straight line
	 * between distant points could pass right through. The token's shape is moved along the line in 1/8-cell steps.
	 * "Through" means the shape enters the enemy's cells by more than half a cell on BOTH axes; less is corner-cutting,
	 * like an ordinary diagonal step past an enemy (the search allows such a step). One floor for the whole line —
	 * straightening only happens on level ground anyway (flatBetween).
	 */
	admLineBlocked(a, b) {
		if (!this.admBlockers) return false;
		const td = this.tokenData;
		const w = td.width || 1;
		const h = td.height || 1;
		const z = this.admFloorAt(a);
		const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 8;
		for (let k = 1; k < n; k++) {
			const r = a.x + ((b.x - a.x) * k) / n;
			const c = a.y + ((b.y - a.y) * k) / n;
			for (const q of this.admBlockers.rects) {
				if (Math.abs(q.z - z) >= 1) continue;
				const rows = Math.min(r + h, q.r1 + 1) - Math.max(r, q.r0);
				const cols = Math.min(c + w, q.c1 + 1) - Math.max(c, q.c0);
				if ((rows > 0.5) && (cols > 0.5)) return true;
			}
		}
		return false;
	}

	/**
	 * PATCHED (adm): in terrain mode the route may be straightened only over level ground.
	 * A wall on the straight line is checked at the height of ONE point: from a plateau (15) a line
	 * to the ground would pass through a 0–15 wall and drop the stairs from the route.
	 */
	flatBetween(a, b) {
		if (!this.tokenData.terrain) return true;
		const h0 = stepSpan(a, this.tokenData).b;
		const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
		for (let k = 1; k <= steps; k++) {
			const p = {
				x: Math.round(a.x + ((b.x - a.x) * k) / steps),
				y: Math.round(a.y + ((b.y - a.y) * k) / steps),
			};
			if (stepSpan(p, this.tokenData).b !== h0) return false;
		}
		return true;
	}

	/**
	 * Estimate the travel distance between two points, as the crow flies. Most of the time, this is 1
	 * per space, but for a square grid using 5-10-5 diagonals, count each diagonal as an extra 0.5
	 */
	estimateCost(pos, target) {
		const distX = Math.abs(pos.x - target.x);
		const distY = Math.abs(pos.y - target.y);
		return Math.max(distX, distY) + (this.use5105 ? Math.min(distX, distY) * 0.5 : 0);
	}

	free() {
		// The gridded pathfinder is 100% Javascript, so we don't need to do anything
	}
}

/**
 * PATCHED (adm): heap for the per-floor search. Order: ascending f; on equal f — closer to the goal (smaller h); if
 * still equal — newer. PriorityQueueSet is a list with O(n) insertion: with thousands of nodes the per-floor search
 * drowned in it, and on equal f without the "closer to the goal" rule A* expanded the whole band of equal-cost paths
 * (24.09.2026).
 */
class AdmEntryHeap {
	constructor() {
		this.items = [];
	}

	static before(a, b) {
		if (a.f !== b.f) return a.f < b.f;
		if (a.h !== b.h) return a.h < b.h;
		return a.seq > b.seq;
	}

	push(entry) {
		const items = this.items;
		items.push(entry);
		let i = items.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (!AdmEntryHeap.before(items[i], items[p])) break;
			const t = items[i];
			items[i] = items[p];
			items[p] = t;
			i = p;
		}
	}

	pop() {
		const items = this.items;
		if (!items.length) return undefined;
		const top = items[0];
		const last = items.pop();
		if (items.length) {
			items[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < items.length && AdmEntryHeap.before(items[l], items[m])) m = l;
				if (r < items.length && AdmEntryHeap.before(items[r], items[m])) m = r;
				if (m === i) break;
				const t = items[i];
				items[i] = items[m];
				items[m] = t;
				i = m;
			}
		}
		return top;
	}
}

/** PATCHED (adm): limit on nodes expanded by the per-floor search — a safeguard against a search lasting seconds. */
const ADM_LAYERED_BUDGET = 12000;

/**
 * PATCHED (adm): PER-FLOOR SEARCH (square grid, terrain mode).
 *
 * The terrain-mode graph is flat: a cell has one height — from the floor the token stands on. Where floors lie one
 * above another (hold −15, deck 0, stern top 15) it mixed them up: a step was checked against walls only at the
 * height of the source cell, and a route to the stern (15) went down the stairs into the hold and through a wall at
 * deck level (24.09.2026).
 * Here a node is cell + floor. The floor of the next cell is computed by adm-levels exactly as the height magnet will
 * set it during a real move (__admStepFloor); walls are checked the same way the core will check them: a height span
 * from the floor the step starts on up to the top of the token above it. The goal is the floor the viewer sees at the
 * point (__admGoalFloor); if it cannot be reached — any floor in that cell.
 * Same interface as GriddedPathfinder: step() → undefined (still searching) | null (no path) | node;
 * postProcessResult.
 *
 * Performance (24.09.2026, "pathfinding is really painful, the scene lags"):
 * - a step is checked LAZILY — when the entry is popped from the heap, not when the parent is expanded for all 8
 *   neighbours: neighbours on the search frontier (most of them) are never checked. The step cost is known in
 *   advance, so the path stays the shortest;
 * - one pass instead of two: while searching for the intended floor, the first destination cell met on any floor is
 *   the shortest of all (A* pops in ascending f, and h = 0 at the goal); if the intended floor is not reached within
 *   its limit — that cell right away, without a second search from scratch;
 * - limit on expanded nodes ADM_LAYERED_BUDGET.
 */
export class LayeredPathfinder {
	constructor(from, to, token, tokenData, options, goal = undefined) {
		this.startPos = from;
		this.targetPos = to;
		this.token = token;
		this.tokenData = tokenData;
		this.maxDistance = options.maxDistance ?? Infinity;
		this.maxDistance = Math.round(this.maxDistance / canvas.scene.dimensions.distance);
		this.use5105 = game.system.id === "pf2e" || canvas.grid.diagonalRule === "5105";
		if (goal === undefined) {
			const c = this.center(to);
			try { goal = globalThis.__admGoalFloor?.(c.x, c.y, tokenData.elevation) ?? null; } catch (e) { goal = null; }
		}
		// The intended floor first; if not reached within a reasonable path — any floor in the destination cell.
		this.goalZ = goal;
		this.profile = (tokenData.width || 1) + "x" + (tokenData.height || 1) + "|" + (tokenData.losDiff ?? 0);
		this.admBlockers = options.admBlockers ?? null; // PATCHED (adm): enemies in combat (admBlockedAt)
		this.reset();
	}

	reset() {
		this.heap = new AdmEntryHeap();
		this.closed = new Set();
		this.seq = 0;
		this.expanded = 0;
		this.anyHit = null;
		this.goalPhase = this.goalZ != null;
		// Step memo — shared by all searches with the same token size and height; taken from the cache again after
		// the cache is reset (walls, doors, regions).
		let memo = cache.layeredMemo.get(this.profile);
		if (!memo) {
			memo = new Map();
			cache.layeredMemo.set(this.profile, memo);
		}
		this.memo = memo;
		// Detours only within reason: otherwise an unreachable cell would search the whole scene on every floor and the
		// ruler would hang (24.09.2026: "calculation lag"). Intended floor — 3× the straight line, any floor — 4×.
		const direct = this.estimateCost(this.startPos, this.targetPos);
		this.limitGoal = Math.min(this.maxDistance, Math.max(20, direct * 3));
		this.limitAny = Math.min(this.maxDistance, Math.max(30, direct * 4));
		this.heap.push({
			x: this.startPos.x, y: this.startPos.y, z: Number(this.tokenData.elevation) || 0, parent: null,
			g: 0, h: direct, f: direct, seq: this.seq++,
		});
	}

	/** Numeric key of a "cell + floor" node: cell index × 2^24 + floor in hundredths of a foot (±83,886 ft). */
	keyOf(x, y, z) {
		const zi = Math.max(0, Math.min(16777215, Math.round(z * 100) + 8388608));
		return (x * cache.gridHeight + y) * 16777216 + zi;
	}

	/** Center of the token's shape at a cell (x is the row, y is the column, as everywhere in routinglib). */
	center(pos) {
		const tl = getPixelsFromGridPositionObj(pos);
		return {
			x: tl.x + (this.tokenData.width || 1) * canvas.grid.sizeX / 2,
			y: tl.y + (this.tokenData.height || 1) * canvas.grid.sizeY / 2,
		};
	}

	/** Floor in the neighbouring cell after a step from floor `from.z`, or null if the step is impossible. */
	stepTo(from, nx, ny) {
		const mk = from.key * 9 + (nx - from.x + 1) * 3 + (ny - from.y + 1);
		const memo = this.memo;
		if (memo.has(mk)) return memo.get(mk);
		const td = this.tokenData;
		let result = null;
		try {
			const a = this.center(from);
			const b = this.center({x: nx, y: ny});
			const nz = Number(globalThis.__admStepFloor(a.x, a.y, b.x, b.y, from.z));
			if (Number.isFinite(nz) && !globalThis.__admRampStepBlocked?.(a.x, a.y, b.x, b.y, from.z, nz)) {
				// Height span — as the core uses in a real move: the floor the step starts FROM, plus token height
				// (wall-height + adm-levels move-wall-elevation). ⚠️ Not "up to the top on the upper floor": wall-height
				// blocks with a wall only if the span lies ENTIRELY within its height, and a tall span gets past the wall.
				// Lilith (height 6.7) went up stairs from 5 to 10 and "passed" a slanted 0–15 wall through the cell
				// center, but the core stopped her — the token got stuck in the wall (24.09.2026).
				const span = {b: from.z, t: from.z + (td.losDiff ?? 0)};
				if (!stepCollidesWithWall(from, {x: nx, y: ny}, td, false, span)) result = nz;
			}
		} catch (e) { result = null; }
		memo.set(mk, result);
		return result;
	}

	step() {
		const entry = this.heap.pop();
		if (!entry) return this.anyHit ?? null;
		// The intended floor was not reached within its limit: the destination cell on any floor — the first one met
		// (it is the shortest), otherwise keep searching for any floor.
		if (this.goalPhase && entry.f > this.limitGoal) {
			if (this.anyHit) return this.anyHit;
			this.goalPhase = false;
		}
		if (entry.f > this.limitAny) return this.anyHit ?? null;
		let z = entry.z;
		if (entry.parent) {
			z = this.stepTo(entry.parent, entry.x, entry.y);
			if (z === null) return undefined;
		}
		const key = this.keyOf(entry.x, entry.y, z);
		if (this.closed.has(key)) return undefined;
		this.closed.add(key);
		// PATCHED (adm): an enemy in combat on this floor — the cell is closed. Not in the step memo (stepTo): that one is
		// shared by all searches.
		if (entry.parent && this.admBlockers
			&& admBlockedAt(this.admBlockers, entry, this.tokenData.width || 1, this.tokenData.height || 1, z)) {
			return undefined;
		}
		const node = {x: entry.x, y: entry.y, z, key, cost: entry.g, previous: entry.parent};
		if (node.x === this.targetPos.x && node.y === this.targetPos.y) {
			if (!this.goalPhase || Math.abs(z - this.goalZ) < 0.5) return node;
			this.anyHit ??= node;
		}
		if (++this.expanded > ADM_LAYERED_BUDGET) return this.anyHit ?? null;
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				if (!dx && !dy) continue;
				const nx = node.x + dx;
				const ny = node.y + dy;
				if (nx < 0 || ny < 0 || nx >= cache.gridWidth || ny >= cache.gridHeight) continue;
				const g = node.cost + ((dx && dy) ? (this.use5105 ? 1.5 : 1.0001) : 1);
				const h = this.estimateCost({x: nx, y: ny}, this.targetPos);
				this.heap.push({x: nx, y: ny, z: 0, parent: node, g, h, f: g + h, seq: this.seq++});
			}
		}
		return undefined;
	}

	/** Path without extra points: straight segments on one floor are merged (corners are not cut — walls are already
	 *  checked). */
	postProcessResult(last) {
		const nodes = [];
		for (let n = last; n; n = n.previous) nodes.push(n);
		nodes.reverse();
		const path = [];
		for (const n of nodes) {
			const k = path.length;
			if (k >= 2) {
				const p0 = path[k - 2];
				const p1 = path[k - 1];
				const same = (Math.sign(p1.x - p0.x) === Math.sign(n.x - p1.x))
					&& (Math.sign(p1.y - p0.y) === Math.sign(n.y - p1.y))
					&& (p0.z === p1.z) && (p1.z === n.z);
				if (same) {
					path[k - 1] = {x: n.x, y: n.y, z: n.z};
					continue;
				}
			}
			path.push({x: n.x, y: n.y, z: n.z});
		}
		const cost = Math.floor(last.cost) * canvas.dimensions.distance;
		return {path: path.map(p => ({x: p.x, y: p.y})), cost};
	}

	estimateCost(pos, target) {
		const distX = Math.abs(pos.x - target.x);
		const distY = Math.abs(pos.y - target.y);
		return Math.max(distX, distY) + (this.use5105 ? Math.min(distX, distY) * 0.5 : 0);
	}

	free() {}
}

/** PATCHED (adm): marker "result taken from the remembered ones" (HybridPathfinder.step → postProcessResult). */
const ADM_CACHED_RESULT = {admCachedResult: true};

/** PATCHED (adm): center of the token's shape at a cell (x is the row, y is the column). */
function admCenterOf(pos, tokenData) {
	const tl = getPixelsFromGridPositionObj(pos);
	return {
		x: tl.x + (tokenData.width || 1) * canvas.grid.sizeX / 2,
		y: tl.y + (tokenData.height || 1) * canvas.grid.sizeY / 2,
	};
}

/**
 * PATCHED (adm): HYBRID. First the regular search (fast, graph is cached). Its path is run through the height magnet
 * (__admStepFloor point by point, like a real move) — if it ends on the goal floor (__admGoalFloor) or there is no
 * goal, take it. Otherwise search per floor (LayeredPathfinder). Ordinary moves are not slowed down, and where the flat
 * graph mixes up floors — from the hold stairs to the deck, to the stern top — the path is searched per floor
 * (24.09.2026).
 */
export class HybridPathfinder {
	constructor(flat, from, to, token, tokenData, options) {
		this.flat = flat;
		this.args = [from, to, token, tokenData, options];
		this.tokenData = tokenData;
		let goal = null;
		try {
			const c = admCenterOf(to, tokenData);
			// Start elevation — the goal is chosen among the floors of the level the token stands on (adm-levels
			// __admGoalFloor).
			goal = globalThis.__admGoalFloor?.(c.x, c.y, tokenData.elevation) ?? null;
		} catch (e) { goal = null; }
		this.goal = goal;
		// The search result is remembered until the cache is reset: while dragging, the core searches again on every cell
		// under the cursor, and moving back and forth over the same cells repeats the same searches (24.09.2026). The
		// key holds everything the result depends on.
		// PATCHED (adm): including the placement of enemies in combat — an enemy moved, the path is different.
		this.resultKey = [from.x, from.y, to.x, to.y, tokenData.width || 1, tokenData.height || 1,
			tokenData.elevation ?? 0, tokenData.losDiff ?? 0, goal, options.maxDistance ?? "", options.interpolate ?? "",
			options.admBlockers?.key ?? ""].join("|");
		this.layered = null;
		this.accepted = null;
		this.cached = cache.hybridResults.get(this.resultKey);
	}

	reset() {
		this.flat.reset();
		this.layered = null;
		this.accepted = null;
		this.cached = cache.hybridResults.get(this.resultKey);
	}

	/** Remember the result (a copy: callers may modify theirs). null means no path. */
	remember(result) {
		const store = cache.hybridResults;
		if (store.size > 4000) store.clear();
		store.set(this.resultKey, result && {path: result.path.map(p => ({x: p.x, y: p.y})), cost: result.cost});
	}

	/** Where the path will actually end: heights point by point, as the magnet will set them. */
	endsOnGoal(path) {
		if (this.goal == null) return true;
		let z = Number(this.tokenData.elevation) || 0;
		// Segments of neighbouring paths repeat (same start, goal moved by one cell) — their floors are remembered.
		const memo = cache.segFloorMemo;
		for (let k = 1; k < path.length; k++) {
			const a = admCenterOf(path[k - 1], this.tokenData);
			const b = admCenterOf(path[k], this.tokenData);
			const mk = a.x + "," + a.y + ">" + b.x + "," + b.y + "@" + z;
			let nz = memo.get(mk);
			if (nz === undefined) {
				nz = Number(globalThis.__admStepFloor(a.x, a.y, b.x, b.y, z));
				if (memo.size > 20000) memo.clear();
				memo.set(mk, nz);
			}
			z = nz;
			if (!Number.isFinite(z)) return false;
		}
		return Math.abs(z - this.goal) < 0.5;
	}

	step() {
		if (this.cached !== undefined) return (this.cached === null) ? null : ADM_CACHED_RESULT;
		if (!this.layered) {
			const r = this.flat.step();
			if (r === undefined) return undefined;
			if (r !== null) {
				let processed = null;
				try { processed = this.flat.postProcessResult(r); } catch (e) { processed = null; }
				let ok = false;
				try { ok = !!processed && this.endsOnGoal(processed.path); } catch (e) { ok = false; }
				if (ok) {
					this.accepted = processed;
					this.remember(processed);
					return r;
				}
			}
			this.layered = new LayeredPathfinder(...this.args, this.goal);
			return undefined;
		}
		const r = this.layered.step();
		if (r === null) this.remember(null);
		return r;
	}

	postProcessResult(r) {
		if (r === ADM_CACHED_RESULT) {
			return {path: this.cached.path.map(p => ({x: p.x, y: p.y})), cost: this.cached.cost};
		}
		if (this.accepted) return this.accepted;
		const out = this.layered.postProcessResult(r);
		this.remember(out);
		return out;
	}

	free() {
		this.flat.free?.();
	}
}

export class GridlessPathfinder {
	constructor(graph, from, to, options) {
		const maxDistance = options.maxDistance ?? Infinity;
		this.pathfinder = GridlessPathfinding.initializePathfinder(from, to, graph, maxDistance);
	}

	reset() {
		GridlessPathfinding.resetPathfinder();
	}

	step() {
		return GridlessPathfinding.step(this.pathfinder);
	}

	postProcessResult(result) {
		// The rust code already does everything that's necessary, so just return the result
		return result;
	}

	free() {
		GridlessPathfinding.dropPathfinder(this.pathfinder);
	}
}
