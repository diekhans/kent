#!/bin/bash
# runTests.sh - run the hgPangenome test suite.
#
# Use "make test", which first builds the CGI from this tree so that the CGI
# layer tests the source in front of you.  "make testWithDb" also runs the
# checks on the commands that live inside the cart; those use the browser's
# central database, so they are left out by default (PG_DB_TESTS=1).
#
# Nothing else here contacts the network, the real middleware, MySQL or the
# bottleneck server.
#
# A layer that cannot run - no node, no CGI built - is reported as NOT RUN and
# the suite does not pass.  A JS test file that stops before printing its
# count is a failure, not a pass.
#
# Exit 0 = every layer ran and passed.  1 = a test failed.  2 = no test
# failed, but a layer did not run.

set -u
cd "$(dirname "$0")"

NOT_RUN=77          # proxyTests.sh's "could not run"
summary=""          # one line a layer, printed at the end
failed=0
notRun=0

note() {            # note <layer> <result>
    summary="$summary$(printf '  %-22s %s' "$1" "$2")"$'\n'
}

have_node=0
if node --version >/dev/null 2>&1; then
    have_node=1
fi

banner() {
    echo
    echo "############################################################"
    echo "# $1"
    echo "############################################################"
}

runJs() {           # runJs <file> <layer name>
    banner "$2 ($1)"
    if [ "$have_node" -eq 0 ]; then
        echo "NOT RUN: node not found"
        note "$2" "NOT RUN (node not found)"
        notRun=1
        return
    fi
    local out status count
    out=$(mktemp "${TMPDIR:-/tmp}/pgTests.XXXXXX")
    node "$1" 2>&1 | tee "$out"
    status=${PIPESTATUS[0]}
    count=$(sed -n 's/^ALL PASSED: \([0-9]*\)\/[0-9]*$/\1/p' "$out" | tail -1)
    if [ "$status" -ne 0 ]; then
        note "$2" "FAIL ($(grep -c '^  FAIL ' "$out") failed)"
        failed=1
    elif [ -z "$count" ]; then
        # node left with 0 and no count: the file stopped part way through
        echo "FAIL: $1 ended without reporting its count"
        note "$2" "FAIL (ended without a count)"
        failed=1
    else
        note "$2" "pass  $count"
    fi
    rm -f "$out"
}

runCgi() {
    banner "CGI against a mock middleware (proxyTests.sh)"
    local out status count
    out=$(mktemp "${TMPDIR:-/tmp}/pgTests.XXXXXX")
    ./proxyTests.sh 2>&1 | tee "$out"
    status=${PIPESTATUS[0]}
    count=$(sed -n 's/^ALL PASSED: \([0-9]*\)\/[0-9]*$/\1/p' "$out" | tail -1)
    if [ "$status" -eq "$NOT_RUN" ]; then
        note "CGI" "NOT RUN ($(grep 'NOT RUN: ' "$out" | tail -1 | sed 's/.*NOT RUN: //'))"
        notRun=1
    elif [ "$status" -ne 0 ] || [ -z "$count" ]; then
        note "CGI" "FAIL ($(grep -c '^  FAIL ' "$out") failed)"
        failed=1
    elif [ "${PG_DB_TESTS:-0}" = "1" ]; then
        note "CGI" "pass  $count, the cart commands included"
    else
        note "CGI" "pass  $count, the cart commands left out (make testWithDb)"
    fi
    rm -f "$out"
}

runJs unitTests.js    "Pure functions"
runCgi
runJs formTests.js    "PanView form"
runJs resultsTests.js "PanView results"
runJs convertTests.js "PanLift"

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
    exit 2
fi
echo "SUITE RESULT: PASS"
exit 0
