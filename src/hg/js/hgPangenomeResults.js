/* hgPangenomeResults.js - the results of one pangenome mapping job, as a table.
 *
 * Reached as hgPangenome?page=results&job_id=<id>.  The page carries nothing
 * but the job id, so everything here is fetched from that: the mapping is read
 * back with cmd=poll, and each carrier haplotype is placed with cmd=surject.
 * Reloading works, and the URL can be handed to someone else for as long as
 * the job is still cached upstream.
 *
 * Laid out like hgBlat's results table, and deliberately so - the identity and
 * coverage bars, the score bar and the position link are the same idea, so a
 * user who has read one page can read this one.  The data is different: a BLAT
 * row is one place the query hits, while a row here is one haplotype that
 * carries the query, at one of its placements in the graph.
 *
 * Copyright (C) 2026 The Regents of the University of California */

/* globals $, pangenomeJobId, pangenomeConfig, pangenomeAssemblies, pangenomeAssemblyNames */

var pgrSelf = window.location.pathname;
var pgrRows = [];

// The page's two globals are written by inline <script> blocks that the CGI
// flushes at cartWebEnd(), which is after this file's own <script src> tag.  So
// they do not exist while this file is being evaluated - read them when they
// are needed, never at load time.  (Reading pangenomeJobId up here is what made
// every results link say "No job was named in this link".)
function pgrCfg() {
    return (typeof pangenomeConfig === "object" && pangenomeConfig) || {};
}

function pgrJobId() {
    return (typeof pangenomeJobId === "string") ? pangenomeJobId : "";
}

function pgrSurjectCount() {
    return (typeof pangenomeSurjectTop === "number") ? pangenomeSurjectTop : 10;
}


// The ancestry plot is optional; with it off nothing below it runs and the
// table has no checkbox column.
function pgrPclaiOn() {
    return (typeof pangenomePclai !== "undefined") && pangenomePclai &&
           (typeof pgpInit === "function");
}

// A row can be plotted when it has both a placement and an assembly to read
// the ancestry from; the plot needs at least one such row.
function pgrPclaiSpot(r) {
    return (r && r.contig != null && r.start != null && r.end != null &&
            r.db && /^GC[AF]_/.test(r.db)) ? r : null;
}

function pgrPclaiReady() {
    return pgrPclaiOn() && pgrRows.some(function (r) { return !r.extra && pgrPclaiSpot(r); });
}

// What the plot is given for one row: where to read its ancestry, plus the
// figures the table already shows, formatted here rather than in the plot so
// that a number means the same thing in both places.  "rank" lets the panel
// emit the same <a data-rank data-act> the table rows use, which the results
// page's own click delegation already answers.
function pgrPclaiSpotOf(r) {
    var mapq = (r.surjMapq == null) ? r.mapq : r.surjMapq;
    var id = pgrIdentityOf(r);
    var info = [];
    info.push(["Assembly", pgrAssemblyName(r.db) + " (" + pgrAssemblyLabel(r.db) + ")"]);
    info.push(["Position", r.contig + ":" + pgrFmt(r.start + 1) + "-" + pgrFmt(r.end) +
                           (r.strand ? " (" + r.strand + ")" : "")]);
    info.push(["Identity", id == null ? "\u2014" : id.toFixed(1) + "%"]);
    info.push(["Coverage", r.coverage == null ? "\u2014" : r.coverage.toFixed(1) + "%"]);
    info.push(["MAPQ", mapq == null ? "\u2014" : String(mapq) +
                       (mapq < 10 ? " \u2014 the mapper could not tell which copy" : "")]);
    if (r.matches != null) {
        info.push(["Bases", pgrFmt(r.matches) + " matching, " +
                            pgrFmt(r.mismatches || 0) + " mismatched, " +
                            pgrFmt(r.inserted || 0) + " inserted, " +
                            pgrFmt(r.deleted || 0) + " deleted"]);
    }
    // Which locus this hit belongs to, when the query mapped to more than one.
    // Without it two rows for one haplotype are indistinguishable in the plot.
    if (r.placements > 1) {
        info.push(["Placement", (r.placement + 1) + " of " + r.placements +
                                (r.placement === 0 ? " (the best)" : "")]);
    }
    if (r.isCarrier || r.isRepresentative) {
        info.push(["Role", r.isRepresentative ? "the placement's representative"
                                              : "carries the query"]);
    }
    return {hap: r.hap, acc: r.db, contig: r.contig, start: r.start, end: r.end,
            rank: r.rank, info: info,
            // What the plot filters on.  "id" is this spot's own name: the same
            // haplotype can appear once per placement of a query that mapped to
            // several loci, so the haplotype alone does not identify a point.
            id: r.hap + "/" + r.placement + "/" + r.start,
            coverage: (r.coverage == null) ? null : r.coverage,
            placement: r.placement, placements: r.placements, query: r.query};
}

function pgrMinCoverage() {
    return (typeof pangenomeMinCoverage === "number") ? pangenomeMinCoverage : 50;
}

// The figure to rank and show a row by: the surjection's where we have one,
// the graded list's otherwise.
function pgrIdentityOf(row) {
    return row.identity == null ? row.listIdentity : row.identity;
}

// The table's order, as hgBlat's results are sorted: by query and then by
// quality.  Each query's rows together, in the order the queries were given;
// then each of its placements in turn, the best first; and within one, best
// identity first.  For one query placed once, this is just the last.
function pgrRowOrder(queryNames) {
    var order = Object.create(null);
    (queryNames || []).forEach(function (n, i) { if (!(n in order)) { order[n] = i; } });
    var rankOf = function (q) { return (q in order) ? order[q] : 1e9; };
    return function (a, b) {
        var qa = rankOf(a.query), qb = rankOf(b.query);
        if (qa !== qb) { return qa - qb; }
        if (a.placement !== b.placement) { return a.placement - b.placement; }
        return pgrByIdentity(a, b);
    };
}

function pgrByIdentity(a, b) {
    var ia = pgrIdentityOf(a), ib = pgrIdentityOf(b);
    ia = (ia == null) ? -1 : ia;
    ib = (ib == null) ? -1 : ib;
    if (ib !== ia) { return ib - ia; }
    // An exact carrier follows every node of the sequence, so it outranks a
    // haplotype that merely scored the same.
    if (a.isCarrier !== b.isCarrier) { return a.isCarrier ? -1 : 1; }
    var ca = a.coverage == null ? -1 : a.coverage;
    var cb = b.coverage == null ? -1 : b.coverage;
    return cb - ca;
}


// ---- small helpers ---------------------------------------------------------

function pgrEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}

function pgrFmt(n) {
    return (n == null || isNaN(n)) ? "" : Number(n).toLocaleString("en-US");
}

// Haplotype names arrive in two shapes: a carrier is 3-field
// ("CHM13#0#chr10") while haplotype_coverage is 2-field ("CHM13#0").  Compare
// on sample#phase.  Same rule as hgPangenome.js.
function pgrHapKey(name) {
    return String(name == null ? "" : name).split("#").slice(0, 2).join("#").toLowerCase();
}

function pgrHapShort(name) {
    return String(name == null ? "" : name).split("#").slice(0, 2).join("#");
}

// A surjection target is PanSN, but the contig may carry a subpath offset -
// either "CHM13#0#chr10#1407250" or "GRCh38#0#chr1[585988]".  The offset is the
// start of that fragment on the real sequence, so it has to be added to the
// position or the row points at the wrong place on a contig that does not
// exist.  Same two forms splitSubpath() handles in hgPangenome.js.
function pgrSplitTarget(name) {
    var full = String(name == null ? "" : name);
    var offset = 0;
    var m = /^(.*)\[(\d+)\]$/.exec(full);
    if (m) { full = m[1]; offset = parseInt(m[2], 10); }
    var parts = full.split("#");
    if (parts.length >= 4) {
        if (!/^\d+$/.test(parts[3])) { return null; }   // unknown form - do not guess
        offset = parseInt(parts[3], 10);
    }
    if (parts.length < 3) { return null; }
    return { contig: parts[2], offset: offset };
}

function pgrAssembly(name) {
    var table = window.pangenomeAssemblies || {};
    var key = pgrHapKey(name);
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

function pgrAssemblyName(db) {
    var names = window.pangenomeAssemblyNames || {};
    return Object.prototype.hasOwnProperty.call(names, db) ? names[db] : db;
}

// What goes in the ASSEMBLY column.  Two haplotypes in the table are served
// from a hub elsewhere and are recorded as a whole URL rather than a db name;
// printing that would make the column four times wider than everything else in
// it, so take the db out of the URL.
function pgrAssemblyLabel(db) {
    if (!db) { return ""; }
    var m = /[?&]db=([^&]+)/.exec(db);
    if (m) { return decodeURIComponent(m[1]); }
    return db;
}

// Identity and coverage come back as percentages (0-100), not fractions.
function pgrPct(v) {
    return (v == null || isNaN(v)) ? null : Number(v);
}

// Reference bases a CIGAR consumes, for the end coordinate.
function pgrCigarSpan(cigar) {
    var span = 0, re = /(\d+)([MIDNSHP=X])/g, m;
    while ((m = re.exec(cigar || "")) !== null) {
        if ("MDN=X".indexOf(m[2]) >= 0) { span += parseInt(m[1], 10); }
    }
    return span;
}

// ---- transport -------------------------------------------------------------

function pgrCheck(resp) {
    if (!resp.ok) { throw new Error("HTTP " + resp.status); }
    return resp.json();
}

function pgrPoll(jobId) {
    return fetch(pgrSelf + "?cmd=poll&job_id=" + encodeURIComponent(jobId),
                 { headers: { Accept: "application/json" } }).then(pgrCheck);
}

function pgrForm(obj) {
    return Object.keys(obj).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]);
    }).join("&");
}

function pgrSurjectAll(name, index, maxTargets, minCoverage) {
    var payload = { job_id: pgrJobId(), name: name, index: index,
                    max_targets: maxTargets, min_coverage: minCoverage };
    return fetch(pgrSelf, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
                   Accept: "application/json" },
        body: pgrForm({ cmd: "surjectAll", payload: JSON.stringify(payload) })
    }).then(pgrCheck);
}

// One named haplotype at one placement.  The batch call cannot be pointed at a
// haplotype - it takes the best by coverage and ignores a list - so a haplotype
// outside that best few is placed this way, one request per placement.
function pgrSurjectOne(name, index, hap) {
    var payload = { job_id: pgrJobId(), name: name, index: index, tgt: hap };
    return fetch(pgrSelf, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
                   Accept: "application/json" },
        body: pgrForm({ cmd: "surject", payload: JSON.stringify(payload) })
    }).then(pgrCheck);
}


// Run a list of thunks a few at a time.  The backend serialises anyway, so a
// hundred simultaneous requests would only queue; this keeps the browser's own
// connection pool free as well.
function pgrPool(thunks, width) {
    var i = 0, active = 0, done = 0, out = new Array(thunks.length);
    return new Promise(function (resolve) {
        if (!thunks.length) { resolve(out); return; }
        function step() {
            while (active < width && i < thunks.length) {
                (function (n) {
                    active++;
                    thunks[n]().then(function (v) { out[n] = v; })
                        .catch(function () { out[n] = null; })
                        .then(function () {
                            active--; done++;
                            if (done === thunks.length) { resolve(out); } else { step(); }
                        });
                })(i++);
            }
        }
        step();
    });
}

// ---- row assembly ----------------------------------------------------------

// One row per record that surject_all returned, for one placement of one
// query sequence.
//
// The rows used to be built from the mapping's graded haplotype list and then
// filtered - an identity floor, a minimum row count - because placing a row
// cost a request and only a handful could be afforded.  The batch call removed
// that constraint: it selects the best max_targets by coverage itself and
// returns each one fully described, so the table is simply what it gave back.
function pgrRowsFromBatch(res, aln, index, placements, batch) {
    var carriers = Object.create(null);
    ((aln.haplotypes && aln.haplotypes.names) || []).forEach(function (n) {
        carriers[pgrHapKey(n)] = true;
    });
    var representative = aln.haplotypes && aln.haplotypes.representative;
    var repKey = representative ? pgrHapKey(representative) : null;

    return (batch.haplotypes || []).map(function (rec) {
        var key = pgrHapKey(rec.requested);
        var row = {
            query: res.name,
            queryLength: res.query_length,
            placement: index,
            placements: placements,
            hap: pgrHapShort(rec.requested),
            db: pgrAssembly(rec.requested),
            isCarrier: !!carriers[key],
            isRepresentative: key === repKey,
            isReference: !!(aln.haplotypes &&
                            aln.haplotypes.representative_is_reference) &&
                         key === repKey,
            placementScore: aln.score,
            mapq: aln.mapping_quality
        };
        pgrApplyRecord(row, rec);
        return row;
    });
}

// When the batch call fails there is still the graded list, which the mapping
// carried all along.  Those rows have no position, but a table of haplotypes
// with their identity and coverage is better than an error.
function pgrRowsFromMapping(res, aln, index, placements) {
    var representative = aln.haplotypes && aln.haplotypes.representative;
    var repKey = representative ? pgrHapKey(representative) : null;
    return (aln.haplotype_coverage || []).map(function (c) {
        return {
            query: res.name,
            queryLength: res.query_length,
            placement: index,
            placements: placements,
            hap: pgrHapShort(c.haplotype),
            db: pgrAssembly(c.haplotype),
            isCarrier: false,
            isRepresentative: pgrHapKey(c.haplotype) === repKey,
            isReference: false,
            placementScore: aln.score,
            mapq: aln.mapping_quality,
            coverage: pgrPct(c.coverage),
            listIdentity: pgrPct(c.identity)
        };
    });
}


// One record from surject_all onto its row.
//
// The record carries both identities and the server's own coverage, so nothing
// here is derived.  "identity" is the surjected alignment's, as a fraction;
// "graph_identity" is the figure the mapping already reported for the
// haplotype's walk through the graph; "coverage" is a percentage and is the
// same number the mapping's list gave.  An earlier version computed coverage
// itself, from aligned bases over query length - a different quantity, which
// made the column mean two things depending on whether the row was placed.
function pgrApplyRecord(row, rec) {
    if (rec.coverage != null) { row.coverage = rec.coverage; }
    if (rec.graph_identity != null) { row.listIdentity = rec.graph_identity; }
    if (rec.status !== "ok") {
        row.placeFailed = true;
        row.placeStatus = rec.status;
        return;
    }
    // target_start/end are local to the fragment named in "haplotype", and that
    // name carries the fragment's offset.
    var tgt = pgrSplitTarget(rec.haplotype);
    if (tgt === null) { row.placeFailed = true; return; }
    row.contig = tgt.contig;
    row.start = tgt.offset + rec.target_start;
    row.end = tgt.offset + rec.target_end;
    row.strand = rec.strand;
    row.cigar = rec.cigar;
    row.score = rec.score;
    row.surjMapq = rec.mapping_quality;
    row.matches = rec.matches;
    row.mismatches = rec.mismatches;
    row.inserted = rec.inserted;
    row.deleted = rec.deleted;
    row.alignedBases = rec.aligned_bases;
    row.identity = rec.identity == null ? null : rec.identity * 100;
    // Where on the query the alignment runs, 0-based and half-open like the
    // target coordinates, for the coverage bar.  Optional: an older service
    // does not send them, and the bar then says only how much, not where.
    if (rec.query_start != null && rec.query_end != null) {
        row.qStart = rec.query_start;
        row.qEnd = rec.query_end;
    }
}

// The mapping's own surjection, which is against the representative and comes
// free in the poll response.  Shaped differently from a batch record: the
// fragment is in "target" and the start in "position".
function pgrApplySurjection(row, resp) {
    var s = resp && resp.surjection;
    if (!s || s.status !== "ok") {
        row.placeFailed = true;
        // A haplotype with no path through this placement fails as
        // "surjection_failed" with the reason in the detail; the table says
        // "not present" for that, as it does for the batch call's "no_anchors".
        row.placeStatus = (s && /^no_anchors/.test(s.detail || "")) ? "no_anchors"
                                                                    : (s && s.status);
        return;
    }
    var tgt = pgrSplitTarget(s.target);
    if (tgt === null) { row.placeFailed = true; return; }
    row.contig = tgt.contig;
    row.start = tgt.offset + s.position;
    row.end = row.start + pgrCigarSpan(s.cigar);
    row.strand = s.strand;
    row.cigar = s.cigar;
    row.score = s.score;
    row.surjMapq = s.mapping_quality;
    row.matches = s.matches;
    row.mismatches = s.mismatches;
    row.inserted = s.inserted;
    row.deleted = s.deleted;
    row.alignedBases = s.aligned_bases;
    row.identity = s.identity == null ? null : s.identity * 100;
}

// Records are keyed by "requested", the haplotype name as it was asked for.
// "haplotype" is the fragment it landed on and is for coordinates only.
var pgrTruncated = 0;
function pgrTruncNote() {
    if (!pgrTruncated) { return null; }
    return "This is the best " + pgrFmt(pgrSurjectCount()) + " of " +
           pgrFmt(pgrTruncated) + " haplotypes that carry the sequence, by " +
           "coverage.";
}


// ---- the table -------------------------------------------------------------
//
// Laid out the way hgBlat's classic results page lays its hits out: a <TT><PRE>
// block with fixed-width columns and an ACTIONS column of plain links.  Column
// widths are measured from the data first, as showAliPlaces() does, so nothing
// is truncated and nothing is padded further than it needs to be.

// ---- the results table: cell renderers -------------------------------------
//
// The table is hgBlat's new results table - a DataTable whose cells are drawn
// here - in hgBlat.js's design: the position as a link with a new-tab icon
// after it, an "Alignment" link, a bar for the part of the query that aligned,
// and identity in hgBlat's semantic colours.  The links cannot be plain hrefs
// the way BLAT's are: the cart has to be armed with the PSL and the query FASTA
// first, and that is a POST, so each carries the row's rank and an action and
// goes through pgrAct() when clicked.

// hgBlat.js's identity colours, so a percentage reads the same in both tools.
function pgrIdColor(id) {
    if (id >= 98) { return "#1f7a34"; }
    if (id >= 95) { return "#4d7c0f"; }
    if (id >= 90) { return "#b45309"; }
    return "#b1301f";
}

// A row with no position: there is nothing to open, so say why instead.
function pgrUnplacedText(r) {
    if (r.placeStatus === "no_anchors") { return "not present"; }
    if (r.placeStatus === "surjection_failed") { return "no alignment"; }
    return "not placed";
}

function pgrPositionCell(r) {
    if (r.contig == null) {
        return '<span class="pgrUnplaced">' + pgrUnplacedText(r) + "</span>";
    }
    var rank = ' data-rank="' + r.rank + '"';
    return '<a href="#"' + rank + ' data-act="browser" ' +
           'title="Open the Genome Browser on this haplotype, with your sequence drawn on it">' +
           pgrEsc(r.contig) + ":" + pgrFmt(r.start + 1) + "-" + pgrFmt(r.end) + "</a>" +
           ' <a class="pgrNewTab" href="#"' + rank + ' data-act="newtab" ' +
           'title="Open in a new tab" aria-label="Open in a new tab"></a>';
}

function pgrActionsCell(r) {
    if (r.contig == null) { return ""; }
    return '<a href="#" data-rank="' + r.rank + '" data-act="details" ' +
           'title="Show the base-by-base alignment of your sequence to this haplotype">' +
           "Alignment</a>";
}

// The bar shows where on the query the alignment runs; the figure after it is
// the coverage - the share of the query's bases that aligned.  hgBlat prints
// the query start and end there instead, which is what a primer search needs;
// here the coverage is the figure people compare haplotypes by, so it takes
// that place and the range goes in the tooltip.  A row from the graded list,
// which has no extent, still gets its figure.
function pgrCoverageCell(r) {
    if (r.coverage == null) { return ""; }
    var pct = r.coverage.toFixed(1) + "%";
    var qSize = r.queryLength;
    if (r.qStart == null || !qSize) {
        return '<span class="pgrCovNum">' + pct + "</span>";
    }
    var left = r.qStart / qSize * 100;
    var width = (r.qEnd - r.qStart) / qSize * 100;
    var tip = "Bases " + pgrFmt(r.qStart + 1) + "-" + pgrFmt(r.qEnd) + " of your " +
              pgrFmt(qSize) + " bp sequence aligned here, " + pct + " of it in all";
    return '<span class="pgrCovWrap" title="' + tip + '"><span class="pgrCov">' +
           '<i style="left:' + left.toFixed(1) + "%;width:" + width.toFixed(1) + '%"></i>' +
           '</span><span class="pgrCovNum">' + pct + "</span></span>";
}

function pgrIdentityCell(r) {
    var id = pgrIdentityOf(r);
    if (id == null) { return ""; }
    return '<span class="pgrIdPct" style="color:' + pgrIdColor(id) + '">' +
           id.toFixed(1) + "%</span>";
}

function pgrMapqOf(r) {
    return (r.surjMapq == null) ? r.mapq : r.surjMapq;
}

// MAPQ is shown as the number, so a reader who knows it can weigh it; a low one
// is marked, with the explanation on the mouse-over, since it is the one value
// in a row that says the position itself may be wrong.
function pgrMapqCell(r) {
    var q = pgrMapqOf(r);
    if (q == null || isNaN(Number(q))) { return ""; }
    q = Number(q);
    if (q < 10) {
        return '<span class="pgrLowMapq" title="Low mapping quality: the mapper could not ' +
               'tell which copy of a duplicated region this sequence came from, so this ' +
               'position may belong to another copy.">' + q + "</span>";
    }
    return String(q);
}

// The box picks this haplotype out in the ancestry plot.  Only a row the plot
// can draw has one: GRCh38 has no pcLAI at all - it is a mosaic, not a sampled
// haplotype - and CHM13 has none in assembly coordinates, so a box on either
// could only ever do nothing.
function pgrPickCell(r) {
    // A row aligned on request is not in the plot, which was given the table's
    // rows when it was drawn.
    if (!pgrPclaiSpot(r) || r.extra) { return ""; }
    var on = (typeof pgpPicked !== "undefined") && pgpPicked[r.hap];
    return '<input type="checkbox" class="pgrPick" data-hap="' + pgrEsc(r.hap) + '"' +
           (on ? " checked" : "") + ' title="Pick this haplotype out in the ancestry plot">';
}

// ---- opening a row in the browser -----------------------------------------

// The cart has to carry the PSL and the query FASTA before hgTracks can draw
// the sequence, and writing them is a POST.  The query itself is not on this
// page - it was left on the search form - so the job id goes instead and the
// CGI reads the sequence back from the copy taken at submit time.
// Armed afresh on every click, never reused: "ss" is a single cart variable,
// so opening another row in between points it at that row's alignment, and a
// remembered URL would then open this one with the other's sequence.
function pgrArm(row, opening) {
    var payload = {
        db: row.db, contig: row.contig, name: row.query, job_id: pgrJobId(),
        cigar: row.cigar, start: row.start, strand: row.strand,
        // Opening the browser: drop what was lifted onto the last haplotype.
        dropLifts: opening ? "on" : "off"
    };
    var body = { cmd: "alignTrack", payload: JSON.stringify(payload) };
    var hgsid = pgrCfg().hgsid;
    if (hgsid) { body.hgsid = hgsid; }
    return fetch(pgrSelf, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
                   Accept: "application/json" },
        body: pgrForm(body)
    }).then(pgrCheck).then(function (resp) {
        if (!resp || resp.status === "error") {
            throw new Error((resp && resp.error) || "could not prepare the track");
        }
        return resp;
    });
}

// ---- a reference's annotations on the haplotype ---------------------------
//
// One choice for the whole page, in the strip: when a haplotype is opened, the
// tracks the user has turned on in GRCh38 (or CHM13) come with it, carried
// across through the graph by cmd=refAnnot.  The choice comes from the link
// (refAnnot=), else what this viewer chose last, else the install's default.

var pgrAnnotRef = null;     // {hap, label, db} or null for none

function pgrAnnotRefs() {
    return pgrPage().annotRefs || [];
}

// "GRCh38", "grch38#0", "none" -> the reference it names, null for none,
// undefined when it names nothing this page knows.
function pgrAnnotMatch(name) {
    if (name == null || name === "") { return undefined; }
    var key = String(name).toLowerCase();
    if (key === "none" || key === "off") { return null; }
    var found = pgrAnnotRefs().filter(function (r) {
        return r.hap.toLowerCase() === key || r.label.toLowerCase() === key;
    });
    return found.length ? found[0] : undefined;
}

function pgrAnnotInit() {
    var page = pgrPage();
    var saved = null;
    try { saved = window.localStorage.getItem("hgPangenome.annotRef"); } catch (e) { saved = null; }
    var picks = [page.annotUrl, saved, page.annotDefault];
    for (var i = 0; i < picks.length; i++) {
        var m = pgrAnnotMatch(picks[i]);
        if (m !== undefined) { pgrAnnotRef = m; return; }
    }
    pgrAnnotRef = null;
}

function pgrAnnotSet(value) {
    var m = pgrAnnotMatch(value);
    pgrAnnotRef = (m === undefined) ? null : m;
    try {
        window.localStorage.setItem("hgPangenome.annotRef", pgrAnnotRef ? pgrAnnotRef.hap : "none");
    } catch (e) { /* remembered for this page only */ }
}

// The reference whose annotations this row would open with, or null: none is
// chosen, the row has no position, it is a hub assembly the browser opens
// elsewhere, or it is that reference already.
function pgrAnnotFor(row) {
    var ref = pgrAnnotRef;
    if (!ref || row.contig == null || !row.db || /^https?:/.test(row.db)) { return null; }
    return pgrHapKey(row.hap) === pgrHapKey(ref.hap) ? null : ref;
}

function pgrRefAnnot(row, ref, position) {
    var payload = { db: row.db, path: row.hap + "#" + row.contig, start: row.start,
                    end: row.end, ref: ref.hap, position: position };
    var body = { cmd: "refAnnot", payload: JSON.stringify(payload) };
    var hgsid = pgrCfg().hgsid;
    if (hgsid) { body.hgsid = hgsid; }
    return fetch(pgrSelf, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
                   Accept: "application/json" },
        body: pgrForm(body)
    }).then(pgrCheck).then(function (resp) {
        if (!resp || resp.status !== "ok" || !resp.url) {
            throw new Error((resp && resp.error) || "no answer");
        }
        return resp;
    });
}

// The armed URL opens the right genome, by the name that keeps the sequence
// track; the annotation URL adds the hubs that carry the lifted tracks.  Take
// the first, and from the second everything but its db and position.
function pgrJoinUrl(armedUrl, annotUrl) {
    var q = String(annotUrl).split("?")[1] || "";
    var extra = q.split("&").filter(function (kv) {
        var k = kv.split("=")[0];
        return kv && k !== "db" && k !== "position";
    });
    return extra.length ? armedUrl + "&" + extra.join("&") : armedUrl;
}

function pgrQueryParam(url, name) {
    var m = new RegExp("[?&]" + name + "=([^&]*)").exec(String(url));
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
}

function pgrAnnotControl() {
    var refs = pgrAnnotRefs();
    if (!refs.length) { return ""; }
    var cur = pgrAnnotRef ? pgrAnnotRef.hap : "";
    var opts = refs.map(function (r) {
        return '<option value="' + pgrEsc(r.hap) + '"' + (r.hap === cur ? " selected" : "") +
               ">" + pgrEsc(r.label) + "</option>";
    }).concat('<option value="none"' + (cur ? "" : " selected") + ">none</option>");
    return '<div class="gbStat pgrAnnotStat"><span class="k" title="When you open a ' +
           "haplotype in the Genome Browser, the tracks you have turned on in this " +
           "reference come with it, carried across through the pangenome graph. " +
           'Choose none to open the haplotype with only its own tracks.">' +
           "Annotations from</span>" +
           '<span class="v"><select id="pgrAnnotRef">' + opts.join("") + "</select></span></div>";
}

function pgrAct(row, what, link) {
    // "plain" is the browser link again, without the annotations - offered
    // when bringing them failed.
    var plain = what === "plain";
    if (plain) { what = "browser"; }
    var ref = (what === "details" || plain) ? null : pgrAnnotFor(row);
    // Only the link that is about to sit there waiting says so.  "new tab" is
    // never touched: its label carries the little new-tab icon as an <svg>, and
    // restoring it through textContent would write back the plain words and
    // take the icon with it - the row then no longer lines up with the others.
    var busy = !!link && what !== "newtab";
    var was = busy ? link.innerHTML : null;
    if (busy) { link.innerHTML = "opening&#8230;"; }
    // A new tab has to be opened in the click itself or the popup blocker takes
    // it, so it is opened now and pointed at the answer when it arrives.
    var tab = (what === "newtab") ? window.open("", "_blank") : null;
    pgrArm(row, what !== "details").then(function (resp) {
        if (what === "details") { return resp.details; }
        if (!ref) { return resp.url; }
        if (busy) { link.innerHTML = "adding " + pgrEsc(ref.label) + " annotations&#8230;"; }
        return pgrRefAnnot(row, ref, pgrQueryParam(resp.url, "position"))
            .then(function (annot) { return pgrJoinUrl(resp.url, annot.url); })
            .catch(function (err) {
                // Opening anyway would hide why the tracks are missing, so stay
                // and say so, with the plain link one click away.
                err.annot = ref;
                throw err;
            });
    }).then(function (url) {
        if (busy) { link.innerHTML = was; }
        if (tab) { tab.location = url; } else { window.location = url; }
    }).catch(function (err) {
        if (busy) { link.innerHTML = was; }
        if (tab) { tab.close(); }
        if (err.annot) {
            pgrFail("Could not bring " + err.annot.label + " annotations onto " + row.hap +
                    ": " + err.message + ".", row);
        } else {
            pgrFail("Could not open this match: " + err.message);
        }
    });
}

// ---- remembering the finished table ----------------------------------------
//
// Coming back from the Genome Browser is an ordinary load of this URL, so
// without this the page polls and surjects all over again and the reader waits
// through it a second time for a table they have already seen.  sessionStorage
// is the right size of memory for that: it belongs to this tab, it survives
// back and forward, and it is gone when the tab is.
//
// Every read and write is guarded.  A private window, blocked site data or a
// full quota all throw, and none of them is a reason to fail: the page just
// does the work again.
function pgrCacheKey(job) {
    return "hgPangenomeResults:" + job;
}

function pgrCacheRead(job) {
    try {
        var raw = window.sessionStorage.getItem(pgrCacheKey(job));
        if (!raw) { return null; }
        var saved = JSON.parse(raw);
        return (saved && saved.rows && saved.rows.length) ? saved : null;
    } catch (e) { return null; }
}

// Written again whenever the table changes after it was first drawn - a
// haplotype placed on request, or the table narrowed to one - so that coming
// back from the browser finds it as it was left.
function pgrCacheWrite(job) {
    try {
        window.sessionStorage.setItem(pgrCacheKey(job), JSON.stringify({
            // Only what the table is drawn from.  The mapping response itself is
            // far larger, and is fetched again in the rare case it is needed.
            rows: pgrRows,
            queries: pgrQueryCount,
            queryNames: pgrQueryNames,
            note: pgrNote,
            focus: pgrFocus,
            places: pgrPlaceList,
            loaded: pgrLoaded,
            allPlaces: pgrAllPlaces
        }));
    } catch (e) { /* no memory to spare; the page will just rebuild it */ }
}

// ---- the other placements --------------------------------------------------
//
// Every job asks for as many placements as the install allows, but the table
// opens on each sequence's best one: for most sequences the rest are weaker
// repeats.  A bar above the table says how many others there are - more
// urgently when the best one's MAPQ says the mapper could not tell them apart -
// and fetches them when asked.  Once fetched they are kept, and the bar
// switches between all placements and the best only without asking again.

function pgrPlaceKey(query, index) {
    return query + "\u0000" + index;
}

// The batch call for one placement, falling back to the graded list when it
// fails, as the table always has.
function pgrBatchRows(res, aln, index) {
    var placements = (res.alignments || []).length;
    return pgrSurjectAll(res.name, index, pgrSurjectCount(), pgrMinCoverage())
        .then(function (batch) {
            if (batch && batch.haplotypes) {
                if (batch.truncated) {
                    pgrTruncated = Math.max(pgrTruncated, batch.candidates || 0);
                }
                return pgrRowsFromBatch(res, aln, index, placements, batch);
            }
            return pgrRowsFromMapping(res, aln, index, placements);
        })
        .catch(function () { return pgrRowsFromMapping(res, aln, index, placements); });
}

// Put the rows in table order and number them: the table's own first, so the
// "#" column counts 1, 2, 3 with no gaps, then the rows aligned on request for
// one haplotype, which show no number.  A row's rank is its index in pgrRows.
function pgrRerank() {
    var order = pgrRowOrder(pgrQueryNames);
    var main = pgrRows.filter(function (r) { return !r.extra; }).sort(order);
    var extra = pgrRows.filter(function (r) { return r.extra; }).sort(order);
    pgrRows = main.concat(extra);
    pgrRows.forEach(function (r, i) { r.rank = i; });
}

function pgrOtherPlaces() {
    return pgrPlaces().filter(function (p) { return p.index > 0; });
}

// The best placement's MAPQ for each query that has others, from its rows.
function pgrLowMapqQueries() {
    var low = Object.create(null);
    pgrRows.forEach(function (r) {
        if (r.placement === 0 && !r.extra && r.placements > 1 && r.mapq != null &&
            Number(r.mapq) < 10) { low[r.query] = Number(r.mapq); }
    });
    return low;
}

function pgrMoreHtml() {
    var others = pgrOtherPlaces();
    if (!others.length) { return ""; }
    if (pgrMoreBusy) {
        return '<span class="gbSpinner"></span><span>Aligning your sequence to the ' +
               "other places it was found&#8230;</span>";
    }
    if (pgrAllPlaces) {
        return "<span>Showing every place your " +
               (pgrQueryCount > 1 ? "sequences" : "sequence") + " aligned. " +
               "Placement 1 is the best of each.</span>" +
               '<button type="button" class="gbPill" data-pgr="bestonly">' +
               "Best placement only</button>";
    }
    var low = pgrLowMapqQueries();
    var nLow = Object.keys(low).length;
    var msg;
    if (pgrQueryCount > 1) {
        var qs = Object.create(null);
        others.forEach(function (p) { qs[p.query] = true; });
        var nq = Object.keys(qs).length;
        msg = pgrFmt(nq) + " of your sequences also " + (nq === 1 ? "aligns" : "align") +
              " to other places (" + pgrFmt(others.length) + " in all). The table " +
              "shows only the best place for each.";
        if (nLow) {
            msg += " For " + pgrFmt(nLow) + " of them the mapper could not tell the " +
                   "places apart (low MAPQ), so the others may be just as likely.";
        }
    } else {
        var n = others.length;
        msg = "Your sequence also aligns to " + pgrFmt(n) + " other " +
              (n === 1 ? "place" : "places") + ". ";
        msg += nLow ?
            "The mapper could not tell " + (n === 1 ? "it" : "them") + " apart from the " +
            "best one (MAPQ " + low[Object.keys(low)[0]] + "), so " +
            (n === 1 ? "it may be" : "they may be") + " just as likely." :
            "The table shows only the best one.";
    }
    if (pgrMoreErr) {
        msg += " Could not load them: " + pgrEsc(pgrMoreErr) + ".";
    }
    return "<span>" + msg + "</span>" +
           '<button type="button" class="gbPill" data-pgr="more">Show other placements</button>';
}

// The bar is hidden while the table is narrowed to one haplotype: that view
// already shows every placement, and says so in its own bar.
function pgrMoreShow() {
    var bar = document.getElementById("pgrMoreBar");
    if (!bar) { return; }
    var html = pgrFocus ? "" : pgrMoreHtml();
    bar.hidden = !html;
    bar.innerHTML = html;
    var low = !pgrAllPlaces && Object.keys(pgrLowMapqQueries()).length > 0;
    bar.className = "pgrBar" + (low ? " warn" : "");
}

// The Placement column only means something when more than one placement can
// be on screen.
function pgrPlaceColShow() {
    if (!pgrDt) { return; }
    var col = pgrDt.column(".placeCol");
    if (col && col.length) { col.visible(!!(pgrFocus || pgrAllPlaces)); }
}

function pgrShowMore() {
    var todo = pgrOtherPlaces().filter(function (p) {
        return !pgrLoaded[pgrPlaceKey(p.query, p.index)];
    });
    if (!todo.length) {
        pgrAllPlaces = true;
        pgrCacheWrite(pgrJobId());
        pgrRedraw();
        return;
    }
    pgrMoreBusy = true;
    pgrMoreErr = null;
    pgrMoreShow();
    pgrMappingReady().then(function (results) {
        var byName = Object.create(null);
        results.forEach(function (res) { byName[res.name] = res; });
        return pgrPool(todo.map(function (p) {
            return function () {
                var res = byName[p.query], aln = res && (res.alignments || [])[p.index];
                if (!aln) { return Promise.resolve(null); }
                return pgrBatchRows(res, aln, p.index).then(function (rows) { p.rows = rows; });
            };
        }), 3);
    }).then(function () {
        todo.forEach(function (p) {
            if (!p.rows) { return; }
            pgrLoaded[pgrPlaceKey(p.query, p.index)] = true;
            // A haplotype placed on request here now has its table row.
            var have = Object.create(null);
            p.rows.forEach(function (r) { have[pgrHapKey(r.hap)] = true; });
            pgrRows = pgrRows.filter(function (r) {
                return !(r.extra && r.query === p.query && r.placement === p.index &&
                         have[pgrHapKey(r.hap)]);
            }).concat(p.rows);
        });
        pgrRerank();
        pgrNote = pgrTruncNote() || pgrNote;
        pgrMoreBusy = false;
        pgrAllPlaces = true;
        pgrCacheWrite(pgrJobId());
        pgrRedraw();
    }).catch(function (err) {
        pgrMoreBusy = false;
        pgrMoreErr = err.message || "the mapping is no longer available";
        pgrMoreShow();
    });
}

function pgrBestOnly() {
    pgrAllPlaces = false;
    pgrCacheWrite(pgrJobId());
    pgrRedraw();
}

// The whole table again: the rows were renumbered, or the plot needs the new
// placements.
function pgrRedraw() {
    pgrDraw(pgrQueryCount, pgrRows, pgrNote);
}

// ---- one haplotype on its own ----------------------------------------------
//
// The table is the best few haplotypes at each placement, so a haplotype can be
// in it at one placement and missing at another, and one outside the best few
// is not in it at all.  Narrowing the table to one haplotype shows it at every
// placement of every query: rows already there are reused, and the rest are
// aligned now, one request each.  Those extra rows are kept apart ("extra") -
// the full table never shows them, so it stays the best-few table it says it is.

var pgrMapping = null;      // the mapping's results, while this page has them
var pgrQueryNames = [];     // query names in the order they were given
var pgrQueryCount = 0;
var pgrNote = null;
var pgrFocus = null;        // the haplotype the table is narrowed to, or null
var pgrFocusBusy = false;
var pgrDt = null;
var pgrPlaceList = null;    // every (query, placement), from the mapping
var pgrLoaded = {};         // the placements whose batch call has been made
var pgrAllPlaces = false;   // showing every placement, not just each best
var pgrMoreBusy = false;
var pgrMoreErr = null;

// The picker's names, from the haplotype->assembly table that is already on
// the page.  Its keys are lower-cased; the server wants them as PanSN spells
// them, which is upper case for every sample.
function pgrHapDisplay(key) {
    if (key === "chm13#0") { return "CHM13#0"; }
    if (key === "grch38#0") { return "GRCh38#0"; }
    return String(key).toUpperCase();
}

function pgrHapNames() {
    var table = window.pangenomeAssemblies || {};
    var refs = ["chm13#0", "grch38#0"];
    return refs.filter(function (k) { return k in table; })
        .concat(Object.keys(table).filter(function (k) { return refs.indexOf(k) < 0; }).sort())
        .map(pgrHapDisplay);
}

// What was typed, as a haplotype the page knows, or null.  Case and spaces do
// not matter, and "HG00097.1" or "HG00097 1" is read as "HG00097#1".
function pgrHapResolve(text) {
    var key = String(text == null ? "" : text).trim().toLowerCase()
        .replace(/^([a-z]+\d+)[\s._#-]+(\d)$/, "$1#$2");
    var table = window.pangenomeAssemblies || {};
    return Object.prototype.hasOwnProperty.call(table, key) ? pgrHapDisplay(key) : null;
}

// Every (query, placement) the haplotype should have a row for.  From the
// mapping when the page has it; otherwise from the rows, which name every
// placement of every query that had any.
function pgrPlaces() {
    var out = [];
    if (pgrPlaceList) { return pgrPlaceList; }
    if (pgrMapping) {
        pgrMapping.forEach(function (res) {
            (res.alignments || []).forEach(function (aln, index) {
                out.push({ query: res.name, index: index });
            });
        });
        return out;
    }
    var seen = Object.create(null);
    pgrRows.forEach(function (r) {
        for (var i = 0; i < (r.placements || 1); i++) {
            var k = r.query + "\u0000" + i;
            if (!seen[k]) { seen[k] = true; out.push({ query: r.query, index: i }); }
        }
    });
    return out;
}

function pgrHasRow(hap, query, index) {
    var key = pgrHapKey(hap);
    return pgrRows.some(function (r) {
        return r.query === query && r.placement === index && pgrHapKey(r.hap) === key;
    });
}

// The mapping, fetched again if this page was drawn from the tab's memory.
function pgrMappingReady() {
    if (pgrMapping) { return Promise.resolve(pgrMapping); }
    return pgrPoll(pgrJobId()).then(function (resp) {
        if (!resp || !resp.results) {
            throw new Error((resp && resp.error) || "the mapping is no longer available");
        }
        pgrMapping = resp.results;
        return pgrMapping;
    });
}

// A row for a haplotype the batch call did not return, built the way
// pgrRowsFromMapping() builds one - the mapping's coverage and identity for it
// at this placement - and then placed by its own surjection.
function pgrRowForHap(res, aln, index, hap, resp) {
    var key = pgrHapKey(hap);
    var cov = (aln.haplotype_coverage || []).filter(function (c) {
        return pgrHapKey(c.haplotype) === key;
    })[0];
    var rep = aln.haplotypes && aln.haplotypes.representative;
    var row = {
        query: res.name,
        queryLength: res.query_length,
        placement: index,
        placements: (res.alignments || []).length,
        hap: pgrHapShort(hap),
        db: pgrAssembly(hap),
        isCarrier: ((aln.haplotypes && aln.haplotypes.names) || []).some(function (n) {
            return pgrHapKey(n) === key;
        }),
        isRepresentative: !!rep && pgrHapKey(rep) === key,
        isReference: false,
        placementScore: aln.score,
        mapq: aln.mapping_quality,
        coverage: cov ? pgrPct(cov.coverage) : null,
        listIdentity: cov ? pgrPct(cov.identity) : null,
        extra: true
    };
    pgrApplySurjection(row, resp);
    // The MAPQ is the placement's; on a row with no position it describes
    // nothing that row shows.
    if (row.placeFailed) { row.mapq = null; }
    return row;
}

function pgrFocusOn(hap) {
    hap = pgrHapShort(hap);
    pgrFocus = hap;
    var missing = pgrPlaces().filter(function (p) { return !pgrHasRow(hap, p.query, p.index); });
    if (!missing.length) { pgrFocusShow(); return; }

    pgrFocusBusy = true;
    pgrFocusShow();
    var failed = 0;
    pgrMappingReady().then(function (results) {
        var byName = Object.create(null);
        results.forEach(function (res) { byName[res.name] = res; });
        return pgrPool(missing.map(function (p) {
            return function () {
                var res = byName[p.query], aln = res && (res.alignments || [])[p.index];
                if (!aln) { return Promise.resolve(null); }
                return pgrSurjectOne(res.name, p.index, hap).then(function (resp) {
                    if (!resp || !resp.surjection) {
                        throw new Error((resp && resp.error) || (resp && resp.status) || "no answer");
                    }
                    return pgrRowForHap(res, aln, p.index, hap, resp);
                });
            };
        }), 3);
    }).then(function (rows) {
        rows.forEach(function (r) {
            if (!r) { failed++; return; }
            if (pgrHasRow(r.hap, r.query, r.placement)) { return; }   // asked twice
            r.rank = pgrRows.length;
            pgrRows.push(r);
        });
    }).catch(function () {
        failed = missing.length;
    }).then(function () {
        pgrFocusBusy = false;
        if (pgrHapKey(pgrFocus) !== pgrHapKey(hap)) { return; }    // moved on meanwhile
        pgrFocusShow(failed);
    });
}

function pgrFocusOff() {
    pgrFocus = null;
    pgrFocusShow();
}

// Redraw the table for the current focus, and say what it is showing.
function pgrFocusShow(failed) {
    if (pgrDt) {
        // The rows go back in their sorted order, the new ones among them, and
        // the filter registered in pgrDraw() decides which are shown.
        var sorted = pgrRows.slice().sort(pgrRowOrder(pgrQueryNames));
        pgrDt.clear();
        pgrDt.rows.add(sorted);
        pgrDt.draw();
    }
    var bar = document.getElementById("pgrFocusBar");
    if (bar) {
        if (!pgrFocus) {
            bar.hidden = true;
            bar.innerHTML = "";
        } else if (pgrFocusBusy) {
            bar.hidden = false;
            bar.innerHTML = '<span class="gbSpinner"></span><span>Aligning your sequence to <b>' +
                pgrEsc(pgrFocus) + "</b> at each place it aligned&#8230;</span>";
        } else {
            var key = pgrHapKey(pgrFocus);
            var mine = pgrRows.filter(function (r) { return pgrHapKey(r.hap) === key; });
            var extra = mine.filter(function (r) { return r.extra; }).length;
            var msg = "Showing only <b>" + pgrEsc(pgrFocus) + "</b>, at every place your " +
                      "sequence aligned.";
            if (extra) {
                msg += " Rows with no number are not in the full table, and were " +
                       "aligned just now.";
            }
            if (failed) {
                msg += " " + pgrFmt(failed) + (failed === 1 ? " place" : " places") +
                       " could not be aligned; the mapping job may have expired.";
            }
            bar.hidden = false;
            bar.innerHTML = "<span>" + msg + "</span>" +
                '<button type="button" class="gbPill" data-pgr="unfocus">Show all haplotypes</button>';
        }
    }
    pgrPlaceColShow();
    pgrMoreShow();
    // The detail panel's button says "all hits" or "all haplotypes" by focus;
    // a selected row that the narrowed table no longer shows is let go.
    var sel = (pgrSelRank !== null) ? pgrRows[pgrSelRank] : null;
    if (sel && pgrFocus && pgrHapKey(sel.hap) !== pgrHapKey(pgrFocus)) {
        sel = null;
        pgrSelRank = null;
        jQuery("#pgrTable tbody tr").removeClass("pgrSel");
        document.getElementById("pgrDetail").innerHTML = pgrHintHtml();
    }
    if (sel) { document.getElementById("pgrDetail").innerHTML = pgrDetailHtml(sel); }
    if (!pgrFocusBusy) { pgrCacheWrite(pgrJobId()); }
}

// The "Find a Haplotype" box under the strip: a name field with the page's
// haplotypes as suggestions.
function pgrShowHapBox() {
    var box = document.getElementById("pgrHapBox");
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    if (!box.innerHTML) {
        box.innerHTML =
            '<span class="gbShareMsg">Show one haplotype at every place your sequence ' +
            "aligned, even if it is not in the table:</span>" +
            '<input type="text" id="pgrHapInput" class="pgrHapInput" list="pgrHapList" ' +
            'placeholder="e.g. HG00097#1" autocomplete="off" spellcheck="false">' +
            '<datalist id="pgrHapList">' + pgrHapNames().map(function (n) {
                return '<option value="' + pgrEsc(n) + '">'; }).join("") + "</datalist>" +
            '<button type="button" class="gbPill primary" id="pgrHapGo">Show</button>' +
            '<button type="button" class="gbPill" id="pgrHapClose">Close</button>' +
            '<span class="pgrHapErr" id="pgrHapErr"></span>';
        var input = document.getElementById("pgrHapInput");
        var go = function () {
            var hap = pgrHapResolve(input.value);
            var err = document.getElementById("pgrHapErr");
            if (!hap) {
                err.textContent = input.value.trim() ?
                    "No haplotype called “" + input.value.trim() + "”. " +
                    "Pick one from the list, e.g. HG00097#1." : "Type a haplotype name.";
                return;
            }
            err.textContent = "";
            input.value = hap;
            pgrFocusOn(hap);
        };
        document.getElementById("pgrHapGo").onclick = go;
        input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); go(); }
        });
        document.getElementById("pgrHapClose").onclick = function () { box.hidden = true; };
    }
    document.getElementById("pgrHapInput").focus();
}

// ---- page ------------------------------------------------------------------

function pgrPage() {
    return (typeof pangenomeResultsPage !== "undefined" && pangenomeResultsPage) || {};
}

// A problem with one action - an alignment that would not open, say - goes in a
// line at the top of the results card, where it is seen without hiding them.
function pgrFail(msg, plainRow) {
    var slot = document.getElementById("pgrErr");
    if (!slot) {
        var el = document.getElementById("pgrResults");
        slot = document.createElement("div");
        slot.id = "pgrErr";
        el.insertBefore(slot, el.firstChild);
    }
    slot.className = "pgrErr";
    slot.textContent = msg;
    if (plainRow) {
        // Inside #pgrResults, so the page's one click handler opens it.
        var a = document.createElement("a");
        a.href = "#";
        a.setAttribute("data-rank", plainRow.rank);
        a.setAttribute("data-act", "plain");
        a.textContent = "Open it without them";
        slot.appendChild(document.createTextNode(" "));
        slot.appendChild(a);
    }
}

// ---- summary strip, detail panel, downloads --------------------------------

function pgrStat(k, v) {
    return '<div class="gbStat"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>";
}

function pgrSummaryStrip(queries, rows, multiPlace) {
    var div = '<span class="gbDiv"></span>';
    var stats;
    if (queries > 1) {
        stats = pgrStat("Queries", pgrFmt(queries));
    } else {
        var r0 = rows[0] || {};
        stats = pgrStat("Query", pgrEsc(r0.query || "")) + div +
                pgrStat("Length", pgrFmt(r0.queryLength || 0) + " bp");
        if (multiPlace) { stats += div + pgrStat("Placements", pgrFmt(r0.placements)); }
    }
    stats += div + pgrStat("Haplotypes", pgrFmt(rows.length));
    var annot = pgrAnnotControl();
    if (annot) { stats += div + annot; }
    var page = pgrPage();
    var acts = "";
    if (page.querySeqs && page.querySeqs.length) {
        acts += '<button type="button" class="gbPill" id="pgrSeqBtn" ' +
                'title="Show the sequence you searched with, in FASTA format">' +
                "Show Query Sequence</button>";
    }
    acts += '<button type="button" class="gbPill" id="pgrHapBtn" title="Show one haplotype ' +
            "at every place your sequence aligned, including one that is not in the " +
            'table">Find a Haplotype</button>';
    acts += '<button type="button" class="gbPill" id="pgrTsvBtn" title="Download the rows ' +
            "below, in their current order and filter, as a tab-separated file that opens " +
            'in Excel">Download Table</button>';
    if (pgrPclaiReady()) {
        // pgpInit() in hgPangenomePclai.js wires this button and keeps its label.
        acts += '<button type="button" class="gbPill" id="pgrPclaiBtn" title="Where these ' +
                'haplotypes sit in the pcLAI reference space">Show ancestry plot</button>';
    }
    return '<div class="gbStrip">' + stats + '<span class="gbStripActions">' + acts + "</span></div>";
}

function pgrTile(k, v, tip) {
    return '<div class="pgrTile"><div class="k" title="' + pgrEsc(tip) + '">' + k +
           '</div><div class="v">' + v + "</div></div>";
}

// The selected row, in hgBlat.js's docked detail panel: its figures as tiles,
// and the row's two links as buttons.  They are the same <a data-rank> links the
// table uses, so the one click handler opens both.
function pgrDetailHtml(r) {
    var id = pgrIdentityOf(r), q = pgrMapqOf(r);
    var tiles = [
        pgrTile("Identity", id == null ? "—" :
                '<span style="color:' + pgrIdColor(id) + '">' + id.toFixed(1) + "%</span>",
                "Percent identity of the aligned bases."),
        pgrTile("Coverage", r.coverage == null ? "—" : r.coverage.toFixed(1) + "%",
                "Share of the query's bases that aligned to this haplotype."),
        pgrTile("MAPQ", q == null ? "—" : pgrMapqCell(r),
                "Mapping quality: how sure the mapper is that it chose the right copy " +
                "of a repeated region. 60 is certain; under 10 is doubtful."),
        pgrTile("Strand", pgrEsc(r.strand || "—"), "Strand of this haplotype the sequence matched."),
        pgrTile("Matches", r.matches == null ? "—" : pgrFmt(r.matches), "Bases that match."),
        pgrTile("Mismatches", r.mismatches == null ? "—" : pgrFmt(r.mismatches),
                "Bases that differ between your sequence and this haplotype."),
        pgrTile("Inserted", r.inserted == null ? "—" : pgrFmt(r.inserted),
                "Bases in your sequence that are not in this haplotype."),
        pgrTile("Deleted", r.deleted == null ? "—" : pgrFmt(r.deleted),
                "Bases in this haplotype that are not in your sequence.")
    ];
    if (r.qStart != null) {
        tiles.push(pgrTile("Q span", pgrFmt(r.qStart + 1) + "-" + pgrFmt(r.qEnd),
                           "Range of your sequence that aligned (1-based)."));
    }
    if (r.placements > 1) {
        tiles.push(pgrTile("Placement", (r.placement + 1) + " of " + r.placements +
                           (r.placement === 0 ? " (best)" : ""),
                           "Which of the places in the graph this sequence aligned to."));
    }
    var where = r.contig == null ? pgrUnplacedText(r) :
                pgrEsc(r.contig) + ":" + pgrFmt(r.start + 1) + "-" + pgrFmt(r.end);
    // Narrowing to this haplotype is only worth offering when it has more than
    // one place to be: several placements, or several queries.
    var focus = pgrFocus ?
        '<a class="gbPill" href="#" data-rank="' + r.rank + '" data-act="unfocus" ' +
        'title="Back to the full table">Show all haplotypes</a>' :
        (pgrPlaces().length > 1 ?
         '<a class="gbPill" href="#" data-rank="' + r.rank + '" data-act="focus" ' +
         'title="Show only this haplotype, at every place your sequence aligned - ' +
         'including those where it is not among the best">All hits on this haplotype</a>' : "");
    var acts = (r.contig == null && !focus) ? "" :
        '<div class="pgrDetailActions">' +
        (r.contig == null ? "" :
         '<a class="gbPill primary" href="#" data-rank="' + r.rank + '" data-act="browser">' +
         "View in Genome Browser</a>" +
         '<a class="gbPill" href="#" data-rank="' + r.rank + '" data-act="details">Alignment</a>') +
        focus + "</div>";
    return '<div class="dhead"><span class="lab">Selected</span>' +
           '<span class="loc">' + pgrEsc(r.hap) + "</span>" +
           '<span class="lab">' + pgrEsc(pgrAssemblyName(r.db) || pgrAssemblyLabel(r.db)) +
           " · " + where + "</span></div>" +
           '<div class="pgrDetailCard"><div class="pgrTiles">' + tiles.join("") + "</div></div>" +
           acts;
}

function pgrHintHtml() {
    return '<div class="pgrSelectHint">Click a row below to see how your sequence ' +
           "aligned to that haplotype. Click its position to open the Genome Browser " +
           "with your sequence drawn on it.</div>";
}

function pgrFasta(seqs) {
    return seqs.map(function (q) {
        var body = String(q.seq || "").toUpperCase().replace(/(.{60})/g, "$1\n").replace(/\n$/, "");
        return ">" + q.name + "\n" + body;
    }).join("\n") + "\n";
}

function pgrDownload(text, fileName, mime) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 0);
}

// One line per row, positions 1-based as on the page, then the counts and the
// CIGAR, which with the start is enough to rebuild the alignment - as hgBlat's
// download carries the PSL block lists for the same reason.
function pgrRowsToTsv(rows) {
    var clean = function (v) {
        return String(v === undefined || v === null ? "" : v).replace(/[\t\r\n]/g, " ");
    };
    var head = ["query", "placement", "haplotype", "assembly", "contig", "strand", "start",
                "end", "span", "identity", "coverage", "mapq", "qStart", "qEnd", "qSize",
                "matches", "mismatches", "inserted", "deleted", "cigar"];
    var lines = [head.join("\t")];
    rows.forEach(function (r) {
        var placed = r.contig != null, id = pgrIdentityOf(r);
        lines.push([r.query, r.placement + 1, r.hap, pgrAssemblyLabel(r.db),
            placed ? r.contig : "", placed ? r.strand : "", placed ? r.start + 1 : "",
            placed ? r.end : "", placed ? r.end - r.start : "",
            id == null ? "" : id.toFixed(2), r.coverage == null ? "" : r.coverage.toFixed(2),
            pgrMapqOf(r), r.qStart == null ? "" : r.qStart + 1,
            r.qEnd == null ? "" : r.qEnd, r.queryLength, r.matches, r.mismatches,
            r.inserted, r.deleted, r.cigar].map(clean).join("\t"));
    });
    return lines.join("\n") + "\n";
}

function pgrShowSeq() {
    var box = document.getElementById("pgrSeqBox");
    if (box.style.display === "flex") { box.style.display = "none"; return; }
    var fasta = pgrFasta(pgrPage().querySeqs || []);
    box.style.display = "flex";
    box.innerHTML = '<div class="pgrSeqBar"><span class="gbShareMsg">Query sequence (FASTA):</span>' +
        '<button type="button" class="gbPill" id="pgrSeqCopy">Copy to Clipboard</button>' +
        '<button type="button" class="gbPill" id="pgrSeqDl">Download</button>' +
        '<button type="button" class="gbPill" id="pgrSeqClose">Close</button></div>' +
        '<textarea id="pgrSeqText" class="pgrSeqText" readonly></textarea>';
    var ta = document.getElementById("pgrSeqText");
    ta.value = fasta;
    document.getElementById("pgrSeqCopy").onclick = function () {
        ta.select();
        if (navigator.clipboard) { navigator.clipboard.writeText(fasta); }
        else { document.execCommand("copy"); }
        this.textContent = "Copied";
    };
    document.getElementById("pgrSeqDl").onclick = function () {
        pgrDownload(fasta, "pangenomeQuery.fa", "text/plain");
    };
    document.getElementById("pgrSeqClose").onclick = function () { box.style.display = "none"; };
}

// ---- page ------------------------------------------------------------------

var pgrSelRank = null;      // rank of the row shown in the detail panel

function pgrSelect(dt, rank) {
    pgrSelRank = rank;
    jQuery("#pgrTable tbody tr").removeClass("pgrSel");
    dt.rows().every(function () {
        if (this.data().rank === rank) { jQuery(this.node()).addClass("pgrSel"); }
    });
    var r = pgrRows[rank];
    if (r) { document.getElementById("pgrDetail").innerHTML = pgrDetailHtml(r); }
}

function pgrDraw(queries, allRows, note) {
    // Drawn again after placements are added, so let go of the last table: its
    // DataTable, its selection (ranks change), and remember whether the plot
    // was open, to open it again on the new rows.
    var oldPlot = document.getElementById("pgrPclaiPlot");
    var plotWasOpen = !!oldPlot && oldPlot.style.display !== "none";
    if (pgrDt) { pgrDt.destroy(); pgrDt = null; }
    pgrSelRank = null;
    // Everything but the rows aligned on request for one haplotype: what the
    // strip counts, the notes describe and the plot is given.
    var rows = allRows.filter(function (r) { return !r.extra; });
    var multiQuery = queries > 1;
    var multiPlace = rows.some(function (r) { return r.placements > 1; });
    var placed = rows.filter(function (r) { return r.contig != null; }).length;
    var page = pgrPage();

    // Page actions go in the gold title bar beside the title, as on hgBlat's
    // results page (the framework's own #sectTtl).
    var sectTtl = document.getElementById("sectTtl");
    if (sectTtl && !document.getElementById("pgrHeadActions")) {
        var acts = document.createElement("span");
        acts.id = "pgrHeadActions";
        acts.className = "pgrHeadActions";
        acts.innerHTML = (page.backUrl ?
            '<a class="gbPill" href="' + pgrEsc(page.backUrl) + '" title="Return to the ' +
            "Genome Browser at your previous location (" + pgrEsc(page.backPos) + ')">' +
            "Back to Genome Browser</a>" : "") +
            '<a class="gbPill" href="' + pgrEsc(page.newSearchUrl || pgrSelf) + '" ' +
            'title="Map another sequence">New search</a>';
        sectTtl.appendChild(acts);
    }

    // What is worth saying about these rows, beyond the rows themselves.
    var notes = [];
    if (note) { notes.push(note); }
    if (placed < rows.length) {
        // Only when the batch call failed and the graded list stood in for it.
        notes.push(pgrFmt(rows.length - placed) + " could not be placed, and show " +
                   "only how well they match.");
    }
    if (pgrPclaiReady()) {
        var noPlot = rows.filter(function (r) { return r.contig != null && !pgrPclaiSpot(r); })
                         .map(function (r) { return r.hap; })
                         .filter(function (h, i, all) { return all.indexOf(h) === i; });
        if (noPlot.length) {
            notes.push(pgrEsc(noPlot.slice(0, 3).join(", ")) +
                       (noPlot.length > 3 ? " and " + (noPlot.length - 3) + " more" : "") +
                       (noPlot.length === 1 ? " has" : " have") + " no pcLAI of " +
                       (noPlot.length === 1 ? "its" : "their") + " own, so " +
                       (noPlot.length === 1 ? "it is" : "they are") +
                       " not in the ancestry plot.");
        }
    }
    if (rows.some(function (r) { var q = pgrMapqOf(r); return q != null && q < 10; })) {
        notes.push("A low MAPQ, marked in red, means the mapper could not tell which copy " +
                   "of a duplicated region the sequence came from; those positions may " +
                   "belong to another copy.");
    }

    var th = ["<th>#</th>"];
    if (pgrPclaiReady()) { th.push('<th title="Tick to pick a haplotype out in the ancestry plot">Plot</th>'); }
    if (multiQuery) { th.push("<th>Query</th>"); }
    if (multiPlace) { th.push("<th>Placement</th>"); }
    th.push("<th>Open in Genome Browser</th>", "<th>Show</th>", "<th>Haplotype</th>",
            "<th>Assembly</th>", "<th>Query coverage</th>", "<th>Identity</th>",
            "<th>MAPQ</th>", "<th>Strand</th>", "<th>Span</th>");

    var el = document.getElementById("pgrResults");
    el.innerHTML =
        '<div class="gbCard">' +
        pgrSummaryStrip(queries, rows.filter(function (r) {
            return pgrAllPlaces || r.placement === 0; }), multiPlace) +
        '<div id="pgrSeqBox" class="gbShareBox" style="display:none"></div>' +
        '<div id="pgrHapBox" class="gbShareBox" hidden></div>' +
        (pgrPclaiReady() ? '<div id="pgrPclaiPlot" class="pgrPanel" style="display:none"></div>' : "") +
        '<div id="pgrDetail" class="pgrDetail">' + pgrHintHtml() + "</div>" +
        (notes.length ? '<div class="pgrNotes">' + notes.map(function (n) {
            return '<div class="pgrNote">' + n + "</div>"; }).join("") + "</div>" : "") +
        '<div id="pgrMoreBar" class="pgrBar" hidden></div>' +
        '<div id="pgrFocusBar" class="pgrBar on" hidden></div>' +
        '<table id="pgrTable" class="display"><thead><tr>' + th.join("") +
        "</tr></thead></table></div>";

    // A row aligned on request has no place in the best-first order, so no number.
    var cols = [{ data: "rank", className: "rankCol",
                  render: function (d, type, r) {
                      return type === "display" ? (r.extra ? "" : d + 1) : d; } }];
    if (pgrPclaiReady()) {
        cols.push({ data: null, orderable: false, className: "pickCol",
                    render: function (d, type, r) { return type === "display" ? pgrPickCell(r) : ""; } });
    }
    // Every column that shows text renders it escaped.  DataTables inserts a
    // column's data as HTML when it has no renderer, and a query name is the
    // user's own FASTA header - so a name that is markup would become markup in
    // the page of anyone who opens the results link, which carries the job.
    if (multiQuery) {
        cols.push({ data: "query", className: "queryCol",
                    render: function (d, type) { return type === "display" ? pgrEsc(d) : d; } });
    }
    if (multiPlace) {
        cols.push({ data: "placement", className: "placeCol",
                    render: function (d, type) { return type === "display" ? d + 1 : d; } });
    }
    // Sorts by contig in natural order (numbers zero-padded), then by start, as
    // hgBlat's position column does; unplaced rows sort last.
    cols.push({ data: null, className: "posCol",
        render: function (d, type, r) {
            if (type === "display") { return pgrPositionCell(r); }
            if (r.contig == null) { return type === "filter" ? pgrUnplacedText(r) : "￿"; }
            if (type === "filter") { return r.contig + ":" + (r.start + 1); }
            return r.contig.replace(/\d+/g, function (n) { return ("0000" + n).slice(-4); }) +
                   ":" + ("0000000000" + r.start).slice(-10);
        } });
    cols.push({ data: null, orderable: false, className: "actionsCol",
        render: function (d, type, r) { return type === "display" ? pgrActionsCell(r) : ""; } });
    cols.push({ data: "hap", className: "hapCol",
        render: function (d, type) { return type === "display" ? pgrEsc(d) : d; } });
    cols.push({ data: null, className: "asmCol",
        render: function (d, type, r) {
            var a = pgrAssemblyLabel(r.db);
            return type === "display" ? pgrEsc(a) : a;
        } });
    cols.push({ data: null, className: "covCol",
        render: function (d, type, r) {
            return type === "display" ? pgrCoverageCell(r) : (r.coverage == null ? -1 : r.coverage);
        } });
    cols.push({ data: null, className: "identCol",
        render: function (d, type, r) {
            var id = pgrIdentityOf(r);
            return type === "display" ? pgrIdentityCell(r) : (id == null ? -1 : id);
        } });
    cols.push({ data: null, className: "mapqCol",
        render: function (d, type, r) {
            var q = pgrMapqOf(r);
            return type === "display" ? pgrMapqCell(r) : (q == null ? -1 : q);
        } });
    cols.push({ data: null, className: "strandCol",
        render: function (d, type, r) { return r.contig == null ? "" : pgrEsc(r.strand || ""); } });
    cols.push({ data: null, className: "spanCol",
        render: function (d, type, r) {
            if (r.contig == null) { return type === "display" ? "" : -1; }
            var n = r.end - r.start;
            return type === "display" ? pgrFmt(n) : n;
        } });

    // Which rows are shown: one haplotype's when the table is narrowed to it,
    // and otherwise the table's own rows - each sequence's best placement, or
    // every placement once the others are asked for.  Registered once,
    // for this table only - DataTables' search hooks are global.
    if (!pgrDraw.filterOn) {
        pgrDraw.filterOn = true;
        jQuery.fn.dataTable.ext.search.push(function (settings, data, index) {
            if (settings.nTable.id !== "pgrTable") { return true; }
            var r = settings.aoData[index]._aData;
            if (pgrFocus) { return pgrHapKey(r.hap) === pgrHapKey(pgrFocus); }
            return !r.extra && (pgrAllPlaces || r.placement === 0);
        });
    }

    var dt = jQuery("#pgrTable").DataTable({
        data: allRows.slice().sort(pgrRowOrder(pgrQueryNames)),
        columns: cols,
        paging: false,
        info: false,
        order: [],       // keep the order the rows came in: best identity first
        language: { search: "", searchPlaceholder: "Filter by haplotype, assembly, contig…" }
    });

    // One handler for every action on the page, the plot's included: a tick in
    // the Plot column, and any of the arming links, wherever they are.
    el.onclick = function (ev) {
        var t = ev.target;
        if (t && t.classList && t.classList.contains("pgrPick")) {
            if (typeof pgpTogglePick === "function") { pgpTogglePick(t.getAttribute("data-hap"), t.checked); }
            return;
        }
        var cmd = t && t.getAttribute ? t.getAttribute("data-pgr") : null;
        if (cmd === "unfocus") { pgrFocusOff(); return; }
        if (cmd === "more") { pgrShowMore(); return; }
        if (cmd === "bestonly") { pgrBestOnly(); return; }
        var a = t && t.closest ? t.closest("a[data-rank]") : null;
        if (!a) { return; }
        ev.preventDefault();
        var row = pgrRows[parseInt(a.getAttribute("data-rank"), 10)];
        var act = a.getAttribute("data-act");
        if (!row) { return; }
        if (act === "focus") { pgrFocusOn(row.hap); }
        else if (act === "unfocus") { pgrFocusOff(); }
        else { pgrAct(row, act, a); }
    };

    jQuery("#pgrTable tbody").on("click", "tr", function (ev) {
        if (jQuery(ev.target).closest("a, input").length) { return; }   // links and boxes do their own thing
        var d = dt.row(this).data();
        if (d) { pgrSelect(dt, d.rank); }
    });
    // The highlight survives sorting and filtering.
    dt.on("draw", function () { if (pgrSelRank !== null) { pgrSelect(dt, pgrSelRank); } });

    document.getElementById("pgrTsvBtn").onclick = function () {
        var shown = dt.rows({ search: "applied", order: "applied" }).data().toArray();
        var base = multiQuery ? "pangenomeResults" :
            "pangenome_" + String((rows[0] || {}).query || "query").replace(/[^A-Za-z0-9._-]+/g, "_");
        pgrDownload(pgrRowsToTsv(shown), base + ".tsv", "text/tab-separated-values");
    };
    if (document.getElementById("pgrSeqBtn")) {
        document.getElementById("pgrSeqBtn").onclick = pgrShowSeq;
    }
    document.getElementById("pgrHapBtn").onclick = pgrShowHapBox;
    if (document.getElementById("pgrAnnotRef")) {
        document.getElementById("pgrAnnotRef").onchange = function () { pgrAnnotSet(this.value); };
    }
    pgrDt = dt;
    pgrPlaceColShow();
    pgrMoreShow();
    // Back from the browser on a table that was narrowed to one haplotype.
    if (pgrFocus) { pgrFocusOn(pgrFocus); }

    if (pgrPclaiReady()) {
        // Each haplotype is read at its own surjection, so what the plot gets is
        // one spot per row rather than a locus they all share.  Every plottable
        // row goes, not a pre-trimmed best few: the plot does its own filtering
        // and the thresholds are adjustable there.
        // The plot's own "Best placement only" follows the table's, and a plot
        // that was open before the redraw is opened again on the new rows.
        if (typeof pgpBestOnly !== "undefined") { pgpBestOnly = !pgrAllPlaces; }
        pgpInit(rows.filter(pgrPclaiSpot).map(pgrPclaiSpotOf));
        if (plotWasOpen && document.getElementById("pgrPclaiBtn")) {
            document.getElementById("pgrPclaiBtn").click();
        }
    }
    if (typeof window.convertTitleTagsToMouseovers === "function") {
        window.convertTitleTagsToMouseovers();
    }
}

// Everything the page says before or instead of a table: a card, with the
// shared spinner while the results are being fetched.
function pgrMessage(el, html, busy) {
    el.innerHTML = '<div class="gbCard pgrMsg">' +
        (busy ? '<span class="gbSpinner"></span>' : "") + "<div>" + html + "</div></div>";
}

function pgrStart() {
    var el = document.getElementById("pgrResults");
    if (!el) { return; }
    pgrAnnotInit();
    var job = pgrJobId();
    if (!job) {
        pgrMessage(el, "No job was named in this link. " +
            '<a href="' + pgrSelf + '">Start a new search</a>.');
        return;
    }
    // Already been here in this tab - draw it straight back.
    var cached = pgrCacheRead(job);
    if (cached) {
        pgrRows = cached.rows;
        pgrQueryCount = cached.queries;
        pgrQueryNames = cached.queryNames || [];
        pgrNote = cached.note || null;
        pgrFocus = cached.focus || null;
        pgrPlaceList = cached.places || null;
        pgrLoaded = cached.loaded || {};
        pgrAllPlaces = !!cached.allPlaces;
        pgrDraw(cached.queries, cached.rows, pgrNote);
        return;
    }
    pgrMessage(el, "Loading results&#8230;", true);

    pgrPoll(job).then(function (resp) {
        if (!resp || resp.status === "error") {
            throw new Error((resp && resp.error) || "the mapping server returned an error");
        }
        if (resp.status !== "done" && resp.status !== "completed") {
            pgrMessage(el, "This mapping is still running (" +
                pgrEsc(resp.status || "pending") + "). " +
                '<a href="">Reload</a> in a moment.');
            return null;
        }
        pgrMapping = resp.results || [];
        pgrQueryNames = pgrMapping.map(function (res) { return res.name; });
        pgrQueryCount = pgrMapping.length;
        pgrPlaceList = pgrPlaces();
        // One batch call per sequence, for its best placement only.  Each
        // returns the haplotypes that carry it, best coverage first, already
        // surjected.  The other placements cost a batch call each and are mostly
        // repeats a reader does not want, so they wait until asked for.
        var jobs = [];
        pgrMapping.forEach(function (res) {
            (res.alignments || []).forEach(function (aln, index) {
                jobs.push({ res: res, aln: aln, index: index });
            });
        });
        if (!jobs.length) {
            pgrMessage(el, "This sequence was not found in any haplotype. " +
                '<a href="' + pgrSelf + '">New search</a>.');
            return null;
        }
        var run = function (list) {
            return pgrPool(list.map(function (j) {
                return function () {
                    return pgrBatchRows(j.res, j.aln, j.index).then(function (rows) {
                        j.rows = rows;
                        pgrLoaded[pgrPlaceKey(j.res.name, j.index)] = true;
                    });
                };
            }), 3);
        };
        var best = jobs.filter(function (j) { return j.index === 0; });
        return run(best).then(function () {
            var any = best.some(function (j) { return j.rows && j.rows.length; });
            if (any) { return best; }
            // Nothing carries the best placement (a coverage floor can do
            // that): show the rest straight away rather than an empty page.
            pgrAllPlaces = true;
            return run(jobs).then(function () { return jobs; });
        }).then(function (done) {
            var rows = [];
            done.forEach(function (j) { rows = rows.concat(j.rows || []); });
            finish(rows);
        });

        function finish(rows) {
            if (!rows.length) {
                pgrMessage(el, "This sequence was not found in any haplotype. " +
                    '<a href="' + pgrSelf + '">New search</a>.');
                return;
            }
            pgrRows = rows;
            pgrRerank();
            pgrNote = pgrTruncNote();
            pgrCacheWrite(job);
            pgrDraw(pgrQueryCount, pgrRows, pgrNote);
        }
    }).catch(function (err) {
        // A job that has aged out of the server's cache is the common case, and
        // not a failure worth an alarming message.
        pgrMessage(el, "Could not load these results: " + pgrEsc(err.message) +
            ". Mapping jobs are kept for a limited time, so a link to " +
            'results may stop working. <a href="' + pgrSelf +
            '">Run the search again</a>.');
    });
}


if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", pgrStart);
} else {
    pgrStart();
}
