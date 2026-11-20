/* hgPangenomePclai.js - where a mapping's hits sit in ancestry space.
 *
 * Optional.  The whole feature is behind pangenome.resultsPclai in hg.conf; with
 * it off the server never emits the config and nothing here runs, so the pages
 * have no plot and no sign of one.
 *
 * pcLAI (Geleta et al. 2026, doi:10.64898/2026.03.23.713813) gives every window
 * of every HPRC haplotype a coordinate in a reference PCA space rather than an
 * ancestry label.  This plots the reference cloud - the pcLAI authors' own
 * published panel - and puts one mark per hit haplotype on top, over the space
 * painted in pcLAI's own colours.
 *
 * Deliberately no labels anywhere: not on the hits, and not on the reference
 * panel either, whose 1000 Genomes populations are not how the HPRC describes
 * its samples and will not fit the next release's.  Colour means one thing
 * throughout, a position in the space, exactly as the pcLAI tracks paint it.
 *
 * A page reaches this as window.pangenomePlot: init() once the page has its
 * regions, update() as it learns more of them, togglePick() and isPicked() for
 * the haplotypes ticked in a table.  The helpers named pg.* are
 * hgPangenomeCommon.js.
 *
 * Copyright (C) 2026 The Regents of the University of California */

/* global window, document, pangenomePclaiMinCoverage */

(function () {
'use strict';

var pg = window.pangenomeCommon;

var pgpSpots = null;        // one {hap, acc, contig, start, end} per hit
var pgpData = null;         // the server's answer, kept so a redraw is free
var pgpDataSpots = null;    // the spots that answer is for
var pgpUpdating = Promise.resolve();   // pgpUpdate()s, one after another
var pgpPicked = Object.create(null);   // haplotypes the user ticked
var pgpSelected = null;     // the haplotype whose details are open, if any
var pgpSelGroup = null;     // the haplotypes sharing the mark that was clicked
var pgpWindows = Object.create(null);  // key -> its windows, or null while being read
var pgpGen = 0;             // which pgpInit() this is; an answer asked for under an older one is dropped
var pgpOpening = -1;        // the pgpGen whose first read is out, so that it is not asked for twice

// The hit index, shared by the hover readout and the click that opens details:
// both ask the same question - which mark is under the cursor.
var pgpMarks = null;
var pgpGrid = null;
var pgpEscBound = false;

// ---- what gets plotted ------------------------------------------------------
//
// The table lists every hit on purpose.  The plot must not: the surjection is
// asked for a COUNT of haplotypes and answers best first, so on a region few
// haplotypes carry, the tail of that count is incidental repeat matches
// covering a few per cent of the query.  They are real rows and belong in the
// table, but their ancestry is read at a position that has little to do with
// the query, and averaging it in moves the centroid and inflates the
// dispersion.  Both filters below therefore govern the points, the grouping,
// the ellipse and the dispersion together, so the figure always describes
// exactly what is drawn - and both say what they excluded rather than dropping
// it quietly.
// What the two marks of our own are called in the legend.  The results page's
// points are hits it can tick; PanLift's are the targets of a conversion and
// its source, and it says so through pgpInit's options.
var pgpLegend = { hit: "a hit", pick: "ticked in the table", many: "hits" };
var pgpMinCov = null;       // coverage floor, % - null until the config is read
var pgpBestOnly = true;     // only the best placement of each query

function pgpMinCovDefault() {
    return (typeof pangenomePclaiMinCoverage === "number") ? pangenomePclaiMinCoverage : 50;
}

// A point is drawn when the row behind it clears both filters.
// What identifies one plotted point.  Its own id where it has one, so two
// placements on the same haplotype stay distinct; the haplotype name otherwise.
function pgpKeyOf(p) {
    return (p && typeof p === "object" && p.id) ? p.id : ((p && p.hap) || String(p));
}

function pgpKeep(p) {
    var spot = pgpSpotFor(p);
    if (spot === null) { return false; }
    if (pgpMinCov !== null && spot.coverage !== null &&
        spot.coverage < pgpMinCov) { return false; }
    if (pgpBestOnly && spot.placement > 0) { return false; }
    return true;
}

// True when any hit comes from a secondary placement, which is the only case
// where the placement control has anything to offer.
function pgpHasPlacements() {
    return (pgpSpots || []).some(function (s) { return s.placements > 1; });
}

// pcLAI's own colour for a coordinate.  The authors' paintings.py puts PC1 and
// PC2 on CIE Lab's a and b axes at a fixed lightness of 80 and converts to
// sRGB, clipping what falls outside it.  The PC range it stretches over comes
// from their founder panel and scaling, which are not published; the bounds
// here were fitted to the itemRgb of 1,521 windows from 30 HPRC2 assemblies,
// and reproduce every one of them to within 3 of 255 on each channel.
var PGP_LAB_X = [-2.3757, 1.3365], PGP_LAB_Y = [-2.0158, 2.1053];

function pgpLabRgb(x, y) {
    var a = ((x - PGP_LAB_X[0]) / (PGP_LAB_X[1] - PGP_LAB_X[0]) - 0.5) * 240;
    var b = ((y - PGP_LAB_Y[0]) / (PGP_LAB_Y[1] - PGP_LAB_Y[0]) - 0.5) * 240;
    var fy = (80 + 16) / 116, fx = fy + a / 500, fz = Math.max(0, fy - b / 200);
    var inv = function (t) { return t > 0.2068966 ? t * t * t : (t - 16 / 116) / 7.787; };
    var X = 0.95047 * inv(fx), Y = inv(fy), Z = 1.08883 * inv(fz);
    return [3.2404813 * X - 1.5371515 * Y - 0.4985363 * Z,
            -0.9692549 * X + 1.8759900 * Y + 0.0415559 * Z,
            0.0556466 * X - 0.2040413 * Y + 1.0573111 * Z].map(function (c) {
        c = c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
        return Math.round(255 * Math.min(1, Math.max(0, c)));
    });
}

// The plot area painted with those colours, as an image: a small canvas the
// browser smooths as it stretches it, so the field has no visible steps.
// Kept for the scale it was made for, so a redraw does not paint it again.
var pgpFieldCache = null;
function pgpField(s) {
    var key = [s.x0, s.x1, s.y0, s.y1].join();
    if (pgpFieldCache && pgpFieldCache.key === key) { return pgpFieldCache.href; }
    var href = null;
    try {
        var w = 140, h = 128, cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        var ctx = cv.getContext && cv.getContext("2d");
        if (ctx) {
            var img = ctx.createImageData(w, h);
            for (var j = 0; j < h; j++) {
                for (var i = 0; i < w; i++) {
                    var c = pgpLabRgb(s.x0 + (i + 0.5) / w * (s.x1 - s.x0),
                                      s.y1 - (j + 0.5) / h * (s.y1 - s.y0));
                    var k = 4 * (j * w + i);
                    img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2];
                    img.data[k + 3] = 255;
                }
            }
            ctx.putImageData(img, 0, 0);
            href = cv.toDataURL("image/png");
        }
    } catch (e) { href = null; }
    pgpFieldCache = { key: key, href: href };
    return href;
}

// ---- fetching ---------------------------------------------------------------

// Each haplotype is read in its own assembly's coordinates, at the interval the
// surjection put the query on, so the request is a list of places rather than
// one locus with a list of names.  POSTed because fifty of them outgrow a URL.
// The server reads at most 100 spots a request (pangenome.pclaiMaxHaplotypes)
// and quietly leaves out the rest, so a table of every hit is asked about in
// pieces, one after another, and the answers put together.
var PGP_PER_REQUEST = 100;

function pgpFetchOne(spots, windows) {
    return pg.post("pclai", windows ? {spots: spots, windows: true} : {spots: spots}).then(pg.json);
}

function pgpFetch(spots) {
    var chunks = [];
    for (var i = 0; i < spots.length; i += PGP_PER_REQUEST) {
        chunks.push(spots.slice(i, i + PGP_PER_REQUEST));
    }
    // The first answer decides whether there is a plot at all.  A later one
    // that fails leaves its spots out, counted in "failed" so that the plot
    // can say how many it is missing.
    var merged = null;
    return chunks.reduce(function (prev, chunk, i) {
        return prev.then(function () {
            if (i === 0) {
                return pgpFetchOne(chunk).then(function (r) { merged = r; });
            }
            if (!merged || merged.status !== "ok") { return; }
            return pgpFetchOne(chunk).then(function (r) {
                if (!r || r.status !== "ok") { throw new Error("no answer"); }
                merged.points = (merged.points || []).concat(r.points || []);
                merged.asked = (merged.asked || 0) + (r.asked || 0);
                merged.found = (merged.found || 0) + (r.found || 0);
                // The panel comes with the first answer that could find it.
                merged.panel = merged.panel || r.panel;
            }).catch(function () {
                merged.failed = (merged.failed || 0) + chunk.length;
            });
        });
    }, Promise.resolve()).then(function () { return merged; });
}

// ---- the plot ---------------------------------------------------------------

var PGP_W = 820, PGP_H = 680, PGP_L = 66, PGP_R = 250, PGP_T = 92, PGP_B = 88;
var PGP_MARG = 28;          // how far the bars along each axis reach

// Everything below the plot is stacked from the plot's own bottom edge rather
// than from the canvas height, so the three rows cannot drift into each other
// when the canvas changes: tick labels, then the axis name, then the
// dispersion line.  PGP_B has to leave room for all three.
var PGP_BASE = PGP_H - PGP_B;       // y of the plot's bottom edge
var PGP_TICK_Y = PGP_BASE + 17;
var PGP_AXIS_Y = PGP_BASE + 38;
var PGP_DISP_Y = PGP_BASE + 62;

function pgpScales(panel, pts) {
    var xs = panel.points.map(function (p) { return p[0]; })
                 .concat(pts.map(function (p) { return p.x; }));
    var ys = panel.points.map(function (p) { return p[1]; })
                 .concat(pts.map(function (p) { return p.y; }));
    var x0 = Math.min.apply(null, xs) - 0.12, x1 = Math.max.apply(null, xs) + 0.12;
    var y0 = Math.min.apply(null, ys) - 0.12, y1 = Math.max.apply(null, ys) + 0.12;
    return {
        X: function (v) { return PGP_L + (v - x0) / (x1 - x0) * (PGP_W - PGP_L - PGP_R); },
        Y: function (v) { return PGP_H - PGP_B - (v - y0) / (y1 - y0) * (PGP_H - PGP_T - PGP_B); },
        x0: x0, x1: x1, y0: y0, y1: y1
    };
}

// How spread out a set of points is: the centroid, which the plot marks, and
// the RMS distance from it, which is the dispersion figure under the plot.
//
// Sample covariance (n-1), so the figure is an estimate of the spread of the
// haplotypes that carry this sequence rather than of these fifty exactly.
function pgpSpread(pts) {
    var n = pts.length;
    if (n < 1) { return null; }
    var cx = 0, cy = 0, i;
    for (i = 0; i < n; i++) { cx += pts[i].x; cy += pts[i].y; }
    cx /= n; cy /= n;
    if (n < 2) { return {cx: cx, cy: cy, n: n, rms: 0}; }
    var sxx = 0, syy = 0;
    for (i = 0; i < n; i++) {
        var dx = pts[i].x - cx, dy = pts[i].y - cy;
        sxx += dx * dx; syy += dy * dy;
    }
    sxx /= (n - 1); syy /= (n - 1);
    return {cx: cx, cy: cy, n: n,
            rms: Math.sqrt(Math.max(0, sxx + syy))};       // RMS distance from centroid
}

// Coincident hits are gathered into one mark.  Measured on a real 48-haplotype
// query the median gap between neighbouring hits was half a unit, against a
// mark ten units wide, and 34 of the 48 fell inside one eight-unit disc: at
// that density separate marks cannot be told apart, let alone aimed at.  So a
// group is drawn once, sized by how many it holds, and clicking it lists them.
//
// Grouping is in viewBox units, not client pixels, so the same query always
// groups the same way however wide the page renders it.
var PGP_GROUP_R = 11;       // centres closer than this share a mark
var PGP_GROUP_GAP = 2;      // clear space every pair of marks must keep

function pgpGroups(pts, scale) {
    var groups = [];
    pts.forEach(function (p) {
        var px = scale.X(p.x), py = scale.Y(p.y), i;
        for (i = 0; i < groups.length; i++) {
            var g = groups[i];
            if (Math.hypot(g.x - px, g.y - py) < PGP_GROUP_R) {
                g.members.push(p);
                centre(g);
                return;
            }
        }
        groups.push({x: px, y: py, members: [p]});
    });
    // Grouping by a fixed radius is not enough on its own: a mark grows with
    // what it holds, so two groups that were far enough apart as points can
    // still overlap once drawn.  Merge the worst offending pair and look again,
    // until no two marks touch - the invariant we actually want is about the
    // circles, not about the centres.
    // Put a mark where its members are, rather than where the first of them
    // happened to be.
    function centre(g) {
        g.x = 0; g.y = 0;
        g.members.forEach(function (m) { g.x += scale.X(m.x); g.y += scale.Y(m.y); });
        g.x /= g.members.length; g.y /= g.members.length;
    }
    for (;;) {
        var worst = PGP_GROUP_GAP, wi = -1, wj = -1, i, j;
        for (i = 0; i < groups.length; i++) {
            for (j = i + 1; j < groups.length; j++) {
                var gap = Math.hypot(groups[i].x - groups[j].x,
                                     groups[i].y - groups[j].y) -
                          pgpGroupR(groups[i].members.length) -
                          pgpGroupR(groups[j].members.length);
                if (gap < worst) { worst = gap; wi = i; wj = j; }
            }
        }
        if (wi < 0) { break; }
        groups[wi].members = groups[wi].members.concat(groups[wj].members);
        centre(groups[wi]);
        groups.splice(wj, 1);
    }

    // The group's colour is the member nearest its centre - a real colour the
    // authors assigned, not an average of several, which would be a colour
    // pcLAI never gave to any coordinate.
    groups.forEach(function (g) {
        var best = null, bestD = Infinity;
        g.members.forEach(function (m) {
            var d = Math.hypot(scale.X(m.x) - g.x, scale.Y(m.y) - g.y);
            if (d < bestD) { bestD = d; best = m; }
        });
        g.rep = best;
        g.picked = g.members.some(function (m) { return !!pgpPicked[m.hap]; });
    });
    return groups;
}

// Area grows with the count so a crowd reads as a crowd, capped so one big
// group cannot swallow its neighbours.
function pgpGroupR(n) {
    return (n <= 1) ? 5 : Math.min(17, 5 + 2.4 * Math.sqrt(n - 1));
}

function pgpTicks(a, b, n) {
    var step = (b - a) / (n || 5);
    var mag = Math.pow(10, Math.floor(Math.log(step) / Math.LN10));
    step = Math.round(step / mag) * mag;
    var out = [], t = Math.ceil(a / step) * step;
    for (; t <= b; t += step) { out.push(Math.round(t * 1e6) / 1e6); }
    return out;
}

// ---- hover readout ----------------------------------------------------------
//
// The same idea as hgc.scatterPlot.js: a point under the cursor is found from a
// cell index rather than by asking the DOM, so three thousand reference points
// stay smooth.  Two differences.  Our cloud is SVG rather than canvas, so the
// plot is scaled to fit the page and client pixels have to be divided back into
// viewBox units before anything is compared.  And a hit always wins over a
// reference point at the same distance - the reader came for the haplotypes.

var PGP_HIT_R = 7;          // slack outside a mark that still counts, viewBox units
var PGP_CELL = 14;          // index cell size
var PGP_GROUP_MAX_R = 17;   // the cap in pgpGroupR, which the search must reach

function pgpFmtNum(v) {
    // Minus sign rather than hyphen: these are coordinates, and the columns of
    // a readout line up better.
    return String(v).replace(/^-/, "\u2212");
}

function pgpBuildIndex(panel, pts, scale) {
    pgpMarks = [];
    (panel.points || []).forEach(function (p) {
        pgpMarks.push({x: scale.X(p[0]), y: scale.Y(p[1]), hit: false, r: 2,
                       name: p[3], px: p[0], py: p[1]});
    });
    // One entry per group, and each is aimable over its whole drawn area: a
    // big group is a big target, which is the point of drawing it big.
    pgpGroups(pts, scale).forEach(function (g) {
        var rep = g.rep;
        pgpMarks.push({x: g.x, y: g.y, hit: true, r: pgpGroupR(g.members.length),
                       group: g, name: rep.hap, conf: rep.conf,
                       px: rep.x, py: rep.y, spot: pgpSpotFor(rep)});
    });
    pgpGrid = Object.create(null);
    pgpMarks.forEach(function (m, i) {
        var k = Math.floor(m.x / PGP_CELL) + "," + Math.floor(m.y / PGP_CELL);
        (pgpGrid[k] || (pgpGrid[k] = [])).push(i);
    });
}

// The mark nearest the cursor, or null.  The plot is scaled to fit the page, so
// client pixels are divided back into viewBox units before anything is
// compared; the caller gets that scale back because it also positions in it.
function pgpMarkAt(wrap, ev) {
    var r = wrap.getBoundingClientRect();
    if (!r.width || pgpGrid === null) { return null; }
    var k = PGP_W / r.width;            // viewBox units per client pixel
    var mx = (ev.clientX - r.left) * k, my = (ev.clientY - r.top) * k;
    var gx = Math.floor(mx / PGP_CELL), gy = Math.floor(my / PGP_CELL);
    // A group's own radius can exceed one index cell, so the search widens
    // enough to reach the biggest mark that could still be covering the cursor.
    var reach = Math.ceil((PGP_HIT_R + PGP_GROUP_MAX_R) / PGP_CELL);
    var best = null, bestScore = Infinity;
    for (var dx = -reach; dx <= reach; dx++) {
        for (var dy = -reach; dy <= reach; dy++) {
            var cell = pgpGrid[(gx + dx) + "," + (gy + dy)];
            if (!cell) { continue; }
            for (var j = 0; j < cell.length; j++) {
                var m = pgpMarks[cell[j]];
                var d = Math.hypot(m.x - mx, m.y - my);
                // Inside the mark, or within the slack that makes a small dot
                // aimable.  Scored by how far outside its edge the cursor is,
                // so a small mark sitting on a big one still wins when the
                // cursor is actually on the small one.
                var edge = d - m.r;
                if (edge > PGP_HIT_R) { continue; }
                // A hit always beats a reference point at comparable distance.
                var score = edge - (m.hit ? 1000 : 0);
                if (score < bestScore) { bestScore = score; best = m; }
            }
        }
    }
    return (best === null) ? null : {mark: best, scale: k, width: r.width};
}

function pgpAttachHover(wrap) {
    if (!wrap) { return; }
    var tip = document.createElement("div");
    tip.style.cssText = "position:absolute;display:none;pointer-events:none;" +
        "background:#ffffe0;border:1px solid #999;padding:3px 6px;font-size:11px;" +
        "line-height:1.45;white-space:nowrap;z-index:10;" +
        "box-shadow:1px 1px 3px rgba(0,0,0,0.25)";
    wrap.appendChild(tip);

    wrap.addEventListener("mousemove", function (ev) {
        var at = pgpMarkAt(wrap, ev);
        if (at === null) { tip.style.display = "none"; wrap.style.cursor = ""; return; }
        // Only the haplotypes answer a click, so only they get the hand.
        wrap.style.cursor = at.mark.hit ? "pointer" : "";
        tip.innerHTML = pgpTipHtml(at.mark);
        tip.style.display = "block";
        // Keep the readout inside the plot, flipping it left near the edge.
        var left = at.mark.x / at.scale + 12, top = at.mark.y / at.scale - 10;
        if (left + tip.offsetWidth > at.width) {
            left = Math.max(0, at.mark.x / at.scale - 12 - tip.offsetWidth);
        }
        tip.style.left = Math.round(left) + "px";
        tip.style.top = Math.round(Math.max(0, top)) + "px";
    });
    wrap.addEventListener("mouseleave", function () { tip.style.display = "none"; });

    // Escape closes the details.  Bound to the document once for the life of
    // the page, not per draw: the wrap is rebuilt on every redraw and binding
    // it there would stack a listener per click.
    if (!pgpEscBound) {
        pgpEscBound = true;
        document.addEventListener("keydown", function (ev) {
            if (ev.key !== "Escape") { return; }
            // Escape steps back out of a haplotype to the group it came from,
            // then closes.
            if (pgpSelected !== null && pgpSelGroup !== null &&
                pgpSelGroup.length > 1) {
                pgpSelected = null;
            } else if (pgpSelected !== null || pgpSelGroup !== null) {
                pgpSelected = null;
                pgpSelGroup = null;
            } else {
                return;
            }
            pgpDraw();
        });
    }

    // Clicking a haplotype opens its details; clicking anywhere else in the
    // plot closes them.  A reference point is not clickable - there is nothing
    // of ours to say about one, and its hover readout is already the whole of
    // what the panel knows.
    wrap.addEventListener("click", function (ev) {
        var at = pgpMarkAt(wrap, ev);
        if (at === null || !at.mark.hit) {             // the cloud, or nothing
            pgpSelected = null;
            pgpSelGroup = null;
            pgpDraw();
            return;
        }
        var members = at.mark.group ? at.mark.group.members : [];
        // Clicking the open mark again closes it.
        var same = pgpSelGroup !== null && members.length === pgpSelGroup.length &&
                   members.every(function (m, i) {
                       return pgpKeyOf(m) === pgpKeyOf(pgpSelGroup[i]); });
        if (same) {
            pgpSelected = null;
            pgpSelGroup = null;
        } else {
            pgpSelGroup = members;
            // A mark holding one haplotype goes straight to its details;
            // a crowd has to be narrowed down first.
            pgpSelected = (members.length === 1) ? pgpKeyOf(members[0]) : null;
        }
        pgpDraw();
    });
}

// The spot behind a point.  Matched on the point's own id where it has one:
// two placements of one query can both land on the same haplotype, and then
// the haplotype name alone picks the wrong row.
function pgpSpotFor(p) {
    var list = pgpSpots || [];
    var id = (p && typeof p === "object") ? p.id : null;
    var hap = (p && typeof p === "object") ? p.hap : p;
    var i;
    if (id) {
        for (i = 0; i < list.length; i++) {
            if (list[i].id === id) { return list[i]; }
        }
    }
    for (i = 0; i < list.length; i++) {
        if (list[i].hap === hap) { return list[i]; }
    }
    return null;
}

// A hit's fill: the authors' colour for its coordinate where the file gave one,
// and a plain light fill where it did not, so a mark is never invisible.
function pgpFill(p) {
    return (p && typeof p.rgb === "string" && /^[0-9]+,[0-9]+,[0-9]+$/.test(p.rgb)) ?
           "rgb(" + p.rgb + ")" : "#ffffff";
}

function pgpTipHtml(m) {
    var coord = "PC1 " + pgpFmtNum(m.px) + ", PC2 " + pgpFmtNum(m.py);
    if (!m.hit) {
        // A reference haplotype: which one, and where.  Its population is
        // left out with the rest of the labels.
        return "<b>" + pg.esc(m.name) + "</b> (reference)<br>" +
               '<span style="color:#5b6572">' + coord + "</span>";
    }
    if (m.group && m.group.members.length > 1) {
        var names = m.group.members.slice(0, 4).map(function (x) {
            return pg.esc(x.hap); }).join(", ");
        var more = m.group.members.length - 4;
        return "<b>" + m.group.members.length + " haplotypes here</b><br>" +
               names + (more > 0 ? ", and " + more + " more" : "") +
               '<br><span style="color:#5b6572">' + coord +
               " \u2014 click to list them</span>";
    }
    var out = "<b>" + pg.esc(m.name) + "</b><br>" + coord +
              '<br><span style="color:#5b6572">pcLAI confidence ' + m.conf +
              "/1000</span>";
    if (m.spot) {
        // Where this haplotype was read, which is its own match and not a
        // position shared with the others.
        out += '<br><span style="color:#5b6572">' + pg.esc(m.spot.contig) + ":" +
               (m.spot.start + 1).toLocaleString() + "-" +
               m.spot.end.toLocaleString() + "</span>";
    }
    return out;
}

// How the plotted haplotypes spread along each axis, as bars on the plot's top
// and right edges.  Marks gather into groups and the cloud can hide them; a bar
// still counts every haplotype at that value.  One count scale for both axes,
// so the two can be compared.
var PGP_MARG_BINS = 28;
function pgpMarginals(pts, s) {
    var count = function (vals, lo, hi) {
        var c = [], i;
        for (i = 0; i < PGP_MARG_BINS; i++) { c.push(0); }
        vals.forEach(function (v) {
            c[Math.max(0, Math.min(PGP_MARG_BINS - 1,
                                   Math.floor((v - lo) / (hi - lo) * PGP_MARG_BINS)))]++;
        });
        return c;
    };
    var cx = count(pts.map(function (p) { return p.x; }), s.x0, s.x1);
    var cy = count(pts.map(function (p) { return p.y; }), s.y0, s.y1);
    var most = Math.max(1, Math.max.apply(null, cx.concat(cy)));
    var len = function (n) { return Math.max(1.5, PGP_MARG * n / most); };
    var tip = function (axis, a, b, n) {
        return '<title>' + axis + ' ' + pgpFmtNum(a.toFixed(2)) + ' to ' +
               pgpFmtNum(b.toFixed(2)) + ': ' + n + ' ' + pgpLegend.many + '</title>';
    };
    var top = PGP_T - 6, side = PGP_W - PGP_R + 6;
    var o = ['<g id="pgpMarginals" fill="#5b6572">'];
    o.push('<line x1="' + PGP_L + '" y1="' + top + '" x2="' + (PGP_W - PGP_R) + '" y2="' +
           top + '" stroke="#c9ced4"/>');
    o.push('<line x1="' + side + '" y1="' + PGP_T + '" x2="' + side + '" y2="' +
           (PGP_H - PGP_B) + '" stroke="#c9ced4"/>');
    var stepX = (s.x1 - s.x0) / PGP_MARG_BINS, stepY = (s.y1 - s.y0) / PGP_MARG_BINS;
    cx.forEach(function (n, i) {
        if (!n) { return; }
        var a = s.x0 + i * stepX, x0 = s.X(a), w = s.X(a + stepX) - x0, h = len(n);
        o.push('<rect x="' + (x0 + 0.5).toFixed(1) + '" y="' + (top - h).toFixed(1) +
               '" width="' + Math.max(1, w - 1).toFixed(1) + '" height="' + h.toFixed(1) +
               '">' + tip("PC1", a, a + stepX, n) + '</rect>');
    });
    cy.forEach(function (n, i) {
        if (!n) { return; }
        var a = s.y0 + i * stepY, y1 = s.Y(a + stepY), hgt = s.Y(a) - y1, w = len(n);
        o.push('<rect x="' + side + '" y="' + (y1 + 0.5).toFixed(1) + '" width="' +
               w.toFixed(1) + '" height="' + Math.max(1, hgt - 1).toFixed(1) + '">' +
               tip("PC2", a, a + stepY, n) + '</rect>');
    });
    o.push('</g>');
    return o.join("");
}

// The windows of one haplotype's region, read once and kept; the plot is drawn
// again when they arrive, if that haplotype is still the one selected.
function pgpReadWindows(key) {
    if (key in pgpWindows) { return; }
    var spot = null;
    (pgpSpots || []).forEach(function (sp) { if (pgpKeyOf(sp) === key) { spot = sp; } });
    if (spot === null) { pgpWindows[key] = []; return; }
    // Kept in the list it was asked for: a plot set up anew meanwhile has its
    // own, where this key may be another region.
    var store = pgpWindows;
    store[key] = null;
    pgpFetchOne([spot], true).then(function (r) {
        var p = r && r.points && r.points[0];
        store[key] = (p && p.windows) || [];
    }).catch(function () {
        store[key] = [];
    }).then(function () {
        if (store === pgpWindows && pgpSelected === key) { pgpDraw(); }
    });
}

function pgpDraw() {
    var host = pg.byId("pgrPclaiPlot");
    if (!host || !pgpData) { return; }
    if (!pgpData.panel) {
        // The cloud the points are drawn over: without it there is no plot.
        host.innerHTML = "<p>No ancestry plot: this server has no pcLAI reference panel.</p>";
        return;
    }
    var panel = pgpData.panel, all = pgpData.points || [];
    if (pgpMinCov === null) { pgpMinCov = pgpMinCovDefault(); }
    var pts = all.filter(pgpKeep);
    var dropped = all.length - pts.length;
    // pcLAI windows are built from SNPs, so a region with no SNPs - a
    // centromere above all - has no windows and no haplotype can be placed.
    // Say so, rather than drawing an empty reference cloud and leaving the
    // reader to wonder which of the two it is looking at.
    if (!pts.length && all.length) {
        // Filtered down to nothing, which is a different thing from having no
        // ancestry data: say which filter did it and leave the controls up.
        host.innerHTML = pgpControlsHtml(0, all.length, dropped) +
            "<p>No hit clears these filters. Lower the coverage floor, or " +
            "include every hit, to see more.</p>";
        pgpBindControls();
        return;
    }
    if (!pts.length) {
        host.innerHTML = "<p>None of these " + pgpData.asked + " haplotypes " +
            "has a pcLAI window where the query matched it. pcLAI windows " +
            "follow SNPs, so regions without them - centromeres and other " +
            "repeat-rich sequence - are not covered.</p>";
        return;
    }
    var s = pgpScales(panel, pts);
    var o = [];

    o.push('<svg width="' + PGP_W + '" height="' + PGP_H + '" viewBox="0 0 ' +
           PGP_W + ' ' + PGP_H + '" style="max-width:100%;height:auto" ' +
           'font-family="Helvetica,Arial,sans-serif">');
    o.push('<rect width="' + PGP_W + '" height="' + PGP_H + '" fill="#ffffff"/>');
    o.push('<text x="' + PGP_L + '" y="24" font-size="15" font-weight="600" fill="#1e2833">' +
           'Position in ancestry space</text>');
    // No shared locus to name: each haplotype is read where the query matched
    // it, in that assembly's own coordinates.
    o.push('<text x="' + PGP_L + '" y="41" font-size="11.5" fill="#5b6572">' +
           (dropped ? pts.length + ' of ' + all.length + ' plotted, ' + dropped +
                      ' filtered out'
                    : pts.length + ' of ' + pgpData.asked + ' ' + pgpLegend.many +
                      ' placed') + '</text>');
    // Dispersion: how far apart the hits are, against the reference panel as a
    // yardstick.  Tight means the sequence sits in one part of the space;
    // broad means it is carried right across it.
    var sp = pgpSpread(pts);
    var ref = pgpSpread((panel.points || []).map(function (p) {
                  return {x: p[0], y: p[1]}; }));
    if (sp !== null && sp.n >= 2 && ref !== null && ref.rms > 0) {
        o.push('<text x="' + PGP_L + '" y="' + PGP_DISP_Y +
               '" font-size="11" fill="#1e2833">Dispersion ' + sp.rms.toFixed(3) +
               ', ' + Math.round(sp.rms / ref.rms * 100) + "% of the reference " +
               "panel's</text>");
    }

    // The space itself, in pcLAI's colours, so a mark's fill reads as where it
    // is: the same colour as the ground under it, only stronger.
    var field = pgpField(s);
    if (field) {
        o.push('<image href="' + field + '" x="' + PGP_L + '" y="' + PGP_T +
               '" width="' + (PGP_W - PGP_L - PGP_R) + '" height="' +
               (PGP_H - PGP_T - PGP_B) + '" preserveAspectRatio="none" opacity="0.38"/>');
    }
    var gridInk = field ? '" stroke="#ffffff" stroke-opacity="0.75"/>' : '" stroke="#ececec"/>';
    pgpTicks(s.x0, s.x1).forEach(function (t) {
        o.push('<line x1="' + s.X(t).toFixed(1) + '" y1="' + PGP_T + '" x2="' +
               s.X(t).toFixed(1) + '" y2="' + (PGP_H - PGP_B) + gridInk);
        o.push('<text x="' + s.X(t).toFixed(1) + '" y="' + PGP_TICK_Y +
               '" font-size="10.5" fill="#5b6572" text-anchor="middle">' + t + '</text>');
    });
    pgpTicks(s.y0, s.y1).forEach(function (t) {
        o.push('<line x1="' + PGP_L + '" y1="' + s.Y(t).toFixed(1) + '" x2="' +
               (PGP_W - PGP_R) + '" y2="' + s.Y(t).toFixed(1) + gridInk);
        o.push('<text x="' + (PGP_L - 8) + '" y="' + (s.Y(t) + 3.5).toFixed(1) +
               '" font-size="10.5" fill="#5b6572" text-anchor="end">' + t + '</text>');
    });
    o.push('<text x="' + ((PGP_L + PGP_W - PGP_R) / 2).toFixed(0) + '" y="' + PGP_AXIS_Y +
           '" font-size="11.5" fill="#1e2833" text-anchor="middle">PC1</text>');
    o.push('<text transform="translate(17,' + ((PGP_T + PGP_H - PGP_B) / 2).toFixed(0) +
           ') rotate(-90)" font-size="11.5" fill="#1e2833" text-anchor="middle">PC2</text>');

    // The reference cloud, all one neutral ink: where the panel's haplotypes
    // sit is the information, and colour already means position.
    o.push('<g fill="#2b333d" opacity="0.45">');
    panel.points.forEach(function (p) {
        o.push('<circle cx="' + s.X(p[0]).toFixed(1) + '" cy="' + s.Y(p[1]).toFixed(1) +
               '" r="1.6"/>');
    });
    o.push('</g>');
    o.push(pgpMarginals(pts, s));

    // The centroid of the hits, under them so it never hides one.
    if (sp !== null && sp.n >= 2) {
        var ccx = s.X(sp.cx).toFixed(1), ccy = s.Y(sp.cy).toFixed(1);
        o.push('<line x1="' + (ccx - 5) + '" y1="' + ccy + '" x2="' + (+ccx + 5) +
               '" y2="' + ccy + '" stroke="#1e2833" stroke-width="1.2" opacity="0.7"/>');
        o.push('<line x1="' + ccx + '" y1="' + (ccy - 5) + '" x2="' + ccx +
               '" y2="' + (+ccy + 5) + '" stroke="#1e2833" stroke-width="1.2" opacity="0.7"/>');
    }

    // One mark per hit.  The fill is the authors' own colour for that
    // coordinate, straight out of the bigBed's itemRgb - so two haplotypes at
    // the same place in the space are the same colour, and the spread of
    // colour across the marks is the dispersion in another form.  The dark
    // ring keeps a mark findable whatever colour it carries.
    // The selected haplotype's own windows, where its region crosses more than
    // one: its mark is the window covering most of the region, and these are
    // the rest, joined in order along the genome.
    var trail = (pgpSelected !== null) ? pgpWindows[pgpSelected] : null;
    if (trail && trail.length > 1) {
        o.push('<g id="pgpTrail"><polyline fill="none" stroke="#1e2833" stroke-width="1.2" ' +
               'stroke-opacity="0.7" points="' + trail.map(function (w) {
                   return s.X(w.x).toFixed(1) + "," + s.Y(w.y).toFixed(1); }).join(" ") + '"/>');
        trail.forEach(function (w) {
            o.push('<circle cx="' + s.X(w.x).toFixed(1) + '" cy="' + s.Y(w.y).toFixed(1) +
                   '" r="3" fill="' + pgpFill(w) + '" stroke="#1e2833" stroke-width="1"/>');
        });
        o.push('</g>');
    }

    o.push('<g id="pgrPclaiHits">');
    // Biggest first, so a large group never covers a small one drawn under it.
    var groups = pgpGroups(pts, s).slice().sort(function (a, b) {
        return b.members.length - a.members.length;
    });
    groups.forEach(function (g) {
        var r = pgpGroupR(g.members.length);
        var cx = g.x.toFixed(1), cy = g.y.toFixed(1);
        var sel = g.members.some(function (m) { return pgpKeyOf(m) === pgpSelected; });
        // The open ring marks the group whose details are showing.  Drawn
        // outside the mark rather than changing it, so a group that is both
        // ticked and selected still reads as ticked.
        if (sel) {
            o.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (r + 5) +
                   '" fill="none" stroke="#1664c0" stroke-width="2"/>');
        }
        // Ticking a row must be obvious at a glance: a thicker stroke alone is
        // a pixel of difference on a small mark.  The fill is left as pcLAI
        // coloured it - that is information - so the marker goes outside, as a
        // ring in the page's blue over a white halo, which reads against both
        // the pale background and a dense patch of cloud.
        if (g.picked) {
            o.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (r + 4).toFixed(1) +
                   '" fill="none" stroke="#ffffff" stroke-width="5"/>');
            o.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (r + 4).toFixed(1) +
                   '" fill="none" stroke="#1664c0" stroke-width="2.6"/>');
        }
        o.push('<circle class="pgrPclaiHit" data-haps="' +
               pg.esc(String(g.members.length)) + '" cx="' + cx + '" cy="' + cy +
               '" r="' + r.toFixed(1) + '" fill="' + pgpFill(g.rep) +
               '" fill-opacity="' + (g.members.length > 1 ? "0.85" : "1") +
               '" stroke="#1e2833" stroke-width="1.6"/>');
        // The count, once the mark is big enough to hold it legibly.
        if (g.members.length > 1 && r >= 10) {
            o.push('<text x="' + cx + '" y="' + (g.y + 3.6).toFixed(1) +
                   '" font-size="' + (r >= 14 ? 11 : 9.5) + '" font-weight="600" ' +
                   'fill="#1e2833" text-anchor="middle" style="pointer-events:none">' +
                   g.members.length + '</text>');
        }
    });
    o.push('</g>');

    // The names of the ticked haplotypes, last so that nothing is drawn over
    // them.  Pulling a mark out of the crowd is the whole point of ticking it,
    // and a ring says "this one" while a name says which one.
    o.push('<g id="pgrPclaiPicks">');
    groups.filter(function (g) { return g.picked; }).forEach(function (g) {
        var picked = g.members.filter(function (m) { return !!pgpPicked[m.hap]; });
        var label = picked.slice(0, 2).map(function (m) { return m.hap; }).join(", ");
        if (picked.length > 2) { label += " +" + (picked.length - 2); }
        var r = pgpGroupR(g.members.length) + 8;
        // Flip to the left of the mark rather than run under the legend.
        var right = g.x + r + 90 < PGP_W - PGP_R;
        // The halo is a second copy of the text underneath, stroke only, rather
        // than paint-order="stroke" on one element: browsers honour paint-order
        // but librsvg 2.50 does not, and there it paints the halo OVER the
        // glyphs and the label disappears.  Two elements work everywhere.
        var lx2 = (g.x + (right ? r : -r)).toFixed(1);
        var ly2 = (g.y + 3.6).toFixed(1);
        var common = ' y="' + ly2 + '" font-size="10.5" font-weight="600" ' +
                     'text-anchor="' + (right ? "start" : "end") + '" ' +
                     'style="pointer-events:none"';
        o.push('<text x="' + lx2 + '"' + common + ' fill="none" ' +
               'stroke="#ffffff" stroke-width="3" stroke-linejoin="round">' +
               pg.esc(label) + '</text>');
        o.push('<text x="' + lx2 + '"' + common + ' fill="#1664c0">' +
               pg.esc(label) + '</text>');
    });
    o.push('</g>');

    // The key: our marks and nothing else.
    var lx = PGP_W - PGP_R + 54, ly = PGP_T + 4;
    var keyText = function (x, y, text) {
        o.push('<text x="' + x + '" y="' + y + '" font-size="10" fill="#1e2833">' +
               pg.esc(text) + '</text>');
    };
    var hitInk = 'rgb(' + pgpLabRgb(sp.cx, sp.cy).join(",") + ')';
    o.push('<circle cx="' + (lx + 5) + '" cy="' + ly + '" r="1.9" fill="#2b333d" opacity="0.55"/>');
    keyText(lx + 18, ly + 3.5, "a reference haplotype");
    o.push('<circle cx="' + (lx + 5) + '" cy="' + (ly + 22) + '" r="5" fill="' + hitInk +
           '" stroke="#1e2833" stroke-width="1.6"/>');
    keyText(lx + 18, ly + 25.5, pgpLegend.hit);
    o.push('<circle cx="' + (lx + 5) + '" cy="' + (ly + 50) + '" r="9" fill="none" ' +
           'stroke="#1664c0" stroke-width="2.6"/>');
    o.push('<circle cx="' + (lx + 5) + '" cy="' + (ly + 50) + '" r="5" fill="' + hitInk +
           '" stroke="#1e2833" stroke-width="1.6"/>');
    keyText(lx + 18, ly + 53.5, pgpLegend.pick);
    o.push('<circle cx="' + (lx + 5) + '" cy="' + (ly + 80) + '" r="11" fill="' + hitInk +
           '" fill-opacity="0.85" stroke="#1e2833" stroke-width="1.6"/>');
    o.push('<text x="' + (lx + 5) + '" y="' + (ly + 83.6) + '" font-size="9.5" ' +
           'font-weight="600" fill="#1e2833" text-anchor="middle">n</text>');
    keyText(lx + 22, ly + 83.5, "n of them, too close to split");
    o.push('<path d="M' + lx + ' ' + (ly + 108) + 'h10M' + (lx + 5) + ' ' + (ly + 103) +
           'v10" stroke="#1e2833" stroke-width="1.2"/>');
    keyText(lx + 18, ly + 111.5, "the centre of the " + pgpLegend.many);
    o.push('<rect x="' + lx + '" y="' + (ly + 124) + '" width="3" height="10" fill="#5b6572"/>' +
           '<rect x="' + (lx + 4) + '" y="' + (ly + 128) + '" width="3" height="6" fill="#5b6572"/>' +
           '<rect x="' + (lx + 8) + '" y="' + (ly + 121) + '" width="3" height="13" fill="#5b6572"/>');
    keyText(lx + 18, ly + 133.5, "how many sit at each value");
    o.push('<text x="' + lx + '" y="' + (ly + 160) + '" font-size="9.6" fill="#5b6572">' +
           "Colour is pcLAI's own for each</text>");
    o.push('<text x="' + lx + '" y="' + (ly + 172) + '" font-size="9.6" fill="#5b6572">' +
           'position, as its tracks paint it.</text>');
    o.push('<text x="' + lx + '" y="' + (ly + 192) + '" font-size="9.6" fill="#5b6572">' +
           'Click a mark for details.</text>');
    o.push('</svg>');

    // The panel sits below the plot rather than beside it: the legend already
    // owns the right-hand strip, and below keeps the plot from reflowing when a
    // haplotype is picked or let go.
    host.innerHTML = pgpControlsHtml(pts.length, all.length, dropped) +
                     '<div id="pgpPlotWrap" style="position:relative;' +
                     'display:inline-block;max-width:100%">' + o.join("") + '</div>' +
                     pgpDetailHtml();
    pgpBindControls();
    if (pgpSelected !== null) { pgpReadWindows(pgpSelected); }
    pgpBuildIndex(panel, pts, s);
    pgpAttachHover(pg.byId("pgpPlotWrap"));

    // The list in the panel sits outside the plot, so its own clicks are
    // caught here.  Assigned rather than added, so a redraw cannot stack it.
    // Anything else is left to bubble: the results page's delegation is what
    // answers the browser and alignment links.
    host.onclick = function (ev) {
        var a = ev.target.closest ? ev.target.closest("a[data-pgp-hap]") : null;
        if (!a) { return; }
        ev.preventDefault();
        var hap = a.getAttribute("data-pgp-hap");
        pgpSelected = (hap === "") ? null : hap;       // "" steps back to the list
        pgpDraw();
    };
}

// The filters, stated as controls rather than applied silently.  Rebuilt on
// every draw, so their markup carries the current values and nothing has to be
// kept in sync with the DOM.
function pgpControlsHtml(shown, total, dropped) {
    var o = ['<div id="pgpControls" class="pgpControls">'];
    // Only where the points have a coverage to filter on: PanLift's targets
    // are regions, not hits, and have none.
    if ((pgpSpots || []).some(function (s) { return s.coverage != null; })) {
        o.push('<label class="pgpCtl">Plot hits covering at least ' +
               '<input id="pgpCovFloor" type="number" min="0" max="100" step="5" ' +
               'value="' + pgpMinCov + '"> % of the query</label>');
    }
    if (pgpHasPlacements()) {
        // A query that maps to several loci gets one set of haplotypes per
        // locus.  Their ancestry is read at different places in the genome, so
        // plotting them together averages positions that have nothing to do
        // with each other - the best placement alone is the default.
        o.push('<label class="pgpCtl"><input id="pgpBestOnly" type="checkbox"' +
               (pgpBestOnly ? ' checked' : '') + '> Best hit only</label>');
    }
    if (dropped > 0) {
        o.push('<span class="pgpCtlNote">' + shown + ' of ' + total + ' shown, ' +
               dropped + ' filtered out (still listed in the table)</span>');
    }
    if (pgpData && pgpData.failed) {
        o.push('<span class="pgpCtlNote">' + pgpData.failed + ' ' + pg.esc(pgpLegend.many) +
               ' could not be read and are not plotted</span>');
    }
    o.push('</div>');
    return o.join("");
}

function pgpBindControls() {
    var cov = pg.byId("pgpCovFloor");
    if (cov) {
        // "change", not "input": retyping a two-digit floor would otherwise
        // redraw at the intermediate value.
        cov.addEventListener("change", function () {
            var v = parseFloat(cov.value);
            pgpMinCov = (isNaN(v) || v < 0) ? 0 : Math.min(100, v);
            pgpDraw();
        });
    }
    var best = pg.byId("pgpBestOnly");
    if (best) {
        best.addEventListener("change", function () {
            pgpBestOnly = !!best.checked;
            pgpDraw();
        });
    }
}

// The details of the selected haplotype.  The figures come from the results
// page with the spot, so they read exactly as the table's do; what is added
// here is the part only the plot knows - where the haplotype sits in ancestry
// space and how confident pcLAI is about that.
function pgpSwatch(p) {
    // The authors' colour for this coordinate - the same one the dot carries and
    // the same one the pcLAI tracks paint with.
    return '<span class="pgpSwatch" style="background:' + pgpFill(p) + '"></span>';
}

function pgpDetailHtml() {
    // A crowded mark lists what it holds, so a haplotype that cannot be aimed
    // at in the plot can still be reached in two clicks.
    if (pgpSelected === null && pgpSelGroup !== null && pgpSelGroup.length > 1) {
        var g = ['<div id="pgpDetail" class="pgpDetail">'];
        g.push('<div class="dhead"><span class="loc">' + pgpSelGroup.length +
               ' haplotypes at this point</span><span class="lab">They sit within ' +
               PGP_GROUP_R + ' units of one another, closer than one mark is wide. ' +
               'Pick one for its details.</span></div>');
        g.push('<div class="pgpGroupList">');
        pgpSelGroup.slice().sort(function (a, b) {
            return a.hap < b.hap ? -1 : (a.hap > b.hap ? 1 : 0);
        }).forEach(function (m) {
            g.push('<a href="#" data-pgp-hap="' + pg.esc(pgpKeyOf(m)) + '">' +
                   pgpSwatch(m) + pg.esc(m.hap) + '</a>');
        });
        g.push('</div></div>');
        return g.join("");
    }
    if (pgpSelected === null) { return ""; }
    var point = null;
    ((pgpData && pgpData.points) || []).forEach(function (p) {
        if (pgpKeyOf(p) === pgpSelected) { point = p; }
    });
    var spot = pgpSpotFor(point || pgpSelected);

    // The same tiles as the results page's detail panel (.pgrTile), so a dot
    // and a row answer in the same form.
    var tiles = [];
    function tile(k, v) {
        tiles.push('<div class="pgrTile"><div class="k">' + pg.esc(k) +
                   '</div><div class="v">' + v + '</div></div>');
    }
    if (point !== null) {
        tile("Position", pgpSwatch(point) + "PC1 " + pgpFmtNum(point.x) + ", PC2 " +
                         pgpFmtNum(point.y));
        tile("Confidence", point.conf + "/1000");
        // Where the region is long enough to cross windows, how far apart
        // they are: one position for the whole of it, or several.
        var wins = pgpWindows[pgpSelected];
        if (wins === null) {
            tile("pcLAI windows", "reading\u2026");
        } else if (wins && wins.length === 1) {
            tile("pcLAI windows", "1");
        } else if (wins && wins.length > 1) {
            tile("pcLAI windows", wins.length + " (the line), dispersion " +
                 pgpSpread(wins).rms.toFixed(3));
        }
        // Where this haplotype sits relative to the rest of the hits, which is
        // the dispersion read one haplotype at a time.
        var sp = pgpSpread(pgpData.points || []);
        if (sp !== null && sp.n >= 2) {
            var d = Math.sqrt(Math.pow(point.x - sp.cx, 2) + Math.pow(point.y - sp.cy, 2));
            tile("From the centre", d.toFixed(3) + " (dispersion " + sp.rms.toFixed(3) + ")");
        }
    }
    ((spot && spot.info) || []).forEach(function (pair) { tile(pair[0], pg.esc(pair[1])); });

    var o = ['<div id="pgpDetail" class="pgpDetail">'];
    o.push('<div class="dhead"><span class="lab">Selected</span><span class="loc">' +
           pg.esc((spot && spot.hap) || pgpSelected) + '</span></div>');
    o.push('<div class="pgrDetailCard"><div class="pgrTiles">' + tiles.join("") + '</div></div>');
    // The same links the table rows carry, answered by the results page's own
    // click delegation - the plot does not need to know how a lift is armed.
    if (spot && spot.rank != null) {
        o.push('<div class="pgrDetailActions">' +
               '<a class="gbPill primary" href="#" data-rank="' + spot.rank +
               '" data-act="browser">View in Genome Browser</a>' +
               '<a class="gbPill" href="#" data-rank="' + spot.rank +
               '" data-act="details">Alignment</a>' +
               ((pgpSelGroup !== null && pgpSelGroup.length > 1) ?
                '<a class="gbPill" href="#" data-pgp-hap="">\u2039 The ' +
                  pgpSelGroup.length + ' here</a>' : "") +
               '</div>');
    } else if (spot && spot.url) {
        // A page with no table to delegate to gives the spot its own link.  With
        // an openId the page answers the click itself - PanLift sends it to the
        // region's own link, so the plot opens exactly what the card does.
        o.push('<div class="pgrDetailActions"><a class="gbPill primary" href="' +
               pg.esc(spot.url) + '"' +
               (spot.openId ? ' data-pgp-open="' + pg.esc(spot.openId) + '"' : '') +
               '>View in Genome Browser</a></div>');
    }
    o.push('</div>');
    return o.join("");
}

// ---- wiring -----------------------------------------------------------------

// Ticking a row bolds its point, and vice versa, without refetching anything.
function pgpTogglePick(hap, on) {
    if (on) { pgpPicked[hap] = true; } else { delete pgpPicked[hap]; }
    pgpDraw();
}

function pgpOpen(spots) {
    var host = pg.byId("pgrPclaiPlot");
    if (!host) { return; }
    host.style.display = "";
    if (pgpData) { pgpDraw(); return; }
    host.innerHTML = "<p>Reading ancestry coordinates…</p>";
    var gen = pgpGen;
    if (pgpOpening === gen) { return; }        // already being read: a second click on the button
    pgpOpening = gen;
    pgpFetch(spots).then(function (resp) {
        if (gen !== pgpGen) { return; }        // an answer for rows or regions no longer shown
        pgpOpening = -1;
        if (!resp || resp.status === "error") {
            throw new Error((resp && resp.error) || "server error");
        }
        pgpData = resp;
        pgpDataSpots = spots;
        pgpDraw();
        // The table gained rows while this was being read.
        if (pgpSpots !== spots) { pgpUpdate(pgpSpots); }
    }).catch(function (err) {
        if (gen !== pgpGen) { return; }
        pgpOpening = -1;
        host.innerHTML = "<p>Could not load the ancestry plot: " +
                         pg.esc(err.message) + "</p>";
    });
}

// The table's new spots, once more of its rows are placed, for a plot already
// set up.  Only the spots not read yet are asked about, and an open plot keeps
// its drawing until the answer is in, so the page around it does not move.
function pgpUpdate(spots) {
    // Told apart by when it was asked for, not by when its turn comes: the
    // table can be drawn anew, with other rows, while this waits in the queue
    // or for its answer, and the plot of the new table starts from nothing.
    var gen = pgpGen;
    pgpUpdating = pgpUpdating.then(function () {
        if (gen !== pgpGen) { return; }
        pgpSpots = spots;
        var old = pgpData;
        if (!old || !pgpDataSpots) { return; }     // not read yet: opening reads them all
        var had = Object.create(null), wanted = Object.create(null);
        pgpDataSpots.forEach(function (sp) { had[pgpKeyOf(sp)] = true; });
        spots.forEach(function (sp) { wanted[pgpKeyOf(sp)] = true; });
        var gone = Object.keys(had).filter(function (k) { return !wanted[k]; }).length;
        var fresh = spots.filter(function (sp) { return !had[pgpKeyOf(sp)]; });
        var keep = (old.points || []).filter(function (pt) { return wanted[pgpKeyOf(pt)]; });
        var done = function (resp) {
            pgpData = { status: "ok", panel: old.panel || (resp && resp.panel),
                        failed: (old.failed || 0) + ((resp && resp.failed) || 0),
                        points: keep.concat((resp && resp.points) || []),
                        asked: Math.max(0, (old.asked || 0) - gone) + ((resp && resp.asked) || 0),
                        found: keep.length + ((resp && resp.found) || 0) };
            pgpDataSpots = spots;
            var host = pg.byId("pgrPclaiPlot");
            if (host && host.style.display === "") {
                // Drawn again in place: what follows the plot stays where it
                // was on screen, whatever the browser's scroll anchoring makes
                // of the old drawing going.
                var below = host.getBoundingClientRect().bottom;
                pgpDraw();
                var moved = host.getBoundingClientRect().bottom - below;
                if (Math.abs(moved) >= 1) { window.scrollBy(0, moved); }
            }
        };
        if (!fresh.length) { done(null); return; }
        return pgpFetch(fresh).then(function (resp) {
            return (resp && resp.status === "ok") ? resp : null;
        }, function () {
            return null;
        }).then(function (resp) {
            if (gen !== pgpGen) { return; }
            // Not read: the plot stays as it is and stays in use, and says how
            // many it is missing, as it does for a batch that failed.
            done(resp || { failed: fresh.length });
        });
    });
    return pgpUpdating;
}

// Called by the results page with one spot per plottable hit.  Returns false
// when there is nothing to plot, so the caller can leave the control and the
// checkbox column out entirely.
//   opts.legend - {hit, pick, many}: what the page calls its points
//   opts.fresh  - these are other regions than the last call's, not more of
//                 the same: nothing chosen or read for those carries over
//   opts.picked - the haplotypes to ring from the start, with opts.fresh
function pgpInit(spots, opts) {
    if (!spots || !spots.length) { return false; }
    // Called again when the table gains placements; what was read for the
    // old rows does not cover the new ones, and what is still being read for
    // them is not waited for.
    pgpData = null;
    pgpDataSpots = null;
    pgpGen++;
    if (opts && opts.fresh) {
        // PanLift draws each conversion with the same ids, so what was open
        // for one would show on another's haplotype.
        pgpWindows = Object.create(null);
        pgpSelected = null;
        pgpSelGroup = null;
        pgpPicked = Object.create(null);
        pgpUpdating = Promise.resolve();
        (opts.picked || []).forEach(function (hap) { pgpPicked[hap] = true; });
    }
    if (opts && opts.legend) {
        pgpLegend = { hit: opts.legend.hit || pgpLegend.hit,
                      pick: opts.legend.pick || pgpLegend.pick,
                      many: opts.legend.many || pgpLegend.many };
    }
    pgpSpots = spots;
    var btn = pg.byId("pgrPclaiBtn");
    if (btn) {
        btn.addEventListener("click", function (e) {
            e.preventDefault();
            var host = pg.byId("pgrPclaiPlot");
            if (host && host.style.display === "" && pgpData) {
                host.style.display = "none";
                btn.textContent = "Show ancestry plot";
                return;
            }
            btn.textContent = "Hide ancestry plot";
            pgpOpen(pgpSpots);
        });
    }
    return true;
}

window.pangenomePlot = {
    init: pgpInit,
    update: pgpUpdate,
    togglePick: pgpTogglePick,
    isPicked: function (hap) { return pgpPicked[hap] === true; }
};

}());
