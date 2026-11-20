#!/usr/bin/env python3
"""cgiTests.py - the hgPangenome CGI, run as a real CGI against a mock graph server.

What is tested: the limits on a request, what is sent on to the graph server
(URL, Content-Type, token, payload), the checks on names, how a failure of the
graph server is worded, timeouts, the rate limit, and - with PG_DB_TESTS=1 -
the commands that run inside the cart, with the files they write.

The CGI tested is the one built from this tree: $PG_CGI, or ../hgPangenome as
"make compile" leaves it.  "make test" builds it first.  An installed CGI is
never used, because it may be older than the source being tested.

Isolated: the test hg.conf files do not include the site hg.conf, so nothing
here contacts the bottleneck server, MySQL or the real graph server.  The
exception is the cart commands, left out unless PG_DB_TESTS=1 ("make
testWithDb"): the cart needs the browser's central database, and each request
starts a session row there.

Every request runs in a directory laid out as cgi-bin is, under a temporary
directory, so the CGI's ../trash is there too and nothing is left behind.

Run:  python3 cgiTests.py            every test
      python3 cgiTests.py InputLimits            one class
      PG_LIST_CHECKS=1 python3 cgiTests.py       name each check as it is made

Exit 0 = all passed, 1 = a check failed, 77 = something could not run (no
CGI built, or no hg.conf here reaches a central database).
"""

import atexit
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.parse

__unittest = True       # a failed check is reported without the lines of this file that raised it

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="pgCgiTests.")
NOT_RUN = 77
LIST_CHECKS = os.environ.get("PG_LIST_CHECKS") == "1"
checks = 0


def find_cgi():
    """The CGI built from this tree, or None."""
    named = os.environ.get("PG_CGI")
    path = named if named else os.path.join(HERE, "..", "hgPangenome")
    return os.path.abspath(path) if os.access(path, os.X_OK) and os.path.isfile(path) else None


CGI = find_cgi()


def setUpModule():
    if CGI is None:
        raise unittest.SkipTest('no hgPangenome built from this tree: use "make test", which '
                                'builds one, or set PG_CGI=/path/to/hgPangenome')


# ------------------------------------------------------------ the mock server

def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Mock:
    """mockMiddleware.py, restarted whenever a test wants it to answer differently."""

    def __init__(self):
        self.proc = None
        self.args = None
        self.port = None
        self.record = os.path.join(TMP, "requests.jsonl")

    def start(self, *args):
        """Have the mock running with these arguments; a no-op if it already is."""
        if self.proc is not None and self.args == args:
            self.clear()
            return
        self.stop()
        self.port = free_port()
        self.clear()
        log = os.path.join(TMP, "mock.err")
        with open(log, "w") as err:
            self.proc = subprocess.Popen(
                [sys.executable, os.path.join(HERE, "mockMiddleware.py"), "--port", str(self.port),
                 "--record", self.record] + list(args), stderr=err)
        self.args = args
        for _ in range(50):
            if "listening" in read(log):
                return
            time.sleep(0.1)
        raise RuntimeError("the mock graph server did not start: " + read(log))

    def stop(self):
        if self.proc is not None:
            self.proc.kill()
            self.proc.wait()
            self.proc = None

    def clear(self):
        open(self.record, "w").close()

    def requests(self):
        return [json.loads(line) for line in read(self.record).split("\n") if line.strip()]

    def count(self):
        return len(self.requests())

    def last(self, key):
        """One field of the last request the mock was sent; None if it had none."""
        got = self.requests()
        return got[-1].get(key) if got else None


MOCK = Mock()


def cleanup():
    MOCK.stop()
    shutil.rmtree(TMP, ignore_errors=True)


atexit.register(cleanup)


# ------------------------------------------------------- hg.conf and the CGI

def conf(name, *lines, tools=True):
    """Write a test hg.conf.  Standalone: it does not include the site's.  The
    tools are turned on unless the test is about them being off."""
    path = os.path.join(TMP, name)
    with open(path, "w") as fh:
        if tools:
            fh.write("pangenomeTools=on\n")
        for line in lines:
            fh.write(line + "\n")
    return path


def mock_conf(name="hg.conf", *lines):
    """A conf pointing at the running mock."""
    return conf(name, "pangenome.apiBase=http://127.0.0.1:%d" % MOCK.port, *lines)


def new_box(name):
    """A directory laid out as cgi-bin is: the CGI's ../trash is then beside it."""
    box = os.path.join(TMP, name, "cgi-bin")
    os.makedirs(os.path.join(box, "loader"))
    os.makedirs(os.path.join(TMP, name, "trash"))
    return box


PLAIN = new_box("plain")


def run_cgi(cf, method, body="", qs="", box=None, split=False, program=None, more_env=None):
    """Run the CGI as the web server would.  Returns what the browser gets with
    what the error log gets after it; with split, the two apart."""
    env = {"HGDB_CONF": cf, "REMOTE_ADDR": "127.0.0.1", "REQUEST_METHOD": method}
    env.update(more_env or {})
    if box is not None:
        # what makes the library keep its trash files in ../trash, as under the web server
        env["SERVER_SOFTWARE"] = "Apache"
    data = body.encode()
    if method == "POST":
        env["CONTENT_TYPE"] = "application/x-www-form-urlencoded"
        env["CONTENT_LENGTH"] = str(len(data))
    else:
        env["QUERY_STRING"] = qs
    p = subprocess.run([program or CGI], input=data, env=env, cwd=box or PLAIN,
                       stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE if split else subprocess.STDOUT)
    out = p.stdout.decode("utf8", "replace")
    return (out, p.stderr.decode("utf8", "replace")) if split else out


def read(*path):
    with open(os.path.join(*path)) as fh:
        return fh.read()


def enc(text):
    return urllib.parse.quote(text, safe="")


def post(cf, cmd, payload, **kw):
    """POST a command with a JSON payload, as the page scripts do."""
    return run_cgi(cf, "POST", "cmd=%s&payload=%s" % (cmd, enc(payload)), **kw)


def get(cf, qs, **kw):
    return run_cgi(cf, "GET", qs=qs, **kw)


def seqs(n, sequence="ACGT"):
    """A mapping request of n sequences."""
    return json.dumps({"sequences": [{"name": "s%d" % i, "sequence": sequence} for i in range(n)],
                       "options": {"max_multimaps": 1, "surject": True, "surject_target": None}})


ONE_SEQ = '{"sequences":[{"name":"r","sequence":"ACGT"}],"options":{}}'


# ------------------------------------------------------------------ the limits

def limit(name):
    """A limit, read from the header the CGI is built from.  Most limits are
    fixed values and no hg.conf reaches them, so the checks are made at the
    values that ship, wherever those are set."""
    text = read(HERE, "..", "hgPangenome.h")
    m = re.search(r"^#define %s (\d+)\b" % re.escape(name), text, re.M)
    return int(m.group(1)) if m else None


def setting_default(name):
    """The default of a setting that is a number, read from where the CGI reads it."""
    text = read(HERE, "..", "hgPangenome.c")
    m = re.search(r'cfgOptionDefault\("%s", "(\d+)"\)' % re.escape(name), text)
    return int(m.group(1)) if m else None


# ------------------------------------------------------------------- checking

class CgiTest(unittest.TestCase):
    """A test is a few requests, each followed by named checks.  A check that
    fails does not stop the ones after it."""

    mock_args = ()

    def setUp(self):
        MOCK.start(*self.mock_args)
        self.conf = mock_conf("hg.conf", "pangenome.timeoutSecs=10")

    def _check(self, label, passed, detail):
        global checks
        checks += 1
        if LIST_CHECKS:
            print("  %s %s" % ("ok  " if passed else "FAIL", label))
        with self.subTest(label):
            self.assertTrue(passed, detail)

    def has(self, label, text, needle):
        self._check(label, needle in text, "expected to contain: %r\ngot: %r" % (needle, text[:300]))

    def lacks(self, label, text, needle):
        self._check(label, needle not in text, "should not contain: %r\ngot: %r" % (needle, text[:300]))

    def eq(self, label, actual, expected):
        self._check(label, actual == expected, "expected: %r\nactual:   %r" % (expected, actual))


# ============================================================== the input limits

class InputLimits(CgiTest):
    """What a mapping request may hold.  Enforced here: the browser's own
    checks can be skipped."""

    def test_limits_are_read(self):
        got = [setting_default("pangenome.maxSequences"), setting_default("pangenome.maxSeqLen"),
               limit("PG_MAX_REQUEST_BYTES"), limit("PG_MAX_LIFT_SPAN"), limit("PG_MAX_CHOSEN_TARGETS"),
               limit("PG_MAX_LIFT_ALL_BYTES"), limit("PG_MAX_BLOCKS")]
        self.eq("the limits are read from hgPangenome.h", [g is not None and g > 0 for g in got], [True] * 7)

    def test_the_two_settings_set_lower(self):
        # How many sequences and how long are settings, so that a server can
        # lower them without a rebuild.
        fewer = mock_conf("fewer.conf", "pangenome.maxSequences=3", "pangenome.maxSeqLen=50")
        self.has("maxSequences set lower: one too many refused", post(fewer, "map", seqs(4)),
                 "too many sequences: 4 (limit is 3)")
        self.has("maxSequences set lower: as many as it says accepted", post(fewer, "map", seqs(3)), "job_id")
        self.has("maxSeqLen set lower: one base too many refused", post(fewer, "map", seqs(1, "A" * 51)),
                 "(limit 50)")
        self.has("maxSeqLen set lower: exactly as long accepted", post(fewer, "map", seqs(1, "A" * 50)),
                 "job_id")
        self.eq("... and only the two accepted requests were forwarded", MOCK.count(), 2)

    def test_number_of_sequences(self):
        most = setting_default("pangenome.maxSequences")
        out = post(self.conf, "map", seqs(most + 1))
        self.has("one sequence too many rejected with the limit", out,
                 "too many sequences: %d (limit is %d)" % (most + 1, most))
        self.eq("... and never reached the middleware", MOCK.count(), 0)
        out = post(self.conf, "map", seqs(most))
        self.has("as many sequences as the limit accepted (boundary)", out, "job_id")
        self.eq("... and forwarded once", MOCK.count(), 1)

    def test_length_of_a_sequence(self):
        longest = setting_default("pangenome.maxSeqLen")
        out = post(self.conf, "map", seqs(1, "A" * (longest + 1)))
        self.has("over-long sequence rejected", out, "(limit %d)" % longest)
        self.eq("over-long sequence not forwarded", MOCK.count(), 0)
        out = post(self.conf, "map", seqs(1, "A" * longest))
        self.has("sequence exactly at the length limit accepted", out, "job_id")

    def test_the_limits_agree(self):
        # The most sequences, each as long as one may be, is a request the form
        # lets through, so the size limit must hold it.
        most, longest = setting_default("pangenome.maxSequences"), setting_default("pangenome.maxSeqLen")
        out = post(self.conf, "map", seqs(most, "A" * longest))
        self.has("the most sequences at the greatest length fit one request", out, "job_id")
        # and the same with nothing configured but the graph server
        defaults = mock_conf("defaults.conf")
        MOCK.clear()
        out = post(defaults, "map", seqs(10, "ACGT" * 25000))
        self.eq("default limits: ten sequences of 100,000 bases are accepted", MOCK.count(), 1)
        self.has("... and the job is taken", out, '"job_id"')
        out = post(defaults, "map", seqs(11))
        self.has("default limits: an eleventh sequence is refused", out, "too many sequences")

    def test_size_of_a_request(self):
        # Ours must fire below cheapcgi's own 1 MB cap, which aborts with an HTML
        # page a JSON client can only report as "Unexpected token '<'".
        out = post(self.conf, "map", seqs(1, "A" * (limit("PG_MAX_REQUEST_BYTES") + 1000)))
        self.has("over-size request body rejected", out, "request too large")
        self.lacks("... as JSON, not as an HTML page", out, "DOCTYPE")
        self.eq("over-size body not forwarded", MOCK.count(), 0)

    def test_bases(self):
        out = post(self.conf, "map", '{"sequences":[{"name":"r","sequence":"ACGTX"}],"options":{}}')
        self.has("invalid character rejected", out, "only A,C,G,T,N allowed")
        self.eq("invalid character not forwarded", MOCK.count(), 0)
        out = post(self.conf, "map", '{"sequences":[{"name":"r","sequence":"acgtn"}],"options":{}}')
        self.has("lower-case acgtn accepted", out, "job_id")
        out = post(self.conf, "map", '{"sequences":[{"name":"r","sequence":"ACGU"}],"options":{}}')
        self.has("RNA (U) rejected", out, "only A,C,G,T,N allowed")

    def test_malformed_requests(self):
        out = post(self.conf, "map", '{"sequences": [ ')
        self.has("malformed JSON rejected without aborting", out, "invalid JSON payload")
        self.eq("malformed JSON not forwarded", MOCK.count(), 0)
        self.has("payload with no sequences field rejected", post(self.conf, "map", '{"options":{}}'),
                 "missing 'sequences'")
        self.has("empty sequences array rejected", post(self.conf, "map", '{"sequences":[],"options":{}}'),
                 "no sequences submitted")
        self.has("sequence entry without a sequence rejected",
                 post(self.conf, "map", '{"sequences":[{"name":"r"}],"options":{}}'), "no 'sequence'")
        self.has("empty sequence string rejected",
                 post(self.conf, "map", '{"sequences":[{"name":"r","sequence":""}],"options":{}}'), "empty")
        # a name is one word: a line break in one would start a second record
        # in the FASTA the job's sequences are kept in
        MOCK.clear()
        for what, name in [("a line break", "q1\\n>q2\\nAAAAAAAA"), ("a blank", "a b"), ("a tab", "a\\tb")]:
            out = post(self.conf, "map", '{"sequences":[{"name":"%s","sequence":"ACGT"}],"options":{}}' % name)
            self.has("sequence name with %s in it rejected" % what, out,
                     "a sequence name has a blank or a line break in it")
        self.eq("... and none of them forwarded", MOCK.count(), 0)

    def test_alignments_per_sequence(self):
        out = post(self.conf, "map", '{"sequences":[{"name":"a","sequence":"ACGT"}],"options":{"max_multimaps":4}}')
        self.has("more than the ceiling rejected", out, "too many alignments per sequence: 4 (limit is 3)")
        self.eq("and not forwarded", MOCK.count(), 0)
        post(self.conf, "map", '{"sequences":[{"name":"a","sequence":"ACGT"}],"options":{"max_multimaps":3}}')
        self.eq("exactly the ceiling accepted (boundary)", MOCK.count(), 1)
        # the JSON parser files 4 and 4.0 as different types; the ceiling is for both
        MOCK.clear()
        one = '{"sequences":[{"name":"a","sequence":"ACGT"}],"options":{"max_multimaps":%s}}'
        self.has("more than the ceiling, written with a decimal point, rejected",
                 post(self.conf, "map", one % "1000.0"), "too many alignments per sequence: 1000 (limit is 3)")
        self.has("... and written with an exponent", post(self.conf, "map", one % "1e3"),
                 "too many alignments per sequence")
        self.has("a ceiling that is not a number rejected", post(self.conf, "map", one % '"9"'),
                 "max_multimaps must be a number")
        self.eq("none of them forwarded", MOCK.count(), 0)
        post(self.conf, "map", one % "3.0")
        self.eq("the ceiling itself, with a decimal point, accepted", MOCK.count(), 1)


# ================================================= what is sent to the graph server

class RequestShaping(CgiTest):

    def test_a_mapping_is_forwarded_as_it_came(self):
        payload = ('{"sequences":[{"name":"r1","sequence":"ACGTACGT"}],"options":{"max_multimaps":1,'
                   '"surject":true,"surject_target":"CHM13#0#chr10"}}')
        out = post(self.conf, "map", payload)
        self.eq("valid submit forwarded exactly once", MOCK.count(), 1)
        self.eq("forwarded as POST", MOCK.last("method"), "POST")
        self.eq("forwarded to /api/v1/map", MOCK.last("path"), "/api/v1/map")
        self.eq("sent as application/json", MOCK.last("content_type"), "application/json")
        self.eq("payload forwarded byte-for-byte", MOCK.last("body"), payload)
        self.eq("Accept: application/json sent", MOCK.last("accept"), "application/json")
        self.has("identifies itself as hgPangenome", MOCK.last("user_agent") or "", "hgPangenome")
        self.has("middleware answer passed through", out, '"job_id": "job1"')
        self.has("CGI emits JSON content type", out, "Content-Type: application/json")

    def test_poll(self):
        out = get(self.conf, "cmd=poll&job_id=job1")
        self.eq("poll forwarded as GET", MOCK.last("method"), "GET")
        self.eq("poll hits /api/v1/map/<job_id>", MOCK.last("path"), "/api/v1/map/job1")
        self.has("poll result passed through", out, '"status": "done"')

    def test_trailing_slash_in_the_address(self):
        slash = conf("slash.conf", "pangenome.apiBase=http://127.0.0.1:%d/" % MOCK.port)
        get(slash, "cmd=poll&job_id=job1")
        self.eq("trailing slash in apiBase normalized", MOCK.last("path"), "/api/v1/map/job1")

    def test_token(self):
        tok = mock_conf("tok.conf", "pangenome.apiToken=test-token-abc123")
        post(tok, "map", ONE_SEQ)
        self.eq("configured token sent as X-Pangenome-Token", MOCK.last("token"), "test-token-abc123")
        MOCK.clear()
        get(tok, "cmd=poll&job_id=job1")
        self.eq("token also sent on poll", MOCK.last("token"), "test-token-abc123")
        MOCK.clear()
        post(self.conf, "map", ONE_SEQ)
        self.eq("no token configured means no auth header", MOCK.last("token"), None)
        MOCK.clear()
        post(tok, "liftoverAll", LIFT_OK)
        self.eq("token sent on a translation", MOCK.last("token"), "test-token-abc123")
        MOCK.clear()
        get(tok, "cmd=haplotypes")
        self.eq("token sent on haplotypes", MOCK.last("token"), "test-token-abc123")

    def test_job_id(self):
        # "." and ".." are made of allowed characters and still name a directory
        for bad in ["../../etc/passwd", "a/b", "a?x=1", "a&b", "a;b", "a b", "http://evil.example/x",
                    "$(id)", ".", "..", ".hidden", "-x"]:
            MOCK.clear()
            out = get(self.conf, "cmd=poll&job_id=" + enc(bad))
            self.has("rejects job_id '%s'" % bad, out, "invalid 'job_id'")
            self.eq("job_id '%s' not forwarded" % bad, MOCK.count(), 0)
        self.has("missing job_id rejected", get(self.conf, "cmd=poll"), "invalid 'job_id'")
        out = get(self.conf, "cmd=poll&job_id=" + "a" * 129)
        self.has("over-long job_id rejected", out, "invalid 'job_id'")
        self.eq("over-long job_id not forwarded", MOCK.count(), 0)
        get(self.conf, "cmd=poll&job_id=abc-123_XY.9")
        self.eq("accepts a normal job_id charset", MOCK.last("path"), "/api/v1/map/abc-123_XY.9")

    def test_haplotypes(self):
        out = get(self.conf, "cmd=haplotypes")
        self.eq("haplotypes forwarded as GET", MOCK.last("method"), "GET")
        self.eq("haplotypes hits /api/v1/haplotypes", MOCK.last("path"), "/api/v1/haplotypes")
        self.has("haplotype list passed through", out, '"haplotypes"')
        self.has("names match our assembly-table keys", out, "hg00097#1")


class Redirect(CgiTest):
    """A redirect is not followed.  Following it would send the token, which is
    in a header of ours, to wherever the redirect pointed."""

    mock_args = ("--redirect",)

    def test_a_redirect_is_not_followed(self):
        tok = mock_conf("redir.conf", "pangenome.apiToken=test-token-abc123")
        out = post(tok, "map", ONE_SEQ)
        self.eq("a redirect is not followed", MOCK.count(), 1)
        self.lacks("... so the token goes nowhere else", json.dumps(MOCK.requests()), "/redirected")
        self.has("... and is reported as an error", out, "answered with a redirect (HTTP 302)")


class OffSwitch(CgiTest):

    def test_tools_off(self):
        off = mock_conf("off.conf")
        with open(off, "w") as fh:          # no pangenomeTools line at all
            fh.write("pangenome.apiBase=http://127.0.0.1:%d\n" % MOCK.port)
        out = post(off, "map", ONE_SEQ)
        self.has("tools off: map says they are not available", out, "not available on this server")
        self.eq("tools off: nothing sent to the graph server", MOCK.count(), 0)
        self.has("tools off: poll says so too", get(off, "cmd=poll&job_id=job1"), "not available on this server")
        self.has("tools off: a file-reading command says so too", get(off, "cmd=pclai"),
                 "not available on this server")


# ===================================================== when the graph server fails

class GraphServerFailures(CgiTest):

    def answer(self, *mock_args):
        """What a mapping request gets when the mock answers this way."""
        MOCK.start(*mock_args)
        return post(mock_conf("hg.conf", "pangenome.timeoutSecs=10"), "map", ONE_SEQ)

    def test_status_codes(self):
        for code in (400, 401, 403, 429, 500, 503):
            out = self.answer("--status", str(code), "--body", '{"status":"error","error":"upstream says no"}')
            self.has("HTTP %d surfaced as an error envelope" % code, out, '"status":"error"')
            self.has("HTTP %d names the status code" % code, out, "HTTP %d" % code)

    def test_an_html_error_page_is_not_quoted(self):
        out = self.answer("--status", "503", "--content-type", "text/html", "--body",
                          '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN"><html><head><title>503 Service '
                          'Unavailable</title></head><body><h1>Service Unavailable</h1></body></html>')
        self.has("HTML 503 reported as unavailable", out, "mapping service is unavailable")
        self.has("HTML 503 names the status", out, "503")
        self.lacks("HTML 503 quotes no markup", out, "DOCTYPE")
        self.lacks("HTML 503 quotes no tags", out, "<html>")
        out = self.answer("--status", "502", "--content-type", "text/html", "--body",
                          "<html><body>Bad Gateway</body></html>")
        self.has("HTML 502 blamed on the proxy hop", out, "through its proxy")
        self.lacks("HTML 502 quotes no markup", out, "<html>")

    def test_a_json_error_is_quoted(self):
        out = self.answer("--status", "400", "--body", '{"status":"error","error":"unknown source haplotype"}')
        self.has("a JSON upstream error is still quoted", out, "unknown source haplotype")
        # ... but only its first part.  Copied whole into a fixed buffer, a long
        # one aborted the CGI and the page got an error page where it wanted JSON.
        out = self.answer("--status", "500", "--body", LONG_ERR)
        self.has("a long JSON upstream error is still an error envelope", out,
                 '{"status":"error","error":"mapping server returned HTTP 500')
        self.lacks("... and quotes only the first part", out, "x" * 500)

    def test_an_answer_that_is_not_json(self):
        out = self.answer("--status", "200", "--content-type", "text/plain", "--body", "this is not json")
        self.has("non-JSON 200 is passed through verbatim (client reports it)", out, "this is not json")

    def test_unreachable(self):
        dead = conf("dead.conf", "pangenome.apiBase=http://127.0.0.1:%d" % free_port())
        self.has("unreachable middleware reported clearly", post(dead, "map", ONE_SEQ),
                 "could not reach mapping server")
        self.has("unreachable middleware reported on a translation", post(dead, "liftoverAll", LIFT_OK),
                 "could not reach mapping server")

    def test_slow(self):
        MOCK.start("--delay", "3")
        slow = mock_conf("to.conf", "pangenome.timeoutSecs=1")
        self.has("slow middleware times out instead of hanging", post(slow, "map", ONE_SEQ),
                 "could not reach mapping server")

    def test_no_address(self):
        noapi = conf("noapi.conf")
        self.has("missing apiBase reported", post(noapi, "map", ONE_SEQ), "apiBase is not configured")
        self.has("missing apiBase reported on poll too", get(noapi, "cmd=poll&job_id=job1"),
                 "apiBase is not configured")
        self.has("missing apiBase reported on a translation", post(noapi, "liftoverAll", LIFT_OK),
                 "apiBase is not configured")

    def test_an_answer_too_long_to_show(self):
        # One region on every haplotype is about 1 kB a haplotype.  An answer
        # past PG_MAX_LIFT_ALL_BYTES is not read to its end and is not passed on.
        row = '{"haplotype":"H#1","pieces":[],"mapped_bp":0}'
        path = os.path.join(TMP, "longAnswer.json")
        with open(path, "w") as fh:
            fh.write('{"summary":[' + ",".join([row] * (limit("PG_MAX_LIFT_ALL_BYTES") // len(row) + 1)) + "]}")
        MOCK.start("--body-file", path)
        out = post(mock_conf("long.conf"), "liftoverAll", '{"src":"HG00097#1#CM094066.1","start":10,"end":20}')
        self.has("an answer past the limit is refused", out, "too large to show")
        self.has("... and comes back as our error", out, '"status":"error"')
        self.eq("... of a few hundred bytes", len(out) < 600, True)


LONG_ERR = '{"status":"error","error":"' + "x" * 3000 + '"}'
LIFT_OK = '{"src":"HG00097#1#CM094066.1","start":19113,"end":19137,"tgt":["HG01234#2"]}'


# ================================================================= the rate limit

class RateLimit(CgiTest):
    """With the bottleneck server pointed at a dead port, a command that is
    rate limited asks it and fails closed; one that is not does not ask."""

    def setUp(self):
        super().setUp()
        self.bot = mock_conf("bot.conf", "bottleneck.host=127.0.0.1", "bottleneck.port=%d" % free_port())

    def test_a_submission_asks(self):
        # stdout is what the browser sees, stderr what the error log gets
        body, log = post(self.bot, "map", ONE_SEQ, split=True)
        self.has("cmd=map consults the bottleneck server", log, "bottleneck")
        # When the bottleneck server is down the answer must still be JSON, not
        # an HTML 500 page (the page would show raw markup).
        self.has("bottleneck failure answered as JSON", body, "Content-Type: application/json")
        self.has("bottleneck failure uses our error envelope", body, '"status":"error"')
        self.has("bottleneck failure message is user-facing", body, "rate limiter unavailable")
        self.lacks("bottleneck failure leaks no HTML to the browser", body, "<!DOCTYPE")
        self.lacks("bottleneck failure leaks no host/port to the browser", body, "IP 127.0.0.1")
        self.has("bottleneck failure detail is written to the error log", log, "bot check failed")

    def test_locus_and_the_batch_surjection_ask(self):
        self.has("cmd=locus consults the bottleneck server too", post(self.bot, "locus", '{"items":[]}'),
                 "rate limiter unavailable")
        # The batch surjection is the heaviest request there is, so it is limited too.
        MOCK.clear()
        out = post(self.bot, "surjectAll", '{"job_id":"job1","name":"r1"}')
        self.has("cmd=surjectAll consults the bottleneck server", out, "rate limiter unavailable")
        self.eq("... and is not forwarded when the check cannot be made", MOCK.count(), 0)

    def test_polling_does_not_ask(self):
        out = get(self.bot, "cmd=poll&job_id=job1")
        self.lacks("cmd=poll does not consult the bottleneck server", out, "bottleneck")
        self.has("cmd=poll still works while bot check is unreachable", out, '"status": "done"')


# =================================================================== the commands

class Commands(CgiTest):

    def test_a_command_that_does_not_exist(self):
        out = get(self.conf, "cmd=bogus&job_id=job1")
        self.eq("unknown cmd is not forwarded upstream", MOCK.count(), 0)
        self.has("unknown cmd is answered in JSON, as every command is", out, "Content-Type: application/json")
        self.has("... with an error that names it", out, "\"error\":\"unknown command 'bogus'\"")
        # There is no plain block-by-block command: PanLift asks for the
        # summary, and a chain's blocks are fetched by the server itself.
        post(self.conf, "liftover",
             '{"src":"HG00097#1#CM094066.1","start":19113,"end":19137,"tgt":"HG01234#2","blocks":true}')
        self.eq("cmd=liftover is gone: nothing is sent to the mapping server", MOCK.count(), 0)

    def test_the_scripts_send_the_commands_in_the_table(self):
        # The commands are one table in hgPangenome.c.  The page scripts send
        # exactly those: none the CGI does not know, and none that nothing sends.
        sent = set()
        js = os.path.join(HERE, "..", "..", "js")
        for name in sorted(os.listdir(js)):
            if re.match(r"hgPangenome.*\.js$", name):
                text = read(js, name)
                sent.update(re.findall(r'(?:pg\.post|postCmd)\("([A-Za-z]+)"', text))
                sent.update(re.findall(r"cmd=([A-Za-z]+)", text))
                sent.update(re.findall(r'cmd: "([A-Za-z]+)"', text))
        table = read(HERE, "..", "hgPangenome.c")
        known = set(re.findall(r'^    \{"([A-Za-z]+)"', table, re.M))
        self.eq("the scripts send exactly the commands in the table", sorted(sent), sorted(known))
        self.has("... and the table was read: it has cmd=map", " ".join(sorted(known)), "map")

    def test_the_ancestry_reference_panel(self):
        # The panel file goes into the answer as it is, so it is read as JSON
        # first.  One caught half written is left out: the answer stays
        # readable, and the page says that there is no panel.
        def answer(name, text):
            path = os.path.join(TMP, name)
            with open(path, "w") as fh:
                fh.write(text)
            out = post(mock_conf(name + ".conf", "pangenome.pclaiRefPanel=" + path), "pclai", '{"spots":[]}')
            return json.loads(out[out.index("{"):])
        none = {"status": "ok", "points": [], "asked": 0, "found": 0}
        good = '{"points":[[0.1,0.2,"AFR"]],"labels":{"AFR":"African"}}'
        self.eq("pclai: a whole panel file goes into the answer", answer("panel.json", good),
                dict(none, panel=json.loads(good)))
        self.eq("pclai: a panel file cut off half way is left out", answer("cut.json", good[:25]), none)
        self.eq("pclai: so is one that is not an object with a list of points",
                answer("other.json", '{"points":3}'), none)
        self.eq("pclai: and one far bigger than a panel is",
                answer("big.json", '{"points":[' + "0," * (2200 * 1024) + '0]}'), none)


# ================================================================ where a region lands

class Liftover(CgiTest):

    def reject(self, label, payload, why):
        MOCK.clear()
        self.has(label, post(self.conf, "liftoverAll", payload), why)
        self.eq(label + " - not forwarded", MOCK.count(), 0)

    def test_the_request_is_rebuilt(self):
        # What goes upstream is rebuilt from the checked fields alone: the
        # summary, for every haplotype or for the ones named, whatever else the
        # page sent.
        out = post(self.conf, "liftoverAll",
                   '{"src":"HG00097#1#CM094066.1","start":10,"end":20,"blocks":true,"other":1}')
        self.eq("liftoverAll forwarded once", MOCK.count(), 1)
        self.eq("liftoverAll forwarded as POST", MOCK.last("method"), "POST")
        self.eq("liftoverAll hits /api/v1/liftover", MOCK.last("path"), "/api/v1/liftover")
        self.eq("liftoverAll sent as application/json", MOCK.last("content_type"), "application/json")
        self.eq("with no targets it asks for every haplotype, summarized", MOCK.last("body").replace(" ", ""),
                '{"src":"HG00097#1#CM094066.1","start":10,"end":20,"tgt":"*","summary":true}')
        self.has("liftoverAll answer passed through", out, '"intervals"')
        MOCK.clear()
        post(self.conf, "liftoverAll",
             '{"src":"HG00097#1#CM094066.1","start":10,"end":20,"tgt":["chm13#0","HG01234#2"],"blocks":true}')
        self.eq("with targets it asks for those, summarized, and never for blocks",
                MOCK.last("body").replace(" ", ""),
                '{"src":"HG00097#1#CM094066.1","start":10,"end":20,"tgt":["chm13#0","HG01234#2"],"summary":true}')
        MOCK.clear()
        out = post(self.conf, "liftoverAll", '{"src":"HG00097#1","start":10,"end":20}')
        self.has("liftoverAll checks the source path", out, "full contig path")
        self.eq("liftoverAll bad source - not forwarded", MOCK.count(), 0)

    def test_the_region(self):
        span = limit("PG_MAX_LIFT_SPAN")
        self.reject("src must be a full contig path",
                    '{"src":"HG00097#1","start":1,"end":2,"tgt":["chm13#0"]}', "full contig path")
        self.reject("missing src rejected", '{"start":1,"end":2,"tgt":["chm13#0"]}', "missing 'src'")
        self.reject("missing start/end rejected", '{"src":"a#1#c","tgt":["chm13#0"]}', "missing 'start' or 'end'")
        self.reject("non-numeric coordinates rejected",
                    '{"src":"a#1#c","start":"x","end":"y","tgt":["chm13#0"]}', "must be numbers")
        self.reject("end must exceed start", '{"src":"a#1#c","start":50,"end":50,"tgt":["chm13#0"]}', "greater than")
        self.reject("negative start rejected", '{"src":"a#1#c","start":-5,"end":10,"tgt":["chm13#0"]}', "negative")
        self.reject("a region one base over the span limit rejected",
                    '{"src":"a#1#c","start":0,"end":%d,"tgt":["chm13#0"]}' % (span + 1), "limit %d" % span)
        self.reject("malformed JSON rejected without aborting", '{"src":', "invalid JSON payload")
        MOCK.clear()
        post(self.conf, "liftoverAll", '{"src":"a#1#c","start":0,"end":%d,"tgt":["chm13#0"]}' % span)
        self.eq("a region exactly at the span limit is accepted", MOCK.count(), 1)

    def test_the_targets(self):
        most = limit("PG_MAX_CHOSEN_TARGETS")
        names = lambda n: json.dumps(["h%d#1" % i for i in range(n)])
        self.reject("empty tgt array rejected", '{"src":"a#1#c","start":1,"end":2,"tgt":[]}',
                    "'tgt' must be a list of haplotypes")
        # a reader may choose so many haplotypes and no more; past that the
        # question is about every haplotype, which is asked without a list
        self.reject("one target too many rejected",
                    '{"src":"a#1#c","start":1,"end":2,"tgt":%s}' % names(most + 1),
                    "too many target haplotypes: %d (limit is %d per conversion)" % (most + 1, most))
        MOCK.clear()
        post(self.conf, "liftoverAll", '{"src":"a#1#c","start":1,"end":2,"tgt":%s}' % names(most))
        self.eq("as many targets as the limit accepted (boundary)", MOCK.count(), 1)
        # A target is a haplotype name and nothing else.  The limits count the
        # targets, and a word the graph server reads as "all of them" counts as one.
        for bad in ['"*"', '"HG01234#2"', '["all"]', '["HG01234"]', '["HG01234#2 x"]', '["a#b#c#d"]',
                    '["HG01234#2","*"]', '["HG01234#2",5]', '[["HG01234#2"]]']:
            self.reject("tgt %s refused" % bad, '{"src":"a#1#c","start":1,"end":2,"tgt":%s}' % bad,
                        "'tgt' must be a list of haplotypes")
        for good in ['["HG01234#2"]', '["hg01234#2"]', '["HG01234#2#CM0987.1"]', '["CHM13#0","GRCh38#0"]']:
            MOCK.clear()
            post(self.conf, "liftoverAll", '{"src":"a#1#c","start":1,"end":2,"tgt":%s}' % good)
            self.eq("tgt %s accepted" % good, MOCK.count(), 1)

    def test_the_size_limit_is_for_every_command(self):
        out = post(self.conf, "liftoverAll", '{"src":"a#1#c","start":1,"end":2,"pad":"%s"}'
                   % ("x" * (limit("PG_MAX_REQUEST_BYTES") + 1000)))
        self.has("oversized payload rejected as JSON, not HTML", out, "request too large")
        self.lacks("oversized payload does not emit an HTML page", out, "DOCTYPE")
        self.eq("oversized payload not forwarded", MOCK.count(), 0)

    def test_surject(self):
        out = post(self.conf, "surject", '{"tgt":"*","job_id":"job1","name":"r1"}')
        self.has('surject: tgt "*" refused', out, "'tgt' must name a haplotype")
        self.eq('surject: tgt "*" - not forwarded', MOCK.count(), 0)
        post(self.conf, "surject", '{"tgt":"CHM13#0","job_id":"job1","name":"r1"}')
        self.eq("surject: a haplotype name accepted", MOCK.count(), 1)

    def test_the_batch_surjection(self):
        # its two numbers are held to their limits however they are written
        ask = '{"job_id":"job1","name":"r1","max_targets":%s,"min_coverage":%s}'
        top = limit("PG_MAX_SURJECT_TARGETS")
        over = "too many targets: %d (limit is %d)" % (top + 1, top)
        self.has("surjectAll: more targets than the limit refused",
                 post(self.conf, "surjectAll", ask % (top + 1, 50)), over)
        self.has("... and when written with a decimal point",
                 post(self.conf, "surjectAll", ask % ("%d.0" % (top + 1), 50)), over)
        self.has("surjectAll: a number of targets that is not a number refused",
                 post(self.conf, "surjectAll", ask % ('"all"', 50)), "max_targets must be a number")
        self.has("surjectAll: a coverage floor over 100 refused",
                 post(self.conf, "surjectAll", ask % (10, "150.5")), "min_coverage must be between 0 and 100")
        self.eq("... and none of them forwarded", MOCK.count(), 0)
        post(self.conf, "surjectAll", ask % (top, "2.5"))
        self.eq("surjectAll: the limit itself, and a floor with a fraction, accepted", MOCK.count(), 1)

    def test_which_haplotypes_a_region_reaches(self):
        targets_ok = '{"src":"HG00097#1#CM094066.1","start":19113,"end":19137}'
        out = post(self.conf, "liftoverTargets", targets_ok)
        self.eq("forwarded to /api/v1/liftover/targets", MOCK.last("path"), "/api/v1/liftover/targets")
        self.eq("forwarded as POST", MOCK.last("method"), "POST")
        self.eq("payload forwarded byte-for-byte", MOCK.last("body"), targets_ok)
        self.has("reachable list passed through", out, '"haplotypes"')
        # no tgt is required here, but the source and range still are
        MOCK.clear()
        out = post(self.conf, "liftoverTargets", '{"src":"HG00097#1","start":1,"end":2}')
        self.has("src must still be a full contig path", out, "full contig path")
        self.eq("not forwarded", MOCK.count(), 0)
        span = limit("PG_MAX_LIFT_SPAN")
        out = post(self.conf, "liftoverTargets", '{"src":"a#1#c","start":0,"end":%d}' % (span + 1))
        self.has("span limit still enforced", out, "limit %d" % span)
        self.eq("not forwarded", MOCK.count(), 0)
        out = post(self.conf, "liftoverTargets", '{"src":"a#1#c","start":5,"end":5}')
        self.has("empty range still rejected", out, "greater than")


# ====================================================== the commands that run in the cart
#
# quickLift, refAnnot and alignTrack build a track hub or write the user's
# sequence track, so they run inside the cart, and the cart needs the browser's
# central database.  The isolated hg.conf has none, and there the CGI stops
# before any of our code runs.  So these tests are not part of the default run:
# each request starts a new session row in that database.  PG_DB_TESTS=1
# ("make testWithDb") includes them, borrowing the database settings from a
# real hg.conf and nothing else.

def find_program(name, *dirs):
    for d in dirs:
        path = os.path.join(d, name)
        if os.path.exists(path):
            return path
    return shutil.which(name)


USER_CGI_BIN = "/usr/local/apache/cgi-bin-%s" % (os.environ.get("USER") or os.environ.get("LOGNAME") or "")
LOADER_DIRS = (USER_CGI_BIN + "/loader", "/usr/local/apache/cgi-bin/loader")
BIG_BED_TO_BED = shutil.which("bigBedToBed") or find_program("bigBedToBed", "/cluster/bin/x86_64")
CART_DUMP = find_program("cartDump", USER_CGI_BIN, "/usr/local/apache/cgi-bin")

QL_FULL = ('{"srcDb":"hg38","tgtDb":"hg38","src":"GRCh38#0#chr1","srcHap":"GRCh38",'
           '"position":"chr1:11000-12000","hideTracks":"off",'
           '"blocks":[{"haplotype":"GRCh38#0#chr1","source_start":11000,"source_end":12000,'
           '"target_start":11000,"target_end":12000,"strand":"+"}]}')
QL_FETCH = ('{"srcDb":"hg38","tgtDb":"hg38","src":"GRCh38#0#chr1","srcHap":"GRCh38",'
            '"srcStart":1000,"srcEnd":2000,"tgt":"%s","position":"chr1:1-2","hideTracks":"off"}')


class CartCommands(CgiTest):

    site = None             # the hg.conf that reaches a central database
    boxes = 0

    @classmethod
    def setUpClass(cls):
        # Probe by running a command rather than by reading the file:
        # credentials often live in an included private file we cannot read.
        MOCK.start()
        home = os.environ.get("HOME", "")
        for cand in (os.environ.get("HGDB_CONF"), home + "/.hg.conf", home + "/hg.conf",
                     USER_CGI_BIN + "/hg.conf", "/usr/local/apache/cgi-bin/hg.conf"):
            if cand and os.access(cand, os.R_OK):
                cls.site = os.path.abspath(cand)
                if '"status"' in post(cls.cart_conf("probe.conf"), "quickLift", "{}"):
                    return
        cls.site = None
        raise unittest.SkipTest("no hg.conf here reaches a central database")

    @classmethod
    def cart_conf(cls, name="cart.conf", api=None):
        """The site's database settings and nothing else of the site's: with a
        bottleneck server and a Cloudflare site key configured, a cookie-less
        request like ours is answered with a captcha page instead of reaching
        the command at all.  "delete" takes off one setting of a key, and a
        conf that includes another can hold several, hence the repeats."""
        return conf(name, "include " + cls.site,
                    *(["delete cloudFlareSiteKey bottleneck.host bottleneck.port"] * 4),
                    "pangenomeTools=on",
                    "pangenome.apiBase=http://127.0.0.1:%d" % (api or MOCK.port),
                    "pangenome.timeoutSecs=10", tools=False)

    def setUp(self):
        super().setUp()
        self.q = self.cart_conf()
        # A cgi-bin of this test's own, so that what one test leaves in trash
        # is not there for the next, with the programs the CGI runs.
        CartCommands.boxes += 1
        self.box = new_box("box%d" % CartCommands.boxes)
        self.trash = os.path.join(os.path.dirname(self.box), "trash")
        os.makedirs(os.path.join(self.trash, "quickLift"))
        for name in ("bedToBigBed", "pslToBigPsl", "bigPsl.as"):
            found = find_program(name, *LOADER_DIRS)
            if found:
                os.symlink(found, os.path.join(self.box, "loader", name))

    def need(self, *names):
        """Skip the test, saying what is missing, unless these programs are here."""
        missing = [n for n in names if not (BIG_BED_TO_BED if n == "bigBedToBed"
                                            else os.path.exists(os.path.join(self.box, "loader", n)))]
        if missing:
            self.skipTest("not found: " + ", ".join(missing))

    def in_box(self, body, cf=None):
        """POST a whole request body, run in this test's cgi-bin."""
        return run_cgi(cf or self.q, "POST", body, box=self.box)

    def files(self, sub, keep=lambda name: True):
        out = []
        for root, _, names in os.walk(os.path.join(self.trash, sub)):
            out += [os.path.join(root, n) for n in names if keep(n)]
        return sorted(out)

    def rows(self, path):
        """A bigBed file as rows of fields."""
        text = subprocess.run([BIG_BED_TO_BED, path, "stdout"], cwd=self.box, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT).stdout.decode("utf8", "replace")
        return [line.split("\t") for line in text.split("\n") if line]

    # ---- requests that are refused before anything is built ----

    def test_requests_refused(self):
        # the name comes from the user's own FASTA header and lands in a FASTA
        # line, a PSL column and hgc's whitespace-split "i=" parameter
        out = post(self.q, "alignTrack",
                   '{"db":"noSuchDb","contig":"c","name":"a b","sequence":"ACGT","cigar":"4M","start":0}')
        self.has("alignTrack: an unknown assembly is reported, not crashed on", out,
                 "no sequence sizes available")

        # The page does not post its blocks - the server fetches them - so a
        # failed fetch must say why.  "no 'blocks' array in the request" would
        # describe our own request and hide the upstream reason: a 503 while
        # the service restarts would read the same as a region that cannot be
        # lifted.
        out = post(self.cart_conf("cartDead.conf", api=free_port()), "quickLift", QL_FETCH % "CHM13#0")
        self.has("quickLift: a failed block fetch says the server was not reached", out,
                 "could not reach the mapping server")
        self.lacks("and does not blame the request", out, "no 'blocks' array")
        self.lacks("the bottleneck server is not contacted", out, "botDelay")

        def reject(cmd, label, payload, why):
            MOCK.clear()
            self.has(label, post(self.q, cmd, payload), why)
            self.eq(label + " - middleware untouched", MOCK.count(), 0)

        reject("quickLift", "malformed JSON rejected without aborting", "not json", "invalid JSON payload")
        reject("quickLift", "missing assemblies rejected",
               '{"src":"HG00097#1#CM094066.1","position":"chr1:1-2"}', "missing or malformed source")
        # srcDb/tgtDb become file paths and a hub genome line, so anything that
        # is not shaped like a db name is refused outright
        reject("quickLift", "assembly name with a slash rejected",
               '{"srcDb":"../../etc","tgtDb":"hs1","src":"a#1#c","position":"c:1-2"}', "missing or malformed source")
        reject("quickLift", "missing position rejected",
               '{"srcDb":"hs1","tgtDb":"GCA_044165735.1","src":"HG00097#1#CM094066.1"}',
               "missing source path or target position")
        reject("quickLift", "two-field src rejected",
               '{"srcDb":"hs1","tgtDb":"GCA_044165735.1","src":"HG00097#1","position":"c:1-2"}', "full contig path")
        reject("quickLift", "unknown assembly reported, not crashed on",
               '{"srcDb":"noSuchDb","tgtDb":"alsoNoSuchDb","src":"a#1#c","position":"c:1-2"}',
               "no sequence sizes available")

        # cmd=refAnnot: a reference's annotations on a mapped haplotype.  Every
        # one of these is refused before the graph server is asked anything.
        ok = '"db":"GCA_046000115.1","path":"HG04187#1#CM099739.1","start":100,"end":200,"position":"CM099739.1:1-300"'
        hap = '{"db":"GCA_046000115.1","path":"%s","start":%d,"end":%d,"position":"c:1-2","ref":"GRCh38#0"}'
        reject("refAnnot", "refAnnot: malformed JSON rejected", "not json", "invalid JSON payload")
        reject("refAnnot", "refAnnot: a reference not configured is refused", '{%s,"ref":"XX#0"}' % ok,
               "annotations cannot be brought from 'XX#0'")
        reject("refAnnot", "refAnnot: no reference refused", "{%s}" % ok, "annotations cannot be brought")
        reject("refAnnot", "refAnnot: assembly name with a slash refused",
               '{"db":"../../etc","path":"HG04187#1#CM099739.1","start":1,"end":2,"position":"c:1-2","ref":"GRCh38#0"}',
               "missing or malformed assembly")
        reject("refAnnot", "refAnnot: a path that is not a full contig refused", hap % ("HG04187#1", 1, 2),
               "missing or malformed assembly")
        reject("refAnnot", "refAnnot: an empty extent refused", hap % ("HG04187#1#CM099739.1", 5, 5),
               "missing or malformed start and end")
        reject("refAnnot", "refAnnot: longer than a translation may cover refused",
               hap % ("HG04187#1#CM099739.1", 0, 999999999), "longer than the")
        reject("refAnnot", "refAnnot: a hit already on the reference is not translated",
               '{"db":"hg38","path":"GRCh38#0#chr1","start":1,"end":2,"position":"chr1:1-2","ref":"GRCh38#0"}',
               "this hit is already on GRCh38")
        # what is sent on to the graph server as a target is a haplotype's name
        # and nothing else: "*" there would ask for every haplotype at once
        reject("quickLift", 'a target of "*" refused',
               '{"srcDb":"hs1","tgtDb":"GCA_044165735.1","src":"HG00097#1#CM094066.1","position":"c:1-2","tgt":"*"}',
               "must name a haplotype")
        reject("refAnnot", 'refAnnot: a path of "*#*#chr1" refused', hap % ("*#*#chr1", 1, 2),
               "missing or malformed assembly")
        reject("quickLift", 'an assembly named ".." refused',
               '{"srcDb":"..","tgtDb":"hs1","src":"a#1#c","position":"c:1-2"}', "missing or malformed source")

    # ---- the sequence track (cmd=alignTrack) ----

    def test_the_sequence_track(self):
        # The mapped sequence becomes a bigPsl custom track.  The checks read
        # the finished file back with bigBedToBed.
        self.need("pslToBigPsl", "bigPsl.as", "bedToBigBed", "bigBedToBed")
        seq40 = "ACGT" * 10
        part = '"db":"hg38","contig":"chr1","name":"q","sequence":"%s","start":11000' % seq40

        def at(rest):
            return self.in_box("cmd=alignTrack&payload=" + enc("{%s,%s}" % (part, rest)))

        def track_of(answer):
            """The track file an answer's link names, as rows."""
            m = re.search(r'bigDataUrl%3D([^"& ]*\.bb)', answer)
            return self.rows(urllib.parse.unquote(m.group(1))) if m else []

        def left_over():
            return len(self.files("pangenomeSs", lambda n: not n.endswith(".bb")))

        # It is written into a session of this request's own, and both links
        # name it.  Left to the user's cookie, a second click or a second tab
        # changed the assembly before the browser page opened.
        out = at('"cigar":"40M","strand":"+"')
        self.has("alignTrack: the track is built", out, '"status":"ok"')
        m = re.search(r'"hgsid":"([0-9]*_[A-Za-z0-9]*)"', out)
        sid = m.group(1) if m else ""
        self.has("... in a session the answer names", out, '"hgsid":"')
        self.has("... the browser link opens that session", out,
                 '"url":"hgTracks?hgsid=%s&db=hg38&position=chr1' % sid)
        self.has("... and hands it the custom track", out, "hgct_customText=track+type%3DbigPsl")
        self.has('... named as shown, so "hide other tracks" leaves it', out, "&ct_PanViewSeq_")
        self.has("... the alignment link opens the same session and track", out,
                 '"details":"hgc?hgsid=%s&db=hg38&g=htcBigPslAli&i=q&c=chr1' % sid)
        self.eq("... and only the track file is left: no PSL, no FASTA", left_over(), 0)
        row = (track_of(out) or [[""] * 22])[0]
        self.eq("... which holds the alignment and the sequence",
                "%s:%s-%s %s %s" % (row[0], row[1], row[2], row[3], row[17]),
                "chr1:11000-11040 q " + seq40.lower())

        # a clipped end is not part of the alignment: 10 of 40 bases aligned
        row = (track_of(at('"cigar":"10M30S","strand":"+","matches":9,"mismatches":1')) or [[""] * 22])[0]
        self.eq("alignTrack: a clipped end is left out of the query range",
                "%s-%s of %s" % (row[12], row[13], row[15]), "0-10 of 40")
        self.eq("... the mapping server's matches and mismatches are used", "%s/%s" % (row[20], row[21]), "9/1")
        self.eq("... and the target range is the aligned bases", "%s-%s" % (row[1], row[2]), "11000-11010")
        # on the reverse strand the range is on the query as it was given
        row = (track_of(at('"cigar":"10M30S","strand":"-"')) or [[""] * 22])[0]
        self.eq("alignTrack: reverse strand, the query range is turned round",
                "%s %s-%s" % (row[5], row[12], row[13]), "- 30-40")
        self.eq("... and with no counts every aligned base is a match", "%s/%s" % (row[20], row[21]), "10/0")
        row = (track_of(at('"cigar":"5S4=1X5=3I10M2D10M2S","strand":"+"')) or [[""] * 22])[0]
        self.eq("alignTrack: runs that touch are one block, gaps separate blocks",
                "%s blocks %s at %s and %s q %s-%s" % (row[9], row[10], row[11], row[16], row[12], row[13]),
                "3 blocks 10,10,10, at 0,10,22, and 5,18,28, q 5-38")
        # every other hit on the haplotype goes in the same track
        rows = track_of(at('"cigar":"40M","strand":"+","others":['
                           '{"contig":"chr2","start":500,"strand":"-","cigar":"20M20S"},'
                           '{"contig":"chr1","start":100,"strand":"+","cigar":"40M"},'
                           '{"contig":"noSuchSeq","start":1,"strand":"+","cigar":"40M"}]'))
        self.eq("alignTrack: the other hits on the haplotype are in the track, sorted",
                " ".join("%s:%s" % (r[0], r[1]) for r in rows), "chr1:100 chr1:11000 chr2:500")
        # the CIGAR is input: anything odd is refused
        for bad in ["-5M45M", "10M30Z", "40", "M", "99999999999M", "50M", "10M 30S", "40S"]:
            self.has("alignTrack: CIGAR '%s' refused" % bad, at('"cigar":"%s","strand":"+"' % bad),
                     '"status":"error"')
        out = self.in_box("cmd=alignTrack&payload=" + enc(
            '{"db":"hg38","contig":"chr1","name":"q","sequence":"%s","start":999999999,"cigar":"40M"}' % seq40))
        self.has("alignTrack: a start past the end of the sequence refused", out, "starts outside chr1")
        out = self.in_box("cmd=alignTrack&payload=" + enc(
            '{"db":"hg38","contig":"chr1","name":"q","sequence":"%s","start":%d,"cigar":"40M"}'
            % (seq40, 11000 + 2 ** 32)))
        self.has("alignTrack: a start too big for an int is refused, not wrapped round", out,
                 "starts outside chr1")
        self.eq("... and a refused request leaves no file behind", left_over(), 0)

    # ---- files these commands write, and what they must leave alone ----

    def hubs(self):
        return self.files("pangenomeQuickLift", lambda n: n.startswith("hub") and n.endswith(".txt"))

    def test_hub_files(self):
        self.need("bedToBigBed")
        # hubQuickLift-<db> names the hub hgConvert's quickLift attached for
        # this user.  We ask the same library for the source's stanzas, and
        # must not empty or change that file on the way.
        theirs = "../trash/quickLift/hub_theirs.txt"
        before = "hub quickLiftHubhg38\n\ngenome hg38\n\ntrack liftedEarlier\nshortLabel lifted earlier\n\n"
        with open(os.path.join(self.box, theirs), "w") as fh:
            fh.write(before)
        # pangenomeQuickLift-<src>-<tgt> is where we keep the name of our own
        # hub file between conversions, and that file is written over.  A cart
        # variable can be set from a link, so a name that is not our file must
        # not be used.
        victim = os.path.join(TMP, "notOurs%d.txt" % CartCommands.boxes)
        with open(victim, "w") as fh:
            fh.write("somebody else's file\n")
        out = self.in_box("cmd=quickLift&payload=%s&pangenomeQuickLift-hg38-hg38=%s&hubQuickLift-hg38=%s"
                          % (enc(QL_FULL), enc(victim), enc(theirs)))
        self.has("quickLift: a whole conversion gives a browser link", out, '"url":"hgTracks?db=hg38')
        self.eq("... and a file named in the cart that is not ours is not written over",
                read(victim).split("\n")[0], "somebody else's file")
        self.eq("... and the hub is in our trash directory", len(self.hubs()), 1)
        self.eq("... and hgConvert's quickLift hub is left as it was",
                read(self.box, theirs) == before, True)
        self.eq("... and no file of ours is left beside it", len(self.files("quickLift")), 1)

        # The other half: a name that is ours is used again.  A new file for
        # every conversion is a new hub attached to the cart every time.
        ours = os.path.relpath(self.hubs()[0], self.box) if self.hubs() else ""
        out = self.in_box("cmd=quickLift&payload=%s&pangenomeQuickLift-hg38-hg38=%s" % (enc(QL_FULL), enc(ours)))
        self.has("quickLift: converting again gives a link", out, '"url":"hgTracks?db=hg38')
        self.eq("... through the same hub file, not a second one", len(self.hubs()), 1)

    def test_the_chain(self):
        # Built from the blocks of a translation.  Read back from the files:
        # one row a chain, and one row a block in the link file.
        self.need("bedToBigBed", "bigBedToBed")

        def blk(s, e, ts, te, strand="+"):
            return ('{"haplotype":"GRCh38#0#chr1","source_start":%d,"source_end":%d,"target_start":%d,'
                    '"target_end":%d,"strand":"%s"}' % (s, e, ts, te, strand))

        def chains_of(*blocks):
            """"start-end strand qStart-qEnd" for each chain a conversion wrote, then
            "| start-end@q" for each block; or the CGI's answer if it wrote none."""
            is_chain = lambda n: n.startswith("chain") and n.endswith(".bb") and not n.endswith(".link.bb")
            before = set(self.files("pangenomeQuickLift", is_chain))
            out = self.in_box("cmd=quickLift&payload=" + enc(
                '{"srcDb":"hg38","tgtDb":"hg38","src":"GRCh38#0#chr1","srcHap":"GRCh38",'
                '"position":"chr1:20001-20300","hideTracks":"off","blocks":[%s]}' % ",".join(blocks)))
            new = sorted(set(self.files("pangenomeQuickLift", is_chain)) - before)
            if not new:
                return out.rstrip("\n").split("\n")[-1][:160]
            chains = " ".join("%s-%s %s %s-%s" % (r[1], r[2], r[5], r[9], r[10]) for r in self.rows(new[0]))
            links = " ".join("%s-%s@%s" % (r[1], r[2], r[4]) for r in self.rows(new[0][:-3] + ".link.bb"))
            return chains + " | " + links

        q1 = 248956422                  # chr1's length: the reverse strand counts from its end
        self.eq("chain: two blocks in order, a gap between, are one chain of two blocks",
                chains_of(blk(11000, 11100, 20000, 20100), blk(11150, 11250, 20200, 20300)),
                "20000-20300 + 11000-11250 | 20000-20100@11000 20200-20300@11150")
        self.eq("chain: the blocks may come in any order",
                chains_of(blk(11150, 11250, 20200, 20300), blk(11000, 11100, 20000, 20100)),
                "20000-20300 + 11000-11250 | 20000-20100@11000 20200-20300@11150")
        self.eq("chain: a block on the other strand is a chain of its own, counted from the far end",
                chains_of(blk(11000, 11100, 20000, 20100), blk(11150, 11250, 20200, 20300, "-")),
                "20000-20100 + 11000-11100 20200-20300 - %d-%d | 20000-20100@11000 20200-20300@%d"
                % (q1 - 11250, q1 - 11150, q1 - 11250))
        self.eq("chain: a block that goes back on the source starts another chain",
                chains_of(blk(11300, 11400, 20000, 20100), blk(11000, 11100, 20200, 20300)),
                "20000-20100 + 11300-11400 20200-20300 + 11000-11100 | 20000-20100@11300 20200-20300@11000")
        self.has("chain: a block with nothing in it is refused",
                 chains_of(blk(11000, 11000, 20000, 20100)), "empty or out-of-range")
        self.has("chain: a block off the end of the source sequence is refused",
                 chains_of(blk(-5, 100, 20000, 20105)), "empty or out-of-range")
        self.has("chain: a block that starts before the target sequence is refused",
                 chains_of(blk(11000, 11100, -5000, -4900)), "empty or out-of-range")
        self.has("chain: a block past the end of the source sequence is refused",
                 chains_of(blk(q1 - 50, q1 + 50, 20000, 20100)), "empty or out-of-range")
        self.has("chain: a block past the end of the target sequence is said plainly",
                 chains_of(blk(11000, 11100, q1 - 50, q1 + 50)), "a block ends past the end of chr1")
        self.has("chain: no blocks at all is said plainly", chains_of(), "returned no blocks")

    def test_a_hub_from_another_day(self):
        # A hub file is kept from one conversion to the next, and trash is
        # filed by day: a hub from another day gets today's chain, which is not
        # in its own directory.  Named by base name alone, the chain was not
        # found after midnight.
        self.need("bedToBigBed")
        day = os.path.join(self.trash, "pangenomeQuickLift", "000")
        os.makedirs(day)
        old = "../trash/pangenomeQuickLift/000/hub_yesterday.txt"
        with open(os.path.join(self.box, old), "w") as fh:
            fh.write("hub old\n")
        out = self.in_box("cmd=quickLift&payload=%s&pangenomeQuickLift-hg38-hg38=%s" % (enc(QL_FULL), enc(old)))
        self.has("a hub from another day: the conversion still gives a link", out, '"url":"hgTracks?db=hg38')
        hub = read(self.box, old).split("\n")
        named = [l.split(" ")[1] for l in hub if l.startswith("bigDataUrl ")]
        self.has("... its hub file is the one kept", hub[0], "hub pangenomeLift")
        self.eq("... and the chain it names is there, from where the hub is",
                bool(named) and os.path.exists(os.path.join(day, named[-1])), True)
        for url in sorted(set(l.split(" ")[1] for l in hub if l.startswith("quickLiftUrl "))):
            self.eq("... as is the chain each lifted track names", os.path.exists(os.path.join(day, url)), True)

    def test_an_abort_inside_a_conversion(self):
        # A command that aborts half way: the answer is still JSON, and the
        # session is left on the assembly it was on, not on the one borrowed to
        # read the source's tracks.
        self.need("bedToBigBed")
        m = re.search(r"hgsid=[0-9]*_[A-Za-z0-9]*", self.in_box("page=convert&db=mm39"))
        sid = m.group(0) if m else ""
        locked = os.path.join(self.trash, "pangenomeQuickLift")
        os.makedirs(locked)
        os.chmod(locked, 0o555)         # nothing can be written there
        try:
            out = self.in_box("cmd=quickLift&%s&payload=%s" % (sid, enc(QL_FULL)))
        finally:
            os.chmod(locked, 0o755)
        self.has("an abort inside a conversion is answered as JSON", out,
                 '{"status":"error","error":"the request could not be completed')
        self.lacks("... and not as an HTML page", out, "<!DOCTYPE")
        if not CART_DUMP or not sid:
            self.skipTest("the session-after-an-abort check: no cartDump, or no session id")
        dump = run_cgi(self.q, "GET", qs=sid, box=self.box, program=CART_DUMP)
        self.has("... and the session is still on its own assembly", dump, "db mm39")

    def test_more_blocks_than_the_limit(self):
        # A request is too short to carry that many, so this is the graph
        # server's own answer, fetched for the chain.
        row = ('{"haplotype":"GRCh38#0#chr1","source_start":%d,"source_end":%d,"target_start":%d,'
               '"target_end":%d,"strand":"+"}')
        path = os.path.join(TMP, "manyBlocks.json")
        with open(path, "w") as fh:
            fh.write('{"blocks":[' + ",".join(row % (i, i + 1, i, i + 1)
                                              for i in range(0, 2 * (limit("PG_MAX_BLOCKS") + 1), 2)) + "]}")
        MOCK.start("--body-file", path)
        out = self.in_box("cmd=quickLift&payload=" + enc(QL_FETCH % "GRCh38#0"), cf=self.cart_conf("many.conf"))
        self.has("chain: more blocks than the limit are refused", out, "too many blocks")

    def test_a_long_error_while_fetching_the_blocks(self):
        MOCK.start("--status", "500", "--body", LONG_ERR)
        out = post(self.cart_conf("cartLong.conf"), "quickLift", QL_FETCH % "CHM13#0")
        self.has("quickLift: a long error from the mapping server is an error envelope", out,
                 '{"status":"error","error":"mapping server returned HTTP 500')

    def test_the_header_of_a_command_in_the_cart(self):
        # The header goes out through the library's own writer.  The lines the
        # library queued for it are sent - with the cart, the content policy,
        # where hg.conf turns that on - and there is one header, not two.
        self.need("bedToBigBed")
        csp = conf("csp.conf", "include " + self.q, "cspResponseHeader=on", tools=False)
        out, _ = run_cgi(csp, "POST", "cmd=quickLift&payload=" + enc(QL_FULL), box=self.box, split=True)
        head, _, body = out.partition("\n\n")
        self.has("a command in the cart: the content policy the library queued is sent", head,
                 "Content-Security-Policy: ")
        self.eq("... the header ends with the JSON Content-Type", head.split("\n")[-1],
                "Content-Type: application/json")
        self.eq("... which is written once", out.count("Content-Type:"), 1)
        self.has("... and the answer follows it", body[:16], '{"status":"ok"')

    def test_a_library_warning_inside_a_conversion(self):
        # The library warns when a session's custom tracks cannot be read;
        # "ctTest" is its own switch for trying that.  The cart shell would
        # write the warning to the browser as HTML.  It is caught with the
        # command's aborts, and the answer is the JSON alone.
        self.need("bedToBigBed")
        os.makedirs(os.path.join(self.trash, "ct"))
        with open(os.path.join(self.trash, "ct", "ct_test.bed"), "w"):
            pass
        out, _ = run_cgi(self.q, "POST", "cmd=quickLift&payload=%s&ctfile_hg38=%s&ctTest=1"
                         % (enc(QL_FULL), enc("../trash/ct/ct_test.bed")), box=self.box, split=True)
        head, _, body = out.partition("\n\n")
        self.eq("a library warning inside a conversion: the header is still the JSON one",
                head.split("\n")[-1], "Content-Type: application/json")
        self.has("... the conversion is answered", body[:16], '{"status":"ok"')
        self.lacks("... and no HTML comes with it", out, "<")

    def test_locus(self):
        # cmd=locus names the genes at each hit.  An interval far longer than
        # any sequence that can be mapped is not looked up: naming it means
        # reading every gene in it.  (Here because the gene files are found
        # through the central database; the command itself starts no session.)
        at = '"db":"GCA_042077495.1","contig":"CM089723.1","start":135714502'
        out = post(self.q, "locus", '{"items":[{%s,"end":135738459},{%s,"end":140714502}]}' % (at, at))
        self.has("locus: a hit is named, an interval of 5 Mb is not", out, '"loci":["exon LCT-MCM6",null]')
        far = 2 ** 32
        out = post(self.q, "locus", '{"items":[{"db":"GCA_042077495.1","contig":"CM089723.1","start":%d,"end":%d}]}'
                   % (135714502 + far, 135738459 + far))
        self.has("locus: coordinates too big for an int are not wrapped round onto a gene", out,
                 '"loci":[null]')

    def test_locus_reads_the_database_over_one_connection(self):
        # One connection, moved from assembly to assembly.  The library keeps
        # at most 16 and a page of hits can name 200 assemblies, so one each
        # would end the request.  Counted in the library's own trace.  An
        # assembly this server does not have costs no connection, which leaves
        # the counts equal there too.
        dbs = "hg38 hg19 hs1 mm10 mm9 dm6 ce11 sacCer3 rn5 danRer7 ce10".split()
        first = {"dm6": "chr2L", "ce11": "chrI", "ce10": "chrI", "sacCer3": "chrI"}

        def ask(names):
            items = [{"db": db, "contig": first.get(db, "chr1"),
                      "start": 50000 if db == "sacCer3" else 1000000,
                      "end": 50100 if db == "sacCer3" else 1000100} for db in names]
            out, err = post(self.q, "locus", json.dumps({"items": items}), split=True,
                            more_env={"JKSQL_TRACE": "on"})
            return (json.loads(out[out.index("{"):])["loci"],
                    sum(1 for line in err.splitlines() if line.split()[:1] == ["SQL_CONNECT"]))
        one, for_one = ask(dbs[:1])
        each, for_each = ask(dbs)
        twice, for_twice = ask(dbs + dbs)
        self._check("locus: the trace was read, there are connections to count", for_one > 0, "none counted")
        self.eq("locus: eleven assemblies open as many connections as one does", for_each, for_one)
        self.eq("... and so do the eleven asked for twice over", for_twice, for_one)
        self.eq("... each still answered in its place", (each[:1], twice), (one, each + each))

    # ---- the pages ----

    def test_page_parameters_are_not_saved(self):
        # "start", "end" and "src" are names any other tool might read.
        out = self.in_box("page=convert&db=hg38&src=pgSrcMark&start=4242421&end=4242422&refAnnot=pgRefMark"
                          "&pgTarget=pgTgtMark&pgAnnot=on&pgHide=on")
        m = re.search(r"hgsid=[0-9]*_[A-Za-z0-9]*", out)
        if not CART_DUMP or not m:
            self.skipTest("the saved-session check: no cartDump, or no session id in the page")
        dump = run_cgi(self.q, "GET", qs=m.group(0), box=self.box, program=CART_DUMP)
        self.has("saved session: read back, with the assembly in it", dump, "db hg38")
        for mark in ["pgSrcMark", "4242421", "4242422", "pgRefMark", "pgTgtMark", "page convert", "pgAnnot",
                     "pgHide"]:
            self.lacks("saved session: no '%s'" % mark, dump, mark)

    def test_the_pages(self):
        def ends(page):
            """The first and the last pangenome script a page names."""
            names = [re.sub(r"-v[0-9]+", "", n) for n in re.findall(r"hgPangenome[A-Za-z]*(?:-v[0-9]+)?\.js", page)]
            return "%s %s" % (names[0], names[-1]) if names else ""

        # the PanLift form prints the cart's db and position into the page
        out = self.in_box("page=convert&db=hg38&position=" + enc("chr1:1-2'><script>alert(1)</script>"))
        self.has("PanLift form: drawn", out, "id='pgcPos'")
        self.lacks("... with the position escaped", out, "'><script>alert(1)")
        # every page names the shared script first and its own script last:
        # the page scripts read hgPangenomeCommon.js as they load
        self.eq("PanLift form: the shared script, then the page's", ends(out),
                "hgPangenomeCommon.js hgPangenomeConvert.js")
        self.eq("results page: the shared script, then the page's", ends(self.in_box("page=results&job_id=job1")),
                "hgPangenomeCommon.js hgPangenomeResults.js")
        self.eq("search form: the shared script, then the page's", ends(self.in_box("db=hg38")),
                "hgPangenomeCommon.js hgPangenome.js")
        # a link whose start is not a number: the page is drawn whole, and says
        # no region was named, as it does for a source it cannot read
        out = self.in_box("page=liftAll&src=" + enc("GRCh38#0#chr1") + "&start=abc&end=200")
        self.has("all-haplotypes page: a start that is not a number is read as none", out,
                 '"start": -1, "end": 200')
        self.lacks("... and the page does not stop half way to say so", out, "Expecting")


if os.environ.get("PG_DB_TESTS") != "1":
    del CartCommands        # left out of the default run: "make testWithDb" includes them


if __name__ == "__main__":
    result = unittest.main(exit=False).result
    for _, why in result.skipped:
        print("NOT RUN: " + why)
    print("%d checks made" % checks)
    if result.failures or result.errors:
        sys.exit(1)
    sys.exit(NOT_RUN if result.skipped else 0)
