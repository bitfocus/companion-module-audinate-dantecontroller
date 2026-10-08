import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	enableTypescript: true,
	ignores: ['vitest.config.ts'],
})

export default [
	...baseConfig,
	{
		files: ['src/**/*.spec.ts'],
		rules: {
			'n/no-unpublished-import': 'off',
			// Referencing a mocked method (e.g. `expect(self.updateStatus).toHaveBeenCalledWith(...)`)
			// is the normal way to assert on it and is safe here since it's never called unbound -
			// this rule can't distinguish that from a real risky unbound method reference.
			'@typescript-eslint/unbound-method': 'off',
		},
	},
]
