#!/usr/bin/env python3
"""makeSvCarriers.py - which haplotypes carry each structural variant of the
HPRC release 2.1 pangenome, from the graph's own VCF.

The browser's "HPRC v2.1 233 SVs" track (hprc2v21Sv, built by
makeDb/scripts/lrSv/lrSvHprc2RoVcfToBed.py) has each SV's allele count but not
who carries it.  The VCF it was made from has, for every sample, a phased
genotype - one allele per haplotype - so the carriers can be read off it.  This
writes the same SVs, positioned and named by that script's own functions so a
row here matches a track item exactly, with two more fields:

    siteStart, siteEnd
              the graph site this SV is one allele of: the VCF record's REF
              span on the reference, 0-based half-open
    carriers  hex bitmap: the haplotypes whose allele is this SV
    missing   hex bitmap: the haplotypes with no call at this site
              (the rest carry another allele: the reference's, a change
              under 50 bp, or another SV at the same site)

The site matters because the track places an SV where its REF and ALT stop
agreeing from the left, which can be far from where the haplotypes actually
differ: chr1:730,868 INS-13.6k:11 is drawn at the start of a 10 kb site whose
13.6 kb insertion sits near 737,000 in every carrier.  Anything that goes and
looks at the SV on a haplotype has to ask for the whole site.

Bit i (most significant first) is the i-th haplotype in the .haps file written
beside the output, in VCF sample order: a haploid sample (CHM13, GRCh38) gives
SAMPLE#0, a diploid one SAMPLE#1 then SAMPLE#2 for its two alleles in GT order.
Each .haps line is the haplotype, then its population as the HPRC describes it
- 1000 Genomes code and descriptor, from the sample metadata makeSampleMap.py
reads - tab separated; both are empty where the HPRC gives none.  The details
page of an SV (hgc's pangenomeCarriers section) groups the carriers by it.

The track script drops rows that come out byte-identical from different VCF
records (vg deconstruct splits some snarls that way).  For counts that is
harmless; for carriers each copy may name different haplotypes, so here
identical rows are merged: their carriers combined, and their sites widened to
cover both.

Usage:
    makeSvCarriers.py in.vcf.gz out.bed [--chrom chr1] [--lrsv DIR] [--haps-only]

--haps-only reads only the VCF's header and rewrites out.bed.haps, for when the
sample metadata changes and the carriers do not.

The VCF is streamed once, through zcat; --chrom stops after that chromosome,
which for chr1 (the first in the file) reads only the start of it.  Run it
niced: it is a one-off read of a 4 GB file, not something to compete with a
web server for.  Only the python3 standard library is used.
"""

import argparse
import csv
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_LRSV = os.path.join(HERE, '..', 'makeDb', 'scripts', 'lrSv')
DEFAULT_METADATA = os.path.join(HERE, 'hprc_release2_sample_metadata.csv')


def readPopulations(path):
    """sample -> (code, descriptor), as makeSampleMap.py reads them for the page."""
    sys.path.insert(0, HERE)
    from makeSampleMap import clean     # the same repairs as the page's table
    pops = {}
    with open(path, encoding='utf-8', newline='') as fh:
        for r in csv.DictReader(fh):
            code = clean(r.get('population_abbreviation'))
            desc = clean(r.get('population_descriptor'))
            if code and code != 'N/A' and desc and desc != 'N/A':
                pops[(r.get('sample_id') or '').strip()] = (code, desc)
    return pops


def writeHaps(path, haps, populations):
    with open(path, 'w', encoding='utf-8') as fh:
        for h in haps:
            code, desc = populations.get(h.split('#')[0], ('', ''))
            fh.write('%s\t%s\t%s\n' % (h, code, desc))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('vcf')
    ap.add_argument('out')
    ap.add_argument('--chrom', help='only this chromosome (stops reading after it)')
    ap.add_argument('--lrsv', default=DEFAULT_LRSV,
                    help='directory of the track script, whose rules are reused')
    ap.add_argument('--metadata', default=DEFAULT_METADATA,
                    help='HPRC sample metadata CSV, for each haplotype\'s population')
    ap.add_argument('--haps-only', action='store_true',
                    help='only rewrite the .haps file, from the VCF header')
    args = ap.parse_args()
    populations = readPopulations(args.metadata)

    # The track's own rules, so a row here is a track item.
    sys.path.insert(0, os.path.abspath(args.lrsv))
    import lrSvHprc2RoVcfToBed as track          # noqa: E402
    from lrSvCommon import svName, svColor       # noqa: E402
    minLen = track.MIN_SV_LEN

    proc = subprocess.Popen(['zcat', args.vcf], stdout=subprocess.PIPE, text=True,
                            bufsize=1 << 20)
    haps = None            # haplotype names, in bit order
    hapCols = None         # for each sample column: its haplotype indexes
    rows = {}              # the 17 track fields -> [carriers, missing, siteStart, siteEnd]
    order = []             # row keys in file order
    seenChrom = False
    nRecords = 0
    for line in proc.stdout:
        if line.startswith('##'):
            continue
        if line.startswith('#CHROM'):
            samples = line.rstrip('\n').split('\t')[9:]
            haps, hapCols = [], []
            # Ploidy is not in the header; CHM13 and GRCh38 are the haploid
            # ones, and every other sample is diploid.
            for s in samples:
                if s in ('CHM13', 'GRCh38'):
                    hapCols.append([len(haps)])
                    haps.append(s + '#0')
                else:
                    hapCols.append([len(haps), len(haps) + 1])
                    haps.extend([s + '#1', s + '#2'])
            if args.haps_only:
                break
            continue
        # Only the first nine columns are needed to decide whether a record
        # holds an SV at all; most do not, so the genotypes stay unsplit.
        head = line.split('\t', 9)
        chrom = head[0]
        if args.chrom:
            if chrom != args.chrom:
                if seenChrom:
                    break
                continue
            seenChrom = True
        nRecords += 1
        ref = head[3]
        alts = head[4].split(',')
        if max(abs(len(a) - len(ref)) for a in alts) < minLen:
            continue

        pos = int(head[1])
        siteStart, siteEnd = pos - 1, pos - 1 + len(ref)
        rowId = head[2]
        info = track.parseInfo(head[7])
        n = len(alts)
        acList = track.splitMulti(info.get('AC'), n)
        afList = track.splitMulti(info.get('AF'), n)
        try:
            nSamples = int(info.get('NS', '0'))
        except ValueError:
            nSamples = 0
        try:
            an = int(info.get('AN', '0'))
        except ValueError:
            an = 0
        try:
            snarlLevel = int(info.get('LV', '0'))
        except ValueError:
            snarlLevel = 0

        # Each haplotype's allele index here, 0 for the reference, -1 for none.
        gts = head[9].rstrip('\n').split('\t')
        alleleOf = [-1] * len(haps)
        for col, gt in enumerate(gts):
            g = gt.split(':', 1)[0].replace('/', '|').split('|')
            for k, hi in enumerate(hapCols[col]):
                if k < len(g) and g[k] not in ('.', ''):
                    alleleOf[hi] = int(g[k])

        missing = 0
        for hi, a in enumerate(alleleOf):
            if a < 0:
                missing |= 1 << (len(haps) - 1 - hi)

        for i, alt in enumerate(alts):
            if alt in ('.', '*'):
                continue
            svLenVal = abs(len(alt) - len(ref))
            if svLenVal < minLen:
                continue
            # Positioned and named exactly as the track script does it.
            svType, prefixLen, refSpan = track.classify(ref, alt)
            chromStart = (pos - 1) + prefixLen
            chromEnd = chromStart + 1 if svType == 'INS' else chromStart + max(1, refSpan)
            if chromEnd <= chromStart:
                chromEnd = chromStart + 1
            try:
                ac = int(acList[i])
            except ValueError:
                ac = 0
            try:
                af = float(afList[i])
            except ValueError:
                af = 0.0
            svLen = chromEnd - chromStart
            insLen = svLenVal if svType == 'INS' else 0
            featLen = insLen if svType == 'INS' else svLen
            key = '\t'.join([chrom, str(chromStart), str(chromEnd),
                             svName(svType, featLen, ac), '0', '.', str(chromStart),
                             str(chromEnd), svColor(svType), svType, str(svLen),
                             str(insLen), str(ac), str(an), f'{af:.6f}', str(nSamples),
                             str(snarlLevel)])
            carriers = 0
            for hi, a in enumerate(alleleOf):
                if a == i + 1:
                    carriers |= 1 << (len(haps) - 1 - hi)
            if key in rows:
                row = rows[key]
                row[0] |= carriers
                row[1] &= missing
                row[2] = min(row[2], siteStart)
                row[3] = max(row[3], siteEnd)
            else:
                rows[key] = [carriers, missing, siteStart, siteEnd]
                order.append(key)
    proc.stdout.close()
    proc.terminate()
    if args.haps_only:
        writeHaps(args.out + '.haps', haps, populations)
        print('wrote %s.haps: %d haplotypes' % (args.out, len(haps)), file=sys.stderr)
        return

    width = (len(haps) + 3) // 4
    with open(args.out, 'w') as out:
        for key in order:
            c, m, s0, s1 = rows[key]
            out.write('%s\t%d\t%d\t%0*x\t%0*x\n' % (key, s0, s1, width, c, width, m))
    writeHaps(args.out + '.haps', haps, populations)
    print('%s: %d records read, %d SVs written, %d haplotypes'
          % (args.chrom or 'all', nRecords, len(order), len(haps)), file=sys.stderr)


if __name__ == '__main__':
    main()
