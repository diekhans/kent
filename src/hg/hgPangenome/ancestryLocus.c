/* ancestryLocus - what is read from files under /gbdb for a haplotype
 * assembly: where a region sits in ancestry space (cmd=pclai) and the gene a
 * hit falls in (cmd=locus). */
/* Copyright 2024 The Regents of the University of California. */
#include "common.h"
#include "obscure.h"
#include "hash.h"
#include "cheapcgi.h"
#include "jsonParse.h"
#include "dystring.h"
#include "errCatch.h"
#include "jksql.h"
#include "hdb.h"
#include "genark.h"
#include "bigBed.h"
#include <ctype.h>
#include <limits.h>
#include "hgPangenome.h"

/* ---- pcLAI: where each haplotype sits in ancestry space ------------------
 *
 * pcLAI (Geleta et al. 2026, doi:10.64898/2026.03.23.713813) places every
 * ~1000-SNP window of every HPRC haplotype at a coordinate in a reference PCA
 * space, rather than giving it an ancestry label.
 *
 * It is published in two coordinate systems, and which one is used decides
 * what the plot means.  The GRCh38-projected copy (/gbdb/hg38/hprcPclai, one
 * bigBed per haplotype keyed by chr1..chr22) can only be read at a single
 * shared reference locus, so every haplotype has to be asked about a position
 * that none of them necessarily matched: when the mapping is ambiguous that
 * locus can be megabases from where the sequence actually landed, and one bad
 * reference placement moves all fifty points at once.  The assembly-coordinate
 * copy - contrib/hprc2annot/pclai.bb on each HPRC2 GenArk hub, keyed by that
 * assembly's own sequences - is read at each haplotype's own surjection, which
 * is the question the results page is asking and is what we use here.  It also
 * means no GRCh38 round-trip: the surjections are already in hand.
 *
 * The browser cannot do this lookup itself - hgTrackUi serves a track's
 * metaDataUrl but never its bigDataUrl - so the reading is done here.  The
 * reference cloud the points are plotted against is a single shared file in
 * the same contrib directory and is passed through in the same answer, so the
 * page needs one request and no dependency on the cart's assembly.
 *
 * A mapping query is far shorter than a pcLAI window - 290 kb is typical - so
 * a hit normally falls inside a single window and has exactly one coordinate
 * here.  That is why this returns a point per haplotype and not a mixture. */

#define PCLAI_CONTRIB "contrib/hprc2annot"
#define PCLAI_PANEL_MAX (4 * 1024 * 1024)   /* the published panel is 94 kb */

static char *pgPclaiDir(char *acc)
/* The contrib directory holding one assembly's pcLAI, or NULL.
 *
 * The path comes from genArkPath(), which resolves through the genark table,
 * so an accession we do not serve yields NULL rather than a path - the caller
 * never builds a directory name out of unchecked input. */
{
if (isEmpty(acc))
    return NULL;
char *arkPath = genArkPath(acc);
if (arkPath == NULL)
    return NULL;
char dir[PATH_LEN];
safef(dir, sizeof(dir), "/gbdb/genark/%s/%s/%s", arkPath, acc, PCLAI_CONTRIB);
freez(&arkPath);
return cloneString(dir);
}

static boolean pgPclaiRgbOk(char *rgb)
/* "R,G,B" with nothing but digits and commas, since it reaches a style
 * attribute as the file wrote it. */
{
if (countChars(rgb, ',') != 2)
    return FALSE;
char *p;
for (p = rgb; *p != '\0'; ++p)
    if (!isdigit((unsigned char)*p) && *p != ',')
        return FALSE;
return TRUE;
}

#define PCLAI_MAX_WINDOWS 200   /* a 1 Mb conversion spans about ten */

static boolean pgPclaiRead(char *dir, char *chrom, int start, int end,
                           double *retX, double *retY, int *retConf,
                           char *retRgb, int rgbSize, struct dyString *windows)
/* The pcLAI coordinate of one haplotype over one interval of its own assembly,
 * or FALSE if there is no file or no window there.  The coordinate is the
 * window that overlaps the interval most - for a mapping hit, shorter than a
 * window, that is the one window it falls in.
 *
 * With windows non-NULL, also writes every window the interval overlaps as a
 * JSON list, each clipped to the interval, for a caller that wants where the
 * ancestry changes inside a region long enough to cross windows.  Neither page
 * asks for it now: both show the plot alone.
 * "c" is the authors' discretized call, the PCA centroid of the ancestry
 * cluster the window falls in - four values across the whole release.
 *
 * retRgb takes the window's itemRgb, which is the authors' own colour for that
 * coordinate - "generated from a perceptual mapping", per the pcLAI output
 * spec, and computed by their paintings.py as CIE Lab with L fixed at 80 and
 * a,b running with PC1,PC2.  Every value it produces is outside the sRGB gamut
 * and comes back clipped, so the mapping cannot be re-derived from the colours
 * and is not reimplemented here: the file's own value is passed through. */
{
char path[PATH_LEN];
safef(path, sizeof(path), "%s/pclai.bb", dir);
if (!fileExists(path))
    return FALSE;

boolean got = FALSE;
int bestOverlap = 0, nWin = 0;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct bbiFile *bbi = bigBedFileOpen(path);
    struct lm *lm = lmInit(0);
    struct bigBedInterval *iv, *list = bigBedIntervalQuery(bbi, chrom, start, end,
                                                           PCLAI_MAX_WINDOWS, lm);
    if (windows != NULL)
        dyStringAppend(windows, "[");
    for (iv = list; iv != NULL; iv = iv->next)
        {
        if (iv->rest == NULL)
            continue;
        /* rest is name, score, strand, thickStart, thickEnd, itemRgb, window,
         * pca, centroid - pca is the eighth.  The GRCh38-projected files carry
         * an extra "haplotype" column before window and put pca ninth; these
         * do not need it, because the file is the haplotype. */
        char *row[16];
        char *rest = cloneString(iv->rest);
        int n = chopByChar(rest, '\t', row, ArraySize(row));
        double x = 0, y = 0, cx = 0, cy = 0;
        if (n < 8 || sscanf(row[7], "(%lf,%lf)", &x, &y) != 2)
            {
            freez(&rest);
            continue;
            }
        boolean hasCentroid = (n >= 9 && sscanf(row[8], "(%lf,%lf)", &cx, &cy) == 2);
        boolean rgbOk = pgPclaiRgbOk(row[5]);
        int s = max((int)iv->start, start), e = min((int)iv->end, end);
        if (e - s > bestOverlap)
            {
            bestOverlap = e - s;
            *retX = x;
            *retY = y;
            *retConf = atoi(row[1]);
            retRgb[0] = '\0';
            if (rgbOk)
                safef(retRgb, rgbSize, "%s", row[5]);
            got = TRUE;
            }
        if (windows != NULL && e > s)
            {
            /* The window id is the authors' "chr2_w0001"; keep only the
             * characters such an id has before it reaches a page. */
            char *w = row[6], *p;
            for (p = w; *p != '\0'; ++p)
                if (!isalnum((unsigned char)*p) && *p != '_')
                    *p = '_';
            dyStringPrintf(windows, "%s{\"s\":%d,\"e\":%d,\"w\":\"%s\",\"x\":%g,\"y\":%g,"
                           "\"conf\":%d", nWin ? "," : "", s, e, w, x, y, atoi(row[1]));
            if (hasCentroid)
                dyStringPrintf(windows, ",\"cx\":%g,\"cy\":%g", cx, cy);
            if (rgbOk)
                dyStringPrintf(windows, ",\"rgb\":\"%s\"", row[5]);
            dyStringAppend(windows, "}");
            nWin++;
            }
        freez(&rest);
        }
    if (windows != NULL)
        dyStringAppend(windows, "]");
    lmCleanup(&lm);
    bbiFileClose(&bbi);
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    {
    fprintf(stderr, "hgPangenome: pcLAI read failed for %s %s: %s\n", path, chrom,
            trimSpaces(errCatch->message->string));
    got = FALSE;
    }
errCatchFree(&errCatch);
return got;
}

/* ---- Locus: the gene a hit falls in ------------------------------------------
 *
 * The results table's Locus column, worded as hgBlat's is: "exon BRCA1",
 * "intron STON2", "intergenic FOO-BAR".  A native assembly answers from its
 * locusName table, as BLAT does - GRCh38 has one.  The rest are worked out
 * from CAT genes: every HPRC assembly carries the set the HPRC annotated it
 * with, contrib/hprc2annot/catGenes.bb on its GenArk hub, and CHM13 has its
 * own CAT/LiftOff set.  Both files keep the gene symbol and the gene type in
 * the same columns. */

#define LOCUS_MAX_ITEMS 200     /* one page of the table */
#define LOCUS_MAX_GENES 3       /* "exon A-B-C" says enough */
#define LOCUS_SPAN_PER_SEQ 10   /* longest interval named, in longest sequences */

static char *pgCatGenesPath(char *acc)
/* The CAT gene bigBed of one assembly, or NULL. */
{
if (!startsWith("GCA_", acc) && !startsWith("GCF_", acc))
    {
    char path[PATH_LEN];
    safef(path, sizeof(path), "/gbdb/%s/catLiftOffGenesV1/catLiftOffGenesV1.bb", acc);
    return fileExists(path) ? cloneString(path) : NULL;
    }
char *dir = pgPclaiDir(acc);
if (dir == NULL)
    return NULL;
char path[PATH_LEN];
safef(path, sizeof(path), "%s/catGenes.bb", dir);
freez(&dir);
return fileExists(path) ? cloneString(path) : NULL;
}

static void pgLocusAddGene(char **genes, int *count, char *name)
/* Add a gene name once, up to LOCUS_MAX_GENES. */
{
int i;
if (isEmpty(name))
    return;
for (i = 0; i < *count; ++i)
    if (sameString(genes[i], name))
        return;
if (*count < LOCUS_MAX_GENES)
    genes[(*count)++] = name;
}

static char *pgCatLocus(struct bbiFile *bbi, char *chrom, int start, int end, struct lm *lm)
/* hgBlat's locus words for one interval, from a CAT bigGenePred, or NULL when
 * the sequence has no genes near enough to name.
 *
 * A transcript's fields after chrom, start and end are name, score, strand,
 * thickStart, thickEnd, itemRgb, blockCount, blockSizes, chromStarts, name2 -
 * the gene symbol - and then cdsStartStat, cdsEndStat, exonFrames, type,
 * geneName, geneName2, geneType.  A protein-coding gene wins over the lncRNAs
 * that so often overlap it, as it would in the reader's own words. */
{
char *exonGenes[LOCUS_MAX_GENES], *geneGenes[LOCUS_MAX_GENES];
int nExon = 0, nGene = 0;
boolean codingOnly;
struct bigBedInterval *iv, *list = bigBedIntervalQuery(bbi, chrom, start, end, 0, lm);
for (codingOnly = TRUE; ; codingOnly = FALSE)
    {
    for (iv = list; iv != NULL; iv = iv->next)
        {
        /* A file built as plain BED3 has no fields here at all. */
        if (iv->rest == NULL)
            continue;
        char *row[20];
        char *rest = lmCloneString(lm, iv->rest);
        int n = chopByChar(rest, '\t', row, ArraySize(row));
        if (n < 17)
            continue;
        if (codingOnly && !sameString(row[16], "protein_coding"))
            continue;
        char *gene = row[9];
        pgLocusAddGene(geneGenes, &nGene, gene);
        int blockCount = atoi(row[6]);
        char *sizeWords[1024], *startWords[1024];
        if (blockCount <= 0 || blockCount > ArraySize(sizeWords) ||
            chopByChar(row[7], ',', sizeWords, ArraySize(sizeWords)) < blockCount ||
            chopByChar(row[8], ',', startWords, ArraySize(startWords)) < blockCount)
            continue;
        int b;
        for (b = 0; b < blockCount; ++b)
            {
            int bStart = iv->start + atoi(startWords[b]);
            int bEnd = bStart + atoi(sizeWords[b]);
            if (bStart < end && bEnd > start)
                {
                pgLocusAddGene(exonGenes, &nExon, gene);
                break;
                }
            }
        }
    if (nGene > 0 || !codingOnly)
        break;
    }
struct dyString *dy = dyStringNew(64);
int i;
if (nGene > 0)
    {
    dyStringAppend(dy, nExon > 0 ? "exon " : "intron ");
    for (i = 0; i < (nExon > 0 ? nExon : nGene); ++i)
        dyStringPrintf(dy, "%s%s", i ? "-" : "", nExon > 0 ? exonGenes[i] : geneGenes[i]);
    return dyStringCannibalize(&dy);
    }
/* Between genes: the nearest on each side, looking further out until both
 * are found or ten megabases either way have turned up nothing - gene deserts
 * of five are not rare. */
char *left = NULL, *right = NULL;
int leftEnd = -1, rightStart = -1, reach;
for (reach = 100000; reach <= 10000000 && (left == NULL || right == NULL); reach *= 10)
    {
    struct bigBedInterval *near = bigBedIntervalQuery(bbi, chrom, max(0, start - reach),
                                                      end + reach, 0, lm);
    for (iv = near; iv != NULL; iv = iv->next)
        {
        if (iv->rest == NULL)
            continue;
        char *row[20];
        char *rest = lmCloneString(lm, iv->rest);
        if (chopByChar(rest, '\t', row, ArraySize(row)) < 17 ||
            !sameString(row[16], "protein_coding"))
            continue;
        if ((int)iv->end <= start && (int)iv->end > leftEnd)
            { leftEnd = iv->end; left = row[9]; }
        if ((int)iv->start >= end && (rightStart < 0 || (int)iv->start < rightStart))
            { rightStart = iv->start; right = row[9]; }
        }
    }
if (left == NULL && right == NULL)
    {
    dyStringFree(&dy);
    return NULL;
    }
dyStringPrintf(dy, "intergenic %s%s%s", left ? left : "", (left && right) ? "-" : "",
               right ? right : "");
return dyStringCannibalize(&dy);
}

struct pgLocusDb
/* The database connection doLocus keeps, and the assembly it is on. */
    {
    struct sqlConnection *conn;
    char *db;
    };

static struct sqlConnection *pgLocusConn(struct pgLocusDb *at, char *db)
/* The connection, moved to db when it is on another assembly.
 *
 * One is kept, not one per assembly: the library's cache holds 16, a page of
 * hits can name 200 assemblies, and asking for a 17th ends the request.  A
 * connection handed back is the one given out next, so moving costs a change
 * of database on the same link to the server and no new login. */
{
if (at->conn == NULL || differentString(at->db, db))
    {
    hFreeConn(&at->conn);
    freez(&at->db);
    at->conn = hAllocConn(db);
    at->db = cloneString(db);
    }
return at->conn;
}

void doLocus()
/* The locus words for each interval in the payload, in order:
 *   {"items":[{"db":"GCA_...","contig":"CM094060.1","start":0,"end":10}, ...]}
 * answers {"status":"ok","loci":["exon ATAD3B", null, ...]}, null where there
 * is nothing to say - a hub assembly, or no genes near enough.  A gene file is
 * opened once per assembly in the request; the database is read over one
 * connection, moved from assembly to assembly. */
{
char *payload = cgiOptionalString("payload");
if (isEmpty(payload))
    {
    emitJsonError("missing payload");
    return;
    }
/* An interval here is a hit, about as long as the sequence that was mapped.
 * One far longer than any sequence can be is not looked up, and is answered
 * null: every gene in it would be read to name it. */
double maxSpan = (double)LOCUS_SPAN_PER_SEQ * pgMaxSeqLen();
struct dyString *out = dyStringNew(4096);
dyStringAppend(out, "{\"status\":\"ok\",\"loci\":[");
char *parseError = NULL;
/* nativeByDb: 1 for an assembly in our database with the locusName table, 0
 * for any other, so that each is asked about once. */
struct hash *bbiByDb = hashNew(6), *nativeByDb = hashNew(6);
struct pgLocusDb *at;
AllocVar(at);
struct lm *lm = lmInit(0);
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct jsonElement *root = jsonParse(payload);
    struct jsonElement *itemsEl = jsonFindNamedField(root, "", "items");
    if (itemsEl == NULL)
        parseError = "payload is missing 'items'";
    else
        {
        struct slRef *ref;
        int n = 0;
        for (ref = jsonListVal(itemsEl, "items"); ref != NULL && n < LOCUS_MAX_ITEMS;
             ref = ref->next, ++n)
            {
            struct jsonElement *item = ref->val;
            char *db = jsonOptionalStringField(item, "db", NULL);
            char *contig = jsonOptionalStringField(item, "contig", NULL);
            struct jsonElement *sEl = jsonFindNamedField(item, "", "start");
            struct jsonElement *eEl = jsonFindNamedField(item, "", "end");
            char *locus = NULL;
            if (pgSafeToken(db) && pgSafeToken(contig) && sEl != NULL && eEl != NULL &&
                sEl->type == jsonNumber && eEl->type == jsonNumber &&
                sEl->val.jeNumber >= 0 && eEl->val.jeNumber > sEl->val.jeNumber &&
                eEl->val.jeNumber - sEl->val.jeNumber <= maxSpan &&
                eEl->val.jeNumber <= INT_MAX)
                {
                /* Held to what an int holds first: a start of 4294967296 is a
                 * short interval by the tests above, and 0 once it is narrowed. */
                int start = sEl->val.jeNumber, end = eEl->val.jeNumber;
                int native = hashIntValDefault(nativeByDb, db, -1);
                if (native < 0)
                    {
                    native = !startsWith("GCA_", db) && !startsWith("GCF_", db) &&
                             hDbExists(db) && sqlTableExists(pgLocusConn(at, db), "locusName");
                    hashAddInt(nativeByDb, db, native);
                    }
                if (native)
                    locus = hLocusName(pgLocusConn(at, db), contig, start, end);
                else
                    {
                    struct hashEl *hel = hashLookup(bbiByDb, db);
                    if (hel == NULL)
                        {
                        char *path = pgCatGenesPath(db);
                        hel = hashAdd(bbiByDb, db, path ? bigBedFileOpen(path) : NULL);
                        freez(&path);
                        }
                    if (hel->val != NULL)
                        locus = pgCatLocus(hel->val, contig, start, end, lm);
                    }
                }
            dyStringPrintf(out, "%s", n ? "," : "");
            if (locus == NULL)
                dyStringAppend(out, "null");
            else
                dyStringPrintf(out, "\"%s\"", jsonStringEscape(locus));
            freez(&locus);
            }
        }
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    parseError = "could not read the gene annotations";
errCatchFree(&errCatch);
struct hashEl *hel, *helList = hashElListHash(bbiByDb);
for (hel = helList; hel != NULL; hel = hel->next)
    if (hel->val != NULL)
        {
        struct bbiFile *bbi = hel->val;
        bigBedFileClose(&bbi);
        }
hashElFreeList(&helList);
hFreeConn(&at->conn);
freez(&at->db);
freez(&at);
lmCleanup(&lm);
if (parseError != NULL)
    emitJsonError("%s", parseError);
else
    {
    dyStringAppend(out, "]}");
    emitJson(out->string);
    }
dyStringFree(&out);
}

static char *pgPclaiPanel(char *path)
/* The reference panel file's text, or NULL when there is no file, it is far
 * bigger than a panel is, or it does not read as an object with a "points"
 * list.
 *
 * The text goes into the answer as it is.  A file caught half written during
 * a data push would make the whole answer unreadable; left out, the page says
 * that there is no panel. */
{
if (isEmpty(path) || !fileExists(path) || fileSize(path) > PCLAI_PANEL_MAX)
    return NULL;
char *text = NULL;
size_t size = 0;
readInGulp(path, &text, &size);
boolean ok = FALSE;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct jsonElement *root = jsonParse(text);
    struct jsonElement *points = (root->type == jsonObject) ?
                                 jsonFindNamedField(root, "", "points") : NULL;
    ok = (points != NULL && points->type == jsonList);
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    ok = FALSE;
errCatchFree(&errCatch);
if (!ok)
    freez(&text);
return text;
}

static boolean pgPclaiChrom(char *hap, char *contig, char *buf, int bufSize)
/* Build the sequence name pcLAI uses - full PanSN, SAMPLE#PHASE#CONTIG - from
 * the two-field haplotype and the contig a surjection named.  FALSE if either
 * is not the shape an HPRC name has. */
{
char *sample = cloneString(hap);
char *hash = strchr(sample, '#');
if (hash == NULL)
    { freez(&sample); return FALSE; }
*hash++ = '\0';
char *phase = hash;
char *more = strchr(phase, '#');        /* a 3-field name carries a contig too */
if (more != NULL)
    *more = '\0';
boolean ok = pgSafeToken(sample) && pgSafeToken(phase) && pgSafeToken(contig);
if (ok)
    safef(buf, bufSize, "%s#%s#%s", sample, phase, contig);
freez(&sample);
return ok;
}

void doPclai()
/* Ancestry coordinates for a list of haplotypes, each read at its own
 * surjected interval, plus the reference cloud they are read against.  With
 * "windows": true, each point also lists every window its interval crosses.
 *
 * The payload is a list rather than one shared locus because that is the whole
 * point of using the assembly-coordinate files - see the note above. */
{
char *payload = cgiOptionalString("payload");
if (isEmpty(payload))
    {
    emitJsonError("missing payload");
    return;
    }

struct dyString *out = dyStringNew(4096);
dyStringAppend(out, "{\"status\":\"ok\",\"points\":[");
boolean wantWindows = FALSE;
int found = 0, asked = 0;
int maxHaps = PG_PCLAI_MAX_HAPLOTYPES;
char *panelDir = NULL;                  /* the first contrib dir that resolved */
char *parseError = NULL;

struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct jsonElement *root = jsonParse(payload);
    struct jsonElement *spotsEl = jsonFindNamedField(root, "", "spots");
    /* PanLift asks for every window in each region, not just its point. */
    struct jsonElement *winEl = jsonFindNamedField(root, "", "windows");
    wantWindows = (winEl != NULL && winEl->type == jsonBoolean && winEl->val.jeBoolean);
    if (spotsEl == NULL)
        parseError = "payload is missing 'spots'";
    else
        {
        struct slRef *ref, *list = jsonListVal(spotsEl, "spots");
        for (ref = list; ref != NULL && asked < maxHaps; ref = ref->next)
            {
            struct jsonElement *spot = ref->val;
            char *hap = jsonOptionalStringField(spot, "hap", NULL);
            /* The caller's own name for this spot, echoed back untouched.  The
             * same haplotype can be asked about twice in one request - once per
             * placement of a query that mapped to several loci - so "hap" does
             * not identify an answer on its own. */
            char *id = jsonOptionalStringField(spot, "id", NULL);
            char *acc = jsonOptionalStringField(spot, "acc", NULL);
            char *contig = jsonOptionalStringField(spot, "contig", NULL);
            struct jsonElement *sEl = jsonFindNamedField(spot, "", "start");
            struct jsonElement *eEl = jsonFindNamedField(spot, "", "end");
            if (isEmpty(hap) || isEmpty(acc) || isEmpty(contig) ||
                sEl == NULL || eEl == NULL ||
                sEl->type != jsonNumber || eEl->type != jsonNumber)
                continue;
            asked++;
            /* Tested as the numbers they came as.  Narrowed to an int first, one
             * past what an int holds turns into a value that passes. */
            if (sEl->val.jeNumber < 0 || eEl->val.jeNumber <= sEl->val.jeNumber ||
                eEl->val.jeNumber > INT_MAX)
                continue;
            int start = (int)sEl->val.jeNumber;
            int end = (int)eEl->val.jeNumber;
            char chrom[PATH_LEN];
            if (!pgPclaiChrom(hap, contig, chrom, sizeof(chrom)))
                continue;
            char *dir = pgPclaiDir(acc);
            if (dir == NULL)
                continue;
            if (panelDir == NULL)
                panelDir = cloneString(dir);
            double x, y;
            int conf = 0;
            char rgb[32];
            rgb[0] = '\0';
            struct dyString *win = wantWindows ? dyStringNew(512) : NULL;
            if (pgPclaiRead(dir, chrom, start, end, &x, &y, &conf,
                            rgb, sizeof(rgb), win))
                {
                dyStringPrintf(out,
                    "%s{\"hap\":\"%s\",\"x\":%g,\"y\":%g,\"conf\":%d",
                    found ? "," : "", jsonStringEscape(hap), x, y, conf);
                if (!isEmpty(id))
                    dyStringPrintf(out, ",\"id\":\"%s\"", jsonStringEscape(id));
                if (rgb[0] != '\0')
                    dyStringPrintf(out, ",\"rgb\":\"%s\"", rgb);
                if (win != NULL)
                    dyStringPrintf(out, ",\"windows\":%s", win->string);
                dyStringAppend(out, "}");
                found++;
                }
            dyStringFree(&win);
            freez(&dir);
            }
        }
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    parseError = "could not read the request";
errCatchFree(&errCatch);

if (parseError != NULL)
    {
    dyStringFree(&out);
    freez(&panelDir);
    emitJsonError("%s", parseError);
    return;
    }
dyStringPrintf(out, "],\"asked\":%d,\"found\":%d", asked, found);

/* The reference cloud.  It is the pcLAI authors' published panel, one shared
 * file symlinked into every assembly's contrib directory, and it is what makes
 * a coordinate readable.  Taken from a directory we have already resolved, so
 * the answer stays within the files the points came from. */
char panelPath[PATH_LEN];
char *cfgPanel = pgPclaiRefPanel();
if (cfgPanel != NULL)
    safef(panelPath, sizeof(panelPath), "%s", cfgPanel);
else if (panelDir != NULL)
    safef(panelPath, sizeof(panelPath), "%s/pclaiRefPanel.json", panelDir);
else
    panelPath[0] = '\0';
char *panel = pgPclaiPanel(panelPath);
if (panel != NULL)
    {
    dyStringAppend(out, ",\"panel\":");
    dyStringAppend(out, panel);
    freez(&panel);
    }
freez(&panelDir);
dyStringAppend(out, "}");
emitJson(out->string);
dyStringFree(&out);
}
