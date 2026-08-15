const globals = require('globals');

module.exports = [
  {
    files: ['*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2021
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off'
    }
  },
  {
    files: ['*.html'],
    languageOptions: {
      parser: require('html-eslint/parser'),
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.es2021
      }
    },
    plugins: {
      html: require('html-eslint/plugin')
    },
    rules: {
      'no-console': 'off'
    }
  }
];