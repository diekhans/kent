normal::
	 cp -p addMetaDataToJson ${HOME}/bin
	 #cp -p addMetaDataToJson ${HOME}/kent/src/pyLib/scripts
test::
	@if test -d tests -a -s tests/makefile; then (cd tests && ${MAKE} test); \ 
	else echo "# no tests directory (or perhaps no tests/makefile) in $(CURDIR)"; fi
