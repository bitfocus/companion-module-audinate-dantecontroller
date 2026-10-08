//NAME: merge.ts
//AUTH: Ryan McCartney (rmccartney856@gmail.com)
//DESC: Deep merge of two objects
//DATE: 07/03/2022

type PlainObject = Record<string, unknown>

function isObject(item: unknown): item is PlainObject {
	return typeof item === 'object' && item !== null && !Array.isArray(item)
}

/**
 * Recursively deep-merges one or more source objects into `target`, mutating and returning it.
 */
function merge<T extends PlainObject>(target: T, ...sources: PlainObject[]): T {
	if (!sources.length) return target
	const source = sources.shift()

	if (isObject(target) && isObject(source)) {
		for (const key in source) {
			if (isObject(source[key])) {
				if (!target[key]) Object.assign(target, { [key]: {} })
				merge(target[key] as PlainObject, source[key])
			} else {
				Object.assign(target, { [key]: source[key] })
			}
		}
	}

	return merge(target, ...sources)
}

export default merge
