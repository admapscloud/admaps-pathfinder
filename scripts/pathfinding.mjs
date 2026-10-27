import { MODULE_ID, cfg } from "./settings.mjs";
import { wrap } from "./wrap.mjs";

/**
 * Path search around walls for a dragged token: A* by routinglib (the module's own patched copy in lib/routinglib) in
 * place of core's straight line. Ported from the adm-daggerheart system
 * (scripts/pathfinding.mjs), with everything system-specific left to the system: what it needs it registers through
 * the API (`registerGhost`, `registerSkip`).
 */

const TOKEN = "foundry.canvas.placeables.Token.prototype";

/* -------------------------------------------- */
/*  Ghosts and service moves                    */
/* -------------------------------------------- */

const ghostTests = [];
const skipTests = [];

/**
 * A ghost moves straight through walls: no path search, no footprint check, no turning. A token is one by its flag
 * (`flags.admaps-pathfinder.ghost`) or by a test a system registers (adm-daggerheart: its scenery actors).
 * @param {(doc: TokenDocument) => boolean} test
 */
export function registerGhost(test) {
	if (typeof test === "function") ghostTests.push(test);
}

/**
 * A service move — the system shifting a token for its own reasons, not the token walking: no footprint check, no
 * turning (adm-daggerheart: settling a token that grew back inside the map).
 * @param {(doc: TokenDocument, options: object) => boolean} test
 */
export function registerSkip(test) {
	if (typeof test === "function") skipTests.push(test);
}

const passes = (tests, ...args) => tests.some((test) => {
	try {
		return test(...args) === true;
	} catch (err) {
		console.warn(`${MODULE_ID} |`, err);
		return false;
	}
});

/** @param {TokenDocument} doc */
export function isGhost(doc) {
	if (!doc) return false;
	return (doc.flags?.[MODULE_ID]?.ghost === true) || passes(ghostTests, doc);
}

/** @param {TokenDocument} doc @param {object} options  the update's options */
export function isSkipped(doc, options) {
	return passes(skipTests, doc, options ?? {});
}

/* -------------------------------------------- */
/*  Alt: through walls                          */
/* -------------------------------------------- */

/** Whether Alt lets this user's tokens through walls — the world's choice. */
function altAllowed() {
	return (cfg.altBypass === "all") || ((cfg.altBypass === "gm") && !!game.user?.isGM);
}

/** Alt held where the world allows it. The full class path: the global KeyboardManager is deprecated in v13, and every
 *  touch of it builds a stack trace for the warning — this runs on every drag step. */
function altBypass() {
	return altAllowed()
		&& !!game.keyboard?.isModifierActive(foundry.helpers.interaction.KeyboardManager.MODIFIER_KEYS.ALT);
}

/** Whether moves are unconstrained right now: Alt (as above), or the GM's own "Unconstrained Movement" switch. */
export function isBypass() {
	return altBypass() || !!(game.user?.isGM && game.settings.get("core", "unconstrainedMovement"));
}

/* -------------------------------------------- */
/*  Enemies in a fight                          */
/* -------------------------------------------- */

/**
 * The cells a player's token walks around in a started fight on this scene: hostile tokens this client sees, not
 * defeated — the hidden and the invisible do not give themselves away by the detour. Players pass through each other,
 * enemies move as before. Square grid only. Height is compared by routinglib (the floor under the token in the cell);
 * through an enemy — Alt.
 * @returns {{key: string, rects: {r0: number, r1: number, c0: number, c1: number, z: number}[]}|null}
 *   rows and columns inclusive
 */
function enemyBlockers(token) {
	if (!cfg.avoidEnemies) return null;
	const combat = game.combat;
	if (!combat?.started) return null;
	if (combat.scene && (combat.scene.id !== canvas.scene?.id)) return null;
	if (!token?.actor?.hasPlayerOwner) return null;
	if (!canvas.grid.isSquare) return null;
	const HOSTILE = CONST.TOKEN_DISPOSITIONS.HOSTILE;
	const DEFEATED = CONFIG.specialStatusEffects?.DEFEATED;
	const { sizeX, sizeY } = canvas.grid;
	const rects = [];
	for (const t of canvas.tokens?.placeables ?? []) {
		const d = t.document;
		if (!d || (d.id === token.document.id) || d.hidden || !t.visible) continue;
		if (d.disposition !== HOSTILE) continue;
		if (t.combatant?.isDefeated || (DEFEATED && t.actor?.statuses?.has?.(DEFEATED))) continue;
		// The figure's cells, corner to corner, a pixel inside — a token off the grid too.
		const a = canvas.grid.getOffset({ x: d.x + 1, y: d.y + 1 });
		const b = canvas.grid.getOffset({ x: d.x + (d.width * sizeX) - 1, y: d.y + (d.height * sizeY) - 1 });
		rects.push({ r0: a.i, r1: b.i, c0: a.j, c1: b.j, z: Number(d.elevation) || 0 });
	}
	if (!rects.length) return null;
	return { rects, key: rects.map((r) => `${r.r0},${r.c0},${r.r1},${r.c1},${r.z}`).sort().join(";") };
}

/* -------------------------------------------- */
/*  Large tokens: no wall inside the figure     */
/* -------------------------------------------- */

let probe = null;

/**
 * One stand-in vision source for every wall probe. wall-height reads the token's height span from `source.object`,
 * and without an object skips its filter — the wall then blocks at any height. The span goes on the probe's start
 * point too: wall-height overwrites `object.b/t` with the point's.
 */
function probeFor(span) {
	probe ??= new foundry.canvas.sources.PointVisionSource({});
	probe.object = { b: span.b, t: span.t };
	return probe;
}

/**
 * The token's height span at `elevation` (by default where it stands — the source's, not the animated document's):
 * its feet there, its own height above them. The height is wall-height's losHeight over the document's elevation;
 * both move together while the token animates.
 */
function spanAt(doc, elevation = null) {
	const animated = Number(doc.elevation ?? 0) || 0;
	const b = Number(elevation ?? doc._source?.elevation ?? animated) || 0;
	const height = Math.max(0, (Number(doc.object?.losHeight ?? animated) || 0) - animated);
	return { b, t: b + height };
}

/**
 * Whether a wall runs between two cells of the figure standing at top-left (x, y): every pair of neighbouring cells —
 * across, down and both diagonals. Square grid.
 */
function wallInsideFootprint(x, y, width, height, span) {
	const { i: row, j: col } = canvas.grid.getOffset({ x, y });
	const options = { mode: "any", type: "move", source: probeFor(span) };
	const backend = CONFIG.Canvas.polygonBackends.move;
	const center = (i, j) => canvas.grid.getCenterPoint({ i, j });
	const hit = (a, b) => backend.testCollision({ ...a, b: span.b, t: span.t }, b, options);
	for (let dr = 0; dr < height; dr++) {
		for (let dc = 0; dc < width; dc++) {
			const c = center(row + dr, col + dc);
			if ((dc + 1 < width) && hit(c, center(row + dr, col + dc + 1))) return true;
			if ((dr + 1 < height) && hit(c, center(row + dr + 1, col + dc))) return true;
			if ((dc + 1 < width) && (dr + 1 < height) && hit(c, center(row + dr + 1, col + dc + 1))) return true;
			if ((dc > 0) && (dr + 1 < height) && hit(c, center(row + dr + 1, col + dc - 1))) return true;
		}
	}
	return false;
}

/**
 * The last cell along the straight line from start to end (top-left pixels) where the figure holds no wall, as its
 * top-left point; null if even the first step does.
 */
function lastValidAlongLine(startX, startY, endX, endY, width, height, span) {
	const s = canvas.grid.getOffset({ x: startX, y: startY });
	const e = canvas.grid.getOffset({ x: endX, y: endY });
	const di = e.i - s.i;
	const dj = e.j - s.j;
	const steps = Math.max(Math.abs(di), Math.abs(dj));
	let last = null;
	for (let k = 1; k <= steps; k++) {
		const i = s.i + Math.round((di * k) / steps);
		const j = s.j + Math.round((dj * k) / steps);
		const { x, y } = canvas.grid.getTopLeftPoint({ i, j });
		if (wallInsideFootprint(x, y, width, height, span)) break;
		last = { x, y };
	}
	return last;
}

/**
 * Whether the token may not stand at top-left (x, y) — a wall would run inside its figure. For pickers that place a
 * token (a teleport, a push), to refuse the cell beforehand. Never for 1×1 tokens, ghosts, while moves are
 * unconstrained, or off a square grid; nor when the token already stands clipped (a wall appeared under it).
 * @param {TokenDocument} doc
 * @param {number} x
 * @param {number} y
 * @param {number|null} [elevation]  the height there (null — its own)
 * @returns {boolean}
 */
export function footprintBlockedAt(doc, x, y, elevation = null) {
	if (!doc || !canvas?.ready || (doc.parent !== canvas.scene)) return false;
	if (!canvas.grid.isSquare || isGhost(doc) || isBypass()) return false;
	// Where it stands, not where its animation is.
	const at = doc._source ?? doc;
	const { width, height } = at;
	if ((width <= 1) && (height <= 1)) return false;
	const span = spanAt(doc, elevation);
	if (!wallInsideFootprint(x, y, width, height, span)) return false;
	return !wallInsideFootprint(at.x, at.y, width, height, span);
}

/**
 * A move that would end with a wall inside a large token's figure does not happen. Drags never get here — the search
 * stops them short already; this catches the keyboard and the API.
 */
function onPreMove(doc, move, options) {
	if (!cfg.pathfinding) return;
	if (["undo", "paste", "config"].includes(move.method) || isSkipped(doc, options)) return;
	const { x, y, elevation } = move.destination;
	if (!footprintBlockedAt(doc, x, y, elevation)) return;
	ui.notifications.warn("ADMAPS_PF.Notify.Clipped", { localize: true });
	return false;
}

/* -------------------------------------------- */
/*  The search                                  */
/* -------------------------------------------- */

/** The module's own call for core's path as it is (the fallback): the search must not start again. */
const CORE_PATH = `${MODULE_ID}.corePath`;

/** Where the search goes: the module's own copy of routinglib (main.mjs hands it over once it is up). */
let routingSource = () => globalThis.routinglib ?? null;

/** @param {() => object|null} source  routinglib's API, or null while it is not up yet */
export function useRouting(source) {
	if (typeof source === "function") routingSource = source;
}

/**
 * Token#findMovementPath: each leg between the drag's waypoints goes to routinglib, the cells it returns become the
 * path, and core lays its terrain and costs over it with walls switched off (they are walked around already).
 * No path on any leg — no move at all. Alt / unconstrained / a hex or gridless scene / a ghost — core's own path.
 *
 * ⚠️ `wrapped` is called only before this wrapper returns: libWrapper invalidates it then ("is no longer valid, and
 * must not be called"), and the search ends later, after routinglib's await. There core is asked anew through the
 * token itself — with walls off (or CORE_PATH) the call comes straight back here and goes to `wrapped` at once.
 */
function findMovementPath(wrapped, waypoints, options = {}) {
	if (options[CORE_PATH]) {
		const { [CORE_PATH]: _, ...rest } = options;
		return wrapped(waypoints, rest);
	}
	const routing = routingSource();
	// Square grids only: a waypoint is the token's top-left corner, which on a hex grid lies in the neighbouring cell.
	if (!cfg.pathfinding || !routing || options.ignoreWalls || !canvas.grid.isSquare || (waypoints.length < 2)
		|| isGhost(this.document)) return wrapped(waypoints, options);

	const token = this;
	const source = token.document._source;
	const blockers = enemyBlockers(token);
	let cancelled = false;
	let running = null;

	const promise = (async () => {
		try {
			const path = [];
			let found = true;
			for (let k = 0; k < waypoints.length - 1; k++) {
				if (cancelled) return null;
				const from = waypoints[k];
				const to = waypoints[k + 1];
				// A leg starts where the last one ended — a large token's end may have been pulled short of a wall.
				const at = path.at(-1);
				const fromX = ((k > 0) && at) ? at.x : (from.x ?? source.x);
				const fromY = ((k > 0) && at) ? at.y : (from.y ?? source.y);
				let toX = to.x ?? fromX;
				let toY = to.y ?? fromY;

				// A large token stops at the last cell along the line where no wall runs inside its figure.
				const { width, height } = source;
				if (canvas.grid.isSquare && ((width > 1) || (height > 1))) {
					const span = spanAt(token.document);
					if (wallInsideFootprint(toX, toY, width, height, span)) {
						const last = lastValidAlongLine(fromX, fromY, toX, toY, width, height, span);
						if (!last) {
							found = false;
							break;
						}
						toX = last.x;
						toY = last.y;
					}
				}

				const a = canvas.grid.getOffset({ x: fromX, y: fromY });
				const b = canvas.grid.getOffset({ x: toX, y: toY });
				if ((a.i === b.i) && (a.j === b.j)) {
					if (k === 0) path.push({ ...from, x: fromX, y: fromY });
					path.push({ ...to, x: toX, y: toY });
					continue;
				}

				running = routing.calculatePath({ x: a.i, y: a.j }, { x: b.i, y: b.j },
					blockers ? { token, admBlockers: blockers } : { token });
				const result = await running;
				running = null;
				if (cancelled) return null;
				if (!(result?.path?.length >= 2)) {
					found = false;
					break;
				}

				const cells = result.path;
				for (let p = 0; p < cells.length; p++) {
					const { x, y } = canvas.grid.getTopLeftPoint({ i: cells[p].x, j: cells[p].y });
					if (p === 0) {
						if (k === 0) path.push({ ...from, x, y, snapped: true });
					} else if (p === cells.length - 1) {
						path.push({ ...to, x, y, snapped: true });
					} else {
						path.push({
							x, y,
							elevation: from.elevation ?? source.elevation,
							width: from.width,
							height: from.height,
							shape: from.shape,
							action: to.action,
							snapped: true,
							explicit: false,
							checkpoint: false,
						});
					}
				}
			}
			if (cancelled) return null;

			// No path on some leg — no move: only the start. Core draws the unreachable part dashed and does not move
			// the token. A straight line here went through walls and railings, and a height magnet then set the token
			// on another flight or floor.
			if (!found) {
				const o = waypoints[0] ?? {};
				return [{ ...o, x: o.x ?? source.x, y: o.y ?? source.y, elevation: o.elevation ?? source.elevation }];
			}
			if (!path.length) return null;

			const inner = token.findMovementPath(path, { ...options, ignoreWalls: true });
			const result = inner.result ?? await inner.promise;

			// Every point at the token's own height: core would otherwise draw two paths, along the ground and up.
			// adm-levels' height magnet relies on it. The height of the source, not of the document: while the token
			// still walks, core writes the animated in-between values into the document.
			const elevation = source.elevation ?? 0;
			return result?.map((w) => (((w.elevation ?? 0) === elevation) ? w : { ...w, elevation })) ?? result;
		} catch (err) {
			console.warn(`${MODULE_ID} | path search failed, core's path is used`, err);
			try {
				const fallback = token.findMovementPath(waypoints, { ...options, [CORE_PATH]: true });
				return fallback.result ?? await fallback.promise;
			} catch (err2) {
				// Core failed too: no move rather than a ruler searching forever.
				console.warn(`${MODULE_ID} |`, err2);
				const o = waypoints[0] ?? {};
				return [{ ...o, x: o.x ?? source.x, y: o.y ?? source.y, elevation: o.elevation ?? source.elevation }];
			}
		}
	})();

	return {
		result: undefined,
		promise,
		cancel() {
			cancelled = true;
			if (running) routing.cancelPathfinding(running);
		},
	};
}

/** Alt (where allowed) and ghosts: the drag is unconstrained — for the search and for the drop alike. */
function dragConstrainOptions(wrapped, ...args) {
	const options = wrapped(...args);
	if (isGhost(this.document) || altBypass()) {
		options.ignoreWalls = true;
		options.ignoreCost = true;
	}
	return options;
}

/** The dragged token's ghost copy neither sees nor clears the fog before the token really moves. */
function visionSourceData(wrapped, ...args) {
	const data = wrapped(...args);
	if (cfg.hidePreviewVision && this.isPreview) data.disabled = true;
	return data;
}

/**
 * СПОРНО[move-point] (29.09.2026, adm-daggerheart): Token#getMovementAdjustedPoint (core v13) moves the token's centre
 * a pixel back along the move when a wall lies on the point, so the move test does not miss a wall the token stands
 * on. But it asks for walls with includeInnerBounds, and CanvasEdges#getEdges adds the scene bounds to the result past
 * the filter — a "wall" is always found, and the shift happens at every point. Core tests the move along the shifted
 * lines while routinglib searches by cell centres: a line passing a wall's corner by a fraction of a pixel touched the
 * wall's end, and the move broke off halfway (on a model of one scene: 102 routes of 260; with this fix none). Here the
 * shift happens only when a wall really lies on the point. The same centre goes to the token's light and vision.
 * Undo: drop the `getMovementAdjustedPoint` wrap in installPathfinding.
 */
function movementAdjustedPoint(wrapped, point, options) {
	if (!cfg.pathfinding) return wrapped(point, options);
	const x = Math.round(point.x);
	const y = Math.round(point.y);
	const p = { x, y };
	const onWall = canvas.edges.getEdges(new PIXI.Rectangle(x, y, 0, 0), {
		includeInnerBounds: false,
		includeOuterBounds: false,
		collisionTest: (edge) => edge.move && (foundry.utils.orient2dFast(edge.a, edge.b, p) === 0),
	}).size > 0;
	if (onWall) return wrapped(point, options);
	return (point.elevation !== undefined) ? { x, y, elevation: point.elevation } : p;
}

/* -------------------------------------------- */
/*  Drag ruler: no coloured cells               */
/* -------------------------------------------- */

const HIGHLIGHT_PATCHED = Symbol(`${MODULE_ID}.highlight`);

/**
 * The cells of the drag path are not painted in the player's colour. The ruler class is whatever the system set, so
 * its own prototype is patched when its first token is drawn — before `ready`, the canvas draws earlier.
 */
function patchRulerOf(token) {
	const proto = token.ruler?.constructor?.prototype;
	if (!proto || proto[HIGHLIGHT_PATCHED]) return;
	const original = proto._getGridHighlightStyle;
	if (typeof original !== "function") return;
	Object.defineProperty(proto, HIGHLIGHT_PATCHED, { value: true });
	proto._getGridHighlightStyle = function (...args) {
		return cfg.hideDragHighlight ? { alpha: 0 } : original.apply(this, args);
	};
}

/* -------------------------------------------- */

/** Alt pressed or let go mid-drag: the path is searched again with walls off or on. */
function onAltKey(event) {
	if ((event.key !== "Alt") || event.repeat || !altAllowed()) return;
	// Later than core's own key handling, so the modifier state is already the new one.
	setTimeout(() => {
		try {
			canvas?.tokens?.recalculatePlannedMovementPaths?.();
		} catch (err) {
			console.warn(`${MODULE_ID} |`, err);
		}
	}, 30);
}

export function installPathfinding() {
	wrap(`${TOKEN}.findMovementPath`, findMovementPath, "MIXED");
	wrap(`${TOKEN}._getDragConstrainOptions`, dragConstrainOptions);
	wrap(`${TOKEN}._getVisionSourceData`, visionSourceData);
	wrap(`${TOKEN}.getMovementAdjustedPoint`, movementAdjustedPoint, "MIXED");
	Hooks.on("drawToken", patchRulerOf);
	Hooks.on("preMoveToken", onPreMove);
	document.addEventListener("keydown", onAltKey);
	document.addEventListener("keyup", onAltKey);
}
