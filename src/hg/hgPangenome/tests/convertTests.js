/* convertTests.js - tests for the coordinate-conversion page
 * (js/hgPangenomeConvert.js).
 *
 * Covers position parsing, the assembly <-> haplotype lookups, the request the
 * page sends, and how 0..N translated intervals are rendered - including the
 * empty case, per-piece strand, and links into the target haplotype's own
 * assembly.  Deterministic: canned middleware responses, no network.
 *
 * Run:  node convertTests.js
 */

'use strict';

var t = require('./testLib.js');
var loader = require('./loadClient.js');

var PAGE_IDS = ['pgcForm', 'pgcSrcHap', 'pgcSrcDb', 'pgcSrcNote', 'pgcSrcLabel',
                'pgcPos', 'pgcFilter',
                'pgcTargetCount', 'pgcTargets', 'pgcSubmit', 'pgcClear',
                'pgcReachableOnly',
                'pgcStatus', 'pgcResults', 'pgcQuickLift', 'pgcHideTracks',
                'pgcChosen', 'pgcPops', 'pgcHaps'];

// Load the convert page's client with a stubbed fetch.
function startPage(opts) {
    opts = opts || {};
    var calls = [];
    var c = loader.load({
        script: 'hgPangenomeConvert.js',
        ids: PAGE_IDS.concat(opts.extraIds || []),
        readyState: 'loading',
        fetch: function (url, o) {
            calls.push({ url: String(url), opts: o });
            var u = String(url), b = (o && o.body) || '';
            var body;
            if (u.indexOf('cmd=contigs') >= 0)
                // Both spellings, as the real endpoint returns: these hubs set
                // "chromAuthority ucsc", so the browser shows chr1 where the
                // graph says CM094060.1.
                body = opts.contigs || { contigs: [
                    { name: 'CM094060.1', display: 'chr1', size: 251561931 },
                    { name: 'CM094061.1', display: 'chr2', size: 242754100 },
                    { name: 'CM094066.1', display: 'chr7', size: 134577915 },
                    { name: 'JBIREP010000009.1',
                      display: 'chrUn_JBIREP010000009v1', size: 133758036 } ] };
            else if (u.indexOf('cmd=haplotypes') >= 0)
                body = opts.haplotypes || { haplotypes: ['GRCh38#0', 'CHM13#0',
                                            'HG00097#1', 'HG00097#2', 'HG01234#2'] };
            else if (b.indexOf('cmd=liftoverTargets') >= 0)
                // deliberately lower-cased, as the published contract shows
                body = opts.targets || { haplotypes: ['chm13#0', 'hg01234#2'] };
            else
                body = opts.liftover || { intervals: [] };
            return Promise.resolve({
                ok: true, status: 200,
                json: function () { return Promise.resolve(body); },
                text: function () { return Promise.resolve(JSON.stringify(body)); }
            });
        }
    });
    c.el.pgcSrcDb.value = opts.db === undefined ? 'GCA_044165215.1' : opts.db;
    if (opts.position !== undefined) c.el.pgcPos.value = opts.position;
    else if (opts.db === undefined) c.el.pgcPos.value = 'CM094066.1:1-100';
    c.window.pangenomeConfig = {
        maxLiftSpan: 10000000,
        defaultSrcDb: 'hs1',
        defaultPosition: 'chr9:145458455-145495201',
        defaultTarget: 'grch38#0',
        minTargetCoverage: 10,
        maxLiftTargets: 3,
    };
    Object.keys(opts.config || {}).forEach(function (k) {
        c.window.pangenomeConfig[k] = opts.config[k];
    });
    c.fireReady();
    c.calls = calls;
    return c;
}

function text(c) { return c.el.pgcResults.textContent.replace(/\s+/g, ' '); }
function links(c) {
    return c.findAll(c.el.pgcResults, function (n) {
        return n.tagName === 'A' && (n.getAttribute('href') || '').indexOf('hgTracks') >= 0;
    });
}

var page = startPage();
var pg = page.api;

// ---- populations in the target picker ---------------------------------------

t.suite('populations');
t.test("a sample's population is the HPRC's own description", function () {
    t.eq(JSON.stringify(pg.samplePop('HG00097#1')),
         JSON.stringify({ code: 'GBR', desc: 'British from England and Scotland' }), 'GBR');
    t.eq(pg.samplePop('hg00097#2').code, 'GBR', 'either phase, any case');
    t.eq(pg.samplePop('HG002#1'), null, 'HG002 has none given');
    t.eq(pg.samplePop('GRCh38#0'), null, 'nor the references');
    t.contains(pg.samplePop('HG02572#1').desc, 'Western Division \u2013 Mandinka', 'the mis-encoded dash repaired');
});
t.test('groups: the references, then populations by name, then none given', function () {
    var g = pg.popGroups(['HG002#1', 'HG02572#1', 'GRCh38#0', 'HG00097#1', 'HG00097#2', 'CHM13#0']);
    t.eq(g.map(function (x) { return x.key; }).join(','), '~ref,GBR,GWD,~none', 'order');
    t.eq(g[1].haps.length, 2, 'both phases of a sample together');
    t.eq(g[1].label, 'British from England and Scotland (GBR)', 'labelled by name and code');
    t.eq(g[3].label, 'No population given', 'HG002');
});
var picker = startPage();
setTimeout(function () {
    t.suite('populations: the picker');
    var api = picker.api, el = picker.el;
    // The haplotype boxes in the right pane, as "name:checked".
    function boxes() {
        return picker.findAll(el.pgcHaps, function (n) { return n.tagName === 'INPUT'; })
            .map(function (n) { return n.getAttribute('data-hap') + (n.checked ? ':on' : ''); });
    }
    function popRows() {
        return picker.findAll(el.pgcPops, function (n) { return n.tagName === 'BUTTON'; })
            .map(function (n) { return n.getAttribute('data-pop'); });
    }
    api.fillTargets('');
    t.test('the left pane lists all, then the groups in order', function () {
        t.eq(popRows().join(','), ',~ref,GBR,~none', 'All, references, GBR, none given');
        t.contains(el.pgcPops.textContent, '1 population', 'counted');
        t.contains(el.pgcPops.textContent, 'British from England and Scotland', 'by name');
    });
    t.test('the right pane lists every candidate, the default chosen', function () {
        t.eq(boxes().join(','), 'CHM13#0,GRCh38#0:on,HG00097#2,HG01234#2', 'source excluded, GRCh38 ticked');
        t.contains(el.pgcChosen.textContent, 'Chosen 1', 'and as a chip');
        t.notOk(/ of 3/.test(el.pgcChosen.textContent), 'no limit stated');
    });
    t.test('a box chooses, a chip lets go, and the hidden list follows', function () {
        api.setChosen('HG00097#2', true);
        t.eq(api.selectedTargets().sort().join(','), 'GRCh38#0,HG00097#2', 'chosen');
        t.contains(el.pgcChosen.textContent, 'HG00097', 'a chip for it');
        t.contains(el.pgcChosen.textContent, 'GBR', 'with its population');
        api.setChosen('GRCh38#0', false);
        t.eq(api.selectedTargets().join(','), 'HG00097#2', 'let go');
    });
    t.test('a population on the left narrows the right pane, and the choice survives', function () {
        api.setPopFilter('~ref');
        api.fillTargets('');
        t.eq(boxes().join(','), 'CHM13#0,GRCh38#0', 'references only');
        t.eq(api.selectedTargets().join(','), 'HG00097#2', 'HG00097#2 still chosen');
        t.contains(el.pgcHaps.textContent, 'Reference assemblies', 'the pane says which');
        api.setPopFilter(null);
    });
    t.test('the search matches a name or a population, and keeps the choice', function () {
        api.fillTargets('british');
        t.eq(boxes().join(','), 'HG00097#2:on', 'by population name');
        api.fillTargets('gbr');
        t.eq(boxes().join(','), 'HG00097#2:on', 'by code');
        api.fillTargets('zzz');
        t.contains(el.pgcHaps.textContent, 'No haplotype matches', 'says so when nothing does');
        t.eq(api.selectedTargets().join(','), 'HG00097#2', 'still chosen');
        api.fillTargets('');
    });
    t.test('past the per-request size nothing is disabled: there is no limit', function () {
        api.setChosen('CHM13#0', true);
        api.setChosen('HG01234#2', true);
        var dis = picker.findAll(el.pgcHaps, function (n) { return n.tagName === 'INPUT' && n.disabled; });
        t.eq(dis.length, 0, 'every box can still be ticked');
        t.contains(el.pgcChosen.textContent, 'Chosen 3', 'count');
    });
    t.test('the pane offers every haplotype it shows in one click', function () {
        var btn = picker.findAll(el.pgcHaps, function (n) { return n.getAttribute && n.getAttribute('data-all'); })[0];
        t.ok(!!btn, 'a Choose all button');
        t.contains(btn ? btn.textContent : '', 'Choose all', 'worded so');
    });
    t.test('with all populations shown, each name carries its code', function () {
        t.contains(el.pgcHaps.textContent, 'HG00097 hap2GBR', 'code beside the name');
    });
    t.test('Clear lets every target go and keeps the source', function () {
        var pos = el.pgcPos.value;
        t.ok(api.selectedTargets().length > 0, 'something chosen first');
        el.pgcFilter.value = 'gbr';
        el.pgcClear.dispatch('click');
        t.eq(api.selectedTargets().length, 0, 'nothing chosen');
        t.contains(el.pgcChosen.textContent, 'Choose target assemblies', 'no chips');
        t.notOk(picker.findAll(el.pgcPops, function (n) {
            return n.className === 'pgcPopPicked'; }).length, 'no chosen counts by the populations');
        t.eq(el.pgcFilter.value, '', 'the search emptied');
        t.eq(el.pgcPos.value, pos, 'the source position kept');
        t.ok(!!pos, 'and it is not empty');
    });
}, 40);

// ================================================= blocks (annotation lifting)
//
// With blocks:true the server sends block-level correspondence instead of
// intervals.  The page has to split those per target haplotype (each becomes
// its own chain) and still be able to draw the ordinary result cards.

// ---- ancestry plot (pcLAI) -------------------------------------------------
t.suite('ancestry plot');
t.test('the plot is offered for the HPRC regions, with no ancestry read until it opens', function () {
    var c = startPage();
    var given = null;
    c.sandbox.pangenomePclai = { on: 1 };
    c.sandbox.pgpPicked = {};
    c.sandbox.pgpInit = function (spots, opts) { given = { spots: spots, opts: opts }; return true; };
    var acts = c.sandbox.document.createElement('span');
    var spots = c.api.ancPlot(acts, [
        { role: 'source', hap: 'HG00097#1', db: 'GCA_018466835.2', contig: 'CM1', start: 0, end: 10 },
        { role: 'target', hap: 'GRCh38#0', db: 'hg38', contig: 'chr1', start: 0, end: 10 },
        { role: 'target', hap: 'HG00099#2', db: 'GCA_018466845.2', contig: 'CM2', start: 5, end: 15 }]);
    t.eq(spots.length, 2, 'GRCh38 left out: it has no pcLAI');
    t.eq(given.spots.length, 2, 'handed to the plot');
    t.ok(!given.opts.data, 'no answer handed over: the plot reads its own when opened');
    t.ok(c.sandbox.pgpPicked['HG00097#1'], 'the source is ringed');
    t.eq(acts._kids.length, 1, 'one button');
    t.eq(acts._kids[0].textContent, 'Show ancestry plot', 'labelled as on the mapping page');
    t.eq(c.calls.filter(function (x) { return /cmd=pclai/.test((x.opts && x.opts.body) || x.url); }).length, 0,
         'nothing asked of pcLAI yet');
});
t.test('no plot with pcLAI off, or with fewer than two regions to plot', function () {
    var c = startPage();
    c.sandbox.pgpInit = function () { return true; };
    var acts = c.sandbox.document.createElement('span');
    var two = [{ role: 'source', hap: 'HG00097#1', db: 'GCA_018466835.2' },
               { role: 'target', hap: 'HG00099#2', db: 'GCA_018466845.2' }];
    t.eq(c.api.ancPlot(acts, two), null, 'off');
    c.sandbox.pangenomePclai = { on: 1 };
    c.sandbox.pgpPicked = {};
    t.eq(c.api.ancPlot(acts, two.slice(0, 1)), null, 'one region');
    t.eq(acts._kids.length, 0, 'and no button');
});

t.suite('every haplotype at once (page=liftAll)');
function piece(contig, start, end, strand, ss, se) {
    return { contig: contig, start: start, end: end, strand: strand,
             source_start: ss, source_end: se };
}
t.test('overlapping pieces on one contig and strand are one place', function () {
    var A = startPage().api;
    // The shape the service sends in a duplicated region: one real piece, then
    // a run of single source bases landing on the same stretch.
    var flood = [piece('c1', 100, 900, '+', 0, 600)];
    for (var i = 0; i < 300; i++) flood.push(piece('c1', 500 + i, 900 + i, '+', 600 + i, 601 + i));
    var m = A.mergePieces(flood);
    t.eq(m.length, 1, 'one piece');
    t.eq(m[0].start, 100, 'from the first start');
    t.eq(m[0].end, 1199, 'to the last end');
    t.eq(m[0].source_end, 900, 'covering all the source');
    t.eq(m[0].merged, 301, 'and saying how many it stands for');
    var kept = A.mergePieces([piece('c1', 0, 10, '+', 0, 10), piece('c1', 10, 20, '+', 10, 20),
                              piece('c1', 5, 15, '-', 20, 30), piece('c2', 5, 15, '+', 30, 40)]);
    t.eq(kept.length, 4, 'abutting, other strand, other contig: all kept apart');
});
t.test('one entry per haplotype: bases, size change, shape; the source left out', function () {
    var A = startPage().api;
    A.setAllSrcHap('CHM13#0');
    var h = A.allHapsFrom([
        { haplotype: 'CHM13#0', pieces: [], mapped_bp: 0 },
        { haplotype: 'HG00097#1', pieces: [piece('c1', 1000, 1950, '+', 0, 1000)], mapped_bp: 950 },
        { haplotype: 'HG00097#2', pieces: [piece('c2', 0, 400, '+', 600, 1000),
                                          piece('c2', 900, 1500, '-', 0, 600)], mapped_bp: 1000 },
        { haplotype: 'HG01234#2', pieces: [], mapped_bp: 0 }], 1000);
    t.eq(h.length, 3, 'the source is not listed');
    t.deepEq(h.map(function (x) { return x.hap; }), ['HG00097#2', 'HG00097#1', 'HG01234#2'],
             'most of the region first');
    t.eq(h[0].pieces[0].source_start, 0, 'pieces largest first');
    t.ok(h[0].reverse, 'a reversed piece is noticed');
    t.eq(h[1].bases, 95, 'bases as a share of the region');
    t.eq(h[1].change, -50, '50 bp shorter here');
    t.eq(h[2].change, null, 'no size where nothing carried over');
    t.eq(h[1].inserted, 0, 'nothing here without a source base');
    t.eq(h[1].deleted, 50, '50 source bases with no place');
    t.eq(h[0].inserted, 0, 'two pieces, every base placed: nothing inserted');
    t.eq(h[0].deleted, 0, 'and nothing deleted');
    t.eq(h[2].inserted, null, 'nothing to count where it did not carry over');
});
t.test('a gain and a loss of the same size show apart, though the net is nothing', function () {
    var A = startPage().api;
    A.setAllSrcHap('CHM13#0');
    // 1000 source bases, 900 placed: 100 deleted; 1000 bases here, so 100 inserted.
    var h = A.allHapsFrom([{ haplotype: 'HG00097#1', pieces: [piece('c1', 0, 1000, '+', 0, 1000)],
                             mapped_bp: 900 }], 1000);
    t.eq(h[0].change, 0, 'net nothing');
    t.eq(h[0].inserted, 100, '100 inserted');
    t.eq(h[0].deleted, 100, '100 deleted');
    // A duplicated region: both copies carry the same source, counted once.
    var d = A.allHapsFrom([{ haplotype: 'HG00097#1', mapped_bp: 1000,
        pieces: [piece('c1', 0, 1000, '+', 0, 1000), piece('c1', 5000, 6000, '+', 0, 1000)] }], 1000);
    t.eq(d[0].deleted, 0, 'the source is covered once');
    t.eq(d[0].inserted, 1000, 'the second copy is a gain');
    t.eq(A.unionLength([[0, 10], [5, 20], [30, 40]]), 30, 'overlaps counted once');
    t.eq(A.unionLength([]), 0, 'nothing covers nothing');
});
t.test('rows are filtered on any figure, every filter at once', function () {
    var A = startPage().api;
    var m = function (k) { return A.allMetrics.filter(function (x) { return x.key === k; })[0]; };
    var row = function (bases, ins, change) {
        return { h: { bases: bases, inserted: ins, deleted: 0, pieces: [1] }, span: bases, change: change };
    };
    A.setMetricFilters([{ metric: m('coverage'), op: 'below', value: 50 }]);
    t.ok(A.metricKeeps(row(20, 0, 0)), 'coverage below 50 keeps 20%');
    t.ok(!A.metricKeeps(row(50, 0, 0)), 'and drops 50%');
    A.setMetricFilters([{ metric: m('coverage'), op: 'min', value: 90 },
                        { metric: m('inserted'), op: 'min', value: 100 }]);
    t.ok(A.metricKeeps(row(95, 150, 0)), 'both met');
    t.ok(!A.metricKeeps(row(95, 50, 0)), 'one missed');
    t.ok(!A.metricKeeps(row(95, null, 0)), 'an unclear figure is not kept');
    A.setMetricFilters([]);
    t.ok(A.metricKeeps(row(0, null, null)), 'no filters keep everything');
});
t.test('a size from hundreds of merged pieces is not a size', function () {
    var A = startPage().api;
    A.setAllSrcHap('CHM13#0');
    var flood = [piece('c1', 0, 600, '+', 0, 600)];
    for (var i = 0; i < 100; i++) flood.push(piece('c1', 300, 900000, '+', 600 + i, 601 + i));
    var h = A.allHapsFrom([{ haplotype: 'HG00097#1', pieces: flood, mapped_bp: 700 }], 1000);
    t.ok(h[0].unsure, 'flagged');
    t.eq(h[0].change, null, 'and kept out of the size figures');
});
t.test('size changes read as signed lengths', function () {
    var A = startPage().api;
    t.eq(A.fmtChange(0), '0 bp', 'none');
    t.eq(A.fmtChange(312), '+312 bp', 'gain');
    t.eq(A.fmtChange(-6104), '−6,104 bp', 'loss, with a minus sign');
    t.eq(A.niceStep(98.6), 100, 'histogram steps are round');
    t.eq(A.niceStep(13), 20, '1, 2 or 5 times a power of ten');
});
t.test('the page is named by the source path and interval', function () {
    var c = startPage();
    c.window.pangenomeConfig.hgsid = 'SID1';
    var u = c.api.liftAllUrl({ src: 'HG00097#1#CM094066.1', start: 100, end: 200 });
    t.contains(u, 'page=liftAll&src=HG00097%231%23CM094066.1&start=100&end=200', 'source and interval');
    t.contains(u, 'hgsid=SID1', 'and the cart');
});

t.suite('block-level liftover responses');

t.test('blocks are split by target haplotype, lower-cased', function () {
    var g = pg.groupBlocks([
        { haplotype: 'HG00235#2#CM094399.1', source_start: 0, source_end: 10,
          target_start: 100, target_end: 110, strand: '+' },
        { haplotype: 'HG00235#2#JBHIKM010000010.1', source_start: 20, source_end: 30,
          target_start: 5, target_end: 15, strand: '+' },
        { haplotype: 'HG00097#1#CM090084.1', source_start: 0, source_end: 5,
          target_start: 7, target_end: 12, strand: '-' }
    ]);
    t.eq(Object.keys(g).length, 2, 'two haplotypes');
    t.eq(g['hg00235#2'].length, 2, 'both contigs stay with their haplotype');
    t.eq(g['hg00097#1'].length, 1, 'the other haplotype is separate');
});

t.test('a haplotype with no contig field is ignored, not crashed on', function () {
    var g = pg.groupBlocks([{ haplotype: 'bogus', target_start: 1, target_end: 2 }]);
    t.eq(Object.keys(g).length, 0, 'dropped');
});

t.test('blocks collapse back into one interval per contig and strand', function () {
    var iv = pg.blocksAsIntervals([
        { haplotype: 'HG00235#2#CM094399.1', target_start: 133234194,
          target_end: 133234924, strand: '+' },
        { haplotype: 'HG00235#2#CM094399.1', target_start: 133234925,
          target_end: 133234948, strand: '+' },
        { haplotype: 'HG00235#2#CM094399.1', target_start: 133235057,
          target_end: 133235189, strand: '+' }
    ]);
    t.eq(iv.length, 1, 'one interval');
    t.eq(iv[0].start, 133234194, 'spans from the first block');
    t.eq(iv[0].end, 133235189, 'to the last');
});

t.test('the collapsed interval records how much actually aligned', function () {
    // the real HG02486 case: four blocks with a 19.8kb hole between them, so
    // the outer span is more than twice what carries over
    var iv = pg.blocksAsIntervals([
        { haplotype: 'HG02486#1#CM088192.1', target_start: 140243497,
          target_end: 140244117, strand: '+' },
        { haplotype: 'HG02486#1#CM088192.1', target_start: 140244118,
          target_end: 140254763, strand: '+' },
        { haplotype: 'HG02486#1#CM088192.1', target_start: 140274595,
          target_end: 140278498, strand: '+' },
        { haplotype: 'HG02486#1#CM088192.1', target_start: 140278498,
          target_end: 140280255, strand: '+' }
    ]);
    t.eq(iv.length, 1, 'one interval');
    t.eq(iv[0].end - iv[0].start, 36758, 'span covers the whole extent');
    t.eq(iv[0].mapped, 16925, 'aligned bases exclude the hole');
    t.eq(iv[0].pieces, 4, 'and it remembers how many pieces');
});

t.test('a gapless region reports mapped equal to its span', function () {
    var iv = pg.blocksAsIntervals([
        { haplotype: 'HG00235#2#CM094399.1', target_start: 100,
          target_end: 200, strand: '+' },
        { haplotype: 'HG00235#2#CM094399.1', target_start: 200,
          target_end: 350, strand: '+' }
    ]);
    t.eq(iv[0].mapped, iv[0].end - iv[0].start, 'nothing is missing');
    t.eq(iv[0].pieces, 2, 'two blocks');
});

t.test('a strand flip is reported as its own interval', function () {
    var iv = pg.blocksAsIntervals([
        { haplotype: 'HG00235#2#CM094399.1', target_start: 10, target_end: 20, strand: '+' },
        { haplotype: 'HG00235#2#CM094399.1', target_start: 30, target_end: 40, strand: '-' }
    ]);
    t.eq(iv.length, 2, 'not merged across an inversion');
});

t.test('blocks that run backwards on the target still report their full span',
       function () {
    // Duplications and transpositions really do come back out of order.
    var iv = pg.blocksAsIntervals([
        { haplotype: 'HG00128#1#CM090084.1', target_start: 5000,
          target_end: 5100, strand: '+' },
        { haplotype: 'HG00128#1#CM090084.1', target_start: 1000,
          target_end: 1100, strand: '+' }
    ]);
    t.eq(iv.length, 1, 'one contig, one interval');
    t.eq(iv[0].start, 1000, 'minimum wins regardless of arrival order');
    t.eq(iv[0].end, 5100, 'maximum wins');
});

t.test('no blocks yields no intervals', function () {
    t.eq(pg.blocksAsIntervals([]).length, 0, 'empty');
    t.eq(pg.blocksAsIntervals(null).length, 0, 'missing');
});

// ============================================================ position parsing

t.suite('position parsing (browser 1-based in, half-open out)');

t.test('a plain range converts to 0-based half-open', function () {
    t.deepEq(pg.parsePosition('chr10:19114-19137'),
             { contig: 'chr10', start: 19113, end: 19137 }, 'chr10');
});

t.test('commas and surrounding whitespace are accepted', function () {
    t.deepEq(pg.parsePosition('  chr10:19,114-19,137  '),
             { contig: 'chr10', start: 19113, end: 19137 }, 'as pasted from the browser');
});

t.test('accession-style contigs work', function () {
    t.deepEq(pg.parsePosition('CM094066.1:100-200'),
             { contig: 'CM094066.1', start: 99, end: 200 }, 'accession');
});

t.test('a single base is a legal one-base range', function () {
    t.deepEq(pg.parsePosition('chr1:5-5'), { contig: 'chr1', start: 4, end: 5 }, 'one base');
});

t.test('empty input asks for a position', function () {
    t.contains(pg.parsePosition('').error, 'enter a position', 'empty');
    t.contains(pg.parsePosition('   ').error, 'enter a position', 'whitespace');
});

t.test('a contig with no range is explained, with an example', function () {
    var e = pg.parsePosition('chr10').error;
    t.contains(e, 'add a range', 'guidance');
    t.contains(e, 'chr10:1-1000', 'concrete example');
});

t.test('unparseable text is reported verbatim', function () {
    t.contains(pg.parsePosition('not a position').error, 'could not read', 'message');
});

t.test('a reversed or zero range is rejected', function () {
    t.contains(pg.parsePosition('chr1:200-100').error, 'end must not be before start', 'reversed');
    t.contains(pg.parsePosition('chr1:0-100').error, 'start must be 1 or greater', 'zero start');
});

t.test('a region past the span cap is rejected with both numbers', function () {
    var e = pg.parsePosition('chr1:1-10000001').error;
    t.contains(e, '10000001 bp', 'actual size');
    t.contains(e, 'limit is 10000000', 'limit');
});

t.test('exactly at the cap is accepted', function () {
    t.deepEq(pg.parsePosition('chr1:1-10000000'),
             { contig: 'chr1', start: 0, end: 10000000 }, 'boundary');
});

// ==================================================== assembly <-> haplotype

t.suite('assembly and haplotype lookups');

t.test('a GenArk assembly resolves to its haplotype', function () {
    t.eq(pg.hapForDb('GCA_044165215.1'), 'hg00097#1', 'HG00097 hap1');
    t.eq(pg.hapForDb('GCA_044164745.1'), 'hg00097#2', 'HG00097 hap2');
});

t.test('reference assemblies resolve too', function () {
    t.eq(pg.hapForDb('hs1'), 'chm13#0', 'hs1');
    t.eq(pg.hapForDb('hg38'), 'grch38#0', 'hg38');
});

t.test('an assembly outside the pangenome has no haplotype', function () {
    t.isNull(pg.hapForDb('mm39'), 'mouse');
    t.isNull(pg.hapForDb(''), 'empty');
});

t.test('haplotype -> assembly is the inverse', function () {
    t.eq(pg.assemblyForHap('hg00097#1'), 'GCA_044165215.1', 'round trip');
    t.eq(pg.assemblyForHap('CHM13#0'), 'hs1', 'case-insensitive');
});

// ================================================================ page wiring
//
// The destination list is fetched from the graph, so everything below runs
// after that promise settles.

function convert(c, position, targets) {
    c.el.pgcPos.value = position;
    c.el.pgcTargets.children.forEach(function (o) {
        o.selected = targets.indexOf(o.value || o.textContent) >= 0;
    });
    c.el.pgcSubmit.dispatch('click');
    return c;
}

function posts(c) { return c.calls.filter(function (x) { return x.opts.method === 'POST'; }); }

function payloadOf(c) {
    var p = posts(c);
    return p.length === 0 ? null
         : JSON.parse(decodeURIComponent(p[0].opts.body.split('payload=')[1]));
}

var tooMany = startPage();
var c0 = tooMany;
var atLimit = startPage();
var badContig = startPage();
var altSource = startPage();
var altSource2 = startPage();
var nonPangenome = startPage({ db: 'mm39', position: '' });
var noContext = startPage({ db: '', position: '' });
var noPosition = startPage({ db: 'GCA_044165215.1', position: '' });
// An assembly served through a hub reaches the cart decorated: hs1 is
// "hub_25071_hs1" from the curated hub.  The regression this guards: the page
// did not recognise the decorated name, decided nothing usable was carried
// over, and replaced the position the user asked about with its own example.
var hubDecorated = startPage({ db: 'hub_25071_hs1',
                               position: 'chr10:42477211-42540362' });
// HG01234#2 rather than a name the stub graph does not list: the point is the
// guard, and an absent target would make both tests pass for the wrong reason.
var hubHandoff = startPage({ db: 'hub_25071_hs1',
                             position: 'chr10:42477211-42540362',
                             config: { presetTarget: 'HG01234#2' } });
var exampleHandoff = startPage({ db: 'hub_25071_hs1', position: '',
                                 config: { presetTarget: 'HG01234#2' } });
// The SV page hands over several targets at once, comma separated, and may
// include the source itself, which is dropped.
var svHandoff = startPage({ db: 'hub_25071_hs1',
                            position: 'chr10:42477211-42540362',
                            config: { presetTarget: 'HG01234#2,GRCh38#0,CHM13#0' } });

setTimeout(function () {
    t.suite('page setup');

    t.test('the source haplotype is shown for the inherited assembly', function () {
        t.eq(page.el.pgcSrcHap.value, 'HG00097#1', 'inherited assembly selects its haplotype');
        t.contains(page.el.pgcSrcNote.textContent, 'GCA_044165215.1', 'assembly named');
    });

    t.suite('a usable default when nothing usable was carried over');

    t.test('no context at all falls back to the configured example', function () {
        t.eq(noContext.el.pgcSrcDb.value, 'hs1', 'default assembly');
        t.eq(noContext.el.pgcPos.value, 'chr9:145458455-145495201', 'default position');
        t.eq(noContext.el.pgcSrcHap.value, 'CHM13#0', 'resolves to a real haplotype');
        t.contains(noContext.el.pgcSrcNote.textContent, 'starting example', 'says it is an example');
        t.contains(noContext.el.pgcSrcNote.textContent, 'no assembly was carried over', 'and why');
    });

    t.test('a non-pangenome assembly falls back and says so', function () {
        t.eq(nonPangenome.el.pgcSrcDb.value, 'hs1', 'switched to the default');
        t.contains(nonPangenome.el.pgcSrcNote.textContent, 'not part of the pangenome', 'reason');
    });

    t.test('a pangenome assembly with no position keeps the assembly', function () {
        // Only the missing half is filled in.  Moving the assembly as well
        // would answer about a different genome than the one asked for.
        t.eq(noPosition.el.pgcSrcDb.value, 'GCA_044165215.1', 'assembly kept');
        t.eq(noPosition.el.pgcPos.value, 'chr9:145458455-145495201', 'position filled in');
        t.contains(noPosition.el.pgcSrcNote.textContent, 'no position was carried over', 'reason');
    });

    t.test('a hub-decorated assembly is recognised, and the position is untouched',
           function () {
        t.eq(hubDecorated.el.pgcPos.value, 'chr10:42477211-42540362',
             'the position asked about, not the example');
        t.eq(hubDecorated.el.pgcSrcHap.value, 'CHM13#0',
             'hub_25071_hs1 resolves to CHM13');
        t.notOk(/starting example/.test(hubDecorated.el.pgcSrcNote.textContent),
                'and nothing claims it is an example');
    });

    t.test('the hand-off converts the region it was given', function () {
        var reqs = hubHandoff.calls.filter(function (c) {
            return String((c.opts && c.opts.body) || '').indexOf('cmd=liftover') >= 0;
        });
        t.eq(reqs.length, 1, 'auto-submitted once');
        var payload = decodeURIComponent(String(reqs[0].opts.body));
        t.contains(payload, '42477210', 'chr10 start, 0-based');
        t.notOk(/145458454|145458455/.test(payload), 'not the example region on chr9');
    });

    t.test('several targets handed over are all chosen, the source left out', function () {
        var reqs = svHandoff.calls.filter(function (c) {
            return String((c.opts && c.opts.body) || '').indexOf('cmd=liftover') >= 0;
        });
        t.eq(reqs.length, 1, 'auto-submitted once');
        var payload = decodeURIComponent(String(reqs[0] && reqs[0].opts.body));
        t.contains(payload, 'HG01234#2', 'first target');
        t.contains(payload, 'GRCh38#0', 'second target');
        t.notOk(/"tgts?":[^\]]*CHM13#0/i.test(payload), 'not the source');
    });

    t.test('an example position is never auto-converted', function () {
        // Filling the field in is a convenience; converting it and heading the
        // answer "Converted from ..." is a wrong answer to the question asked.
        var reqs = exampleHandoff.calls.filter(function (c) {
            return String((c.opts && c.opts.body) || '').indexOf('cmd=liftover') >= 0;
        });
        t.eq(reqs.length, 0, 'no conversion ran');
        t.eq(exampleHandoff.el.pgcPos.value, 'chr9:145458455-145495201',
             'the example is offered, not acted on');
    });

    t.test('a complete inherited source is left alone', function () {
        t.eq(page.el.pgcSrcDb.value, 'GCA_044165215.1', 'assembly kept');
        t.eq(page.el.pgcSrcHap.value, 'HG00097#1', 'haplotype kept');
        t.notOk(/starting example/.test(page.el.pgcSrcNote.textContent), 'no example note');
    });

    t.test('the default target is pre-selected, so the page is one click from an answer',
           function () {
        var chosen = noContext.el.pgcTargets.children.filter(function (o) { return o.selected; })
                        .map(function (o) { return o.textContent; });
        t.deepEq(chosen, ['GRCh38'], 'default target selected');
    });

    t.test('haplotypes are fetched from the graph, not a static list', function () {
        var haps = page.calls.filter(function (c) { return c.url.indexOf('cmd=haplotypes') >= 0; });
        t.eq(haps.length, 1, 'one request');
        t.eq(haps[0].opts.method, 'GET', 'GET');
    });

    t.test('the picker lists them, excluding the source haplotype itself', function () {
        var opts = page.el.pgcTargets.children.map(function (o) { return o.textContent; });
        t.ok(opts.length > 0, 'populated (' + opts.length + ')');
        t.notOk(opts.indexOf('HG00097 hap1') >= 0, 'source excluded');
        t.ok(opts.indexOf('CHM13') >= 0, 'others present');
        t.contains(page.el.pgcTargetCount.textContent, 'source haplotype is excluded', 'explained');
    });

    t.suite('the source, stated rather than chosen');

    t.test('the source line names the haplotype and the position', function () {
        t.contains(page.el.pgcSrcLabel.textContent, 'HG00097 hap1', 'haplotype named');
        t.contains(page.el.pgcSrcLabel.textContent, 'CM094066.1:1-100', 'position named');
    });

    t.test('the haplotype is carried in a hidden field, not a picker', function () {
        // Nothing to choose: the assembly is the one the user came from.  The
        // value still has to be there, because it is what gets submitted.
        t.eq(page.el.pgcSrcHap.value, 'HG00097#1', 'seeded from the inherited assembly');
        t.eq(page.el.pgcSrcHap.children.length, 0, 'no options to pick from');
    });

    t.test('the note names the assembly and nothing else', function () {
        // The caveat about contigs went with the text box it was advice for;
        // a position that does not fit the source is caught by contigProblem()
        // at the moment it matters.
        t.contains(page.el.pgcSrcNote.textContent, 'GCA_044165215.1', 'assembly named');
        t.notOk(/must be one of/.test(page.el.pgcSrcNote.textContent), 'no caveat');
    });

    t.test('the source is excluded from its own target list', function () {
        var targets = page.el.pgcTargets.children.map(function (o) { return o.value; });
        t.notOk(targets.indexOf('HG00097#1') >= 0, 'no self-conversion');
    });

    // ---- chain padding ------------------------------------------------------
    //
    // The chain is what lets the lifted tracks draw, so where it stops the
    // annotations stop.  Two requests: a narrow chain on the click, so following
    // the link is not slow, then a wider one asked for on the way out.
    //
    // Both stages are asynchronous, and this harness asserts synchronously, so
    // the driving happens in timers and the suite runs once it has settled -
    // the same shape as the other multi-step suites in this file.
    function padPage() {
        return startPage({ liftover: { blocks: [
            { haplotype: 'CHM13#0#chr9', source_start: 100, source_end: 200,
              target_start: 500, target_end: 600, strand: '+' }] } });
    }
    var padA = padPage(), padB = padPage(), padNoBeacon = padPage();
    var padPages = [padA, padB, padNoBeacon];
    setTimeout(function () {
        /* The destination list is fetched, so a page cannot be converted until
         * that promise has settled - hence the wait before driving it. */
        padPages.forEach(function (c) {
            c.window.pangenomeConfig.hgsid = 'SID1';
            c.el.pgcQuickLift.checked = true;
            convert(c, 'CM094066.1:101-200', ['CHM13#0']);
        });
        setTimeout(function () {
        padPages.forEach(function (c) {
            // The position link, not the strip's "Show all haplotypes".
            c.link = c.findAll(c.el.pgcResults, function (n) {
                return n.tagName === 'A' &&
                       (n.getAttribute('href') || '').indexOf('hgTracks') >= 0;
            })[0];
        });
        padNoBeacon.sandbox.navigator = undefined;
        padPages.forEach(function (c) {
            if (c.link) c.link.dispatch('click');
        });
        setTimeout(function () {
            t.suite('chain padding');

            t.test('the click sends the interval and target, not just the blocks',
                   function () {
                // Without these the server can only build a chain as wide as the
                // blocks the page holds, which is exactly the interval converted.
                t.ok(padA.link, 'a result link was rendered');
                if (!padA.link) return;
                var ql = padA.calls.filter(function (x) {
                    return String((x.opts && x.opts.body) || '')
                             .indexOf('cmd=quickLift') >= 0;
                });
                t.eq(ql.length, 1, 'one quickLift request');
                if (!ql.length) return;
                var p = JSON.parse(decodeURIComponent(
                    String(ql[0].opts.body).split('payload=')[1].split('&')[0]));
                t.eq(p.srcStart, 100, 'source start sent');
                t.eq(p.srcEnd, 200, 'source end sent');
                t.eq(p.tgt, 'CHM13#0', 'and the single target the chain is for');
                // Posting the blocks put an unbounded array in the body and blew
                // past cheapcgi's 1 MB cap on a big conversion, which aborts as
                // HTML.  The server fetches its own.
                t.notOk('blocks' in p, 'the blocks are not posted back');
            });

            t.test('a wider chain is asked for on the way out, without the blocks',
                   function () {
                var b = padB.sandbox.beacons;
                t.eq(b.length, 1, 'exactly one beacon');
                if (!b.length) return;
                t.contains(b[0].body, 'cmd=extendChain', 'asks to extend');
                var p = JSON.parse(decodeURIComponent(
                    b[0].body.split('payload=')[1].split('&')[0]));
                t.notOk('blocks' in p, 'no blocks: the server fetches its own');
                t.eq(p.srcStart, 100, 'but it knows the interval');
                t.eq(p.tgt, 'CHM13#0', 'and the target');
                t.ok(b[0].body.indexOf('hgsid=SID1') >= 0,
                     'and the cart it belongs to');
            });

            t.test('no beacon where the browser has none', function () {
                // It runs as the page is being replaced; naming a missing
                // navigator would throw and take the navigation with it.
                t.eq(padNoBeacon.sandbox.beacons.length, 0,
                     'nothing sent, nothing thrown');
            });
        }, 0);
        }, 0);
    }, 0);

    t.suite('checking the inherited position');

    // The position is not typed any more, but it is still inherited, and an
    // inherited one can be stale - the browser's spelling of a contig, or a
    // position left over from another assembly.  So the source's sequence list
    // is still fetched, and still used to judge it.
    t.test('the source sequences are loaded for checking', function () {
        t.ok(page.api.contigsForSource(), 'list fetched');
        t.deepEq(page.api.contigsForSource().slice(0, 2),
                 ['CM094060.1', 'CM094061.1'], 'in the graph\'s own names');
    });

    t.test('a contig from the wrong haplotype is caught before the request', function () {
        // exactly the case that produced "No paths found for source haplotype:
        // HG00290#2#chr9" from the server
        var c = badContig;
        c.el.pgcPos.value = 'chr9:1-1000';
        c.el.pgcTargets.children.forEach(function (o) { o.selected = true; });
        c.el.pgcSubmit.dispatch('click');
        t.eq(posts(c).length, 0, 'nothing sent');
        t.contains(c.el.pgcStatus.textContent, 'is not a sequence of', 'says why');
        t.contains(c.el.pgcStatus.textContent, 'chr1', 'and what is valid');
    });

    t.test('a near match is suggested rather than just rejected', function () {
        var c = badContig;
        // Both spellings, so a partial accession is answered in terms the user
        // can connect to what they typed.
        t.contains(c.api.contigProblem('CM094066'), 'Did you mean chr7 (CM094066.1)',
                   'suggests the close name, under both names');
    });

    t.test("the browser's own name for a sequence is accepted", function () {
        // The bug this fixes: a position copied out of hgTracks names the
        // sequence chrUn_JBIREP010000009v1, which the graph has never heard of,
        // and the page rejected it as not being a sequence of the assembly.
        t.isNull(page.api.contigProblem('chrUn_JBIREP010000009v1'),
                 'no complaint about the browser spelling');
        t.isNull(page.api.contigProblem('chr1'), 'nor a plain chromosome name');
        t.eq(page.api.nativeContig('chrUn_JBIREP010000009v1'), 'JBIREP010000009.1',
             'and it is translated to the accession the graph knows');
        t.eq(page.api.nativeContig('CM094060.1'), 'CM094060.1',
             'an accession is left alone');
        t.eq(page.api.nativeContig('nonsense'), 'nonsense',
             'an unknown name passes through for the server to judge');
    });

    t.test('a valid contig passes straight through', function () {
        t.isNull(page.api.contigProblem('CM094066.1'), 'no complaint');
    });

    t.test('the source path is built from the accession, not what was typed',
           function () {
        // buildSource is what feeds the request, so this is the assertion that
        // matters: whichever name goes in the box, the graph is asked in its
        // own naming.
        page.el.pgcPos.value = 'chrUn_JBIREP010000009v1:1-1000';
        var a = page.api.buildSource();
        t.isNull(a.error || null, 'accepted');
        t.eq(a.src, 'HG00097#1#JBIREP010000009.1', 'translated in the src path');
        t.eq(a.contig, 'JBIREP010000009.1', 'and in the contig it reports');
        page.el.pgcPos.value = 'CM094060.1:1-1000';
        t.eq(page.api.buildSource().src, 'HG00097#1#CM094060.1',
             'an accession is passed through unchanged');
    });

    t.suite('more targets than one request carries');

    t.test('the chosen line states how many are chosen, and no limit', function () {
        t.contains(page.el.pgcChosen.textContent, 'Chosen 1', 'running count');
        t.notOk(/ of \d/.test(page.el.pgcChosen.textContent), 'no cap to state');
    });

    t.test('a longer list goes as several requests, none over the per-request size', function () {
        var c = tooMany;
        c.el.pgcPos.value = 'CM094066.1:1-100';
        c.el.pgcTargets.children.forEach(function (o) { o.selected = true; });  // all 4
        c.el.pgcSubmit.dispatch('click');
        var sent = posts(c).filter(function (x) { return (x.opts.body || '').indexOf('cmd=liftover') >= 0; });
        t.eq(sent.length, 2, 'two requests at once: 3 targets and 1');
        var sizes = sent.map(function (x) {
            var tgt = JSON.parse(decodeURIComponent(x.opts.body.split('payload=')[1])).tgt;
            return Array.isArray(tgt) ? tgt.length : 1;
        });
        t.eq(sizes.join('+'), '3+1', 'split at the per-request size');
        t.contains(c.el.pgcStatus.textContent, 'Translating', 'and the page says it is working');
    });

    t.test('a long region carries fewer targets per request', function () {
        t.eq(c0.api.batchSize(100), 3, 'short: the per-request size');
        t.eq(c0.api.batchSize(2000000), 2, '2 Mb under a 5 Mb budget: two');
        t.eq(c0.api.batchSize(9000000), 1, 'never fewer than one');
    });

    t.test('at the limit it goes through', function () {
        var c = atLimit;
        c.el.pgcPos.value = 'CM094066.1:1-100';
        var n = 0;
        c.el.pgcTargets.children.forEach(function (o) { o.selected = (n++ < 3); });
        c.el.pgcSubmit.dispatch('click');
        t.eq(posts(c).length, 1, 'sent');
        t.eq(payloadOf(c).tgt.length, 3, 'three targets');
    });

    t.suite('the conversion request');


    // requests (the pages were given time above via their own fetch stubs)
    var one = startPage(), many = startPage(), badPos = startPage(), noTgt = startPage();
    setTimeout(function () {
        convert(one, 'CM094066.1:19114-19137', ['CHM13#0']);
        convert(many, 'CM094066.1:1-100', ['CHM13#0', 'GRCh38#0', 'HG01234#2']);
        convert(badPos, 'not a position', ['CHM13#0']);
        convert(noTgt, 'CM094066.1:1-100', []);   // valid contig: isolate the target check

        t.test('a single target sends src/start/end/tgt as a full contig path', function () {
            t.eq(posts(one).length, 1, 'one POST');
            t.contains(posts(one)[0].opts.body, 'cmd=liftover', 'liftover command');
            var p = payloadOf(one);
            t.eq(p.src, 'HG00097#1#CM094066.1', 'full 3-field source path, graph casing');
            t.eq(p.start, 19113, '0-based start');
            t.eq(p.end, 19137, 'half-open end');
            t.eq(p.tgt, 'CHM13#0', 'single target as a string');
        });

        t.test('the source path uses the graph\'s spelling, not our lower-cased key',
               function () {
            // hapForDb() returns "hg00097#1" (table keys are lower-cased) but the
            // graph's path is "HG00097#1"; sending the wrong case gets a 400
            // "No paths found for source haplotype".
            t.eq(one.api.canonicalHap('hg00097#1'), 'HG00097#1', 'canonicalized');
            t.eq(payloadOf(one).src, 'HG00097#1#CM094066.1', 'sent with graph casing');
        });

        t.test('a haplotype absent from the loaded graph is caught before sending',
               function () {
            var c = startPage({ db: 'GCA_018504085.2' });   // hg02080#2, not in this stub list
            setTimeout(function () {}, 0);
            t.notOk(c.api.hapInGraph('hg02080#2') && c.api.canonicalHap('hg02080#2') === 'HG02080#2',
                    'not treated as present');
        });

        t.test('several targets are sent as an array, in one request', function () {
            t.eq(posts(many).length, 1, 'still one request');
            t.deepEq(payloadOf(many).tgt, ['CHM13#0', 'GRCh38#0', 'HG01234#2'], 'array');
        });

        t.test('a bad position is caught before anything is sent', function () {
            t.eq(posts(badPos).length, 0, 'no POST');
            t.contains(badPos.el.pgcStatus.textContent, 'could not read', 'reason shown');
        });

        t.test('a contig with no range is caught with concrete guidance', function () {
            var c = startPage();
            c.el.pgcPos.value = 'chr10';
            c.el.pgcSubmit.dispatch('click');
            t.contains(c.el.pgcStatus.textContent, 'add a range', 'guidance shown');
        });

        t.test('no target selected is caught before anything is sent', function () {
            t.eq(posts(noTgt).length, 0, 'no POST');
            t.contains(noTgt.el.pgcStatus.textContent, 'at least one target', 'reason shown');
        });

        // ---- "show only reachable" ----
        var reach = startPage();
        setTimeout(function () {
            reach.el.pgcPos.value = 'CM094066.1:19114-19137';
            reach.el.pgcReachableOnly.checked = true;
            reach.el.pgcReachableOnly.dispatch('change');
            setTimeout(function () {
                t.suite('narrowing the picker to reachable haplotypes');

                t.test('it asks the graph with the source region, no target', function () {
                    var p = reach.calls.filter(function (x) {
                        return (x.opts.body || '').indexOf('cmd=liftoverTargets') >= 0; });
                    t.eq(p.length, 1, 'one request');
                    var payload = JSON.parse(decodeURIComponent(
                        p[0].opts.body.split('payload=')[1]));
                    t.eq(payload.src, 'HG00097#1#CM094066.1', 'graph-cased source path');
                    t.eq(payload.start, 19113, 'start');
                    t.eq(payload.end, 19137, 'end');
                    t.notOk('tgt' in payload, 'no target in a reachability query');
                });

                t.test('the picker keeps only the reachable haplotypes', function () {
                    var opts = reach.el.pgcTargets.children.map(function (o) {
                        return o.textContent; });
                    t.deepEq(opts.sort(), ['CHM13', 'HG01234 hap2'],
                             'narrowed, and shown by their readable names');
                    t.contains(reach.el.pgcTargetCount.textContent, 'containing this region',
                               'count explains the filter');
                });

                t.test('a lower-cased reply still matches the graph-cased list', function () {
                    // the two endpoints are produced separately; the client must
                    // not assume they agree on spelling
                    t.eq(reach.el.pgcTargets.children.length, 2, 'matched case-insensitively');
                });

                t.test('unticking it restores the full list', function () {
                    reach.el.pgcReachableOnly.checked = false;
                    reach.el.pgcReachableOnly.dispatch('change');
                    t.ok(reach.el.pgcTargets.children.length > 2, 'full list back');
                    t.notOk(/contain this region/.test(reach.el.pgcTargetCount.textContent),
                            'filter note cleared');
                });

                t.test('ticking it again does not ask the graph twice', function () {
                    // The answer depends only on the source region, which has
                    // not moved, so the second tick is free.
                    reach.el.pgcReachableOnly.checked = true;
                    reach.el.pgcReachableOnly.dispatch('change');
                    var asks = reach.calls.filter(function (x) {
                        return (x.opts.body || '').indexOf('cmd=liftoverTargets') >= 0; });
                    t.eq(asks.length, 1, 'still one request');
                    t.eq(reach.el.pgcTargets.children.length, 2, 'and the filter is back on');
                });

                runRenderCases();
            }, 60);
        }, 60);

        function runRenderCases() {
        // ---- rendering ----
        // blocks, as the server sends them now: the percentages are measured
        // from the source side of these
        var single = startPage({ liftover: { blocks: [
            { haplotype: 'chm13#0#chr10', source_start: 19113, source_end: 19137,
              target_start: 4338779, target_end: 4338799, strand: '+' }] } });
        var multi = startPage({ liftover: { blocks: [
            { haplotype: 'hg01234#2#CM0987.1', source_start: 0, source_end: 24,
              target_start: 20551, target_end: 20575, strand: '+' },
            { haplotype: 'hg01234#2#CM0988.1', source_start: 30, source_end: 40,
              target_start: 400, target_end: 410, strand: '-' }] } });
        var empty = startPage({ liftover: { intervals: [] } });
        var mixed = startPage({ liftover: { intervals: [
            { haplotype: 'chm13#0#chr10', start: 10, end: 20, strand: '+' }] } });
        var errPage = startPage({ liftover: { status: 'error', error: 'unknown source haplotype' } });
        // arrives the way hgConvert hands off: destination already chosen
        var autoPage = startPage({ config: { presetTarget: 'CHM13#0',
                                            presetAnnot: 'on', presetHide: 'off' },
            liftover: { blocks: [{ haplotype: 'chm13#0#chr10',
                source_start: 0, source_end: 20,
                target_start: 10, target_end: 30, strand: '+' }] } });

        setTimeout(function () {
            convert(single, 'CM094066.1:19114-19137', ['CHM13#0']);
            convert(multi, 'CM094066.1:1-100', ['HG01234#2']);
            convert(empty, 'CM094066.1:1-100', ['CHM13#0']);
            convert(mixed, 'CM094066.1:1-100', ['CHM13#0', 'GRCh38#0']);
            convert(errPage, 'CM094066.1:1-100', ['CHM13#0']);

            setTimeout(function () {
                t.suite('rendering translated intervals');

                // The rows of the results table, and one cell's text, by class.
                function rowsOf(page) {
                    var out = [];
                    page.findAll(page.el.pgcResults, function (n) { return n.tagName === 'TBODY'; })
                        .forEach(function (tb) { out = out.concat(tb.children); });
                    return out;
                }
                function cellText(tr, cls) {
                    var td = (tr.children || []).filter(function (c) { return c.className === cls; })[0];
                    return td ? td.textContent : null;
                }

                t.test('the options chosen in hgConvert are honoured here',
                       function () {
                    // they mean the same thing on both pages, so resetting them
                    // would undo a choice the user just made
                    t.eq(autoPage.el.pgcQuickLift.checked, true,
                         'annotations box carried over');
                    t.eq(autoPage.el.pgcHideTracks.checked, false,
                         'and so did hide-default-tracks');
                });

                t.test('arriving from hgConvert converts without a second Submit',
                       function () {
                    // hgConvert already collected the source, the position and
                    // the destination and the user pressed Submit there; asking
                    // again would make the hand-off look broken
                    var posts = autoPage.calls.filter(function (x) {
                        return x.opts.method === 'POST'; });
                    t.ok(posts.length > 0, 'a conversion was sent on its own');
                });


                t.test("a single interval renders as a position link with hgConvert-style percentages",
                       function () {
                    var s = text(single);
                    t.contains(s, 'CHM13', 'target named');
                    t.contains(s, 'chr10:4338780-4338799', '1-based display');
                    t.contains(s, 'Coverage', 'share of the region, as a column');
                    t.contains(s, '83.3%', 'its figure');
                    var l = links(single);
                    t.eq(l.length, 1, 'one view link');
                    if (l.length) {
                        t.contains(l[0].getAttribute('href'), 'db=hs1', 'target assembly');
                        t.contains(l[0].getAttribute('href'),
                                   'position=chr10%3A4338780-4338799', 'at that locus');
                    }
                });

                t.test('multiple pieces each get a row, honoring per-piece strand', function () {
                    var s = text(multi);
                    var rows = rowsOf(multi);
                    t.eq(rows.length, 2, 'a row for each piece');
                    t.contains(s, 'CM0987.1:20552-20575', 'first piece');
                    t.contains(s, 'CM0988.1:401-410', 'second piece');
                    t.eq(cellText(rows[1], 'strandCol'), '-', 'reverse-strand piece flagged');
                    t.eq(cellText(rows[0], 'sampleCol'), 'HG01234', 'sample in its own column');
                    t.eq(cellText(rows[0], 'phaseCol'), '2', 'and the haplotype number in another');
                });

                t.test('an empty result says the region does not exist there', function () {
                    var s = text(empty);
                    t.contains(s, 'no equivalent region', 'header states it');
                    t.contains(s, 'does not exist on CHM13', 'explained in full');
                    t.eq(links(empty).length, 0, 'and no link');
                });

                t.test('every requested target gets an answer, including empty ones', function () {
                    var s = text(mixed);
                    t.eq(rowsOf(mixed).length, 2, 'one row for each target');
                    t.contains(s, 'CHM13', 'target with a hit');
                    t.contains(s, 'does not exist on GRCh38', 'target without one');
                });

                t.test('a server error envelope is surfaced with a retry', function () {
                    t.contains(errPage.el.pgcStatus.textContent, 'unknown source haplotype', 'reason');
                    t.contains(errPage.el.pgcStatus.textContent, 'Retry', 'retry offered');
                });


                // ---- ranked destinations (scored:true) ----
                var scored = startPage({ targets: { haplotypes: [
                    { haplotype: 'hg01234#2', coverage: 62.5, covered_bp: 620 },
                    { haplotype: 'chm13#0', coverage: 99.1, covered_bp: 991 }] } });
                setTimeout(function () {
                    scored.el.pgcPos.value = 'CM094066.1:1-1000';
                    scored.el.pgcReachableOnly.checked = true;
                    scored.el.pgcReachableOnly.dispatch('change');
                    setTimeout(function () {
                        t.suite('ranked destinations');

                        t.test('the request asks for scores and a floor', function () {
                            var p = scored.calls.filter(function (x) {
                                return (x.opts.body || '').indexOf('cmd=liftoverTargets') >= 0; });
                            var payload = JSON.parse(decodeURIComponent(
                                p[0].opts.body.split('payload=')[1]));
                            t.eq(payload.scored, true, 'scored requested');
                            t.eq(payload.min_coverage, 10, 'floor sent, to drop repeat noise');
                        });

                        t.test('scored objects are accepted, not just plain names', function () {
                            t.eq(scored.el.pgcTargets.children.length, 2, 'both kept');
                        });

                        t.test('the picker is ordered by coverage, best first', function () {
                            var labels = scored.el.pgcTargets.children.map(function (o) {
                                return o.textContent; });
                            t.contains(labels[0], 'CHM13', 'best first');
                            t.contains(labels[0], '99.1%', 'with its score');
                            t.contains(labels[1], 'HG01234 hap2', 'then the weaker match');
                            t.contains(scored.el.pgcTargetCount.textContent, 'best first',
                                       'count line says so');
                        });

                        t.test('the value submitted is the bare name, not the label', function () {
                            var o = scored.el.pgcTargets.children[0];
                            t.eq(o.value, 'CHM13#0', 'percentage is display only');
                        });

                        // ---- no caveat on a wide region ----
                        // A wide region loses nothing a tiled one finds (tested
                        // against the service, 2026-11-02), so it is not flagged.
                        var wide = startPage({
                            liftover: { intervals: [{ haplotype: 'CHM13#0#chr10',
                                        start: 10, end: 500010, strand: '+' }] } });
                        setTimeout(function () {
                            convert(wide, 'CM094066.1:1-500000', ['CHM13#0']);
                            setTimeout(function () {
                                t.suite('wide regions');

                                t.test('a wide region is not flagged as incomplete', function () {
                                    t.notOk(/incomplete|drop some positions/.test(text(wide)),
                                            'no caveat');
                                });

                                process.exit(t.report());
                            }, 120);
                        }, 60);
                    }, 60);
                }, 60);
            }, 120);
        }, 80);
        }
    }, 60);
}, 60);
