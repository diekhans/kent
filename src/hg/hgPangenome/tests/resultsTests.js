/* resultsTests.js - tests for the results page (js/hgPangenomeResults.js).
 *
 * The page is hgBlat's new results table: a DataTable whose cells, detail
 * panel and download are drawn by functions in that file.  These test those
 * functions directly - the cell renderers, the row order, the tab-separated
 * download, the record parsing - so that the presentation can change without
 * the meaning of a number changing with it.  No DataTable, no network: the
 * file is loaded into a vm with just enough of a window to evaluate.
 *
 * Run:  node resultsTests.js
 */

'use strict';

var t = require('./testLib.js');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var JS = path.resolve(__dirname, '../../js');

// The results page's file defines its functions at top level (no module
// wrapper), so they land on the vm context and can be called from here.
function loadResults(extra) {
    var ctx = {
        window: { location: { pathname: '/cgi-bin/hgPangenome' },
                  sessionStorage: { getItem: function () { return null; }, setItem: function () {} } },
        document: { readyState: 'complete', getElementById: function () { return null; },
                    addEventListener: function () {} },
        console: { log: function () {}, error: function () {} },
        setTimeout: function () {},
        fetch: function () { return new Promise(function () {}); },
        Promise: Promise, Math: Math, JSON: JSON, Date: Date, Object: Object,
        String: String, Number: Number, Array: Array, RegExp: RegExp, isNaN: isNaN
    };
    Object.keys(extra || {}).forEach(function (k) { ctx[k] = extra[k]; });
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(JS, 'hgPangenomeAssemblies.js'), 'utf8'), ctx);
    ctx.pangenomeAssemblies = ctx.window.pangenomeAssemblies;
    vm.runInContext(fs.readFileSync(path.join(JS, 'hgPangenomeResults.js'), 'utf8'), ctx);
    return ctx;
}

var R = loadResults({ pangenomePclai: false });

function row(over) {
    var r = { query: 'q1', queryLength: 1000, placement: 0, placements: 1, hap: 'HG00097#2',
              db: 'GCA_044164745.1', contig: 'CM094075.1', start: 999, end: 1999,
              strand: '+', identity: 99.5, coverage: 98.25, surjMapq: 60, mapq: 60,
              matches: 990, mismatches: 5, inserted: 2, deleted: 3, cigar: '1000M',
              qStart: 0, qEnd: 1000, rank: 0 };
    Object.keys(over || {}).forEach(function (k) { r[k] = over[k]; });
    return r;
}

t.suite('identity colours match hgBlat');
t.test('the four bands', function () {
    t.eq(R.pgrIdColor(100), '#1f7a34', '>=98');
    t.eq(R.pgrIdColor(98), '#1f7a34', 'boundary 98');
    t.eq(R.pgrIdColor(97.9), '#4d7c0f', '>=95');
    t.eq(R.pgrIdColor(92), '#b45309', '>=90');
    t.eq(R.pgrIdColor(89.9), '#b1301f', 'below 90');
});

t.suite('position cell');
t.test('a placed row links its 1-based position, with a new-tab link', function () {
    var h = R.pgrPositionCell(row());
    t.contains(h, 'CM094075.1:1,000-1,999', '1-based start, commas');
    t.contains(h, 'data-act="browser"', 'opens the browser');
    t.contains(h, 'data-act="newtab"', 'and a new tab');
    t.contains(h, 'data-rank="0"', 'names its row');
});
t.test('an unplaced row says why instead of linking', function () {
    t.contains(R.pgrPositionCell(row({ contig: null, placeStatus: 'no_anchors' })), 'not present', 'no anchors');
    t.contains(R.pgrPositionCell(row({ contig: null, placeStatus: 'surjection_failed' })), 'no alignment', 'failed');
    t.contains(R.pgrPositionCell(row({ contig: null })), 'not placed', 'anything else');
    t.notOk(/data-act/.test(R.pgrPositionCell(row({ contig: null }))), 'nothing to click');
    t.eq(R.pgrActionsCell(row({ contig: null })), '', 'no Alignment link either');
});
t.test('a contig name cannot inject markup', function () {
    var h = R.pgrPositionCell(row({ contig: '<img src=x onerror=alert(1)>' }));
    t.notOk(/<img/.test(h), 'escaped');
});

t.suite('coverage cell');
t.test('the bar covers the aligned extent, the figure is the coverage', function () {
    var h = R.pgrCoverageCell(row({ qStart: 250, qEnd: 750, coverage: 49.5 }));
    t.contains(h, 'left:25.0%;width:50.0%', 'extent 251-750 of 1000');
    t.contains(h, '49.5%', 'coverage figure');
    t.contains(h, 'Bases 251-750 of your 1,000 bp', 'tooltip is 1-based');
});
t.test('a row with no extent still shows its coverage', function () {
    var h = R.pgrCoverageCell(row({ qStart: null, qEnd: null }));
    t.contains(h, '98.3%', 'figure');
    t.notOk(/pgrCov"/.test(h), 'no bar');
});
t.test('no coverage at all draws nothing', function () {
    t.eq(R.pgrCoverageCell(row({ coverage: null })), '', 'empty');
});

t.suite('MAPQ and the plot box');
t.test('a low MAPQ is marked, a good one is not', function () {
    t.contains(R.pgrMapqCell(row({ surjMapq: 3 })), 'pgrLowMapq', 'marked under 10');
    t.eq(R.pgrMapqCell(row({ surjMapq: 60 })), '60', 'plain');
    t.eq(R.pgrMapqCell(row({ surjMapq: null, mapq: 12 })), '12', 'falls back to the mapping MAPQ');
});
t.test('a MAPQ that is not a number prints nothing, not itself', function () {
    t.eq(R.pgrMapqCell(row({ surjMapq: '<b>60</b>' })), '', 'markup dropped');
    t.eq(R.pgrMapqCell(row({ surjMapq: '7' })), R.pgrMapqCell(row({ surjMapq: 7 })), 'numeric string as number');
});
t.test('no box on a row the plot cannot draw', function () {
    var P = loadResults({ pangenomePclai: true, pgpInit: function () {} });
    t.contains(P.pgrPickCell(row()), 'pgrPick', 'a GenArk haplotype gets one');
    t.eq(P.pgrPickCell(row({ hap: 'GRCh38#0', db: 'hg38' })), '', 'GRCh38 does not');
    t.eq(P.pgrPickCell(row({ hap: 'CHM13#0', db: 'hs1' })), '', 'nor CHM13');
    t.eq(P.pgrPickCell(row({ contig: null })), '', 'nor an unplaced row');
});

t.suite('row order follows hgBlat: query, then placement, then identity');
t.test('queries in the order given, placements in turn, best identity first', function () {
    var rows = [
        row({ query: 'B', placement: 0, identity: 99 }),
        row({ query: 'A', placement: 1, identity: 100 }),
        row({ query: 'A', placement: 0, identity: 98 }),
        row({ query: 'B', placement: 0, identity: 100 }),
        row({ query: 'A', placement: 0, identity: 99.9 })
    ];
    rows.sort(R.pgrRowOrder(['A', 'B']));
    t.eq(rows.map(function (r) { return r.query + r.placement + ':' + r.identity; }).join(' '),
         'A0:99.9 A0:98 A1:100 B0:100 B0:99', 'order');
});
t.test('a query not in the list sorts after those that are', function () {
    var rows = [row({ query: 'zz' }), row({ query: 'A' })];
    rows.sort(R.pgrRowOrder(['A']));
    t.eq(rows[0].query, 'A', 'known first');
});

t.suite('download table');
t.test('one header and one line per row, 20 columns, positions 1-based', function () {
    var tsv = R.pgrRowsToTsv([row(), row({ contig: null })]);
    var lines = tsv.trim().split('\n');
    t.eq(lines.length, 3, 'header + 2');
    lines.forEach(function (l, i) { t.eq(l.split('\t').length, 20, 'columns on line ' + i); });
    var f = lines[1].split('\t');
    t.eq(f[6], '1000', 'start is 1-based');
    t.eq(f[7], '1999', 'end');
    t.eq(f[8], '1000', 'span');
    t.eq(f[12], '1', 'qStart is 1-based');
    t.eq(lines[2].split('\t')[4], '', 'an unplaced row has no contig');
});
t.test('a tab or newline in a query name cannot break the columns', function () {
    var l = R.pgrRowsToTsv([row({ query: 'a\tb\nc' })]).trim().split('\n');
    t.eq(l.length, 2, 'still one data line');
    t.eq(l[1].split('\t').length, 20, 'still 20 columns');
});
t.test('the query FASTA wraps at 60 bases', function () {
    var fa = R.pgrFasta([{ name: 'x', seq: new Array(131).join('a') }]);
    t.eq(fa.split('\n')[0], '>x', 'header');
    t.eq(fa.split('\n')[1].length, 60, 'first line');
    t.eq(fa.split('\n')[3].length, 10, 'remainder');
    t.contains(fa, 'AAAA', 'upper-cased');
});

t.suite('surjection records');
t.test('the query extent is carried for the coverage bar', function () {
    var r = {};
    R.pgrApplyRecord(r, { status: 'ok', haplotype: 'HG00097#2#CM094075.1', target_start: 10,
                          target_end: 20, query_start: 3, query_end: 13, coverage: 99,
                          identity: 0.995, strand: '+', cigar: '10M', mapping_quality: 60 });
    t.eq(r.qStart, 3, 'qStart');
    t.eq(r.qEnd, 13, 'qEnd');
    t.eq(r.identity, 99.5, 'identity as a percentage');
});
t.test('a record without one leaves it unset, not zero', function () {
    var r = {};
    R.pgrApplyRecord(r, { status: 'ok', haplotype: 'HG00097#2#CM094075.1', target_start: 10,
                          target_end: 20, coverage: 99, identity: 1, strand: '+', cigar: '10M' });
    t.ok(r.qStart === undefined, 'unset');
});

t.suite('one haplotype on its own');
t.test('typed names resolve to the PanSN spelling, or to nothing', function () {
    t.eq(R.pgrHapResolve('hg00097#1'), 'HG00097#1', 'lower case');
    t.eq(R.pgrHapResolve('  HG00097 1 '), 'HG00097#1', 'space for #');
    t.eq(R.pgrHapResolve('HG00097.2'), 'HG00097#2', 'dot for #');
    t.eq(R.pgrHapResolve('chm13#0'), 'CHM13#0', 'CHM13 keeps its case');
    t.eq(R.pgrHapResolve('grch38#0'), 'GRCh38#0', 'and GRCh38');
    t.eq(R.pgrHapResolve('HG00097'), null, 'a sample alone is not a haplotype');
    t.eq(R.pgrHapResolve('XX0#1'), null, 'unknown');
    t.eq(R.pgrHapResolve(''), null, 'empty');
});
t.test('the picker lists every haplotype, references first', function () {
    var n = R.pgrHapNames();
    t.eq(n.length, Object.keys(R.window.pangenomeAssemblies).length, 'all of them');
    t.eq(n[0], 'CHM13#0', 'CHM13 first');
    t.eq(n[1], 'GRCh38#0', 'then GRCh38');
    t.ok(n.indexOf('HG00097#1') > 1, 'samples upper-cased');
});
t.test('every placement of every query is a place to fill, from the rows alone', function () {
    R.pgrMapping = null;
    R.pgrRows = [row({ query: 'a', placements: 3 }), row({ query: 'a', placement: 2, placements: 3 }),
                 row({ query: 'b', placements: 1 })];
    var p = R.pgrPlaces().map(function (x) { return x.query + x.index; }).join(',');
    t.eq(p, 'a0,a1,a2,b0', 'three for a, one for b, none twice');
    t.ok(R.pgrHasRow('hg00097#2', 'a', 2), 'a row there, matched case-blind');
    t.notOk(R.pgrHasRow('HG00097#2', 'a', 1), 'none at the placement it is missing from');
    R.pgrRows = [];
});
t.test('a haplotype placed on request carries the mapping figures and its surjection', function () {
    var res = { name: 'q', query_length: 300, alignments: [{}, {}] };
    var aln = { score: 50, mapping_quality: 0,
                haplotypes: { names: ['NA21106#2#JBHIJB010000016.1'], representative: 'CHM13#0#chr6' },
                haplotype_coverage: [{ haplotype: 'NA21106#2', coverage: 97.36, identity: 96.04 }] };
    var r = R.pgrRowForHap(res, aln, 1, 'NA21106#2', { haplotype: 'NA21106#2', surjection: {
        status: 'ok', target: 'NA21106#2#JBHIJB010000016.1#6631428', position: 100, strand: '-',
        cigar: '296M7S', mapping_quality: 0, identity: 0.976351, matches: 289 } });
    t.ok(r.extra, 'kept apart from the best-few rows');
    t.eq(r.placement, 1, 'placement');
    t.eq(r.placements, 2, 'of two');
    t.eq(r.coverage, 97.36, "the mapping's coverage");
    t.ok(r.isCarrier, 'a carrier, by sample#phase');
    t.eq(r.contig, 'JBHIJB010000016.1', 'contig without the offset');
    t.eq(r.start, 6631528, 'fragment offset added');
    t.eq(r.end, 6631824, 'end from the reference bases the CIGAR consumes');
    t.eq(r.db, 'GCA_042076865.1', 'its assembly');
});
t.test('a haplotype with no path there reads "not present"', function () {
    var r = R.pgrRowForHap({ name: 'q', alignments: [{}] }, {}, 0, 'XX00000#1',
        { surjection: { status: 'surjection_failed', detail: 'no_anchors (unknown_path)' } });
    t.eq(r.placeStatus, 'no_anchors', 'status');
    t.contains(R.pgrPositionCell(r), 'not present', 'shown so');
    t.eq(r.coverage, null, 'no coverage to show');
});
t.test('a row placed on request gets no number and no plot box', function () {
    var R2 = loadResults({ pangenomePclai: true, pgpInit: function () {} });
    t.eq(R2.pgrPickCell(row({ extra: true })), '', 'no box');
    t.contains(R2.pgrPickCell(row()), 'pgrPick', 'a table row keeps its box');
});

t.suite('the other placements');
function setPlaces(R, list, rows, queries) {
    R.pgrPlaceList = list.map(function (x) { return { query: x[0], index: x[1] }; });
    R.pgrRows = rows;
    R.pgrQueryCount = queries;
    R.pgrQueryNames = ['a', 'b'];
    R.pgrAllPlaces = false; R.pgrMoreBusy = false; R.pgrMoreErr = null;
}
t.test('the table numbers its own rows first, those aligned on request after, with no gaps', function () {
    setPlaces(R, [['a', 0], ['a', 1]], [
        row({ query: 'a', placement: 1, placements: 2, identity: 99, hap: 'X#1' }),
        row({ query: 'a', placement: 0, placements: 2, identity: 98, hap: 'Y#1', extra: true }),
        row({ query: 'a', placement: 0, placements: 2, identity: 97, hap: 'Z#1' })], 1);
    R.pgrRerank();
    t.eq(R.pgrRows.map(function (r) { return r.hap + ':' + r.rank; }).join(' '),
         'Z#1:0 X#1:1 Y#1:2', 'best placement first, the extra last');
});
t.test('one sequence with other places: say how many, and that only the best is shown', function () {
    setPlaces(R, [['a', 0], ['a', 1], ['a', 2]], [row({ query: 'a', placements: 3, mapq: 60 })], 1);
    var h = R.pgrMoreHtml();
    t.contains(h, 'also aligns to 2 other places', 'count');
    t.contains(h, 'shows only the best one', 'what the table is');
    t.contains(h, 'data-pgr="more"', 'the button');
});
t.test('a low MAPQ at the best placement says the others may be just as likely', function () {
    setPlaces(R, [['a', 0], ['a', 1]], [row({ query: 'a', placements: 2, mapq: 0 })], 1);
    var h = R.pgrMoreHtml();
    t.contains(h, 'other place.', 'singular');
    t.contains(h, 'could not tell it apart', 'why it matters');
    t.contains(h, 'MAPQ 0', 'the figure');
});
t.test('several sequences: how many have other places, and how many in all', function () {
    setPlaces(R, [['a', 0], ['a', 1], ['a', 2], ['b', 0]],
              [row({ query: 'a', placements: 3, mapq: 3 }), row({ query: 'b', mapq: 60 })], 2);
    var h = R.pgrMoreHtml();
    t.contains(h, '1 of your sequences also aligns to other places (2 in all)', 'counts');
    t.contains(h, 'For 1 of them the mapper could not tell', 'low MAPQ named');
});
t.test('no other places: nothing to offer', function () {
    setPlaces(R, [['a', 0]], [row({ query: 'a' })], 1);
    t.eq(R.pgrMoreHtml(), '', 'empty');
});
t.test('once shown, the bar offers the best only; while loading, it says so', function () {
    setPlaces(R, [['a', 0], ['a', 1]], [row({ query: 'a', placements: 2 })], 1);
    R.pgrAllPlaces = true;
    t.contains(R.pgrMoreHtml(), 'data-pgr="bestonly"', 'best only');
    R.pgrAllPlaces = false; R.pgrMoreBusy = true;
    t.contains(R.pgrMoreHtml(), 'gbSpinner', 'spinner');
    R.pgrMoreBusy = false; R.pgrMoreErr = 'gone <b>';
    t.contains(R.pgrMoreHtml(), 'Could not load them: gone &lt;b&gt;', 'an error, escaped');
    setPlaces(R, [], [], 0); R.pgrPlaceList = null;
});

t.suite('reference annotations');
var REFS = [{ hap: 'GRCh38#0', label: 'GRCh38', db: 'hg38' },
            { hap: 'CHM13#0', label: 'CHM13', db: 'hs1' }];
function annotPage(over, saved) {
    var page = { annotRefs: REFS, annotDefault: 'GRCh38#0' };
    Object.keys(over || {}).forEach(function (k) { page[k] = over[k]; });
    var store = { 'hgPangenome.annotRef': saved };
    var R2 = loadResults({ pangenomePclai: false, pangenomeResultsPage: page });
    R2.window.localStorage = { getItem: function (k) { return store[k] === undefined ? null : store[k]; },
                               setItem: function (k, v) { store[k] = v; } };
    R2.pgrAnnotInit();
    return { R: R2, store: store };
}
t.test('names match a reference by label or haplotype, any case; none is none', function () {
    var x = annotPage();
    t.eq(x.R.pgrAnnotMatch('chm13').db, 'hs1', 'label');
    t.eq(x.R.pgrAnnotMatch('GRCh38#0').db, 'hg38', 'haplotype');
    t.eq(x.R.pgrAnnotMatch('none'), null, 'none');
    t.eq(x.R.pgrAnnotMatch('GREF'), undefined, 'unknown');
});
t.test('the link wins over what was chosen last, which wins over the default', function () {
    t.eq(annotPage().R.pgrAnnotRef.label, 'GRCh38', 'default');
    t.eq(annotPage({}, 'CHM13#0').R.pgrAnnotRef.label, 'CHM13', 'remembered');
    t.eq(annotPage({ annotUrl: 'none' }, 'CHM13#0').R.pgrAnnotRef, null, 'link says none');
    t.eq(annotPage({ annotUrl: 'chm13' }).R.pgrAnnotRef.label, 'CHM13', 'link names one');
    t.eq(annotPage({ annotUrl: 'GREF' }, 'CHM13#0').R.pgrAnnotRef.label, 'CHM13', 'an unknown name is skipped');
    t.eq(annotPage({ annotRefs: [] }).R.pgrAnnotRef, null, 'nothing offered: none');
});
t.test('a choice is remembered for next time', function () {
    var x = annotPage();
    x.R.pgrAnnotSet('none');
    t.eq(x.store['hgPangenome.annotRef'], 'none', 'none');
    x.R.pgrAnnotSet('CHM13#0');
    t.eq(x.store['hgPangenome.annotRef'], 'CHM13#0', 'CHM13');
    t.eq(x.R.pgrAnnotRef.db, 'hs1', 'and in effect');
});
t.test('which rows get annotations', function () {
    var x = annotPage();
    t.eq(x.R.pgrAnnotFor(row()).label, 'GRCh38', 'a haplotype');
    t.eq(x.R.pgrAnnotFor(row({ hap: 'GRCh38#0', db: 'hg38', contig: 'chr1' })), null, 'GRCh38 itself');
    t.eq(x.R.pgrAnnotFor(row({ contig: null })), null, 'no position');
    t.eq(x.R.pgrAnnotFor(row({ db: 'https://genome.ucsc.edu/cgi-bin/hgTracks?db=hub_1_HG002' })), null, 'a hub assembly');
    x.R.pgrAnnotSet('CHM13#0');
    t.eq(x.R.pgrAnnotFor(row({ hap: 'GRCh38#0', db: 'hg38', contig: 'chr1' })).label, 'CHM13', 'CHM13 onto GRCh38');
    x.R.pgrAnnotSet('none');
    t.eq(x.R.pgrAnnotFor(row()), null, 'none chosen');
});
t.test('the opened URL keeps its genome and position and gains the hubs', function () {
    var u = R.pgrJoinUrl('hgTracks?db=hub_7_GCA_1.1&position=CM1.1%3A1-9',
        'hgTracks?db=GCA_1.1&position=CM1.1%3A1-9&hgHubConnect.hub.204866=1&hgHubConnect.hub.12=1');
    t.eq(u, 'hgTracks?db=hub_7_GCA_1.1&position=CM1.1%3A1-9&hgHubConnect.hub.204866=1&hgHubConnect.hub.12=1', 'joined');
    t.eq(R.pgrQueryParam('hgTracks?db=x&position=CM1.1%3A1-9', 'position'), 'CM1.1:1-9', 'position read back');
    t.eq(R.pgrJoinUrl('a?db=x', 'b?db=y&position=z'), 'a?db=x', 'nothing to add');
});
t.test('the strip offers each reference and none, the current one selected', function () {
    var x = annotPage({}, 'CHM13#0');
    var h = x.R.pgrAnnotControl();
    t.contains(h, '<option value="CHM13#0" selected>CHM13</option>', 'CHM13 selected');
    t.contains(h, '<option value="none">none</option>', 'none offered');
    t.eq(annotPage({ annotRefs: [] }).R.pgrAnnotControl(), '', 'nothing when QuickLift is off');
});

process.exit(t.report());
