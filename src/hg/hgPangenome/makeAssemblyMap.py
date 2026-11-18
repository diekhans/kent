#!/usr/bin/env python3
"""makeAssemblyMap.py - generate js/hgPangenomeAssemblies.js from the HPRC
UCSC-browser index CSV.

The index CSV is committed next to this script, so generating the table needs no
network access and always produces the same result for a given release.

The pangenome names haplotypes PanSN style, SAMPLE#PHASE#CONTIG.  The HPRC
publishes, per sample and haplotype, the UCSC assembly that haplotype is
browsable in - references as a plain db (hg38 / hs1), samples as a GenArk
accession short link (/h/GCA_...., which redirects to hgTracks?db=GCA_...).
This script turns that table into a lookup the page can use to link a
surjection on ANY haplotype - not just the references - into the browser.

Usage:
    ./makeAssemblyMap.py                     # use the committed CSV (default)
    ./makeAssemblyMap.py other.csv           # or another file, or a URL
    ./makeAssemblyMap.py --out ../js/hgPangenomeAssemblies.js

To move to a new HPRC release: drop its index CSV in beside this script, point
DEFAULT_SRC (or the command line) at it, re-run, and reinstall the js file.
Only the python3 standard library is used.
"""

import argparse
import csv
import hashlib
import io
import os
import re
import sys
import urllib.request

# The release we serve.  Committed alongside this script so the generated table
# is reproducible and no network access is needed.  Obtained from:
UPSTREAM_URL = ("https://github.com/human-pangenomics/hprc_intermediate_assembly/"
                "blob/main/data_tables/browser/ucsc_browser_hprc_r2_v1.0.index.csv")

DEFAULT_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           'ucsc_browser_hprc_r2_v1.0.index.csv')

DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           '..', 'js', 'hgPangenomeAssemblies.js')


def db_from_browser_url(url):
    """Turn the table's browser URL into what the pages should link to.

    Two kinds of value come back:
      * a bare assembly id, which is portable across UCSC browser servers, so
        the page can link to the LOCAL browser (keeping the user's session):
            https://genome.ucsc.edu/h/GCA_041900255.1        -> GCA_041900255.1
            https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg38 -> hg38
      * a full URL, used when the assembly id is NOT portable - a "hub_<id>_"
        db names a hub by a per-server hub id, which does not resolve on other
        servers (verified: hub_4837794_HG002v1.1.PAT errors on hgwdev), so those
        must keep pointing at the server the table names:
            ...hgTracks?db=hub_4837794_HG002v1.1.PAT -> that URL verbatim
    Returns None if the URL is not recognized."""
    url = (url or '').strip()
    if not url:
        return None
    m = re.search(r'[?&]db=([A-Za-z0-9._]+)', url)
    if m:
        db = m.group(1)
        return url if db.startswith('hub_') else db
    m = re.search(r'/h/([A-Za-z0-9._]+)', url)
    if m:
        return m.group(1)
    return None


def load_rows(src):
    if re.match(r'^https?://', src):
        with urllib.request.urlopen(src, timeout=120) as fh:
            text = fh.read().decode('utf-8')
    else:
        with open(src) as fh:
            text = fh.read()
    return list(csv.DictReader(io.StringIO(text))), text


def build(rows):
    """Return ({"sample#phase": db}, {db: assembly_name}) plus stats.

    The assembly name is kept in its own table keyed by db rather than folded
    into the first one: it is a property of the assembly, not of the haplotype,
    so this way the two haplotypes of a sample cannot disagree about it, and
    every existing caller of pangenomeAssemblies keeps working unchanged.
    """
    out = {}
    names = {}
    skipped = []
    for row in rows:
        sample = (row.get('sample_id') or '').strip()
        hap = (row.get('haplotype') or '').strip()
        db = db_from_browser_url(row.get('browser'))
        if not sample or hap == '' or not db:
            skipped.append(row)
            continue
        key = ('%s#%s' % (sample, hap)).lower()
        if key in out and out[key] != db:
            skipped.append(row)          # conflicting duplicate; keep the first
            continue
        out[key] = db
        name = (row.get('assembly_name') or '').strip()
        if name and db not in names:
            names[db] = name
    return out, names, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src', nargs='?', default=DEFAULT_SRC,
                    help='CSV URL or path (default: the published HPRC index)')
    ap.add_argument('--out', default=DEFAULT_OUT)
    args = ap.parse_args()

    rows, raw = load_rows(args.src)
    src_sha = hashlib.sha256(raw.encode()).hexdigest()
    table, names, skipped = build(rows)
    if not table:
        sys.exit('no usable rows found in %s' % args.src)

    plain = sorted(k for k in table if not table[k].startswith('GCA_')
                   and not table[k].startswith('http'))
    urls = sorted(k for k in table if table[k].startswith('http'))
    refs = plain
    lines = []
    lines.append('/* hgPangenomeAssemblies.js - GENERATED FILE, DO NOT EDIT BY HAND.')
    lines.append(' *')
    lines.append(' * Maps a pangenome haplotype (PanSN "SAMPLE#PHASE", lower-cased) to the UCSC')
    lines.append(' * assembly it can be browsed in: a GenArk accession for HPRC sample')
    lines.append(' * haplotypes, or a plain db for the references.  Read through')
    lines.append(' * hgPangenomeCommon.js (assemblyFor) by the results page and by PanLift, to')
    lines.append(' * link a place on any haplotype to the Genome Browser.')
    lines.append(' *')
    lines.append(' * Source: %s' % os.path.basename(args.src))
    lines.append(' *   sha256 %s' % src_sha)
    lines.append(' *   from %s' % UPSTREAM_URL)
    lines.append(' * Regenerate with hgPangenome/makeAssemblyMap.py when HPRC publishes a new')
    lines.append(' * release; %d haplotypes here (%d named db, %d GenArk accessions,'
                 % (len(table), len(plain), len(table) - len(plain) - len(urls)))
    lines.append(' * %d non-portable hub URLs kept absolute).' % len(urls))
    lines.append(' * A second table gives each assembly its published name, for display.')
    lines.append(' */')
    lines.append('')
    lines.append('window.pangenomeAssemblies = {')
    for i, key in enumerate(sorted(table)):
        comma = ',' if i < len(table) - 1 else ''
        lines.append('    "%s": "%s"%s' % (key, table[key], comma))
    lines.append('};')
    lines.append('')
    lines.append('window.pangenomeAssemblyNames = {')
    keys = sorted(names)
    for i, db in enumerate(keys):
        comma = ',' if i < len(keys) - 1 else ''
        lines.append('    "%s": "%s"%s' % (db, names[db], comma))
    lines.append('};')
    lines.append('')

    with open(args.out, 'w') as fh:
        fh.write('\n'.join(lines))

    print('wrote %s' % os.path.normpath(args.out))
    print('  %d haplotypes: %d named db (%s), %d GenArk, %d absolute hub URLs (%s)'
          % (len(table), len(plain), ', '.join('%s->%s' % (k, table[k]) for k in plain),
             len(table) - len(plain) - len(urls), len(urls), ', '.join(urls)))
    if skipped:
        print('  skipped %d unusable/duplicate rows' % len(skipped))


if __name__ == '__main__':
    main()
