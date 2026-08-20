import { describe, expect, it } from 'vitest'
import { object2choices, object2PartialChoices, array2choices } from './const.js'

describe('object2choices', () => {
	it('converts an id-to-label map into a choices array', () => {
		expect(object2choices({ 1: 'One', 2: 'Two' })).toEqual([
			{ id: '1', label: 'One' },
			{ id: '2', label: 'Two' },
		])
	})

	it('returns an empty array for an empty map', () => {
		expect(object2choices({})).toEqual([])
	})
})

describe('object2PartialChoices', () => {
	it('only includes entries whose id is present in optionsArray', () => {
		const result = object2PartialChoices({ 0: 'NONE', 1: 'A', 2: 'B' }, ['0', '2'])
		expect(result).toEqual([
			{ id: '0', label: 'NONE' },
			{ id: '2', label: 'B' },
		])
	})

	it('returns an empty array when optionsArray is undefined', () => {
		expect(object2PartialChoices({ 0: 'NONE' }, undefined)).toEqual([])
	})
})

describe('array2choices', () => {
	it('maps raw values to choices using the value itself as the label by default', () => {
		expect(array2choices([1, 2])).toEqual([
			{ id: 1, label: '1' },
			{ id: 2, label: '2' },
		])
	})

	it('uses the mapping function to derive labels when given', () => {
		const result = array2choices([48000, 96000], (hz) => `${hz / 1000} kHz`)
		expect(result).toEqual([
			{ id: 48000, label: '48 kHz' },
			{ id: 96000, label: '96 kHz' },
		])
	})

	it('returns undefined when array is undefined', () => {
		expect(array2choices(undefined)).toBeUndefined()
	})
})
