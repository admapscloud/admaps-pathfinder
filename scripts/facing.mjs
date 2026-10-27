import { MODULE_ID, cfg } from "./settings.mjs";
import { wrap } from "./wrap.mjs";
import { isGhost, isSkipped } from "./pathfinding.mjs";

/**
 * Facing: the token's art is mirrored (texture.scaleX's sign) toward where it walks, and toward the token its player
 * targets last. Ported from the adm-daggerheart system (scripts/token-mirror.mjs). The art is taken to look right;
 * only the sign changes, never the size (a token scaled 1.5 stays 1.5).
 */

/** Moves that are not the token walking: Ctrl+Z, a paste, a change in the token's own sheet. */
const NOT_WALKING = new Set(["undo", "paste", "config"]);

/**
 * Which way a path runs: −1 left, 1 right, 0 neither (straight up or down, or a height change). By the centres of its
 * points (a token growing shifts its corner, not its centre); by its second half, where the token arrives — a detour
 * left around a wall that ends to the right looks right — else by the whole of it.
 * @param {TokenDocument} doc
 * @param {object[]} points  positions: {x, y, width, height, shape}
 * @returns {-1|0|1}
 */
export function pathDirection(doc, points) {
	if (points.length < 2) return 0;
	const xs = points.map((p) => doc.getCenterPoint(p).x);
	const dead = (canvas?.grid?.size ?? 100) / 4;
	const sign = (dx) => ((Math.abs(dx) < dead) ? 0 : Math.sign(dx));
	return sign(xs.at(-1) - xs[Math.floor(xs.length / 2)]) || sign(xs.at(-1) - xs[0]);
}

/**
 * The turn goes into the move's own update: a hook later in the chain that refuses the move refuses the turn too, and
 * one Ctrl+Z takes back both. The direction comes from the move core has already planned (`options._movement`): the
 * path search's detours are in it, and keyboard moves as well. Each leg of a long move is its own update and turns on
 * its own.
 */
function onPreUpdate(doc, changes, options) {
	if (!cfg.facing) return;
	const move = options._movement?.[doc.id];
	if (!move || NOT_WALKING.has(move.method)) return;
	if (isGhost(doc) || isSkipped(doc, options)) return;
	const dir = pathDirection(doc, [move.origin, ...move.passed.waypoints]);
	if (!dir) return;
	const current = foundry.utils.getProperty(changes, "texture.scaleX") ?? doc._source.texture?.scaleX ?? 1;
	const next = dir * (Math.abs(current) || 1);
	if (next !== current) foundry.utils.setProperty(changes, "texture.scaleX", next);
}

/** The token this user plays: the one selected, else their character's on this scene. */
function ownToken() {
	const controlled = canvas?.tokens?.controlled?.[0];
	if (controlled) return controlled;
	const id = game.user?.character?.id;
	return id ? (canvas?.tokens?.placeables?.find((t) => t.actor?.id === id) ?? null) : null;
}

/** Turn toward the last target (the targets keep their order; dropping one turns toward the one before it). */
function onTarget(user) {
	if (!cfg.faceTarget || (user !== game.user)) return;
	const target = Array.from(game.user.targets).at(-1);
	const own = ownToken();
	if (!target || !own || (own === target) || !own.document.isOwner || isGhost(own.document)) return;
	const dx = target.center.x - own.center.x;
	if (Math.abs(dx) < 1) return; // straight above or below
	const doc = own.document;
	const current = doc._source.texture?.scaleX ?? 1;
	const next = Math.sign(dx) * (Math.abs(current) || 1);
	if (next !== current) doc.update({ "texture.scaleX": next }).catch((err) => console.warn(`${MODULE_ID} |`, err));
}

/**
 * A turn is instant, on every client: core would animate the scale through zero for a second. Not `animate: false` —
 * that stops the token's running animations, its walk among them. Only a pure mirror is touched: the scale's sign
 * changes and nothing else; the walk animates apart from it.
 */
function animationDuration(wrapped, from, to, options) {
	if ((cfg.facing || cfg.faceTarget) && isPureMirror(from, to)) return 0;
	return wrapped(from, to, options);
}

function isPureMirror(from, to) {
	const keys = Object.keys(to ?? {});
	if ((keys.length !== 1) || (keys[0] !== "texture")) return false;
	const texture = Object.keys(to.texture ?? {});
	if ((texture.length !== 1) || (texture[0] !== "scaleX")) return false;
	const a = from?.texture?.scaleX;
	const b = to.texture.scaleX;
	return (Math.sign(a) === -Math.sign(b)) && (Math.abs(a) === Math.abs(b));
}

export function installFacing() {
	Hooks.on("preUpdateToken", onPreUpdate);
	Hooks.on("targetToken", onTarget);
	wrap("foundry.canvas.placeables.Token.prototype._getAnimationDuration", animationDuration, "MIXED");
}
