/* plotTests.js - tests for the ancestry plot (js/hgPangenomePclai.js).
 *
 * The plot is shared by PanView's results page and PanLift.  These test what
 * it keeps between one set of regions and the next, how it reads its points
 * in batches, and what it says when it cannot draw.  The file is loaded into
 * a vm with just enough of a document to evaluate; nothing is fetched.
 *
 * Run:  node plotTests.js
 */

'use strict';

var test = require('node:test');
var check = require('./check.js');
var vm = require('vm');
var loader = require('./loadClient.js');

test('The ancestry plot (js/hgPangenomePclai.js)', async function (ctx) {
var t = check.under(ctx);

// The plot's file is loaded without its module wrapper (loadClient.js body()),
// so its functions land on the vm context.  Every element asked for exists,
// and remembers what was put in it.
function loadPlot(fetchStub) {
    var nodes = {};
    var node = function (id) {
        if (!nodes[id]) {
            nodes[id] = { id: id, style: { display: '' }, innerHTML: '', textContent: '',
                          addEventListener: function () {}, querySelector: function () { return null; },
                          appendChild: function (c) { return c; },
                          getBoundingClientRect: function () { return { top: 0, bottom: 0, left: 0, width: 800, height: 600 }; } };
        }
        return nodes[id];
    };
    var ctx = {
        window: { location: { pathname: '/cgi-bin/hgPangenome' }, scrollBy: function () {} },
        document: { getElementById: node, addEventListener: function () {},
                    createElement: function () {
                        return { style: {}, appendChild: function (c) { return c; },
                                 addEventListener: function () {} };
                    } },
        console: console, setTimeout: setTimeout, encodeURIComponent: encodeURIComponent,
        fetch: fetchStub || function () { return new Promise(function () {}); },
        Promise: Promise, Math: Math, JSON: JSON, Object: Object, String: String, Number: Number,
        Array: Array, isNaN: isNaN, parseFloat: parseFloat
    };
    vm.createContext(ctx);
    vm.runInContext(loader.source('hgPangenomeCommon.js'), ctx);
    vm.runInContext(loader.body('hgPangenomePclai.js'), ctx);
    ctx.node = node;
    return ctx;
}

function spots(n, tag) {
    var out = [];
    for (var i = 0; i < n; i++) {
        out.push({ id: 'a' + i, hap: (tag || 'S') + i + '#1', acc: 'GCA_1.1', contig: 'c', start: 0, end: 10,
                   coverage: null, placement: 0, placements: 1 });
    }
    return out;
}

// The spots a request asked about.
function asked(opts) {
    return JSON.parse(decodeURIComponent(/payload=([^&]*)/.exec(opts.body)[1])).spots;
}
function answer(body) {
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(body); } });
}
function pointsFor(list) {
    return list.map(function (s, i) { return { id: s.id, hap: s.hap, x: i / 100, y: 0.1 }; });
}
var PANEL = { points: [[0, 0], [1, 1], [0.5, 0.2]] };

// ---- reading the points in batches -------------------------------------------

var sent1 = [], got1 = null;
var P1 = loadPlot(function (url, opts) {
    var list = asked(opts);
    sent1.push(list.length);
    if (sent1.length === 2) { return answer({ status: 'error', error: 'busy' }); }
    return answer({ status: 'ok', points: pointsFor(list), asked: list.length, found: list.length,
                    panel: sent1.length === 3 ? PANEL : undefined });
});
P1.pgpFetch(spots(250)).then(function (r) { got1 = r; });

var sent2 = [], got2 = null, err2 = null;
var P2 = loadPlot(function (url, opts) {
    var list = asked(opts);
    sent2.push(list.length);
    if (sent2.length === 2) { return Promise.reject(new Error('network')); }
    return answer({ status: 'ok', points: pointsFor(list), asked: list.length, found: list.length, panel: PANEL });
});
P2.pgpFetch(spots(150)).then(function (r) { got2 = r; }, function (e) { err2 = e; });

var sent3 = [], got3 = null;
var P3 = loadPlot(function (url, opts) {
    sent3.push(asked(opts).length);
    return answer({ status: 'error', error: 'pcLAI is off' });
});
P3.pgpFetch(spots(250)).then(function (r) { got3 = r; });

// ---- an answer that comes after the regions have changed ---------------------

var late = {};
var P4 = loadPlot(function () { return new Promise(function (resolve) { late.resolve = resolve; }); });
var first = spots(3, 'OLD'), second = spots(3, 'NEW');
P4.pgpInit(first, { fresh: true });
P4.pgpOpen(first);
// The request goes out a tick after the plot is opened.
await check.wait(5);
P4.pgpInit(second, { fresh: true });
late.resolve({ ok: true, json: function () {
    return Promise.resolve({ status: 'ok', points: pointsFor(first), asked: 3, found: 3, panel: PANEL }); } });

// And one that comes in time, which is drawn.
var P5 = loadPlot(function (url, opts) {
    var list = asked(opts);
    return answer({ status: 'ok', points: pointsFor(list), asked: list.length, found: list.length, panel: PANEL });
});
P5.pgpInit(spots(3), { fresh: true });
P5.pgpOpen(spots(3));

// No reference panel on the server.
var P6 = loadPlot(function (url, opts) {
    var list = asked(opts);
    return answer({ status: 'ok', points: pointsFor(list), asked: list.length, found: list.length });
});
var s6 = spots(3);
P6.pgpInit(s6, { fresh: true });
P6.pgpOpen(s6);

await check.wait(40);
t.suite('reading the points in batches');
await t.test('a later batch that fails is counted, and the rest is kept', function () {
    t.deepEq(sent1, [100, 100, 50], 'three requests for 250 regions');
    t.ok(got1 && got1.status === 'ok', 'there is a plot');
    if (!got1) { return; }
    t.eq(got1.points.length, 150, 'with the points that were read');
    t.eq(got1.failed, 100, 'and the number that were not');
    t.ok(got1.panel, 'the reference panel is taken from the first answer that has it');
});
await t.test('so is one that never arrives', function () {
    t.eq(err2, null, 'the plot is not given up');
    t.ok(got2, 'answered');
    if (!got2) { return; }
    t.eq(got2.points.length, 100, 'the first batch stands');
    t.eq(got2.failed, 50, 'the second is counted as missing');
});
await t.test('when the first fails there is no plot, and nothing more is asked', function () {
    t.deepEq(sent3, [100], 'one request');
    t.eq(got3 && got3.status, 'error', 'and its error is the answer');
});
await t.test('the plot says how many it is missing', function () {
    var x = loadPlot();
    x.pgpInit(spots(3), { legend: { many: 'regions' }, fresh: true });
    x.pgpData = { status: 'ok', failed: 100 };
    t.contains(x.pgpControlsHtml(150, 150, 0), '100 regions could not be read', 'beside its controls');
    x.pgpData = { status: 'ok' };
    t.notOk(/could not be read/.test(x.pgpControlsHtml(150, 150, 0)), 'and nothing when all were');
});
await t.test('a count from the server is written as text, whatever it holds', function () {
    var x = loadPlot();
    x.pgpInit(spots(3), { legend: { many: 'regions' }, fresh: true });
    x.pgpData = { status: 'ok', failed: '<img src=x>' };
    var html = x.pgpControlsHtml(150, 150, 0);
    t.notOk(/<img/.test(html), 'no markup of its own');
    t.contains(html, '&lt;img src=x&gt; regions could not be read', 'shown as it came');
});

t.suite('a new set of regions');
await t.test('nothing opened or read for the last one is kept', function () {
    var x = loadPlot();
    x.pgpInit(spots(3), { fresh: true, picked: ['S0#1'] });
    x.pgpSelected = 'a1';
    x.pgpSelGroup = ['a1', 'a2'];
    x.pgpWindows.a1 = [{ x: 1, y: 1 }];
    x.pgpPicked['S2#1'] = true;
    x.pgpInit(spots(3, 'T'), { fresh: true, picked: ['T0#1'] });
    t.eq(x.pgpSelected, null, 'no detail open');
    t.eq(x.pgpSelGroup, null, 'no group open');
    t.eq(x.pgpWindows.a1, undefined, 'the windows read for the old a1 are gone');
    t.deepEq(Object.keys(x.pgpPicked), ['T0#1'], 'only the new source is ringed');
});
await t.test('more rows of the same table keep what the reader chose', function () {
    // The results page calls again as its table gains rows.
    var x = loadPlot();
    x.pgpInit(spots(3));
    x.pgpSelected = 'a1';
    x.pgpPicked['S2#1'] = true;
    x.pgpInit(spots(5));
    t.eq(x.pgpSelected, 'a1', 'the open detail');
    t.ok(x.pgpPicked['S2#1'], 'and the ticked row');
});
await t.test('an answer for the old regions is dropped', function () {
    t.eq(P4.pgpData, null, 'not taken as the new regions\' points');
    t.notOk(/OLD/.test(P4.node('pgrPclaiPlot').innerHTML), 'and not drawn');
});
await t.test('an answer in time is drawn', function () {
    t.ok(P5.pgpData && P5.pgpData.points.length === 3, 'kept');
    t.contains(P5.node('pgrPclaiPlot').innerHTML, '<svg', 'and drawn');
});

t.suite('no reference panel');
await t.test('the plot says so instead of waiting for ever', function () {
    var html = P6.node('pgrPclaiPlot').innerHTML;
    t.notOk(/Reading ancestry coordinates/.test(html), 'not still reading');
    t.contains(html, 'no pcLAI reference panel', 'the reason');
});

// A plot whose requests wait in "out" until the test answers them.
function heldPlot() {
    var out = [];
    var x = loadPlot(function (url, opts) {
        var list = asked(opts);
        return new Promise(function (resolve, reject) {
            out.push({ spots: list,
                       ok: function () { resolve({ ok: true, json: function () { return Promise.resolve(
                           { status: 'ok', points: pointsFor(list), asked: list.length, found: list.length, panel: PANEL }); } }); },
                       fail: function () { reject(new Error('network')); } });
        });
    });
    return { x: x, out: out, html: function () { return x.node('pgrPclaiPlot').innerHTML; } };
}
function haps(data) { return (data.points || []).map(function (p) { return p.hap; }).join(' '); }

t.suite('the table drawn anew while the plot is being read');
// The results page: the same plot, set up again with the rows of the new
// table, and nothing to say that they are other rows.
await t.test('the answer for the old rows is not taken for the new table\'s', async function () {
    var p = heldPlot(), oldRows = spots(3, 'OLD'), newRows = spots(3, 'NEW');
    p.x.pgpInit(oldRows);
    p.x.pgpOpen(oldRows);
    await check.wait(2);
    p.x.pgpInit(newRows);
    p.x.pgpOpen(newRows);
    await check.wait(2);
    t.eq(p.out.length, 2, 'each table asked for its own rows');
    p.out[1].ok();
    await check.wait(2);
    t.contains(haps(p.x.pgpData), 'NEW0#1', 'the new rows are plotted');
    p.out[0].ok();
    await check.wait(2);
    t.notOk(/OLD/.test(haps(p.x.pgpData)), 'and the old ones do not take their place');
    t.eq(p.out.length, 2, 'nor is anything asked again to put that right');
});
await t.test('nor does its failure take the plot away', async function () {
    var p = heldPlot(), oldRows = spots(3, 'OLD'), newRows = spots(3, 'NEW');
    p.x.pgpInit(oldRows);
    p.x.pgpOpen(oldRows);
    await check.wait(2);
    p.x.pgpInit(newRows);
    p.x.pgpOpen(newRows);
    await check.wait(2);
    p.out[1].ok();
    await check.wait(2);
    p.out[0].fail();
    await check.wait(2);
    t.contains(p.html(), '<svg', 'the plot is still drawn');
    t.notOk(/Could not load/.test(p.html()), 'with no error over it');
});
await t.test('more rows asked for before the table was drawn anew are not added to the new plot', async function () {
    var p = heldPlot(), oldRows = spots(3, 'OLD');
    p.x.pgpInit(oldRows);
    p.x.pgpOpen(oldRows);
    await check.wait(2);
    p.out[0].ok();
    await check.wait(2);
    p.x.pgpUpdate(spots(5, 'OLD'));
    await check.wait(2);
    t.eq(p.out.length, 2, 'the two new rows are asked about');
    p.x.pgpInit(spots(3, 'NEW'));
    p.out[1].ok();
    await check.wait(2);
    t.eq(p.x.pgpData, null, 'the new table\'s plot has nothing read yet');
    t.eq(p.x.pgpSpots[0].hap, 'NEW0#1', 'and its own rows to read');
});
await t.test('a second click while it is being read does not ask a second time', async function () {
    var p = heldPlot(), rows = spots(3);
    p.x.pgpInit(rows);
    p.x.pgpOpen(rows);
    p.x.pgpOpen(rows);
    await check.wait(2);
    t.eq(p.out.length, 1, 'one request');
    p.out[0].fail();
    await check.wait(2);
    t.contains(p.html(), 'Could not load the ancestry plot', 'a failure is said');
    p.x.pgpOpen(rows);
    await check.wait(2);
    t.eq(p.out.length, 2, 'and opening it again asks again');
});

t.suite('more rows that could not be read');
await t.test('the plot stays, in use, and says how many it is missing', async function () {
    var p = heldPlot(), rows = spots(3);
    p.x.pgpInit(rows, { legend: { many: 'haplotypes' } });
    p.x.pgpOpen(rows);
    await check.wait(2);
    p.out[0].ok();
    await check.wait(2);
    p.x.pgpUpdate(spots(5));
    await check.wait(2);
    p.out[1].fail();
    await check.wait(2);
    t.ok(p.x.pgpData, 'what was read is kept');
    t.eq(p.x.pgpData.points.length, 3, 'its three points');
    t.eq(p.x.pgpData.failed, 2, 'and the two that were not read are counted');
    t.contains(p.html(), '<svg', 'the plot is drawn');
    t.contains(p.html(), '2 haplotypes could not be read', 'and says so');
    p.x.pgpUpdate(spots(5));
    await check.wait(2);
    t.eq(p.out.length, 2, 'they are not asked about again for the same table');
});
});
