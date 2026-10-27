// Wrapper to fix a FoundryVTT bug that causes the return values of canvas.grid.getPixelsFromGridPosition to be ordered inconsistently

// https://gitlab.com/foundrynet/foundryvtt/-/issues/4705
export function getPixelsFromGridPosition(xGrid, yGrid) {
	const coord = canvas.grid.getTopLeftPoint({i: xGrid, j: yGrid});
	// v13: getTopLeftPoint returns correct {x, y} — no swap needed
	return [coord.x, coord.y];
}

// Wrapper to fix a FoundryVTT bug that causes the return values of canvas.grid.getPixelsFromGridPosition to be ordered inconsistently
// https://gitlab.com/foundrynet/foundryvtt/-/issues/4705
export function getGridPositionFromPixels(xPixel, yPixel) {
	// v13 compat: getGridPositionFromPixels removed, use getOffset
	if (canvas.grid.getGridPositionFromPixels) {
		const [x, y] = canvas.grid.getGridPositionFromPixels(xPixel, yPixel);
		if (canvas.grid.type !== CONST.GRID_TYPES.GRIDLESS) return [y, x];
		return [x, y];
	}
	const offset = canvas.grid.getOffset({ x: xPixel, y: yPixel });
	return [offset.i, offset.j];
}

export function getGridPositionFromPixelsObj(o) {
	const r = {};
	[r.x, r.y] = getGridPositionFromPixels(o.x, o.y);
	return r;
}

export function getPixelsFromGridPositionObj(o) {
	const r = {};
	[r.x, r.y] = getPixelsFromGridPosition(o.x, o.y);
	return r;
}

export function getCenterFromGridPositionObj(o) {
	const r = getPixelsFromGridPositionObj(o);
	// v13: getCenter is deprecated and just returns [x,y], use getCenterPoint
	if (canvas.grid.getCenterPoint) {
		const center = canvas.grid.getCenterPoint({ x: r.x, y: r.y });
		r.x = center.x;
		r.y = center.y;
	} else {
		[r.x, r.y] = canvas.grid.getCenter(r.x, r.y);
	}
	return r;
}
