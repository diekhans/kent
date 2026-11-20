/* hgPangenomeCommon.js - what the PanAlign and PanConvert scripts share.
 *
 * Loaded before a page's own script (hgPangenome.js, hgPangenomeResults.js,
 * hgPangenomeConvert.js, hgPangenomePclai.js), each of which reads it as
 * window.pangenomeCommon.  Nothing here knows about a page: these build
 * elements, format text, look a haplotype up in the generated tables
 * (hgPangenomeAssemblies.js, hgPangenomeSamples.js) and send a command to
 * this CGI.
 *
 * Copyright (C) 2026 The Regents of the University of California */

/* global window, document, fetch, URL, Blob, Promise */

(function () {
'use strict';

// ---- elements ----------------------------------------------------------------

function byId(id) { return document.getElementById(id); }

// el("a", { href: url, class: "x", text: "label" }, [children]).  "html" is
// only for strings the calling code built itself.
function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
        if (k === "class") {
            e.className = attrs[k];
        } else if (k === "text") {
            e.textContent = attrs[k];
        } else if (k === "html") {
            e.innerHTML = attrs[k];
        } else {
            e.setAttribute(k, attrs[k]);
        }
    });
    (kids || []).forEach(function (c) {
        if (c === null || c === undefined) { return; }
        e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
}

function clear(node) {
    while (node.firstChild) { node.removeChild(node.firstChild); }
}

// ---- text --------------------------------------------------------------------

// As htmlEncode() in utils.js, which is on every page this is.  Written here
// so that this file leans on no other script, and the tests can load it alone.
function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}

// 1234567 as "1,234,567"; nothing for a missing number.
function commas(n) {
    return (n === null || n === undefined || isNaN(n)) ? "" : Number(n).toLocaleString("en-US");
}

// ---- haplotypes --------------------------------------------------------------

// A haplotype is named in two shapes: with its sequence ("CHM13#0#chr10") and
// without ("CHM13#0").  Both are the same haplotype, "chm13#0", which is also
// how the generated tables are keyed.
function hapKey(name) {
    return String(name === null || name === undefined ? "" : name)
        .split("#").slice(0, 2).join("#").toLowerCase();
}

function lookUp(table, key) {
    return Object.prototype.hasOwnProperty.call(table || {}, key) ? table[key] : null;
}

// The UCSC assembly a haplotype is browsed in: a db, a GenArk accession, or
// the URL of a hub elsewhere for one that is only there.  Null when it has none.
function assemblyFor(name) {
    return lookUp(window.pangenomeAssemblies, hapKey(name));
}

// Does the graph name this assembly's sequences its own way?  It does HG002's:
// chr2 where the assembly says CP139519.2.  What comes back from the graph is
// matched up by the CGI; a page cannot name such a sequence to the graph.
function graphNamesDiffer(db) {
    return lookUp(window.pangenomeGraphNamesDiffer, db) === true;
}

// The name an assembly was published under, or null.
function assemblyName(db) {
    return lookUp(window.pangenomeAssemblyNames, db);
}

// An assembly served through a hub is known to the cart by a decorated name:
// hs1 arrives as "hub_25071_hs1".  The tables are keyed on the plain name.
function bareDb(db) {
    return String(db === null || db === undefined ? "" : db).replace(/^hub_[0-9]+_/, "");
}

// The population of a haplotype's sample as the HPRC describes it,
// { code: "GBR", desc: "British from England and Scotland" }, or null.
function population(hap) {
    var p = lookUp(window.pangenomeSamples, hapKey(hap).split("#")[0]);
    return p ? { code: p[0], desc: p[1] } : null;
}

// ---- requests ----------------------------------------------------------------
//
// A page talks only to this CGI, which passes the request on to the graph
// server; the server's address and token never reach the browser.

function formEncode(obj) {
    return Object.keys(obj).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]);
    }).join("&");
}

// The most a request may be, as it is sent: the body the CGI library reads at
// most (CGI_INPUT_SIZE_LIMIT_DEFAULT in cheapcgi.c).  Over that the library
// stops the CGI with an HTML error page before it can answer in its own way.
// The CGI's own limit is lower and on the payload once decoded
// (PG_MAX_REQUEST_BYTES), so whatever the search form lets through fits here;
// this is for a request that grew some other way.  A server that raised the
// library's limit (GB_CGI_INPUT_SIZE_LIMIT) is held to this one by the page.
var MAX_POST_BYTES = 1048576;

// POST cmd=<cmd>&payload=<json>.  With hgsid for a command that writes to the
// reader's own session.  Rejects, without sending, a request too large to send.
function post(cmd, payload, hgsid) {
    var fields = { cmd: cmd, payload: JSON.stringify(payload) };
    if (hgsid) { fields.hgsid = hgsid; }
    var body = formEncode(fields);
    if (body.length > MAX_POST_BYTES) {
        return Promise.reject(new Error("the request is too large: " + commas(body.length) +
                                        " bytes (limit " + commas(MAX_POST_BYTES) + ")"));
    }
    return fetch(window.location.pathname, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body
    });
}

function get(query) {
    return fetch(window.location.pathname + "?" + query, {
        method: "GET",
        headers: { Accept: "application/json" }
    });
}

// The two ways an answer is read.  json() names only the HTTP status when the
// request failed; jsonOrBody() adds the start of what the server said, for
// the pages that show it.
function json(resp) {
    if (!resp.ok) { throw new Error("HTTP " + resp.status); }
    return resp.json();
}

function jsonOrBody(resp) {
    if (!resp.ok) {
        return resp.text().then(function (t) {
            throw new Error("HTTP " + resp.status + (t ? ": " + t.slice(0, 300) : ""));
        });
    }
    return resp.json();
}

// ---- the reader's files and choices -----------------------------------------

function saveFile(text, fileName, mime) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Let go of the file a minute later, not at once: the browser may not have
    // started reading it yet, and a large download then stops short.
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
}

// Rows per page in a table: the reader's last choice on either tool, else 50.
function pageLen() {
    var v = null;
    try {
        v = parseInt(window.localStorage.getItem("hgPangenome.pageLen"), 10);
    } catch (e) {
        v = null;
    }
    return (v === -1 || v === 25 || v === 50 || v === 100) ? v : 50;
}

function keepPageLen(n) {
    try {
        window.localStorage.setItem("hgPangenome.pageLen", String(n));
    } catch (e) {
        /* this page only */
    }
}

window.pangenomeCommon = {
    byId: byId, el: el, clear: clear,
    esc: esc, commas: commas,
    hapKey: hapKey, assemblyFor: assemblyFor, assemblyName: assemblyName,
    graphNamesDiffer: graphNamesDiffer,
    bareDb: bareDb, population: population,
    formEncode: formEncode, post: post, get: get, json: json, jsonOrBody: jsonOrBody,
    saveFile: saveFile, pageLen: pageLen, keepPageLen: keepPageLen
};

}());
