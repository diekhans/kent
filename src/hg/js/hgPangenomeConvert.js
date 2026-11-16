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
/* global window, document, fetch, Promise, pgpInit, pgpOpen */

(function () {
'use strict';

var CFG = {};
var MAX_SPAN = 1000000;         // the server's cap (pangenome.maxLiftSpan), which it enforces too
var MAX_CHOSEN = 50;           // haplotypes one conversion may be sent to; 0 for no limit

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

// How many more haplotypes may be chosen.  Past MAX_CHOSEN the answer is a
// question about every haplotype, which "View all haplotypes" is for.
function chosenRoom(chosenCount) {
    return MAX_CHOSEN > 0 ? Math.max(0, MAX_CHOSEN - chosenCount) : Infinity;
}

// Choose or let go of one haplotype, then draw the picker again.
function setChosen(hap, on) {
    if (on && chosenRoom(selectedTargets().length) < 1) on = false;
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
        chosen.length ? "Chosen " + chosen.length + (MAX_CHOSEN > 0 ? " of " + MAX_CHOSEN : "")
                      : (MAX_CHOSEN > 0 ? "Choose up to " + MAX_CHOSEN + " below" : "Choose below") }));
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
    // Every one listed here, or none of them, in one click - or, when there
    // is not room for them all, as many from the top of the list as there is
    // room for.
    var allOn = shown.length > 0 && shown.every(function (h) { return chosenSet[h.toLowerCase()]; });
    var room = chosenRoom(Object.keys(chosenSet).length);
    var unchosen = shown.filter(function (h) { return !chosenSet[h.toLowerCase()]; }).length;
    var allText = allOn ? "Clear these"
                : unchosen <= room ? "Choose all " + shown.length
                : room > 0 ? "Choose first " + room : null;
    box.appendChild(el("div", { class: "pgcPaneHead" }, [
        el("span", { text: title }),
        el("span", { class: "pgcPaneN", text: shown.length + (shown.length === 1 ? " haplotype" : " haplotypes") +
            (reachableScored ? ", best first" : "") }),
        (shown.length && allText) ? el("button", { type: "button", class: "pgcAllBtn",
                                                   "data-all": allOn ? "off" : "on", text: allText }) : null
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
        if (!on && room < 1) {
            box2.disabled = true;
            box2.title = MAX_CHOSEN + " is the most. Remove one to choose another.";
        }
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

    // One short line under the picker, and only when the list was narrowed:
    // the pane's own heading counts what it shows.
    $("pgcTargetCount").textContent = reachable
        ? candidates.length + " of " + allHaplotypes.length + " haplotypes have this region" : "";
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
            // Retry asks again; going through the toggle would not, the box
            // having just been unticked.
            showError("Could not check which assemblies contain this region: " +
                      err.message, function () {
                          if ($("pgcReachableOnly")) { $("pgcReachableOnly").checked = true; }
                          showReachable();
                      });
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
    if (allSrcHap) return allSrcHap;
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

// ---- Ancestry plot (pcLAI) -------------------------------------------------
//
// The mapping results page's plot, of where each region sits in pcLAI's
// reference space, with the source ringed.  As on that page there are no
// ancestry labels or colours in the table: pcLAI gives a position, not a name,
// and the plot is the place to read it.  Nothing is read until the plot is
// opened; the plot reads its own points then, a hundred regions a request.

function ancOn() {
    return typeof pangenomePclai !== "undefined" && !!pangenomePclai;
}

// Put a "Show ancestry plot" button in `acts` and hand the plot one spot per
// region that has pcLAI - an HPRC assembly - when there are at least two.
// `asks` is one {role, hap, db, contig, start, end, url, anchor} per region.
function ancPlot(acts, asks) {
    if (!ancOn() || typeof pgpInit !== "function") return null;
    var plotted = asks.filter(function (a) { return a.db && /^GC[AF]_/.test(a.db); });
    if (plotted.length < 2) return null;
    var spots = plotted.map(function (a, i) {
        a.id = "a" + i;
        return { id: a.id, hap: a.hap, acc: a.db, contig: a.contig, start: a.start, end: a.end,
                 coverage: null, placement: 0, placements: 1, url: a.url,
                 openId: a.anchor ? a.id : null,
                 info: [["Assembly", a.db], ["Region", fmtPos(a.contig, a.start, a.end)],
                        ["Role", a.role === "source" ? "the source of this conversion"
                                                     : "a target of this conversion"]] };
    });
    plotted.forEach(function (a) {
        if (a.role === "source") pgpPicked[a.hap] = true;
    });
    acts.appendChild(el("button", { type: "button", class: "gbPill", id: "pgrPclaiBtn",
        title: "Where these regions sit in the pcLAI reference space", text: "Show ancestry plot" }));
    pgpInit(spots, { legend: { hit: "a region", pick: "the source", many: "regions" } });
    return spots;
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

function pctText(v) { return v == null ? "" : v.toFixed(1) + "%"; }

// Pages and sorting, as on the mapping results page, when DataTables is on the
// page; without it the table is simply all there.
function pgcPageTable(table, order) {
    var jq = window.jQuery;
    if (!jq || !jq.fn || !jq.fn.dataTable) return null;
    var len = 50;
    try {
        var v = parseInt(window.localStorage.getItem("hgPangenome.pageLen"), 10);
        if (v === -1 || v === 25 || v === 50 || v === 100) len = v;
    } catch (e) { /* the default */ }
    var dt = jq(table).DataTable({
        // Widths from the content, not pinned to what the first draw measured:
        // the loci, the coverage bars and the ancestry arrive after it.
        autoWidth: false,
        paging: true,
        pageLength: len,
        lengthMenu: [[25, 50, 100, -1], [25, 50, 100, "All"]],
        pagingType: "simple_numbers",
        dom: '<"pgrPageBar"lfip>rt<"pgrPageBar"ip>',
        order: order || [],
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
    return dt;
}

// Offer to carry the source's own gene tracks over to this target.  The chain
// is built from the blocks we already have, so this costs the mapping server
// nothing further.
// Both sides are assemblies this server opens, so QuickLift can draw one's
// tracks on the other.
function annotationsPossible(iv) {
    var parts = String(iv.haplotype || "").split("#");
    if (parts.length < 2 || !lastSource) return false;
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
        if (!quickLiftWanted()) return;       // unticked since: the plain position
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

var lastSource = null;         // the source of the results on the page

function quickLiftWanted() {
    var box = $("pgcQuickLift");
    return !!(box && box.checked);
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

// One request, whatever the number of targets: the service's summary mode
// walks the source region once and answers for every haplotype asked for, so
// fifty cost about what one does.  The answer is the all-haplotypes page's,
// for the chosen few, and is drawn by the same code (renderAll).
var convertSeq = 0;            // the conversion the page is waiting for

function doConvert() {
    var src = buildSource();
    if (src.error) { showError(src.error); return; }

    var targets = selectedTargets();
    if (targets.length === 0) { showError("Choose at least one target assembly."); return; }
    if (MAX_CHOSEN > 0 && targets.length > MAX_CHOSEN) {
        showError("Choose at most " + MAX_CHOSEN + " haplotypes, or use View all haplotypes.");
        return;
    }
    // Send the graph's spelling for targets too: an unknown target is not an
    // error upstream, it just yields nothing - which would look like "region
    // absent" rather than a mistake.
    targets = targets.map(canonicalHap);

    clear($("pgcResults"));
    var what = fmtPos(src.contig, src.start, src.end);
    showBusy("Translating " + what + " to " + targets.length + " assembl" +
             (targets.length === 1 ? "y" : "ies") + "…");
    // A later click, or Clear, owns the page from then on: an answer to an
    // earlier one is dropped when it arrives.
    var seq = ++convertSeq;
    postCmd("liftoverAll", { src: src.src, start: src.start, end: src.end, tgt: targets })
        .then(function (resp) {
            if (seq !== convertSeq) return;
            if (!resp || resp.status === "error") throw new Error((resp && resp.error) || "no answer");
            if (!resp.summary) throw new Error("the graph server sent no summary");
            lastSource = src;          // what the links carry annotations over from
            allSrcHap = String(src.src).split("#").slice(0, 2).join("#");
            hideStatus();
            renderAll(resp, src, targets);
        }).catch(function (err) {
            if (seq !== convertSeq) return;
            showError("Conversion failed: " + err.message, doConvert);
        });
}

// Start the choice over: no targets, no search, every population, and no
// results.  The source stays - it came from the browser and is not a control
// on this page, so emptying it left every later conversion with nothing to
// convert.  The reachability answer is kept too, since it depends only on the
// source.
function onClear() {
    $("pgcFilter").value = "";
    popFilter = null;
    reachable = null;
    reachableScored = false;
    if ($("pgcReachableOnly")) { $("pgcReachableOnly").checked = false; }
    targetOptions($("pgcTargets")).forEach(function (o) { o.selected = false; });
    fillTargets("");
    convertSeq++;               // a conversion still out is not to draw into the cleared page
    clear($("pgcResults"));
    hideStatus();
}

// ---- Every haplotype (page=liftAll) -----------------------------------------
//
// The service's summary mode answers for the whole graph in one request: it
// walks the source region once and reports, for each haplotype, where the
// region lands - in one piece or several - and how many of its bases do.  At a
// tenth of a second for 100 kb that is cheap enough to offer anyone, so this
// page shows every haplotype: a few figures on how the region carries over
// across the pangenome, then the table, laid out as the main page's.
//
// The one costly part is pcLAI, which this web server reads: about a second per
// hundred regions.  So the ancestry column is read for the rows on screen as
// they are shown, and for every row only when the plot is opened.

var allSrcHap = null;          // the source haplotype, on that page
var allHaps = null;            // one per haplotype, as allHapsFrom() made them
var allRows = null;            // one per table row: {h, piece, n}
var allDt = null;              // the table's DataTable, when there is one
var allFilter = null;          // {label, test(h)} narrowing the table, or null
var ALL_WHOLE = 99;            // % of the region's bases that counts as all of it
var ALL_MERGED_MAX = 50;       // pieces past this, merged into one, make a size unclear
var allSearchHooked = false;   // our row filter is in DataTables' list

// The link to that page for a source {src, start, end}, carrying the two
// annotation choices so that its links open the way this page's would.
function liftAllUrl(src) {
    var url = selfUrl() + "?page=liftAll&src=" + encodeURIComponent(src.src) +
              "&start=" + src.start + "&end=" + src.end;
    if ($("pgcQuickLift")) url += "&pgAnnot=" + (quickLiftWanted() ? "on" : "off");
    if ($("pgcHideTracks")) url += "&pgHide=" + (hideTargetTracks() ? "on" : "off");
    if (CFG.hgsid) url += "&hgsid=" + encodeURIComponent(CFG.hgsid);
    return url;
}

function onShowAll() {
    var src = buildSource();
    if (src.error) { showError(src.error); return; }
    window.location = liftAllUrl(src);
}

// One entry per haplotype, its pieces largest first, as the mapping page
// numbers hits best first.  The source is left out: "*" names it too, so the
// service lists it, with nothing mapped.
//   bases    - coverage: % of the region's bases with a place on this haplotype
//   change   - the net size change inside the parts that carried over: each
//              piece's length here less the length of source it covers
//   inserted - bases here, inside those parts, that no source base is placed on
//   deleted  - source bases inside those parts with no place here
// inserted - deleted is the net change, so a gain and a loss of about the same
// size, which cancel in the net, still show in the two.
function allHapsFrom(summary, len) {
    var src = String(allSrcHap).toLowerCase();
    var haps = [];
    (summary || []).forEach(function (s) {
        if (String(s.haplotype).toLowerCase() === src) return;
        var pieces = mergePieces(s.pieces || []).sort(function (a, b) {
            return (b.source_end - b.source_start) - (a.source_end - a.source_start);
        });
        var change = 0, here = 0, contigs = Object.create(null), nContigs = 0;
        pieces.forEach(function (p) {
            change += (p.end - p.start) - (p.source_end - p.source_start);
            here += p.end - p.start;
            if (!contigs[p.contig]) { contigs[p.contig] = true; nContigs++; }
        });
        var mapped = s.mapped_bp || 0;
        var spanned = unionLength(pieces.map(function (p) { return [p.source_start, p.source_end]; }));
        // Hundreds of pieces merged into one: the service could not settle
        // where these bases go, and the span they add up to is not a length.
        var unsure = pieces.some(function (p) { return p.merged > ALL_MERGED_MAX; });
        haps.push({ hap: s.haplotype, pieces: pieces, mapped: mapped,
                    bases: len > 0 ? Math.min(100, 100 * mapped / len) : 0,
                    change: pieces.length && !unsure ? change : null,
                    inserted: pieces.length && !unsure ? Math.max(0, here - mapped) : null,
                    deleted: pieces.length && !unsure ? Math.max(0, spanned - mapped) : null,
                    unsure: unsure,
                    contigs: nContigs,
                    reverse: pieces.some(function (p) { return p.strand === "-"; }),
                    group: popGroupOf(s.haplotype) });
    });
    // Most of the region first, then by name, which keeps a sample's two
    // haplotypes together among equals.
    haps.sort(function (a, b) {
        return (b.bases - a.bases) || (a.hap < b.hap ? -1 : a.hap > b.hap ? 1 : 0);
    });
    return haps;
}

// The bases a list of [start, end) intervals covers, overlaps counted once: two
// pieces of a duplicated region can carry the same source bases.
function unionLength(ivs) {
    var sorted = ivs.slice().sort(function (a, b) { return a[0] - b[0]; });
    var total = 0, from = null, to = null;
    sorted.forEach(function (iv) {
        if (to === null || iv[0] > to) {
            if (to !== null) total += to - from;
            from = iv[0]; to = iv[1];
        } else if (iv[1] > to) {
            to = iv[1];
        }
    });
    return to === null ? total : total + to - from;
}

// Pieces on the same contig and strand whose places overlap are one place.
// In a duplicated or inverted region the service can report a haplotype as
// thousands of pieces, most of them a single source base landing on the same
// stretch as the others; listed as they come, that is thousands of rows that
// all open the same place.
function mergePieces(pieces) {
    var sorted = pieces.slice().sort(function (a, b) {
        return a.contig < b.contig ? -1 : a.contig > b.contig ? 1 :
               a.strand < b.strand ? -1 : a.strand > b.strand ? 1 : a.start - b.start;
    });
    var out = [];
    sorted.forEach(function (p) {
        var cur = out[out.length - 1];
        if (cur && cur.contig === p.contig && cur.strand === p.strand && p.start < cur.end) {
            cur.end = Math.max(cur.end, p.end);
            cur.source_start = Math.min(cur.source_start, p.source_start);
            cur.source_end = Math.max(cur.source_end, p.source_end);
            cur.merged++;
            return;
        }
        out.push({ contig: p.contig, start: p.start, end: p.end, strand: p.strand,
                   source_start: p.source_start, source_end: p.source_end, merged: 1 });
    });
    return out;
}

function fmtChange(v) {
    if (v == null) return "";
    if (v === 0) return "0 bp";
    return (v > 0 ? "+" : "−") + withCommas(Math.abs(v)) + " bp";
}

function fmtBp(v) { return v == null ? "" : withCommas(v) + " bp"; }

// Axis labels: "-6 kb", "0", "+250 bp".
function fmtChangeShort(v) {
    if (v === 0) return "0";
    var a = Math.abs(v), sign = v > 0 ? "+" : "−";
    if (a >= 1000) return sign + (a / 1000).toFixed(a % 1000 ? 1 : 0).replace(/\.0$/, "") + " kb";
    return sign + a + " bp";
}

// 1, 2 or 5 times a power of ten, at least x.
function niceStep(x) {
    if (!(x > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(x) / Math.LN10));
    var m = x / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

function median(values) {
    if (!values.length) return null;
    var v = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

// What a table row can be filtered on.  Coverage, the inserted and deleted
// bases and the piece count belong to the haplotype, so every row of it has
// the same; span and size change are the row's own piece.
var ALL_METRICS = [
    { key: "coverage", label: "Coverage", unit: "%", get: function (r) { return r.h.bases; } },
    { key: "span", label: "Span", unit: "%", get: function (r) { return r.span; } },
    { key: "inserted", label: "Inserted", unit: "bp", get: function (r) { return r.h.inserted; } },
    { key: "deleted", label: "Deleted", unit: "bp", get: function (r) { return r.h.deleted; } },
    { key: "change", label: "Size change", unit: "bp", get: function (r) { return r.change; } },
    { key: "pieces", label: "Pieces", unit: "", get: function (r) { return r.h.pieces.length; } }
];
var allMetricFilters = [];     // {metric, op: "min"|"below", value}, all applied together

function metricKeeps(r) {
    return allMetricFilters.every(function (f) {
        var v = f.metric.get(r);
        if (v == null) return false;
        return f.op === "min" ? v >= f.value : v < f.value;
    });
}

function metricFilterText(f) {
    return f.metric.label + (f.op === "min" ? " at least " : " below ") +
           (f.metric.unit === "bp" ? withCommas(f.value) + " bp" : f.value + f.metric.unit);
}

// The row of controls that adds a filter, and the filters in force as chips.
function allMetricControls() {
    var key = el("select", { id: "pgcMfKey", "aria-label": "Filter on" });
    ALL_METRICS.forEach(function (m) { key.appendChild(el("option", { value: m.key, text: m.label })); });
    var op = el("select", { id: "pgcMfOp", "aria-label": "How" }, [
        el("option", { value: "min", text: "at least" }), el("option", { value: "below", text: "below" })]);
    var val = el("input", { id: "pgcMfVal", type: "number", value: "50", "aria-label": "Value" });
    var unit = el("span", { id: "pgcMfUnit", class: "pgcMfUnit", text: "%" });
    var add = el("button", { type: "button", class: "gbPill", id: "pgcMfAdd", text: "Add filter" });
    var chips = el("span", { id: "pgcMfChips", class: "pgcMfChips" });
    var metricOf = function () {
        return ALL_METRICS.filter(function (m) { return m.key === key.value; })[0];
    };
    key.addEventListener("change", function () { unit.textContent = metricOf().unit; });
    var go = function () {
        var v = parseFloat(val.value);
        if (isNaN(v)) { val.focus(); return; }
        allMetricFilters.push({ metric: metricOf(), op: op.value, value: v });
        drawMetricChips();
        applyAllFilters();
    };
    add.addEventListener("click", go);
    val.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); go(); } });
    chips.addEventListener("click", function (ev) {
        var i = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-mf");
        if (i === null || i === undefined) return;
        allMetricFilters.splice(+i, 1);
        drawMetricChips();
        applyAllFilters();
    });
    return el("div", { class: "pgcMf", id: "pgcMf" }, [
        el("label", { for: "pgcMfKey", class: "pgcMfLab", text: "Filter rows:" }),
        key, op, val, unit, add, chips]);
}

function drawMetricChips() {
    var chips = $("pgcMfChips");
    if (!chips) return;
    clear(chips);
    allMetricFilters.forEach(function (f, i) {
        chips.appendChild(el("span", { class: "pgcMfChip" }, [
            el("span", { text: metricFilterText(f) }),
            el("button", { type: "button", "data-mf": String(i), "aria-label": "Remove this filter",
                           title: "Remove this filter", text: "×" })]));
    });
}

// The figure's filter and the metric filters, together, on the table.
function applyAllFilters() {
    if (allDt) allDt.draw();
    else if (allRows)                       // no DataTables: hide the rows by hand
        allRows.forEach(function (r) {
            r.tr.hidden = !!(allFilter && !allFilter.test(r.h)) || !metricKeeps(r);
        });
}

// Narrow the table to the haplotypes a figure counts, or (null) widen it
// again.  The bar above the table says what it shows.
function setAllFilter(f) {
    allFilter = f;
    var bar = $("pgcAllBar");
    if (bar) {
        clear(bar);
        bar.hidden = !f;
        if (f) {
            var n = allHaps.filter(f.test).length;
            bar.appendChild(el("span", { text: "Showing the " + withCommas(n) + " haplotype" +
                                               (n === 1 ? "" : "s") + " " + f.label + "." }));
            var b = el("button", { type: "button", class: "gbPill", text: "Show all" });
            b.addEventListener("click", function () { setAllFilter(null); });
            bar.appendChild(b);
        }
    }
    applyAllFilters();
}

// A figure that narrows the table when clicked.
function filterLink(node, label, test) {
    node.classList.add("pgcPick2");
    node.setAttribute("tabindex", "0");
    node.setAttribute("role", "button");
    node.setAttribute("title", "List these haplotypes in the table");
    var go = function () { setAllFilter({ label: label, test: test }); };
    node.addEventListener("click", go);
    node.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
    return node;
}

// How much of the region each haplotype has, and in what shape.
function allCoveragePanel(haps) {
    var bins = [
        { label: "99–100%", test: function (h) { return h.pieces.length && h.bases >= ALL_WHOLE; },
          says: "with 99% or more of the region" },
        { label: "90–99%", test: function (h) { return h.pieces.length && h.bases >= 90 && h.bases < ALL_WHOLE; },
          says: "with 90 to 99% of the region" },
        { label: "50–90%", test: function (h) { return h.pieces.length && h.bases >= 50 && h.bases < 90; },
          says: "with 50 to 90% of the region" },
        { label: "Under 50%", test: function (h) { return h.pieces.length && h.bases < 50; },
          says: "with less than half of the region" },
        { label: "Not found", test: function (h) { return !h.pieces.length; },
          says: "the region does not reach", none: true }
    ];
    var most = 1;
    bins.forEach(function (b) { b.n = haps.filter(b.test).length; most = Math.max(most, b.n); });
    var list = el("div", { class: "pgcBars" });
    bins.forEach(function (b) {
        var fill = el("span", { class: "pgcBarFill" + (b.none ? " none" : "") });
        fill.style.width = (100 * b.n / most).toFixed(1) + "%";
        var row = el("div", { class: "pgcBarRow" }, [
            el("span", { class: "pgcBarK", text: b.label }),
            el("span", { class: "pgcBarTrack" }, [fill]),
            el("span", { class: "pgcBarV", text: withCommas(b.n) +
                         (haps.length ? " (" + Math.round(100 * b.n / haps.length) + "%)" : "") })
        ]);
        list.appendChild(b.n ? filterLink(row, b.says, b.test) : row);
    });
    var shapes = [
        ["In one piece", "in one piece", function (h) { return h.pieces.length === 1; }],
        ["In two or more pieces", "where it is in two or more pieces", function (h) { return h.pieces.length > 1; }],
        ["On two or more contigs", "where it is on two or more contigs", function (h) { return h.contigs > 1; }],
        ["Reversed, all or part", "where all or part of it is on the reverse strand", function (h) { return h.reverse; }]
    ];
    var grid = el("div", { class: "pgcShapes" });
    shapes.forEach(function (s) {
        var n = haps.filter(s[2]).length;
        var cell = el("div", { class: "pgcShape" }, [el("span", { class: "v", text: withCommas(n) }),
                                                     el("span", { class: "k", text: s[0] })]);
        grid.appendChild(n ? filterLink(cell, s[1], s[2]) : cell);
    });
    return el("div", { class: "pgcStatPanel" }, [
        el("h3", { text: "Coverage" }), list, grid]);
}

// Bases inserted and deleted where the region carried over, each as its own
// histogram, so that opposite changes are not netted away; then the net change,
// whose exact sizes are worth listing - an indel is the same length on
// everyone who carries it.
var ALL_SIZE_KINDS = [
    { key: "inserted", title: "Inserted", get: function (h) { return h.inserted; },
      says: "inserted", fmt: fmtBp },
    { key: "deleted", title: "Deleted", get: function (h) { return h.deleted; },
      says: "deleted", fmt: fmtBp }
];

function allSizePanel(haps) {
    var found = haps.filter(function (h) { return h.change != null; });
    var unsure = haps.filter(function (h) { return h.unsure; });
    var panel = el("div", { class: "pgcStatPanel" }, [el("h3", { text: "Insertions and deletions" })]);
    if (unsure.length)
        panel.appendChild(filterLink(el("p", { class: "pgcStatText pgcUnsure",
            text: withCommas(unsure.length) + " haplotype" + (unsure.length === 1 ? " is" : "s are") +
                  " left out: the graph server could not settle where this region goes on " +
                  (unsure.length === 1 ? "it" : "them") + "." }),
            "whose size change is unclear", function (h) { return h.unsure; }));
    if (!found.length) {
        panel.appendChild(el("p", { class: "pgMuted", text: "The region carried over to no haplotype." }));
        return panel;
    }
    ALL_SIZE_KINDS.forEach(function (k) {
        var vals = found.map(k.get);
        var hi = Math.max.apply(null, vals);
        var head = el("div", { class: "pgcSizeHead" }, [el("b", { text: k.title }),
            el("span", { text: hi === 0 ? "none on any haplotype"
                                        : "median " + k.fmt(median(vals)) + ", up to " + k.fmt(hi) })]);
        panel.appendChild(head);
        if (hi > 0) panel.appendChild(allHistogram(vals, 0, hi, k));
    });

    var vals = found.map(function (h) { return h.change; });
    var bySize = Object.create(null), sizes = [];
    vals.forEach(function (v) {
        if (!(v in bySize)) { bySize[v] = 0; sizes.push(v); }
        bySize[v]++;
    });
    sizes.sort(function (a, b) { return bySize[b] - bySize[a] || Math.abs(a) - Math.abs(b); });
    var common = sizes.filter(function (v) { return bySize[v] > 1; }).slice(0, 4);
    var line = el("div", { class: "pgcStatText" }, [
        el("b", { text: "Net change" }),
        el("span", { text: ": median " + fmtChange(median(vals)) + (common.length ? "; most common " : ".") })]);
    common.forEach(function (v, i) {
        if (i) line.appendChild(document.createTextNode(" · "));
        line.appendChild(filterLink(el("span", { text: fmtChange(v) + " on " + withCommas(bySize[v]) }),
            "with a net size change of " + fmtChange(v),
            function (h) { return h.change === v; }));
    });
    panel.appendChild(line);
    return panel;
}

var SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, text) {
    var e = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
}

// One histogram of a haplotype figure, kind being one of ALL_SIZE_KINDS.  A
// bar narrows the table to the haplotypes it counts.
function allHistogram(vals, lo, hi, kind) {
    var step = Math.max(1, niceStep((hi - lo) / 30));     // whole bases
    var first = Math.floor(lo / step) * step;
    var nBins = Math.floor((hi - first) / step) + 1;
    var counts = [];
    for (var i = 0; i < nBins; i++) counts.push(0);
    vals.forEach(function (v) { counts[Math.min(nBins - 1, Math.floor((v - first) / step))]++; });
    var most = Math.max.apply(null, counts);
    var W = 420, H = 104, L = 34, R = 12, T = 6, B = 24;
    var x = function (v) { return L + (W - L - R) * (v - first) / (nBins * step); };
    var y = function (n) { return T + (H - T - B) * (1 - n / most); };
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "pgcHist", role: "img",
        "aria-label": "Histogram of the bases " + kind.says + " on each haplotype, from " +
                      kind.fmt(lo) + " to " + kind.fmt(hi) });
    // The count axis: its top and the baseline.
    svg.appendChild(svgEl("line", { x1: L, x2: W - R, y1: y(most), y2: y(most), class: "grid" }));
    svg.appendChild(svgEl("text", { x: L - 5, y: y(most) + 4, "text-anchor": "end", class: "tick" },
                          withCommas(most)));
    svg.appendChild(svgEl("text", { x: L - 5, y: y(0) + 4, "text-anchor": "end", class: "tick" }, "0"));
    var tickStep = niceStep((nBins * step) / 5);
    for (var t = Math.ceil(first / tickStep) * tickStep; t <= first + nBins * step; t += tickStep) {
        svg.appendChild(svgEl("line", { x1: x(t), x2: x(t), y1: y(0), y2: y(0) + 4, class: "axis" }));
        svg.appendChild(svgEl("text", { x: x(t), y: H - 8, "text-anchor": "middle", class: "tick" },
                              fmtChangeShort(t).replace(/^\+/, "")));
    }
    var barW = (W - L - R) / nBins;
    counts.forEach(function (n, i) {
        if (!n) return;
        var a = first + i * step, b = a + step;
        // At least 2 px tall, or a bar of one haplotype among four hundred vanishes.
        var top = Math.min(y(n), y(0) - 2);
        var g = svgEl("g", { class: "bar", tabindex: "0", role: "button" });
        g.appendChild(svgEl("rect", { x: x(a) + 0.5, y: top, width: Math.max(1, barW - 1),
                                      height: y(0) - top }));
        // A wider target than the bar, so the thin ones can be hovered.
        g.appendChild(svgEl("rect", { x: x(a), y: T, width: barW, height: y(0) - T, class: "hit" }));
        var range = step === 1 ? kind.fmt(a) : withCommas(a) + " to " + kind.fmt(b - 1);
        g.appendChild(svgEl("title", null, range + ": " + withCommas(n) + " haplotype" +
                                           (n === 1 ? "" : "s") + ". Click to list them."));
        var go = function () {
            setAllFilter({ label: "with " + range + " " + kind.says,
                           test: function (h) { var v = kind.get(h); return v != null && v >= a && v < b; } });
        };
        g.addEventListener("click", go);
        g.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
        });
        svg.appendChild(g);
    });
    svg.appendChild(svgEl("line", { x1: L, x2: W - R, y1: y(0), y2: y(0), class: "axis" }));
    return el("div", { class: "pgcHistWrap" }, [svg]);
}

// How many haplotypes of each population there are, and how the region fares
// on them.  The populations are the HPRC's own description of each sample, as
// in the table; nothing is grouped above them.  A header sorts by its column.
function allPopPanel(haps) {
    var groups = Object.create(null), order = [];
    haps.forEach(function (h) {
        var g = h.group;
        if (!groups[g.key]) { groups[g.key] = { g: g, haps: [] }; order.push(g.key); }
        groups[g.key].haps.push(h);
    });
    var rows = order.map(function (k) {
        var hs = groups[k].haps;
        var found = hs.filter(function (h) { return h.pieces.length; });
        var sized = found.filter(function (h) { return h.change != null; });
        return { key: k, g: groups[k].g, n: hs.length, found: found.length,
                 ins: median(sized.map(function (h) { return h.inserted; })),
                 del: median(sized.map(function (h) { return h.deleted; })),
                 net: median(sized.map(function (h) { return h.change; })) };
    });
    var cols = [
        { k: "name", text: "Population", cls: "" },
        { k: "n", text: "Haps", cls: "num", title: "Haplotypes from this population" },
        { k: "found", text: "Found", cls: "num", title: "Haplotypes the region carried over to" },
        { k: "ins", text: "Inserted", cls: "num", title: "Median bases inserted, where it carried over" },
        { k: "del", text: "Deleted", cls: "num", title: "Median bases deleted, where it carried over" },
        { k: "net", text: "Net", cls: "num", title: "Median net size change, where it carried over" }
    ];
    var sortBy = "name", desc = false;
    var tbody = el("tbody");
    var byName = function (a, b) {
        return (a.g.rank - b.g.rank) || (a.g.label < b.g.label ? -1 : a.g.label > b.g.label ? 1 : 0);
    };
    var fill = function () {
        clear(tbody);
        rows.slice().sort(function (a, b) {
            if (sortBy === "name") return desc ? byName(b, a) : byName(a, b);
            var x = a[sortBy], y = b[sortBy];
            if (x == null || y == null) return (x == null) - (y == null);
            return (desc ? y - x : x - y) || byName(a, b);
        }).forEach(function (r) {
            var tr = el("tr", null, [
                el("td", { class: "pgcPopName", text: r.g.label }),
                el("td", { class: "num", text: withCommas(r.n) }),
                el("td", { class: "num", text: withCommas(r.found) }),
                el("td", { class: "num", text: fmtBp(r.ins) }),
                el("td", { class: "num", text: fmtBp(r.del) }),
                el("td", { class: "num", text: r.net == null ? "" : fmtChange(r.net) })
            ]);
            tbody.appendChild(filterLink(tr, "from " + (r.key.charAt(0) === "~" ? "the " : "") +
                                             r.g.label.replace(/^Reference assemblies$/, "reference assemblies"),
                function (h) { return h.group.key === r.key; }));
        });
    };
    var headRow = el("tr");
    cols.forEach(function (c) {
        var th = el("th", c.title ? { class: c.cls, title: c.title } : { class: c.cls });
        var b = el("button", { type: "button", class: "pgcSortBtn", text: c.text });
        b.addEventListener("click", function () {
            // Names read A to Z first; figures largest first.
            if (sortBy === c.k) desc = !desc;
            else { sortBy = c.k; desc = c.k !== "name"; }
            Array.prototype.forEach.call(headRow.querySelectorAll("th"), function (x) {
                x.removeAttribute("aria-sort"); });
            th.setAttribute("aria-sort", desc ? "descending" : "ascending");
            fill();
        });
        th.appendChild(b);
        headRow.appendChild(th);
    });
    headRow.firstChild.setAttribute("aria-sort", "ascending");
    fill();
    var table = el("table", { class: "pgcPopTable" }, [el("thead", null, [headRow]), tbody]);
    return el("div", { class: "pgcStatPanel pgcPopPanel" }, [
        el("h3", { text: "By population" }), el("div", { class: "pgcPopScroll" }, [table])]);
}

function allTsv(rows, len) {
    var head = ["sample", "haplotype", "population", "piece", "pieces", "assembly", "contig",
                "start", "end", "strand", "coverage_pct", "span_pct", "inserted_bp", "deleted_bp",
                "size_change_bp", "mapped_bp", "source_start", "source_end"];
    var clean = function (v) {
        return String(v === undefined || v === null ? "" : v).replace(/[\t\r\n]/g, " ");
    };
    return head.join("\t") + "\n" + rows.map(function (r) {
        var h = r.h, p = r.piece, info = prettyHap(h.hap), pop = samplePop(h.hap);
        return [info.sample, info.phase, pop ? pop.desc + " (" + pop.code + ")" : "",
                p ? r.i + 1 : "", h.pieces.length, assemblyForHap(h.hap) || "",
                p ? p.contig : "", p ? p.start + 1 : "", p ? p.end : "", p ? p.strand : "",
                h.bases.toFixed(1),
                p && len ? (100 * (p.source_end - p.source_start) / len).toFixed(1) : "",
                h.inserted, h.deleted,
                p ? (p.end - p.start) - (p.source_end - p.source_start) : "",
                h.mapped, p ? p.source_start + 1 : "", p ? p.source_end : ""].map(clean).join("\t");
    }).join("\n") + "\n";
}

function saveFile(text, fileName, mime) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 0);
}

// The annotation choices, as stats in the strip, as the mapping results page
// has its "Annotations from".
function allAnnotControl() {
    if (!CFG.quickLiftEnabled) return null;
    var on = CFG.presetAnnot ? CFG.presetAnnot === "on" : CFG.quickLift !== false;
    var hide = CFG.presetHide ? CFG.presetHide === "on" : true;
    var lift = el("input", { type: "checkbox", id: "pgcQuickLift" });
    lift.checked = on;
    var hideBox = el("input", { type: "checkbox", id: "pgcHideTracks" });
    hideBox.checked = hide;
    var hideLabel = el("label", { for: "pgcHideTracks", title: "Hide all of the target " +
        "assembly default tracks, showing only the QuickLifted tracks" }, [hideBox, " Hide default tracks"]);
    var sync = function () { hideBox.disabled = !lift.checked; };
    lift.addEventListener("change", sync);
    sync();
    return el("div", { class: "gbStat pgcAnnotStat" }, [
        el("span", { class: "k", text: "Opening a haplotype" }),
        el("span", { class: "v" }, [
            el("label", { for: "pgcQuickLift", title: "Display tracks from the source " +
                          "assembly mapped onto the target assembly" }, [lift, " PanLift tracks"]),
            hideLabel])]);
}

// The table of where a region lands, one row a piece.  With "chosen", a list
// of haplotypes, it is PanLift's answer for those: each of them has a row,
// found or not, and the page's statistics and filters, which describe the
// whole pangenome, are left out.  Without, it is the all-haplotypes page.
function renderAll(resp, src, chosen) {
    var box = $("pgcResults");
    clear(box);
    var len = src.end - src.start;
    var haps = allHapsFrom(resp.summary, len);
    if (chosen) {
        // Matched without regard to case, and shown as the reader chose it:
        // the service's list of haplotypes and its answers are spelled apart.
        var asked = Object.create(null), have = Object.create(null);
        chosen.forEach(function (t) { asked[String(t).toLowerCase()] = t; });
        haps = haps.filter(function (h) { return asked[String(h.hap).toLowerCase()]; });
        haps.forEach(function (h) {
            have[String(h.hap).toLowerCase()] = true;
            h.hap = asked[String(h.hap).toLowerCase()];
        });
        // One the service did not answer for has no place here either.
        chosen.forEach(function (t) {
            if (have[String(t).toLowerCase()] || String(t).toLowerCase() === String(allSrcHap).toLowerCase()) return;
            haps.push({ hap: t, pieces: [], mapped: 0, bases: 0, change: null, inserted: null,
                        deleted: null, unsure: false, contigs: 0, reverse: false,
                        group: popGroupOf(t) });
        });
    }
    allHaps = haps;
    allFilter = null;
    var found = haps.filter(function (h) { return h.pieces.length; }).length;
    var srcLabel = hapLabel(src.src) + ":" + (src.start + 1) + "-" + src.end;

    var card = el("div", { class: "gbCard pgcCard" });
    box.appendChild(card);
    var stat = function (k, v) {
        return el("div", { class: "gbStat" }, [el("span", { class: "k", text: k }),
                                               el("span", { class: "v", text: v })]);
    };
    var div = function () { return el("span", { class: "gbDiv" }); };
    var sPop = samplePop(allSrcHap);
    var acts = el("span", { class: "gbStripActions", id: "pgcStripActs" });
    var strip = el("div", { class: "gbStrip" }, [
        stat("Converted from", srcLabel), div(),
        stat("Population", sPop ? sPop.desc + " (" + sPop.code + ")" : "—"), div(),
        stat("Length", withCommas(len) + " bp"), div(),
        stat(chosen ? "Targets" : "Haplotypes", withCommas(haps.length)), div(),
        stat("Found on", chosen ? withCommas(found) + " of " + withCommas(haps.length)
                                : withCommas(found) + " (" +
             (haps.length ? Math.round(100 * found / haps.length) : 0) + "%)")]);
    // The form has the two annotation choices already; that page has no form.
    var annot = chosen ? null : allAnnotControl();
    if (annot) { strip.appendChild(div()); strip.appendChild(annot); }
    strip.appendChild(acts);
    card.appendChild(strip);
    if (chosen)
        acts.appendChild(el("a", { class: "gbPill", href: liftAllUrl(src),
            title: "This region on every haplotype in the pangenome, with figures on " +
                   "how it carries over", text: "View all haplotypes" }));
    var tsv = el("button", { type: "button", class: "gbPill", text: "Download Table",
        title: "Download the rows below, in their current order and filter, as a " +
               "tab-separated file that opens in Excel" });
    acts.appendChild(tsv);

    if (!chosen)
        card.appendChild(el("div", { class: "pgcStats" }, [
            allCoveragePanel(haps), allSizePanel(haps), allPopPanel(haps)]));

    // The regions the ancestry plot is offered for, the source first.
    var anc = ancOn() ? [] : null;
    if (anc) {
        var sp = String(src.src).split("#");
        anc.push({ role: "source", hap: allSrcHap,
                   db: assemblyForHap(allSrcHap), contig: sp.slice(2).join("#"),
                   start: src.start, end: src.end,
                   url: (browserLinkFor({ haplotype: src.src, start: src.start, end: src.end }) || {}).url });
    }
    var notes = el("div", { class: "pgrNotes" });
    notes.appendChild(el("div", { class: "pgrNote", text: "One row for each piece of the region " +
        "on a haplotype." + (chosen ? "" : " Click a number above to filter the table.") }));
    (resp.warnings || []).forEach(function (w) {
        if (w && w.reason === "timeout")
            notes.appendChild(el("div", { class: "pgrNote pgErrBox", text: "The graph server " +
                "ran out of time on this region, so some haplotypes may be missing pieces " +
                "or missing altogether." }));
    });
    card.appendChild(notes);

    if (anc) {
        var plotHost = el("div", { class: "pgrPanel", id: "pgrPclaiPlot" });
        plotHost.style.display = "none";
        plotHost.addEventListener("click", function (ev) {
            var b = ev.target && ev.target.closest ? ev.target.closest("[data-pgp-open]") : null;
            if (!b) return;
            var hit = anc.filter(function (x) { return x.id === b.getAttribute("data-pgp-open"); })[0];
            if (!hit || !hit.anchor) return;
            ev.preventDefault();
            hit.anchor.click();
        });
        card.appendChild(plotHost);
    }
    card.appendChild(el("div", { id: "pgcAllBar", class: "pgrBar on", hidden: "hidden" }));
    allMetricFilters = [];
    if (!chosen) card.appendChild(allMetricControls());

    // The table.
    var split = haps.some(function (h) { return h.pieces.length > 1; });
    var head = ["#", "Sample", "Haplotype", "Population"];
    if (split) head.push("Piece");
    head.push("Open in Genome Browser", "Coverage", "Span", "Inserted", "Deleted", "Size change", "Strand");
    var tips = { Piece: "Which piece of the region this is, numbered largest first",
                 Coverage: "Share of the region's bases with a place on this haplotype, all pieces together",
                 Inserted: "Bases on this haplotype, inside the parts that carried over, that no " +
                           "base of the region is placed on; all pieces together",
                 Deleted: "Bases of the region, inside the parts that carried over, with no " +
                          "place on this haplotype; all pieces together",
                 Span: "Share of the region this piece covers, from its first base to its last",
                 "Size change": "This piece's length here less the length of the source it covers: " +
                                "inserted less deleted, net",
                 Haplotype: "Which of the sample's two haplotypes; 0 for a reference",
                 Population: "The sample's population, as the HPRC describes it" };
    var table = el("table", { id: "pgcTable", class: "display" });
    table.appendChild(el("thead", null, [el("tr", null, head.map(function (h) {
        return el("th", tips[h] ? { text: h, title: tips[h] } : { text: h });
    }))]));
    var tbody = el("tbody");
    table.appendChild(tbody);
    var rows = allRows = [];
    haps.forEach(function (h) {
        (h.pieces.length ? h.pieces : [null]).forEach(function (p, i) {
            rows.push({ h: h, piece: p, i: i,
                        span: p ? (len ? 100 * (p.source_end - p.source_start) / len : null) : 0,
                        change: p && p.merged <= ALL_MERGED_MAX
                                ? (p.end - p.start) - (p.source_end - p.source_start) : null });
        });
    });
    // The form has the Annotations box only where the browser can lift tracks.
    var annotOk = chosen ? !!$("pgcQuickLift") : !!CFG.quickLiftEnabled;
    rows.forEach(function (r, idx) {
        var h = r.h, p = r.piece;
        var info = prettyHap(h.hap);
        var pop = samplePop(h.hap);
        var parent = info.label.split(" ")[1];
        parent = (parent === "paternal" || parent === "maternal") ? parent : null;
        var cells = [el("td", { class: "rankCol", text: String(idx + 1), "data-order": String(idx) }),
                     el("td", { class: "sampleCol", text: info.sample }),
                     el("td", parent ? { class: "phaseCol", text: info.phase, title: parent }
                                     : { class: "phaseCol", text: info.phase == null ? "" : info.phase }),
                     el("td", { class: "popCol", text: pop ? pop.desc + " (" + pop.code + ")" : "" })];
        if (split)
            cells.push(el("td", { class: "pieceCol", "data-order": p ? String(r.i) : "",
                                  text: h.pieces.length > 1 ? (r.i + 1) + " of " + h.pieces.length : "" }));
        var posCell = el("td", { class: "posCol" });
        if (!p) {
            posCell.appendChild(el("span", { class: "pgrUnplaced", text: "no equivalent region" }));
            posCell.appendChild(el("span", { class: "pgcNoneWhy",
                text: " - this region does not exist on " + hapLabel(h.hap) + "." }));
            cells.push(posCell,
                       el("td", { class: "pctCol", "data-order": "0" }),
                       el("td", { class: "pctCol", "data-order": "0" }),
                       el("td", { class: "pctCol", "data-order": "" }),
                       el("td", { class: "pctCol", "data-order": "" }),
                       el("td", { class: "pctCol", "data-order": "" }),
                       el("td", { class: "strandCol" }));
        } else {
            var iv = { haplotype: h.hap + "#" + p.contig, start: p.start, end: p.end, strand: p.strand };
            var link = browserLinkFor(iv);
            var a = null;
            if (link) {
                a = el("a", { href: link.url, text: link.pos,
                    title: "Show this region in the UCSC Genome Browser (assembly " + link.db + ")" });
                if (link.isRemote) { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener"); }
                if (annotOk && annotationsPossible(iv)) armAnnotationLink(a, iv, link);
                posCell.appendChild(a);
            } else {
                posCell.appendChild(el("code", { text: hapLabel(iv.haplotype) + ":" + (p.start + 1) + "-" + p.end }));
            }
            var spanPct = len ? 100 * (p.source_end - p.source_start) / len : null;
            var change = (p.end - p.start) - (p.source_end - p.source_start);
            var changeCell = p.merged > ALL_MERGED_MAX
                ? el("td", { class: "pctCol pgcUnsure", text: "unclear", "data-order": "",
                             title: "The graph server reported this place as " + withCommas(p.merged) +
                                    " overlapping pieces, shown here as one; its length is not a size change" })
                : el("td", { class: "pctCol" + (change ? "" : " zero"), text: fmtChange(change),
                             "data-order": String(change) });
            var bpCell = function (v) {
                return v == null
                    ? el("td", { class: "pctCol pgcUnsure", text: "unclear", "data-order": "" })
                    : el("td", { class: "pctCol" + (v ? "" : " zero"), text: fmtBp(v), "data-order": String(v) });
            };
            cells.push(posCell,
                el("td", { class: "pctCol", text: pctText(h.bases), "data-order": h.bases.toFixed(3) }),
                el("td", { class: "pctCol", text: pctText(spanPct), "data-order": spanPct.toFixed(3) }),
                bpCell(h.inserted), bpCell(h.deleted),
                changeCell,
                el("td", p.strand === "-" ? { class: "strandCol", text: "-", title: "reverse strand" }
                                          : { class: "strandCol", text: "+" }));
            if (anc)
                anc.push({ role: "target", hap: h.hap,
                           db: assemblyForHap(h.hap), contig: p.contig, start: p.start, end: p.end,
                           url: link ? link.url : null, anchor: a });
        }
        r.tr = el("tr", { "data-i": String(idx), class: p ? "" : "pgcNone" }, cells);
        tbody.appendChild(r.tr);
    });
    card.appendChild(el("div", { class: "pgcTableWrap" }, [table]));

    // Narrowed by a figure above, through DataTables' own row filter.
    var jq = window.jQuery;
    if (jq && jq.fn && jq.fn.dataTable && !allSearchHooked) {
        allSearchHooked = true;
        jq.fn.dataTable.ext.search.push(function (settings, data, i) {
            if (settings.nTable.id !== "pgcTable" || (!allFilter && !allMetricFilters.length)) return true;
            var tr = settings.aoData[i] && settings.aoData[i].nTr;
            var r = tr ? allRows[+tr.getAttribute("data-i")] : null;
            return !r || ((!allFilter || allFilter.test(r.h)) && metricKeeps(r));
        });
    }
    allDt = pgcPageTable(table, [[0, "asc"]]);
    tsv.addEventListener("click", function () {
        var shown = allRows;
        if (allDt) {
            shown = [];
            allDt.rows({ search: "applied", order: "applied" }).nodes().each(function (tr) {
                shown.push(allRows[+tr.getAttribute("data-i")]);
            });
        } else {
            shown = allRows.filter(function (r) { return !r.tr.hidden; });
        }
        var name = String(src.src).replace(/#/g, "_") + "_" + (src.start + 1) + "-" + src.end;
        saveFile(allTsv(shown, len), "panLift_" + name + ".tsv", "text/tab-separated-values");
    });
    if (anc) ancPlot(acts, anc);
}

// The page's two ways out, in the gold title bar, as on the mapping results page.
function allHeadActions(page) {
    var sectTtl = $("sectTtl");
    if (!sectTtl || $("pgrHeadActions")) return;
    var acts = el("span", { id: "pgrHeadActions", class: "pgrHeadActions" });
    if (page.backUrl)
        acts.appendChild(el("a", { class: "gbPill", href: page.backUrl, text: "Back to Genome Browser",
            title: "Return to the Genome Browser at your previous location (" + page.backPos + ")" }));
    acts.appendChild(el("a", { class: "gbPill", href: page.panLiftUrl || (selfUrl() + "?page=convert"),
        text: "Back to PanLift", title: "Convert to a few assemblies, chosen by hand" }));
    sectTtl.appendChild(acts);
}

function initAll() {
    var page = window.pangenomeLiftAll;
    CFG = window.pangenomeConfig || {};
    allHeadActions(page);
    var parts = String(page.src || "").split("#");
    if (parts.length < 3 || !(page.start >= 0) || !(page.end > page.start)) {
        showError("This link does not name a region to convert. Go to the region in the " +
                  "Genome Browser and open PanLift from there.");
        return;
    }
    allSrcHap = parts[0] + "#" + parts[1];
    var src = { src: page.src, contig: parts.slice(2).join("#"), start: page.start, end: page.end };
    lastSource = src;              // what armAnnotationLink carries over from
    var what = hapLabel(src.src) + ":" + (src.start + 1) + "-" + src.end;
    var go = function () {
        showBusy("Translating " + what + " to every haplotype in the pangenome…");
        postCmd("liftoverAll", { src: src.src, start: src.start, end: src.end }).then(function (resp) {
            if (!resp || resp.status === "error") throw new Error((resp && resp.error) || "no answer");
            if (!resp.summary) throw new Error("the graph server sent no summary");
            hideStatus();
            renderAll(resp, src);
        }).catch(function (err) {
            showError("Could not convert " + what + ": " + err.message, go);
        });
    };
    go();
}

// ---- Init -------------------------------------------------------------------

function init() {
    if (window.pangenomeLiftAll && $("pgcAll")) { initAll(); return; }
    if (!$("pgcResults")) return;              // not this page
    CFG = window.pangenomeConfig || {};
    if (CFG.maxLiftSpan) MAX_SPAN = CFG.maxLiftSpan;
    if (typeof CFG.maxChosenTargets === "number" && CFG.maxChosenTargets >= 0) MAX_CHOSEN = CFG.maxChosenTargets;

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
    if ($("pgcAllBtn")) $("pgcAllBtn").addEventListener("click", onShowAll);
    $("pgcFilter").addEventListener("input", function () {
        fillTargets($("pgcFilter").value);
    });
    // No listener on the source: it is not a control any more.
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
            // In the pane's order, so that "Choose first N" takes the top of it.
            var want = Object.create(null);
            var room = chosenRoom(selectedTargets().length);
            Array.prototype.forEach.call(boxes, function (x) {
                if (!on) { want[x.getAttribute("data-hap")] = true; }
                else if (!x.checked && room > 0) { want[x.getAttribute("data-hap")] = true; room--; }
            });
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
}

if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
else
    init();

// Test hook; a no-op in the browser (see hgPangenome/tests/).
if (typeof module !== "undefined" && module.exports)
    module.exports = {
        parsePosition: parsePosition,
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
        ancPlot: ancPlot,
        samplePop: samplePop,
        allHapsFrom: allHapsFrom,
        mergePieces: mergePieces,
        unionLength: unionLength,
        metricKeeps: metricKeeps,
        setMetricFilters: function (f) { allMetricFilters = f; },
        allMetrics: ALL_METRICS,
        setAllSrcHap: function (h) { allSrcHap = h; },
        fmtChange: fmtChange,
        niceStep: niceStep,
        liftAllUrl: liftAllUrl,
        renderAll: renderAll,
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
