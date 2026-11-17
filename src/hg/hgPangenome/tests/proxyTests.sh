#!/bin/bash
# proxyTests.sh - Layer 2 of the hgPangenome test suite.
#
# Tests the compiled CGI's commands against a mock middleware: server-side
# input caps, what we actually send upstream (URL, Content-Type, auth header,
# payload bytes), the job-id charset guard, upstream HTTP error mapping,
# timeouts, response passthrough, and that bot-delay is applied to submissions
# but not to polling.
#
# The CGI tested is the one built from this tree: $PG_CGI, or ../hgPangenome
# as "make compile" leaves it.  "make test" builds it first.  An installed CGI
# is never used, because it may be older than the source being tested.
#
# Isolated: the test hg.conf files do not include the site hg.conf, so nothing
# here contacts the bottleneck server, MySQL or the real middleware.  The one
# exception is the last section, the commands that run inside the cart, which
# is left out unless PG_DB_TESTS=1 ("make testWithDb").
#
# Exit 0 = all passed, 1 = a check failed, 77 = could not run (no CGI, or the
# cart section was asked for and no hg.conf here reaches a central database).

set -u
cd "$(dirname "$0")"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/pgProxyTests.XXXXXX")
REC="$TMP/requests.jsonl"
MOCK_PID=""
PORT=""
pass=0
fail=0

cleanup() {
    [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
    rm -rf "$TMP"
}
trap cleanup EXIT

# ---------------------------------------------------------------- locate CGI

NOT_RUN=77
notRun=""

find_cgi() {
    if [ -n "${PG_CGI:-}" ]; then
        [ -x "$PG_CGI" ] && echo "$(cd "$(dirname "$PG_CGI")" && pwd)/$(basename "$PG_CGI")"
        return
    fi
    [ -x ../hgPangenome ] && echo "$(cd .. && pwd)/hgPangenome"
}
CGI=$(find_cgi)
if [ -z "$CGI" ]; then
    echo "NOT RUN: no hgPangenome built from this tree."
    echo "         Use \"make test\", which builds one, or set PG_CGI=/path/to/hgPangenome"
    exit $NOT_RUN
fi
echo "Using CGI: $CGI"

# ------------------------------------------------------------------ utilities

free_port() {
    python3 - <<'PY'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
}

start_mock() {                      # start_mock [extra mockMiddleware args...]
    stop_mock
    PORT=$(free_port)
    : > "$REC"
    python3 ./mockMiddleware.py --port "$PORT" --record "$REC" "$@" 2>"$TMP/mock.err" &
    MOCK_PID=$!
    # wait for it to listen (max ~3s)
    for _ in $(seq 1 30); do
        if grep -q listening "$TMP/mock.err" 2>/dev/null; then return 0; fi
        sleep 0.1
    done
    echo "ERROR: mock middleware failed to start:"; cat "$TMP/mock.err"; exit 1
}

stop_mock() {
    if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null; MOCK_PID=""; fi
}

# Write a test hg.conf.  Deliberately standalone (no include of the site conf).
# The tools are turned on; the "off switch" section writes one without it.
mk_conf() {                          # mk_conf <file> [extra lines...]
    local f="$1"; shift
    echo "pangenomeTools=on" > "$f"
    for line in "$@"; do echo "$line" >> "$f"; done
}

# Default conf pointing at the running mock.
conf_default() {
    mk_conf "$TMP/hg.conf" \
        "pangenome.apiBase=http://127.0.0.1:$PORT" \
        "pangenome.timeoutSecs=10"
    echo "$TMP/hg.conf"
}

# A limit, read from the header the CGI is built from.  The limits are fixed
# values and no hg.conf reaches them, so the checks below are made at the
# values that ship, wherever those are set.
limit() {                            # limit <PG_NAME>
    awk -v n="$1" '$1 == "#define" && $2 == n { print $3; exit }' ../hgPangenome.h
}

# The default of a setting that is a number, read from where the CGI reads it.
setting_default() {                  # setting_default <pangenome.name>
    grep -oE 'cfgOptionDefault\("'"$1"'", "[0-9]+"\)' ../hgPangenome.c | head -1 | grep -oE '"[0-9]+"' | tr -d '"'
}

# Invoke the CGI as a real browser POST (urlencoded body on stdin).
cgi_post() {                         # cgi_post <conf> <payload-json>
    local conf="$1" payload="$2"
    local body
    body=$(BODY_PAYLOAD="$payload" python3 -c '
import os, urllib.parse
print("cmd=map&payload=" + urllib.parse.quote(os.environ["BODY_PAYLOAD"]))')
    printf '%s' "$body" | env -i \
        HGDB_CONF="$conf" REMOTE_ADDR=127.0.0.1 \
        REQUEST_METHOD=POST CONTENT_TYPE=application/x-www-form-urlencoded \
        CONTENT_LENGTH=${#body} \
        "$CGI" 2>&1
}

# Same as cgi_post but keeps the streams apart: stdout is returned (the HTTP
# response body the browser sees), stderr is left in $TMP/stderr.txt (what the
# apache error log would get).
cgi_post_split() {                   # cgi_post_split <conf> <payload-json>
    local conf="$1" payload="$2"
    local body
    body=$(BODY_PAYLOAD="$payload" python3 -c '
import os, urllib.parse
print("cmd=map&payload=" + urllib.parse.quote(os.environ["BODY_PAYLOAD"]))')
    printf '%s' "$body" | env -i \
        HGDB_CONF="$conf" REMOTE_ADDR=127.0.0.1 \
        REQUEST_METHOD=POST CONTENT_TYPE=application/x-www-form-urlencoded \
        CONTENT_LENGTH=${#body} \
        "$CGI" 2>"$TMP/stderr.txt"
}


# POST an arbitrary cmd with a JSON payload (cgi_post is map-specific).
cgi_post_cmd() {                     # cgi_post_cmd <conf> <cmd> <payload-json>
    local conf="$1" cmdName="$2" payload="$3"
    local body
    body=$(BODY_CMD="$cmdName" BODY_PAYLOAD="$payload" python3 -c '
import os, urllib.parse
print("cmd=" + os.environ["BODY_CMD"] + "&payload=" + urllib.parse.quote(os.environ["BODY_PAYLOAD"]))')
    printf '%s' "$body" | env -i \
        HGDB_CONF="$conf" REMOTE_ADDR=127.0.0.1 \
        REQUEST_METHOD=POST CONTENT_TYPE=application/x-www-form-urlencoded \
        CONTENT_LENGTH=${#body} \
        "$CGI" 2>&1
}

# POST a payload too long for a shell variable to carry.  The payload is the
# value of a python expression, in which seqs(n, length) is a mapping request
# of n sequences of that length.
cgi_post_big() {                     # cgi_post_big <conf> <cmd> <python expression>
    BODY_CMD="$2" BODY_EXPR="$3" BODY_OUT="$TMP/body.txt" python3 -c '
import json, os, urllib.parse
def seqs(n, length):
    return json.dumps({"sequences": [{"name": "s%d" % i, "sequence": "A" * length} for i in range(n)],
                       "options": {"max_multimaps": 1, "surject": True, "surject_target": None}})
payload = eval(os.environ["BODY_EXPR"])
with open(os.environ["BODY_OUT"], "w") as fh:
    fh.write("cmd=" + os.environ["BODY_CMD"] + "&payload=" + urllib.parse.quote(payload))'
    env -i HGDB_CONF="$1" REMOTE_ADDR=127.0.0.1 \
        REQUEST_METHOD=POST CONTENT_TYPE=application/x-www-form-urlencoded \
        CONTENT_LENGTH="$(wc -c < "$TMP/body.txt" | tr -d ' ')" \
        "$CGI" < "$TMP/body.txt" 2>&1
}

# Invoke the CGI as a real browser GET (QUERY_STRING).
cgi_get() {                          # cgi_get <conf> <query-string>
    local conf="$1" qs="$2"
    env -i HGDB_CONF="$conf" REMOTE_ADDR=127.0.0.1 \
        REQUEST_METHOD=GET QUERY_STRING="$qs" \
        "$CGI" 2>&1 < /dev/null
}

# Number of requests the mock has received.
mock_count() { [ -s "$REC" ] && wc -l < "$REC" | tr -d ' ' || echo 0; }

# Field of the last recorded request (python-side extraction).
mock_field() {                       # mock_field <key>
    MF_KEY="$1" python3 -c '
import json, os, sys
key = os.environ["MF_KEY"]
lines = [l for l in open(sys.argv[1]) if l.strip()]
if not lines:
    print("<no-request>"); sys.exit(0)
v = json.loads(lines[-1]).get(key)
print("<null>" if v is None else v)
' "$REC"
}

# --------------------------------------------------------------- assertions

check() {                            # check <label> <condition-result 0/1>
    if [ "$2" -eq 0 ]; then pass=$((pass+1)); echo "  ok   $1"
    else fail=$((fail+1)); echo "  FAIL $1"; fi
}

check_contains() {                   # check_contains <label> <text> <needle>
    case "$2" in
        *"$3"*) check "$1" 0 ;;
        *) check "$1" 1; echo "         expected to contain: $3"
           echo "         got: $(echo "$2" | tr '\n' ' ' | cut -c1-200)" ;;
    esac
}

check_not_contains() {               # check_not_contains <label> <text> <needle>
    case "$2" in
        *"$3"*) check "$1" 1; echo "         should NOT contain: $3"
                echo "         got: $(echo "$2" | tr '\n' ' ' | cut -c1-200)" ;;
        *) check "$1" 0 ;;
    esac
}

check_eq() {                         # check_eq <label> <actual> <expected>
    if [ "$2" = "$3" ]; then check "$1" 0
    else check "$1" 1; echo "         expected: $3"; echo "         actual:   $2"; fi
}

section() { echo; echo "--- $1 ---"; }

# Build a payload of N sequences of a given sequence string.
payload_n() {                        # payload_n <count> [sequence]
    PN_N="$1" PN_SEQ="${2:-ACGT}" python3 -c '
import json, os
n = int(os.environ["PN_N"]); seq = os.environ["PN_SEQ"]
print(json.dumps({"sequences": [{"name": "s%d" % i, "sequence": seq} for i in range(n)],
                  "options": {"max_multimaps": 1, "surject": True, "surject_target": None}}))'
}

echo "============================================================"
echo "Layer 2: CGI proxy tests"
echo "============================================================"

start_mock
CONF=$(conf_default)

# =================================================== A. server-side input caps
section "server-side input caps (must be enforced here, not just in the browser)"

MAXSEQ=$(setting_default pangenome.maxSequences)
MAXLEN=$(setting_default pangenome.maxSeqLen)
MAXBYTES=$(limit PG_MAX_REQUEST_BYTES)
MAXSPAN=$(limit PG_MAX_LIFT_SPAN)
MAXTGT=$(limit PG_MAX_CHOSEN_TARGETS)
MAXANSWER=$(limit PG_MAX_LIFT_ALL_BYTES)
MAXBLOCKS=$(limit PG_MAX_BLOCKS)
case "$MAXSEQ$MAXLEN$MAXBYTES$MAXSPAN$MAXTGT$MAXANSWER$MAXBLOCKS" in
    *[!0-9]*|"") check "the limits are read from hgPangenome.h" 1 ;;
    *) [ -n "$MAXSEQ" ] && [ -n "$MAXLEN" ] && [ -n "$MAXBYTES" ] && [ -n "$MAXSPAN" ] && \
       [ -n "$MAXTGT" ] && [ -n "$MAXANSWER" ] && [ -n "$MAXBLOCKS" ]
       check "the limits are read from hgPangenome.h" $? ;;
esac

# How many sequences and how long are settings, so that a server can lower
# them without a rebuild.
mk_conf "$TMP/fewer.conf" "pangenome.apiBase=http://127.0.0.1:$PORT" \
                          "pangenome.maxSequences=3" "pangenome.maxSeqLen=50"
: > "$REC"
out=$(cgi_post "$TMP/fewer.conf" "$(payload_n 4)")
check_contains "maxSequences set lower: one too many refused" "$out" "too many sequences: 4 (limit is 3)"
out=$(cgi_post "$TMP/fewer.conf" "$(payload_n 3)")
check_contains "maxSequences set lower: as many as it says accepted" "$out" "job_id"
out=$(cgi_post "$TMP/fewer.conf" "$(payload_n 1 "$(python3 -c 'print("A" * 51)')")")
check_contains "maxSeqLen set lower: one base too many refused" "$out" "(limit 50)"
out=$(cgi_post "$TMP/fewer.conf" "$(payload_n 1 "$(python3 -c 'print("A" * 50)')")")
check_contains "maxSeqLen set lower: exactly as long accepted" "$out" "job_id"
check_eq       "... and only the two accepted requests were forwarded" "$(mock_count)" "2"

: > "$REC"
out=$(cgi_post "$CONF" "$(payload_n $((MAXSEQ + 1)))")
check_contains "one sequence too many rejected with the limit" "$out" \
    "too many sequences: $((MAXSEQ + 1)) (limit is $MAXSEQ)"
check_eq       "... and never reached the middleware" "$(mock_count)" "0"

: > "$REC"
out=$(cgi_post "$CONF" "$(payload_n "$MAXSEQ")")
check_contains "as many sequences as the limit accepted (boundary)" "$out" "job_id"
check_eq       "... and forwarded once" "$(mock_count)" "1"

: > "$REC"
out=$(cgi_post_big "$CONF" map "seqs(1, $((MAXLEN + 1)))")
check_contains "over-long sequence rejected" "$out" "(limit $MAXLEN)"
check_eq       "over-long sequence not forwarded" "$(mock_count)" "0"

: > "$REC"
out=$(cgi_post_big "$CONF" map "seqs(1, $MAXLEN)")
check_contains "sequence exactly at the length limit accepted" "$out" "job_id"

# The three limits have to agree: the most sequences, each as long as one may
# be, is a request the form lets through, so the size limit must hold it.
: > "$REC"
out=$(cgi_post_big "$CONF" map "seqs($MAXSEQ, $MAXLEN)")
check_contains "the most sequences at the greatest length fit one request" "$out" "job_id"

: > "$REC"
out=$(cgi_post "$CONF" '{"sequences":[{"name":"r","sequence":"ACGTX"}],"options":{}}')
check_contains "invalid character rejected" "$out" "only A,C,G,T,N allowed"
check_eq       "invalid character not forwarded" "$(mock_count)" "0"

: > "$REC"
out=$(cgi_post "$CONF" '{"sequences":[{"name":"r","sequence":"acgtn"}],"options":{}}')
check_contains "lower-case acgtn accepted" "$out" "job_id"

: > "$REC"
out=$(cgi_post "$CONF" '{"sequences":[{"name":"r","sequence":"ACGU"}],"options":{}}')
check_contains "RNA (U) rejected" "$out" "only A,C,G,T,N allowed"

# Ours must fire below cheapcgi's own 1 MB cap, which aborts with an HTML page
# a JSON client can only report as "Unexpected token '<'".
: > "$REC"
out=$(cgi_post_big "$CONF" map "seqs(1, $((MAXBYTES + 1000)))")
check_contains "over-size request body rejected" "$out" "request too large"
check_not_contains "... as JSON, not as an HTML page" "$out" "DOCTYPE"
check_eq       "over-size body not forwarded" "$(mock_count)" "0"

: > "$REC"
out=$(cgi_post "$CONF" '{"sequences": [ ')
check_contains "malformed JSON rejected without aborting" "$out" "invalid JSON payload"
check_eq       "malformed JSON not forwarded" "$(mock_count)" "0"

: > "$REC"
out=$(cgi_post "$CONF" '{"options":{}}')
check_contains "payload with no sequences field rejected" "$out" "missing 'sequences'"

: > "$REC"
out=$(cgi_post "$CONF" '{"sequences":[],"options":{}}')
check_contains "empty sequences array rejected" "$out" "no sequences submitted"

: > "$REC"
out=$(cgi_post "$CONF" '{"sequences":[{"name":"r"}],"options":{}}')
check_contains "sequence entry without a sequence rejected" "$out" "no 'sequence'"

: > "$REC"
out=$(cgi_post "$CONF" '{"sequences":[{"name":"r","sequence":""}],"options":{}}')
check_contains "empty sequence string rejected" "$out" "empty"

# =============================================== B. what we send upstream
section "upstream request shaping"

: > "$REC"
PAYLOAD='{"sequences":[{"name":"r1","sequence":"ACGTACGT"}],"options":{"max_multimaps":1,"surject":true,"surject_target":"CHM13#0#chr10"}}'
out=$(cgi_post "$CONF" "$PAYLOAD")
check_eq       "valid submit forwarded exactly once" "$(mock_count)" "1"
check_eq       "forwarded as POST" "$(mock_field method)" "POST"
check_eq       "forwarded to /api/v1/map" "$(mock_field path)" "/api/v1/map"
check_eq       "sent as application/json" "$(mock_field content_type)" "application/json"
check_eq       "payload forwarded byte-for-byte" "$(mock_field body)" "$PAYLOAD"
check_eq       "Accept: application/json sent" "$(mock_field accept)" "application/json"
check_contains "identifies itself as hgPangenome" "$(mock_field user_agent)" "hgPangenome"
check_contains "middleware answer passed through" "$out" '"job_id": "job1"'
check_contains "CGI emits JSON content type" "$out" "Content-Type: application/json"

: > "$REC"
out=$(cgi_get "$CONF" "cmd=poll&job_id=job1")
check_eq       "poll forwarded as GET" "$(mock_field method)" "GET"
check_eq       "poll hits /api/v1/map/<job_id>" "$(mock_field path)" "/api/v1/map/job1"
check_contains "poll result passed through" "$out" '"status": "done"'

# trailing slash in apiBase must not produce a double slash
mk_conf "$TMP/slash.conf" "pangenome.apiBase=http://127.0.0.1:$PORT/"
: > "$REC"
cgi_get "$TMP/slash.conf" "cmd=poll&job_id=job1" > /dev/null
check_eq "trailing slash in apiBase normalized" "$(mock_field path)" "/api/v1/map/job1"

# =========================================================== auth header
section "auth token"

mk_conf "$TMP/tok.conf" "pangenome.apiBase=http://127.0.0.1:$PORT" \
                        "pangenome.apiToken=test-token-abc123"
: > "$REC"
cgi_post "$TMP/tok.conf" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}' > /dev/null
check_eq "configured token sent as X-Pangenome-Token" "$(mock_field token)" "test-token-abc123"

: > "$REC"
cgi_get "$TMP/tok.conf" "cmd=poll&job_id=job1" > /dev/null
check_eq "token also sent on poll" "$(mock_field token)" "test-token-abc123"

: > "$REC"
cgi_post "$CONF" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}' > /dev/null
check_eq "no token configured means no auth header" "$(mock_field token)" "<null>"

# A redirect is not followed.  Following it would send the token, which is in
# a header of ours, to wherever the redirect pointed.
start_mock --redirect
mk_conf "$TMP/redir.conf" "pangenome.apiBase=http://127.0.0.1:$PORT" \
                          "pangenome.apiToken=test-token-abc123"
: > "$REC"
out=$(cgi_post "$TMP/redir.conf" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}')
check_eq       "a redirect is not followed" "$(mock_count)" "1"
check_not_contains "... so the token goes nowhere else" "$(cat "$REC")" "/redirected"
check_contains "... and is reported as an error" "$out" "answered with a redirect (HTTP 302)"
start_mock
CONF=$(conf_default)

# The three limits agree: with nothing configured, as many sequences as are
# allowed, each as long as is allowed, make a request that is accepted.
mk_conf "$TMP/defaults.conf" "pangenome.apiBase=http://127.0.0.1:$PORT"
# (a megabyte is more than one environment variable or argument may hold, so
# this request is written to a file and read by the CGI from there)
python3 - "$TMP/tenFull.body" <<'PY'
import json, sys, urllib.parse
payload = json.dumps({"sequences": [{"name": "s%d" % i, "sequence": "ACGT" * 25000} for i in range(10)],
                      "options": {"max_multimaps": 1, "surject": True, "surject_target": None}})
open(sys.argv[1], "w").write("cmd=map&payload=" + urllib.parse.quote(payload))
PY
: > "$REC"
out=$(env -i HGDB_CONF="$TMP/defaults.conf" REMOTE_ADDR=127.0.0.1 \
    REQUEST_METHOD=POST CONTENT_TYPE=application/x-www-form-urlencoded \
    CONTENT_LENGTH=$(wc -c < "$TMP/tenFull.body") "$CGI" < "$TMP/tenFull.body" 2>&1)
check_eq "default limits: ten sequences of 100,000 bases are accepted" "$(mock_count)" "1"
check_contains "... and the job is taken" "$out" '"job_id"'
: > "$REC"
out=$(cgi_post "$TMP/defaults.conf" "$(payload_n 11 ACGT)")
check_contains "default limits: an eleventh sequence is refused" "$out" "too many sequences"

# ============================================================= off switch
section "off switch (pangenomeTools)"

printf '%s\n' "pangenome.apiBase=http://127.0.0.1:$PORT" > "$TMP/off.conf"
: > "$REC"
out=$(cgi_post "$TMP/off.conf" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}')
check_contains "tools off: map says they are not available" "$out" "not available on this server"
check_eq "tools off: nothing sent to the graph server" "$(mock_count)" "0"
out=$(cgi_get "$TMP/off.conf" "cmd=poll&job_id=job1")
check_contains "tools off: poll says so too" "$out" "not available on this server"
out=$(cgi_get "$TMP/off.conf" "cmd=pclai")
check_contains "tools off: a file-reading command says so too" "$out" "not available on this server"

# ======================================================= C. job_id guard
section "job_id guard (path traversal / SSRF)"

# "." and ".." are made of allowed characters and still name a directory
for bad in "../../etc/passwd" "a/b" "a?x=1" "a&b" "a;b" "a b" "http://evil.example/x" '$(id)' \
           "." ".." ".hidden" "-x"; do
    : > "$REC"
    out=$(cgi_get "$CONF" "cmd=poll&job_id=$(python3 -c "
import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$bad")")
    check_contains "rejects job_id '$bad'" "$out" "invalid 'job_id'"
    check_eq       "job_id '$bad' not forwarded" "$(mock_count)" "0"
done

: > "$REC"
out=$(cgi_get "$CONF" "cmd=poll")
check_contains "missing job_id rejected" "$out" "invalid 'job_id'"

: > "$REC"
longid=$(python3 -c 'print("a"*129)')
out=$(cgi_get "$CONF" "cmd=poll&job_id=$longid")
check_contains "over-long job_id rejected" "$out" "invalid 'job_id'"
check_eq       "over-long job_id not forwarded" "$(mock_count)" "0"

: > "$REC"
cgi_get "$CONF" "cmd=poll&job_id=abc-123_XY.9" > /dev/null
check_eq "accepts a normal job_id charset" "$(mock_field path)" "/api/v1/map/abc-123_XY.9"

# ================================================ D. upstream error mapping
section "upstream HTTP error mapping"

for code in 400 401 403 429 500 503; do
    start_mock --status "$code" --body '{"status":"error","error":"upstream says no"}'
    CONF2=$(conf_default)
    out=$(cgi_post "$CONF2" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}')
    check_contains "HTTP $code surfaced as an error envelope" "$out" '"status":"error"'
    check_contains "HTTP $code names the status code" "$out" "HTTP $code"
done

# an HTML error page from a proxy must not be quoted back at the user
start_mock --status 503 --body '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN"><html><head><title>503 Service Unavailable</title></head><body><h1>Service Unavailable</h1></body></html>' --content-type text/html
CONF2=$(conf_default)
out=$(cgi_post "$CONF2" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}')
check_contains     "HTML 503 reported as unavailable" "$out" "mapping service is unavailable"
check_contains     "HTML 503 names the status" "$out" "503"
check_not_contains "HTML 503 quotes no markup" "$out" "DOCTYPE"
check_not_contains "HTML 503 quotes no tags" "$out" "<html>"

start_mock --status 502 --body '<html><body>Bad Gateway</body></html>' --content-type text/html
CONF2=$(conf_default)
out=$(cgi_post "$CONF2" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}')
check_contains     "HTML 502 blamed on the proxy hop" "$out" "through its proxy"
check_not_contains "HTML 502 quotes no markup" "$out" "<html>"

# a JSON error body is still worth showing verbatim
start_mock --status 400 --body '{"status":"error","error":"unknown source haplotype"}'
CONF2=$(conf_default)
out=$(cgi_post "$CONF2" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}')
check_contains "a JSON upstream error is still quoted" "$out" "unknown source haplotype"

# ... but only its first part.  Copied whole into a fixed buffer, a long one
# aborted the CGI and the page got an error page where it wanted JSON.
LONG_ERR=$(python3 -c 'print("{\"status\":\"error\",\"error\":\"" + "x" * 3000 + "\"}")')
start_mock --status 500 --body "$LONG_ERR"
CONF2=$(conf_default)
out=$(cgi_post "$CONF2" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}')
check_contains "a long JSON upstream error is still an error envelope" "$out" \
    '{"status":"error","error":"mapping server returned HTTP 500'
check_not_contains "... and quotes only the first part" "$out" "$(printf 'x%.0s' $(seq 1 500))"

start_mock --status 200 --body 'this is not json' --content-type text/plain
CONF2=$(conf_default)
out=$(cgi_post "$CONF2" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}')
check_contains "non-JSON 200 is passed through verbatim (client reports it)" "$out" "this is not json"

# unreachable middleware
mk_conf "$TMP/dead.conf" "pangenome.apiBase=http://127.0.0.1:$(free_port)"
out=$(cgi_post "$TMP/dead.conf" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}')
check_contains "unreachable middleware reported clearly" "$out" "could not reach mapping server"

# timeout
start_mock --delay 3
mk_conf "$TMP/to.conf" "pangenome.apiBase=http://127.0.0.1:$PORT" "pangenome.timeoutSecs=1"
out=$(cgi_post "$TMP/to.conf" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}')
check_contains "slow middleware times out instead of hanging" "$out" "could not reach mapping server"

# apiBase not configured
mk_conf "$TMP/noapi.conf"
out=$(cgi_post "$TMP/noapi.conf" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}')
check_contains "missing apiBase reported" "$out" "apiBase is not configured"
out=$(cgi_get "$TMP/noapi.conf" "cmd=poll&job_id=job1")
check_contains "missing apiBase reported on poll too" "$out" "apiBase is not configured"

# ================================================= E. bot delay differential
section "bot delay: applied to submissions, not to polling"

# Point the bottleneck server at a dead port.  A submission must attempt the
# bot check (and therefore fail closed); a poll must not consult it at all.
DEADP=$(free_port)
start_mock
mk_conf "$TMP/bot.conf" "pangenome.apiBase=http://127.0.0.1:$PORT" \
                        "bottleneck.host=127.0.0.1" \
                        "bottleneck.port=$DEADP"
# Keep stdout (what the browser sees) and stderr (the error log) apart.
body=$(cgi_post_split "$TMP/bot.conf" '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}')
log=$(cat "$TMP/stderr.txt")
check_contains "cmd=map consults the bottleneck server" "$log" "bottleneck"
# When the bottleneck server is down the API path must still answer JSON, not an
# HTML 500 page (the client would otherwise show raw markup).
check_contains     "bottleneck failure answered as JSON" "$body" "Content-Type: application/json"
check_contains     "bottleneck failure uses our error envelope" "$body" '"status":"error"'
check_contains     "bottleneck failure message is user-facing" "$body" "rate limiter unavailable"
check_not_contains "bottleneck failure leaks no HTML to the browser" "$body" "<!DOCTYPE"
check_not_contains "bottleneck failure leaks no host/port to the browser" "$body" "IP 127.0.0.1"
check_contains     "bottleneck failure detail is written to the error log" "$log" "bot check failed"

out=$(cgi_post_cmd "$TMP/bot.conf" locus '{"items":[]}')
check_contains "cmd=locus consults the bottleneck server too" "$out" "rate limiter unavailable"

# The batch surjection is the heaviest request there is, so it is limited too.
: > "$REC"
out=$(cgi_post_cmd "$TMP/bot.conf" surjectAll '{"job_id":"job1","name":"r1"}')
check_contains "cmd=surjectAll consults the bottleneck server" "$out" "rate limiter unavailable"
check_eq       "... and is not forwarded when the check cannot be made" "$(mock_count)" "0"

: > "$REC"
out=$(cgi_get "$TMP/bot.conf" "cmd=poll&job_id=job1")
check_not_contains "cmd=poll does not consult the bottleneck server" "$out" "bottleneck"
check_contains     "cmd=poll still works while bot check is unreachable" "$out" '"status": "done"'

# =============================================== F. a command there is not
section "a command that does not exist"

: > "$REC"
out=$(cgi_get "$CONF" "cmd=bogus&job_id=job1")
check_eq       "unknown cmd is not forwarded upstream" "$(mock_count)" "0"
check_contains "unknown cmd is answered in JSON, as every command is" "$out" "Content-Type: application/json"
check_contains "... with an error that names it" "$out" "\"error\":\"unknown command 'bogus'\""

# The commands are one table in hgPangenome.c.  The page scripts send exactly
# those: none the CGI does not know, and none in the table that nothing sends.
sent=$(grep -ohE '(pg\.post|postCmd)\("[A-Za-z]+"|cmd=[A-Za-z]+|cmd: "[A-Za-z]+"' ../../js/hgPangenome*.js \
       | grep -oE '[A-Za-z]+"?$' | tr -d '"' | sort -u | tr '\n' ' ')
known=$(grep -oE '^    \{"[A-Za-z]+"' ../hgPangenome.c | tr -d ' {"' | sort -u | tr '\n' ' ')
check_eq "the scripts send exactly the commands in the table" "$sent" "$known"
check_contains "... and the table was read: it has cmd=map" " $known" " map "


# ======================================= G. coordinate translation (liftover)
section "coordinate translation"

# earlier sections restarted the mock on other ports; get a fresh one and
# rebuild the confs that point at it
start_mock
CONF=$(conf_default)
mk_conf "$TMP/tok.conf" "pangenome.apiBase=http://127.0.0.1:$PORT" \
                        "pangenome.apiToken=test-token-abc123"

LIFT_OK='{"src":"HG00097#1#CM094066.1","start":19113,"end":19137,"tgt":["HG01234#2"]}'

# The plain block-by-block command is not offered any more: PanLift asks for
# the summary, and a chain's blocks are fetched by the server itself.
: > "$REC"
out=$(cgi_post_cmd "$CONF" liftover '{"src":"HG00097#1#CM094066.1","start":19113,"end":19137,"tgt":"HG01234#2","blocks":true}')
check_eq "cmd=liftover is gone: nothing is sent to the mapping server" "$(mock_count)" "0"

section "where a region lands, summarized (cmd=liftoverAll)"

# What goes upstream is rebuilt from the checked fields alone: the summary,
# for every haplotype or for the ones named, whatever else the page sent.
: > "$REC"
out=$(cgi_post_cmd "$CONF" liftoverAll \
    '{"src":"HG00097#1#CM094066.1","start":10,"end":20,"blocks":true,"other":1}')
check_eq       "liftoverAll forwarded once" "$(mock_count)" "1"
check_eq       "liftoverAll forwarded as POST" "$(mock_field method)" "POST"
check_eq       "liftoverAll hits /api/v1/liftover" "$(mock_field path)" "/api/v1/liftover"
check_eq       "liftoverAll sent as application/json" "$(mock_field content_type)" "application/json"
sent=$(mock_field body | tr -d ' ')
check_eq       "with no targets it asks for every haplotype, summarized" "$sent" \
    '{"src":"HG00097#1#CM094066.1","start":10,"end":20,"tgt":"*","summary":true}'
check_contains "liftoverAll answer passed through" "$out" '"intervals"'
: > "$REC"
cgi_post_cmd "$CONF" liftoverAll \
    '{"src":"HG00097#1#CM094066.1","start":10,"end":20,"tgt":["chm13#0","HG01234#2"],"blocks":true}' > /dev/null
sent=$(mock_field body | tr -d ' ')
check_eq       "with targets it asks for those, summarized, and never for blocks" "$sent" \
    '{"src":"HG00097#1#CM094066.1","start":10,"end":20,"tgt":["chm13#0","HG01234#2"],"summary":true}'
: > "$REC"
out=$(cgi_post_cmd "$CONF" liftoverAll '{"src":"HG00097#1","start":10,"end":20}')
check_contains "liftoverAll checks the source path" "$out" "full contig path"
check_eq       "liftoverAll bad source - not forwarded" "$(mock_count)" "0"

section "translation input validation (server-side, before forwarding)"

lift_reject() {                      # lift_reject <label> <payload> <expected text>
    : > "$REC"
    local o
    o=$(cgi_post_cmd "$CONF" liftoverAll "$2")
    check_contains "$1" "$o" "$3"
    check_eq       "$1 - not forwarded" "$(mock_count)" "0"
}

lift_reject "src must be a full contig path" \
    '{"src":"HG00097#1","start":1,"end":2,"tgt":["chm13#0"]}' "full contig path"
lift_reject "missing src rejected" \
    '{"start":1,"end":2,"tgt":["chm13#0"]}' "missing 'src'"
lift_reject "missing start/end rejected" \
    '{"src":"a#1#c","tgt":["chm13#0"]}' "missing 'start' or 'end'"
lift_reject "non-numeric coordinates rejected" \
    '{"src":"a#1#c","start":"x","end":"y","tgt":["chm13#0"]}' "must be numbers"
lift_reject "end must exceed start" \
    '{"src":"a#1#c","start":50,"end":50,"tgt":["chm13#0"]}' "greater than"
lift_reject "negative start rejected" \
    '{"src":"a#1#c","start":-5,"end":10,"tgt":["chm13#0"]}' "negative"
lift_reject "a region one base over the span limit rejected" \
    "{\"src\":\"a#1#c\",\"start\":0,\"end\":$((MAXSPAN + 1)),\"tgt\":[\"chm13#0\"]}" "limit $MAXSPAN"
lift_reject "empty tgt array rejected" \
    '{"src":"a#1#c","start":1,"end":2,"tgt":[]}' "'tgt' must be a list of haplotypes"
# a reader may choose so many haplotypes and no more; past that the question is
# about every haplotype, which is asked without a list
names() { python3 -c 'import json, sys; print(json.dumps(["h%d#1" % i for i in range(int(sys.argv[1]))]))' "$1"; }
lift_reject "one target too many rejected" \
    "{\"src\":\"a#1#c\",\"start\":1,\"end\":2,\"tgt\":$(names $((MAXTGT + 1)))}" \
    "too many target haplotypes: $((MAXTGT + 1)) (limit is $MAXTGT per conversion)"

: > "$REC"
out=$(cgi_post_cmd "$CONF" liftoverAll "{\"src\":\"a#1#c\",\"start\":1,\"end\":2,\"tgt\":$(names "$MAXTGT")}")
check_eq "as many targets as the limit accepted (boundary)" "$(mock_count)" "1"

# The size limit is one for every command, not only for a mapping.
: > "$REC"
out=$(cgi_post_big "$CONF" liftoverAll \
    "'{\"src\":\"a#1#c\",\"start\":1,\"end\":2,\"pad\":\"' + 'x' * ($MAXBYTES + 1000) + '\"}'")
check_contains "oversized payload rejected as JSON, not HTML" "$out" \
    "request too large"
check_not_contains "oversized payload does not emit an HTML page" "$out" "DOCTYPE"
check_eq       "oversized payload not forwarded" "$(mock_count)" "0"

lift_reject "malformed JSON rejected without aborting" \
    '{"src":' "invalid JSON payload"

# A target is a haplotype name and nothing else.  The limits above count the
# targets, and a word the mapping server reads as "all of them" counts as one.
for bad in '"*"' '"HG01234#2"' '["all"]' '["HG01234"]' '["HG01234#2 x"]' '["a#b#c#d"]' \
           '["HG01234#2","*"]' '["HG01234#2",5]' '[["HG01234#2"]]'; do
    lift_reject "tgt $bad refused" \
        "{\"src\":\"a#1#c\",\"start\":1,\"end\":2,\"tgt\":$bad}" "'tgt' must be a list of haplotypes"
done
for good in '["HG01234#2"]' '["hg01234#2"]' '["HG01234#2#CM0987.1"]' '["CHM13#0","GRCh38#0"]'; do
    : > "$REC"
    cgi_post_cmd "$CONF" liftoverAll "{\"src\":\"a#1#c\",\"start\":1,\"end\":2,\"tgt\":$good}" > /dev/null
    check_eq "tgt $good accepted" "$(mock_count)" "1"
done
: > "$REC"
out=$(cgi_post_cmd "$CONF" surject '{"tgt":"*","job_id":"job1","name":"r1"}')
check_contains "surject: tgt \"*\" refused" "$out" "'tgt' must name a haplotype"
check_eq       "surject: tgt \"*\" - not forwarded" "$(mock_count)" "0"
: > "$REC"
cgi_post_cmd "$CONF" surject '{"tgt":"CHM13#0","job_id":"job1","name":"r1"}' > /dev/null
check_eq "surject: a haplotype name accepted" "$(mock_count)" "1"

: > "$REC"
out=$(cgi_post_cmd "$CONF" liftoverAll "{\"src\":\"a#1#c\",\"start\":0,\"end\":$MAXSPAN,\"tgt\":[\"chm13#0\"]}")
check_eq "a region exactly at the span limit is accepted" "$(mock_count)" "1"

section "reachable-targets query (cmd=liftoverTargets)"

: > "$REC"
TARGETS_OK='{"src":"HG00097#1#CM094066.1","start":19113,"end":19137}'
out=$(cgi_post_cmd "$CONF" liftoverTargets "$TARGETS_OK")
check_eq       "forwarded to /api/v1/liftover/targets" "$(mock_field path)" "/api/v1/liftover/targets"
check_eq       "forwarded as POST" "$(mock_field method)" "POST"
check_eq       "payload forwarded byte-for-byte" "$(mock_field body)" "$TARGETS_OK"
check_contains "reachable list passed through" "$out" '"haplotypes"'

# no tgt is required here, but the source and range still are
: > "$REC"
out=$(cgi_post_cmd "$CONF" liftoverTargets '{"src":"HG00097#1","start":1,"end":2}')
check_contains "src must still be a full contig path" "$out" "full contig path"
check_eq       "not forwarded" "$(mock_count)" "0"

: > "$REC"
out=$(cgi_post_cmd "$CONF" liftoverTargets "{\"src\":\"a#1#c\",\"start\":0,\"end\":$((MAXSPAN + 1))}")
check_contains "span limit still enforced" "$out" "limit $MAXSPAN"
check_eq       "not forwarded" "$(mock_count)" "0"

: > "$REC"
out=$(cgi_post_cmd "$CONF" liftoverTargets '{"src":"a#1#c","start":5,"end":5}')
check_contains "empty range still rejected" "$out" "greater than"

section "haplotype list"

: > "$REC"
out=$(cgi_get "$CONF" "cmd=haplotypes")
check_eq       "haplotypes forwarded as GET" "$(mock_field method)" "GET"
check_eq       "haplotypes hits /api/v1/haplotypes" "$(mock_field path)" "/api/v1/haplotypes"
check_contains "haplotype list passed through" "$out" '"haplotypes"'
check_contains "names match our assembly-table keys" "$out" 'hg00097#1'

# auth + failure behaviour apply to the new routes too
: > "$REC"
cgi_post_cmd "$TMP/tok.conf" liftoverAll "$LIFT_OK" > /dev/null
check_eq "token sent on a translation" "$(mock_field token)" "test-token-abc123"
: > "$REC"
cgi_get "$TMP/tok.conf" "cmd=haplotypes" > /dev/null
check_eq "token sent on haplotypes" "$(mock_field token)" "test-token-abc123"

out=$(cgi_post_cmd "$TMP/dead.conf" liftoverAll "$LIFT_OK")
check_contains "unreachable middleware reported on a translation" "$out" "could not reach mapping server"
out=$(cgi_post_cmd "$TMP/noapi.conf" liftoverAll "$LIFT_OK")
check_contains "missing apiBase reported on a translation" "$out" "apiBase is not configured"

section "alignments per sequence (server-side ceiling)"

: > "$REC"
out=$(cgi_post_cmd "$CONF" map \
  '{"sequences":[{"name":"a","sequence":"ACGT"}],"options":{"max_multimaps":4}}')
check_contains "more than the ceiling rejected" "$out" \
    "too many alignments per sequence: 4 (limit is 3)"
check_eq "and not forwarded" "$(mock_count)" "0"

: > "$REC"
out=$(cgi_post_cmd "$CONF" map \
  '{"sequences":[{"name":"a","sequence":"ACGT"}],"options":{"max_multimaps":3}}')
check_eq "exactly the ceiling accepted (boundary)" "$(mock_count)" "1"

section "an answer too long to show"

# One region on every haplotype is about 1 kB a haplotype.  An answer past
# PG_MAX_LIFT_ALL_BYTES is not read to its end and is not passed on.
python3 -c 'import sys
row = "{\"haplotype\":\"H#1\",\"pieces\":[],\"mapped_bp\":0}"
sys.stdout.write("{\"summary\":[" + ",".join([row] * (int(sys.argv[1]) // len(row) + 1)) + "]}")' \
    "$MAXANSWER" > "$TMP/longAnswer.json"
start_mock --body-file "$TMP/longAnswer.json"
mk_conf "$TMP/long.conf" "pangenome.apiBase=http://127.0.0.1:$PORT"
out=$(cgi_post_cmd "$TMP/long.conf" liftoverAll '{"src":"HG00097#1#CM094066.1","start":10,"end":20}')
check_contains "an answer past the limit is refused" "$out" "too large to show"
check_contains "... and comes back as our error" "$out" '"status":"error"'
check_eq       "... of a few hundred bytes" "$([ ${#out} -lt 600 ] && echo short)" "short"
start_mock
CONF=$(conf_default)

# ------------------------------------------- commands that run in the cart
#
# quickLift, refAnnot and alignTrack build a track hub or write the user's
# sequence track, so they run inside the cart, and the cart needs the browser's
# central database.  The isolated hg.conf has none, and there the CGI stops
# before any of our code runs.  So these checks are not part of the default
# run: each request starts a new session row in that database.  PG_DB_TESTS=1
# ("make testWithDb") includes them, borrowing the database settings from a
# real hg.conf and nothing else.

if [ "${PG_DB_TESTS:-0}" != "1" ]; then
    echo
    echo "--- commands that run in the cart: not included (make testWithDb) ---"
else
section "commands that run in the cart (uses the central database)"

# Probe by running a command rather than by reading the file: credentials
# often live in an included private file we cannot read from here.
QCONF=""
for cand in "${HGDB_CONF:-}" "${HOME:-}/.hg.conf" "${HOME:-}/hg.conf" \
            /usr/local/apache/cgi-bin-$(id -un)/hg.conf \
            /usr/local/apache/cgi-bin/hg.conf; do
    [ -n "$cand" ] && [ -r "$cand" ] || continue
    abs=$(cd "$(dirname "$cand")" && pwd)/$(basename "$cand")
    # Borrow the database settings but not the site's front-door defences:
    # with a bottleneck server and a Cloudflare site key configured, a
    # cookie-less request like ours is answered with a captcha page instead of
    # reaching the command at all.  "delete" takes off one setting of a key,
    # and a conf that includes another can hold several, hence the repeats.
    { echo "include $abs"
      for _ in 1 2 3 4; do
          echo "delete cloudFlareSiteKey bottleneck.host bottleneck.port"
      done
      echo "pangenomeTools=on"
      echo "pangenome.apiBase=http://127.0.0.1:$PORT"
      echo "pangenome.timeoutSecs=10"; } > "$TMP/quicklift.conf"
    case "$(cgi_post_cmd "$TMP/quicklift.conf" quickLift '{}' 2>/dev/null)" in
        *'"status"'*) QCONF="$TMP/quicklift.conf"; break ;;
    esac
done

if [ -z "$QCONF" ]; then
    echo "  NOT RUN: no hg.conf here reaches a central database"
    notRun="the commands that run in the cart"
else
    # the name comes from the user's own FASTA header and lands in a FASTA
    # line, a PSL column and hgc's whitespace-split "i=" parameter
    out=$(cgi_post_cmd "$QCONF" alignTrack \
      '{"db":"noSuchDb","contig":"c","name":"a b","sequence":"ACGT","cigar":"4M","start":0}')
    check_contains "alignTrack: an unknown assembly is reported, not crashed on" \
        "$out" "no sequence sizes available"

    # The page does not post its blocks - the server fetches them - so a failed
    # fetch must say why.  Reporting "no 'blocks' array in the request"
    # described our own request and hid the upstream reason (a 503 while the
    # service was restarting looked identical to a region that cannot be lifted).
    { echo "include $QCONF"
      echo "pangenome.apiBase=http://127.0.0.1:$(free_port)"; } > "$TMP/quickliftDead.conf"
    out=$(cgi_post_cmd "$TMP/quickliftDead.conf" quickLift \
        '{"srcDb":"hg38","tgtDb":"hg38","src":"GRCh38#0#chr1","srcHap":"GRCh38",
          "srcStart":1000,"srcEnd":2000,"tgt":"CHM13#0","position":"chr1:1-2",
          "hideTracks":"off"}')
    check_contains "quickLift: a failed block fetch says the server was not reached" \
        "$out" "could not reach the mapping server"
    check_not_contains "and does not blame the request" "$out" "no 'blocks' array"
    check_not_contains "the bottleneck server is not contacted" "$out" "botDelay"

    ql_reject() {                    # ql_reject <label> <payload> <expected text>
        : > "$REC"
        local o
        o=$(cgi_post_cmd "$QCONF" quickLift "$2")
        check_contains "$1" "$o" "$3"
        # nothing about quickLift should ever reach the mapping server: the
        # page already has the blocks, that is the whole point of passing them
        # back instead of translating twice
        check_eq "$1 - middleware untouched" "$(mock_count)" "0"
    }

    ql_reject "malformed JSON rejected without aborting" \
        'not json' "invalid JSON payload"
    ql_reject "missing assemblies rejected" \
        '{"src":"HG00097#1#CM094066.1","position":"chr1:1-2"}' \
        "missing or malformed source"
    # srcDb/tgtDb become file paths and a hub genome line, so anything that is
    # not shaped like a db name is refused outright
    ql_reject "assembly name with a slash rejected" \
        '{"srcDb":"../../etc","tgtDb":"hs1","src":"a#1#c","position":"c:1-2"}' \
        "missing or malformed source"
    ql_reject "missing position rejected" \
        '{"srcDb":"hs1","tgtDb":"GCA_044165735.1","src":"HG00097#1#CM094066.1"}' \
        "missing source path or target position"
    ql_reject "two-field src rejected" \
        '{"srcDb":"hs1","tgtDb":"GCA_044165735.1","src":"HG00097#1","position":"c:1-2"}' \
        "full contig path"
    ql_reject "unknown assembly reported, not crashed on" \
        '{"srcDb":"noSuchDb","tgtDb":"alsoNoSuchDb","src":"a#1#c","position":"c:1-2"}' \
        "no sequence sizes available"

    # cmd=refAnnot: a reference's annotations on a mapped haplotype.  Every one
    # of these is refused before the mapping server is asked anything.
    ra_reject() {                    # ra_reject <label> <payload> <expected text>
        : > "$REC"
        local o
        o=$(cgi_post_cmd "$QCONF" refAnnot "$2")
        check_contains "$1" "$o" "$3"
        check_eq "$1 - middleware untouched" "$(mock_count)" "0"
    }
    RA_OK='"db":"GCA_046000115.1","path":"HG04187#1#CM099739.1","start":100,"end":200,"position":"CM099739.1:1-300"'
    ra_reject "refAnnot: malformed JSON rejected" 'not json' "invalid JSON payload"
    ra_reject "refAnnot: a reference not configured is refused" \
        "{$RA_OK,\"ref\":\"XX#0\"}" "annotations cannot be brought from 'XX#0'"
    ra_reject "refAnnot: no reference refused" "{$RA_OK}" "annotations cannot be brought"
    ra_reject "refAnnot: assembly name with a slash refused" \
        '{"db":"../../etc","path":"HG04187#1#CM099739.1","start":1,"end":2,"position":"c:1-2","ref":"GRCh38#0"}' \
        "missing or malformed assembly"
    ra_reject "refAnnot: a path that is not a full contig refused" \
        '{"db":"GCA_046000115.1","path":"HG04187#1","start":1,"end":2,"position":"c:1-2","ref":"GRCh38#0"}' \
        "missing or malformed assembly"
    ra_reject "refAnnot: an empty extent refused" \
        '{"db":"GCA_046000115.1","path":"HG04187#1#CM099739.1","start":5,"end":5,"position":"c:1-2","ref":"GRCh38#0"}' \
        "missing or malformed start and end"
    ra_reject "refAnnot: longer than a translation may cover refused" \
        '{"db":"GCA_046000115.1","path":"HG04187#1#CM099739.1","start":0,"end":999999999,"position":"c:1-2","ref":"GRCh38#0"}' \
        "longer than the"
    ra_reject "refAnnot: a hit already on the reference is not translated" \
        '{"db":"hg38","path":"GRCh38#0#chr1","start":1,"end":2,"position":"chr1:1-2","ref":"GRCh38#0"}' \
        "this hit is already on GRCh38"

    # ---- files these commands write, and what they must leave alone ----
    #
    # Run in a directory of their own, laid out as cgi-bin is: the CGI's
    # ../trash is then $TMP/trash, and loader/bedToBigBed is where it looks.
    # SERVER_SOFTWARE is what makes the library use ../trash as it does under
    # the web server; without it a command-line run keeps trash files in ".".
    BOX="$TMP/cgi-bin"
    mkdir -p "$BOX/loader" "$TMP/trash/quickLift"
    for cand in "/usr/local/apache/cgi-bin-$(id -un)/loader/bedToBigBed" \
                /usr/local/apache/cgi-bin/loader/bedToBigBed \
                "$(command -v bedToBigBed 2>/dev/null)"; do
        [ -n "$cand" ] && [ -x "$cand" ] && { ln -sf "$cand" "$BOX/loader/bedToBigBed"; break; }
    done
    # the sequence track: the converter and the format's field list
    for f in pslToBigPsl bigPsl.as; do
        for dir in "/usr/local/apache/cgi-bin-$(id -un)/loader" /usr/local/apache/cgi-bin/loader; do
            [ -e "$dir/$f" ] && { ln -sf "$dir/$f" "$BOX/loader/$f"; break; }
        done
    done
    enc() { ENC_S="$1" python3 -c 'import os, urllib.parse; print(urllib.parse.quote(os.environ["ENC_S"], safe=""))'; }
    cgi_box() {                      # cgi_box <conf> <urlencoded body>
        (cd "$BOX" && printf '%s' "$2" | env -i \
            HGDB_CONF="$1" REMOTE_ADDR=127.0.0.1 SERVER_SOFTWARE=Apache \
            REQUEST_METHOD=POST CONTENT_TYPE=application/x-www-form-urlencoded \
            CONTENT_LENGTH=${#2} \
            "$CGI" 2>&1)
    }

    # ---- the sequence track (cmd=alignTrack) ----
    #
    # The mapped sequence becomes a bigPsl custom track.  The checks read the
    # finished file back with bigBedToBed, so they need that and the two
    # programs the CGI runs.
    BB2BED=""
    for cand in "$(command -v bigBedToBed 2>/dev/null)" /cluster/bin/x86_64/bigBedToBed; do
        [ -n "$cand" ] && [ -x "$cand" ] && { BB2BED="$cand"; break; }
    done
    if [ ! -e "$BOX/loader/pslToBigPsl" ] || [ ! -e "$BOX/loader/bigPsl.as" ] || \
       [ ! -x "$BOX/loader/bedToBigBed" ] || [ -z "$BB2BED" ]; then
        echo "  NOT RUN: the sequence track checks (pslToBigPsl, bigPsl.as, bedToBigBed or bigBedToBed not found)"
        notRun="the sequence track checks"
    else
    SEQ40=$(python3 -c 'print("ACGT" * 10)')
    AT_PART="\"db\":\"hg38\",\"contig\":\"chr1\",\"name\":\"q\",\"sequence\":\"$SEQ40\",\"start\":11000"
    at() { cgi_box "$QCONF" "cmd=alignTrack&payload=$(enc "$1")"; }
    # the track file an answer's link names, as tab-separated bigPsl rows
    track_of() {                     # track_of <alignTrack answer>
        local f
        f=$(printf '%s' "$1" | grep -o 'bigDataUrl%3D[^"& ]*\.bb' | head -1 | sed 's/bigDataUrl%3D//; s/%2F/\//g; s/%2E/./g')
        [ -n "$f" ] && (cd "$BOX" && "$BB2BED" "$f" stdout 2>&1)
    }
    col() { printf '%s' "$1" | cut -f"$2"; }

    # It is written into a session of this request's own, and both links name
    # it.  Left to the user's cookie, a second click or a second tab changed
    # the assembly before the browser page opened.
    out=$(at "{$AT_PART,\"cigar\":\"40M\",\"strand\":\"+\"}")
    check_contains "alignTrack: the track is built" "$out" '"status":"ok"'
    ATSID=$(printf '%s' "$out" | grep -o '"hgsid":"[0-9]*_[A-Za-z0-9]*"' | cut -d'"' -f4)
    check_contains "... in a session the answer names" "$out" '"hgsid":"'
    check_contains "... the browser link opens that session" "$out" "\"url\":\"hgTracks?hgsid=$ATSID&db=hg38&position=chr1"
    check_contains "... and hands it the custom track" "$out" 'hgct_customText=track+type%3DbigPsl'
    check_contains "... named as shown, so \"hide other tracks\" leaves it" "$out" '&ct_PanViewSeq_'
    check_contains "... the alignment link opens the same session and track" "$out" \
        "\"details\":\"hgc?hgsid=$ATSID&db=hg38&g=htcBigPslAli&i=q&c=chr1"
    check_eq "... and only the track file is left: no PSL, no FASTA" \
        "$(find "$TMP/trash/pangenomeSs" -type f ! -name '*.bb' | grep -c .)" "0"
    row=$(track_of "$out")
    check_eq "... which holds the alignment and the sequence" \
        "$(col "$row" 1):$(col "$row" 2)-$(col "$row" 3) $(col "$row" 4) $(col "$row" 18)" \
        "chr1:11000-11040 q $(printf '%s' "$SEQ40" | tr 'ACGT' 'acgt')"

    # a clipped end is not part of the alignment: 10 of 40 bases aligned
    row=$(track_of "$(at "{$AT_PART,\"cigar\":\"10M30S\",\"strand\":\"+\",\"matches\":9,\"mismatches\":1}")")
    check_eq "alignTrack: a clipped end is left out of the query range" \
        "$(col "$row" 13)-$(col "$row" 14) of $(col "$row" 16)" "0-10 of 40"
    check_eq "... the mapping server's matches and mismatches are used" \
        "$(col "$row" 21)/$(col "$row" 22)" "9/1"
    check_eq "... and the target range is the aligned bases" \
        "$(col "$row" 2)-$(col "$row" 3)" "11000-11010"
    # on the reverse strand the range is on the query as it was given
    row=$(track_of "$(at "{$AT_PART,\"cigar\":\"10M30S\",\"strand\":\"-\"}")")
    check_eq "alignTrack: reverse strand, the query range is turned round" \
        "$(col "$row" 6) $(col "$row" 13)-$(col "$row" 14)" "- 30-40"
    check_eq "... and with no counts every aligned base is a match" \
        "$(col "$row" 21)/$(col "$row" 22)" "10/0"
    row=$(track_of "$(at "{$AT_PART,\"cigar\":\"5S4=1X5=3I10M2D10M2S\",\"strand\":\"+\"}")")
    check_eq "alignTrack: runs that touch are one block, gaps separate blocks" \
        "$(col "$row" 10) blocks $(col "$row" 11) at $(col "$row" 12) and $(col "$row" 17) q $(col "$row" 13)-$(col "$row" 14)" \
        "3 blocks 10,10,10, at 0,10,22, and 5,18,28, q 5-38"
    # every other hit on the haplotype goes in the same track
    row=$(track_of "$(at "{$AT_PART,\"cigar\":\"40M\",\"strand\":\"+\",\"others\":[{\"contig\":\"chr2\",\"start\":500,\"strand\":\"-\",\"cigar\":\"20M20S\"},{\"contig\":\"chr1\",\"start\":100,\"strand\":\"+\",\"cigar\":\"40M\"},{\"contig\":\"noSuchSeq\",\"start\":1,\"strand\":\"+\",\"cigar\":\"40M\"}]}")")
    check_eq "alignTrack: the other hits on the haplotype are in the track, sorted" \
        "$(printf '%s\n' "$row" | cut -f1,2 | tr '\t\n' ': ')" "chr1:100 chr1:11000 chr2:500 "
    # the CIGAR is input: anything odd is refused
    for badCigar in "-5M45M" "10M30Z" "40" "M" "99999999999M" "50M" "10M 30S" "40S"; do
        out=$(at "{$AT_PART,\"cigar\":\"$badCigar\",\"strand\":\"+\"}")
        check_contains "alignTrack: CIGAR '$badCigar' refused" "$out" '"status":"error"'
    done
    out=$(at "{\"db\":\"hg38\",\"contig\":\"chr1\",\"name\":\"q\",\"sequence\":\"$SEQ40\",\"start\":999999999,\"cigar\":\"40M\"}")
    check_contains "alignTrack: a start past the end of the sequence refused" "$out" "starts outside chr1"
    check_eq "... and a refused request leaves no file behind" \
        "$(find "$TMP/trash/pangenomeSs" -type f ! -name '*.bb' | grep -c .)" "0"
    fi

    # hubQuickLift-<db> names the hub hgConvert's quickLift attached for this
    # user.  We ask the same library for the source's stanzas, and used to empty
    # that file first.
    THEIRS="../trash/quickLift/hub_theirs.txt"
    printf 'hub quickLiftHubhg38\n\ngenome hg38\n\ntrack liftedEarlier\nshortLabel lifted earlier\n\n' \
        > "$BOX/$THEIRS"
    cp "$BOX/$THEIRS" "$TMP/theirsBefore.txt"
    theirs_state() { cmp -s "$BOX/$THEIRS" "$TMP/theirsBefore.txt" && echo unchanged || echo changed; }

    # pangenomeQuickLift-<src>-<tgt> is where we keep the name of our own hub
    # file between conversions, and that file is written over.  A cart variable
    # can be set from a link, so a name that is not our file must not be used.
    VICTIM="$TMP/notOurs.txt"
    echo "somebody else's file" > "$VICTIM"
    QL_FULL='{"srcDb":"hg38","tgtDb":"hg38","src":"GRCh38#0#chr1","srcHap":"GRCh38",
      "position":"chr1:11000-12000","hideTracks":"off",
      "blocks":[{"haplotype":"GRCh38#0#chr1","source_start":11000,"source_end":12000,
                 "target_start":11000,"target_end":12000,"strand":"+"}]}'
    if [ ! -x "$BOX/loader/bedToBigBed" ]; then
        echo "  NOT RUN: the hub file checks, no bedToBigBed found"
        notRun="the hub file checks (no bedToBigBed)"
    else
        out=$(cgi_box "$QCONF" \
            "cmd=quickLift&payload=$(enc "$QL_FULL")&pangenomeQuickLift-hg38-hg38=$(enc "$VICTIM")&hubQuickLift-hg38=$(enc "$THEIRS")")
        check_contains "quickLift: a whole conversion gives a browser link" "$out" '"url":"hgTracks?db=hg38'
        check_eq "... and a file named in the cart that is not ours is not written over" \
            "$(head -1 "$VICTIM")" "somebody else's file"
        check_eq "... and the hub is in our trash directory" \
            "$(find "$TMP/trash/pangenomeQuickLift" -name 'hub*.txt' 2>/dev/null | grep -c .)" "1"
        check_eq "... and hgConvert's quickLift hub is left as it was" "$(theirs_state)" "unchanged"
        check_eq "... and no file of ours is left beside it" \
            "$(find "$TMP/trash/quickLift" -type f | grep -c .)" "1"

        # The other half: a name that is ours is used again.  A new file for
        # every conversion is a new hub attached to the cart every time.
        OURS=$(cd "$BOX" && find ../trash/pangenomeQuickLift -name 'hub*.txt' | head -1)
        out=$(cgi_box "$QCONF" \
            "cmd=quickLift&payload=$(enc "$QL_FULL")&pangenomeQuickLift-hg38-hg38=$(enc "$OURS")")
        check_contains "quickLift: converting again gives a link" "$out" '"url":"hgTracks?db=hg38'
        check_eq "... through the same hub file, not a second one" \
            "$(find "$TMP/trash/pangenomeQuickLift" -name 'hub*.txt' 2>/dev/null | grep -c .)" "1"
    fi

    # ---- the chain the lifted tracks are drawn through ----
    #
    # Built from the blocks of a translation.  Read back from the files, with
    # bigBedToBed: one row a chain, and one row a block in the link file.
    if [ ! -x "$BOX/loader/bedToBigBed" ] || [ -z "$BB2BED" ]; then
        echo "  NOT RUN: the chain checks (bedToBigBed or bigBedToBed not found)"
        notRun="the chain checks"
    else
    blk() {                          # blk <srcStart> <srcEnd> <tgtStart> <tgtEnd> [strand]
        printf '{"haplotype":"GRCh38#0#chr1","source_start":%s,"source_end":%s,"target_start":%s,"target_end":%s,"strand":"%s"}' \
            "$1" "$2" "$3" "$4" "${5:-+}"
    }
    ql_payload() {                   # ql_payload <blocks, comma separated>
        printf '{"srcDb":"hg38","tgtDb":"hg38","src":"GRCh38#0#chr1","srcHap":"GRCh38","position":"chr1:20001-20300","hideTracks":"off","blocks":[%s]}' "$1"
    }
    # chains_of <blocks>: "start-end strand qStart-qEnd" for each chain, then
    # "| start-end@q" for each block, of the chain a conversion just wrote
    chains_of() {
        local before o f
        before=$(find "$TMP/trash/pangenomeQuickLift" -name 'chain*.bb' ! -name '*.link.bb' | sort)
        o=$(cgi_box "$QCONF" "cmd=quickLift&payload=$(enc "$(ql_payload "$1")")")
        f=$(comm -13 <(printf '%s\n' "$before") \
                     <(find "$TMP/trash/pangenomeQuickLift" -name 'chain*.bb' ! -name '*.link.bb' | sort) | head -1)
        if [ -z "$f" ]; then printf '%s' "$o" | tail -1 | cut -c1-160; return; fi
        "$BB2BED" "$f" stdout | awk -F'\t' '{printf "%s-%s %s %s-%s ", $2, $3, $6, $10, $11}'
        printf '|'
        "$BB2BED" "${f%.bb}.link.bb" stdout | awk -F'\t' '{printf " %s-%s@%s", $2, $3, $5}'
    }
    Q1=248956422                     # chr1's length: the reverse strand counts from its end
    check_eq "chain: two blocks in order, a gap between, are one chain of two blocks" \
        "$(chains_of "$(blk 11000 11100 20000 20100),$(blk 11150 11250 20200 20300)")" \
        "20000-20300 + 11000-11250 | 20000-20100@11000 20200-20300@11150"
    check_eq "chain: the blocks may come in any order" \
        "$(chains_of "$(blk 11150 11250 20200 20300),$(blk 11000 11100 20000 20100)")" \
        "20000-20300 + 11000-11250 | 20000-20100@11000 20200-20300@11150"
    check_eq "chain: a block on the other strand is a chain of its own, counted from the far end" \
        "$(chains_of "$(blk 11000 11100 20000 20100),$(blk 11150 11250 20200 20300 -)")" \
        "20000-20100 + 11000-11100 20200-20300 - $((Q1 - 11250))-$((Q1 - 11150)) | 20000-20100@11000 20200-20300@$((Q1 - 11250))"
    check_eq "chain: a block that goes back on the source starts another chain" \
        "$(chains_of "$(blk 11300 11400 20000 20100),$(blk 11000 11100 20200 20300)")" \
        "20000-20100 + 11300-11400 20200-20300 + 11000-11100 | 20000-20100@11300 20200-20300@11000"
    check_contains "chain: a block with nothing in it is refused" \
        "$(chains_of "$(blk 11000 11000 20000 20100)")" "empty or out-of-range"
    check_contains "chain: a block off the end of the source sequence is refused" \
        "$(chains_of "$(blk -5 100 20000 20105)")" "empty or out-of-range"
    check_contains "chain: no blocks at all is said plainly" \
        "$(chains_of "")" "returned no blocks"

    # A hub file is kept from one conversion to the next, and trash is filed by
    # day: a hub from another day gets today's chain, which is not in its own
    # directory.  Named by base name alone, the chain was not found after midnight.
    mkdir -p "$TMP/trash/pangenomeQuickLift/000"
    OLDHUB="../trash/pangenomeQuickLift/000/hub_yesterday.txt"
    echo "hub old" > "$BOX/$OLDHUB"
    out=$(cgi_box "$QCONF" \
        "cmd=quickLift&payload=$(enc "$QL_FULL")&pangenomeQuickLift-hg38-hg38=$(enc "$OLDHUB")")
    check_contains "a hub from another day: the conversion still gives a link" "$out" '"url":"hgTracks?db=hg38'
    named=$(grep '^bigDataUrl ' "$BOX/$OLDHUB" | tail -1 | cut -d' ' -f2)
    check_contains "... its hub file is the one kept" "$(head -1 "$BOX/$OLDHUB")" "hub pangenomeLift"
    check_eq "... and the chain it names is there, from where the hub is" \
        "$([ -n "$named" ] && [ -e "$TMP/trash/pangenomeQuickLift/000/$named" ] && echo found || echo "missing: $named")" "found"
    for u in $(grep '^quickLiftUrl ' "$BOX/$OLDHUB" | cut -d' ' -f2 | sort -u); do
        check_eq "... as is the chain each lifted track names" \
            "$([ -e "$TMP/trash/pangenomeQuickLift/000/$u" ] && echo found || echo "missing: $u")" "found"
    done

    # A command that aborts half way: the answer is still JSON, and the
    # session is left on the assembly it was on, not on the one borrowed to
    # read the source's tracks.
    out=$(cgi_box "$QCONF" "page=convert&db=mm39")
    ABSID=$(printf '%s' "$out" | grep -o 'hgsid=[0-9]*_[A-Za-z0-9]*' | head -1)
    chmod -R a-w "$TMP/trash/pangenomeQuickLift"
    out=$(cgi_box "$QCONF" "cmd=quickLift&$ABSID&payload=$(enc "$QL_FULL")")
    chmod -R u+w "$TMP/trash/pangenomeQuickLift"
    check_contains "an abort inside a conversion is answered as JSON" "$out" '{"status":"error","error":"the request could not be completed'
    check_not_contains "... and not as an HTML page" "$out" "<!DOCTYPE"
    DUMP2=""
    for cand in "/usr/local/apache/cgi-bin-$(id -un)/cartDump" /usr/local/apache/cgi-bin/cartDump; do
        [ -x "$cand" ] && { DUMP2="$cand"; break; }
    done
    if [ -z "$DUMP2" ] || [ -z "$ABSID" ]; then
        echo "  NOT RUN: the session-after-an-abort check (no cartDump, or no session id)"
        notRun="the session-after-an-abort check"
    else
        dump=$(cd "$BOX" && env -i HGDB_CONF="$QCONF" REMOTE_ADDR=127.0.0.1 SERVER_SOFTWARE=Apache \
            REQUEST_METHOD=GET QUERY_STRING="$ABSID" "$DUMP2" 2>&1)
        check_contains "... and the session is still on its own assembly" "$dump" "db mm39"
    fi
    fi

    # More blocks than PG_MAX_BLOCKS.  A request is too short to carry that
    # many, so this is the graph server's own answer, fetched for the chain.
    python3 -c 'import sys
row = "{\"haplotype\":\"GRCh38#0#chr1\",\"source_start\":%d,\"source_end\":%d,\"target_start\":%d,\"target_end\":%d,\"strand\":\"+\"}"
n = int(sys.argv[1]) + 1
sys.stdout.write("{\"blocks\":[" + ",".join(row % (i, i + 1, i, i + 1) for i in range(0, 2 * n, 2)) + "]}")' \
        "$MAXBLOCKS" > "$TMP/manyBlocks.json"
    start_mock --body-file "$TMP/manyBlocks.json"
    { echo "include $QCONF"
      echo "pangenome.apiBase=http://127.0.0.1:$PORT"; } > "$TMP/manyBlocks.conf"
    out=$(cgi_box "$TMP/manyBlocks.conf" "cmd=quickLift&payload=$(enc '{"srcDb":"hg38","tgtDb":"hg38","src":"GRCh38#0#chr1","srcHap":"GRCh38","srcStart":1000,"srcEnd":2000,"tgt":"GRCh38#0","position":"chr1:1-2","hideTracks":"off"}')")
    check_contains "chain: more blocks than the limit are refused" "$out" "too many blocks"

    # a long error from the mapping server, met while fetching the blocks
    start_mock --status 500 --body "$LONG_ERR"
    { echo "include $QCONF"
      echo "pangenome.apiBase=http://127.0.0.1:$PORT"; } > "$TMP/quickliftLong.conf"
    out=$(cgi_post_cmd "$TMP/quickliftLong.conf" quickLift \
        '{"srcDb":"hg38","tgtDb":"hg38","src":"GRCh38#0#chr1","srcHap":"GRCh38",
          "srcStart":1000,"srcEnd":2000,"tgt":"CHM13#0","position":"chr1:1-2",
          "hideTracks":"off"}')
    check_contains "quickLift: a long error from the mapping server is an error envelope" \
        "$out" '{"status":"error","error":"mapping server returned HTTP 500'

    # cmd=locus names the genes at each hit.  An interval far longer than any
    # sequence that can be mapped is not looked up: naming it means reading
    # every gene in it.  (Here because the gene files are found through the
    # central database; the command itself starts no session.)
    LOCUS_AT='"db":"GCA_042077495.1","contig":"CM089723.1","start":135714502'
    out=$(cgi_post_cmd "$QCONF" locus \
        "{\"items\":[{$LOCUS_AT,\"end\":135738459},{$LOCUS_AT,\"end\":140714502}]}")
    check_contains "locus: a hit is named, an interval of 5 Mb is not" "$out" '"loci":["exon LCT-MCM6",null]'

    # The page parameters must not be saved into the user's session: "start",
    # "end" and "src" are names any other tool might read.
    DUMP=""
    for cand in "/usr/local/apache/cgi-bin-$(id -un)/cartDump" /usr/local/apache/cgi-bin/cartDump; do
        [ -x "$cand" ] && { DUMP="$cand"; break; }
    done
    out=$(cgi_box "$QCONF" "page=convert&db=hg38&src=pgSrcMark&start=4242421&end=4242422&refAnnot=pgRefMark&pgTarget=pgTgtMark&pgAnnot=on&pgHide=on")
    SID=$(printf '%s' "$out" | grep -o 'hgsid=[0-9]*_[A-Za-z0-9]*' | head -1)
    if [ -z "$DUMP" ] || [ -z "$SID" ]; then
        echo "  NOT RUN: the saved-session check (no cartDump, or no session id in the page)"
        notRun="the saved-session check"
    else
        dump=$(cd "$BOX" && env -i HGDB_CONF="$QCONF" REMOTE_ADDR=127.0.0.1 SERVER_SOFTWARE=Apache \
            REQUEST_METHOD=GET QUERY_STRING="$SID" "$DUMP" 2>&1)
        check_contains "saved session: read back, with the assembly in it" "$dump" "db hg38"
        for mark in pgSrcMark 4242421 4242422 pgRefMark pgTgtMark "page convert" pgAnnot pgHide; do
            check_not_contains "saved session: no '$mark'" "$dump" "$mark"
        done
    fi

    # the PanLift form prints the cart's db and position into the page
    out=$(cgi_box "$QCONF" "page=convert&db=hg38&position=$(enc "chr1:1-2'><script>alert(1)</script>")")
    check_contains "PanLift form: drawn" "$out" "id='pgcPos'"
    check_not_contains "... with the position escaped" "$out" "'><script>alert(1)"

    # every page names the shared script first and its own script last: the
    # page scripts read hgPangenomeCommon.js as they load
    ends() {                         # ends <page html>: first and last pangenome script
        printf '%s' "$1" | grep -oE "hgPangenome[A-Za-z]*(-v[0-9]+)?\.js" | sed -E 's/-v[0-9]+//' |
            awk 'NR == 1 { first = $0 } { last = $0 } END { print first, last }'
    }
    check_eq "PanLift form: the shared script, then the page's" "$(ends "$out")" \
        "hgPangenomeCommon.js hgPangenomeConvert.js"
    out=$(cgi_box "$QCONF" "page=results&job_id=job1")
    check_eq "results page: the shared script, then the page's" "$(ends "$out")" \
        "hgPangenomeCommon.js hgPangenomeResults.js"
    out=$(cgi_box "$QCONF" "db=hg38")
    check_eq "search form: the shared script, then the page's" "$(ends "$out")" \
        "hgPangenomeCommon.js hgPangenome.js"
fi
fi

# --------------------------------------------------------------------- report

echo
echo "---------------------------------------------"
total=$((pass+fail))
if [ "$fail" -ne 0 ]; then
    echo "FAILED: $fail of $total"
    exit 1
fi
if [ -n "$notRun" ]; then
    echo "PASSED $pass/$total, but NOT RUN: $notRun"
    exit $NOT_RUN
fi
echo "ALL PASSED: $pass/$total"
exit 0
