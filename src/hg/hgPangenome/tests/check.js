/* check.js - what the test files share on top of Node's own test runner.
 *
 * A test file is one top-level test, and each of its checks is a subtest, run
 * where it is written: many of them look at a page that the lines between them
 * have just changed, so they cannot be collected first and run afterwards.
 * under(ctx) gives a file that, as t.suite() and t.test(), with assertions
 * that say what they expected and what they got.
 *
 *   var test = require('node:test');
 *   var check = require('./check.js');
 *   test('what the file tests', async function (ctx) {
 *       var t = check.under(ctx);
 *       t.suite('a group');
 *       await t.test('does a thing', function () { t.eq(actual, expected, 'label'); });
 *       await check.wait(20);       // let the page's requests settle
 *   });
 *
 * No npm packages: node:test and node:assert come with node.
 */

'use strict';

var assert = require('node:assert');

function fail(msg) {
    throw new assert.AssertionError({ message: msg, stackStartFn: fail });
}

function show(v) {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (v === undefined) return 'undefined';
    try {
        var s = JSON.stringify(v);
        return s === undefined ? String(v) : s;   // e.g. NaN, Infinity
    } catch (e) { return String(v); }
}

// The same value: numbers, strings, booleans, null, undefined.
function eq(actual, expected, label) {
    if (actual !== expected)
        fail((label || 'eq') + ': expected ' + show(expected) + ', got ' + show(actual));
}

// The same structure, compared as JSON.  Not node's deepStrictEqual: what a
// page script returns was made in the page's own context, whose Object and
// Array are not this file's, and deepStrictEqual holds that against it.
function deepEq(actual, expected, label) {
    var a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b)
        fail((label || 'deepEq') + ':\n    expected ' + b + '\n    got      ' + a);
}

function ok(cond, label) {
    if (!cond) fail((label || 'ok') + ': expected truthy, got ' + show(cond));
}

function notOk(cond, label) {
    if (cond) fail((label || 'notOk') + ': expected falsy, got ' + show(cond));
}

function isNull(v, label) {
    if (v !== null) fail((label || 'isNull') + ': expected null, got ' + show(v));
}

// A string that holds another: for messages.
function contains(haystack, needle, label) {
    if (typeof haystack !== 'string' || haystack.indexOf(needle) < 0)
        fail((label || 'contains') + ': expected ' + show(haystack) + ' to contain ' + show(needle));
}

// The checks of one file, under its top-level test.
function under(ctx) {
    var suite = '';
    return {
        suite: function (name) { suite = name; },
        test: function (name, fn) { return ctx.test(suite ? suite + ': ' + name : name, fn); },
        eq: eq, deepEq: deepEq, ok: ok, notOk: notOk, isNull: isNull, contains: contains, fail: fail
    };
}

// Let what a page has started - a request answered, a timer - come to rest.
function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

module.exports = { under: under, wait: wait };
