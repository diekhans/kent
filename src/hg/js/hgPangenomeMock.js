/* hgPangenomeMock.js - in-browser mock of the PanView mapping API.
 *
 * Lets the page run with no live backend.  It implements the same small
 * transport surface the real API layer uses (submit + poll for the job flow,
 * or a single submit for the sync flow), simulating per-sequence latency so
 * the incremental-rendering path is exercised.  Enabled when
 * window.pangenomeConfig.useMock is true.
 *
 * Keep this file's public shape identical to the real transport in
 * hgPangenome.js (PangenomeApi) so the two are interchangeable.
 */
/* global window */

(function () {
'use strict';

// ---- Canned per-sequence results -------------------------------------------

// A clean, fully-covered read surjected onto the representative.
function cleanResult(name, qlen) {
    return {
        name: name,
        status: "mapped",
        error: null,
        query_length: qlen,
        alignments: [{
            primary: true,
            score: qlen + 10,
            mapping_quality: 60,
            strand: "+",
            graph_path: ">4238799>4238797>4238795>4238793",
            haplotypes: {
                count: 38,
                names: buildHapNames(38),
                representative: "CHM13#0#chr10",
                representative_is_reference: true,
                fully_covered: true,
                coverage_percent: 100,
                num_segments: 1
            },
            haplotype_coverage: [
                { haplotype: "CHM13#0", coverage: 100.0, covered_bp: qlen },
                { haplotype: "HG00097#1", coverage: 100.0, covered_bp: qlen },
                { haplotype: "GRCh38#0", coverage: 99.8,
                  covered_bp: Math.round(qlen * 0.998) },
                { haplotype: "HG01234#2", coverage: 41.2,
                  covered_bp: Math.round(qlen * 0.412) }
            ],
            surjection: {
                status: "ok",
                target: "CHM13#0#chr10",
                position: 19113,
                strand: "+",
                score: qlen + 10,
                mapping_quality: 60,
                cigar: qlen + "M"
            }
        }]
    };
}

// A mosaic read: no single haplotype spans it end to end.
function mosaicResult(name, qlen) {
    return {
        name: name,
        status: "mapped",
        error: null,
        query_length: qlen,
        alignments: [{
            primary: true,
            score: qlen - 40,
            mapping_quality: 40,
            strand: "+",
            graph_path: ">551>552>998>1002>1500",
            haplotypes: {
                count: 15,
                names: buildHapNames(15),
                representative: "CHM13#0#chr10",
                representative_is_reference: true,
                fully_covered: false,
                coverage_percent: 63,
                num_segments: 3,
                mosaic: [
                    { covered_bp: Math.round(qlen * 0.42), haplotype_count: 6, representative: "CHM13#0#chr10" },
                    { covered_bp: Math.round(qlen * 0.33), haplotype_count: 9, representative: "HG01234#2#CM0987.1" },
                    { covered_bp: qlen - Math.round(qlen * 0.42) - Math.round(qlen * 0.33), haplotype_count: 4, representative: "HG00097#1#CM094066.1" }
                ]
            },
            surjection: {
                status: "ok",
                target: "NA19338#1#CM087762.1",
                position: 19113,
                strand: "+",
                score: qlen - 40,
                mapping_quality: 20,
                cigar: Math.round(qlen * 0.42) + "M120I" + (qlen - Math.round(qlen * 0.42) - 120) + "M"
            }
        }]
    };
}

// A read that maps but cannot be surjected onto the chosen target.
function unsurjectableResult(name, qlen) {
    var r = cleanResult(name, qlen);
    r.alignments[0].mapping_quality = 55;
    r.alignments[0].surjection = {
        status: "incompatible",
        target: "HG00097#1#CM094066.1",
        position: null,
        strand: null,
        score: null,
        mapping_quality: null,
        cigar: null
    };
    return r;
}

function unmappedResult(name, qlen) {
    return { name: name, status: "unmapped", error: null, query_length: qlen, alignments: [] };
}

function errorResult(name) {
    return { name: name, status: "error", error: "graph index unavailable for this region", query_length: null, alignments: [] };
}

function buildHapNames(n) {
    var samples = ["CHM13#0#chr10", "HG00097#1#CM094066.1", "HG01234#2#CM0987.1",
                   "NA19338#1#CM087762.1", "HG002#1#chr10", "HG005#2#chr10",
                   "HG00733#1#CM045392.1", "NA12878#0#chr10"];
    var out = [];
    for (var i = 0; i < n; i++)
        out.push(samples[i % samples.length].replace(/(#[^#]+$)/, (i < samples.length ? "$1" : "#alt" + i + "$1")));
    // de-dup-ish; keep it simple, uniqueness is not important for the mock
    out[0] = "CHM13#0#chr10";
    return out;
}

// Pick a canned result shape based on the query so different inputs look different.
function fakeResultFor(seq, index) {
    var name = seq.name;
    var qlen = seq.sequence.length;
    var pick = (seq.sequence.charCodeAt(0) + index) % 10;
    if (pick === 0) return unmappedResult(name, qlen);
    if (pick === 1) return errorResult(name);
    if (pick <= 4) return mosaicResult(name, qlen);
    if (pick === 5) return unsurjectableResult(name, qlen);
    return cleanResult(name, qlen);
}

// ---- Mock transport --------------------------------------------------------

var jobs = {};   // job_id -> { sequences, results, revealed, timer }
var nextId = 1;

function PangenomeMock() {}

// Async job flow: return a job id immediately, then reveal results over time.
PangenomeMock.prototype.submit = function (payload) {
    var seqs = payload.sequences;
    var jobId = "mock" + (nextId++);
    var job = { sequences: seqs, results: [], done: false };
    jobs[jobId] = job;

    // Reveal one result roughly every ~600ms to exercise incremental render.
    var i = 0;
    function step() {
        if (i < seqs.length) {
            job.results.push(fakeResultFor(seqs[i], i));
            i++;
            job.timer = window.setTimeout(step, 600);
        } else {
            job.done = true;
        }
    }
    job.timer = window.setTimeout(step, 400);

    return Promise.resolve({ job_id: jobId, status: "queued", n_sequences: seqs.length });
};

// The mock cannot write files, so it reports that plainly rather than
// pretending; the caller falls back to the position-only jump.
PangenomeMock.prototype.alignTrack = function () {
    return Promise.resolve({ status: "error",
        error: "the mock transport cannot build an alignment track" });
};

// The mock has no server-side alignment cache, so it always reports the fast
// path as a miss and lets the caller map again.
PangenomeMock.prototype.surject = function () {
    return Promise.resolve({ status: "expired" });
};

PangenomeMock.prototype.poll = function (jobId) {
    var job = jobs[jobId];
    if (!job)
        return Promise.resolve({ job_id: jobId, status: "error", error: "no such job", results: [] });
    return Promise.resolve({
        job_id: jobId,
        status: job.done ? "done" : "running",
        progress: { completed: job.results.length, total: job.sequences.length },
        results: job.results.slice()
    });
};

// Sync flow: block (well, resolve after a delay) and return results directly.
PangenomeMock.prototype.submitSync = function (payload) {
    var seqs = payload.sequences;
    var results = seqs.map(function (s, i) { return fakeResultFor(s, i); });
    return new Promise(function (resolve) {
        window.setTimeout(function () {
            resolve({ status: "done", n_sequences: seqs.length, results: results });
        }, 500 + 200 * seqs.length);
    });
};

window.PangenomeMock = PangenomeMock;

}());
