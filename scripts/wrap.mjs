import { MODULE_ID } from "./settings.mjs";

/**
 * Wrap a method by its full path: through libWrapper when it is on (one wrapper per target), otherwise by hand.
 * `fn(wrapped, ...args)` is called with the instance as `this`, as libWrapper calls it.
 * @param {string} target   e.g. "foundry.canvas.placeables.Token.prototype.findMovementPath"
 * @param {Function} fn
 * @param {"WRAPPER"|"MIXED"} [type]
 */
export function wrap(target, fn, type = "WRAPPER") {
	if (game.modules.get("lib-wrapper")?.active && globalThis.libWrapper) {
		globalThis.libWrapper.register(MODULE_ID, target, fn, type);
		return;
	}
	const path = target.split(".");
	const key = path.pop();
	const owner = path.reduce((o, k) => o?.[k], globalThis);
	const original = owner[key];
	owner[key] = function (...args) {
		return fn.call(this, original.bind(this), ...args);
	};
}
