#!/bin/bash
# proxyTests.sh - Layer 2 of the hgPangenome test suite.
#
# Tests the compiled CGI's API modes (cmd=map / cmd=poll) against a mock
# middleware: server-side input caps, what we actually send upstream (URL,
# Content-Type, auth header, payload bytes), the job-id charset guard, upstream
# HTTP error mapping, timeouts, response passthrough, and that bot-delay is
# applied to submissions but not to polling.
#
# Fully isolated: the test hg.conf files do NOT include the site hg.conf, so
# these tests never contact the shared bottleneck server, MySQL, or the real
# middleware.  Only python3 stdlib + the compiled CGI are needed.
#
# Usage:   ./proxyTests.sh            (exit 0 = all passed)
#          PG_CGI=/path/to/hgPangenome ./proxyTests.sh

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

find_cgi() {
    if [ -n "${PG_CGI:-}" ] && [ -x "${PG_CGI}" ]; then echo "$PG_CGI"; return; fi
    if [ -x ../hgPangenome ]; then echo "$(cd .. && pwd)/hgPangenome"; return; fi
    if [ -x /usr/local/apache/cgi-bin-$USER/hgPangenome ]; then
        echo "/usr/local/apache/cgi-bin-$USER/hgPangenome"; return; fi
    echo ""
}
CGI=$(find_cgi)
if [ -z "$CGI" ]; then
    echo "SKIP: no hgPangenome binary found."
    echo "      Build one with:  (cd .. && make compile)   or set PG_CGI=/path/to/hgPangenome"
    exit 0
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
mk_conf() {                          # mk_conf <file> [extra lines...]
    local f="$1"; shift
    : > "$f"
    for line in "$@"; do echo "$line" >> "$f"; done
}

# Default conf pointing at the running mock.
conf_default() {
    mk_conf "$TMP/hg.conf" \
        "pangenome.apiBase=http://127.0.0.1:$PORT" \
        "pangenome.maxSequences=50" \
        "pangenome.maxSeqLen=100" \
        "pangenome.maxRequestBytes=5000" \
        "pangenome.maxLiftSpan=10000000" \
        "pangenome.maxLiftTargets=10" \
        "pangenome.maxLiftTargetMb=0" \
        "pangenome.timeoutSecs=10"
    echo "$TMP/hg.conf"
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

: > "$REC"
out=$(cgi_post "$CONF" "$(payload_n 51)")
check_contains "51 sequences rejected with the limit" "$out" "too many sequences: 51 (limit is 50)"
check_eq       "51 sequences never reached the middleware" "$(mock_count)" "0"

: > "$REC"
out=$(cgi_post "$CONF" "$(payload_n 50)")
check_contains "50 sequences accepted (boundary)" "$out" "job_id"
check_eq       "50 sequences forwarded once" "$(mock_count)" "1"

: > "$REC"
long=$(python3 -c 'print("A"*101)')
out=$(cgi_post "$CONF" "$(payload_n 1 "$long")")
check_contains "over-long sequence rejected" "$out" "(limit 100)"
check_eq       "over-long sequence not forwarded" "$(mock_count)" "0"

: > "$REC"
exact=$(python3 -c 'print("A"*100)')
out=$(cgi_post "$CONF" "$(payload_n 1 "$exact")")
check_contains "sequence exactly at the length limit accepted" "$out" "job_id"

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

: > "$REC"
big=$(payload_n 50 "$(python3 -c 'print("A"*100)')")
out=$(cgi_post "$CONF" "$big")
check_contains "over-size request body rejected" "$out" "request too large"
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

# ======================================================= C. job_id guard
section "job_id guard (path traversal / SSRF)"

for bad in "../../etc/passwd" "a/b" "a?x=1" "a&b" "a;b" "a b" "http://evil.example/x" '$(id)'; do
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
mk_conf "$TMP/noapi.conf" "pangenome.transport=job"
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

: > "$REC"
out=$(cgi_get "$TMP/bot.conf" "cmd=poll&job_id=job1")
check_not_contains "cmd=poll does not consult the bottleneck server" "$out" "bottleneck"
check_contains     "cmd=poll still works while bot check is unreachable" "$out" '"status": "done"'

# =============================================== F. non-API paths untouched
section "non-API requests do not enter the proxy"

: > "$REC"
out=$(cgi_get "$CONF" "cmd=bogus&job_id=job1")
check_eq           "unknown cmd is not forwarded upstream" "$(mock_count)" "0"
check_not_contains "unknown cmd does not emit an API error envelope" "$out" '"status":"error"'


# ======================================= G. coordinate translation (liftover)
section "coordinate translation: cmd=liftover and cmd=haplotypes"

# earlier sections restarted the mock on other ports; get a fresh one and
# rebuild the confs that point at it
start_mock
CONF=$(conf_default)
mk_conf "$TMP/tok.conf" "pangenome.apiBase=http://127.0.0.1:$PORT" \
                        "pangenome.apiToken=test-token-abc123"

LIFT_OK='{"src":"HG00097#1#CM094066.1","start":19113,"end":19137,"tgt":"HG01234#2"}'

: > "$REC"
out=$(cgi_post_cmd "$CONF" liftover "$LIFT_OK")
check_eq       "liftover forwarded once" "$(mock_count)" "1"
check_eq       "liftover forwarded as POST" "$(mock_field method)" "POST"
check_eq       "liftover hits /api/v1/liftover" "$(mock_field path)" "/api/v1/liftover"
check_eq       "liftover sent as application/json" "$(mock_field content_type)" "application/json"
check_eq       "liftover payload forwarded byte-for-byte" "$(mock_field body)" "$LIFT_OK"
check_contains "liftover intervals passed through" "$out" '"intervals"'
check_contains "interval keeps its full 3-field contig" "$out" 'HG01234#2#CM0987.1'
check_contains "a reverse-strand piece survives" "$out" '"strand": "-"'

# an array of targets is a legal payload too (one request, many haplotypes)
: > "$REC"
LIFT_MULTI='{"src":"HG00097#1#CM094066.1","start":10,"end":20,"tgt":["chm13#0","grch38#0"]}'
out=$(cgi_post_cmd "$CONF" liftover "$LIFT_MULTI")
check_eq "array tgt accepted and forwarded" "$(mock_field body)" "$LIFT_MULTI"

section "every haplotype at once (cmd=liftoverAll)"

# What goes upstream is rebuilt from src/start/end alone: always "*", always
# the summary, whatever else the page sent.
: > "$REC"
out=$(cgi_post_cmd "$CONF" liftoverAll \
    '{"src":"HG00097#1#CM094066.1","start":10,"end":20,"tgt":["chm13#0"],"blocks":true}')
check_eq       "liftoverAll forwarded once" "$(mock_count)" "1"
check_eq       "liftoverAll hits /api/v1/liftover" "$(mock_field path)" "/api/v1/liftover"
sent=$(mock_field body | tr -d ' ')
check_eq       "liftoverAll asks for every haplotype, summarized" "$sent" \
    '{"src":"HG00097#1#CM094066.1","start":10,"end":20,"tgt":"*","summary":true}'
check_contains "liftoverAll answer passed through" "$out" '"intervals"'
: > "$REC"
out=$(cgi_post_cmd "$CONF" liftoverAll '{"src":"HG00097#1","start":10,"end":20}')
check_contains "liftoverAll checks the source path" "$out" "full contig path"
check_eq       "liftoverAll bad source - not forwarded" "$(mock_count)" "0"
# An answer past pangenome.maxLiftAllBytes is refused rather than passed on.
mk_conf "$TMP/small.conf" "pangenome.apiBase=http://127.0.0.1:$PORT" \
                          "pangenome.maxLiftAllBytes=50"
out=$(cgi_post_cmd "$TMP/small.conf" liftoverAll '{"src":"HG00097#1#CM094066.1","start":10,"end":20}')
check_contains "an oversized answer is refused" "$out" "too large to show"
check_contains "and comes back as our error" "$out" '"status":"error"'

section "liftover input validation (server-side, before forwarding)"

lift_reject() {                      # lift_reject <label> <payload> <expected text>
    : > "$REC"
    local o
    o=$(cgi_post_cmd "$CONF" liftover "$2")
    check_contains "$1" "$o" "$3"
    check_eq       "$1 - not forwarded" "$(mock_count)" "0"
}

lift_reject "src must be a full contig path" \
    '{"src":"HG00097#1","start":1,"end":2,"tgt":"chm13#0"}' "full contig path"
lift_reject "missing src rejected" \
    '{"start":1,"end":2,"tgt":"chm13#0"}' "missing 'src'"
lift_reject "missing start/end rejected" \
    '{"src":"a#1#c","tgt":"chm13#0"}' "missing 'start' or 'end'"
lift_reject "non-numeric coordinates rejected" \
    '{"src":"a#1#c","start":"x","end":"y","tgt":"chm13#0"}' "must be numbers"
lift_reject "end must exceed start" \
    '{"src":"a#1#c","start":50,"end":50,"tgt":"chm13#0"}' "greater than"
lift_reject "negative start rejected" \
    '{"src":"a#1#c","start":-5,"end":10,"tgt":"chm13#0"}' "negative"
lift_reject "over-span rejected at the 10Mb cap" \
    '{"src":"a#1#c","start":0,"end":10000001,"tgt":"chm13#0"}' "limit 10000000"
lift_reject "missing tgt rejected" \
    '{"src":"a#1#c","start":1,"end":2}' "'tgt' must be"
lift_reject "empty tgt array rejected" \
    '{"src":"a#1#c","start":1,"end":2,"tgt":[]}' "empty"
# each target is a separate traversal upstream; a request naming them all can
# take the mapping service down, so the cap is enforced here too
many=$(python3 -c 'import json;print(json.dumps(["h%d#1" % i for i in range(11)]))')
lift_reject "more than 10 targets rejected" \
    "{\"src\":\"a#1#c\",\"start\":1,\"end\":2,\"tgt\":$many}" \
    "too many target haplotypes: 11 (limit is 10 per conversion)"

: > "$REC"
ten=$(python3 -c 'import json;print(json.dumps(["h%d#1" % i for i in range(10)]))')
out=$(cgi_post_cmd "$CONF" liftover "{\"src\":\"a#1#c\",\"start\":1,\"end\":2,\"tgt\":$ten}")
check_eq "exactly 10 targets accepted (boundary)" "$(mock_count)" "1"

# The cost of a translation is span x targets, not either alone: the mapping
# service traverses once per target and serves one request at a time.  Capping
# each half separately is what let 10 Mb x 10 targets through as ~110 s of
# exclusive backend time.
mk_conf "$TMP/budget.conf" "pangenome.apiBase=http://127.0.0.1:$PORT" \
    "pangenome.maxLiftSpan=10000000" "pangenome.maxLiftTargets=10" \
    "pangenome.maxLiftTargetMb=5"
four=$(python3 -c 'import json;print(json.dumps(["h%d#1" % i for i in range(4)]))')
out=$(cgi_post_cmd "$TMP/budget.conf" liftover \
    "{\"src\":\"a#1#c\",\"start\":0,\"end\":2000000,\"tgt\":$four}")
check_contains "span x targets over budget rejected" "$out" \
    "megabase-assemblies"

: > "$REC"
two=$(python3 -c 'import json;print(json.dumps(["h%d#1" % i for i in range(2)]))')
out=$(cgi_post_cmd "$TMP/budget.conf" liftover \
    "{\"src\":\"a#1#c\",\"start\":0,\"end\":2000000,\"tgt\":$two}")
check_eq "within budget accepted (2 x 2Mb = 4)" "$(mock_count)" "1"

# Ours must fire below cheapcgi's own 1 MB cap, which aborts with an HTML page
# a JSON client can only report as "Unexpected token '<'".
mk_conf "$TMP/big.conf" "pangenome.apiBase=http://127.0.0.1:$PORT" \
    "pangenome.maxRequestBytes=2000"
big=$(python3 -c 'print("{\"src\":\"a#1#c\",\"start\":1,\"end\":2,\"pad\":\"" + "x"*4000 + "\"}")')
out=$(cgi_post_cmd "$TMP/big.conf" liftover "$big")
check_contains "oversized payload rejected as JSON, not HTML" "$out" \
    "request too large"
check_not_contains "oversized payload does not emit an HTML page" "$out" "DOCTYPE"

# The page no longer posts its blocks - the server fetches them - so a failed
# fetch must say why.  Reporting "no 'blocks' array in the request" described
# our own request and hid the upstream reason (a 503 while the service was
# restarting looked identical to a region that cannot be lifted).
mk_conf "$TMP/dead2.conf" "pangenome.apiBase=http://127.0.0.1:$(free_port)"
out=$(cgi_post_cmd "$TMP/dead2.conf" quickLift \
    '{"srcDb":"hg38","tgtDb":"hg38","src":"GRCh38#0#chr1","srcHap":"GRCh38",
      "srcStart":1000,"srcEnd":2000,"tgt":"CHM13#0","position":"chr1:1-2",
      "hideTracks":"off"}')
check_not_contains "failed block fetch does not blame the request" "$out" \
    "no 'blocks' array"

lift_reject "malformed JSON rejected without aborting" \
    '{"src":' "invalid JSON payload"

: > "$REC"
out=$(cgi_post_cmd "$CONF" liftover '{"src":"a#1#c","start":0,"end":10000000,"tgt":"chm13#0"}')
check_eq "exactly at the span cap is accepted" "$(mock_count)" "1"

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
out=$(cgi_post_cmd "$CONF" liftoverTargets '{"src":"a#1#c","start":0,"end":10000001}')
check_contains "span cap still enforced" "$out" "limit 10000000"
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
cgi_post_cmd "$TMP/tok.conf" liftover "$LIFT_OK" > /dev/null
check_eq "token sent on liftover" "$(mock_field token)" "test-token-abc123"
: > "$REC"
cgi_get "$TMP/tok.conf" "cmd=haplotypes" > /dev/null
check_eq "token sent on haplotypes" "$(mock_field token)" "test-token-abc123"

out=$(cgi_post_cmd "$TMP/dead.conf" liftover "$LIFT_OK")
check_contains "unreachable middleware reported on liftover" "$out" "could not reach mapping server"
out=$(cgi_post_cmd "$TMP/noapi.conf" liftover "$LIFT_OK")
check_contains "missing apiBase reported on liftover" "$out" "apiBase is not configured"

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

section "alignTrack: a hostile query name cannot corrupt the files"

# the name comes from the user's own FASTA header and lands in a FASTA line, a
# PSL column and hgc's whitespace-split "i=" parameter
ql_name_probe=$(cgi_post_cmd "$CONF" alignTrack \
  '{"db":"noSuchDb","contig":"c","name":"a b","sequence":"ACGT","cigar":"4M","start":0}')
case "$ql_name_probe" in
    *'"status"'*) check_contains "unknown assembly still reported cleanly" \
                      "$ql_name_probe" "no sequence sizes available" ;;
    *) echo "  SKIP: alignTrack needs a cart-capable hg.conf" ;;
esac

section "quickLift annotation lifting (validation)"

# cmd=quickLift is the one command that builds a track hub, so unlike the rest
# it runs inside the cart shell and needs a central database.  The isolated
# hg.conf these tests use deliberately has none, so the shell aborts before any
# of our code runs.  Probe for that and skip rather than report failures the
# developer cannot act on.
# Borrow database settings from a real hg.conf; the rest of the suite stays
# hermetic, only this section needs one.  Probe by actually running the command
# rather than by inspecting the file - credentials often live in an included
# private file we cannot read from here.
ql_ok=0
QCONF=""
for cand in "${HGDB_CONF:-}" "${HOME:-}/.hg.conf" "${HOME:-}/hg.conf" \
            /usr/local/apache/cgi-bin-$(id -un)/hg.conf \
            /usr/local/apache/cgi-bin/hg.conf; do
    [ -n "$cand" ] && [ -r "$cand" ] || continue
    abs=$(cd "$(dirname "$cand")" && pwd)/$(basename "$cand")
    # Borrow the database settings but not the site's front-door defences:
    # with a bottleneck server and a Cloudflare site key configured, a
    # cookie-less request like ours is answered with a captcha page instead of
    # reaching the command at all.
    { echo "include $abs"
      echo "delete cloudFlareSiteKey bottleneck.host bottleneck.port"
      echo "pangenome.apiBase=http://127.0.0.1:$PORT"
      echo "pangenome.timeoutSecs=10"; } > "$TMP/quicklift.conf"
    case "$(cgi_post_cmd "$TMP/quicklift.conf" quickLift '{}' 2>/dev/null)" in
        *'"status"'*) ql_ok=1; QCONF="$TMP/quicklift.conf"; break ;;
    esac
done

if [ "$ql_ok" -eq 0 ]; then
    echo "  SKIP: no hg.conf with a reachable central database"
else
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
fi

# --------------------------------------------------------------------- report

echo
echo "---------------------------------------------"
total=$((pass+fail))
if [ "$fail" -eq 0 ]; then
    echo "ALL PASSED: $pass/$total"
    exit 0
else
    echo "FAILED: $fail of $total"
    exit 1
fi
