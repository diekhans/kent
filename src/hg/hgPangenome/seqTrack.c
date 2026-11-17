/* seqTrack - the mapped sequence as a track: a job's query sequences kept
 * where the results page can read them back, the alignment written as PSL and
 * turned into a bigPsl custom track, and cmd=alignTrack, which does that and
 * answers with the browser link. */
/* Copyright 2024 The Regents of the University of California. */
#include "common.h"
#include "linefile.h"
#include "hash.h"
#include "cheapcgi.h"
#include "cart.h"
#include "jsonWrite.h"
#include "jsonParse.h"
#include "dystring.h"
#include "errCatch.h"
#include "portable.h"
#include "trashDir.h"
#include "customTrack.h"
#include "pipeline.h"
#include "psl.h"
#include <ctype.h>
#include "hgPangenome.h"

static void pgJobFaPath(char *jobId, char *buf, int bufSize)
/* Where this job's query sequences are kept.  One file per job, named after it
 * rather than by a fresh trash name, so any later request can find it knowing
 * only the job id. */
{
safef(buf, bufSize, "../trash/pangenomeSs/pangenomeJob_%s.fa", jobId);
}

void pgStashQuerySeqs(char *payload, char *response)
/* Write the submitted sequences to a FASTA named after the job.
 *
 * BLAT does the same thing at search time, and for the same reason: the page
 * that draws a result needs the query sequence to colour mismatched bases, and
 * it should not have to carry the sequence through every link to get it.  The
 * results page is reached by an ordinary URL that names only the job, so this
 * is the only copy it can use.
 *
 * Best effort.  A mapping that worked must not be reported as failed because
 * the copy could not be written; the only thing lost is base colouring. */
{
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct jsonElement *resp = jsonParse(response);
    char *jobId = jsonOptionalStringField(resp, "job_id", NULL);
    if (pgValidJobId(jobId))
        {
        char path[PATH_LEN];
        pgJobFaPath(jobId, path, sizeof(path));
        struct jsonElement *root = jsonParse(payload);
        struct jsonElement *seqsEl = jsonFindNamedField(root, "", "sequences");
        if (seqsEl != NULL)
            {
            makeDirsOnPath("../trash/pangenomeSs");
            FILE *f = mustOpen(path, "w");
            struct slRef *ref;
            for (ref = jsonListVal(seqsEl, "sequences"); ref != NULL; ref = ref->next)
                {
                struct jsonElement *el = ref->val;
                char *name = jsonOptionalStringField(el, "name", "query");
                char *seq = jsonOptionalStringField(el, "sequence", NULL);
                if (!isEmpty(seq))
                    fprintf(f, ">%s\n%s\n", name, seq);
                }
            carefulClose(&f);
            chmod(path, 0666);
            }
        }
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    fprintf(stderr, "hgPangenome: could not stash query sequences: %s\n",
            trimSpaces(errCatch->message->string));
errCatchFree(&errCatch);
}

/* ---- The mapped sequence as a track on the target ------------------------
 *
 * hgBlat hands its results to the browser as a bigPsl custom track: the
 * alignments and the query sequence in one bigBed file, drawn with the query
 * bases coloured against the assembly.  Doing the same here means the read is
 * drawn the way a browser user already expects, with the details pages hgc
 * already has for that track type, and nothing of ours in hgTracks or hgc.
 *
 * The alignment goes through a PSL on the way: pgWritePsl() turns the CIGAR
 * into one, and pslToBigPsl and bedToBigBed do the rest (pgBigPslTrack).
 *
 * Note the PSL's tName is the assembly's own sequence name - on a GenArk
 * assembly the accession, not the chrN alias - because that is what its
 * chrom.sizes, which bedToBigBed checks against, is keyed by. */

static boolean pgWritePsl(char *path, boolean append, char *qName, int qSize, char *cigar,
                          char *tName, int tSize, int tStart, char strand,
                          long matches, long mismatches, int *retTEnd, char **retError)
/* One PSL line for the alignment.  M/=/X advance both sides, I the query, D/N
 * the target, and S/H the query without aligning it - the same expansion a
 * CIGAR gets in bamToPsl().  matches and mismatches are the mapping server's
 * counts, or -1.
 *
 * The CIGAR comes from the page, so it is checked here as input: every
 * operation a count and a known letter, and the alignment inside both the
 * query and the target sequence.  FALSE and a reason if not.
 *
 * Expanding the CIGAR is ours; the record itself is kent's.  We fill in a
 * struct psl and let pslTabOut() write it, rather than printing twenty-one
 * tab-separated fields in an order we had to get right by hand. */
{
static char msg[256];
long q = 0, t = tStart, aligned = 0;
int blocks = 0;

if (tStart < 0 || tStart >= tSize)
    {
    safef(msg, sizeof(msg), "the alignment starts outside %.100s", tName);
    *retError = msg;
    return FALSE;
    }

/* A CIGAR cannot have more blocks than it has operations. */
int maxBlocks = 1;
char *c;
for (c = cigar; c != NULL && *c != '\0'; ++c)
    if (!isdigit((unsigned char)*c))
        ++maxBlocks;

unsigned *blockSizes, *qStarts, *tStarts;
AllocArray(blockSizes, maxBlocks);
AllocArray(qStarts, maxBlocks);
AllocArray(tStarts, maxBlocks);

char *bad = NULL;
char *p = cigar;
while (p != NULL && *p != '\0' && bad == NULL)
    {
    /* A count is digits only - strtol() would take a sign - and short enough
     * that it cannot overflow. */
    long n = 0;
    int digits = 0;
    while (isdigit((unsigned char)*p) && digits < 10)
        {
        n = n * 10 + (*p - '0');
        ++p;
        ++digits;
        }
    char op = *p;
    if (digits == 0 || digits >= 10 || op == '\0')
        {
        bad = "the alignment's CIGAR cannot be read";
        break;
        }
    ++p;
    if (op == 'M' || op == '=' || op == 'X')
        {
        if (n > 0)
            {
            /* "10=1X5=" is one block of sixteen, not three that touch. */
            if (blocks > 0 && qStarts[blocks-1] + blockSizes[blocks-1] == q &&
                tStarts[blocks-1] + blockSizes[blocks-1] == t)
                blockSizes[blocks-1] += n;
            else
                {
                blockSizes[blocks] = n;
                qStarts[blocks] = q;
                tStarts[blocks] = t;
                ++blocks;
                }
            }
        aligned += n;
        q += n;
        t += n;
        }
    else if (op == 'I' || op == 'S' || op == 'H')
        q += n;
    else if (op == 'D' || op == 'N')
        t += n;
    else if (op != 'P')
        bad = "the alignment's CIGAR cannot be read";
    if (q > qSize)
        bad = "the alignment is longer than the sequence";
    else if (t > tSize)
        bad = "the alignment runs past the end of its sequence in the assembly";
    }
if (bad == NULL && blocks == 0)
    bad = "the alignment has no aligned blocks to draw";
if (bad != NULL)
    {
    safef(msg, sizeof(msg), "%s", bad);
    *retError = msg;
    freeMem(blockSizes); freeMem(qStarts); freeMem(tStarts);
    return FALSE;
    }

struct psl psl;
ZeroVar(&psl);
/* The mapping server's own counts where it gave them and they add up to the
 * aligned length; otherwise every aligned base is called a match.  Either way
 * the per-base mismatch colouring is done by hgTracks itself, from the FASTA
 * against the assembly; these are the numbers on the details page. */
if (matches >= 0 && mismatches >= 0 && matches + mismatches == aligned)
    {
    psl.match = matches;
    psl.misMatch = mismatches;
    }
else
    psl.match = aligned;
psl.strand[0] = strand;
psl.qName = qName;
psl.qSize = qSize;
/* From the first aligned base to the last: a clipped end is not part of the
 * alignment.  On the reverse strand the CIGAR, and so the block starts, run
 * along the reversed query, as PSL wants them, and only the overall range is
 * turned round - as bamToPsl() does. */
psl.qStart = qStarts[0];
psl.qEnd = qStarts[blocks-1] + blockSizes[blocks-1];
if (strand == '-')
    reverseIntRange(&psl.qStart, &psl.qEnd, qSize);
psl.tName = tName;
psl.tSize = tSize;
psl.tStart = tStarts[0];
psl.tEnd = tStarts[blocks-1] + blockSizes[blocks-1];
psl.blockCount = blocks;
psl.blockSizes = blockSizes;
psl.qStarts = qStarts;
psl.tStarts = tStarts;
pslComputeInsertCounts(&psl);

FILE *f = mustOpen(path, append ? "a" : "w");
pslTabOut(&psl, f);
carefulClose(&f);

if (retTEnd != NULL)
    *retTEnd = psl.tEnd;
freeMem(blockSizes); freeMem(qStarts); freeMem(tStarts);
return TRUE;
}

static long pgCountField(struct jsonElement *obj, char *name)
/* A whole number of bases from a request, or -1 if it is not there. */
{
struct jsonElement *el = jsonFindNamedField(obj, "", name);
if (el == NULL || el->type != jsonNumber || el->val.jeNumber < 0)
    return -1;
return (long)el->val.jeNumber;
}

#define PG_SEQ_TRACK_NAME "PanView Seq"

static char *pgBigPslTrack(char *pslFile, char *faFile, char *chromSizes, char **retError)
/* The alignments as a bigPsl file, the way hgBlat keeps its results (hgc.c
 * makeBigPsl, blatNewResultCt).  Returns the custom track line for hgTracks'
 * hgct_customText, or NULL and a reason.
 *
 * pslToBigPsl puts the query sequence in the file, so the track needs no
 * FASTA beside it and nothing in the cart: it is an ordinary custom track,
 * which a change of assembly does not throw away and a saved session keeps.
 * The track this replaced was the pair hgBlat's classic results use, a PSL
 * and a FASTA named in the cart's "ss", which the browser drops whenever the
 * assembly changes. */
{
static char msg[256];
struct tempName bedTn, bbTn;
trashDirDateFile(&bedTn, "pangenomeSs", "pangenomeSs", ".bigPsl");
trashDirDateFile(&bbTn, "pangenomeSs", "pangenomeSs", ".bb");

/* bedToBigBed wants its input sorted by sequence and start.  pslToBigPsl
 * keeps the order it is given, so sort the PSL: no "sort" between the two. */
struct psl *psl, *pslList = pslLoadAll(pslFile);
slSort(&pslList, pslCmpTarget);
struct tempName sortedTn;
trashDirDateFile(&sortedTn, "pangenomeSs", "pangenomeSs", ".sorted.psl");
FILE *f = mustOpen(sortedTn.forCgi, "w");
for (psl = pslList; psl != NULL; psl = psl->next)
    pslTabOut(psl, f);
carefulClose(&f);

char faArg[PATH_LEN];
safef(faArg, sizeof(faArg), "-fa=%s", faFile);
char *toBed[] = {"loader/pslToBigPsl", sortedTn.forCgi, faArg, bedTn.forCgi, NULL};
struct pipeline *pl = pipelineOpen1(toBed, pipelineWrite | pipelineNoAbort, "/dev/null", NULL, 0);
int status = pipelineClose(&pl);
if (status == 0)
    {
    char *toBb[] = {"loader/bedToBigBed", "-verbose=0", "-extraIndex=name", "-tab",
                    "-as=loader/bigPsl.as", "-type=bed12+13",
                    bedTn.forCgi, chromSizes, bbTn.forCgi, NULL};
    pl = pipelineOpen1(toBb, pipelineWrite | pipelineNoAbort, "/dev/null", NULL, 0);
    status = pipelineClose(&pl);
    }
unlink(sortedTn.forCgi);
unlink(bedTn.forCgi);
if (status != 0 || !fileExists(bbTn.forCgi))
    {
    safef(msg, sizeof(msg), "could not build the sequence track (exit %d)", status);
    *retError = msg;
    return NULL;
    }
/* hgBlat's track line for a nucleotide search, under this tool's name. */
struct dyString *line = dyStringNew(512);
dyStringPrintf(line, "track type=bigPsl name=\"" PG_SEQ_TRACK_NAME "\" "
    "description=\"Your Sequence from PanView\" visibility=pack showAll=on "
    "indelDoubleInsert=on indelQueryInsert=on indelPolyA=on showDiffBasesAllScales=. "
    "baseColorUseSequence=lfExtra baseColorDefault=diffBases "
    "colorByStrand=\"0,0,0 0,0,150\" bigDataUrl=%s", bbTn.forCgi);
return dyStringCannibalize(&line);
}

static boolean pgValidDna(char *seq)
/* The query goes into a FASTA we hand to another CGI, so keep it to bases. */
{
char *p;
if (isEmpty(seq))
    return FALSE;
for (p = seq; *p != '\0'; ++p)
    {
    char c = toupper(*p);
    if (c != 'A' && c != 'C' && c != 'G' && c != 'T' && c != 'N')
        return FALSE;
    }
return TRUE;
}

static char *pgSafeName(char *name)
/* A query name reaches us from the user's own FASTA header, and then goes into
 * three places that care: a FASTA line (a newline would start a second
 * record), a PSL's qName column (a tab would shift every field after it), and
 * hgc's "i=" parameter, which is split on whitespace.  FASTA itself ends a name
 * at the first whitespace, so do the same and drop anything else awkward. */
{
if (isEmpty(name))
    return "query";
char *clean = cloneString(name);
char *p;
for (p = clean; *p != '\0'; ++p)
    {
    if (isspace((unsigned char)*p))
        { *p = '\0'; break; }
    if (!(isalnum((unsigned char)*p) || strchr("_.-#:|+", *p) != NULL))
        *p = '_';
    }
if (strlen(clean) > 255)
    clean[255] = '\0';
return isEmpty(clean) ? "query" : clean;
}

void pgJsonQuerySeqs(struct jsonWrite *jw, char *field, char *jobId)
/* The job's query sequences as [{name, seq}, ...], read back from the copy
 * taken at submit time, for the results page's "Show Query Sequence".  hgBlat
 * puts its queries on its results page the same way.  Nothing is written - not
 * even an empty list - when the job is unknown or its copy has been swept, so
 * the page can tell "no sequence to show" from "an empty one". */
{
if (!pgValidJobId(jobId))
    return;
char path[PATH_LEN];
pgJobFaPath(jobId, path, sizeof(path));
struct lineFile *lf = lineFileMayOpen(path, TRUE);
if (lf == NULL)
    return;
jsonWriteListStart(jw, field);
struct dyString *seq = dyStringNew(1024);
char *name = NULL, *line;
while (TRUE)
    {
    boolean more = lineFileNext(lf, &line, NULL);
    if (!more || line[0] == '>')
        {
        if (name != NULL)
            {
            jsonWriteObjectStart(jw, NULL);
            jsonWriteString(jw, "name", name);
            jsonWriteString(jw, "seq", seq->string);
            jsonWriteObjectEnd(jw);
            freez(&name);
            }
        if (!more)
            break;
        name = cloneString(trimSpaces(line + 1));
        dyStringClear(seq);
        }
    else if (name != NULL)
        dyStringAppend(seq, trimSpaces(line));
    }
jsonWriteListEnd(jw);
dyStringFree(&seq);
lineFileClose(&lf);
}

static char *pgSeqFromJobFa(char *jobId, char *name)
/* The named query sequence from the FASTA stashed when the job was submitted,
 * or NULL.  The results page is reached by a plain URL that carries only the
 * job, so this is how it gets the sequence it never saw. */
{
if (!pgValidJobId(jobId) || isEmpty(name))
    return NULL;
char path[PATH_LEN];
pgJobFaPath(jobId, path, sizeof(path));
char *seq = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct lineFile *lf = lineFileMayOpen(path, TRUE);
    if (lf != NULL)
        {
        struct dyString *dy = dyStringNew(1024);
        boolean want = FALSE;
        char *line;
        while (lineFileNext(lf, &line, NULL))
            {
            if (line[0] == '>')
                {
                if (want)
                    break;
                want = sameString(trimSpaces(line + 1), name);
                }
            else if (want)
                dyStringAppend(dy, trimSpaces(line));
            }
        lineFileClose(&lf);
        if (dy->stringSize > 0)
            seq = cloneString(dy->string);
        dyStringFree(&dy);
        }
    }
errCatchEnd(errCatch);
errCatchFree(&errCatch);
return seq;
}

#define PG_MAX_OTHER_HITS 50    /* more than any install asks the mapper for */

void doAlignTrack()
/* Build the sequence track - the user's sequence aligned to one haplotype, as
 * a bigPsl custom track - and hand back a browser URL that draws it and one
 * for its base-by-base alignment.  Runs with the cart, for the session the
 * links name and the assembly's hub. */
{
char *payload = cgiOptionalString("payload");
if (isEmpty(payload))
    {
    emitJsonError("missing 'payload'");
    return;
    }
char *err = NULL;
struct jsonElement *root = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    root = jsonParse(payload);
errCatchEnd(errCatch);
if (errCatch->gotError || root == NULL)
    {
    errCatchFree(&errCatch);
    emitJsonError("invalid JSON payload");
    return;
    }
errCatchFree(&errCatch);

char *db = jsonOptionalStringField(root, "db", NULL);
char *contig = jsonOptionalStringField(root, "contig", NULL);
char *name = pgSafeName(jsonOptionalStringField(root, "name", "query"));
char *seq = jsonOptionalStringField(root, "sequence", NULL);
/* The results page has only the job id - the sequence itself was left on the
 * search page.  Read it back from the copy taken at submit time. */
if (isEmpty(seq))
    seq = pgSeqFromJobFa(jsonOptionalStringField(root, "job_id", NULL),
                         jsonOptionalStringField(root, "name", NULL));
char *cigar = jsonOptionalStringField(root, "cigar", NULL);
char *strand = jsonOptionalStringField(root, "strand", "+");
/* The results page sets this when the browser is about to open: whatever was
 * lifted onto the last haplotype it opened stays connected in the cart and
 * would show here too, so let it go.  A reference's annotations, if chosen,
 * are attached again by the cmd=refAnnot that follows. */
boolean dropLifts = sameOk(jsonOptionalStringField(root, "dropLifts", "off"), "on");
struct jsonElement *startEl = jsonFindNamedField(root, "", "start");

if (!pgValidDb(db) || isEmpty(contig))
    { emitJsonError("missing or malformed assembly or sequence name"); return; }
if (!pgValidDna(seq))
    { emitJsonError("the query sequence must be A, C, G, T or N"); return; }
if (isEmpty(cigar) || startEl == NULL || startEl->type != jsonNumber)
    { emitJsonError("missing alignment CIGAR or start"); return; }

struct hash *sizes = pgChromSizes(db);
if (sizes == NULL)
    { emitJsonError("no sequence sizes available for %s", db); return; }
int tSize = hashIntValDefault(sizes, contig, 0);
if (tSize == 0)
    { emitJsonError("%s is not a sequence of %s", contig, db); return; }
/* The assembly's own sequence name - the accession on a GenArk assembly.  The
 * chrN alias is only what gets displayed, so the track and the position both
 * use the name we were given. */
char *viewChrom = contig;

struct tempName pslTn, faTn;
trashDirDateFile(&pslTn, "pangenomeSs", "pangenomeSs", ".psl");
trashDirDateFile(&faTn, "pangenomeSs", "pangenomeSs", ".fa");

FILE *fa = mustOpen(faTn.forCgi, "w");
fprintf(fa, ">%s\n%s\n", name, seq);
carefulClose(&fa);

int tStart = (int)startEl->val.jeNumber;
int tEnd = tStart;
if (!pgWritePsl(pslTn.forCgi, FALSE, name, strlen(seq), cigar, viewChrom, tSize,
                tStart, (strand[0] == '-') ? '-' : '+', pgCountField(root, "matches"),
                pgCountField(root, "mismatches"), &tEnd, &err))
    {
    unlink(faTn.forCgi);
    emitJsonError("%s", err);
    return;
    }
/* Every other place the sequence aligned on this haplotype goes in the same
 * track, as hgBlat's results do: the browser opens on the hit that was
 * clicked, and the others are there to be found.  Each is a contig, a start,
 * a strand and a CIGAR, checked as the first one was; one that does not fit
 * this assembly is left out rather than failing the lot. */
struct jsonElement *othersEl = jsonFindNamedField(root, "", "others");
if (othersEl != NULL && othersEl->type == jsonList)
    {
    struct slRef *ref;
    int n = 0;
    for (ref = othersEl->val.jeList; ref != NULL && n < PG_MAX_OTHER_HITS; ref = ref->next)
        {
        struct jsonElement *o = ref->val;
        if (o->type != jsonObject)
            continue;
        char *oContig = jsonOptionalStringField(o, "contig", NULL);
        char *oCigar = jsonOptionalStringField(o, "cigar", NULL);
        char *oStrand = jsonOptionalStringField(o, "strand", "+");
        struct jsonElement *oStart = jsonFindNamedField(o, "", "start");
        int oSize = isEmpty(oContig) ? 0 : hashIntValDefault(sizes, oContig, 0);
        if (oSize == 0 || isEmpty(oCigar) || oStart == NULL || oStart->type != jsonNumber ||
            oStart->val.jeNumber < 0 || oStart->val.jeNumber >= oSize)
            continue;
        char *oErr = NULL;
        if (pgWritePsl(pslTn.forCgi, TRUE, name, strlen(seq), oCigar, oContig, oSize,
                       (int)oStart->val.jeNumber, (oStrand[0] == '-') ? '-' : '+',
                       pgCountField(o, "matches"), pgCountField(o, "mismatches"),
                       NULL, &oErr))
            ++n;
        }
    }

/* Open on the whole alignment, not its first base: a one-base window shows
 * nothing useful.  A little padding either side keeps the read off the edges. */
int pad = (tEnd - tStart) / 10 + 20;
int viewStart = tStart - pad;
int viewEnd = tEnd + pad;
if (viewStart < 0)
    viewStart = 0;
if (viewEnd > tSize)
    viewEnd = tSize;
/* The name the browser resolves the assembly to, which for a GenArk assembly
 * is the decorated hub_<id>_ form. */
char *viewDb = pgAttachAssembly(db);
char pos[512];
safef(pos, sizeof(pos), "%s:%d-%d", viewChrom, viewStart + 1, viewEnd);

char *customText = pgBigPslTrack(pslTn.forCgi, faTn.forCgi, pgChromSizesFile(db, sizes, FALSE), &err);
/* Both are in the bigPsl file now, the sequence included. */
unlink(pslTn.forCgi);
unlink(faTn.forCgi);
if (customText == NULL)
    { emitJsonError("%s", err); return; }
cartSetString(cart, "db", viewDb);
cartSetString(cart, "position", pos);
if (dropLifts)
    pgForgetStaleHubs(NULL, FALSE);

/* Both links hand the browser the track line itself (hgct_customText), which
 * whichever page opens first turns into a custom track of this session, and
 * both name this request's own session.  The page sends no hgsid, so this
 * request began a new one: a second click, or a second tab, has a session of
 * its own and cannot change the assembly or the track under this one. */
char *sid = cartSessionId(cart);
char *ctName = customTrackTableFromLabel(PG_SEQ_TRACK_NAME);
char *ctText = cgiEncode(customText);
/* The track's visibility goes in the link as well.  When a reference's
 * annotations come along the link gains hideTracks=on, and under that the
 * browser shows only the tracks the link itself names. */
struct dyString *url = dyStringNew(900);
dyStringPrintf(url, "hgTracks?hgsid=%s&db=%s&position=%s&hgct_customText=%s&%s=pack",
               sid, cgiEncode(viewDb), cgiEncode(pos), ctText, ctName);
/* The base-by-base alignment, the page a click on the track's item leads to. */
struct dyString *details = dyStringNew(900);
dyStringPrintf(details,
               "hgc?hgsid=%s&db=%s&g=htcBigPslAli&i=%s&c=%s&l=%d&r=%d&o=%d"
               "&aliTable=%s&aliTrack=%s&hgct_customText=%s",
               sid, cgiEncode(viewDb), cgiEncode(name), cgiEncode(viewChrom),
               tStart, tEnd, tStart, ctName, ctName, ctText);
struct dyString *out = dyStringNew(1800);
/* "hgsid" is for the request that follows, cmd=refAnnot, which has to add its
 * hub to this same session. */
dyStringPrintf(out, "{\"status\":\"ok\",\"url\":\"%s\","
                    "\"details\":\"%s\",\"hgsid\":\"%s\"}",
               jsonStringEscape(url->string), jsonStringEscape(details->string), sid);
emitJson(out->string);
dyStringFree(&out);
dyStringFree(&details);
dyStringFree(&url);
}
