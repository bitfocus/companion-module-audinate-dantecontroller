import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	enableTypescript: false,
})

export default [
	...baseConfig,
	{
		files: ['**/*.js'],
		languageOptions: {
			sourceType: 'module',
		},
	},
]
