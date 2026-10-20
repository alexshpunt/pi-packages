// Shared stub pi for calling the extension's default export in unit tests.
// Returns the Map of event handlers the stub recorded. Pass activateFn to
// override the activate function (e.g. a freshly re-imported module instance).
// Tool registration is an error: the bridge is provider-only.
const { default: activate } = await import("../../src/index.js");

export function activateWithMockPi(activateFn) {
	const handlers = new Map();
	(activateFn ?? activate)({
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: () => {},
		registerTool: () => { throw new Error("bridge must not register tools"); },
	});
	return handlers;
}
