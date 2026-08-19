// Tests for dashboard/js/toast.js (new toast notification module added in
// this PR). Loaded via the loadEsmModule helper with a minimal mock DOM,
// since the module reads `document.getElementById('toastContainer')` at
// module-load time and manipulates elements via `document.createElement`.

const { loadEsmModule } = require('../../test-helpers/loadEsm');

class MockElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.className = '';
        this._innerHTML = '';
        this.textContent = '';
        this.style = {};
        this.children = [];
        this.attributes = {};
        this.listeners = {};
        this.parentNode = null;
    }
    get innerHTML() {
        return this._innerHTML;
    }
    set innerHTML(value) {
        this._innerHTML = value;
    }
    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    setAttribute(name, value) {
        this.attributes[name] = value;
    }
    addEventListener(event, cb) {
        (this.listeners[event] = this.listeners[event] || []).push(cb);
    }
    dispatch(event) {
        (this.listeners[event] || []).forEach(cb => cb());
    }
    remove() {
        if (this.parentNode) {
            const idx = this.parentNode.children.indexOf(this);
            if (idx !== -1) this.parentNode.children.splice(idx, 1);
            this.parentNode = null;
        }
    }
}

function makeDocumentMock() {
    const registry = new Map();
    return {
        getElementById: jest.fn(id => registry.get(id) || null),
        createElement: jest.fn(tag => new MockElement(tag)),
        __registry: registry
    };
}

function loadToastModule(withContainer = true) {
    const documentMock = makeDocumentMock();
    const container = new MockElement('div');
    if (withContainer) {
        documentMock.__registry.set('toastContainer', container);
    }
    const mod = loadEsmModule('dashboard/js/toast.js', {
        globals: { document: documentMock }
    });
    return { mod, container, documentMock };
}

describe('dashboard/js/toast.js', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('showToast returns undefined and creates nothing when the toast container is missing', () => {
        const { mod, documentMock } = loadToastModule(false);

        const result = mod.showToast('success', 'Title');

        expect(result).toBeUndefined();
        expect(documentMock.createElement).not.toHaveBeenCalled();
    });

    test('showToast appends a toast with the correct type class and title to the container', () => {
        const { mod, container } = loadToastModule();

        const toastEl = mod.showToast('success', 'Saved!');

        expect(toastEl.className).toBe('toast success');
        expect(container.children).toContain(toastEl);

        const contentDiv = toastEl.children.find(c => c.className === 'toast-content');
        expect(contentDiv).toBeDefined();
        const titleDiv = contentDiv.children.find(c => c.className === 'toast-title');
        expect(titleDiv.textContent).toBe('Saved!');
    });

    test('showToast includes a message element only when a message is provided', () => {
        const { mod } = loadToastModule();

        const withMessage = mod.showToast('info', 'Title', 'Some details');
        const contentWithMsg = withMessage.children.find(c => c.className === 'toast-content');
        expect(contentWithMsg.children.some(c => c.className === 'toast-message')).toBe(true);

        const withoutMessage = mod.showToast('info', 'Title only');
        const contentWithoutMsg = withoutMessage.children.find(c => c.className === 'toast-content');
        expect(contentWithoutMsg.children.some(c => c.className === 'toast-message')).toBe(false);
    });

    test('falls back to the info icon for an unrecognized toast type', () => {
        const { mod } = loadToastModule();

        const unknownTypeToast = mod.showToast('bogus-type', 'Title');
        const infoTypeToast = mod.showToast('info', 'Title');

        const iconOf = t => t.children.find(c => c.className === 'toast-icon');
        expect(iconOf(unknownTypeToast).innerHTML).toBe(iconOf(infoTypeToast).innerHTML);
    });

    test('automatically removes the toast from the container after the given duration', () => {
        jest.useFakeTimers();
        const { mod, container } = loadToastModule();

        const toastEl = mod.showToast('success', 'Auto dismiss', undefined, 1000);
        expect(container.children).toContain(toastEl);

        jest.advanceTimersByTime(1000); // fires removeToast's setTimeout
        jest.advanceTimersByTime(200); // fires the reverse-animation removal setTimeout

        expect(container.children).not.toContain(toastEl);
    });

    test('does not schedule auto-removal when duration is 0 or negative', () => {
        jest.useFakeTimers();
        const { mod, container } = loadToastModule();

        const toastEl = mod.showToast('warning', 'Persistent', undefined, 0);

        jest.advanceTimersByTime(60000);

        expect(container.children).toContain(toastEl);
    });

    test('clicking the close button removes the toast', () => {
        jest.useFakeTimers();
        const { mod, container } = loadToastModule();

        const toastEl = mod.showToast('error', 'Dismiss me', undefined, 0);
        const closeBtn = toastEl.children.find(c => c.className === 'toast-close');

        closeBtn.dispatch('click');
        jest.advanceTimersByTime(200);

        expect(container.children).not.toContain(toastEl);
    });

    test('the toast convenience object dispatches the correct type for each helper', () => {
        const { mod } = loadToastModule();

        expect(mod.toast.success('S').className).toBe('toast success');
        expect(mod.toast.error('E').className).toBe('toast error');
        expect(mod.toast.warning('W').className).toBe('toast warning');
        expect(mod.toast.info('I').className).toBe('toast info');
    });
});