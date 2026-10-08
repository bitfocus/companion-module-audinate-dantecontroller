import type DanteInstance from './main.js'

/** Builds and registers this instance's preset definitions with Companion. */
export function UpdatePresetDefinitions(self: DanteInstance): void {
	self.setPresetDefinitions([], {})
}
