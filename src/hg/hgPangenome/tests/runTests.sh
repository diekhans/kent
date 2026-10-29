#!/bin/bash
# runTests.sh - run the hgPangenome test suite.
#
# Layers that need a tool which is not guaranteed on a build machine SKIP rather
# than fail:
#   node    - optional in kent (see NODEBIN in inc/common.mk); the JS layers skip
#   the CGI - built by "make compile" here, or set PG_CGI; the proxy layer skips
# So a machine with neither still exits 0, and a machine with both runs
# everything.  Nothing here contacts the network, the real middleware, MySQL, or
# the shared bottleneck server.
#
# Exit 0 = everything that could run, passed.

set -u
cd "$(dirname "$0")"

fail=0
skipped=""

# Check that node actually runs, not merely that something named node is on the
# PATH (a stub or a broken install would otherwise be treated as usable).
have_node=0
if node --version >/dev/null 2>&1; then
    have_node=1
fi

runJs() {                    # runJs <file> <description>
    if [ "$have_node" -eq 0 ]; then
        echo "SKIP: node not found, cannot run $1"
        skipped="$skipped $1"
        return 0
    fi
    node "$1" || fail=1
}

echo "############################################################"
echo "# Layer 1: unit tests (pure functions, no network, no DOM)  #"
echo "############################################################"
runJs unitTests.js

echo
echo "############################################################"
echo "# Layer 2: CGI proxy tests (mock middleware, isolated conf) #"
echo "############################################################"
./proxyTests.sh || fail=1

echo
echo "############################################################"
echo "# Layer 3: contract/rendering tests (canned fixtures)       #"
echo "############################################################"
runJs renderTests.js

echo
echo "############################################################"
echo "# Results page: cells, row order, download                  #"
echo "############################################################"
runJs resultsTests.js

echo
echo "############################################################"
echo "# Coordinate conversion page (canned responses)             #"
echo "############################################################"
runJs convertTests.js

# --- Layer 4 hook (needs the live middleware) ---
# [ -f e2eTests.sh ] && { ./e2eTests.sh || fail=1; }

echo
if [ -n "$skipped" ]; then
    echo "SKIPPED (missing tools):$skipped"
fi
if [ "$fail" -eq 0 ]; then
    echo "SUITE RESULT: PASS"
else
    echo "SUITE RESULT: FAIL"
fi
exit $fail
