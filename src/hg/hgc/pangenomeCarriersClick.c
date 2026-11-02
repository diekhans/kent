/* pangenomeCarriersClick.c - the haplotypes of the pangenome that carry an SV,
 * on its details page.
 *
 * A track of pangenome SVs - the HPRC v2.1 graph's, built from the graph's VCF
 * - knows how many haplotypes carry each SV but not which.  The trackDb setting
 *     pangenomeCarriers <bigBed>
 * names a file that does: makeSvCarriers.py (src/hg/hgPangenome) writes the
 * track's rows again with the graph site each SV is an allele of and two
 * bitmaps over the haplotypes, carriers and no-calls, and beside it a .haps
 * file naming the haplotypes in bit order, each with its HPRC population.
 *
 * The section lists every haplotype by what it has at the SV's site, grouped by
 * population, each a link that opens it there in the browser (hgPangenome's
 * page=svOpen, which translates the site through the graph and brings the
 * reference's tracks), and offers the carriers to PanLift side by side with
 * haplotypes that lack the SV. */

/* Copyright (C) 2026 The Regents of the University of California */

#include "common.h"
#include "hash.h"
#include "linefile.h"
#include "dystring.h"
#include "localmem.h"
#include "cheapcgi.h"
#include "htmshell.h"
#include "obscure.h"
#include "cart.h"
#include "hgConfig.h"
#include "hdb.h"
#include "hui.h"
#include "trackDb.h"
#include "trackHub.h"
#include "hubConnect.h"
#include "bigBed.h"
#include "udc.h"
#include "errCatch.h"
#include "hgc.h"

/* Fields of a carriers row after chrom, start and end, as iv->rest holds them.
 * The first fourteen are the SV track's own. */
enum carrierField { cfName = 0, cfAc = 9, cfSiteStart = 14, cfSiteEnd = 15,
                    cfCarriers = 16, cfMissing = 17, cfCount = 18 };

/* What a haplotype has at the site. */
enum carrierState { csCarrier, csOther, csNone, csNoCall, csStateCount };
static char *stateLabel[csStateCount] = { "Carry this SV", "Another SV at this site",
                                          "No SV here", "Not covered" };
/* The count column of each state's table. */
static char *stateColumn[csStateCount] = { "Carriers", "Another SV", "No SV", "Not covered" };

struct carrierHap
/* One haplotype: its name, its population as the HPRC gives it, its state. */
    {
    char *name;
    char *code;          /* 1000 Genomes code, "" if none */
    char *desc;          /* descriptor, "" if none */
    enum carrierState state;
    };

struct carrierPop
/* One population's haplotypes. */
    {
    struct carrierPop *next;
    char *key, *label;
    int carriers, called;
    struct slRef *haps;              /* carrierHap, in .haps order */
    };

static boolean hexBit(char *hex, int hapCount, int hap)
/* Is haplotype `hap` (the .haps file's hap-th line) set in this bitmap?  The
 * first haplotype is the most significant bit of a number written in
 * ceil(hapCount / 4) hex digits. */
{
int width = strlen(hex);
if (width != (hapCount + 3) / 4)
    return FALSE;
int bit = hapCount - 1 - hap;
char c = hex[width - 1 - bit / 4];
int v = isdigit((unsigned char)c) ? c - '0' : tolower((unsigned char)c) - 'a' + 10;
return (v >> (bit % 4)) & 1;
}

static char **chopRow(struct lm *lm, char *rest)
/* A carriers row's fields after chrom, start and end, or NULL if it is short. */
{
char **row;
lmAllocArray(lm, row, cfCount);
if (rest == NULL || chopByChar(lmCloneString(lm, rest), '\t', row, cfCount) != cfCount)
    return NULL;
return row;
}

static boolean sameItem(char **row, char **item, int itemCount)
/* Is this carriers row the track item whose fields after chrom, start and end
 * are item?  The carriers file repeats the track's fields ahead of its own.
 * All of them, not the name alone: one site can hold several SVs of a name -
 * insertions that round to the same length - told apart by their exact
 * lengths. */
{
if (itemCount != cfSiteStart)
    return FALSE;
int i;
for (i = 0; i < itemCount; i++)
    if (differentString(row[i], item[i]))
        return FALSE;
return TRUE;
}

static struct carrierHap *readHaps(char *path, int *retCount)
/* The .haps file: one haplotype a line, then its population code and
 * descriptor, tab separated. */
{
size_t size = 0;
char *text = udcFileReadAll(path, NULL, 1024 * 1024, &size);
struct lineFile *lf = lineFileOnString(path, TRUE, text);
int count = 0, alloc = 512;
struct carrierHap *haps;
AllocArray(haps, alloc);
char *line;
while (lineFileNextReal(lf, &line))
    {
    char *words[3] = { NULL, "", "" };
    chopByChar(line, '\t', words, ArraySize(words));
    if (count == alloc)
        {
        ExpandArray(haps, alloc, 2 * alloc);
        alloc *= 2;
        }
    haps[count].name = cloneString(trimSpaces(words[0]));
    haps[count].code = cloneString(words[1] ? trimSpaces(words[1]) : "");
    haps[count].desc = cloneString(words[2] ? trimSpaces(words[2]) : "");
    count++;
    }
lineFileClose(&lf);
*retCount = count;
return haps;
}

static int popCmp(const void *va, const void *vb)
/* Most carriers first, by frequency; the references and the haplotypes with no
 * population given last, since a frequency over a handful says little. */
{
const struct carrierPop *a = *((struct carrierPop **)va);
const struct carrierPop *b = *((struct carrierPop **)vb);
boolean sa = a->key[0] == '~', sb = b->key[0] == '~';
if (sa != sb)
    return sa ? 1 : -1;
double fa = a->called ? (double)a->carriers / a->called : 0;
double fb = b->called ? (double)b->carriers / b->called : 0;
if (fa != fb)
    return fa > fb ? -1 : 1;
return strcmp(a->label, b->label);
}

static struct carrierPop *groupByPopulation(struct carrierHap *haps, int hapCount)
/* The haplotypes by population, in the order popCmp gives. */
{
struct hash *hash = hashNew(8);
struct carrierPop *pops = NULL, *pop;
int i;
for (i = 0; i < hapCount; i++)
    {
    struct carrierHap *h = &haps[i];
    char *key, label[256];
    if (!isEmpty(h->code))
        {
        key = h->code;
        safef(label, sizeof(label), "%s (%s)", h->desc, h->code);
        }
    else if (startsWith("GRCh38#", h->name) || startsWith("CHM13#", h->name))
        {
        key = "~ref";
        safef(label, sizeof(label), "References");
        }
    else
        {
        key = "~none";
        safef(label, sizeof(label), "No population given");
        }
    pop = hashFindVal(hash, key);
    if (pop == NULL)
        {
        AllocVar(pop);
        pop->key = cloneString(key);
        pop->label = cloneString(label);
        hashAdd(hash, key, pop);
        slAddHead(&pops, pop);
        }
    refAdd(&pop->haps, h);
    if (h->state == csCarrier)
        pop->carriers++;
    if (h->state != csNoCall)
        pop->called++;
    }
for (pop = pops; pop != NULL; pop = pop->next)
    slReverse(&pop->haps);
slSort(&pops, popCmp);
hashFree(&hash);
return pops;
}

static void printHapLink(struct carrierHap *h, char *db, char *chrom, int start, int end,
                         char *svName)
/* A haplotype's name, linked to opening it at the site. */
{
printf("<a href='../cgi-bin/hgPangenome?page=svOpen&db=%s&chrom=%s&start=%d&end=%d"
       "&hap=%s&sv=%s&%s' title='Open %s at this site'>%s</a> ",
       cgiEncode(db), cgiEncode(chrom), start, end, cgiEncode(h->name),
       cgiEncode(svName), cartSidUrlString(cart), htmlEncode(h->name), htmlEncode(h->name));
}

static void printStateTable(struct carrierPop *pops, enum carrierState state, char *db,
                            char *chrom, int start, int end, char *svName)
/* One table of the haplotypes in this state, a row a population.  Its count is
 * of this state, out of the population's haplotypes with a call - or out of all
 * of them for those not covered, which have none. */
{
printf("<table class='bedExtraTbl'>\n");
printf("<tr><th>Population</th><th style='width:7em'>%s</th>"
       "<th style='width:60%%'>Haplotypes</th></tr>\n", stateColumn[state]);
struct carrierPop *pop;
for (pop = pops; pop != NULL; pop = pop->next)
    {
    struct slRef *ref;
    int n = 0;
    for (ref = pop->haps; ref != NULL; ref = ref->next)
        if (((struct carrierHap *)ref->val)->state == state)
            n++;
    if (n == 0)
        continue;
    printf("<tr><td>%s</td><td>%d / %d</td><td>", htmlEncode(pop->label), n,
           state == csNoCall ? slCount(pop->haps) : pop->called);
    for (ref = pop->haps; ref != NULL; ref = ref->next)
        {
        struct carrierHap *h = ref->val;
        if (h->state == state)
            printHapLink(h, db, chrom, start, end, svName);
        }
    printf("</td></tr>\n");
    }
printf("</table>\n");
}

static char *compareChoice(struct carrierPop *pops)
/* A starting set for PanLift: up to five carriers and four without any SV at
 * the site, a population at a time so one large group does not fill it, and
 * only haplotypes with a population - which leaves out the references, one of
 * them the source, and the assemblies served from hubs.  Comma separated, or
 * NULL if there are no carriers to compare. */
{
struct dyString *dy = dyStringNew(256);
int pass, picked = 0, carriers = 0;
for (pass = 0; pass < 2; pass++)
    {
    enum carrierState state = pass == 0 ? csCarrier : csNone;
    int want = pass == 0 ? 5 : 9 - picked;
    int round, got = 0;
    for (round = 0; got < want; round++)
        {
        boolean any = FALSE;
        struct carrierPop *pop;
        for (pop = pops; pop != NULL && got < want; pop = pop->next)
            {
            if (pop->key[0] == '~')
                continue;
            int seen = 0;
            struct slRef *ref;
            for (ref = pop->haps; ref != NULL; ref = ref->next)
                {
                struct carrierHap *h = ref->val;
                if (h->state != state)
                    continue;
                if (seen++ == round)
                    {
                    dyStringPrintf(dy, "%s%s", picked ? "," : "", h->name);
                    picked++;
                    got++;
                    any = TRUE;
                    break;
                    }
                }
            }
        if (!any)
            break;
        }
    if (pass == 0)
        carriers = picked;
    }
if (carriers == 0)
    return NULL;
return dyStringCannibalize(&dy);
}

void pangenomeCarriersSection(struct trackDb *tdb, char *chrom, int start, int end,
                              char *name, char *rest)
/* If this track names a pangenomeCarriers file, say which haplotypes carry the
 * clicked SV and what the rest have at its site. */
{
char *setting = trackDbSetting(tdb, "pangenomeCarriers");
if (isEmpty(setting))
    return;
char *db = trackHubSkipHubName(database);
char *bbPath = hReplaceGbdb(replaceChars(setting, "$D", db));
/* A hub may only name a file it serves, never one on this machine. */
if (isHubTrack(tdb->track) && !startsWith("http://", bbPath) && !startsWith("https://", bbPath))
    return;
char hapsPath[4096];
safef(hapsPath, sizeof(hapsPath), "%s", bbPath);
if (endsWith(hapsPath, ".bb"))
    hapsPath[strlen(hapsPath) - 3] = '\0';
safecat(hapsPath, sizeof(hapsPath), ".haps");

struct lm *lm = lmInit(0);
char *item[cfCount + 1];
int itemCount = isEmpty(rest) ? 0 : chopByChar(lmCloneString(lm, rest), '\t', item,
                                                ArraySize(item));
char **row = NULL;
struct carrierHap *haps = NULL;
int hapCount = 0;
struct dyString *others = dyStringNew(256);   /* the other SVs at the site */
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct bbiFile *bbi = bigBedFileOpen(bbPath);
    struct bigBedInterval *iv, *list = bigBedIntervalQuery(bbi, chrom, start, end, 0, lm);
    for (iv = list; iv != NULL && row == NULL; iv = iv->next)
        {
        char **r = chopRow(lm, iv->rest);
        if (r != NULL && (int)iv->start == start && (int)iv->end == end &&
            sameItem(r, item, itemCount))
            row = r;
        }
    if (row != NULL)
        {
        haps = readHaps(hapsPath, &hapCount);
        /* The other alleles of the same graph site, which the track lists as
         * items of their own: their carriers have a different SV here. */
        list = bigBedIntervalQuery(bbi, chrom, atoi(row[cfSiteStart]),
                                   atoi(row[cfSiteEnd]) + 1, 0, lm);
        int i;
        for (i = 0; i < hapCount; i++)
            haps[i].state = hexBit(row[cfCarriers], hapCount, i) ? csCarrier :
                            hexBit(row[cfMissing], hapCount, i) ? csNoCall : csNone;
        for (iv = list; iv != NULL; iv = iv->next)
            {
            char **r = chopRow(lm, iv->rest);
            if (r == NULL || differentString(r[cfSiteStart], row[cfSiteStart]) ||
                differentString(r[cfSiteEnd], row[cfSiteEnd]) ||
                ((int)iv->start == start && (int)iv->end == end &&
                 sameItem(r, item, itemCount)))
                continue;
            dyStringPrintf(others, "%s%s", others->stringSize ? ", " : "", r[cfName]);
            for (i = 0; i < hapCount; i++)
                if (haps[i].state == csNone && hexBit(r[cfCarriers], hapCount, i))
                    haps[i].state = csOther;
            }
        }
    bigBedFileClose(&bbi);
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    {
    fprintf(stderr, "hgc pangenomeCarriers %s: %s\n", bbPath,
            trimSpaces(errCatch->message->string));
    printf("<p>The haplotypes carrying this SV could not be read.</p>\n");
    errCatchFree(&errCatch);
    return;
    }
errCatchFree(&errCatch);
if (row == NULL || hapCount == 0)
    {
    /* Built from an older version of the track: say so rather than be silent. */
    printf("<p>This SV is not in the carriers file for this track; it may need "
           "rebuilding with makeSvCarriers.py.</p>\n");
    return;
    }

int count[csStateCount] = { 0 };
int i;
for (i = 0; i < hapCount; i++)
    count[haps[i].state]++;
int called = hapCount - count[csNoCall];
/* What each haplotype is opened over: the site and the SV together, since an
 * insertion can sit just past the end of its site. */
int siteStart = min(atoi(row[cfSiteStart]), start);
int siteEnd = max(atoi(row[cfSiteEnd]), end);
struct carrierPop *pops = groupByPopulation(haps, hapCount);
char *refLabel = sameString(db, "hs1") ? "CHM13" : sameString(db, "hg38") ? "GRCh38" : db;

printf("<h3>Haplotypes with this SV</h3>\n");
printf("<p>Carried by <b>%d</b> of %d haplotypes with a call at this site (%.1f%%); "
       "%d carry another SV here, %d have no SV here and %d %s not covered.</p>\n",
       count[csCarrier], called, called ? 100.0 * count[csCarrier] / called : 0.0,
       count[csOther], count[csNone], count[csNoCall], count[csNoCall] == 1 ? "is" : "are");
char from[32], to[32], len[32];
sprintLongWithCommas(from, siteStart + 1);
sprintLongWithCommas(to, siteEnd);
if (siteEnd - siteStart >= 10000)
    safef(len, sizeof(len), "%.1f kb", (siteEnd - siteStart) / 1000.0);
else
    safef(len, sizeof(len), "%d bp", siteEnd - siteStart);
printf("<p>Graph site: %s:%s-%s (%s) in the HPRC release 2.1 pangenome graph",
       htmlEncode(chrom), from, to, len);
if (others->stringSize > 0)
    printf(", which also holds %s", htmlEncode(others->string));
printf(". The SV can lie anywhere in the site; click a haplotype to open its copy of "
       "the whole site, with the %s tracks you have on carried across.</p>\n", refLabel);

if (count[csCarrier] > 0)
    printStateTable(pops, csCarrier, db, chrom, siteStart, siteEnd, name);

/* Where no one carries it: one line, not a table of empty rows. */
struct dyString *none = dyStringNew(256);
struct carrierPop *pop;
for (pop = pops; pop != NULL; pop = pop->next)
    if (pop->key[0] != '~' && pop->carriers == 0)
        dyStringPrintf(none, "%s%s", none->stringSize ? "; " : "", pop->label);
if (none->stringSize > 0 && count[csCarrier] > 0)
    printf("<p>No carriers among: %s.</p>\n", htmlEncode(none->string));

/* The rest, folded away: most people opening an SV want its carriers. */
enum carrierState state;
for (state = csOther; state < csStateCount; state++)
    {
    if (count[state] == 0)
        continue;
    printf("<details><summary>%s (%d)</summary>\n", stateLabel[state], count[state]);
    printStateTable(pops, state, db, chrom, siteStart, siteEnd, name);
    printf("</details>\n");
    }

char *choice = compareChoice(pops);
if (choice != NULL)
    {
    long flank = atol(cfgOptionDefault("pangenome.svFlank", "1000"));
    char position[256];
    safef(position, sizeof(position), "%s:%ld-%ld", chrom, max(0L, siteStart - flank) + 1,
          siteEnd + flank);
    printf("<p><a href='../cgi-bin/hgPangenome?page=convert&db=%s&position=%s"
           "&pgTarget=%s&%s'>Compare in PanLift</a>: some carriers and some haplotypes "
           "without the SV, side by side (%s).</p>\n",
           cgiEncode(db), cgiEncode(position), cgiEncode(choice), cartSidUrlString(cart),
           htmlEncode(replaceChars(choice, ",", ", ")));
    }
lmCleanup(&lm);
}
