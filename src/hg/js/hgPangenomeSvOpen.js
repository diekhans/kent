/* hgPangenomeSvOpen.js - the step from an SV's details page to one haplotype.
 *
 * The details page of an item on the HPRC v2.1 SV track lists the haplotypes
 * that carry it, each a link to hgPangenome?page=svOpen naming the SV's graph
 * site and the haplotype.  This page says what it is opening, asks the CGI to
 * translate the site onto the haplotype and carry the reference's tracks across
 * (cmd=svOpen), and replaces itself with the browser there.  If the tracks
 * cannot come, it offers the haplotype without them.
 *
 * Copyright (C) 2026 The Regents of the University of California */
/* global window, document, fetch */

(function () {
'use strict';

function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
        if (k === "text") e.textContent = attrs[k];
        else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
        if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
}

function say(kids) {
    var box = document.getElementById("pgsOpen");
    while (box.firstChild) box.removeChild(box.firstChild);
    kids.forEach(function (k) { box.appendChild(k); });
}

function back() {
    var a = el("a", { href: "#", text: "Back to the SV" });
    a.addEventListener("click", function (e) { e.preventDefault(); window.history.back(); });
    return a;
}

function open(o, withTracks) {
    var cfg = window.pangenomeConfig || {};
    var hapDb = (window.pangenomeAssemblies || {})[o.hap.toLowerCase()];
    if (!hapDb || /^https?:/.test(hapDb)) {
        say([el("p", { class: "pgWarn", text: o.hap + " is not an assembly the Genome Browser " +
                                              "can open by name." }), back()]);
        return;
    }
    var what = o.hap + " at " + (o.sv || "the SV") + "'s site" +
               (withTracks ? ", with your " + o.refLabel + " tracks" : "");
    say([el("p", { text: "Opening " + what + "…" })]);
    var payload = { db: o.db, chrom: o.chrom, start: o.start, end: o.end, hap: o.hap,
                    hapDb: hapDb, annot: withTracks ? "on" : "off" };
    var body = "cmd=svOpen&payload=" + encodeURIComponent(JSON.stringify(payload));
    if (cfg.hgsid) body += "&hgsid=" + encodeURIComponent(cfg.hgsid);
    fetch(window.location.pathname, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded",
                   Accept: "application/json" },
        body: body
    }).then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
    }).then(function (resp) {
        if (!resp || resp.status !== "ok" || !resp.url) {
            var e = new Error((resp && resp.error) || "no answer");
            e.stage = resp && resp.stage;
            throw e;
        }
        // Replaced, not added: Back from the browser returns to the SV.
        window.location.replace(resp.url);
    }).catch(function (err) {
        var kids = [el("p", { class: "pgWarn", text: "Could not open " + what + ": " +
                                                     err.message + "." })];
        // Without the tracks only helps when it was the tracks that failed;
        // a site with no counterpart on the haplotype has none either way.
        if (withTracks && err.stage !== "translate") {
            var plain = el("a", { href: "#", text: "Open " + o.hap + " without them" });
            plain.addEventListener("click", function (e) { e.preventDefault(); open(o, false); });
            kids.push(el("p", null, [plain]));
        }
        kids.push(back());
        say(kids);
    });
}

function init() {
    var o = window.pangenomeSvOpen;
    if (!o) return;
    if (!o.db || !o.chrom || !o.hap || !(o.start >= 0) || !(o.end > o.start) || !o.refLabel) {
        say([el("p", { class: "pgWarn", text: "This link does not name a haplotype and an SV " +
                                              "to open it at." })]);
        return;
    }
    open(o, !!o.quickLift);
}

if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
else
    init();
})();
