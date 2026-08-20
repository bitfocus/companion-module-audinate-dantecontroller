import { describe, expect, it } from 'vitest'
import merge from './merge.js'

describe('merge', () => {
	it('returns the target unchanged when no sources are given', () => {
		const target = { a: 1 }
		expect(merge(target)).toBe(target)
	})

	it('merges top-level keys from a source into the target', () => {
		const target = { a: 1, b: 2 }
		const result = merge(target, { b: 3, c: 4 })
		expect(result).toEqual({ a: 1, b: 3, c: 4 })
	})

	it('recursively merges nested objects instead of replacing them', () => {
		const target = { device: { name: 'A', tx: { 1: { name: 'in1' } } } }
		const result = merge(target, { device: { tx: { 2: { name: 'in2' } } } })
		expect(result).toEqual({
			device: { name: 'A', tx: { 1: { name: 'in1' }, 2: { name: 'in2' } } },
		})
	})

	it('applies multiple sources in order, later sources winning', () => {
		const target = { a: 1 }
		const result = merge(target, { a: 2 }, { a: 3 })
		expect(result).toEqual({ a: 3 })
	})

	it('mutates and returns the same target object', () => {
		const target: Record<string, unknown> = { a: 1 }
		const result = merge(target, { b: 2 })
		expect(result).toBe(target)
	})
})
