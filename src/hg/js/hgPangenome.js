/* hgPangenome.js - the PanAlign search form (pangenome mapping).
 *
 * Builds the form, parses pasted or uploaded sequences (one per line or
 * FASTA), validates them, submits them as a mapping job, polls until the job
 * is done, and then opens the results page (hgPangenomeResults.js) on that
 * job.  Config comes from window.pangenomeConfig, written by the CGI; the
 * helpers named pg.* are hgPangenomeCommon.js.
 */
/* global window, document, fetch, console, FileReader, Event, module */

(function () {
'use strict';

var pg = window.pangenomeCommon;
var el = pg.el, clear = pg.clear, $ = pg.byId;

// ---- Config ----------------------------------------------------------------
// NOTE: window.pangenomeConfig is emitted by the CGI as an inline script that
// runs AFTER this file (see hgPangenome.c: jsInlineF is flushed at end of body,
// after the <script src> tags).  So we must NOT read it at load time — it isn't
// defined yet.  readConfig() is called from init() on DOMContentLoaded, by which
// point the inline config has executed.

var CFG = {};
var POLL_INTERVAL = 1500;
var HGSID = null;           // session, needed by commands that write the cart
var MAX_SEQUENCES = 10;
var MAX_MULTIMAPS = 1;

function readConfig() {
    CFG = window.pangenomeConfig || {};
    POLL_INTERVAL = CFG.pollIntervalMs || 1500;
    MAX_SEQUENCES = CFG.maxSequences || 10;
    MAX_MULTIMAPS = CFG.maxMultimaps || 1;
    HGSID = CFG.hgsid || null;
}

var POLL_MAX_ERRORS = 3;    // consecutive poll failures tolerated before giving up
var POLL_MAX_MS = 30 * 60 * 1000;   // a job not done by then is given up on

// ---- Transport --------------------------------------------------------------
//
// The browser talks only to this CGI, which forwards each request to the
// graph server and returns its JSON.

function submitJob(payload) {
    return pg.post("map", payload).then(pg.jsonOrBody);
}

function readJob(jobId) {
    return pg.get("cmd=poll&job_id=" + encodeURIComponent(jobId)).then(pg.jsonOrBody);
}

// ---- Input parsing ---------------------------------------------------------

// Returns { sequences: [{name, sequence, line}], errors: [{line, message}] }.
function parseInput(text) {
    var out = { sequences: [], errors: [] };
    if (!text) return out;
    var lines = text.replace(/\r\n?/g, "\n").split("\n");

    var isFasta = lines.some(function (l) { return l.trim().charAt(0) === ">"; });

    if (isFasta) {
        var cur = null;
        lines.forEach(function (raw, i) {
            var lineNo = i + 1;
            var line = raw.trim();
            if (line === "") return;
            if (line.charAt(0) === ">") {
                if (cur) out.sequences.push(cur);
                var name = line.slice(1).trim().split(/\s+/)[0] || "";
                cur = { name: name, sequence: "", line: lineNo };
            } else if (cur) {
                cur.sequence += line.replace(/\s+/g, "");
            } else {
                // sequence data before any header
                out.errors.push({ line: lineNo, message: "sequence data before the first '>' header" });
            }
        });
        if (cur) out.sequences.push(cur);
    } else {
        lines.forEach(function (raw, i) {
            var line = raw.trim();
            if (line === "") return;
            out.sequences.push({ name: "", sequence: line.replace(/\s+/g, ""), line: i + 1 });
        });
    }
    return out;
}

// Validate + normalize.  Mutates parsed.sequences (assigns names, uppercases),
// appends to parsed.errors.  Returns true if OK to submit.
function validate(parsed) {
    // Prototype-less map: a plain {} would report inherited members such as
    // "constructor" or "toString" as already-seen and rename them spuriously.
    var seen = Object.create(null);
    var auto = 0;
    var fd = window.hgPangenomeFormData;
    var maxLen = (fd && fd.maxSeqLen) || 0;     // the server's limit, where the page was told it
    parsed.sequences.forEach(function (s) {
        // name
        if (!s.name) s.name = "seq_" + (++auto);
        var base = s.name, n = 1;
        while (seen[s.name]) { s.name = base + "_" + (++n); }
        seen[s.name] = true;

        // sequence
        s.sequence = (s.sequence || "").replace(/\s+/g, "").toUpperCase();
        if (s.sequence === "") {
            parsed.errors.push({ line: s.line, message: "sequence '" + s.name + "' is empty" });
        } else {
            var bad = s.sequence.match(/[^ACGTN]/);
            if (bad)
                parsed.errors.push({
                    line: s.line,
                    message: "sequence '" + s.name + "' has an invalid character '" +
                             bad[0] + "' (only A, C, G, T, N allowed)"
                });
            else if (maxLen && s.sequence.length > maxLen)
                parsed.errors.push({
                    line: s.line,
                    message: "sequence '" + s.name + "' is " + pg.commas(s.sequence.length) +
                             " bp (limit is " + pg.commas(maxLen) + " bp)"
                });
        }
    });

    if (parsed.sequences.length === 0)
        parsed.errors.push({ line: 0, message: "no sequences found" });
    if (parsed.sequences.length > MAX_SEQUENCES)
        parsed.errors.push({
            line: 0,
            message: "too many sequences: " + parsed.sequences.length +
                     " (limit is " + MAX_SEQUENCES + ")"
        });

    // The server's limit on the whole request: said here, before sending,
    // where the reader can still do something about it.
    var bases = 0;
    parsed.sequences.forEach(function (s) { bases += (s.sequence || "").length; });
    var room = totalRoom(parsed.sequences.length);
    if (room !== null && bases > room)
        parsed.errors.push({ line: 0,
            message: "the sequences are " + pg.commas(bases) + " bases together (limit is " +
                     pg.commas(room) + ")" });

    return parsed.errors.length === 0;
}

var statusEl;

// ---- Status / errors --------------------------------------------------------

function showStatus(html) {
    statusEl.style.display = "";
    clear(statusEl);
    if (typeof html === "string") statusEl.textContent = html;
    else statusEl.appendChild(html);
}
function hideStatus() { statusEl.style.display = "none"; clear(statusEl); busyOff(); }

function showValidationErrors(errors) {
    busyOff();
    var box = el("div", { class: "pgErrBox" });
    box.appendChild(el("b", { text: "Please fix the input:" }));
    var ul = el("ul");
    errors.forEach(function (e) {
        ul.appendChild(el("li", { text: (e.line ? "line " + e.line + ": " : "") + e.message }));
    });
    box.appendChild(ul);
    showStatus(box);
}

function showFatal(message, retryFn) {
    busyOff();
    var box = el("div", { class: "pgErrBox" });
    box.appendChild(el("span", { class: "pgErrText", text: message }));
    if (retryFn) {
        var b = el("button", { type: "button", class: "pgDlBtn", text: "Retry" });
        b.addEventListener("click", retryFn);
        box.appendChild(b);
    }
    showStatus(box);
}

function showProgress(completed, total) {
    var box = el("div", { class: "pgProgress" }, [
        el("span", { class: "pgSpinner" }),
        el("span", { text: "Mapping… " + completed + " / " + total + " complete" })
    ]);
    showStatus(box);
    busyOn("Aligning " + (total === 1 ? "your sequence" : total + " sequences") +
           " to the pangenome graph" +
           (completed ? " \u2014 " + completed + " of " + total + " done." : "."));
}

// ---- Submit / poll orchestration -------------------------------------------

var lastPayload = null;
var pollTimer = null;
var runSeq = 0;             // the search the page is waiting for: see pollJob()

// Submit is off while a search is out.  The scrim that covers the form comes
// up after a pause, and a double click is quicker than it: without this the
// second click sent a second job.
function submitOff(off) {
    if ($("pgSubmit")) $("pgSubmit").disabled = !!off;
}

// A search is out from Submit until it ends, fails or is cleared, and Submit
// comes back on only then: not for an error that has nothing to do with the
// search, such as a file that would not read.
var searchOut = false;

function searchOver() {
    searchOut = false;
    submitOff(false);
}

function searchFailed(message) {
    searchOver();
    showFatal(message, run);
}

function collectOptions() {
    var opts = {
        // Not a choice on the form: every job asks for as many as the install
        // allows, and the results page shows the best placement first and the
        // others only when they are asked for.
        max_multimaps: MAX_MULTIMAPS,
        // Always on: there is no useful result without a position.
        surject: true,
        // Null means the representative assembly.  The results page places
        // the other haplotypes itself, against the job we already have.
        surject_target: null
    };
    // Coverage is reported for every haplotype sharing any part of the path -
    // a few hundred per alignment.  A configured cutoff trims that at the
    // source rather than shipping it all and throwing most of it away.
    if (typeof CFG.minHapCoverage === "number")
        opts.min_haplotype_coverage = CFG.minHapCoverage;
    return opts;
}

function onSubmit() {
    if ($("pgSubmit") && $("pgSubmit").disabled) return;       // Ctrl-Enter comes here too
    if (pollTimer) { window.clearTimeout(pollTimer); pollTimer = null; }
    var parsed = parseInput($("pgSeq").value);
    if (!validate(parsed)) { showValidationErrors(parsed.errors); return; }

    lastPayload = {
        sequences: parsed.sequences.map(function (s) {
            return { name: s.name, sequence: s.sequence };
        }),
        options: collectOptions()
    };

    run();
}

function run() {
    var total = lastPayload.sequences.length;
    searchOut = true;
    submitOff(true);
    showProgress(0, total);
    // Clear lets go of this search; the answer to it is then not followed up.
    var seq = ++runSeq;

    submitJob(lastPayload).then(function (resp) {
        if (seq !== runSeq) return;
        // The CGI answers {status:"error",error} when it cannot reach the graph
        // server.
        if (resp && resp.status === "error") throw new Error(resp.error || "server error");
        if (!resp || !resp.job_id) throw new Error("no job id in response");
        pollJob(resp.job_id, total);
    }).catch(function (err) {
        if (seq !== runSeq) return;
        searchFailed("Could not submit: " + err.message);
    });
}

// Is this answer to a poll the end of the job, or only of this try?
//
// A job the graph server gave up on comes back as the job itself, with its
// id and status "error".  Everything else the CGI reports the same way - the
// server was restarting, the proxy timed out - is a failed try, and the job
// may be perfectly well, so it is asked about again.  The exception is a job
// the server does not have, which no number of tries will bring back.
function pollEndsJob(job) {
    if (!job || job.status !== "error") return false;
    if (job.job_id) return true;
    return /HTTP 404|unknown or expired job/.test(String(job.error || ""));
}

function pollJob(jobId, total) {
    var errCount = 0;
    var started = Date.now();
    var seq = ++runSeq;         // a later Submit, or Clear, ends this loop

    function again() { pollTimer = window.setTimeout(tick, POLL_INTERVAL); }
    function failedTry(message) {
        errCount++;
        if (errCount > POLL_MAX_ERRORS) {
            searchFailed("Lost contact with the mapping server: " + message);
            return;
        }
        again();
    }

    function tick() {
        if (seq !== runSeq) return;
        if (Date.now() - started > POLL_MAX_MS) {
            searchFailed("The mapping did not finish in " + (POLL_MAX_MS / 60000) +
                         " minutes. The server may be busy.");
            return;
        }
        readJob(jobId).then(function (job) {
            if (seq !== runSeq) return;
            if (pollEndsJob(job)) {
                searchFailed("Job failed: " + (job.error || "unknown error"));
                return;
            }
            if (job && job.status === "error") { failedTry(job.error || "no answer"); return; }
            errCount = 0;
            var prog = (job && job.progress) || { completed: 0, total: total };
            if (job && job.status === "done") {
                // Over, though Submit stays off until the results page is up:
                // coming back to this page turns it on again (pageshow).
                searchOut = false;
                hideStatus();
                // Hand off to the results table, the way hgBlat moves from the
                // search form to its hit list.  The job id is the whole of the
                // page's state, so the results URL survives a reload and can be
                // passed to someone else.
                busyNow("Opening the results\u2026");
                // A choice of annotations named in the link goes along with it.
                var refAnnot = /[?&]refAnnot=([^&]*)/.exec(window.location.search);
                window.location = window.location.pathname + "?page=results" +
                    "&job_id=" + encodeURIComponent(jobId) +
                    (HGSID ? "&hgsid=" + encodeURIComponent(HGSID) : "") +
                    (refAnnot ? "&refAnnot=" + refAnnot[1] : "");
                return;
            }
            showProgress(prog.completed, prog.total || total);
            again();
        }).catch(function (err) {
            if (seq !== runSeq) return;
            failedTry(err.message);
        });
    }
    tick();
}

// ---- File upload ------------------------------------------------------------

function onFile(evt) {
    var file = evt.target.files && evt.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
        $("pgSeq").value = reader.result;
        // The file is read into the box, so show the box: the user sees what
        // will be submitted, and the count under it.
        if ($("pgFileName")) $("pgFileName").textContent = file.name;
        formCount();
        formTab(false);
    };
    reader.onerror = function () { showFatal("Could not read file.", null); };
    reader.readAsText(file);
}

function onClear() {
    $("pgSeq").value = "";
    $("pgFile").value = "";
    if ($("pgFileName")) $("pgFileName").textContent = "";
    formCount();
    // A search still running is let go: nothing is waiting for it any more.
    runSeq++;
    if (pollTimer) { window.clearTimeout(pollTimer); pollTimer = null; }
    searchOver();
    hideStatus();
}

// ---- Search form ------------------------------------------------------------
//
// Built here from hgPangenomeFormData, the way hgBlat.js builds hgBlat's new
// search form from hgBlatFormData, and in the same design: the shared house
// style from gbModern.css (.gbSection bars, .gbPill buttons, .gbCard sidebar,
// the busy overlay) and this tool's own layout from hgPangenome.css.  The
// controls have the ids the rest of this file reads - pgSeq, pgFile, pgSubmit,
// pgClear - and a page with no form data is left alone.

// The Genome Browser's standard info icon, as hgBlat.js copies it from
// printInfoIconSvg() in hg/lib/hui.c, so these icons are the same ones as on
// every other page.
var PG_INFO_SVG =
    "<svg style='height:1.1em; vertical-align:top' viewBox='0 0 24 24' fill='none' " +
    "xmlns='http://www.w3.org/2000/svg'>" +
    "<circle cx='12' cy='12' r='10' stroke='#1C274C' stroke-width='1.5'/>" +
    "<path d='M12 17V11' stroke='#1C274C' stroke-width='1.5' stroke-linecap='round'/>" +
    "<circle cx='1' cy='1' r='1' transform='matrix(1 0 0 -1 11 9)' fill='#1C274C'/></svg>";

var BUSY_DELAY_MS = 350;      // as hgBlat.js: a scrim that flashes reads as a glitch
var busyTimer = null;
var countTimer = null;

function infoIcon(tip) {
    return '<span class="pgInfo" title="' + pg.esc(tip) + '">' + PG_INFO_SVG + "</span>";
}

function formSidebar(fd) {
    return '<div>' +
        '<div class="gbCard"><h3>Similar tools</h3>' +
        '<div><a href="' + pg.esc(fd.blatUrl) + '">BLAT</a> - finds a sequence ' +
        'in one assembly, rather than across every haplotype at once.</div>' +
        '<div><a href="' + pg.esc(fd.panConvertUrl) + '">PanConvert</a> - for a region ' +
        'you already have coordinates for: translates it from one assembly to ' +
        'another through the graph.</div>' +
        '</div>' +
        '<div class="gbCard"><h3>About PanAlign</h3>' +
        '<div>Your sequence is aligned to the pangenome graph, which holds every ' +
        'haplotype in it at once. The results list the haplotypes that carry it, ' +
        'with how well it matches each and where it lands, and open any of them ' +
        'in the Genome Browser.</div>' +
        '<div>The graph is built by the <a target="_blank" ' +
        'href="https://humanpangenome.org/">Human Pangenome Reference ' +
        'Consortium</a>.</div>' +
        '</div></div>';
}

function formBusyMarkup() {
    // Built with the form, hidden, as hgBlat.js does: nothing should have to be
    // parsed or fetched at the moment the page is busy with the job.
    return '<div id="pgBusyBg" class="gbBusyBg" role="status" aria-live="polite">' +
        '<div class="gbBusyCard"><div class="gbSpinner"></div>' +
        '<div><div class="gbBusyTitle" id="pgBusyTitle">Mapping&hellip;</div>' +
        '<div class="gbBusyText" id="pgBusyText"></div></div></div></div>';
}

// The overlay mirrors the in-page status rather than replacing it: #pgStatus
// still carries the progress and every error, so a page without the form - and
// the tests - can read both there.
function busyOn(text) {
    var bg = $("pgBusyBg");
    if (!bg) return;
    if (text != null && $("pgBusyText")) $("pgBusyText").textContent = text;
    if (bg.className.indexOf(" on") >= 0 || busyTimer) return;
    busyTimer = window.setTimeout(function () {
        busyTimer = null;
        if (bg.className.indexOf(" on") < 0) bg.className += " on";
    }, BUSY_DELAY_MS);
}

// Up at once, with no delay: used when the page is about to navigate away, so
// there is no flash to avoid and every reason not to leave a gap.
function busyNow(text) {
    var bg = $("pgBusyBg");
    if (!bg) return;
    if (busyTimer) { window.clearTimeout(busyTimer); busyTimer = null; }
    if (text != null && $("pgBusyText")) $("pgBusyText").textContent = text;
    if (bg.className.indexOf(" on") < 0) bg.className += " on";
}

function busyOff() {
    if (busyTimer) { window.clearTimeout(busyTimer); busyTimer = null; }
    var bg = $("pgBusyBg");
    if (bg) bg.className = bg.className.replace(/\s*\bon\b/g, "");
}

function formTab(showUpload) {
    var paste = $("pgTabPaste"), upload = $("pgTabUpload");
    if (!paste || !upload) return;
    paste.className = "pgTab" + (showUpload ? "" : " on");
    upload.className = "pgTab" + (showUpload ? " on" : "");
    $("pgPanePaste").style.display = showUpload ? "none" : "";
    $("pgPaneUpload").style.display = showUpload ? "" : "none";
}

// The live count under the box.  Counted with the parser the submission uses,
// so the numbers it shows are the ones the job will see, and checked against
// the limits the server enforces so a sequence that is too long is flagged
// before it is sent.  Debounced: a paste can be a megabyte, and the textarea
// itself is never re-rendered, so the caret stays where the user put it.
// The bases one search may carry in all, or null where the server has not
// said.  Its limit is on the size of the request, which is the sequences plus
// a little for each one's name and the wrapping around them.
function totalRoom(nSeq) {
    var fd = window.hgPangenomeFormData;
    if (!fd || !fd.maxRequestBytes) return null;
    return Math.max(0, fd.maxRequestBytes - 200 * nSeq - 500);
}

function formCount() {
    var out = $("pgCountText"), ta = $("pgSeq"), fd = window.hgPangenomeFormData;
    if (!out || !ta || !fd) return;
    var parsed = parseInput(ta.value);
    var bases = 0, longest = 0;
    parsed.sequences.forEach(function (s) {
        var n = (s.sequence || "").replace(/\s+/g, "").length;
        bases += n;
        if (n > longest) longest = n;
    });
    var nSeq = parsed.sequences.length;
    var text = pg.commas(bases) + " bases in " + pg.commas(nSeq) + " sequence" + (nSeq === 1 ? "" : "s");
    var problem = null;
    var room = totalRoom(nSeq);
    if (nSeq > MAX_SEQUENCES)
        problem = "up to " + pg.commas(MAX_SEQUENCES) + " sequences";
    else if (fd.maxSeqLen && longest > fd.maxSeqLen)
        problem = "longest is " + pg.commas(longest) + " bp, limit " + pg.commas(fd.maxSeqLen) + " bp";
    else if (room !== null && bases > room)
        problem = "too long together, limit " + pg.commas(room) + " bases";
    out.textContent = problem ? text + " — " + problem : text;
    out.className = problem ? "over" : "";
}

function formCountSoon() {
    if (countTimer) window.clearTimeout(countTimer);
    countTimer = window.setTimeout(function () { countTimer = null; formCount(); }, 150);
}

function formBuild() {
    var fd = window.hgPangenomeFormData;
    var box = $("pgFormBox");
    if (!fd || !box) return;

    box.innerHTML =
        '<div class="pgFormGrid"><div>' +

        '<div class="gbSection">Search settings</div>' +
        '<div class="pgRow">' +
            '<div class="pgField pgGraphSlot"><span>Pangenome ' +
                infoIcon("The pangenome graph your sequence is aligned to. Every " +
                         "haplotype in it is searched at once. If a sequence aligns " +
                         "to more than one place, the results show the best one, and " +
                         "the others are a click away.") + '</span>' +
                '<div class="pgGraphName">' + pg.esc(fd.graphLabel) + '</div></div>' +
        '</div>' +

        '<div class="gbSection">Query sequence</div>' +
        '<div class="pgTabs">' +
            '<button type="button" class="pgTab on" id="pgTabPaste">Paste sequence</button>' +
            '<button type="button" class="pgTab" id="pgTabUpload">Upload file</button>' +
        '</div>' +

        '<div id="pgPanePaste">' +
            '<div class="pgPaneHint"><span>Separate multiple sequences with a &gt;name ' +
            'line. Up to ' + pg.commas(MAX_SEQUENCES) + ' sequences, ' +
            pg.commas(fd.maxSeqLen) + ' bp each.</span>' +
            '<button type="button" id="pgExample" class="pgChip" title="' +
            pg.esc(fd.exampleTitle) + '">' + pg.esc(fd.exampleLabel) + '</button></div>' +
            '<textarea class="pgSeqBox" id="pgSeq" spellcheck="false" ' +
            'aria-label="Paste query sequences, one per line or in FASTA"></textarea>' +
            '<div class="pgCount"><span id="pgCountText"></span></div>' +
        '</div>' +

        '<div id="pgPaneUpload" style="display:none">' +
            '<div class="pgDrop" id="pgDrop">' +
                '<div class="pgDropTitle">Drop a sequence file here</div>' +
                '<div class="pgDropSub">Plain text or FASTA, up to ' +
                pg.commas(MAX_SEQUENCES) + ' sequences</div>' +
                '<input type="file" id="pgFile">' +
                '<div class="pgFileName" id="pgFileName"></div>' +
            '</div>' +
        '</div>' +

        '<div id="pgStatusSlot"></div>' +
        '<div class="pgActions">' +
            '<input type="button" class="gbPill primary" id="pgSubmit" value="Submit" ' +
            'title="Align the sequences to the pangenome and list the haplotypes that carry them">' +
            '<input type="button" class="gbPill" id="pgClear" value="Clear" ' +
            'title="Empty the sequence box">' +
        '</div>' +

        '</div>' + formSidebar(fd) + '</div>' +
        formBusyMarkup();

    // The status box the C side emitted moves in beside the buttons it reports on.
    var status = $("pgStatus");
    if (status) $("pgStatusSlot").appendChild(status);

    $("pgTabPaste").addEventListener("click", function () { formTab(false); });
    $("pgTabUpload").addEventListener("click", function () { formTab(true); });
    $("pgSeq").addEventListener("input", formCountSoon);

    // As hgBlat.js: the button is its own status while the example is fetched,
    // and disabled meanwhile so a double click cannot start a second fetch.
    $("pgExample").addEventListener("click", function () {
        var btn = this, label = fd.exampleLabel;
        btn.disabled = true;
        btn.textContent = "Loading example…";
        fetch(fd.exampleUrl).then(function (resp) {
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            return resp.text();
        }).then(function (fa) {
            var ta = $("pgSeq");
            ta.value = fa.trim();
            formCount();
            formTab(false);
            ta.focus();
            ta.setSelectionRange(0, 0);
            ta.scrollTop = 0;
            btn.textContent = label;
            btn.disabled = false;
        }).catch(function (err) {
            btn.textContent = "Could not load example";
            window.setTimeout(function () { btn.textContent = label; btn.disabled = false; }, 4000);
            if (window.console) console.error("hgPangenome: example fetch failed:", err);
        });
    });

    var drop = $("pgDrop"), fileInput = $("pgFile");
    ["dragenter", "dragover"].forEach(function (e) {
        drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.className = "pgDrop hot"; });
    });
    ["dragleave", "drop"].forEach(function (e) {
        drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.className = "pgDrop"; });
    });
    drop.addEventListener("drop", function (ev) {
        if (ev.dataTransfer && ev.dataTransfer.files.length) {
            fileInput.files = ev.dataTransfer.files;
            fileInput.dispatchEvent(new Event("change"));
        }
    });

    // Back from the results page: a browser that restores this page from its
    // back/forward cache restores the overlay with it, still spinning, and
    // Submit still off.  Restored with a search still out, both are right as
    // they are: the search goes on from where it was.
    window.addEventListener("pageshow", function () {
        if (!searchOut) { busyOff(); submitOff(false); }
    });

    formCount();
    if (typeof window.convertTitleTagsToMouseovers === "function")
        window.convertTitleTagsToMouseovers();
}

// ---- Init -------------------------------------------------------------------

function init() {
    readConfig();     // the form is built from these limits, so read them first
    formBuild();
    statusEl = $("pgStatus");
    if (!statusEl) return;    // not our page

    $("pgSubmit").addEventListener("click", onSubmit);
    $("pgClear").addEventListener("click", onClear);
    $("pgFile").addEventListener("change", onFile);
    // Ctrl/Cmd-Enter in the textarea submits.
    $("pgSeq").addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); onSubmit(); }
    });
}

if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
else
    init();

// Test hook.  In a browser "module" is undefined, so this is a no-op there; the
// unit tests (hgPangenome/tests/) load this file under node and use these.
if (typeof module !== "undefined" && module.exports)
    module.exports = {
        parseInput: parseInput,
        validate: validate,
        readConfig: readConfig,
        init: init
    };

}());
