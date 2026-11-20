/* formTests.js - Layer 3 of the hgPangenome test suite.
 *
 * The PanView search form (js/hgPangenome.js), driven end to end through a
 * stubbed fetch: what it sends when Submit is clicked, how it polls, where it
 * goes when the job is done, and what it says when something fails.  The
 * results themselves are drawn by another page and are tested in
 * resultsTests.js.
 *
 * Deterministic: responses are fixtures, and no graph server or browser is
 * involved.
 *
 * Run:  node formTests.js
 */

'use strict';

var test = require('node:test');
var check = require('./check.js');
var loader = require('./loadClient.js');

test("PanView's search form (js/hgPangenome.js)", async function (ctx) {
var t = check.under(ctx);

var PAGE_IDS = ['pgStatus', 'pgSeq', 'pgSubmit', 'pgClear', 'pgFile'];
var CFG = { pollIntervalMs: 5 };

// Load the form, type a sequence and click Submit.  "responses" is what the
// CGI answers: submit, and poll in turn (the last one repeats).  A poll
// response of "fail" is a request that does not get through.
function start(responses, cfg, seqText, before) {
    var calls = [];
    var i = -1, submits = 0;
    var c = loader.load({
        ids: PAGE_IDS,
        readyState: 'loading',
        fetch: function (url, opts) {
            calls.push({ url: url, opts: opts });
            var isPoll = String(url).indexOf('cmd=poll') >= 0;
            var body;
            if (isPoll) { i = Math.min(i + 1, responses.poll.length - 1); body = responses.poll[i]; }
            else body = Array.isArray(responses.submit)
                        ? responses.submit[Math.min(submits++, responses.submit.length - 1)]
                        : responses.submit;
            if (body === 'fail') return Promise.reject(new Error('network down'));
            return Promise.resolve({
                ok: true, status: 200,
                json: function () { return Promise.resolve(body); },
                text: function () { return Promise.resolve(JSON.stringify(body)); }
            });
        }
    });
    c.window.pangenomeConfig = cfg || CFG;
    if (before) before(c);
    c.fireReady();
    c.el.pgSeq.value = seqText || '>r1\nACGTACGTACGTACGTACGT';
    c.el.pgSubmit.dispatch('click');
    c.calls = calls;
    return c;
}

function payloadOf(c) {
    return JSON.parse(decodeURIComponent(c.calls[0].opts.body.split('payload=')[1]));
}
function polls(c) {
    return c.calls.filter(function (x) { return String(x.url).indexOf('cmd=poll') >= 0; });
}

var QUEUED = { job_id: 'j1', status: 'queued', n_sequences: 1 };
var RUNNING = { job_id: 'j1', status: 'running', progress: { completed: 0, total: 1 }, results: [] };
var DONE = { job_id: 'j1', status: 'done', progress: { completed: 1, total: 1 },
             results: [{ name: 'r1', status: 'mapped', error: null, query_length: 20,
                         alignments: [] }] };

// =============================================================== the request

t.suite('the mapping request');

var waiting = start({ submit: QUEUED, poll: [RUNNING] });

await t.test('submit posts to our own CGI with cmd=map (never to the middleware)', function () {
    var first = waiting.calls[0];
    t.eq(first.opts.method, 'POST', 'POST');
    t.eq(first.url, '/cgi-bin/hgPangenome', 'same-origin CGI url');
    t.contains(first.opts.body, 'cmd=map', 'cmd');
    t.contains(first.opts.body, 'payload=', 'payload');
    t.contains(first.opts.headers['Content-Type'], 'x-www-form-urlencoded', 'form encoded');
});

await t.test('it carries the sequence, named and upper-cased', function () {
    var p = payloadOf(start({ submit: QUEUED, poll: [RUNNING] }, null, '>myRead desc\nacgtacgt'));
    t.eq(p.sequences.length, 1, 'one sequence');
    t.eq(p.sequences[0].name, 'myRead', 'name is the first word of the header');
    t.eq(p.sequences[0].sequence, 'ACGTACGT', 'upper-cased');
});

await t.test('a position is always asked for, on the representative', function () {
    var o = payloadOf(waiting).options;
    t.eq(o.surject, true, 'surject on');
    t.isNull(o.surject_target, 'no target named');
});

await t.test('the map request does not ask for per-haplotype alignments', function () {
    // each one is a surjection on the server, the slowest stage per read; the
    // results page asks for them as its rows come into view
    var o = payloadOf(waiting).options;
    t.notOk('alignments_top' in o, 'no alignments_top');
    t.notOk('alignments_for' in o, 'no alignments_for');
});

await t.test('as many placements as the install allows', function () {
    t.eq(payloadOf(waiting).options.max_multimaps, 1, 'one by default');
    var c = start({ submit: QUEUED, poll: [RUNNING] }, { pollIntervalMs: 5, maxMultimaps: 3 });
    t.eq(payloadOf(c).options.max_multimaps, 3, 'the configured number');
});

await t.test('no coverage cutoff is sent unless one is configured', function () {
    t.notOk('min_haplotype_coverage' in payloadOf(waiting).options,
            'middleware default is left alone');
});

await t.test('a configured cutoff is sent, so the answer is trimmed at the source', function () {
    var c = start({ submit: QUEUED, poll: [RUNNING] }, { pollIntervalMs: 5, minHapCoverage: 50 });
    t.eq(payloadOf(c).options.min_haplotype_coverage, 50, 'cutoff forwarded');
});

await t.test('progress is shown as soon as Submit is clicked', function () {
    t.contains(waiting.el.pgStatus.textContent, 'Mapping', 'progress shown');
});

// ============================================================ input problems

t.suite('input that cannot be submitted');

await t.test('invalid input is explained and nothing is sent', function () {
    var bad = start({ submit: QUEUED, poll: [RUNNING] }, null, 'ACGTX\nACGT');
    t.contains(bad.el.pgStatus.textContent, 'Please fix the input', 'reported');
    t.contains(bad.el.pgStatus.textContent, 'invalid character', 'reason given');
    t.eq(bad.calls.length, 0, 'no request made');
});

await t.test('more sequences than the limit are refused, with the limit', function () {
    var many = [];
    for (var i = 0; i < 4; i++) many.push('>s' + i + '\nACGT');
    var c = start({ submit: QUEUED, poll: [RUNNING] }, { pollIntervalMs: 5, maxSequences: 3 },
                  many.join('\n'));
    t.contains(c.el.pgStatus.textContent, 'too many sequences: 4 (limit is 3)', 'the limit is named');
    t.eq(c.calls.length, 0, 'no request made');
});

await t.test('a sequence longer than the limit is refused here, by name, and nothing is sent', function () {
    var c = start({ submit: QUEUED, poll: [RUNNING] }, null, '>long\nACGTACGTAC\nGTACGTACGT\n>short\nACGT',
                  function (page) { page.window.hgPangenomeFormData = { maxSeqLen: 10 }; });
    t.contains(c.el.pgStatus.textContent, "sequence 'long' is 20 bp (limit is 10 bp)", 'its name, its length, the limit');
    t.notOk(/'short'/.test(c.el.pgStatus.textContent), 'the one within the limit is not named');
    t.eq(c.calls.length, 0, 'no request made');
    var at = start({ submit: QUEUED, poll: [RUNNING] }, null, '>ten\nACGTACGTAC',
                   function (page) { page.window.hgPangenomeFormData = { maxSeqLen: 10 }; });
    t.eq(at.calls.length, 1, 'a sequence of exactly the limit is sent');
});

await t.test('the largest search the limits allow is sent', async function () {
    // Ten sequences of 100,000 bases, the defaults of the two settings: what
    // the form accepts, the page's own size check must let through.
    var full = [];
    for (var i = 0; i < 10; i++) full.push('>s' + i + '\n' + new Array(100001).join('A'));
    var c = start({ submit: QUEUED, poll: [RUNNING] }, { pollIntervalMs: 5, maxSequences: 10 }, full.join('\n'),
                  function (page) { page.window.hgPangenomeFormData = { maxSeqLen: 100000, maxRequestBytes: 1040000 }; });
    await check.wait(10);
    t.eq(c.calls.length >= 1, true, 'sent');
    t.notOk(/too large/.test(c.el.pgStatus.textContent), 'and not refused as too large');
});

// ===================================================== what happens afterwards

var finished = start({ submit: QUEUED, poll: [RUNNING, RUNNING, DONE] },
                     { pollIntervalMs: 5, hgsid: 'sess9' });
var demoLink = start({ submit: QUEUED, poll: [DONE] }, null, null, function (c) {
    c.window.location.search = '?refAnnot=CHM13%230';
});
var refused = start({ submit: { status: 'error', error: 'pangenome.apiBase is not configured' },
                      poll: [] });
var noJob = start({ submit: { status: 'queued' }, poll: [] });
var jobFailed = start({ submit: QUEUED,
                        poll: [{ job_id: 'j1', status: 'error', error: 'engine exploded' }] });
var blip = start({ submit: QUEUED, poll: ['fail', 'fail', DONE] });
var lost = start({ submit: QUEUED, poll: ['fail'] });
// what the CGI answers while the graph server is restarting: an error, but
// not the job's own
var restart = { status: 'error', error: 'the mapping service is unavailable (HTTP 503)' };
var served = start({ submit: QUEUED, poll: [restart, restart, DONE] });
var down = start({ submit: QUEUED, poll: [restart] });
var expired = start({ submit: QUEUED,
    poll: [{ status: 'error', error: 'mapping server returned HTTP 404: {"error": "unknown or expired job"}' }] });
// a search that never finishes: the clock is moved on after it has started
var endless = start({ submit: QUEUED, poll: [RUNNING] });
// Clear, and a second Submit, while a search is out
var clearedForm = start({ submit: QUEUED, poll: [RUNNING] });
var twiceForm = start({ submit: [QUEUED, { job_id: 'j2', status: 'queued', n_sequences: 1 }],
                        poll: [RUNNING] });
function pollsOf(c, job) {
    return polls(c).filter(function (x) { return String(x.url).indexOf('job_id=' + job) >= 0; }).length;
}
await check.wait(60);
require('vm').runInContext('Date.now = function () { return 1e15; };', endless.sandbox);
clearedForm.el.pgClear.dispatch('click');
clearedForm.pollsAtClear = polls(clearedForm).length;
twiceForm.firstAtClick = pollsOf(twiceForm, 'j1');
twiceForm.offAtClick = twiceForm.el.pgSubmit.disabled;
twiceForm.el.pgSubmit.dispatch('click');
twiceForm.submitsAfter = twiceForm.calls.filter(function (x) {
    return x.opts && x.opts.method === 'POST'; }).length;

await check.wait(400);
t.suite('polling');

await t.test('polling uses GET with the job id', function () {
    var p = polls(finished);
    t.ok(p.length >= 3, 'polled until done (' + p.length + ')');
    t.contains(p[0].url, 'job_id=j1', 'job id in query');
    t.eq(p[0].opts.method, 'GET', 'GET');
});

await t.test('it stops once the job is done', function () {
    t.eq(polls(finished).length, 3, 'no poll after the answer that said done');
});

t.suite('handing off to the results page');

await t.test('a finished job goes to the results page, carrying the job id', function () {
    var url = String(finished.window.location);
    t.contains(url, '/cgi-bin/hgPangenome?page=results', 'results page, same CGI');
    t.contains(url, 'job_id=j1', 'job id carried');
    t.contains(url, 'hgsid=sess9', 'session carried');
});

await t.test('without a session id none is put in the link', function () {
    t.notOk(/hgsid=/.test(String(demoLink.window.location)), 'no hgsid');
});

await t.test('a link\'s choice of reference annotations goes along', function () {
    t.contains(String(demoLink.window.location), 'refAnnot=CHM13%230', 'carried as it came');
});

t.suite('failures');

await t.test('an error envelope from the CGI is shown with a retry', function () {
    var s = refused.el.pgStatus.textContent;
    t.contains(s, 'Could not submit', 'failure stated');
    t.contains(s, 'pangenome.apiBase is not configured', 'reason shown');
    t.contains(s, 'Retry', 'retry offered');
    t.eq(polls(refused).length, 0, 'nothing is polled');
});

await t.test('an answer with no job id is a failure, not a poll for "undefined"', function () {
    t.contains(noJob.el.pgStatus.textContent, 'no job id', 'stated');
    t.eq(polls(noJob).length, 0, 'nothing is polled');
});

await t.test('a job that fails says why, with a retry, and goes nowhere', function () {
    var s = jobFailed.el.pgStatus.textContent;
    t.contains(s, 'Job failed: engine exploded', 'reason shown');
    t.contains(s, 'Retry', 'retry offered');
    t.notOk(/page=results/.test(String(jobFailed.window.location)), 'no results page');
});

await t.test('a poll or two that does not get through is tried again', function () {
    t.contains(String(blip.window.location), 'page=results', 'reached the results');
});

await t.test('contact lost for good is reported, and the polling stops', function () {
    var s = lost.el.pgStatus.textContent;
    t.contains(s, 'Lost contact with the mapping server', 'stated');
    t.contains(s, 'Retry', 'retry offered');
    t.eq(polls(lost).length, 4, 'three failures tolerated, the fourth ends it');
});

await t.test('an error from the CGI while polling is a failed try, not a failed job', function () {
    // One 503 while the graph server restarts must not lose the job.
    t.contains(String(served.window.location), 'page=results', 'the job was followed to its end');
    t.notOk(/Job failed/.test(served.el.pgStatus.textContent), 'and never called failed');
});

await t.test('such errors, kept up, end as lost contact, with the reason', function () {
    var s = down.el.pgStatus.textContent;
    t.contains(s, 'Lost contact with the mapping server', 'stated');
    t.contains(s, 'unavailable (HTTP 503)', 'with what the server said');
    t.eq(polls(down).length, 4, 'after three more tries');
});

await t.test('a job the server no longer has is not tried again', function () {
    t.contains(expired.el.pgStatus.textContent, 'Job failed', 'final at once');
    t.contains(expired.el.pgStatus.textContent, 'unknown or expired job', 'with the reason');
    t.eq(polls(expired).length, 1, 'one poll');
});

await t.test('a search that never finishes is given up on', function () {
    t.contains(endless.el.pgStatus.textContent, 'did not finish in 30 minutes', 'said so');
    t.contains(endless.el.pgStatus.textContent, 'Retry', 'with a retry');
    var n = polls(endless).length;
    t.ok(n >= 1 && n < 40, 'and the polling stopped (' + n + ' polls)');
});

await t.test('Clear lets a running search go', function () {
    t.eq(polls(clearedForm).length <= clearedForm.pollsAtClear + 1, true,
         'no more polls after it (' + clearedForm.pollsAtClear + ' then, ' +
         polls(clearedForm).length + ' now)');
    t.notOk(/page=results/.test(String(clearedForm.window.location)), 'and it goes nowhere');
});

await t.test('Submit is off while a search is out: a second one sends nothing', function () {
    // The second click of a double click, or Ctrl-Enter in the box.
    t.eq(twiceForm.offAtClick, true, 'the button is off');
    t.eq(twiceForm.submitsAfter, 1, 'one submission');
    t.eq(pollsOf(twiceForm, 'j2'), 0, 'no second job');
    t.ok(pollsOf(twiceForm, 'j1') > twiceForm.firstAtClick + 1,
         'and the first search is still followed (' + twiceForm.firstAtClick + ' polls at the click, ' +
         pollsOf(twiceForm, 'j1') + ' at the end)');
});

await t.test('Submit is on again when the search has failed, and after Clear', function () {
    t.eq(refused.el.pgSubmit.disabled, false, 'a submission that was refused');
    t.eq(jobFailed.el.pgSubmit.disabled, false, 'a job that failed');
    t.eq(lost.el.pgSubmit.disabled, false, 'contact lost');
    t.eq(clearedForm.el.pgSubmit.disabled, false, 'Clear');
});
});
