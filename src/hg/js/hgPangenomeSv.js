/* hgPangenomeSv.js - one structural variant of the HPRC pangenome, and every
 * haplotype by what it has there.
 *
 * Reached from an item on the "HPRC v2.1 233 SVs" track, as
 * hgPangenome?page=sv&db=hg38&chrom=chr1&start=730868&end=730869&sv=INS-13.6k:11.
 * The CGI reads the SV's row from the carriers file (makeSvCarriers.py) and
 * hands it over as pangenomeSv: what the SV is, the graph site it is one allele
 * of, and each haplotype's state there - carries this SV, carries another SV at
 * the same site, neither, or no call.  This page lays that out by population
 * (hgPangenomeSamples.js), and from it opens any haplotype at the site
 * (cmd=svOpen) or compares several in PanLift.
 *
 * Copyright (C) 2026 The Regents of the University of California */
/* global window, document, fetch */

(function () {
'use strict';

var SV = null;          // pangenomeSv
var CFG = {};           // pangenomeConfig
var MAX_TARGETS = 10;

// What a haplotype can have at the site, in the order the page offers them.
var STATES = [
    { key: "c", label: "Carry this SV" },
    { key: "o", label: "Another SV here",
      title: "These haplotypes carry a different SV at the same graph site." },
    { key: "r", label: "No SV here",
      title: "These haplotypes have the reference's sequence here, or a change under 50 bp." },
    { key: "n", label: "Not covered",
      title: "These assemblies have no call at this site: the graph has no path for them here." },
    { key: "", label: "All" }
];

var showing = "c";      // the state whose haplotypes are listed
var chosen = [];        // haplotypes chosen for PanLift, in the order picked
var states = {};        // haplotype -> state

// ---- DOM helpers ------------------------------------------------------------

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
function num(n) { return Number(n).toLocaleString("en-US"); }
function plural(n, one, many) { return num(n) + " " + (n === 1 ? one : many); }

function bp(n) {
    if (n >= 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + " kb";
    return num(n) + " bp";
}

// ---- Haplotypes -------------------------------------------------------------

function sampleOf(hap) { return String(hap).split("#")[0]; }

// The assembly a haplotype is browsed in, or null when it has none the browser
// can open by name (the two HG002 assemblies are hubs at full URLs).
function dbOf(hap) {
    var db = (window.pangenomeAssemblies || {})[String(hap).toLowerCase()];
    return db && !/^https?:/.test(db) ? db : null;
}

function isRef(hap) {
    return /^(GRCh38|CHM13)#/i.test(hap);
}

// [key, label] of the group a haplotype is listed under.
function groupOf(hap) {
    if (isRef(hap)) return ["~ref", "References"];
    var p = (window.pangenomeSamples || {})[sampleOf(hap).toLowerCase()];
    if (!p) return ["~none", "No population given"];
    return [p[0], p[1] + " (" + p[0] + ")"];
}

// ---- The region compared and opened ------------------------------------------

// The site and the SV together, plus the flank: what every haplotype is shown
// over.  The SV can sit anywhere inside its site, and a pure insertion just past
// its end, so the union is the honest extent.
function region() {
    var s = Math.min(SV.siteStart, SV.start), e = Math.max(SV.siteEnd, SV.end);
    return { start: Math.max(0, s - SV.flank), end: e + SV.flank, siteStart: s, siteEnd: e };
}

function regionPos() {
    var r = region();
    return SV.chrom + ":" + (r.start + 1) + "-" + r.end;
}

// ---- Header -----------------------------------------------------------------

function whatItIs() {
    var where = SV.refLabel + " " + SV.chrom + ":" + num(SV.start + 1);
    if (SV.svType === "INS")
        return bp(SV.insLen) + " insertion at " + where;
    if (SV.svType === "DEL")
        return bp(SV.svLen) + " deletion at " + where + "-" + num(SV.end);
    return bp(SV.svLen) + " " + SV.svType + " at " + where;
}

function svPageUrl(o) {
    return "hgPangenome?page=sv&db=" + encodeURIComponent(SV.db) +
           "&chrom=" + encodeURIComponent(SV.chrom) + "&start=" + o.start +
           "&end=" + o.end + "&sv=" + encodeURIComponent(o.name);
}

function drawHead(app) {
    var counts = { c: 0, o: 0, r: 0, n: 0 };
    SV.haps.forEach(function (h) { counts[h[1]]++; });
    var called = counts.c + counts.o + counts.r;

    app.appendChild(el("h2", { class: "pgsTitle", text: SV.name }));
    app.appendChild(el("p", { class: "pgsLead" }, [
        whatItIs() + ", carried by ",
        el("b", { text: plural(counts.c, "haplotype", "haplotypes") }),
        " of " + num(called) + " with a call here (" +
        (called ? (100 * counts.c / called).toFixed(1) : "0") + "%)."
    ]));

    var facts = el("table", { class: "pgsFacts" });
    function fact(k, v, title) {
        facts.appendChild(el("tr", title ? { title: title } : null,
                             [el("th", { text: k }), el("td", null, v)]));
    }
    var r = region();
    var siteLen = r.siteEnd - r.siteStart;
    var browse = el("a", { href: "hgTracks?db=" + encodeURIComponent(SV.db) +
                                 "&position=" + encodeURIComponent(regionPos()),
                           text: "View in Genome Browser" });
    fact("Graph site", [SV.chrom + ":" + num(r.siteStart + 1) + "-" + num(r.siteEnd) +
                        " (" + bp(siteLen) + ")  ", browse],
         "The stretch of " + SV.refLabel + " that the pangenome graph treats as one " +
         "variable site. The track draws the SV at the site's left edge; in the " +
         "haplotypes the sequence can differ anywhere inside it.");
    fact("Haplotypes", [
        plural(counts.c, "carries", "carry") + " it · " +
        num(counts.o) + " another SV here · " + num(counts.r) + " no SV here · " +
        num(counts.n) + " not covered"]);
    if (SV.others.length) {
        var links = [];
        SV.others.forEach(function (o, i) {
            if (i) links.push(", ");
            links.push(el("a", { href: svPageUrl(o), text: o.name }));
        });
        fact("Other SVs at this site", links,
             "The graph site has other alleles of 50 bp or more; each is its own item on the track.");
    }
    fact("Source", ["HPRC release 2.1 pangenome graph (minigraph-cactus), " +
                    "as on the HPRC v2.1 233 SVs track"]);
    app.appendChild(facts);
    if (siteLen > Math.max(SV.svLen, 1) + 50)
        app.appendChild(el("p", { class: "pgMuted pgsSiteNote", text:
            "Open and Compare show each haplotype's copy of the whole site, with " +
            num(SV.flank) + " bp either side, because the SV can lie anywhere in it." }));
    return counts;
}

// ---- Populations ------------------------------------------------------------

function groups() {
    var byKey = {};
    SV.haps.forEach(function (h) {
        var g = groupOf(h[0]);
        var grp = byKey[g[0]] || (byKey[g[0]] = { key: g[0], label: g[1], haps: [],
                                                  c: 0, called: 0 });
        grp.haps.push(h[0]);
        if (h[1] === "c") grp.c++;
        if (h[1] !== "n") grp.called++;
    });
    // Most carriers first, by frequency; the references and the samples with no
    // population at the end, since a frequency over two of them says little.
    return Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) {
        var sa = a.key.charAt(0) === "~", sb = b.key.charAt(0) === "~";
        if (sa !== sb) return sa ? 1 : -1;
        var fa = a.called ? a.c / a.called : 0, fb = b.called ? b.c / b.called : 0;
        if (fa !== fb) return fb - fa;
        return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });
}

function hapChip(hap) {
    var st = states[hap];
    var db = dbOf(hap);
    var isSource = hap.toLowerCase() === SV.refHap.toLowerCase();
    var on = chosen.indexOf(hap) >= 0;
    var full = chosen.length >= MAX_TARGETS && !on;
    var box = el("input", { type: "checkbox", "data-hap": hap,
                            "aria-label": "Compare " + hap + " in PanLift" });
    box.checked = on;
    if (!db || isSource || full) box.disabled = true;
    box.title = isSource ? "The source of the comparison" :
                !db ? "Not available in the Genome Browser by name" :
                full ? "Up to " + MAX_TARGETS + " can be compared at once" :
                "Compare in PanLift";
    var name = db ? el("a", { href: "#", "data-open": hap, text: hap,
                              title: "Open " + hap + " at this site" })
                  : el("span", { text: hap });
    return el("span", { class: "pgsHap pgsHap-" + st + (on ? " on" : "") }, [box, name]);
}

function drawPops() {
    var host = $("pgsPops");
    clear(host);
    var table = el("table", { class: "pgsPopTable" });
    table.appendChild(el("tr", null, [
        el("th", { text: "Population" }),
        el("th", { class: "pgsNum", text: "Carriers",
                   title: "Haplotypes carrying this SV, of those with a call here" }),
        el("th", { text: "" }),
        el("th", { text: "Haplotypes" })
    ]));
    var none = [];
    groups().forEach(function (g) {
        var list = g.haps.filter(function (h) { return !showing || states[h] === showing; });
        if (!list.length) {
            if (showing === "c" && g.key.charAt(0) !== "~") none.push(g.label);
            return;
        }
        var frac = g.called ? g.c / g.called : 0;
        var bar = el("span", { class: "pgsBar", title: (100 * frac).toFixed(1) + "%" },
                     [el("span", { class: "pgsBarFill" })]);
        bar.firstChild.style.width = Math.round(100 * frac) + "%";
        table.appendChild(el("tr", null, [
            el("td", { class: "pgsPopName", text: g.label }),
            el("td", { class: "pgsNum", text: g.c + " / " + g.called }),
            el("td", null, [bar]),
            el("td", { class: "pgsHaps" }, list.map(hapChip))
        ]));
    });
    host.appendChild(table);
    if (none.length)
        host.appendChild(el("p", { class: "pgMuted pgsNone",
                                   text: "No carriers among: " + none.join("; ") + "." }));
}

function drawTabs(counts) {
    var host = $("pgsTabs");
    clear(host);
    STATES.forEach(function (s) {
        var n = s.key ? counts[s.key] : SV.haps.length;
        var b = el("button", { type: "button", class: "pgsTab pgsTab-" + (s.key || "all") +
                                                     (showing === s.key ? " on" : ""),
                               "data-state": s.key, "aria-pressed": String(showing === s.key) },
                   [s.label + " ", el("span", { class: "pgsTabN", text: num(n) })]);
        if (s.title) b.title = s.title;
        host.appendChild(b);
    });
}

// ---- Compare in PanLift ------------------------------------------------------

// A starting choice worth comparing: carriers and non-carriers side by side,
// taken a population at a time so one large group does not fill the list.
function defaultChoice() {
    var pick = [];
    function take(state, want) {
        var queues = groups().map(function (g) {
            return g.haps.filter(function (h) {
                return states[h] === state && dbOf(h) &&
                       h.toLowerCase() !== SV.refHap.toLowerCase();
            });
        }).filter(function (q) { return q.length; });
        var got = 0;
        while (got < want && queues.some(function (q) { return q.length; })) {
            queues.forEach(function (q) {
                if (got < want && q.length) { pick.push(q.shift()); got++; }
            });
        }
    }
    take("c", 5);
    take("r", MAX_TARGETS - 1 - pick.length);
    return pick.slice(0, MAX_TARGETS);
}

function panLiftUrl() {
    var url = "hgPangenome?page=convert&db=" + encodeURIComponent(SV.db) +
              "&position=" + encodeURIComponent(regionPos()) +
              "&pgTarget=" + encodeURIComponent(chosen.join(","));
    if (CFG.hgsid) url += "&hgsid=" + encodeURIComponent(CFG.hgsid);
    return url;
}

function drawCompare() {
    var host = $("pgsCompare");
    clear(host);
    var go = el("a", { class: "pgsGo", href: panLiftUrl(), text: "Compare in PanLift" });
    if (!chosen.length) {
        go.removeAttribute("href");
        go.className += " dis";
    }
    var chips = chosen.map(function (h) {
        return el("span", { class: "pgcChip pgsChip-" + states[h] }, [
            h, el("button", { type: "button", class: "pgcChipX", "data-drop": h,
                              "aria-label": "Remove " + h, text: "×" })]);
    });
    host.appendChild(el("div", { class: "pgsCompareHead" }, [
        el("b", { text: "Compare in PanLift" }),
        el("span", { class: "pgMuted", text: "  " + chosen.length + " of " + MAX_TARGETS +
            " chosen. Tick haplotypes below to change the choice. PanLift shows the site " +
            "on each of them, from " + SV.refLabel + ", side by side." })]));
    host.appendChild(el("div", { class: "pgcChosen" }, chips.concat([go])));
}

// ---- Opening a haplotype ------------------------------------------------------

function annotOn() {
    var box = $("pgsAnnot");
    return !!(box && box.checked);
}

function status(kids, isError) {
    var box = $("pgsStatus");
    clear(box);
    box.className = isError ? "pgWarn" : "pgsStatus";
    box.hidden = !kids;
    (kids || []).forEach(function (k) {
        box.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
    });
}

function openHap(hap, withAnnot, newTab) {
    var r = region();
    var payload = { db: SV.db, chrom: SV.chrom, start: r.siteStart, end: r.siteEnd,
                    hap: hap, hapDb: dbOf(hap), annot: withAnnot ? "on" : "off" };
    // A new tab has to be opened inside the click, or the popup blocker takes
    // it; it is pointed at the answer when that arrives.
    var tab = newTab ? window.open("", "_blank") : null;
    status(["Opening " + hap + (withAnnot ? " with your " + SV.refLabel + " tracks" : "") +
            "…"]);
    var body = "cmd=svOpen&payload=" + encodeURIComponent(JSON.stringify(payload));
    if (CFG.hgsid) body += "&hgsid=" + encodeURIComponent(CFG.hgsid);
    fetch(window.location.pathname, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
                   Accept: "application/json" },
        body: body
    }).then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
    }).then(function (resp) {
        if (!resp || resp.status !== "ok" || !resp.url)
            throw new Error((resp && resp.error) || "no answer");
        status(null);
        if (tab) tab.location = resp.url;
        else window.location = resp.url;
    }).catch(function (err) {
        if (tab) tab.close();
        var kids = ["Could not open " + hap + ": " + err.message + ". "];
        if (withAnnot) {
            var plain = el("a", { href: "#", text: "Open it without the " + SV.refLabel +
                                                   " tracks" });
            plain.addEventListener("click", function (e) {
                e.preventDefault();
                openHap(hap, false, false);
            });
            kids.push(plain);
        }
        status(kids, true);
    });
}

// ---- Page -------------------------------------------------------------------

function redraw() {
    drawPops();
    drawCompare();
}

function init() {
    SV = window.pangenomeSv;
    if (!SV) return;                     // the CGI has already said what is wrong
    CFG = window.pangenomeConfig || {};
    MAX_TARGETS = CFG.maxLiftTargets || MAX_TARGETS;
    SV.haps.forEach(function (h) { states[h[0]] = h[1]; });

    var app = $("pgsApp");
    var counts = drawHead(app);
    if (!counts.c) showing = "";
    chosen = defaultChoice();

    app.appendChild(el("h3", { class: "pgsH3", text: "Haplotypes by population" }));
    var tools = el("div", { class: "pgsTools" }, [el("div", { id: "pgsTabs", class: "pgsTabs",
                                                              role: "group" })]);
    if (SV.quickLift) {
        var saved = null;
        try { saved = window.localStorage.getItem("hgPangenome.svAnnot"); } catch (e) { saved = null; }
        var box = el("input", { type: "checkbox", id: "pgsAnnot" });
        box.checked = saved !== "off";
        tools.appendChild(el("label", { for: "pgsAnnot", class: "pgsAnnot",
            title: "When you open a haplotype, the tracks you have turned on in " + SV.refLabel +
                   " come with it, carried across through the pangenome graph." },
            [box, " Open with my " + SV.refLabel + " tracks"]));
        box.addEventListener("change", function () {
            try { window.localStorage.setItem("hgPangenome.svAnnot", box.checked ? "on" : "off"); }
            catch (e) { /* remembered for this page only */ }
        });
    }
    app.appendChild(tools);
    app.appendChild(el("div", { id: "pgsStatus", class: "pgsStatus", hidden: "",
                                "aria-live": "polite" }));
    app.appendChild(el("p", { class: "pgMuted pgsHint", text:
        "Click a haplotype to open it at this site in the Genome Browser; tick it to " +
        "include it in the PanLift comparison." }));
    app.appendChild(el("div", { id: "pgsPops" }));
    app.appendChild(el("div", { id: "pgsCompare", class: "pgsCompare" }));

    drawTabs(counts);
    redraw();

    $("pgsTabs").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-state]");
        if (!b) return;
        showing = b.getAttribute("data-state");
        drawTabs(counts);
        drawPops();
    });
    $("pgsPops").addEventListener("click", function (e) {
        var a = e.target.closest("a[data-open]");
        if (!a) return;
        e.preventDefault();
        openHap(a.getAttribute("data-open"), annotOn(), e.ctrlKey || e.metaKey);
    });
    $("pgsPops").addEventListener("change", function (e) {
        var box = e.target;
        if (!box.matches("input[data-hap]")) return;
        var hap = box.getAttribute("data-hap");
        var at = chosen.indexOf(hap);
        if (box.checked && at < 0 && chosen.length < MAX_TARGETS) chosen.push(hap);
        if (!box.checked && at >= 0) chosen.splice(at, 1);
        redraw();
    });
    $("pgsCompare").addEventListener("click", function (e) {
        var x = e.target.closest("button[data-drop]");
        if (!x) return;
        var at = chosen.indexOf(x.getAttribute("data-drop"));
        if (at >= 0) chosen.splice(at, 1);
        redraw();
    });
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { init: init, region: region, defaultChoice: defaultChoice,
                       groupOf: groupOf, whatItIs: whatItIs,
                       _set: function (sv, cfg) {
                           SV = sv; CFG = cfg || {}; states = {};
                           sv.haps.forEach(function (h) { states[h[0]] = h[1]; });
                       } };
} else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
})();
