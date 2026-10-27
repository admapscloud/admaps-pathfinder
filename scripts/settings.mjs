export const MODULE_ID = "admaps-pathfinder";

/**
 * The settings, read on every drag step and every animation start — `game.settings.get` there is too dear, so the
 * values live here and `onChange` keeps them fresh.
 */
export const cfg = {
	pathfinding: true,
	altBypass: "all",
	avoidEnemies: true,
	hidePreviewVision: true,
	hideDragHighlight: true,
	facing: true,
	faceTarget: true,
};

const SETTINGS = {
	pathfinding: { type: Boolean, default: true },
	altBypass: { type: String, default: "all", choices: ["all", "gm", "off"] },
	avoidEnemies: { type: Boolean, default: true },
	hidePreviewVision: { type: Boolean, default: true },
	hideDragHighlight: { type: Boolean, default: true },
	facing: { type: Boolean, default: true },
	faceTarget: { type: Boolean, default: true },
};

export function registerSettings() {
	for (const [key, { type, default: initial, choices }] of Object.entries(SETTINGS)) {
		const base = `ADMAPS_PF.Settings.${key}`;
		game.settings.register(MODULE_ID, key, {
			name: `${base}.Name`,
			hint: `${base}.Hint`,
			scope: "world",
			config: true,
			type,
			default: initial,
			choices: choices && Object.fromEntries(choices.map((c) => [c, `${base}.Choices.${c}`])),
			onChange: (value) => { cfg[key] = value; },
		});
		cfg[key] = game.settings.get(MODULE_ID, key);
	}
}
