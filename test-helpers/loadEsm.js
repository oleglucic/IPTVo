/**
 * Test helper: loads a plain browser-style ES module file (using `import`/`export`
 * syntax) and evaluates it as CommonJS *within the current V8 realm*.
 *
 * The project's Jest config runs with testEnvironment "node" and has no
 * babel/jsdom transform configured, so `dashboard/js/*.js` files (which use
 * native ESM syntax and rely on browser globals like `document`/`fetch`)
 * cannot be `require()`-d directly. This helper performs a minimal,
 * deterministic source transform (stripping `import`/`export` keywords) and
 * compiles the result with `vm.compileFunction`, which - unlike
 * `vm.createContext`/`vm.runInContext` - executes in the *same realm* as the
 * calling test file. This matters because cross-realm execution would make
 * `instanceof` checks against built-ins like `TypeError` silently fail
 * (a different realm has a distinct `TypeError` constructor).
 *
 * Any browser globals the module relies on (e.g. `document`, `fetch`,
 * `sessionStorage`) must be supplied explicitly via `options.globals`; they
 * are injected as function parameters so they shadow (or safely fill in for)
 * the corresponding real Node globals, without mutating `globalThis`.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Built-ins and browser globals that modules commonly reference unqualified.
// `vm.compileFunction` resolves free variables against a context-global that,
// in some Node versions, does NOT alias the current realm's `globalThis`:
// `instanceof TypeError` fails across realms and jest fake timers cannot drive
// a module's `setTimeout`. Injecting these from `globalThis` as explicit
// parameters pins them to the calling realm. Callers may still override any of
// these via `options.globals` (injected afterwards).
const REALM_GLOBALS = [
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'queueMicrotask', 'AbortController', 'TypeError', 'Error',
    'RangeError', 'ReferenceError', 'SyntaxError', 'fetch',
    'URL', 'URLSearchParams', 'Headers', 'Request', 'Response',
    'FormData', 'Blob', 'File', 'TextEncoder', 'TextDecoder',
    'crypto', 'performance', 'console'
];

/**
 * @param {string} filePath - Absolute path, or path relative to the repository root (e.g. "dashboard/js/api.js").
 * @param {Object} [options]
 * @param {Object<string, any>} [options.importMocks] - Values to substitute for named imports, keyed by imported identifier.
 * @param {Object<string, any>} [options.globals] - Extra identifiers to expose to the module (e.g. `document`, `fetch`, `sessionStorage`).
 * @returns {any} The module's `module.exports` object (including a `default` key when applicable).
 */
function loadEsmModule(filePath, options = {}) {
    const { importMocks = {}, globals = {} } = options;
    // Resolve non-absolute paths relative to the repository root (this file
    // lives in `<repoRoot>/test-helpers/`), regardless of which directory
    // the calling test file is located in.
    const repoRoot = path.resolve(__dirname, '..');
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
    let code = fs.readFileSync(absPath, 'utf8');

    const exportedNames = new Set();

    code = code.replace(/export\s+const\s+(\w+)/g, (m, name) => {
        exportedNames.add(name);
        return `const ${name}`;
    });
    code = code.replace(/export\s+function\s+(\w+)/g, (m, name) => {
        exportedNames.add(name);
        return `function ${name}`;
    });
    code = code.replace(/export\s+class\s+(\w+)/g, (m, name) => {
        exportedNames.add(name);
        return `class ${name}`;
    });

    let defaultExportName = null;
    code = code.replace(/export\s+default\s+(\w+)\s*;?/g, (m, name) => {
        defaultExportName = name;
        return '';
    });

    // Named imports: import { a, b } from '...';
    code = code.replace(/import\s*{\s*([^}]+)\s*}\s*from\s*['"][^'"]+['"];?/g, (m, names) => {
        return names
            .split(',')
            .map(n => n.trim())
            .map(n => `const ${n} = __importMocks__[${JSON.stringify(n)}];`)
            .join('\n');
    });

    const exportLines = [...exportedNames].map(n => `module.exports[${JSON.stringify(n)}] = ${n};`).join('\n');
    const defaultLine = defaultExportName ? `module.exports.default = ${defaultExportName};` : '';

    const wrapped = `${code}\n${exportLines}\n${defaultLine}`;

    const customGlobalNames = Object.keys(globals);
    const paramNames = ['module', 'exports', 'require', '__importMocks__', ...REALM_GLOBALS, ...customGlobalNames];

    const fn = vm.compileFunction(wrapped, paramNames, { filename: absPath });

    const moduleObj = { exports: {} };
    const args = [
        moduleObj, moduleObj.exports, require, importMocks,
        ...REALM_GLOBALS.map(n => globalThis[n]),
        ...customGlobalNames.map(n => globals[n])
    ];
    fn(...args);

    return moduleObj.exports;
}

module.exports = { loadEsmModule };