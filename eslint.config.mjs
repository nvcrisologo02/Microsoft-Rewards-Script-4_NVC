import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
    {
        ignores: [
            'dist/**', 'node_modules/**', 'diagnostics/**', 'sessions/**', 'scripts/**',
            '!scripts', '!scripts/api', '!scripts/api/ui', '!scripts/api/ui/**'
        ]
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.es2021
            },
            ecmaVersion: 2021,
            sourceType: 'module'
        },
        rules: {
            '@typescript-eslint/no-explicit-any': ['warn', { fixToUnknown: false }],
            'prefer-arrow-callback': 'error',
            'no-empty': 'off',
            'preserve-caught-error': 'off'
        }
    },
    {
        files: ['scripts/api/ui/**/*.js'],
        languageOptions: { globals: { ...globals.browser } }
    },
    // Vendored third-party file: never lint/reformat it.
    {
        ignores: ['scripts/api/ui/vendor/**']
    },
    // Must come last: disables ESLint rules that conflict with Prettier formatting
    prettier
)
