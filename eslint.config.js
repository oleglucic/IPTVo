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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_+', varsIgnorePattern: '^_+', caughtErrorsIgnorePattern: '^_+' }],
      'no-console': 'off'
    }
  },
  {
    files: ['*.worker.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_+', varsIgnorePattern: '^_+', caughtErrorsIgnorePattern: '^_+' }],
      'no-console': 'off'
    }
  },
  {
    files: ['*.html'],
    plugins: {
      html: require('eslint-plugin-html')
    },
    rules: {
      'no-console': 'off'
    }
  }
];