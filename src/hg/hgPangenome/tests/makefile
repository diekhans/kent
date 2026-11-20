kentSrc = ../../..
include ../../../inc/common.mk

# Tests for PanView and PanLift.  "make test" builds the CGI from this tree,
# without installing it, runs every layer against it and removes it again.  It
# contacts no network, no MySQL, no live middleware and no bottleneck server.
# A layer that cannot run (no node, say) is reported as NOT RUN and the suite
# does not pass.
#
# The CGI is removed only if it was not there before: "make compile" leaves one
# in the directory, and that one is not this makefile's to take away.  NODEBIN
# is where common.mk found node, for a machine that has none on its PATH.
runSuite = had=no; [ -e ../hgPangenome ] && had=yes; \
	(cd .. && ${MAKE} compile) || exit 1; \
	$(1) NODEBIN=${NODEBIN} PG_CGI=../hgPangenome ./runTests.sh; status=$$?; \
	[ $$had = yes ] || rm -f ../hgPangenome; exit $$status

test::
	$(call runSuite,)

# The same, plus the checks on the commands that run inside the cart
# (quickLift, refAnnot, alignTrack).  Those need the browser's central
# database, taken from your hg.conf, and each request starts a session row
# there, which is why they are not in "make test".
testWithDb::
	$(call runSuite,PG_DB_TESTS=1)

# Refresh the generated haplotype -> UCSC assembly table from the published
# HPRC index, then re-run the tests that depend on it.
updateAssemblies::
	(cd .. && ./makeAssemblyMap.py)
	${MAKE} test

help::
	@printf "makefile targets:\n\
test             - build the CGI from this tree and run every layer against it\n\
testWithDb       - the same, plus the cart commands (uses the central database)\n\
updateAssemblies - regenerate js/hgPangenomeAssemblies.js from the HPRC index, then test\n\
\n\
Individual layers:\n\
  node unitTests.js     pure-function unit tests (Layer 1)\n\
  node commonTests.js   what the scripts share, and the scripts as shipped\n\
  python3 cgiTests.py   the CGI against a mock graph server (Layer 2)\n\
  node formTests.js     the PanView search form (Layer 3)\n\
  node resultsTests.js  results page: cells, row order, download\n\
  node convertTests.js  PanLift\n\
  node plotTests.js     the ancestry plot both tools share\n\
\n\
To test a CGI you built yourself:  PG_CGI=/path/to/hgPangenome python3 cgiTests.py\n"

clean::
	rm -rf output
