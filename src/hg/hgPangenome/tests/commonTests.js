/* commonTests.js - tests for what the page scripts share
 * (js/hgPangenomeCommon.js), and for the scripts as they are shipped.
 *
 * The other test files load a page script without its module wrapper, to reach
 * inside it.  The last part of this one loads every script exactly as the
 * browser does, in the order the CGI names them, and checks what each leaves
 * in the page's global scope and that the pages start.
 *
 * Run:  node commonTests.js
 */

'use strict';

var test = require('node:test');
var check = require('./check.js');
var vm = require('vm');
var loader = require('./loadClient.js');

test('What the page scripts share, and the scripts as shipped (js/hgPangenomeCommon.js)', async function (ctx) {
var t = check.under(ctx);

var calls = [];
var page = loader.load({ fetch: function (url, opts) {
    calls.push({ url: url, opts: opts });
    return Promise.resolve({ ok: true, json: function () { return {}; } });
} });
var C = page.window.pangenomeCommon;

// ---- text ------------------------------------------------------------------------

t.suite('text');
await t.test('markup characters are escaped, a missing value is empty', function () {
    t.eq(C.esc('<a href="x">\'&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;', 'all five');
    t.eq(C.esc(null), '', 'null');
    t.eq(C.esc(undefined), '', 'undefined');
    t.eq(C.esc(0), '0', 'a number is kept');
});
await t.test('thousands are separated, a missing number is empty', function () {
    t.eq(C.commas(1234567), '1,234,567', 'millions');
    t.eq(C.commas(999), '999', 'no comma under a thousand');
    t.eq(C.commas(0), '0', 'zero is a number');
    t.eq(C.commas('1500'), '1,500', 'a number given as text');
    t.eq(C.commas(null), '', 'null');
    t.eq(C.commas(undefined), '', 'undefined');
    t.eq(C.commas(NaN), '', 'not a number');
});

// ---- haplotypes --------------------------------------------------------------------

t.suite('haplotype names');
await t.test('a haplotype is its sample and number, with or without a sequence, in any case', function () {
    t.eq(C.hapKey('CHM13#0#chr10'), 'chm13#0', 'with its sequence');
    t.eq(C.hapKey('HG00097#1'), 'hg00097#1', 'without');
    t.eq(C.hapKey('HG00097#1#CM094066.1#1407250'), 'hg00097#1', 'with a subpath offset');
    t.eq(C.hapKey(null), '', 'nothing');
});
await t.test('a hub assembly is known by its plain name', function () {
    t.eq(C.bareDb('hub_25071_hs1'), 'hs1', 'curated hub');
    t.eq(C.bareDb('hub_146215_GCA_044165215.1'), 'GCA_044165215.1', 'GenArk');
    t.eq(C.bareDb('hg38'), 'hg38', 'a plain db is unchanged');
    t.eq(C.bareDb(null), '', 'nothing');
});
await t.test('an assembly has the name it was published under, or none', function () {
    t.contains(C.assemblyName('GCA_044165215.1'), 'HG00097', 'a GenArk assembly');
    t.isNull(C.assemblyName('mm39'), 'not in the table');
    t.isNull(C.assemblyName('toString'), 'a name Object.prototype has');
});

t.suite('the assembly a haplotype is served from');
await t.test('the generated HPRC table is loaded', function () {
    var n = Object.keys(page.window.pangenomeAssemblies || {}).length;
    t.ok(n > 400, 'populated (' + n + ' haplotypes)');
});
await t.test('sample haplotypes resolve to their GenArk assembly', function () {
    t.eq(C.assemblyFor('HG00097#1'), 'GCA_044165215.1', 'HG00097 hap1');
    t.eq(C.assemblyFor('HG00097#2'), 'GCA_044164745.1', 'HG00097 hap2');
    t.eq(C.assemblyFor('NA19338#1'), 'GCA_042035195.1', 'NA19338 hap1');
});
await t.test('a name is matched on sample and haplotype, in any case, contig or not', function () {
    t.eq(C.assemblyFor('hg00097#1'), 'GCA_044165215.1', 'lower case');
    t.eq(C.assemblyFor('HG00097#1#CM094066.1'), 'GCA_044165215.1', 'with its contig');
});
await t.test('the two haplotypes of a sample are different assemblies', function () {
    t.notOk(C.assemblyFor('HG00408#1') === C.assemblyFor('HG00408#2'), 'pat and mat differ');
});
await t.test('the references come from the same table', function () {
    t.eq(C.assemblyFor('CHM13#0'), 'hs1', 'CHM13');
    t.eq(C.assemblyFor('GRCh38#0'), 'hg38', 'GRCh38');
});
await t.test('HG002 is opened in its GenArk assemblies, like every other sample', function () {
    // HPRC's index links it by a hub's number on genome.ucsc.edu, which opens
    // whatever assembly the reader's session there was on last.
    t.eq(C.assemblyFor('HG002#1'), 'GCA_018852605.3', 'paternal');
    t.eq(C.assemblyFor('HG002#2'), 'GCA_018852615.3', 'maternal');
    t.eq(C.assemblyName('GCA_018852605.3'), 'hg002v1.1.pat', 'under the name it was published by');
    var hubs = Object.keys(page.window.pangenomeAssemblies).filter(function (hap) {
        return /hub_[0-9]+_/.test(page.window.pangenomeAssemblies[hap]); });
    t.deepEq(hubs, [], 'and no haplotype is left that opens by a hub\'s number');
});
await t.test('the assemblies the graph names its own way are marked', function () {
    t.eq(C.graphNamesDiffer('GCA_018852615.3'), true, 'HG002 maternal');
    t.eq(C.graphNamesDiffer('GCA_018852605.3'), true, 'HG002 paternal');
    t.eq(C.graphNamesDiffer('GCA_044165215.1'), false, 'not another sample');
    t.eq(C.graphNamesDiffer('hg38'), false, 'nor a reference');
    t.eq(C.graphNamesDiffer('toString'), false, 'nor a name Object.prototype has');
});
await t.test('an unknown haplotype has no assembly', function () {
    t.isNull(C.assemblyFor('NOSUCHSAMPLE#1'), 'unknown sample');
    t.isNull(C.assemblyFor('HG00097#9'), 'unknown haplotype of a known sample');
    t.isNull(C.assemblyFor('toString'), 'a name Object.prototype has');
});

t.suite('populations');
await t.test("a sample's population is the HPRC's own description", function () {
    t.eq(JSON.stringify(C.population('HG00097#1')),
         JSON.stringify({ code: 'GBR', desc: 'British from England and Scotland' }), 'GBR');
    t.eq(C.population('hg00097#2').code, 'GBR', 'either phase, any case');
    t.eq(C.population('HG002#1'), null, 'HG002 has none given');
    t.eq(C.population('GRCh38#0'), null, 'nor the references');
    t.contains(C.population('HG02572#1').desc, 'Western Division \u2013 Mandinka', 'the mis-encoded dash repaired');
});

// ---- requests: the body --------------------------------------------------------------

t.suite('formEncode - request body encoding');

await t.test('single and multiple pairs', function () {
    t.eq(C.formEncode({ cmd: 'map' }), 'cmd=map', 'one pair');
    t.eq(C.formEncode({ cmd: 'poll', job_id: 'abc123' }), 'cmd=poll&job_id=abc123', 'two pairs');
});

await t.test('JSON payloads are percent-encoded', function () {
    t.eq(C.formEncode({ payload: '{"a":1}' }), 'payload=%7B%22a%22%3A1%7D', 'json');
});

await t.test('characters that would break the body are escaped', function () {
    t.eq(C.formEncode({ v: 'a&b' }), 'v=a%26b', 'ampersand');
    t.eq(C.formEncode({ v: 'a=b' }), 'v=a%3Db', 'equals');
    t.eq(C.formEncode({ v: 'a+b' }), 'v=a%2Bb', 'plus');
    t.eq(C.formEncode({ v: 'a b' }), 'v=a%20b', 'space');
    t.eq(C.formEncode({ v: '#frag' }), 'v=%23frag', 'hash');
});

// ---- elements ------------------------------------------------------------------------

t.suite('elements');
await t.test('an element is built with its class, text, attributes and children', function () {
    var a = C.el('a', { class: 'gbPill', href: '/x', text: 'Open' });
    t.eq(a.tagName, 'A', 'tag');
    t.eq(a.className, 'gbPill', 'class');
    t.eq(a.getAttribute('href'), '/x', 'attribute');
    t.eq(a.textContent, 'Open', 'text');
    var p = C.el('p', null, ['one ', null, a, undefined]);
    t.eq(p._kids.length, 2, 'missing children are skipped');
    t.eq(p.textContent, 'one Open', 'a string becomes text');
    C.clear(p);
    t.eq(p._kids.length, 0, 'cleared');
});

// ---- requests ------------------------------------------------------------------------

t.suite('requests');
await t.test('a command is POSTed to this CGI as cmd and payload', function () {
    calls.length = 0;
    C.post('surject', { job_id: 'j1', name: 'a&b' });
    t.eq(calls[0].url, '/cgi-bin/hgPangenome', 'to the page\'s own address');
    t.eq(calls[0].opts.method, 'POST', 'POST');
    t.eq(calls[0].opts.headers['Content-Type'], 'application/x-www-form-urlencoded', 'as a form');
    t.eq(calls[0].opts.body, 'cmd=surject&payload=' + encodeURIComponent('{"job_id":"j1","name":"a&b"}'),
         'the payload as JSON, escaped');
    t.notOk(/hgsid/.test(calls[0].opts.body), 'no session unless one is given');
});
await t.test('with the session when the command writes to it', function () {
    calls.length = 0;
    C.post('refAnnot', {}, '123_abc');
    t.eq(calls[0].opts.body, 'cmd=refAnnot&payload=%7B%7D&hgsid=123_abc', 'hgsid last');
});
await t.test('a request too large to send is refused on the page, with the sizes', async function () {
    // Over a megabyte the web server's library answers with an HTML page
    // before the CGI is run.  Quotes and braces count three bytes each here.
    calls.length = 0;
    var said = null;
    await C.post('map', { sequences: new Array(40001).join('{"a":"b"},') }).then(function () { said = 'sent'; },
                                                                                function (err) { said = err.message; });
    t.contains(said || '', 'the request is too large', 'refused');
    t.contains(said || '', '(limit 1,000,000)', 'with the limit');
    t.eq(calls.length, 0, 'and not sent');
    await C.post('map', { sequences: new Array(40001).join('ACGTACGTAC') }).then(function () { said = 'sent'; },
                                                                              function (err) { said = err.message; });
    t.eq(said, 'sent', '400 kb of plain bases goes');
});
await t.test('a saved file is let go of later, not at once', function () {
    var revoked = 0, waits = [];
    page.sandbox.URL = { createObjectURL: function () { return 'blob:test'; },
                         revokeObjectURL: function () { revoked++; } };
    var timeout = page.sandbox.setTimeout;
    page.sandbox.setTimeout = function (fn, ms) { waits.push(ms); };
    C.saveFile('a\tb\n', 'table.tsv', 'text/tab-separated-values');
    page.sandbox.setTimeout = timeout;
    t.eq(revoked, 0, 'not while the browser may only be starting on it');
    t.ok(waits[0] >= 10000, 'some time after (' + waits[0] + ' ms)');
});
await t.test('a query is a GET on the same address', function () {
    calls.length = 0;
    C.get('cmd=poll&job_id=j1');
    t.eq(calls[0].url, '/cgi-bin/hgPangenome?cmd=poll&job_id=j1', 'address and query');
    t.eq(calls[0].opts.method, 'GET', 'GET');
});

function failed(status, text) {
    return { ok: false, status: status, text: function () { return Promise.resolve(text); },
             json: function () { throw new Error('not read'); } };
}
var good = { ok: true, json: function () { return { a: 1 }; } };
var bodyErr = null, emptyErr = null, bodyOk = null;
C.jsonOrBody(failed(502, 'x'.repeat(400))).catch(function (e) { bodyErr = e.message; });
C.jsonOrBody(failed(404, '')).catch(function (e) { emptyErr = e.message; });
Promise.resolve(good).then(C.jsonOrBody).then(function (v) { bodyOk = v; });

await t.test('an answer is read as JSON; a failed request names its status', function () {
    t.deepEq(C.json(good), { a: 1 }, 'read');
    var msg = null;
    try { C.json(failed(502, 'Bad Gateway')); } catch (e) { msg = e.message; }
    t.eq(msg, 'HTTP 502', 'the status alone');
});

// ---- the reader's files and choices -------------------------------------------------

t.suite('rows per page');
await t.test('the last choice is kept, and anything else is 50', function () {
    var store = {};
    t.eq(C.pageLen(), 50, 'no storage at all');
    page.window.localStorage = { getItem: function (k) { return store[k] === undefined ? null : store[k]; },
                                 setItem: function (k, v) { store[k] = v; } };
    t.eq(C.pageLen(), 50, 'nothing kept yet');
    C.keepPageLen(100);
    t.eq(store['hgPangenome.pageLen'], '100', 'kept under the name both tools read');
    t.eq(C.pageLen(), 100, 'and read back');
    C.keepPageLen(-1);
    t.eq(C.pageLen(), -1, 'All');
    store['hgPangenome.pageLen'] = '7';
    t.eq(C.pageLen(), 50, 'a size the menu does not offer');
    page.window.localStorage = { getItem: function () { throw new Error('blocked'); },
                                 setItem: function () { throw new Error('blocked'); } };
    t.eq(C.pageLen(), 50, 'storage that refuses');
    C.keepPageLen(25);
    t.ok(true, 'and keeping a choice there does not stop the page');
});

t.suite('saving a file');
await t.test('the text is offered under the given name', function () {
    var made = null, revoked = null;
    page.sandbox.URL = { createObjectURL: function (b) { made = b; return 'blob:1'; },
                         revokeObjectURL: function (u) { revoked = u; } };
    var clicked = 0, link = null;
    var realCreate = page.document.createElement;
    page.document.createElement = function (tag) {
        link = realCreate(tag);
        link.click = function () { clicked++; };
        return link;
    };
    C.saveFile('a\tb\n', 'table.tsv', 'text/tab-separated-values');
    page.document.createElement = realCreate;
    t.eq(link.download, 'table.tsv', 'file name');
    t.eq(link.href, 'blob:1', 'pointing at the text');
    t.eq(made.parts[0], 'a\tb\n', 'the text itself');
    t.eq(clicked, 1, 'clicked once');
    t.eq(page.document.body._kids.length, 0, 'and taken off the page again');
    t.ok(revoked === null || revoked === 'blob:1', 'the address is given back');
});

// ---- the scripts as shipped -----------------------------------------------------------
//
// A browser: window is the global object, so a name a script declares at top
// level, or hangs on window, shows up among the context's own keys.

function browser() {
    var listeners = [], nodes = {}, asked = [];
    var ctx = {
        document: {
            readyState: 'loading',
            getElementById: function (id) { return nodes[id] || null; },
            addEventListener: function (ev, fn) { if (ev === 'DOMContentLoaded') { listeners.push(fn); } },
            createElement: loader.makeNode,
            createTextNode: function (s) { var n = loader.makeNode(); n._text = String(s); return n; },
            body: loader.makeNode('body')
        },
        location: { pathname: '/cgi-bin/hgPangenome' },
        sessionStorage: { getItem: function () { return null; }, setItem: function () {} },
        console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
        fetch: function (url, opts) { asked.push({ url: url, opts: opts }); return new Promise(function () {}); }
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    return {
        ctx: ctx, nodes: nodes, asked: asked,
        // Run a script; the names it added to the global scope.
        add: function (file) {
            var before = Object.keys(ctx);
            vm.runInContext(loader.source(file), ctx, { filename: file });
            return Object.keys(ctx).filter(function (k) { return before.indexOf(k) < 0; }).sort();
        },
        ready: function () {
            ctx.document.readyState = 'complete';
            listeners.forEach(function (fn) { fn(); });
        }
    };
}

t.suite('the scripts as shipped');
await t.test('each adds its own name to the page and nothing else', function () {
    var b = browser();
    t.deepEq(b.add('hgPangenomeCommon.js'), ['pangenomeCommon'], 'the shared helpers');
    t.deepEq(b.add('hgPangenomeAssemblies.js'),
             ['pangenomeAssemblies', 'pangenomeAssemblyNames', 'pangenomeGraphNamesDiffer'],
             'the assembly tables');
    t.deepEq(b.add('hgPangenomeSamples.js'), ['pangenomeSamples'], 'the population table');
    t.deepEq(b.add('hgPangenomePclai.js'), ['pangenomePlot'], 'the ancestry plot');
    t.deepEq(b.add('hgPangenomeResults.js'), [], 'the results page');
    t.deepEq(b.add('hgPangenomeConvert.js'), [], 'PanLift');
    t.deepEq(b.add('hgPangenome.js'), [], 'the search form');
});
await t.test('the plot is reached through its one object', function () {
    var b = browser();
    b.add('hgPangenomeCommon.js');
    b.add('hgPangenomePclai.js');
    var plot = b.ctx.pangenomePlot;
    t.deepEq(Object.keys(plot).sort(), ['init', 'isPicked', 'togglePick', 'update'], 'what a page may call');
    t.eq(plot.init([{ id: 'a0', hap: 'HG00097#1' }], { fresh: true, picked: ['HG00097#1'] }), true, 'init');
    t.eq(plot.isPicked('HG00097#1'), true, 'a haplotype picked at the start');
    t.eq(plot.isPicked('HG00099#2'), false, 'one that was not');
    t.eq(plot.isPicked('toString'), false, 'a name every object has');
});
await t.test('the results page starts and asks for its job', function () {
    var b = browser();
    b.nodes.pgrResults = loader.makeNode('div');
    b.ctx.pangenomeJobId = 'job1';
    ['hgPangenomeCommon.js', 'hgPangenomeAssemblies.js', 'hgPangenomeSamples.js',
     'hgPangenomeResults.js'].forEach(b.add);
    t.eq(b.asked.length, 0, 'nothing before the page is ready');
    b.ready();
    t.eq(b.asked.length, 1, 'one request');
    t.eq(b.asked[0].url, '/cgi-bin/hgPangenome?cmd=poll&job_id=job1', 'for the job the page names');
});

await check.wait(20);
t.suite('a request that failed');
await t.test('the page that shows what the server said gets the start of it', function () {
    t.eq(bodyErr, 'HTTP 502: ' + 'x'.repeat(300), 'the status and 300 characters');
    t.eq(emptyErr, 'HTTP 404', 'the status alone when the server said nothing');
    t.deepEq(bodyOk, { a: 1 }, 'an answer is read as JSON');
});
});
