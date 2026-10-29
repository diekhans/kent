/* svTests.js - the SV page's own logic (js/hgPangenomeSv.js): the region a
 * haplotype is opened and compared over, the starting PanLift choice, the
 * population groups and the one-line description.  Pure functions, no DOM.
 */

'use strict';

var path = require('path');
var t = require('./testLib.js');

global.window = {
    pangenomeAssemblies: {
        'grch38#0': 'hg38', 'chm13#0': 'hs1',
        'hg002#1': 'https://example.org/hub.txt',
        'na18940#1': 'GCA_1', 'na18940#2': 'GCA_2', 'na18952#1': 'GCA_3',
        'hg02583#2': 'GCA_4', 'hg01243#2': 'GCA_5', 'hg00097#1': 'GCA_6',
        'hg00097#2': 'GCA_7', 'na18952#2': 'GCA_8', 'hg02583#1': 'GCA_9'
    },
    pangenomeSamples: {
        na18940: ['JPT', 'Japanese in Tokyo, Japan'],
        na18952: ['JPT', 'Japanese in Tokyo, Japan'],
        hg02583: ['GWD', 'Gambian in Western Division – Mandinka'],
        hg01243: ['PUR', 'Puerto Rican in Puerto Rico'],
        hg00097: ['GBR', 'British from England and Scotland']
    }
};
global.document = {};
var sv = require(path.resolve(__dirname, '../../js/hgPangenomeSv.js'));

// The example from the build notes: a 13.6 kb insertion drawn at the left edge
// of a 10 kb site.
function example() {
    return {
        db: 'hg38', refHap: 'GRCh38#0', refLabel: 'GRCh38', chrom: 'chr1',
        start: 730868, end: 730869, name: 'INS-13.6k:11', svType: 'INS',
        svLen: 1, insLen: 13634, ac: 11, an: 463, af: 0.023758, level: 0,
        siteStart: 730114, siteEnd: 740387, flank: 1000, others: [],
        haps: [['GRCh38#0', 'r'], ['CHM13#0', 'n'], ['HG002#1', 'c'],
               ['NA18940#1', 'c'], ['NA18940#2', 'r'], ['NA18952#1', 'c'],
               ['NA18952#2', 'o'], ['HG02583#2', 'c'], ['HG02583#1', 'r'],
               ['HG01243#2', 'c'], ['HG00097#1', 'r'], ['HG00097#2', 'r']]
    };
}

t.suite('SV page: region');

t.test('the whole site plus the flank, not just the drawn point', function () {
    sv._set(example());
    var r = sv.region();
    t.eq(r.siteStart, 730114, 'site start');
    t.eq(r.siteEnd, 740387, 'site end');
    t.eq(r.start, 729114, 'flank before');
    t.eq(r.end, 741387, 'flank after');
});

t.test('an insertion just past its site still lies inside the region', function () {
    var s = example();
    s.start = 740387; s.end = 740388;
    sv._set(s);
    t.eq(sv.region().siteEnd, 740388, 'widened to the SV');
});

t.test('the flank stops at the start of the chromosome', function () {
    var s = example();
    s.siteStart = 200; s.start = 300; s.end = 301;
    sv._set(s);
    t.eq(sv.region().start, 0, 'clamped');
});

t.suite('SV page: starting choice for PanLift');

t.test('carriers and non-carriers, never the source, never a hub-only assembly', function () {
    sv._set(example());
    var pick = sv.defaultChoice();
    t.ok(pick.indexOf('GRCh38#0') < 0, 'not the source');
    t.ok(pick.indexOf('HG002#1') < 0, 'not an assembly the browser cannot open by name');
    t.ok(pick.indexOf('CHM13#0') < 0, 'not one with no call');
    t.ok(pick.indexOf('NA18952#2') < 0, 'not one with a different SV');
    var carriers = pick.filter(function (h) {
        return ['NA18940#1', 'NA18952#1', 'HG02583#2', 'HG01243#2'].indexOf(h) >= 0;
    });
    t.eq(carriers.length, 4, 'every carrier that can be compared');
    t.ok(pick.length > carriers.length, 'and some without it');
    t.ok(pick.length <= 10, 'within the limit');
});

t.test('a population at a time, so one group does not fill the list', function () {
    sv._set(example());
    var pick = sv.defaultChoice().slice(0, 3);
    var pops = pick.map(function (h) { return sv.groupOf(h)[0]; });
    t.eq(new Set(pops).size, 3, 'first three from three populations: ' + pops.join(','));
});

t.suite('SV page: groups and wording');

t.test('population, references, and no population given', function () {
    t.eq(sv.groupOf('NA18940#1')[1], 'Japanese in Tokyo, Japan (JPT)', 'a sample');
    t.eq(sv.groupOf('CHM13#0')[0], '~ref', 'a reference');
    t.eq(sv.groupOf('HG002#1')[0], '~none', 'no population');
});

t.test('says what the SV is and where', function () {
    sv._set(example());
    t.eq(sv.whatItIs(), '13.6 kb insertion at GRCh38 chr1:730,869', 'insertion');
    var s = example();
    s.svType = 'DEL'; s.svLen = 569; s.insLen = 0; s.start = 372158; s.end = 372727;
    sv._set(s);
    t.eq(sv.whatItIs(), '569 bp deletion at GRCh38 chr1:372,159-372,727', 'deletion');
});

process.exit(t.report());
