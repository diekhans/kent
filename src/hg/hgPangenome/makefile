kentSrc = ../..
include ../../inc/common.mk

L += ${MYSQLLIBS} -lm
MYLIBDIR = ../../lib/${MACHTYPE}
MYLIBS =  ${MYLIBDIR}/jkhgap.a ${MYLIBDIR}/jkweb.a

A = hgPangenome

O = $A.o ancestryLocus.o liftedTracks.o proxy.o seqTrack.o

include ../../inc/cgi_build_rules.mk

compile: $O
	${CC} $O ${MYLIBS} ${L}
	mv ${AOUT} $A${EXE}

# "make test" here runs the suite in tests/, which builds the CGI from this
# tree and, if there was none here before, removes it again.  See tests/README.
#
# "make test" in src/hg comes here too (TEST_DIRS there).  So a layer that
# cannot run on this machine - the JavaScript ones need node 18 or later - is
# said and let go, as the js makefile lets jshint go where there is no node.
# A test that fails still stops the run.  "make test" in tests/ itself is
# strict about both.
test::
	cd tests && PG_ALLOW_NOT_RUN=1 ${MAKE} test
