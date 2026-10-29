kentSrc = ../../..
include ../../../inc/common.mk

# Tests for the pangenome mapping tool.  Everything here is self-contained: no
# network, no MySQL, no live middleware, no shared bottleneck server.  Layers
# whose tool is missing SKIP rather than fail, so "make test" is safe on a build
# machine that has no node (node is optional in kent, see NODEBIN in common.mk).

test::
	./runTests.sh

# The proxy layer needs the CGI binary.  This builds one here (without
# installing it) and runs the suite against it, then removes it again.
testWithCgi::
	(cd .. && ${MAKE} compile)
	PG_CGI=../hgPangenome ./runTests.sh; status=$$?; rm -f ../hgPangenome; exit $$status

# Refresh the generated haplotype -> UCSC assembly table from the published
# HPRC index, then re-run the tests that depend on it.
updateAssemblies::
	(cd .. && ./makeAssemblyMap.py)
	./runTests.sh

help::
	@printf "makefile targets:\n\
test             - run every layer that can run here (skips what needs missing tools)\n\
testWithCgi      - build a throwaway CGI binary first, so the proxy layer runs too\n\
updateAssemblies - regenerate js/hgPangenomeAssemblies.js from the HPRC index, then test\n\
\n\
Individual layers:\n\
  node unitTests.js     pure-function unit tests (Layer 1)\n\
  ./proxyTests.sh       CGI proxy tests against a mock middleware (Layer 2)\n\
  node renderTests.js   contract/rendering tests (Layer 3)\n\
  node resultsTests.js  results page: cells, row order, download\n\
\n\
To test a specific CGI binary:  PG_CGI=/path/to/hgPangenome ./proxyTests.sh\n"

clean::
	rm -rf output
