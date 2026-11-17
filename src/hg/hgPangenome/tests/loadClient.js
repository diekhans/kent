/* loadClient.js - load js/hgPangenome.js (and optionally the mock) into a
 * sandboxed context with a minimal DOM stub, and hand back its test exports.
 *
 * The client is browser code wrapped in an IIFE, so we run it with node's vm in
 * a context carrying just enough of window/document for it to load.  With no
 * page elements present, its init() returns early ("not our page"), which is
 * exactly what pure-function unit tests want.  Layer 3 (rendering) tests pass
 * ids:[...] to get a working element tree.
 *
 * No npm packages: plain node vm + a hand-rolled DOM stub.
 */

'use strict';

var fs = require('fs');
var vm = require('vm');
var path = require('path');

var JS_DIR = path.resolve(__dirname, '../../js');

// ---- Minimal DOM element stub ----------------------------------------------

function makeNode(tag) {
    var node = {
        tagName: (tag || '').toUpperCase(),
        _kids: [],
        attributes: {},
        style: {},
        className: '',
        _text: null,
        value: '',
        checked: false,
        files: null,
        _listeners: {},
        get children() { return this._kids.filter(function (k) { return k.tagName; }); },
        get firstChild() { return this._kids[0] || null; },
        appendChild: function (c) { this._kids.push(c); return c; },
        removeChild: function (c) {
            var i = this._kids.indexOf(c);
            if (i >= 0) this._kids.splice(i, 1);
            return c;
        },
        setAttribute: function (k, v) { this.attributes[k] = String(v); },
        getAttribute: function (k) {
            return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
        },
        addEventListener: function (ev, fn) {
            (this._listeners[ev] = this._listeners[ev] || []).push(fn);
        },
        // test helper: fire a listener
        dispatch: function (ev, arg) {
            (this._listeners[ev] || []).forEach(function (fn) { fn(arg || { preventDefault: function () {} }); });
        },
        click: function () { this.dispatch('click'); },
        focus: function () {},
        select: function () {},
        set textContent(v) { this._kids = []; this._text = String(v); },
        get textContent() {
            if (this._text !== null) return this._text;
            return this._kids.map(function (k) { return k.textContent; }).join('');
        },
        set innerHTML(v) { this._text = String(v).replace(/<[^>]*>/g, ''); },
        get innerHTML() { return this.textContent; }
    };
    return node;
}

// Collect all descendant nodes matching a predicate (test helper for Layer 3).
function findAll(node, pred, out) {
    out = out || [];
    if (pred(node)) out.push(node);
    (node._kids || []).forEach(function (k) { findAll(k, pred, out); });
    return out;
}

// ---- The scripts' text -------------------------------------------------------

function source(name) {
    return fs.readFileSync(path.join(JS_DIR, name), 'utf8');
}

/* A script's text without its module wrapper, so that everything it defines
 * lands on the vm context, where a test can call it, read it and replace it.
 * "use strict" is still the first statement, so the body runs as strictly as
 * the shipped file does.  commonTests.js loads the files as shipped. */
function body(name) {
    var src = source(name);
    var open = '\n(function () {\n', close = '\n}());\n';
    var a = src.indexOf(open), b = src.lastIndexOf(close);
    if (a < 0 || b < a || src.indexOf(open, a + 1) >= 0)
        throw new Error(name + ': expected one module wrapper');
    return src.slice(0, a) + '\n' + src.slice(a + open.length, b) + '\n';
}

// ---- Loader -----------------------------------------------------------------

/* Options:
 *   ids:        array of element ids to pre-create (default [] => init() no-ops)
 *   config:     value for window.pangenomeConfig (set BEFORE DOMContentLoaded,
 *               matching how the CGI emits it after the script tag)
 *   readyState: 'complete' (default) or 'loading'
 *   fetch:      a fetch stub function
 *   script:     which client to load (default 'hgPangenome.js')
 */
function load(options) {
    options = options || {};
    var ids = options.ids || [];
    var byId = {};
    ids.forEach(function (id) { byId[id] = makeNode('div'); });

    var docListeners = {};
    var document = {
        readyState: options.readyState || 'complete',
        getElementById: function (id) {
            return Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null;
        },
        createElement: makeNode,
        createTextNode: function (t) { var n = makeNode(); n._text = String(t); return n; },
        body: makeNode('body'),
        addEventListener: function (ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); }
    };
    // The client copies by appending a <textarea>, selecting it and calling
    // document.execCommand('copy').  Capture what would have hit the clipboard
    // in document.copiedText so tests can assert the exact text.
    document.copiedText = null;
    document.execCommand = function (cmd) {
        if (cmd === 'copy') {
            var ta = findAll(document.body, function (n) { return n.tagName === 'TEXTAREA'; });
            if (ta.length > 0) document.copiedText = ta[ta.length - 1].value;
        }
        return true;
    };

    var sandbox = {
        document: document,
        console: console,
        Promise: Promise,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        JSON: JSON,
        Math: Math,
        Blob: function (parts, opts) { this.parts = parts; this.opts = opts; },
        FileReader: function () {
            var self = this;
            this.readAsText = function () {
                if (self.onload) self.onload();
            };
        },
        fetch: options.fetch || function () { return Promise.reject(new Error('fetch not stubbed')); },
        module: { exports: {} }
    };
    sandbox.window = {
        // Assigning window.location is how the page navigates; keep the
        // assigned URL readable so a test can assert on where it went.
        location: Object.assign(
            Object.create({ toString: function () { return this.href || this.pathname; } }),
            { pathname: '/cgi-bin/hgPangenome', href: '' }),
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        URL: { createObjectURL: function () { return 'blob:test'; }, revokeObjectURL: function () {} }
    };
    // Beacons are how the page asks for a wider chain on its way out; tests
    // read sandbox.beacons to see what was sent.
    sandbox.beacons = [];
    sandbox.Blob = function (parts) { this.parts = parts; };
    sandbox.navigator = {
        sendBeacon: function (url, blob) {
            sandbox.beacons.push({ url: url,
                body: blob && blob.parts ? String(blob.parts[0]) : String(blob) });
            return true;
        }
    };
    sandbox.self = sandbox.window;
    vm.createContext(sandbox);

    // Generated haplotype->assembly table, loaded by the page before the app.
    // withAssemblies:false lets a test exercise the no-table fallback path.
    if (options.withAssemblies !== false) {
        var tablePath = path.join(JS_DIR, 'hgPangenomeAssemblies.js');
        if (fs.existsSync(tablePath))
            vm.runInContext(fs.readFileSync(tablePath, 'utf8'), sandbox,
                            { filename: 'hgPangenomeAssemblies.js' });
    }
    // And the sample->population table, which PanLift's picker groups by.
    var samplesPath = path.join(JS_DIR, 'hgPangenomeSamples.js');
    if (options.withAssemblies !== false && fs.existsSync(samplesPath))
        vm.runInContext(fs.readFileSync(samplesPath, 'utf8'), sandbox,
                        { filename: 'hgPangenomeSamples.js' });

    // What every page script is written on, loaded before it as on the page.
    vm.runInContext(source('hgPangenomeCommon.js'), sandbox, { filename: 'hgPangenomeCommon.js' });

    var clientScript = options.script || 'hgPangenome.js';
    vm.runInContext(source(clientScript), sandbox, { filename: clientScript });

    // The CGI emits window.pangenomeConfig in an inline script AFTER the
    // <script src> tags, so set it here, then fire DOMContentLoaded.
    if (options.config !== undefined)
        sandbox.window.pangenomeConfig = options.config;

    function fireReady() {
        document.readyState = 'complete';
        (docListeners.DOMContentLoaded || []).forEach(function (fn) { fn(); });
    }

    return {
        api: sandbox.module.exports,   // the client's test exports
        sandbox: sandbox,
        window: sandbox.window,
        document: document,
        el: byId,
        fireReady: fireReady,
        findAll: findAll,
        makeNode: makeNode
    };
}

module.exports = { load: load, makeNode: makeNode, findAll: findAll, source: source, body: body };
