/* unitTests.js - Layer 1 of the hgPangenome test suite.
 *
 * Pure-function unit tests for js/hgPangenome.js, the PanView search form:
 * input parsing, validation and form encoding.  No network, no real DOM, no
 * middleware.  (The coordinate arithmetic of the results page is tested in
 * resultsTests.js, beside the functions that do it.)
 *
 * Run:  node unitTests.js        (exit 0 = all passed)
 */

'use strict';

var t = require('./testLib.js');
var loader = require('./loadClient.js');

// One shared client instance for the stateless tests.  Tests that mutate client
// config (readConfig) load their own fresh instance to avoid cross-talk.
var client = loader.load();
var pg = client.api;

// Sanity: the test hook is present and exports what we expect.
t.suite('test harness');
t.test('client loads and exports its pure helpers', function () {
    ['parseInput', 'validate', 'formEncode', 'readConfig'].forEach(function (name) {
        t.eq(typeof pg[name], 'function', 'exports ' + name);
    });
});

// ---------------------------------------------------------------- parseInput

t.suite('parseInput - plain one-per-line input');

t.test('empty and missing input yield nothing', function () {
    t.deepEq(pg.parseInput(''), { sequences: [], errors: [] }, 'empty string');
    t.deepEq(pg.parseInput(null), { sequences: [], errors: [] }, 'null');
    t.deepEq(pg.parseInput(undefined), { sequences: [], errors: [] }, 'undefined');
});

t.test('one sequence per line, with line numbers', function () {
    var r = pg.parseInput('ACGT\nTTTT');
    t.deepEq(r.sequences, [
        { name: '', sequence: 'ACGT', line: 1 },
        { name: '', sequence: 'TTTT', line: 2 }
    ], 'two lines');
    t.eq(r.errors.length, 0, 'no errors');
});

t.test('blank lines are skipped but do not shift line numbers', function () {
    var r = pg.parseInput('ACGT\n\n\nTTTT');
    t.eq(r.sequences.length, 2, 'count');
    t.eq(r.sequences[0].line, 1, 'first line no');
    t.eq(r.sequences[1].line, 4, 'second line no (after 2 blanks)');
});

t.test('surrounding and internal whitespace is stripped', function () {
    var r = pg.parseInput('   AC GT\t\tAAAA   ');
    t.eq(r.sequences.length, 1, 'count');
    t.eq(r.sequences[0].sequence, 'ACGTAAAA', 'whitespace removed');
});

t.test('CRLF and bare-CR line endings are normalized', function () {
    t.eq(pg.parseInput('ACGT\r\nTTTT\r\n').sequences.length, 2, 'CRLF');
    t.eq(pg.parseInput('ACGT\rTTTT').sequences.length, 2, 'bare CR');
});

t.suite('parseInput - FASTA input');

t.test('single FASTA record', function () {
    var r = pg.parseInput('>read1\nACGT');
    t.deepEq(r.sequences, [{ name: 'read1', sequence: 'ACGT', line: 1 }], 'record');
});

t.test('multiple records with wrapped sequence lines are concatenated', function () {
    var r = pg.parseInput('>r1\nACGT\nTTTT\n>r2\nGGGG');
    t.deepEq(r.sequences, [
        { name: 'r1', sequence: 'ACGTTTTT', line: 1 },
        { name: 'r2', sequence: 'GGGG', line: 4 }
    ], 'two records, first wrapped');
});

t.test('header name is the first whitespace-delimited token', function () {
    var r = pg.parseInput('>read1 length=150 some description\nACGT');
    t.eq(r.sequences[0].name, 'read1', 'description dropped');
});

t.test('bare ">" header leaves the name empty (validate will autogenerate)', function () {
    var r = pg.parseInput('>\nACGT');
    t.eq(r.sequences[0].name, '', 'empty name');
    t.eq(r.sequences[0].sequence, 'ACGT', 'sequence still parsed');
});

t.test('a record with no sequence lines is kept (so validate can flag it)', function () {
    var r = pg.parseInput('>r1\n>r2\nACGT');
    t.eq(r.sequences.length, 2, 'both records kept');
    t.eq(r.sequences[0].sequence, '', 'r1 empty');
    t.eq(r.sequences[1].sequence, 'ACGT', 'r2 has sequence');
});

t.test('trailing newline does not create a phantom record', function () {
    t.eq(pg.parseInput('>r1\nACGT\n').sequences.length, 1, 'count');
});

t.test('indented header lines are still headers', function () {
    var r = pg.parseInput('   >r1\nACGT');
    t.eq(r.sequences.length, 1, 'count');
    t.eq(r.sequences[0].name, 'r1', 'name parsed from indented header');
});

t.test('sequence data before the first header is reported with its line number', function () {
    var r = pg.parseInput('ACGT\n>r1\nTTTT');
    t.eq(r.errors.length, 1, 'one error');
    t.eq(r.errors[0].line, 1, 'error line');
    t.contains(r.errors[0].message, "before the first '>'", 'error message');
    t.deepEq(r.sequences, [{ name: 'r1', sequence: 'TTTT', line: 2 }], 'valid record still parsed');
});

t.test('FASTA mode is chosen if any line has a header, even late in the input', function () {
    var r = pg.parseInput('ACGT\nTTTT\n>r1\nGGGG');
    t.eq(r.sequences.length, 1, 'only the FASTA record is a sequence');
    t.eq(r.errors.length, 2, 'both pre-header lines flagged');
});

// ------------------------------------------------------------------ validate

function parsed(seqs) {
    // build a parseInput-shaped object directly
    return { sequences: seqs.map(function (s, i) {
        return { name: s.name || '', sequence: s.sequence, line: s.line || (i + 1) };
    }), errors: [] };
}

t.suite('validate - naming');

t.test('unnamed sequences get seq_1, seq_2 ...', function () {
    var p = parsed([{ sequence: 'ACGT' }, { sequence: 'TTTT' }]);
    t.ok(pg.validate(p), 'valid');
    t.deepEq([p.sequences[0].name, p.sequences[1].name], ['seq_1', 'seq_2'], 'names');
});

t.test('explicit names are preserved', function () {
    var p = parsed([{ name: 'myRead', sequence: 'ACGT' }]);
    t.ok(pg.validate(p), 'valid');
    t.eq(p.sequences[0].name, 'myRead', 'name kept');
});

t.test('duplicate names are made unique', function () {
    var p = parsed([{ name: 'dup', sequence: 'ACGT' },
                    { name: 'dup', sequence: 'ACGT' },
                    { name: 'dup', sequence: 'ACGT' }]);
    t.ok(pg.validate(p), 'valid');
    t.deepEq(p.sequences.map(function (s) { return s.name; }),
             ['dup', 'dup_2', 'dup_3'], 'uniquified');
});

t.test('a name colliding with an autogenerated one is still made unique', function () {
    var p = parsed([{ name: 'seq_1', sequence: 'ACGT' }, { sequence: 'TTTT' }]);
    t.ok(pg.validate(p), 'valid');
    var names = p.sequences.map(function (s) { return s.name; });
    t.eq(names[0], 'seq_1', 'explicit name kept');
    t.notOk(names[1] === names[0], 'autogenerated name did not collide: got ' + names[1]);
});

t.test('names that collide with Object.prototype members are handled', function () {
    // "constructor"/"toString" are truthy on a plain {} via the prototype chain,
    // so a naive seen-map would rename them spuriously.
    var p = parsed([{ name: 'constructor', sequence: 'ACGT' },
                    { name: 'toString', sequence: 'ACGT' }]);
    t.ok(pg.validate(p), 'valid');
    t.eq(p.sequences[0].name, 'constructor', 'constructor not renamed');
    t.eq(p.sequences[1].name, 'toString', 'toString not renamed');
});

t.test('duplicate "__proto__" names are still deduplicated', function () {
    // "__proto__" is the nastiest key: on a plain {} the assignment is ignored,
    // so the name is never recorded as seen and dedup silently breaks.
    var p = parsed([{ name: '__proto__', sequence: 'ACGT' },
                    { name: '__proto__', sequence: 'ACGT' }]);
    t.ok(pg.validate(p), 'valid');
    t.deepEq(p.sequences.map(function (s) { return s.name; }),
             ['__proto__', '__proto___2'], 'first kept, second uniquified');
});

t.suite('validate - sequence content');

t.test('lowercase input is accepted and upper-cased', function () {
    var p = parsed([{ sequence: 'acgtn' }]);
    t.ok(pg.validate(p), 'valid');
    t.eq(p.sequences[0].sequence, 'ACGTN', 'upper-cased');
});

t.test('N is allowed', function () {
    t.ok(pg.validate(parsed([{ sequence: 'ACGTNNNNACGT' }])), 'valid');
});

t.test('embedded whitespace is stripped before validation', function () {
    var p = parsed([{ sequence: 'ACGT ACGT' }]);
    t.ok(pg.validate(p), 'valid');
    t.eq(p.sequences[0].sequence, 'ACGTACGT', 'stripped');
});

t.test('empty sequence is rejected with the sequence name', function () {
    var p = parsed([{ name: 'r1', sequence: '' }]);
    t.notOk(pg.validate(p), 'invalid');
    t.eq(p.errors.length, 1, 'one error');
    t.contains(p.errors[0].message, "'r1' is empty", 'message');
});

t.test('invalid character is rejected, naming the character', function () {
    var p = parsed([{ name: 'r1', sequence: 'ACGTX' }]);
    t.notOk(pg.validate(p), 'invalid');
    t.contains(p.errors[0].message, "invalid character 'X'", 'message');
});

t.test('RNA (U) is rejected', function () {
    var p = parsed([{ sequence: 'ACGU' }]);
    t.notOk(pg.validate(p), 'invalid');
    t.contains(p.errors[0].message, "invalid character 'U'", 'message');
});

t.test('digits and punctuation are rejected', function () {
    t.notOk(pg.validate(parsed([{ sequence: 'ACGT1' }])), 'digit');
    t.notOk(pg.validate(parsed([{ sequence: 'ACGT-' }])), 'dash');
    t.notOk(pg.validate(parsed([{ sequence: 'ACGT*' }])), 'star');
});

t.test('each bad sequence produces its own error, with its line number', function () {
    var p = parsed([{ name: 'good', sequence: 'ACGT', line: 1 },
                    { name: 'bad1', sequence: 'ACGTX', line: 2 },
                    { name: 'bad2', sequence: '', line: 3 }]);
    t.notOk(pg.validate(p), 'invalid');
    t.eq(p.errors.length, 2, 'two errors');
    t.eq(p.errors[0].line, 2, 'first error line');
    t.eq(p.errors[1].line, 3, 'second error line');
});

t.suite('validate - counts');

t.test('zero sequences is an error', function () {
    var p = parsed([]);
    t.notOk(pg.validate(p), 'invalid');
    t.contains(p.errors[0].message, 'no sequences found', 'message');
});

function nSeqs(n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push({ sequence: 'ACGT' });
    return parsed(a);
}

t.test('exactly 10 sequences is allowed (boundary): the default limit', function () {
    t.ok(pg.validate(nSeqs(10)), '10 accepted');
});

t.test('11 sequences is rejected with the limit in the message', function () {
    var p = nSeqs(11);
    t.notOk(pg.validate(p), 'invalid');
    t.contains(p.errors[p.errors.length - 1].message, 'too many sequences: 11 (limit is 10)', 'message');
});

t.test('the cap honors a configured maxSequences', function () {
    // Fresh client so readConfig() does not leak into other tests.
    var c = loader.load();
    c.window.pangenomeConfig = { maxSequences: 2 };
    c.api.readConfig();
    t.ok(c.api.validate(nSeqs(2)), '2 allowed');
    var p = nSeqs(3);
    t.notOk(c.api.validate(p), '3 rejected');
    t.contains(p.errors[p.errors.length - 1].message, '(limit is 2)', 'configured limit used');
});

t.suite('validate - the size of the whole request');

t.test('sequences that fit one by one may still be too long together', function () {
    var c = loader.load();
    c.window.hgPangenomeFormData = { maxSeqLen: 100000, maxRequestBytes: 3000 };
    var seq = new Array(1001).join('ACGT').slice(0, 1000);
    var ok = c.api.parseInput('>a\n' + seq + '\n>b\n' + seq);
    t.ok(c.api.validate(ok), 'two of 1,000 bases fit a 3,000 byte request');
    var over = c.api.parseInput('>a\n' + seq + '\n>b\n' + seq + '\n>c\n' + seq);
    t.notOk(c.api.validate(over), 'three do not');
    t.contains(over.errors[0].message, '3,000 bases together', 'the total is stated');
    t.contains(over.errors[0].message, 'limit is 1,900', 'and the room there is, less the wrapping');
});

t.test('with the default limits, ten sequences of full length fit', function () {
    // pangenome.maxSequences 10 x maxSeqLen 100,000 inside maxRequestBytes 1,040,000
    var c = loader.load();
    c.window.hgPangenomeFormData = { maxSeqLen: 100000, maxRequestBytes: 1040000 };
    var seq = new Array(25001).join('ACGT');
    var parts = [];
    for (var i = 0; i < 10; i++) parts.push('>s' + i + '\n' + seq);
    var p = c.api.parseInput(parts.join('\n'));
    t.ok(c.api.validate(p), 'accepted');
    t.eq(JSON.stringify({ sequences: p.sequences.map(function (s) {
        return { name: s.name, sequence: s.sequence }; }), options: {} }).length < 1040000, true,
        'and the request really is under the limit');
});

t.test('where the server has not said, nothing is assumed', function () {
    var c = loader.load();
    var p = c.api.parseInput('>a\nACGT');
    t.ok(c.api.validate(p), 'no form data, no total check');
});

// ---------------------------------------------------------------- formEncode

t.suite('formEncode - request body encoding');

t.test('single and multiple pairs', function () {
    t.eq(pg.formEncode({ cmd: 'map' }), 'cmd=map', 'one pair');
    t.eq(pg.formEncode({ cmd: 'poll', job_id: 'abc123' }), 'cmd=poll&job_id=abc123', 'two pairs');
});

t.test('JSON payloads are percent-encoded', function () {
    t.eq(pg.formEncode({ payload: '{"a":1}' }), 'payload=%7B%22a%22%3A1%7D', 'json');
});

t.test('characters that would break the body are escaped', function () {
    t.eq(pg.formEncode({ v: 'a&b' }), 'v=a%26b', 'ampersand');
    t.eq(pg.formEncode({ v: 'a=b' }), 'v=a%3Db', 'equals');
    t.eq(pg.formEncode({ v: 'a+b' }), 'v=a%2Bb', 'plus');
    t.eq(pg.formEncode({ v: 'a b' }), 'v=a%20b', 'space');
    t.eq(pg.formEncode({ v: '#frag' }), 'v=%23frag', 'hash');
});

process.exit(t.report());
