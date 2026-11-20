#!/bin/bash
# runTests.sh - run the hgPangenome test suite.
#
# Use "make test", which first builds the CGI from this tree so that the CGI
# layer tests the source in front of you.  "make testWithDb" also runs the
# checks on the commands that live inside the cart; those use the browser's
# central database, so they are left out by default (PG_DB_TESTS=1).
#
# Nothing else here contacts the network, the real graph server, MySQL or the
# bottleneck server.
#
# The JavaScript files run on node's own test runner (node:test) and the CGI
# tests on python's (unittest); this script runs each and reads its verdict.
# A layer that cannot run - no node, no CGI built - is reported as NOT RUN and
# the suite does not pass.  A file that ends without a verdict is a failure,
# not a pass.
#
# Exit 0 = every layer ran and passed.  1 = a test failed.  2 = no test
# failed, but a layer did not run.
#
# With PG_ALLOW_NOT_RUN=1 the last of those is said and exits 0.  That is for
# "make test" in src/hg, which reaches this suite with the rest of the tree's:
# a machine with no node is not a tree with a failing test.

set -u
cd "$(dirname "$0")"

NOT_RUN=77          # cgiTests.py's "could not run"
summary=""          # one line a layer, printed at the end
failed=0
notRun=0

note() {            # note <layer> <result>
    summary="$summary$(printf '  %-22s %s' "$1" "$2")"$'\n'
}

banner() {
    echo
    echo "############################################################"
    echo "# $1"
    echo "############################################################"
}

# One number out of a runner's closing lines: node prints "pass 37" after a
# mark of its own, python "Ran 36 tests".
figure() {          # figure <file> <word before or after the number>
    sed -n "s/^.* $2 \([0-9][0-9]*\)$/\1/p; s/^Ran \([0-9][0-9]*\) $2.*$/\1/p; s/^\([0-9][0-9]*\) $2.*$/\1/p" "$1" | tail -1
}

runJs() {           # runJs <file> <layer name>
    banner "$2 ($1)"
    # node:test came with node 18; an older node would fail every file here
    # for a reason that has nothing to do with the code under test.
    if ! node -e "require('node:test')" >/dev/null 2>&1; then
        echo "NOT RUN: node not found, or too old to have node:test"
        note "$2" "NOT RUN (no node with node:test)"
        notRun=1
        return
    fi
    local out status passed
    out=$(mktemp "${TMPDIR:-/tmp}/pgTests.XXXXXX")
    node "$1" 2>&1 | tee "$out"
    status=${PIPESTATUS[0]}
    passed=$(figure "$out" pass)
    if [ "$status" -ne 0 ]; then
        note "$2" "FAIL ($(figure "$out" fail) failed)"
        failed=1
    elif [ -z "$passed" ]; then
        # node left with 0 and no verdict: the file stopped part way through
        echo "FAIL: $1 ended without a verdict"
        note "$2" "FAIL (ended without a verdict)"
        failed=1
    else
        note "$2" "pass  $passed"
    fi
    rm -f "$out"
}

runCgi() {
    banner "CGI against a mock graph server (cgiTests.py)"
    if ! python3 --version >/dev/null 2>&1; then
        echo "NOT RUN: python3 not found"
        note "CGI" "NOT RUN (python3 not found)"
        notRun=1
        return
    fi
    local out status tests checks
    out=$(mktemp "${TMPDIR:-/tmp}/pgTests.XXXXXX")
    python3 cgiTests.py 2>&1 | tee "$out"
    status=${PIPESTATUS[0]}
    tests=$(figure "$out" test)
    checks=$(figure "$out" checks)
    if [ "$status" -eq "$NOT_RUN" ]; then
        note "CGI" "NOT RUN ($(grep 'NOT RUN: ' "$out" | tail -1 | sed 's/.*NOT RUN: //'))"
        notRun=1
    elif [ "$status" -ne 0 ] || [ -z "$tests" ]; then
        note "CGI" "FAIL ($(grep -c '^FAIL: \|^ERROR: ' "$out") failed)"
        failed=1
    elif [ "${PG_DB_TESTS:-0}" = "1" ]; then
        note "CGI" "pass  $tests ($checks checks), the cart commands included"
    else
        note "CGI" "pass  $tests ($checks checks), the cart commands left out (make testWithDb)"
    fi
    rm -f "$out"
}

runJs unitTests.js    "Pure functions"
runJs commonTests.js  "Shared helpers"
runCgi
runJs formTests.js    "PanView form"
runJs resultsTests.js "PanView results"
runJs convertTests.js "PanLift"
runJs plotTests.js    "Ancestry plot"

echo
echo "============================================================"
printf '%s' "$summary"
echo "============================================================"
if [ "$failed" -ne 0 ]; then
    echo "SUITE RESULT: FAIL"
    exit 1
fi
if [ "$notRun" -ne 0 ]; then
    echo "SUITE RESULT: INCOMPLETE - nothing failed, but not everything ran"
    if [ "${PG_ALLOW_NOT_RUN:-}" = "1" ]; then
        echo "(let go: PG_ALLOW_NOT_RUN is set)"
        exit 0
    fi
    exit 2
fi
echo "SUITE RESULT: PASS"
exit 0
