#!/usr/bin/env python3
"""makeSvCarriers.py - which haplotypes carry each structural variant of the
HPRC release 2.1 pangenome, from the graph's own VCF.

The browser's "HPRC v2.1 233 SVs" track (hprc2v21Sv, built by
makeDb/scripts/lrSv/lrSvHprc2RoVcfToBed.py) has each SV's allele count but not
who carries it.  The VCF it was made from has, for every sample, a phased
genotype - one allele per haplotype - so the carriers can be read off it.  This
writes the same SVs, positioned and named by that script's own functions so a
row here matches a track item exactly, with two more fields:

    carriers  hex bitmap: the haplotypes whose allele is this SV
    missing   hex bitmap: the haplotypes with no call at this site
              (the rest carry the reference allele)

Bit i (most significant first) is the i-th haplotype in the .haps file written
beside the output, in VCF sample order: a haploid sample (CHM13, GRCh38) gives
SAMPLE#0, a diploid one SAMPLE#1 then SAMPLE#2 for its two alleles in GT order.

The track script drops rows that come out byte-identical from different VCF
records (vg deconstruct splits some snarls that way).  For counts that is
harmless; for carriers each copy may name different haplotypes, so here
identical rows are merged and their carriers combined.

Usage:
    makeSvCarriers.py in.vcf.gz out.bed [--chrom chr1] [--lrsv DIR]

The VCF is streamed once, through zcat; --chrom stops after that chromosome,
which for chr1 (the first in the file) reads only the start of it.  Run it
niced: it is a one-off read of a 4 GB file, not something to compete with a
web server for.  Only the python3 standard library is used.
"""

import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_LRSV = os.path.join(HERE, '..', 'makeDb', 'scripts', 'lrSv')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('vcf')
    ap.add_argument('out')
    ap.add_argument('--chrom', help='only this chromosome (stops reading after it)')
    ap.add_argument('--lrsv', default=DEFAULT_LRSV,
                    help='directory of the track script, whose rules are reused')
    args = ap.parse_args()

    # The track's own rules, so a row here is a track item.
    sys.path.insert(0, os.path.abspath(args.lrsv))
    import lrSvHprc2RoVcfToBed as track          # noqa: E402
    from lrSvCommon import svName, svColor       # noqa: E402
    minLen = track.MIN_SV_LEN

    proc = subprocess.Popen(['zcat', args.vcf], stdout=subprocess.PIPE, text=True,
                            bufsize=1 << 20)
    haps = None            # haplotype names, in bit order
    hapCols = None         # for each sample column: its haplotype indexes
    rows = {}              # the 17 track fields -> [carrier bits, missing bits]
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
                rows[key][0] |= carriers
                rows[key][1] &= missing
            else:
                rows[key] = [carriers, missing]
                order.append(key)
    proc.stdout.close()
    proc.terminate()

    width = (len(haps) + 3) // 4
    with open(args.out, 'w') as out:
        for key in order:
            c, m = rows[key]
            out.write('%s\t%0*x\t%0*x\n' % (key, width, c, width, m))
    with open(args.out + '.haps', 'w') as fh:
        fh.write('\n'.join(haps) + '\n')
    print('%s: %d records read, %d SVs written, %d haplotypes'
          % (args.chrom or 'all', nRecords, len(order), len(haps)), file=sys.stderr)


if __name__ == '__main__':
    main()
