/* hgPangenomeConvert.js - client for PanLift, the coordinate-conversion page.
 *
 * Translates a region from one haplotype's coordinates to another's through the
 * pangenome graph, in the spirit of hgConvert's "In Other Genomes" - but between
 * any two haplotypes in the graph, not just where liftOver chains happen to
 * exist.
 *
 * Flow:
 *   - the source assembly and position are pre-filled from the cart by the CGI
 *     (so arriving from a track view carries the region over), and both stay
 *     editable here;
 *   - the destination list comes from the live graph  (cmd=haplotypes);
 *   - the translation is done by the middleware        (cmd=liftover);
 *   - every returned interval is rendered as a link into the Genome Browser on
 *     the target haplotype's own assembly.
 *
 * As with the mapping page, the browser only ever talks to this CGI; the
 * middleware URL and token stay server-side.
 */
/* global window, document, fetch, Promise */

(function () {
'use strict';

var CFG = {};
var MAX_SPAN = 10000000;        // middleware cap; also enforced server-side
var MAX_TARGETS = 10;           // per request, not per conversion: see liftInBatches()
var BUDGET_MB = 5;             // per request: span in Mb x targets

// Source assembly -> haplotype, i.e. the inverse of the generated HPRC table
// (which maps "sample#phase" -> assembly).  Built once, lazily.
var dbToHap = null;

function buildDbToHap() {
    dbToHap = Object.create(null);
    var table = window.pangenomeAssemblies || {};
    Object.keys(table).forEach(function (hap) {
        var v = String(table[hap]);
        // Non-portable entries are full URLs; pull the db out of them.
        var m = v.match(/[?&]db=([^&]+)/);
        var db = m ? decodeURIComponent(m[1]) : v;
        if (!(db in dbToHap)) dbToHap[db] = hap;   // first wins, keys are sorted
    });
}

// An assembly served through a hub is known to the cart by a decorated name -
// hs1 arrives as "hub_25071_hs1" from the curated hub, a GenArk sample as
// "hub_146215_GCA_...".  The assembly table is keyed on the undecorated name,
// so strip the prefix before looking one up.  Without this, arriving from the
// browser on hs1 looked like an assembly outside the pangenome.
function bareDb(db) {
    return String(db == null ? "" : db).replace(/^hub_[0-9]+_/, "");
}

function hapForDb(db) {
    if (!dbToHap) buildDbToHap();
    if (!db) return null;
    var bare = bareDb(db);
    return dbToHap[db] || dbToHap[String(db).toLowerCase()] ||
           dbToHap[bare] || dbToHap[bare.toLowerCase()] || null;
}
function assemblyForHap(hap) {
    var table = window.pangenomeAssemblies || {};
    var key = String(hap).toLowerCase();
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

// PanSN ("HG00097#1#CM094066.1") is a storage convention.  The rest of the
// browser never shows it, so neither does this page: break it into the sample,
// the haplotype - by parental origin where the assembly is trio-phased - and
// the sequence.
function prettyHap(name) {
    var parts = String(name == null ? "" : name).split("#");
    var sample = parts[0] || String(name);
    var phase = parts.length > 1 ? parts[1] : null;
    var contig = parts.length > 2 ? parts.slice(2).join("#").split("#")[0] : null;
    var db = (phase != null) ? assemblyForHap(sample + "#" + phase) : null;
    var names = window.pangenomeAssemblyNames || {};
    var aName = (db && Object.prototype.hasOwnProperty.call(names, db))
        ? names[db] : null;
    var parent = null;
    if (aName) {
        var pm = /[._](pat|mat)([._]|$)/.exec(aName);
        if (pm) parent = (pm[1] === "pat") ? "paternal" : "maternal";
    }
    var label = sample;
    if (phase != null && phase !== "0")
        label += " " + (parent ? parent : "hap" + phase);
    if (contig)
        label += " " + contig;
    return { sample: sample, phase: phase, contig: contig,
             assembly: db, assemblyName: aName, label: label };
}

function hapLabel(name) { return prettyHap(name).label; }

// ---- DOM helpers (kept local so this page stands alone) --------------------

function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
        if (k === "class") e.className = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
        if (c == null) return;
        e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
}
function $(id) { return document.getElementById(id); }
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

// ---- Position parsing -------------------------------------------------------

// "chr10:19,114-19,137" (1-based inclusive, commas allowed) or "chr10" for a
// whole contig.  Returns {contig, start, end} with start 0-based half-open, or
// {error} explaining what is wrong.
function parsePosition(text) {
    var s = String(text == null ? "" : text).trim().replace(/,/g, "");
    if (s === "") return { error: "enter a position, e.g. chr10:19114-19137" };
    var m = s.match(/^([^\s:]+):(\d+)\s*-\s*(\d+)$/);
    if (!m) {
        if (/^[^\s:]+$/.test(s))
            return { error: "add a range to " + s + ", e.g. " + s + ":1-1000" };
        return { error: "could not read '" + text + "' as contig:start-end" };
    }
    var start1 = parseInt(m[2], 10), end1 = parseInt(m[3], 10);
    if (start1 < 1) return { error: "start must be 1 or greater" };
    if (end1 < start1) return { error: "end must not be before start" };
    var span = end1 - start1 + 1;
    if (span > MAX_SPAN)
        return { error: "region is " + span + " bp; the limit is " + MAX_SPAN + " bp" };
    return { contig: m[1], start: start1 - 1, end: end1 };   // 0-based half-open
}

// Display a 0-based half-open interval the way the browser does.
function withCommas(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtPos(contig, start, end) {
    return contig + ":" + (start + 1) + "-" + end;
}

// ---- Transport (same-origin, via our own CGI) -------------------------------

function selfUrl() { return window.location.pathname; }

function postCmd(cmd, payload) {
    var body = "cmd=" + encodeURIComponent(cmd) +
               "&payload=" + encodeURIComponent(JSON.stringify(payload));
    // Commands that build a hub need the user's real cart, not a fresh session
    // per request - otherwise every conversion mints another hub and connects
    // it, and none of them is ever reused or taken away.
    if (CFG.hgsid)
        body += "&hgsid=" + encodeURIComponent(CFG.hgsid);
    return fetch(selfUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
                   "Accept": "application/json" },
        body: body
    }).then(checkHttp);
}

// Ask for a wider chain on the way out of the page.
//
// The chain the first request builds reaches a little either side of the
// converted interval - enough to pan a few window-widths, not enough to roam.
// Widening it costs the mapping server about a second per megabase, which is
// not worth charging to every conversion, so it is asked for here instead:
// once, at the moment the user actually follows the link.
//
// It has to be sendBeacon rather than fetch.  This runs immediately before
// navigating away, and the browser cancels in-flight fetches when the page
// goes; a beacon is guaranteed to be delivered.  That is also why the payload
// leaves out the blocks - the server fetches its own, and beacons are size
// limited.  Nothing waits for the reply, and the browser picks the new chain
// up on the next pan without a reload.
function requestWiderChain(base) {
    /* typeof, not a plain test: where navigator is absent altogether naming it
     * throws rather than reading as false, and this runs on the way out of the
     * page, where an exception would take the navigation with it. */
    if (typeof navigator === "undefined" || !navigator.sendBeacon ||
        typeof Blob === "undefined")
        return;
    var lean = {};
    Object.keys(base).forEach(function (k) {
        if (k !== "blocks") lean[k] = base[k];
    });
    var body = "cmd=extendChain&payload=" +
               encodeURIComponent(JSON.stringify(lean));
    if (CFG.hgsid)
        body += "&hgsid=" + encodeURIComponent(CFG.hgsid);
    try {
        navigator.sendBeacon(selfUrl(), new Blob([body],
            { type: "application/x-www-form-urlencoded" }));
    } catch (e) {
        /* Best effort: the narrower chain is already in place and works. */
    }
}

function getCmd(qs) {
    return fetch(selfUrl() + "?" + qs, {
        method: "GET", headers: { "Accept": "application/json" }
    }).then(checkHttp);
}

function checkHttp(resp) {
    if (!resp.ok)
        return resp.text().then(function (t) {
            throw new Error("HTTP " + resp.status + (t ? ": " + t.slice(0, 300) : ""));
        });
    return resp.json();
}

// ---- Status -----------------------------------------------------------------

function showStatus(node) {
    var box = $("pgcStatus");
    box.style.display = "";
    clear(box);
    box.appendChild(typeof node === "string" ? document.createTextNode(node) : node);
}
function hideStatus() { var b = $("pgcStatus"); b.style.display = "none"; clear(b); }

function showError(message, retry) {
    var box = el("div", { class: "pgErrBox" }, [
        el("span", { class: "pgErrText", text: message })
    ]);
    if (retry) {
        var b = el("button", { type: "button", class: "pgDlBtn", text: "Retry" });
        b.addEventListener("click", retry);
        box.appendChild(b);
    }
    showStatus(box);
}

function showBusy(text) {
    showStatus(el("div", { class: "pgProgress" }, [
        el("span", { class: "pgSpinner" }), el("span", { text: text })
    ]));
}

// ---- Destination list -------------------------------------------------------

var allHaplotypes = [];
var hapExactByLower = null;
var reachable = null;          // lower name -> coverage (or null), else not filtered
var reachableScored = false;   // true when the server ranked them
// What the graph last said for this source region.  Kept so that turning the
// filter off and on again does not ask a second time; cleared whenever the
// region changes, because then it is an answer to a different question.
var reachableCache = null;
var reachableCacheScored = false;
var autoRan = false;           // the hand-off from hgConvert converts once
var sourceIsExample = false;   // the position on screen is ours, not the user's

// The graph's path names are case-sensitive ("CHM13#0", not "chm13#0"), but our
// generated assembly table is keyed lower-case.  Map back to the graph's own
// spelling before building a source path, or the middleware finds no paths.
function canonicalHap(hap) {
    if (!hap) return hap;
    if (!hapExactByLower) {
        hapExactByLower = Object.create(null);
        allHaplotypes.forEach(function (h) {
            hapExactByLower[String(h).toLowerCase()] = h;
        });
    }
    return hapExactByLower[String(hap).toLowerCase()] || hap;
}

// Is this haplotype present in the loaded graph at all?  Only meaningful once
// the list has arrived.
function hapInGraph(hap) {
    if (allHaplotypes.length === 0) return true;      // unknown yet; let the server judge
    canonicalHap(hap);                                 // builds the index
    return !!hapExactByLower[String(hap).toLowerCase()];
}

function loadHaplotypes() {
    showBusy("Loading assemblies from the graph…");
    return getCmd("cmd=haplotypes").then(function (resp) {
        if (resp && resp.status === "error") throw new Error(resp.error || "server error");
        allHaplotypes = (resp && resp.haplotypes) || [];
        allHaplotypes.sort();
        hapExactByLower = null;                        // rebuilt on next use
        fillSources();
        loadContigs();
        fillTargets("");
        preselectDefaultTarget();
        fillTargets($("pgcFilter").value);      // so the picker shows the default
        hideStatus();
        // Arriving from hgConvert the user has already chosen a source, a
        // position and a destination and pressed Submit once; make them press
        // it again and the hand-off would just look broken.  Run it for them,
        // but only once, and only when everything really did come through -
        // never on a position this page supplied, because converting an example
        // region under the heading the user asked for is worse than asking.
        if (CFG.presetTarget && !autoRan && !sourceIsExample &&
            selectedTargets().length > 0 && ($("pgcPos").value || "").trim() !== "") {
            autoRan = true;
            doConvert();
        }
    }).catch(function (err) {
        showError("Could not load the assembly list: " + err.message, loadHaplotypes);
    });
}

// ---- Populations -------------------------------------------------------------
//
// Each sample's population as the HPRC describes it - 1000 Genomes code and
// descriptor, from hgPangenomeSamples.js - organises the target picker.
// Super-populations are not used: the HPRC follows the NHGRI's guidelines for
// referring to populations, which do not, and leaves them out of its metadata.
//
// The picker is two panes: the populations, with their counts, and the
// haplotypes of the one picked, as checkboxes.  Above them, what has been
// chosen, as chips.  The hidden #pgcTargets list underneath holds every
// candidate and is what the rest of the page reads the choice from; the panes
// only ever change which of its options are selected.

var popFilter = null;          // the population the right pane shows, or null for all

function samplePop(hap) {
    var table = window.pangenomeSamples || {};
    var key = String(hap || "").split("#")[0].toLowerCase();
    var p = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
    return p ? { code: p[0], desc: p[1] } : null;
}

// The group a haplotype is listed under: the references first, then each
// population by name, then the samples with no population given.
function popGroupOf(hap) {
    var lower = String(hap).toLowerCase();
    if (lower === "grch38#0" || lower === "chm13#0")
        return { key: "~ref", label: "Reference assemblies", rank: 0 };
    var p = samplePop(hap);
    if (!p) return { key: "~none", label: "No population given", rank: 2 };
    return { key: p.code, label: p.desc + " (" + p.code + ")", rank: 1, desc: p.desc };
}

// Every option in the list, whether it sits under a group or not.
function targetOptions(sel) {
    var out = [];
    if (!sel) return out;
    Array.prototype.forEach.call(sel.children, function (c) {
        if (c.tagName === "OPTGROUP")
            Array.prototype.forEach.call(c.children, function (o) { out.push(o); });
        else
            out.push(c);
    });
    return out;
}

// The groups among some haplotypes, in display order, each with its members.
function popGroups(list) {
    var byKey = Object.create(null), groups = [];
    list.forEach(function (h) {
        var g = popGroupOf(h);
        if (!byKey[g.key]) {
            byKey[g.key] = { key: g.key, label: g.label, rank: g.rank, desc: g.desc || "", haps: [] };
            groups.push(byKey[g.key]);
        }
        byKey[g.key].haps.push(h);
    });
    groups.sort(function (a, b) {
        return (a.rank - b.rank) || a.desc.localeCompare(b.desc);
    });
    return groups;
}

// Does the search text match this haplotype, by its name or its population?
function matchesSearch(h, f) {
    if (!f) return true;
    var g = popGroupOf(h);
    return h.toLowerCase().indexOf(f) >= 0 || hapLabel(h).toLowerCase().indexOf(f) >= 0 ||
           (g.rank === 1 && (g.key.toLowerCase().indexOf(f) >= 0 ||
                             g.desc.toLowerCase().indexOf(f) >= 0));
}

// Choose or let go of one haplotype, then draw the picker again.
function setChosen(hap, on) {
    targetOptions($("pgcTargets")).forEach(function (o) {
        if (o.value === hap) o.selected = !!on;
    });
    fillTargets($("pgcFilter") ? $("pgcFilter").value : "");
}

// The chips: what has been chosen, each with a way to take it back.
function drawChosen(chosen) {
    var box = $("pgcChosen");
    if (!box) return;
    clear(box);
    box.appendChild(el("span", { class: "pgcChosenHead", text:
        chosen.length ? "Chosen " + chosen.length
                      : "Choose target assemblies below" }));
    chosen.forEach(function (h) {
        var p = samplePop(h);
        var chip = el("span", { class: "pgcChip", title: p ? p.desc : "" }, [
            el("span", { text: hapLabel(h) }),
            p ? el("span", { class: "pgcChipPop", text: p.code }) : null,
            el("button", { type: "button", class: "pgcChipX", "data-unchoose": h,
                           "aria-label": "Remove " + hapLabel(h), text: "×" })
        ]);
        box.appendChild(chip);
    });
}

// Left: the populations among the candidates the search allows, with how
// many there are in each and how many of those are chosen.  "All" first.
function drawPops(matches, chosenSet) {
    var box = $("pgcPops");
    if (!box) return;
    var keep = box.querySelector ? box.querySelector(".pgcPopsList") : null;
    var scroll = keep ? keep.scrollTop : 0;
    clear(box);
    var groups = popGroups(matches);
    var npops = groups.filter(function (g) { return g.rank === 1; }).length;
    box.appendChild(el("div", { class: "pgcPaneHead", text:
        npops + (npops === 1 ? " population" : " populations") }));
    var listBox = el("div", { class: "pgcPopsList" });
    function row(key, label, code, n, picked) {
        var on = (popFilter || "") === key;
        var b = el("button", { type: "button", class: "pgcPop" + (on ? " on" : ""),
                               "data-pop": key, "aria-pressed": on ? "true" : "false",
                               title: label });
        b.appendChild(el("span", { class: "pgcPopName", text: label }));
        if (code) b.appendChild(el("span", { class: "pgcPopCode", text: code }));
        if (picked) b.appendChild(el("span", { class: "pgcPopPicked", text: String(picked),
                                               title: picked + " chosen" }));
        b.appendChild(el("span", { class: "pgcPopN", text: String(n) }));
        listBox.appendChild(b);
    }
    var allPicked = matches.filter(function (h) { return chosenSet[h.toLowerCase()]; }).length;
    row("", "All populations", "", matches.length, allPicked);
    groups.forEach(function (g) {
        var picked = g.haps.filter(function (h) { return chosenSet[h.toLowerCase()]; }).length;
        row(g.key, g.rank === 1 ? g.desc : g.label, g.rank === 1 ? g.key : "", g.haps.length, picked);
    });
    box.appendChild(listBox);
    listBox.scrollTop = scroll;
}

// Right: the haplotypes of the population picked, as checkboxes, in the order
// the list has them (alphabetical, or best first once ranked).
function drawHaps(shown, chosenSet) {
    var box = $("pgcHaps");
    if (!box) return;
    var keep = box.querySelector ? box.querySelector(".pgcHapsList") : null;
    var scroll = keep ? keep.scrollTop : 0;
    clear(box);
    var g = popFilter ? popGroups(shown.length ? shown : []).filter(function (x) {
        return x.key === popFilter; })[0] : null;
    var title = popFilter ? (g ? g.label : "This population") : "All populations";
    // Every one listed here, or none of them, in one click: "convert to all
    // of these" is a question people ask, and ticking 463 boxes is not an answer.
    var allOn = shown.length > 0 && shown.every(function (h) { return chosenSet[h.toLowerCase()]; });
    box.appendChild(el("div", { class: "pgcPaneHead" }, [
        el("span", { text: title }),
        el("span", { class: "pgcPaneN", text: shown.length + (shown.length === 1 ? " haplotype" : " haplotypes") +
            (reachableScored ? ", best first" : "") }),
        shown.length ? el("button", { type: "button", class: "pgcAllBtn", "data-all": allOn ? "off" : "on",
                                      text: allOn ? "Clear these" : "Choose all " + shown.length }) : null
    ]));
    var listBox = el("div", { class: "pgcHapsList" });
    if (!shown.length) {
        listBox.appendChild(el("div", { class: "pgMuted pgcEmpty",
            text: "No haplotype matches. Clear the search or pick another population." }));
    }
    shown.forEach(function (h) {
        var on = !!chosenSet[h.toLowerCase()];
        var id = "pgcHap_" + h.replace(/[^A-Za-z0-9]/g, "_");
        var box2 = el("input", { type: "checkbox", id: id, "data-hap": h });
        box2.checked = on;
        var p = popFilter ? null : samplePop(h);
        var cov = reachable ? reachable[h.toLowerCase()] : null;
        var lab = el("label", { class: "pgcHap" + (on ? " on" : "") + (box2.disabled ? " dis" : ""),
                                for: id }, [
            box2,
            el("span", { text: hapLabel(h) }),
            p ? el("span", { class: "pgcHapPop", text: p.code, title: p.desc }) : null,
            cov == null ? null : el("span", { class: "pgcHapCov", text: (Math.round(cov * 10) / 10) + "%" })
        ]);
        listBox.appendChild(lab);
    });
    box.appendChild(listBox);
    listBox.scrollTop = scroll;
}

function fillTargets(filter) {
    var sel = $("pgcTargets");
    var chosen = selectedTargets();
    var f = String(filter || "").trim().toLowerCase();
    var srcHap = currentSourceHap();
    clear(sel);
    // The candidates: everything but the source, and with "only with this
    // region" on, only those.  The hidden list holds all of them, so that a
    // choice survives searching and moving between populations.
    var candidates = allHaplotypes.filter(function (h) {
        var lower = h.toLowerCase();
        if (srcHap && lower === String(srcHap).toLowerCase()) return false; // no self-conversion
        if (reachable && !(lower in reachable)) return false;
        return true;
    });
    // With scores, the most relevant destinations come first; otherwise keep the
    // alphabetical order the list arrived in.
    if (reachableScored)
        candidates.sort(function (a, b) {
            var ca = reachable[a.toLowerCase()], cb = reachable[b.toLowerCase()];
            ca = (ca == null ? -1 : ca); cb = (cb == null ? -1 : cb);
            if (cb !== ca) return cb - ca;
            return a.localeCompare(b);
        });
    candidates.forEach(function (h) {
        var cov = reachable ? reachable[h.toLowerCase()] : null;
        var o = el("option", { text: (cov == null) ? hapLabel(h)
                                     : hapLabel(h) + "  (" + (Math.round(cov * 10) / 10) + "%)" });
        sel.appendChild(o);
        o.value = h;                       // the bare name is what gets submitted
        o.selected = chosen.indexOf(h) >= 0;
    });
    var chosenNow = selectedTargets();
    var chosenSet = Object.create(null);
    chosenNow.forEach(function (h) { chosenSet[h.toLowerCase()] = true; });

    // What the panes show: the candidates the search allows, and on the right
    // only the population picked.  A population the search leaves empty is let go.
    var matches = candidates.filter(function (h) { return matchesSearch(h, f); });
    if (popFilter && !matches.some(function (h) { return popGroupOf(h).key === popFilter; }))
        popFilter = null;
    var shown = popFilter ? matches.filter(function (h) { return popGroupOf(h).key === popFilter; })
                          : matches;
    drawChosen(chosenNow);
    drawPops(matches, chosenSet);
    drawHaps(shown, chosenSet);

    // Kept to one short line, under the picker, so nothing above it moves.
    $("pgcTargetCount").textContent = candidates.length + " of " + allHaplotypes.length +
        " assembl" + (allHaplotypes.length === 1 ? "y" : "ies") +
        (reachable ? (reachableScored ? " sharing this region, best first"
                                      : " containing this region") : "") +
        (srcHap ? "; the source haplotype is excluded" : "") +
        (f ? "; " + matches.length + " match the search" : "");
}

// Ask the graph which haplotypes this region exists on, and narrow the picker to
// those.  Saves guessing among hundreds of haplotypes that may have no
// equivalent region at all.
// The reachability filter is one checkbox, so turning it on and off is one
// function.  The answer is kept once fetched: it only depends on the source
// region, so flipping the box back on does not ask again.
function setToggleBusy(busy) {
    var lab = $("pgcReachableOnly") && $("pgcReachableOnly").parentNode;
    if (lab && lab.classList) {
        if (busy) { lab.classList.add("pgcBusy"); }
        else { lab.classList.remove("pgcBusy"); }
    }
    if ($("pgcReachableOnly")) { $("pgcReachableOnly").disabled = !!busy; }
}

function onReachableToggle() {
    var box = $("pgcReachableOnly");
    if (!box || !box.checked) { showAllHaplotypes(); return; }
    if (reachableCache) {        // already asked for this region
        reachable = reachableCache;
        reachableScored = reachableCacheScored;
        fillTargets($("pgcFilter").value);
        hideStatus();
        return;
    }
    showReachable();
}

function showReachable() {
    var src = buildSource();
    if (src.error) { showError(src.error); untick(); return; }
    setToggleBusy(true);
    showBusy("Asking which assemblies contain " +
             fmtPos(src.contig, src.start, src.end) + "…");
    var req = { src: src.src, start: src.start, end: src.end, scored: true };
    // Very low scores are usually incidental repeat matches, so ask the server
    // to drop them rather than filtering a long list here.
    if (typeof CFG.minTargetCoverage === "number")
        req.min_coverage = CFG.minTargetCoverage;
    // Bound the reachability scan.  Without a cap it walks far more of the
    // graph than the answer needs, which is both slow and where the false
    // positives came from.
    if (typeof CFG.maxTargetNodes === "number")
        req.max_nodes = CFG.maxTargetNodes;
    postCmd("liftoverTargets", req)
        .then(function (resp) {
            if (resp && resp.status === "error") throw new Error(resp.error || "server error");
            // An answer with no list at all is not the same as an empty list:
            // saying "no assembly contains this region" when the server never
            // told us would be a confident wrong answer.
            if (!resp || !Array.isArray(resp.haplotypes))
                throw new Error("the mapping server returned no list of assemblies");
            // Entries are plain names, or {haplotype, coverage, covered_bp} when
            // the server ranked them.  Accept both.  Compare case-insensitively:
            // this list and the haplotype list are produced separately, so do
            // not assume they agree on spelling.
            reachable = Object.create(null);
            reachableScored = false;
            ((resp && resp.haplotypes) || []).forEach(function (h) {
                if (h && typeof h === "object") {
                    reachable[String(h.haplotype).toLowerCase()] =
                        typeof h.coverage === "number" ? h.coverage : null;
                    if (typeof h.coverage === "number") reachableScored = true;
                } else {
                    reachable[String(h).toLowerCase()] = null;
                }
            });
            reachableCache = reachable;
            reachableCacheScored = reachableScored;
            setToggleBusy(false);
            fillTargets($("pgcFilter").value);
            if (Object.keys(reachable).length === 0)
                showError("No assembly in the graph contains this region.");
            else
                hideStatus();
        })
        .catch(function (err) {
            setToggleBusy(false);
            untick();
            showError("Could not check which assemblies contain this region: " +
                      err.message, onReachableToggle);
        });
}

// The filter did not take, so the box must not claim it did.
function untick() {
    if ($("pgcReachableOnly")) { $("pgcReachableOnly").checked = false; }
    reachable = null;
    reachableScored = false;
}

function showAllHaplotypes() {
    reachable = null;
    reachableScored = false;
    fillTargets($("pgcFilter").value);
    hideStatus();
}

// Pre-select a sensible target so the page is one click from an answer.  Skips
// any that is the source haplotype.
function preselectDefaultTarget() {
    // A destination chosen in hgConvert wins over the configured default: the
    // user already said where they wanted to go.
    // The SV page sends several, comma separated.
    var src = String(currentSourceHap() || "").toLowerCase();
    var want = String(CFG.presetTarget || CFG.defaultTarget || "").toLowerCase()
        .split(",").map(function (w) { return w.trim(); })
        .filter(function (w) { return w && w !== src; });
    if (!want.length) return;
    targetOptions($("pgcTargets")).forEach(function (o) {
        if (want.indexOf(String(o.value || o.textContent).toLowerCase()) >= 0)
            o.selected = true;
    });
}

function selectedTargets() {
    var out = [];
    targetOptions($("pgcTargets")).forEach(function (o) {
        // o.value is the bare haplotype name; the label may carry a percentage
        if (o.selected) out.push(o.value || o.textContent);
    });
    return out;
}

// ---- Source -----------------------------------------------------------------

// The source haplotype the user has chosen.  Before the graph's list arrives
// the picker is empty, so fall back to whatever the inherited assembly implies.
function currentSourceHap() {
    var sel = $("pgcSrcHap");
    if (sel && sel.value) return sel.value;
    return hapForDb(($("pgcSrcDb") || {}).value || "");
}

// Fill the source picker from the graph and select the best starting point:
// the haplotype for the assembly we arrived from, else the configured default.
// Settle what the source is and say so.  There is nothing to choose: the
// assembly is the one the user came from, and the position is the region they
// were looking at.  Both are carried in hidden inputs; this writes the line
// that tells the user what they are.
function fillSources() {
    var box = $("pgcSrcHap");
    if (!box) { return; }
    var want = String(hapForDb(($("pgcSrcDb") || {}).value || "") || "");
    var chosen = null;
    var lower = want.toLowerCase();
    allHaplotypes.forEach(function (h) {
        if (chosen === null && h.toLowerCase() === lower) { chosen = h; }
    });
    // The graph's list may not have arrived, or may not know this assembly;
    // the name we worked out from the db is still the right answer.
    box.value = chosen || want || "";
    showSourceLabel();
}

// "HG01258 maternal — CM088139.1:7,100,001-7,140,000", or as much of it as is
// known yet.
function showSourceLabel() {
    var el2 = $("pgcSrcLabel");
    if (!el2) { return; }
    var hap = currentSourceHap();
    var pos = (($("pgcPos") || {}).value || "").trim();
    var text = hap ? hapLabel(hap) : "";
    if (pos) { text += (text ? " \u2014 " : "") + pos; }
    el2.textContent = text;
}

// Changing the source invalidates anything computed for the previous one.
function onSourceChange() {
    reachable = null;
    reachableScored = false;
    reachableCache = null;
    reachableCacheScored = false;
    if ($("pgcReachableOnly")) { $("pgcReachableOnly").checked = false; }
    fillTargets($("pgcFilter").value);
    describeSource(null);
    loadContigs();
    liftCheckFor = null;        // a new source is a new question
    checkLiftable();
}

// Make sure the page opens in a state that can actually be converted: if the
// inherited assembly is not a pangenome haplotype, or there is no position to
// go with it, fall back to a configured example instead of an unusable form.
// The source db and position move together - a position only means something on
// its own assembly.
// Fill in what is missing, and only what is missing.
//
// These are two independent questions and were being answered as one: an
// assembly the page did not recognise replaced the position too, so a request
// for chr10 came back converted from the example region on chr9.  A position
// the user gave us is never overwritten - if we cannot use it we say so, and
// the caller declines to convert rather than quietly answering about somewhere
// else.
//
// Returns {why, tookPosition} or null when nothing needed filling in.
function applySourceFallback() {
    var db = ($("pgcSrcDb") || {}).value || "";
    var pos = ($("pgcPos") || {}).value || "";
    var haveDb = !!hapForDb(db);
    var havePos = pos.trim() !== "";
    if (haveDb && havePos) return null;

    var why = !haveDb
        ? (!db ? "no assembly was carried over"
               : "assembly " + bareDb(db) + " is not part of the pangenome")
        : "no position was carried over";
    if (!haveDb)
        $("pgcSrcDb").value = CFG.defaultSrcDb || "hs1";
    var tookPosition = false;
    if (!havePos) {
        $("pgcPos").value = CFG.defaultPosition || "";
        showSourceLabel();
        tookPosition = true;
    }
    return { why: why, tookPosition: tookPosition };
}

function describeSource(fallback) {
    var fallbackWhy = fallback && fallback.why;
    var db = ($("pgcSrcDb") || {}).value || "";
    var hap = currentSourceHap();
    var note = $("pgcSrcNote");
    if (!hap) {
        note.textContent = db
            ? "Assembly " + db + " is not one of the pangenome haplotypes."
            : "Pick the haplotype your coordinates are on.";
        return;
    }
    var assembly = assemblyForHap(hap);
    var parts = [];
    if (assembly && !/^https?:/.test(assembly)) parts.push("assembly " + assembly);
    // The caveat about the contig belonging to this haplotype has gone with the
    // text box it was advice for.  The position is inherited now, and when it
    // does not fit the source, contigProblem() says so in those terms at the
    // moment it matters.
    if (fallbackWhy && fallback.tookPosition)
        parts.push("shown as a starting example because " + fallbackWhy);
    else if (fallbackWhy)
        parts.push(fallbackWhy);
    note.textContent = parts.join(" \u2014 ");
}

// ---- Sequences of the source haplotype --------------------------------------
//
// Contig names are not shared between haplotypes - chr9 on CHM13 but
// CM094066.1 (or a JBH... WGS contig) on a sample - so a name that works for one
// source is simply absent from another.  Offer the real list rather than
// letting the request fail upstream with "No paths found".

var contigCache = Object.create(null);   // assembly -> {names, sizes, display, nativeOf}
var contigsForSource = null;             // the list for the current source, or null
// Lower-cased spelling -> the accession the graph knows.  Holds both spellings
// of every sequence, because a position can arrive either way: typed from the
// graph's own naming, or copied out of the browser's address box.
var nativeForSource = null;

function loadContigs() {
    var hap = currentSourceHap();
    var assembly = hap ? assemblyForHap(hap) : null;
    contigsForSource = null;
    // Hub-URL assemblies are not ours to query, and an unknown haplotype has no
    // assembly at all; in both cases just stay quiet and let the server judge.
    if (!assembly || /^https?:/.test(assembly)) return;

    if (contigCache[assembly]) { applyContigs(contigCache[assembly]); return; }

    // Our own endpoint rather than hubApi/list/chromosomes: that reports only
    // the accessions, and half the point here is to know the name the browser
    // shows for each one.
    getCmd("cmd=contigs&db=" + encodeURIComponent(assembly))
        .then(function (d) {
            var list = (d && d.contigs) || null;
            if (!list || !list.length) return;
            var sizes = Object.create(null), display = Object.create(null),
                nativeOf = Object.create(null);
            list.forEach(function (c) {
                if (!c || !c.name) return;
                sizes[c.name] = c.size;
                display[c.name] = c.display || c.name;
                nativeOf[String(c.name).toLowerCase()] = c.name;
                if (c.display)
                    nativeOf[String(c.display).toLowerCase()] = c.name;
            });
            var names = Object.keys(sizes).sort(function (a, b) {
                return sizes[b] - sizes[a];         // biggest first: chromosomes
            });
            contigCache[assembly] = { names: names, sizes: sizes,
                                      display: display, nativeOf: nativeOf };
            applyContigs(contigCache[assembly]);
        })
        .catch(function () { /* advisory only */ });
}

function nameShown(info, n) {
    // What the browser calls this sequence, which is what the user will have in
    // front of them.  Falls back to the accession where there is no alias.
    return (info.display && info.display[n]) || n;
}

function nameBoth(info, n) {
    // For a message about a name the user got wrong, give them both spellings:
    // answering "CM094066" with "did you mean chr7" is correct but leaves them
    // to guess that the two are the same sequence.
    var shown = nameShown(info, n);
    return (shown === n) ? n : (shown + " (" + n + ")");
}

// The source's sequence names, kept for one purpose now that the position is
// not typed: checking that the position we inherited actually names a sequence
// of this assembly.  An inherited position can be stale - the browser's own
// spelling of a contig, or one left from another assembly - and contigProblem()
// says so in terms the user can act on.
function applyContigs(info) {
    contigsForSource = info.names;
    nativeForSource = info.nativeOf || null;
}

// The accession the graph knows this sequence by, whatever the user called it.
//
// These assembly hubs set "chromAuthority ucsc", so the browser labels a
// sequence chrUn_JBIREP010000009v1 while the graph only answers to
// JBIREP010000009.1.  A position pasted out of the browser has to be
// translated, or the graph reports the region as simply absent.  Unknown names
// pass through untouched: the server is a better judge than a guess here.
function nativeContig(contig) {
    if (!nativeForSource) return contig;
    var hit = nativeForSource[String(contig).toLowerCase()];
    return hit || contig;
}

// Advisory check: is this contig one of the source's sequences?  Either
// spelling counts - rejecting the browser's own name for it was the bug this
// guards against.
function contigProblem(contig) {
    if (!contigsForSource) return null;                 // unknown; let the server judge
    if (contigsForSource.indexOf(nativeContig(contig)) >= 0) return null;
    var lower = String(contig).toLowerCase();
    var info = contigCache[assemblyForHap(currentSourceHap())] || {};
    var near = contigsForSource.filter(function (n) {
        return n.toLowerCase().indexOf(lower) >= 0 ||
               nameShown(info, n).toLowerCase().indexOf(lower) >= 0;
    }).map(function (n) { return nameBoth(info, n); }).slice(0, 3);
    return "\"" + contig + "\" is not a sequence of " + hapLabel(currentSourceHap()) +
           (near.length ? ".  Did you mean " + near.join(", ") + "?"
                        : ".  Its largest sequences are " +
                          contigsForSource.slice(0, 3).map(function (n) {
                              return nameBoth(info, n);
                          }).join(", ") + ".");
}

// ---- Ancestry at each region (pcLAI) --------------------------------------
//
// Each converted region is read in its own assembly's pcLAI, as the results
// page reads each hit, and shown three ways: a line of text with the ancestry
// under every region, a strip of its windows where the ancestry changes inside
// it, and - with two or more targets - a summary and the results page's plot.
//
// pcLAI calls ancestry per window of about 1000 SNPs (roughly 100 kb).  Each
// window carries a continuous position (PC1, PC2), the authors' colour for it,
// and a discretized call: the centroid of one of the four ancestry clusters
// the release uses.  The clusters have no names in the files, so a call is
// named from the reference panel - by the 1000 Genomes populations whose
// haplotypes lie nearest its centroid - and the nearest populations are given
// alongside, so the name can be checked.  It is ancestry at this region, not
// the person's ancestry, and the wording says "in this region" for that reason.

// The 1000 Genomes super-populations of the panel's 21 populations.
var ANC_SUPERPOP = {
    "Esan in Nigeria": "African", "Mende in Sierra Leone": "African",
    "Yoruba in Ibadan, Nigeria": "African", "Gambian in Western Division - Mandinka": "African",
    "Luhya in Webuye, Kenya": "African",
    "Iberian Populations in Spain": "European", "Toscani in Italia": "European",
    "British from England and Scotland": "European", "Finnish in Finland": "European",
    "Punjabi in Lahore, Pakistan": "South Asian", "Sri Lankan Tamil in the UK": "South Asian",
    "Indian Telugu in the UK": "South Asian", "Gujarati Indians in Houston, Texas, USA": "South Asian",
    "Bengali in Bangladesh": "South Asian",
    "Peruvian in Lima, Peru": "American", "Mexican Ancestry in Los Angeles, California, USA": "American",
    "Kinh in Ho Chi Minh City, Vietnam": "East Asian", "Japanese in Tokyo, Japan": "East Asian",
    "Chinese Dai in Xishuangbanna": "East Asian", "Han Chinese in Beijing, China": "East Asian",
    "Han Chinese South, China": "East Asian"
};
var ANC_NEAREST = 60;          // reference haplotypes that name a cluster
var ANC_PER_REQUEST = 100;     // regions per pcLAI request; the server's own cap
var ancSeq = 0;                // which conversion an answer belongs to
var ancNames = Object.create(null);

function ancOn() {
    return typeof pangenomePclai !== "undefined" && !!pangenomePclai;
}

// The name of the cluster whose centroid is (cx, cy): the super-population of
// most of the reference haplotypes nearest it, and the populations among them.
function ancClusterName(panel, cx, cy) {
    var key = cx + "," + cy;
    if (ancNames[key]) return ancNames[key];
    var labels = (panel && panel.labels) || [], pts = (panel && panel.points) || [];
    var near = pts.map(function (p) {
        return { d: (p[0] - cx) * (p[0] - cx) + (p[1] - cy) * (p[1] - cy), pop: labels[p[2]] };
    }).sort(function (a, b) { return a.d - b.d; }).slice(0, ANC_NEAREST);
    var bySuper = Object.create(null), byPop = Object.create(null);
    near.forEach(function (n) {
        var sp = ANC_SUPERPOP[n.pop] || n.pop;
        bySuper[sp] = (bySuper[sp] || 0) + 1;
        byPop[n.pop] = (byPop[n.pop] || 0) + 1;
    });
    var supers = Object.keys(bySuper).sort(function (a, b) { return bySuper[b] - bySuper[a]; });
    var pops = Object.keys(byPop).sort(function (a, b) { return byPop[b] - byPop[a]; })
        .slice(0, 4).map(function (p) {
            return p + " " + Math.round(100 * byPop[p] / near.length) + "%";
        });
    var out = { name: supers.length ? supers[0] : "unnamed", near: pops.join(", ") };
    ancNames[key] = out;
    return out;
}

// One region's windows, summed by cluster over the bases each covers.
function ancSummary(point, panel) {
    var wins = (point && point.windows) || [];
    var parts = [], byName = Object.create(null), total = 0, minConf = 1000;
    wins.forEach(function (w) {
        var len = w.e - w.s;
        if (len <= 0) return;
        var c = (w.cx != null) ? ancClusterName(panel, w.cx, w.cy) : { name: "unnamed", near: "" };
        w.cluster = c;
        if (!byName[c.name]) {
            byName[c.name] = { name: c.name, near: c.near, bases: 0, rgb: w.rgb };
            parts.push(byName[c.name]);
        }
        byName[c.name].bases += len;
        total += len;
        if (w.conf < minConf) minConf = w.conf;
    });
    parts.sort(function (a, b) { return b.bases - a.bases; });
    parts.forEach(function (p) { p.pct = total ? 100 * p.bases / total : 0; });
    return { parts: parts, windows: wins, total: total, minConf: minConf };
}

function ancSwatch(rgb) {
    var sw = el("span", { class: "pgcAncSw" });
    if (rgb && /^\d+,\d+,\d+$/.test(rgb)) sw.style.background = "rgb(" + rgb + ")";
    return sw;
}

// "European", or "Mixed: European 70% · African 30%" - read under a "Local
// ancestry" heading, which is what keeps it from being taken for the sample's
// population.
function ancText(sum) {
    if (sum.parts.length === 1) return sum.parts[0].name;
    return "Mixed: " + sum.parts.map(function (p) {
        return p.name + " " + Math.round(p.pct) + "%";
    }).join(" · ");
}

function ancTitle(sum, point) {
    var first = sum.windows[0], last = sum.windows[sum.windows.length - 1];
    var lines = [];
    lines.push("pcLAI " + (sum.windows.length === 1 ? "window " + first.w
               : sum.windows.length + " windows, " + first.w + " to " + last.w));
    lines.push("PC1 " + point.x.toFixed(3) + ", PC2 " + point.y.toFixed(3) +
               (sum.windows.length > 1 ? " (the window covering most of the region)" : ""));
    sum.parts.forEach(function (p) {
        lines.push(p.name + ": nearest reference haplotypes " + p.near);
    });
    lines.push("Confidence " + (sum.minConf === 1000 ? "1000" : "at least " + sum.minConf) + "/1000");
    return lines.join("\n");
}

// The windows of a region whose ancestry changes inside it, each as wide as
// the share of the region it covers.  Gaps - a dropped window, a centromere -
// stay blank.
function ancStrip(sum, start, end) {
    var strip = el("div", { class: "pgcAncStrip", role: "img",
        "aria-label": "Ancestry along the region: " + ancText(sum) });
    var span = Math.max(1, end - start);
    sum.windows.forEach(function (w) {
        if (w.e <= w.s) return;
        var cell = el("span", { class: "pgcAncCell",
            title: w.w + "  " + (w.s + 1).toLocaleString() + "-" + w.e.toLocaleString() +
                   "\n" + (w.cluster ? w.cluster.name : "") +
                   "  PC1 " + w.x.toFixed(3) + ", PC2 " + w.y.toFixed(3) +
                   "\nConfidence " + w.conf + "/1000" });
        cell.style.left = (100 * (w.s - start) / span).toFixed(2) + "%";
        cell.style.width = Math.max(0.4, 100 * (w.e - w.s) / span).toFixed(2) + "%";
        if (w.rgb && /^\d+,\d+,\d+$/.test(w.rgb)) cell.style.background = "rgb(" + w.rgb + ")";
        strip.appendChild(cell);
    });
    return strip;
}

// Why a region has no ancestry to show, from what it is.
function ancNone(db) {
    if (db === "hg38") return "No ancestry: GRCh38 is a mosaic of several people";
    if (db === "hs1") return "No ancestry in CHM13's own coordinates";
    return "No ancestry for this assembly";
}

// Fill one slot: the line of text, and the strip where the ancestry changes.
function ancFill(slot, point, panel, start, end) {
    clear(slot);
    if (!point || !point.windows || !point.windows.length) {
        slot.appendChild(el("span", { class: "pgMuted",
            text: "No call: no pcLAI window covers it" }));
        return null;
    }
    var sum = ancSummary(point, panel);
    if (!sum.parts.length) return null;
    var line = el("span", { class: "pgcAncLine", title: ancTitle(sum, point) });
    sum.parts.forEach(function (p) { line.appendChild(ancSwatch(p.rgb)); });
    line.appendChild(el("span", { text: ancText(sum) }));
    if (sum.minConf < 900)
        line.appendChild(el("span", { class: "pgMuted", text: " (low confidence)" }));
    slot.appendChild(line);
    if (sum.parts.length > 1) slot.appendChild(ancStrip(sum, start, end));
    return sum;
}

// Read every region's ancestry in one request and fill the slots
// renderResults() left.  `asks` is one {slot, hap, db, contig, start, end,
// role, label, url} per region, the source first.
function ancRead(asks) {
    var seq = ++ancSeq;
    var spots = [];
    asks.forEach(function (a, i) {
        a.id = "a" + i;
        if (a.db && /^GC[AF]_/.test(a.db)) {
            spots.push({ id: a.id, hap: a.hap, acc: a.db, contig: a.contig,
                         start: a.start, end: a.end });
        } else {
            clear(a.slot);
            a.slot.appendChild(el("span", { class: "pgMuted", text: ancNone(a.db) }));
        }
    });
    if (!spots.length) return;
    asks.forEach(function (a) {
        if (a.db && /^GC[AF]_/.test(a.db))
            a.slot.appendChild(el("span", { class: "pgMuted", text: "Reading ancestry…" }));
    });
    // The server reads at most ANC_PER_REQUEST regions per request (its
    // pangenome.pclaiMaxHaplotypes), so a conversion to every haplotype is read
    // in several, one after another, and their points put together.
    var chunks = [];
    for (var c = 0; c < spots.length; c += ANC_PER_REQUEST) chunks.push(spots.slice(c, c + ANC_PER_REQUEST));
    var merged = null;
    chunks.reduce(function (prev, chunk) {
        return prev.then(function () {
            return postCmd("pclai", { windows: true, spots: chunk }).then(function (r) {
                if (!r || r.status !== "ok") throw new Error((r && r.error) || "no answer");
                if (!merged) merged = r;
                else merged.points = (merged.points || []).concat(r.points || []);
            });
        });
    }, Promise.resolve()).then(function () { return merged; }).then(function (resp) {
        if (seq !== ancSeq) return;                    // a newer conversion owns the page
        if (!resp || resp.status !== "ok") throw new Error((resp && resp.error) || "no answer");
        var byId = Object.create(null);
        (resp.points || []).forEach(function (p) { byId[p.id] = p; });
        asks.forEach(function (a) {
            if (a.db && /^GC[AF]_/.test(a.db))
                a.sum = ancFill(a.slot, byId[a.id] || null, resp.panel, a.start, a.end);
        });
        ancSummaryLine(asks, resp);
    }).catch(function (err) {
        if (seq !== ancSeq) return;
        asks.forEach(function (a) {
            if (a.db && /^GC[AF]_/.test(a.db)) {
                clear(a.slot);
                a.slot.appendChild(el("span", { class: "pgMuted",
                    text: "Could not read the ancestry in this region: " + err.message }));
            }
        });
    });
}

// With two or more targets: how their ancestry in this region adds up, and the plot.
function ancSummaryLine(asks, resp) {
    var box = $("pgcAncSummary");
    if (!box) return;
    var targets = asks.filter(function (a) { return a.role === "target" && a.sum; });
    if (targets.length < 2) return;
    var count = Object.create(null), order = [];
    targets.forEach(function (a) {
        var k = a.sum.parts.length === 1 ? a.sum.parts[0].name : "mixed";
        if (!(k in count)) { count[k] = 0; order.push(k); }
        count[k]++;
    });
    order.sort(function (x, y) { return count[y] - count[x]; });
    clear(box);
    box.appendChild(el("span", { text: "Local ancestry of the targets here: " +
        order.map(function (k) { return count[k] + " " + k; }).join(" · ") }));
    if (typeof pgpInit !== "function") return;
    // The results page's plot, given the answer already in hand: one point per
    // region, the source ringed.  Its button sits in the strip, where the
    // mapping results page has its own.
    var btn = el("button", { type: "button", class: "gbPill", id: "pgrPclaiBtn",
                             text: "Show ancestry plot" });
    ($("pgcStripActs") || box).appendChild(btn);
    var plotted = asks.filter(function (a) { return a.sum; });
    var spots = plotted.map(function (a) {
        return { id: a.id, hap: a.hap, acc: a.db, contig: a.contig, start: a.start, end: a.end,
                 coverage: null, placement: 0, placements: 1, url: a.url,
                 openId: a.anchor ? a.id : null,
                 info: [["Assembly", a.db], ["Region", fmtPos(a.contig, a.start, a.end)],
                        ["Local ancestry", ancText(a.sum)],
                        ["Role", a.role === "source" ? "the source of this conversion"
                                                     : "a target of this conversion"]] };
    });
    plotted.forEach(function (a) {
        if (a.role === "source") pgpPicked[a.hap] = true;
    });
    pgpInit(spots, { data: resp,
                     legend: { hit: "a region, in pcLAI's own colour", pick: "the source" } });
}

// ---- Results ----------------------------------------------------------------

// Build a Genome Browser link for one returned interval, or null if we have no
// assembly for that haplotype.
function browserLinkFor(interval) {
    var full = String(interval.haplotype || "");
    var parts = full.split("#");
    if (parts.length < 3) return null;
    var hap = parts[0] + "#" + parts[1];
    var contig = parts.slice(2).join("#");
    var assembly = assemblyForHap(hap);
    if (!assembly) return null;
    var pos = fmtPos(contig, interval.start, interval.end);
    if (/^https?:\/\//.test(assembly)) {          // per-server hub id: link off-site
        var sep = assembly.indexOf("?") >= 0 ? "&" : "?";
        return { url: assembly + sep + "position=" + encodeURIComponent(pos),
                 db: assembly, isRemote: true, contig: contig, pos: pos };
    }
    return { url: "../cgi-bin/hgTracks?db=" + encodeURIComponent(assembly) +
                  "&position=" + encodeURIComponent(pos),
             db: assembly, isRemote: false, contig: contig, pos: pos };
}

// ---- The results table ------------------------------------------------------
//
// One row per region found, laid out as the mapping page's results are: the
// sample and which of its haplotypes first, then its population, the position
// as the link that opens it, how much of the region it accounts for, and the
// local ancestry there.  A target with no equivalent region still gets a row
// that says so.  "Population" is the HPRC's description of the sample;
// "Local ancestry" is pcLAI's call for this stretch of this haplotype - two
// different things, and the column names keep them apart.
//
// The table is built as plain DOM so that every link and ancestry slot is a
// live node; in the browser DataTables then pages and sorts it (pgcPageTable).

function pctText(v) { return v == null ? "" : v.toFixed(1) + "%"; }

function renderResults(srcLabel, targets, intervals, failed, errors) {
    var box = $("pgcResults");
    clear(box);

    // Group the intervals by target haplotype so each requested target gets an
    // answer - including the honest empty one.
    var byHap = Object.create(null);
    (intervals || []).forEach(function (iv) {
        var full = String(iv.haplotype || "");
        var parts = full.split("#");
        var hap = parts.length >= 2 ? (parts[0] + "#" + parts[1]) : full;
        (byHap[hap.toLowerCase()] = byHap[hap.toLowerCase()] || []).push(iv);
    });
    var found = 0, withAny = 0;
    targets.forEach(function (t) {
        var n = (byHap[String(t).toLowerCase()] || []).length;
        found += n;
        if (n) withAny++;
    });

    var card = el("div", { class: "gbCard pgcCard" });
    box.appendChild(el("div", { class: "gbApp" }, [card]));

    // The strip, as on the mapping results page: what was asked, what came back,
    // and the page's actions on the right.
    var acts = el("span", { class: "gbStripActions", id: "pgcStripActs" });
    var stat = function (k, v) {
        return el("div", { class: "gbStat" }, [el("span", { class: "k", text: k }),
                                               el("span", { class: "v", text: v })]);
    };
    var div = function () { return el("span", { class: "gbDiv" }); };
    var sPop = samplePop(currentSourceHap());
    var srcLen = (lastSource && lastSource.end > lastSource.start)
        ? lastSource.end - lastSource.start : 0;
    card.appendChild(el("div", { class: "gbStrip" }, [
        stat("Converted from", srcLabel), div(),
        stat("Population", sPop ? sPop.desc + " (" + sPop.code + ")" : "—"), div(),
        stat("Length", srcLen ? withCommas(srcLen) + " bp" : "—"), div(),
        stat("Targets", withCommas(targets.length)), div(),
        stat("Found on", withCommas(withAny) + " of " + withCommas(targets.length)),
        acts
    ]));

    // What the ancestry readout fills in once it has an answer: a slot for the
    // source, one in each row, a summary line and the plot.
    var anc = ancOn() && lastSource ? [] : null;
    var notes = el("div", { class: "pgrNotes" });
    if (anc) {
        var srcHap = currentSourceHap();
        var srcSlot = el("span", { class: "pgcAnc pgcAncSrc" });
        notes.appendChild(el("div", { class: "pgrNote pgcSrcAnc" }, [
            el("span", { text: "Local ancestry of the source here: " }), srcSlot]));
        var srcParts = String(lastSource.src || "").split("#");
        anc.push({ slot: srcSlot, role: "source", hap: srcParts.slice(0, 2).join("#"),
                   db: assemblyForHap(srcHap), contig: srcParts.slice(2).join("#"),
                   start: lastSource.start, end: lastSource.end,
                   url: (browserLinkFor({ haplotype: lastSource.src, start: lastSource.start,
                                          end: lastSource.end }) || {}).url });
    }
    if (wideRegionWarning)
        notes.appendChild(el("div", { class: "pgrNote pgErrBox pgcWide", text:
            "This region is large; translation of wide intervals is known to " +
            "drop some positions, so treat the result as incomplete." }));
    if (anc)
        notes.appendChild(el("div", { class: "pgrNote pgcAncSummary", id: "pgcAncSummary" }));
    if (notes.firstChild) card.appendChild(notes);
    if (anc) {
        var plotHost = el("div", { class: "pgrPanel", id: "pgrPclaiPlot" });
        plotHost.style.display = "none";
        // A region's "View in Genome Browser" in the plot is that region's
        // link, clicked: one way to open a target, whichever place it is from.
        plotHost.addEventListener("click", function (ev) {
            var b = ev.target && ev.target.closest ? ev.target.closest("[data-pgp-open]") : null;
            if (!b) return;
            var hit = anc.filter(function (x) { return x.id === b.getAttribute("data-pgp-open"); })[0];
            if (!hit || !hit.anchor) return;            // no row link: the plain href stands
            ev.preventDefault();
            hit.anchor.click();
        });
        card.appendChild(plotHost);
    }

    var head = ["#", "Sample", "Haplotype", "Population", "Open in Genome Browser",
                "Bases", "Span", "Strand"];
    var tips = { Bases: "Share of the region's bases that carried over to this place",
                 Span: "Share of the region's span between the first and last base that carried over",
                 Haplotype: "Which of the sample's two haplotypes; 0 for a reference",
                 Population: "The sample's population, as the HPRC describes it",
                 "Local ancestry": "pcLAI's ancestry call for this stretch of this haplotype" };
    if (anc) head.push("Local ancestry");
    var table = el("table", { id: "pgcTable", class: "display pgcTable" });
    table.appendChild(el("thead", null, [el("tr", null, head.map(function (h) {
        return el("th", tips[h] ? { text: h, title: tips[h] } : { text: h });
    }))]));
    var tbody = el("tbody");
    table.appendChild(tbody);

    var origSize = srcLen;
    var rank = 0;
    targets.forEach(function (t) {
        var pieces = byHap[String(t).toLowerCase()] || [];
        var info = prettyHap(t);
        var pop = samplePop(t);
        var popText = pop ? pop.desc + " (" + pop.code + ")" : "";
        // Trio-phased assemblies know which parent a haplotype came from.
        var parent = info.label.split(" ")[1];
        parent = (parent === "paternal" || parent === "maternal") ? parent : null;
        var lead = function () {
            return [el("td", { class: "rankCol", text: String(++rank) }),
                    el("td", { class: "sampleCol", text: info.sample }),
                    el("td", parent ? { class: "phaseCol", text: info.phase, title: parent }
                                    : { class: "phaseCol", text: info.phase == null ? "" : info.phase }),
                    el("td", { class: "popCol", text: popText })];
        };
        if (pieces.length === 0) {
            var lost = (failed || []).indexOf(t) >= 0;
            var none = el("tr", { class: "pgcNone" }, lead().concat([
                el("td", { class: "posCol" }, lost ? [el("span", { class: "pgrUnplaced",
                    text: "not translated" }),
                    el("span", { class: "pgcNoneWhy", text: " - the request failed: " +
                                 ((errors || [])[0] || "no answer") + "." })] :
                    [el("span", { class: "pgrUnplaced", text: "no equivalent region" }),
                    el("span", { class: "pgcNoneWhy",
                                 text: " - this region does not exist on " + hapLabel(t) + "." })]),
                el("td", { class: "pctCol" }), el("td", { class: "pctCol" }),
                el("td", { class: "strandCol" })
            ].concat(anc ? [el("td", { class: "ancCol" })] : [])));
            tbody.appendChild(none);
            return;
        }
        pieces.forEach(function (iv) {
            var link = browserLinkFor(iv);
            var label = link ? link.pos
                             : (hapLabel(iv.haplotype) + ":" + (iv.start + 1) + "-" + iv.end);
            var posCell = el("td", { class: "posCol" });
            var a = null;
            // The position itself is the link, as hgConvert's is.
            if (link) {
                a = el("a", { href: link.url, text: label,
                    title: "Show this region in the UCSC Genome Browser " +
                           "(assembly " + link.db + ")" });
                if (link.isRemote) {
                    a.setAttribute("target", "_blank");
                    a.setAttribute("rel", "noopener");
                }
                // With annotations asked for, this link carries the source's
                // tracks with it - one link, as in hgConvert.
                if (wantsAnnotations(iv))
                    armAnnotationLink(a, iv, link);
                posCell.appendChild(a);
            } else {
                posCell.appendChild(el("code", { text: label }));
            }
            // Both percentages are against the region the user asked to
            // convert, as hgConvert's are.
            var bases = null, spanPct = null;
            if (origSize > 0 && typeof iv.mapped === "number" && typeof iv.srcStart === "number") {
                bases = 100 * iv.mapped / origSize;
                spanPct = 100 * (iv.srcEnd - iv.srcStart) / origSize;
            }
            var cells = lead().concat([posCell,
                el("td", { class: "pctCol", text: pctText(bases) }),
                el("td", { class: "pctCol", text: pctText(spanPct) }),
                el("td", iv.strand === "-" ? { class: "strandCol", text: "-", title: "reverse strand" }
                                           : { class: "strandCol", text: "+" })]);
            if (anc) {
                var slot = el("div", { class: "pgcAnc" });
                cells.push(el("td", { class: "ancCol" }, [slot]));
                var ivParts = String(iv.haplotype || "").split("#");
                var ivHap = ivParts.slice(0, 2).join("#");
                // The row's own link goes along: the plot's "View in Genome
                // Browser" clicks it, so annotations and the alignment
                // differences come with it exactly as they do from here.
                anc.push({ slot: slot, role: "target", hap: ivHap,
                           db: assemblyForHap(ivHap), contig: ivParts.slice(2).join("#"),
                           start: iv.start, end: iv.end, url: link ? link.url : null,
                           anchor: a });
            }
            tbody.appendChild(el("tr", null, cells));
        });
    });
    card.appendChild(el("div", { class: "pgcTableWrap" }, [table]));
    pgcPageTable(table);
    if (anc) ancRead(anc);
}

// Pages and sorting, as on the mapping results page, when DataTables is on the
// page; without it the table is simply all there.
function pgcPageTable(table) {
    var jq = window.jQuery;
    if (!jq || !jq.fn || !jq.fn.dataTable) return;
    var len = 50;
    try {
        var v = parseInt(window.localStorage.getItem("hgPangenome.pageLen"), 10);
        if (v === -1 || v === 25 || v === 50 || v === 100) len = v;
    } catch (e) { /* the default */ }
    var dt = jq(table).DataTable({
        paging: true,
        pageLength: len,
        lengthMenu: [[25, 50, 100, -1], [25, 50, 100, "All"]],
        pagingType: "simple_numbers",
        dom: '<"pgrPageBar"lfip>rt<"pgrPageBar"ip>',
        order: [],
        columnDefs: [{ targets: 0, orderable: true }],
        language: { search: "", searchPlaceholder: "Filter by sample, population, contig…",
                    lengthMenu: "Show _MENU_ rows",
                    info: "Rows _START_-_END_ of _TOTAL_",
                    infoEmpty: "No rows",
                    infoFiltered: "(filtered from _MAX_)",
                    paginate: { previous: "Previous", next: "Next" } }
    });
    dt.on("length", function (e, settings, n) {
        try { window.localStorage.setItem("hgPangenome.pageLen", String(n)); } catch (err) { /* this page only */ }
    });
}

// Offer to carry the source's own gene tracks over to this target.  The chain
// is built from the blocks we already have, so this costs the mapping server
// nothing further.
// Can this row carry the source's annotations?  Only when the user asked for
// them, we have the blocks the chain is built from, and both sides are
// assemblies this server can open.
function wantsAnnotations(iv) {
    if (!quickLiftWanted() || !lastBlocks || !lastSource) return false;
    var parts = String(iv.haplotype || "").split("#");
    if (parts.length < 2) return false;
    var hap = (parts[0] + "#" + parts[1]).toLowerCase();
    var blocks = lastBlocks[hap];
    if (!blocks || blocks.length === 0) return false;
    var srcDb = assemblyForHap(currentSourceHap());
    var tgtDb = assemblyForHap(parts[0] + "#" + parts[1]);
    return !!(srcDb && tgtDb && !/^https?:/.test(srcDb) && !/^https?:/.test(tgtDb));
}

// Make one link carry the lifted tracks: hgConvert puts the quickLift
// parameters on the position link itself rather than offering a second one, so
// the annotations arrive with the click the user was going to make anyway.
function armAnnotationLink(a, iv, link) {
    var prepared = null;
    a.addEventListener("click", function (e) {
        if (prepared) return;                 // already have the real target
        e.preventDefault();
        var parts = String(iv.haplotype).split("#");
        var hap = parts[0] + "#" + parts[1];
        var was = a.textContent;
        a.textContent = was + " — preparing…";
        // The interval and the target, not the blocks.  The server fetches its
        // own - it was already doing so for the padding - and posting ours put
        // an unbounded array in the request body: a conversion over a big or
        // repeat-dense region went past the 1 MB cap cheapcgi.c enforces, which
        // aborts with an HTML page and surfaced here as
        // "Unexpected token '<' ... is not valid JSON".
        var payload = {
            srcDb: assemblyForHap(currentSourceHap()),
            tgtDb: assemblyForHap(hap),
            src: lastSource.src,
            srcHap: hapLabel(currentSourceHap()),
            srcStart: lastSource.start,
            srcEnd: lastSource.end,
            tgt: canonicalHap(hap),
            position: link.pos,
            hideTracks: hideTargetTracks() ? "on" : "off"
        };
        postCmd("quickLift", payload).then(function (resp) {
            a.textContent = was;
            if (resp && resp.status === "error") throw new Error(resp.error);
            prepared = resp.url;
            a.setAttribute("href", resp.url);
            requestWiderChain(payload);
            window.location = resp.url;
        }).catch(function (err) {
            // Fall back to the plain position rather than going nowhere.
            a.textContent = was;
            prepared = link.url;
            showError("Could not carry the annotations over: " + err.message);
        });
    });
}

function hideTargetTracks() {
    var box = $("pgcHideTracks");
    return !!(box && box.checked);
}

// ---- Convert ----------------------------------------------------------------

var lastRequest = null;
var lastBlocks = null;         // per target haplotype, when annotations were asked for
var lastSource = null;         // the source the blocks were computed from
var wideRegionWarning = false;
var WIDE_REGION_BP = 100000;   // above this, results may be incomplete upstream

// Ask whether the source has anything the browser could carry over, and say
// so on the form rather than after a conversion has run.
//
// The usual way to end up with nothing is the second leg of two conversions:
// arriving somewhere with "hide the target's own tracks" checked turns off
// everything that assembly has, and the annotations carried in are skipped
// deliberately, so a conversion onward from there has nothing left to take.
// That is worth knowing before pressing Submit, not after.
var liftCheckFor = null;        // the db the last answer was about

function showLiftWarning(html) {
    var el = $("pgcLiftWarn");
    if (!el) { return; }
    el.innerHTML = html || "";
    el.style.display = html ? "" : "none";
}

function checkLiftable() {
    if (!quickLiftWanted()) { showLiftWarning(null); return; }
    var db = assemblyForHap(currentSourceHap());
    if (!db) { showLiftWarning(null); return; }
    if (db === liftCheckFor) { return; }       // already answered for this one
    liftCheckFor = db;
    // The cart holds the visibilities this is a question about, so it has to go
    // to the user's own session rather than a fresh one.
    var url = selfUrl() + "?cmd=liftCheck&db=" + encodeURIComponent(db) +
              (CFG.hgsid ? "&hgsid=" + encodeURIComponent(CFG.hgsid) : "");
    fetch(url, { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); }).then(function (resp) {
        if (db !== liftCheckFor) { return; }   // the source moved on meanwhile
        // A null count means the check could not run; the conversion itself
        // will report whatever is wrong, so say nothing here.
        if (!resp || resp.tracks === null || resp.tracks === undefined) {
            showLiftWarning(null);
            return;
        }
        if (resp.tracks > 0) { showLiftWarning(null); return; }
        showLiftWarning(
            "No tracks are showing on this assembly, so there would be " +
            "nothing to carry over. If you arrived here from another " +
            "conversion, its tracks were hidden on the way in - " +
            "<a href='../cgi-bin/hgTracks?db=" + encodeURIComponent(db) +
            "' target='_blank'>turn some on</a> and come back, or uncheck " +
            "Annotations to convert the position alone.");
    }).catch(function () { showLiftWarning(null); });
}

function quickLiftWanted() {
    var box = $("pgcQuickLift");
    return !!(box && box.checked);
}

// Blocks arrive as a flat list covering every requested target; split them by
// haplotype so each result card can be turned into its own chain.
function groupBlocks(blocks) {
    var byHap = Object.create(null);
    (blocks || []).forEach(function (b) {
        var parts = String(b.haplotype || "").split("#");
        if (parts.length < 2) return;
        var hap = (parts[0] + "#" + parts[1]).toLowerCase();
        (byHap[hap] = byHap[hap] || []).push(b);
    });
    return byHap;
}

// With blocks:true the server sends blocks instead of intervals, but the
// result cards still want intervals.  Collapse each contig's blocks back into
// the span they cover, which is what the intervals view reports anyway.
function blocksAsIntervals(blocks) {
    var byKey = Object.create(null), order = [];
    (blocks || []).forEach(function (b) {
        var key = b.haplotype + "\t" + (b.strand || "+");
        var iv = byKey[key];
        if (!iv) {
            iv = byKey[key] = { haplotype: b.haplotype, strand: b.strand || "+",
                                start: b.target_start, end: b.target_end,
                                srcStart: b.source_start, srcEnd: b.source_end,
                                mapped: b.target_end - b.target_start, pieces: 1 };
            order.push(iv);
            return;
        }
        if (b.target_start < iv.start) iv.start = b.target_start;
        if (b.target_end > iv.end) iv.end = b.target_end;
        if (b.source_start < iv.srcStart) iv.srcStart = b.source_start;
        if (b.source_end > iv.srcEnd) iv.srcEnd = b.source_end;
        iv.mapped += b.target_end - b.target_start;
        iv.pieces += 1;
    });
    return order;
}

// The source path plus coordinates, or {error}.  Shared by the conversion and
// the "which haplotypes contain this?" query.
function buildSource() {
    var hap = currentSourceHap();
    if (!hap) return { error: "No pangenome assembly for that source." };
    if (!hapInGraph(hap))
        return { error: "Haplotype " + hap + " is not in the loaded graph, so its " +
                        "coordinates cannot be translated." };
    hap = canonicalHap(hap);          // the graph's own spelling
    var pos = parsePosition($("pgcPos").value);
    if (pos.error) return { error: pos.error };
    var bad = contigProblem(pos.contig);
    if (bad) return { error: bad };
    // Send the graph the only name it knows, whichever one was typed.
    var contig = nativeContig(pos.contig);
    return { src: hap + "#" + contig, contig: contig,
             start: pos.start, end: pos.end };
}

function doConvert() {
    var src = buildSource();
    if (src.error) { showError(src.error); return; }
    var pos = { contig: src.contig, start: src.start, end: src.end };

    var targets = selectedTargets();
    if (targets.length === 0) { showError("Choose at least one target assembly."); return; }

    // Send the graph's spelling for targets too: an unknown target is not an
    // error upstream, it just yields no intervals - which would look like
    // "region absent" rather than a mistake.
    targets = targets.map(canonicalHap);
    lastRequest = { src: src.src, start: src.start, end: src.end,
                    tgt: targets.length === 1 ? targets[0] : targets };
    // The block-level answer is what a chain is made of, so only ask for it
    // when the annotations are actually wanted.
    var wantAnnotations = quickLiftWanted();
    // Always ask for blocks, not just when lifting annotations: the collapsed
    // interval is only the outer span, and without the blocks inside it there
    // is no way to say how much of the region actually carried over.
    lastRequest.blocks = true;

    clear($("pgcResults"));
    var what = fmtPos(pos.contig, pos.start, pos.end);
    showBusy("Translating " + what + " to " + targets.length + " assembl" +
             (targets.length === 1 ? "y" : "ies") + "…");
    wideRegionWarning = (src.end - src.start) >= WIDE_REGION_BP;
    var seq = ++convertSeq;

    liftInBatches(lastRequest, targets, function (done) {
        if (seq === convertSeq && targets.length > done)
            showBusy("Translating " + what + ": " + done + " of " + targets.length +
                     " assemblies done…");
    }).then(function (resp) {
        if (seq !== convertSeq) return;            // a newer conversion owns the page
        if (resp.failed.length === targets.length)
            throw new Error(resp.errors[0] || "server error");
        lastBlocks = wantAnnotations ? groupBlocks(resp.blocks) : null;
        lastSource = src;          // the percentages are measured against it
        renderResults(hapLabel(src.src) + ":" + (pos.start + 1) + "-" + pos.end,
                      targets, resp.intervals.concat(blocksAsIntervals(resp.blocks)),
                      resp.failed, resp.errors);
        hideStatus();
    }).catch(function (err) {
        if (seq !== convertSeq) return;
        showError("Conversion failed: " + err.message, doConvert);
    });
}

// ---- Many targets ------------------------------------------------------------
//
// There is no limit on how many assemblies a region is converted to.  The work
// upstream is one graph traversal per target, so a long list goes as several
// requests of at most MAX_TARGETS targets each - fewer for a long region, so
// that span x targets stays inside the server's per-request budget - two at a
// time.  The CGI queues requests to the graph server (pangenome.maxConcurrent),
// so one reader's 463 targets and another reader's one are served in turn
// rather than the first blocking the second.

var convertSeq = 0;

// The targets one request may carry for a region of this many bases.
function batchSize(span) {
    var byBudget = Math.floor(BUDGET_MB * 1000000 / Math.max(1, span));
    return Math.max(1, Math.min(MAX_TARGETS, byBudget));
}

// One translation, as several requests when the list is long.  Resolves to
// { intervals, blocks, failed: [targets], errors: [messages] }; a failed
// request is tried once more before its targets are given up on.
function liftInBatches(request, targets, progress) {
    var per = batchSize(request.end - request.start);
    var batches = [];
    for (var i = 0; i < targets.length; i += per) batches.push(targets.slice(i, i + per));
    var out = { intervals: [], blocks: [], failed: [], errors: [] };
    var next = 0, done = 0;
    var one = function (batch) {
        var req = {};
        Object.keys(request).forEach(function (k) { req[k] = request[k]; });
        req.tgt = batch.length === 1 ? batch[0] : batch;
        var ask = function () {
            return postCmd("liftover", req).then(function (resp) {
                if (resp && resp.status === "error") throw new Error(resp.error || "server error");
                return resp || {};
            });
        };
        return ask().catch(function () { return ask(); }).then(function (resp) {
            out.intervals = out.intervals.concat(resp.intervals || []);
            out.blocks = out.blocks.concat(resp.blocks || []);
        }, function (err) {
            out.failed = out.failed.concat(batch);
            if (out.errors.indexOf(err.message) < 0) out.errors.push(err.message);
        }).then(function () {
            done += batch.length;
            if (progress) progress(done);
        });
    };
    var lane = function () {
        if (next >= batches.length) return Promise.resolve();
        return one(batches[next++]).then(lane);
    };
    var lanes = [];
    for (var k = 0; k < Math.min(2, batches.length); k++) lanes.push(lane());
    return Promise.all(lanes).then(function () { return out; });
}

function onClear() {
    $("pgcPos").value = "";
    $("pgcFilter").value = "";
    popFilter = null;
    reachable = null;
    reachableScored = false;
    reachableCache = null;
    reachableCacheScored = false;
    if ($("pgcReachableOnly")) { $("pgcReachableOnly").checked = false; }
    fillTargets("");
    clear($("pgcResults"));
    hideStatus();
}

// ---- Init -------------------------------------------------------------------

function init() {
    if (!$("pgcResults")) return;              // not this page
    CFG = window.pangenomeConfig || {};
    if (CFG.maxLiftSpan) MAX_SPAN = CFG.maxLiftSpan;
    if (typeof CFG.wideRegionBp === "number") WIDE_REGION_BP = CFG.wideRegionBp;
    if (typeof CFG.maxLiftTargets === "number" && CFG.maxLiftTargets > 0) MAX_TARGETS = CFG.maxLiftTargets;
    if (typeof CFG.maxLiftTargetMb === "number" && CFG.maxLiftTargetMb > 0) BUDGET_MB = CFG.maxLiftTargetMb;

    // Options carried over from hgConvert: the user set them there, so honour
    // them rather than resetting to this page's defaults.
    if (CFG.presetAnnot && $("pgcQuickLift"))
        $("pgcQuickLift").checked = (CFG.presetAnnot === "on");
    if (CFG.presetHide && $("pgcHideTracks"))
        $("pgcHideTracks").checked = (CFG.presetHide === "on");

    var fallback = applySourceFallback();
    sourceIsExample = !!(fallback && fallback.tookPosition);
    describeSource(fallback);
    $("pgcSubmit").addEventListener("click", doConvert);
    $("pgcClear").addEventListener("click", onClear);
    $("pgcFilter").addEventListener("input", function () {
        fillTargets($("pgcFilter").value);
    });
    // No listener on the source: it is not a control any more.  onSourceChange
    // still runs once, from fillSources, to set up everything derived from it.
    // Ticking Annotations asks the question for the first time; unticking it
    // makes the answer irrelevant.
    if ($("pgcQuickLift")) {
        $("pgcQuickLift").addEventListener("change", checkLiftable);
    }
    $("pgcTargets").addEventListener("change", function () {
        fillTargets($("pgcFilter").value);      // refresh the "N selected" line
    });
    $("pgcReachableOnly").addEventListener("change", onReachableToggle);
    // The picker's three parts answer for themselves: a population on the
    // left shows its haplotypes, a box on the right chooses one, and a chip's
    // cross lets one go.
    if ($("pgcPops")) {
        $("pgcPops").addEventListener("click", function (ev) {
            var b = ev.target && ev.target.closest ? ev.target.closest("[data-pop]") : null;
            if (!b) return;
            popFilter = b.getAttribute("data-pop") || null;
            fillTargets($("pgcFilter").value);
        });
    }
    if ($("pgcHaps")) {
        $("pgcHaps").addEventListener("click", function (ev) {
            var b = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-all");
            if (!b) return;
            var on = (b === "on");
            var boxes = ev.currentTarget.querySelectorAll ?
                ev.currentTarget.querySelectorAll("input[data-hap]") : [];
            var want = Object.create(null);
            Array.prototype.forEach.call(boxes, function (x) { want[x.getAttribute("data-hap")] = true; });
            targetOptions($("pgcTargets")).forEach(function (o) {
                if (want[o.value]) o.selected = on;
            });
            fillTargets($("pgcFilter").value);
        });
        $("pgcHaps").addEventListener("change", function (ev) {
            var hap = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-hap");
            if (hap) setChosen(hap, ev.target.checked);
        });
    }
    if ($("pgcChosen")) {
        $("pgcChosen").addEventListener("click", function (ev) {
            var hap = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-unchoose");
            if (hap) setChosen(hap, false);
        });
    }

    loadHaplotypes();
    // Ask on the way in as well as on a change: arriving here from a browser
    // page whose tracks were hidden is exactly the case worth warning about,
    // and the source has not changed at that point.
    checkLiftable();
}

if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
else
    init();

// Test hook; a no-op in the browser (see hgPangenome/tests/).
if (typeof module !== "undefined" && module.exports)
    module.exports = {
        parsePosition: parsePosition,
        batchSize: batchSize,
        liftInBatches: liftInBatches,
        canonicalHap: canonicalHap,
        hapInGraph: hapInGraph,
        buildSource: buildSource,
        fillSources: fillSources,
        contigProblem: contigProblem,
        nativeContig: nativeContig,
        applyContigs: applyContigs,
        contigsForSource: function () { return contigsForSource; },
        showSourceLabel: showSourceLabel,
        showReachable: showReachable,
        applySourceFallback: applySourceFallback,
        preselectDefaultTarget: preselectDefaultTarget,
        fmtPos: fmtPos,
        hapForDb: hapForDb,
        assemblyForHap: assemblyForHap,
        browserLinkFor: browserLinkFor,
        renderResults: renderResults,
        groupBlocks: groupBlocks,
        blocksAsIntervals: blocksAsIntervals,
        ancClusterName: ancClusterName,
        ancSummary: ancSummary,
        ancText: ancText,
        ancNone: ancNone,
        samplePop: samplePop,
        popGroupOf: popGroupOf,
        popGroups: popGroups,
        targetOptions: targetOptions,
        selectedTargets: selectedTargets,
        fillTargets: fillTargets,
        setPopFilter: function (k) { popFilter = k; },
        setChosen: setChosen,
        init: init
    };

}());
