#!/usr/bin/env python3
"""mockMiddleware.py - stand-in for the PanView mapping middleware.

Used by the Layer 2 proxy tests.  Two jobs:

  1. Answer POST /api/v1/map and GET /api/v1/map/<job_id> with a configurable
     status code, body and delay, so the CGI's error/timeout handling can be
     exercised.
  2. Record every request it receives (method, path, headers of interest, body)
     as one JSON object per line, so a test can assert on exactly what the CGI
     sent upstream - URL shape, Content-Type, auth header, payload bytes.

Only the python3 standard library is used; nothing is installed.

  mockMiddleware.py --port 8795 --record /tmp/rec.jsonl
                    [--status 200] [--body '{"x":1}'] [--delay 0]
                    [--content-type application/json]
                    [--redirect]         answer with a redirect to this same
                                         server's /redirected
"""

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
import time

ARGS = None


def record(entry):
    if not ARGS.record:
        return
    with open(ARGS.record, 'a') as fh:
        fh.write(json.dumps(entry) + '\n')
        fh.flush()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass                                   # keep test output clean

    def _capture(self, body):
        record({
            'method': self.command,
            'path': self.path,
            'content_type': self.headers.get('Content-Type'),
            'accept': self.headers.get('Accept'),
            'token': self.headers.get('X-Pangenome-Token'),
            'authorization': self.headers.get('Authorization'),
            'user_agent': self.headers.get('User-Agent'),
            'content_length': self.headers.get('Content-Length'),
            'body': body,
        })

    def _respond(self, default_body):
        if ARGS.delay:
            time.sleep(ARGS.delay)
        if ARGS.redirect and not self.path.endswith('/redirected'):
            self.send_response(302)
            self.send_header('Location', 'http://127.0.0.1:%d/redirected' % ARGS.port)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        body = (ARGS.body if ARGS.body is not None else default_body).encode()
        self.send_response(ARGS.status)
        self.send_header('Content-Type', ARGS.content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n).decode('utf-8', 'replace') if n else ''
        self._capture(body)
        if self.path.endswith('/liftover/targets'):
            # Which haplotypes contain this region.  Deliberately lower-cased,
            # as the published contract shows, so the client is exercised
            # against names that differ from /api/v1/haplotypes.
            self._respond(json.dumps({'haplotypes': ['chm13#0', 'hg01234#2']}))
            return
        if self.path.endswith('/liftover'):
            # Coordinate translation: 0..N intervals, each naming its full
            # 3-field contig path, 0-based half-open, with a real strand.
            self._respond(json.dumps({'intervals': [
                {'haplotype': 'HG01234#2#CM0987.1',
                 'start': 20551, 'end': 20575, 'strand': '+'},
                {'haplotype': 'HG01234#2#CM0988.1',
                 'start': 400, 'end': 410, 'strand': '-'}]}))
            return
        n_seqs = 0
        try:
            n_seqs = len(json.loads(body).get('sequences', []))
        except Exception:
            pass
        self._respond(json.dumps({'job_id': 'job1', 'status': 'queued',
                                  'n_sequences': n_seqs}))

    def do_GET(self):
        self._capture(None)
        if self.path.endswith('/haplotypes'):
            self._respond(json.dumps({'haplotypes':
                ['grch38#0', 'chm13#0', 'hg00097#1', 'hg00097#2']}))
            return
        job_id = self.path.rsplit('/', 1)[-1]
        self._respond(json.dumps({
            'job_id': job_id, 'status': 'done',
            'progress': {'completed': 1, 'total': 1},
            'results': [{'name': 'r1', 'status': 'mapped', 'error': None,
                         'query_length': 4, 'alignments': []}],
            'error': None}))


def main():
    global ARGS
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, required=True)
    p.add_argument('--record')
    p.add_argument('--status', type=int, default=200)
    p.add_argument('--body', default=None)
    p.add_argument('--delay', type=float, default=0)
    p.add_argument('--content-type', dest='content_type', default='application/json')
    p.add_argument('--redirect', action='store_true')
    ARGS = p.parse_args()
    srv = HTTPServer(('127.0.0.1', ARGS.port), Handler)
    # tell the caller we are ready
    sys.stderr.write('mock middleware listening on %d\n' % ARGS.port)
    sys.stderr.flush()
    srv.serve_forever()


if __name__ == '__main__':
    main()
