#!/usr/bin/env python3
"""makeSampleMap.py - generate js/hgPangenomeSamples.js from the HPRC release 2
sample metadata CSV.

The CSV is committed next to this script, as the assembly index is for
makeAssemblyMap.py, so generating the table needs no network access and always
produces the same result for a given release.

What the page gets is each sample's population as the HPRC describes it: the
1000 Genomes population code ("GBR") and descriptor ("British from England and
Scotland").  PanLift's target picker groups and filters haplotypes by it.

Nothing is added to that.  The HPRC follows the NHGRI's guidelines for referring
to populations, which do not use super-populations, and leaves them out of the
metadata on purpose (see the README beside the CSV upstream), so this table
does not invent them either.  Samples with "N/A" - the references, and the GIAB
samples HG002 and HG005 - get no entry, and the page says "no population given".

One repair: the descriptor of GWD arrives as "Gambian in Western Division Ð
Mandinka", an en dash that was mis-encoded somewhere upstream (Mac Roman 0xD0
read as Latin-1, then written as UTF-8).  It is written back as an en dash.

Usage:
    ./makeSampleMap.py                       # use the committed CSV (default)
    ./makeSampleMap.py other.csv             # or another file
    ./makeSampleMap.py --out ../js/hgPangenomeSamples.js

Only the python3 standard library is used.
"""

import argparse
import csv
import hashlib
import io
import json
import os
import sys

UPSTREAM_URL = ("https://github.com/human-pangenomics/hprc_intermediate_assembly/"
                "blob/568298a358c35dc9930be71519e472f33aebc1e6/data_tables/sample/"
                "hprc_release2_sample_metadata.csv")

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = os.path.join(HERE, 'hprc_release2_sample_metadata.csv')
DEFAULT_OUT = os.path.join(HERE, '..', 'js', 'hgPangenomeSamples.js')

# Mis-encodings seen in the source, and what they stand for.
REPAIRS = {'Ð': '–'}


def clean(text):
    text = (text or '').strip()
    for bad, good in REPAIRS.items():
        text = text.replace(bad, good)
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src', nargs='?', default=DEFAULT_SRC)
    ap.add_argument('--out', default=DEFAULT_OUT)
    args = ap.parse_args()

    # Hashed as the bytes on disk, so the header matches sha256sum of the file.
    data = open(args.src, 'rb').read()
    src_sha = hashlib.sha256(data).hexdigest()
    raw = data.decode('utf-8')
    rows = list(csv.DictReader(io.StringIO(raw)))

    samples = {}
    missing = []
    for r in rows:
        sid = (r.get('sample_id') or '').strip()
        code = clean(r.get('population_abbreviation'))
        desc = clean(r.get('population_descriptor'))
        if not sid:
            continue
        if not code or code == 'N/A' or not desc or desc == 'N/A':
            missing.append(sid)
            continue
        samples[sid.lower()] = [code, desc]
    if not samples:
        sys.exit('makeSampleMap.py: no samples with a population in %s' % args.src)

    pops = sorted({tuple(v) for v in samples.values()}, key=lambda p: p[1])
    lines = []
    lines.append('/* hgPangenomeSamples.js - GENERATED FILE, DO NOT EDIT BY HAND.')
    lines.append(' *')
    lines.append(' * Maps a pangenome sample (the SAMPLE of PanSN "SAMPLE#PHASE", lower-cased)')
    lines.append(' * to its population as the HPRC describes it: [1000 Genomes code, descriptor].')
    lines.append(' * Read through hgPangenomeCommon.js (population) by the results page, for its')
    lines.append(' * Population column, and by PanLift, to group and filter the target picker.')
    lines.append(' * Super-populations are deliberately absent: the HPRC follows the NHGRI')
    lines.append(" * guidelines for referring to populations, which do not use them.")
    lines.append(' *')
    lines.append(' * Source: %s' % os.path.basename(args.src))
    lines.append(' *   sha256 %s' % src_sha)
    lines.append(' *   from %s' % UPSTREAM_URL)
    lines.append(' * Regenerate with hgPangenome/makeSampleMap.py; %d samples with a population'
                 % len(samples))
    lines.append(' * in %d populations; no population given for %s.'
                 % (len(pops), ', '.join(sorted(missing))))
    lines.append(' */')
    lines.append('')
    lines.append('window.pangenomeSamples = {')
    body = ['    %s: %s' % (json.dumps(k), json.dumps(samples[k], ensure_ascii=False))
            for k in sorted(samples)]
    lines.append(',\n'.join(body))
    lines.append('};')
    lines.append('')
    with open(args.out, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines))
    print('wrote %s: %d samples, %d populations, %d without'
          % (args.out, len(samples), len(pops), len(missing)))


if __name__ == '__main__':
    main()
