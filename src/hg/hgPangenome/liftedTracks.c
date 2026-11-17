/* liftedTracks - one assembly's annotations drawn on another, through the
 * browser's own QuickLift: the chain built from the graph's blocks, the hub
 * that wraps the source's tracks, and the commands that ask for it
 * (quickLift, extendChain, refAnnot), plus cmd=contigs, an assembly's
 * sequences under both their names. */
/* Copyright 2024 The Regents of the University of California. */
#include "common.h"
#include "linefile.h"
#include "hash.h"
#include "cheapcgi.h"
#include "cart.h"
#include "jsonParse.h"
#include "dystring.h"
#include "errCatch.h"
#include "portable.h"
#include "net.h"
#include "jksql.h"
#include <fcntl.h>
#include "trashDir.h"
#include "pipeline.h"
#include "hdb.h"
#include "trackHub.h"
#include "hubConnect.h"
#include "genark.h"
#include "chromAlias.h"
#include "twoBit.h"
#include "chain.h"
#include "bigChain.h"
#include "bigLink.h"
#include <ctype.h>
#include "hgPangenome.h"

/* ---- QuickLift: show the source's annotations on the target ----------------
 *
 * The browser already knows how to draw one assembly's annotations on another:
 * QuickLift.  It runs off two trackDb settings - quickLiftUrl (a bigChain
 * file) and quickLiftDb (the assembly the data comes from).  The central
 * quickLiftChain table is only consulted by hgConvert; the renderers never
 * look at it.  So writing a chain is enough to get the whole feature: the
 * source's tracks in the green "QuickLift from ..." group, and the Alignment
 * Differences track marking insertions, deletions and mismatches in whatever
 * colours this install configures.
 *
 * That matters here because QuickLift is chain-backed, and chains between two
 * HPRC samples essentially do not exist - which is exactly the gap the graph
 * fills.  The mapping server's "blocks" mode reports runs of 1:1
 * correspondence, and the gap between two blocks is precisely a chain's dt/dq,
 * so quickLift ends up classifying them the same way it would a real
 * alignment.
 *
 * Two things are load-bearing:
 *
 *  - Chain format needs both sides to advance monotonically within one chain,
 *    and graph coordinates do not.  A duplication, a transposition, or a
 *    source interval spanning several graph fragments can put a later source
 *    block at an earlier target position.  So a new chain is started wherever
 *    colinearity breaks; the ordering guaranteed by the server is only
 *    (contig, source_start).
 *  - On a '-' chain the query side is in reverse-complement coordinates
 *    (qSize - forwardEnd).  The server always reports forward coordinates with
 *    start < end, so we convert while parsing and order in chain space after.
 */

struct pgBlock
/* One block of source<->target correspondence, already in chain coordinates:
 * t is the target (the assembly being browsed), q the source. */
    {
    struct pgBlock *next;
    char *contig;               /* target contig */
    long tStart, tEnd;
    long qStart, qEnd;
    char strand;
    };

/* The autoSql definitions bedToBigBed validates against.  Inline so this CGI
 * needs nothing installed beside it; loader/bedToBigBed is already there for
 * custom tracks. */
static char *bigChainAsText =
"table bigChain\n"
"\"bigChain pairwise alignment\"\n"
"    (\n"
"    string chrom;       \"Reference sequence chromosome or scaffold\"\n"
"    uint   chromStart;  \"Start position in chromosome\"\n"
"    uint   chromEnd;    \"End position in chromosome\"\n"
"    string name;        \"Name or ID of item, ideally both human readable and unique\"\n"
"    uint score;         \"Score (0-1000)\"\n"
"    char[1] strand;     \"+ or - for strand\"\n"
"    uint tSize;         \"size of target sequence\"\n"
"    string qName;       \"name of query sequence\"\n"
"    uint qSize;         \"size of query sequence\"\n"
"    uint qStart;        \"start of alignment on query sequence\"\n"
"    uint qEnd;          \"end of alignment on query sequence\"\n"
"    double chainScore;    \"score from chain\"\n"
"    )\n";

static char *bigLinkAsText =
"table bigLink\n"
"\"bigLink pairwise alignment\"\n"
"    (\n"
"    string chrom;       \"Reference sequence chromosome or scaffold\"\n"
"    uint   chromStart;  \"Start position in chromosome\"\n"
"    uint   chromEnd;    \"End position in chromosome\"\n"
"    string name;        \"Name or ID of item, ideally both human readable and unique\"\n"
"    uint qStart;        \"start of alignment on query sequence\"\n"
"    )\n";

static void pgWriteTextFile(char *path, char *text)
/* Drop a string into a file. */
{
FILE *f = mustOpen(path, "w");
mustWrite(f, text, strlen(text));
carefulClose(&f);
}

static char *pgAssemblyFile(char *db, char *suffix)
/* Path to one of an assembly's files, e.g. ".2bit" or ".chrom.sizes.txt".
 * NULL if it is not there.
 *
 * Deliberately not hNibForChrom(): for a GenArk assembly that resolves through
 * the hubs loaded in this process, and aborts outright when none are - which
 * is exactly our situation, since neither assembly here is the one the cart is
 * pointed at.  genArkPath gives the same layout without that dependency. */
{
char path[PATH_LEN];
char *arkPath = genArkPath(db);
if (arkPath != NULL)
    safef(path, sizeof(path), "/gbdb/genark/%s/%s/%s%s", arkPath, db, db, suffix);
else
    safef(path, sizeof(path), "/gbdb/%s/%s%s", db, db, suffix);
return fileExists(path) ? cloneString(path) : NULL;
}

static char *pgChromSizesPath(char *db)
/* Where this assembly's chrom.sizes lives. */
{
return pgAssemblyFile(db, ".chrom.sizes.txt");
}

struct hash *pgChromSizes(char *db)
/* name -> size for an assembly, NULL if we cannot work it out.
 *
 * A GenArk assembly ships a chrom.sizes file; otherwise read the sizes out of
 * the 2bit.  Deliberately not chromInfo: assemblies served from a curated hub
 * (hs1 among them) have no such table, and the 2bit is the one thing every
 * assembly has, whether it is native, curated or GenArk. */
{
char *path = pgChromSizesPath(db);
if (path != NULL)
    {
    struct hash *hash = hChromSizeHashFromFile(path);
    freez(&path);
    return hash;
    }
char *twoBitPath = pgAssemblyFile(db, ".2bit");
if (twoBitPath == NULL)
    return NULL;
struct hash *hash = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct twoBitFile *tbf = twoBitOpen(twoBitPath);
    hash = hashNew(12);
    struct twoBitIndex *ix;
    for (ix = tbf->indexList; ix != NULL; ix = ix->next)
        hashAddInt(hash, ix->name, twoBitSeqSize(tbf, ix->name));
    twoBitClose(&tbf);
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    {
    fprintf(stderr, "hgPangenome: could not read sizes from %s: %s\n",
            twoBitPath, trimSpaces(errCatch->message->string));
    hash = NULL;
    }
errCatchFree(&errCatch);
freez(&twoBitPath);
return hash;
}

char *pgChromSizesFile(char *db, struct hash *sizes, boolean renamed)
/* bedToBigBed wants a chrom.sizes file.  Use the assembly's own where there is
 * one, but not once we have renamed the sequences to their display names - the
 * shipped file is keyed by accession and bedToBigBed would reject every row. */
{
char *path = renamed ? NULL : pgChromSizesPath(db);
if (path != NULL)
    return path;
struct tempName tn;
trashDirDateFile(&tn, "pangenomeQuickLift", "chromSizes", ".txt");
FILE *f = mustOpen(tn.forCgi, "w");
struct hashEl *el, *list = hashElListHash(sizes);
for (el = list; el != NULL; el = el->next)
    fprintf(f, "%s\t%d\n", el->name, (int)(long)el->val);
carefulClose(&f);
hashElFreeList(&list);
return cloneString(tn.forCgi);
}

static char *pgContigOf(char *panSn)
/* "HG00235#2#CM094399.1" -> "CM094399.1", NULL if not a full contig path.
 * A 4th "#offset" field, where the graph adds one, is not part of the name. */
{
char *first = strchr(panSn, '#');
if (first == NULL)
    return NULL;
char *second = strchr(first + 1, '#');
if (second == NULL)
    return NULL;
char *contig = cloneString(second + 1);
char *third = strchr(contig, '#');
if (third != NULL)
    *third = '\0';
return contig;
}

static int pgBlockCmp(const void *va, const void *vb)
/* Order blocks the way a chain needs them: contig, then strand (a flip starts
 * a new chain anyway), then target position. */
{
const struct pgBlock *a = *((struct pgBlock **)va);
const struct pgBlock *b = *((struct pgBlock **)vb);
int diff = strcmp(a->contig, b->contig);
if (diff != 0)
    return diff;
diff = (int)a->strand - (int)b->strand;
if (diff != 0)
    return diff;
if (a->tStart != b->tStart)
    return (a->tStart < b->tStart) ? -1 : 1;
return 0;
}

static struct pgBlock *pgParseBlocks(struct jsonElement *root, long qSize,
                                     char **retError)
/* Turn the middleware's "blocks" array into chain-space blocks. */
{
/* A chain is built in memory, one node per block, so an unbounded array is an
 * unbounded allocation.  The cap is far above anything a legal request
 * produces (a 10 Mb span runs ~2,500 blocks) and exists only to stop a
 * hand-made payload. */
long maxBlocks = PG_MAX_BLOCKS;
long blockCount = 0;

struct jsonElement *blocksEl = jsonFindNamedField(root, "", "blocks");
if (blocksEl == NULL || blocksEl->type != jsonList)
    {
    *retError = "no 'blocks' array in the request";
    return NULL;
    }
struct pgBlock *list = NULL;
struct slRef *ref;
for (ref = jsonListVal(blocksEl, "blocks"); ref != NULL; ref = ref->next)
    {
    struct jsonElement *el = ref->val;
    char *hap = jsonOptionalStringField(el, "haplotype", NULL);
    struct jsonElement *ss = jsonFindNamedField(el, "", "source_start");
    struct jsonElement *se = jsonFindNamedField(el, "", "source_end");
    struct jsonElement *ts = jsonFindNamedField(el, "", "target_start");
    struct jsonElement *te = jsonFindNamedField(el, "", "target_end");
    char *strand = jsonOptionalStringField(el, "strand", "+");
    if (isEmpty(hap) || ss == NULL || se == NULL || ts == NULL || te == NULL ||
        ss->type != jsonNumber || se->type != jsonNumber ||
        ts->type != jsonNumber || te->type != jsonNumber)
        {
        *retError = "a block is missing its haplotype or coordinates";
        return NULL;
        }
    char *contig = pgContigOf(hap);
    if (contig == NULL)
        {
        *retError = "a block's haplotype is not a full contig path";
        return NULL;
        }
    long sStart = ss->val.jeNumber, sEnd = se->val.jeNumber;
    struct pgBlock *b;
    AllocVar(b);
    b->contig = contig;
    b->tStart = ts->val.jeNumber;
    b->tEnd = te->val.jeNumber;
    b->strand = (strand[0] == '-') ? '-' : '+';
    if (b->strand == '-')       /* chain query side is reverse-complemented */
        {
        b->qStart = qSize - sEnd;
        b->qEnd = qSize - sStart;
        }
    else
        {
        b->qStart = sStart;
        b->qEnd = sEnd;
        }
    if (b->tEnd <= b->tStart || b->qEnd <= b->qStart || b->qStart < 0)
        {
        *retError = "a block has an empty or out-of-range coordinate span";
        return NULL;
        }
    if (++blockCount > maxBlocks)
        {
        *retError = "too many blocks in this translation";
        return NULL;
        }
    slAddHead(&list, b);
    }
if (list == NULL)
    {
    *retError = "the mapping server returned no blocks for this target";
    return NULL;
    }
slSort(&list, pgBlockCmp);
return list;
}

static boolean pgExtendsChain(struct pgBlock *prev, struct pgBlock *b)
/* Can this block continue the chain the previous one is in?  Both sides have
 * to keep moving forward on the same contig in the same orientation - anything
 * else is a rearrangement, which one chain cannot express. */
{
if (prev == NULL)
    return FALSE;
if (!sameString(prev->contig, b->contig) || prev->strand != b->strand)
    return FALSE;
return (b->tStart >= prev->tEnd) && (b->qStart >= prev->qEnd);
}

static boolean pgUseDisplayNames(char *db, struct pgBlock *blocks,
                                 struct hash **pSizes)
/* Rewrite the target side of the chain to the sequence names the browser
 * actually addresses this assembly by.
 *
 * An assembly with "chromAuthority ucsc" is browsed as chr1, chr2, ... even
 * though its sequences are named by accession, and hgTracks queries the chain
 * with the name it is displaying.  A chain written with accessions answers
 * nothing and the track draws blank, so translate once, here, and build the
 * chrom.sizes bedToBigBed sees to match.  Returns TRUE if anything was
 * renamed. */
{
if (!trackHubDatabase(db))
    return FALSE;
chromAliasSetup(db);
struct hash *renames = hashNew(8);      /* accession -> display name */
struct pgBlock *b;
boolean any = FALSE;
for (b = blocks; b != NULL; b = b->next)
    {
    char *display = hashFindVal(renames, b->contig);
    if (display == NULL)
        {
        display = chromAliasGetDisplayChrom(db, cart, b->contig);
        if (isEmpty(display))
            display = b->contig;
        hashAdd(renames, b->contig, display);
        }
    if (differentString(display, b->contig))
        {
        /* Carry the size across under the new name before the old one goes. */
        int size = hashIntValDefault(*pSizes, b->contig, 0);
        if (size > 0 && hashLookup(*pSizes, display) == NULL)
            hashAddInt(*pSizes, display, size);
        b->contig = cloneString(display);
        any = TRUE;
        }
    }
hashFree(&renames);
return any;
}

static boolean pgWriteChainBeds(struct pgBlock *blocks, char *qName, long qSize,
                                struct hash *tSizes, char *chainBed, char *linkBed,
                                char **retError)
/* Write the two BED files bedToBigBed turns into the bigChain pair.
 *
 * Our job is only to decide where one chain ends and the next begins: the graph
 * gives runs of correspondence that are not colinear, and chain format needs
 * both sides to advance monotonically within a chain.  Turning the resulting
 * chains into bigChain/bigLink rows is kent's, via chainToBigChainList() - it
 * does the field mapping and sorts both lists by target position, which is what
 * bedToBigBed needs.  We used to hand-format those twelve and five columns, and
 * a copy of a format nobody told us had changed is exactly the kind of thing
 * that rots quietly. */
{
struct chain *chainList = NULL;
int chainId = 0;
long blockCount = 0;
struct pgBlock *b = blocks;
while (b != NULL)
    {
    /* Longest colinear run starting here. */
    struct pgBlock *runStart = b, *prev = b, *next = b->next;
    while (next != NULL && pgExtendsChain(prev, next))
        {
        prev = next;
        next = next->next;
        }
    struct pgBlock *runEnd = prev;              /* inclusive */

    long tSize = hashIntValDefault(tSizes, runStart->contig, 0);
    if (tSize == 0)
        {
        b = next;                               /* not a sequence we can draw on */
        continue;
        }

    struct chain *chain;
    AllocVar(chain);
    chain->id = ++chainId;
    chain->tName = cloneString(runStart->contig);
    chain->tSize = tSize;
    chain->tStart = runStart->tStart;
    chain->tEnd = runEnd->tEnd;
    chain->qName = cloneString(qName);
    chain->qSize = qSize;
    chain->qStrand = runStart->strand;
    chain->qStart = runStart->qStart;
    chain->qEnd = runEnd->qEnd;

    /* One block per aligned run; the score is the aligned base count, which is
     * what chainRecToBigChain() copies into the bigChain chainScore column. */
    struct cBlock *blockTail = NULL;
    long aligned = 0;
    struct pgBlock *p;
    for (p = runStart; ; p = p->next)
        {
        aligned += p->tEnd - p->tStart;
        /* Blocks that touch on both sides are one block.  The server can hand
         * back a run of one-base blocks like that (16,674 of them beside one
         * large insertion), and QuickLift reads the gap between two links as a
         * deletion and fetches its zero bases, which the browser reports as an
         * error. */
        if (blockTail != NULL && p->tStart == blockTail->tEnd && p->qStart == blockTail->qEnd)
            {
            blockTail->tEnd = p->tEnd;
            blockTail->qEnd = p->qEnd;
            if (p == runEnd)
                break;
            continue;
            }
        struct cBlock *cb;
        AllocVar(cb);
        cb->tStart = p->tStart;
        cb->tEnd = p->tEnd;
        cb->qStart = p->qStart;
        cb->qEnd = p->qEnd;
        /* Append rather than prepend: chain blocks are in target order. */
        if (blockTail == NULL)
            chain->blockList = cb;
        else
            blockTail->next = cb;
        blockTail = cb;
        ++blockCount;
        if (p == runEnd)
            break;
        }
    chain->score = aligned;
    slAddHead(&chainList, chain);
    b = next;
    }
if (blockCount == 0)
    {
    *retError = "none of the translated blocks land on a sequence of the target assembly";
    return FALSE;
    }

struct bigChain *bigChains = NULL;
struct bigLink *bigLinks = NULL;
chainToBigChainList(chainList, &bigChains, &bigLinks);

FILE *f = mustOpen(chainBed, "w");
struct bigChain *bc;
for (bc = bigChains; bc != NULL; bc = bc->next)
    bigChainTabOut(bc, f);
carefulClose(&f);

f = mustOpen(linkBed, "w");
struct bigLink *bl;
for (bl = bigLinks; bl != NULL; bl = bl->next)
    bigLinkTabOut(bl, f);
carefulClose(&f);
return TRUE;
}

static boolean pgRunBedToBigBed(char *type, char *asFile, char *bedFile,
                                char *chromSizes, char *outFile, char **retError)
/* Run loader/bedToBigBed, the way customFactory.c runs its loaders. */
{
static char msg[512];
char typeArg[64], asArg[PATH_LEN];
safef(typeArg, sizeof(typeArg), "-type=%s", type);
safef(asArg, sizeof(asArg), "-as=%s", asFile);
char *cmd[] = {"loader/bedToBigBed", typeArg, asArg, "-tab",
               bedFile, chromSizes, outFile, NULL};
struct pipeline *pl = pipelineOpen1(cmd, pipelineWrite | pipelineNoAbort,
                                    "/dev/null", NULL, 0);
int status = pipelineClose(&pl);
if (status != 0 || !fileExists(outFile))
    {
    safef(msg, sizeof(msg),
          "could not index the chain for the browser (bedToBigBed exit %d)", status);
    *retError = msg;
    return FALSE;
    }
return TRUE;
}





static boolean pgIsOurHubFile(char *path)
/* TRUE if path is a hub file pgHubName() made: in the trash directory, under
 * pangenomeQuickLift, named hub*.txt.
 *
 * The name comes back out of the cart, and a cart value is not ours - it can
 * be set from a URL or arrive in a loaded session - and the file it names is
 * written over.  So nothing but our own file is taken from it. */
{
if (isEmpty(path) || !isTrashPath(path) || strstr(path, "/pangenomeQuickLift/") == NULL)
    return FALSE;
char *base = strrchr(path, '/') + 1;
return startsWith("hub", base) && endsWith(base, ".txt");
}

static char *pgHubName(char *srcDb, char *tgtDb)
/* Path of the hub file for this source/target pair, reused across conversions.
 *
 * Not a fresh trash name each time: every distinct path becomes its own row in
 * hubStatus and its own hgHubConnect.hub.<id> cart variable, and nothing ever
 * takes those away.  Trash is swept about an hour after last use, so a new file
 * per conversion leaves the user's cart filling up with hubs whose files are
 * gone - each one drawn as a red "Couldn't open ..." group on every page from
 * then on.  Reusing one name per pair keeps it to a single, self-repairing
 * entry.  This is what trackHub.c's getHubName() does for hgConvert. */
{
char var[512];
safef(var, sizeof(var), "pangenomeQuickLift-%s-%s", srcDb, tgtDb);
char *name = cartOptionalString(cart, var);
/* Only a file of ours.  That also leaves a saved session's copy alone: it is
 * under the session-data directory, not in trash. */
if (name != NULL && !pgIsOurHubFile(name))
    name = NULL;
if (name != NULL)
    {
    /* Swept away, or from a day directory that is itself gone. */
    int fd = open(name, O_RDONLY);
    if (fd < 0)
        name = NULL;
    else
        close(fd);
    }
if (name == NULL)
    {
    struct tempName tn;
    trashDirDateFile(&tn, "pangenomeQuickLift", "hub", ".txt");
    name = cloneString(tn.forCgi);
    cartSetString(cart, var, name);
    }
return name;
}

void pgForgetStaleHubs(char *keepHubFile, boolean missingOnly)
/* Disconnect pangenome quickLift hubs this cart is still holding.
 *
 * Two callers, two meanings.  Building a new lift passes the hub it is about to
 * use and missingOnly=FALSE: everything else goes, which is how a cart built
 * before the name was reused stops carrying a dozen of them.  A page load
 * passes missingOnly=TRUE, which drops only hubs whose file is gone - trash is
 * swept in about an hour, and the cart entry outlives it, so hgTracks goes on
 * trying to open a dead path and draws a red "Couldn't open ..." group on every
 * page until something takes the entry away.  Nothing did, because this only
 * ran when a new lift was built - the one moment a user is not looking at the
 * error. */
{
struct sqlConnection *conn = hConnectCentral();
struct slPair *var, *vars = cartVarsWithPrefix(cart, hgHubConnectHubVarPrefix);
for (var = vars; var != NULL; var = var->next)
    {
    unsigned id = sqlUnsigned(var->name + strlen(hgHubConnectHubVarPrefix));
    char query[512];
    sqlSafef(query, sizeof(query), "select hubUrl from hubStatus where id='%u'", id);
    char *url = sqlQuickString(conn, query);
    if (url == NULL)
        continue;
    boolean gone = FALSE;
    if (missingOnly)
        {
        int fd = open(url, O_RDONLY);
        if (fd < 0)
            gone = TRUE;
        else
            close(fd);
        }
    if (strstr(url, "/pangenomeQuickLift/") != NULL &&
        (missingOnly ? gone : !sameOk(url, keepHubFile)))
        {
        char prefix[256];
        cartRemove(cart, var->name);
        safef(prefix, sizeof(prefix), "hub_%u_", id);
        cartRemovePrefix(cart, prefix);
        }
    freez(&url);
    }
slPairFreeList(&vars);
hDisconnectCentral(&conn);
}






static void pgNote(struct dyString *into, struct trackDb *tdb)
/* Add a track's label to one of the lists we report back. */
{
if (into == NULL)
    return;
if (into->stringSize > 0)
    dyStringAppend(into, ", ");
dyStringAppend(into, isEmpty(tdb->shortLabel) ? tdb->track : tdb->shortLabel);
}


static void pgNoteLabel(struct dyString *into, char *label)
/* Add one label to a list we report back. */
{
if (into == NULL || isEmpty(label))
    return;
if (into->stringSize > 0)
    dyStringAppend(into, ", ");
dyStringAppend(into, label);
}

static void pgCloseStanza(FILE *f, char *chainRel, char *srcDb)
/* Finish a track stanza with the settings that say this track is being lifted.
 * "quickLifted" also relaxes the hub reader's type check, which is what lets a
 * plain genePred through. */
{
fprintf(f, "quickLifted on\n");
fprintf(f, "avoidHandler on\n");
fprintf(f, "quickLiftUrl %s\n", chainRel);
fprintf(f, "quickLiftDb %s\n", srcDb);
}

static void pgCopySetting(struct dyString *stanza, char *line)
/* Add one setting from trackHubBuild's file to a stanza.  A file setting that
 * names a local path relative to this CGI - a custom track's
 * "bigDataUrl ../trash/hgBlat/..." - is made absolute on the way: the hub
 * reader resolves relative paths against the hub's own directory, so left as
 * it is the browser looks for the file under trash/pangenomeQuickLift and says
 * it cannot open it. */
{
char *value = skipToSpaces(line);
if (value != NULL)
    {
    int nameLen = value - line;
    value = skipLeadingSpaces(value);
    char name[128];
    safencpy(name, sizeof(name), line, min(nameLen, (int)sizeof(name) - 1));
    if ((endsWith(name, "Url") || endsWith(name, "File") || endsWith(name, "Index")) &&
        !isEmpty(value) && value[0] != '/' && !hasProtocol(value))
        {
        dyStringPrintf(stanza, "%s %s/%s\n", name, getCurrentDir(), value);
        return;
        }
    }
dyStringPrintf(stanza, "%s\n", line);
}

static char *pgBuildSourceHub(char *db, struct trackDb **retBadList)
/* Have trackHubBuild() write the stanzas for what db is showing now, into a
 * file of our own, and return its name; NULL if it could not.  The caller
 * removes the file once it has read it.
 *
 * trackHubBuild writes to the file the cart names in hubQuickLift-<db>, which
 * is the hub hgConvert's quickLift has attached to this user's browser.  It
 * also merges: a stanza already in the file stays.  Both are right for
 * hgConvert and wrong for us.  PanLift wants only what is showing now, and
 * has no business changing a hub that another tool attached - least of all
 * emptying it first, which is what this code used to do.  So the cart
 * variable is taken away for the length of the call, which makes trackHubBuild
 * start a new file, and is put back afterwards exactly as it was. */
{
char var[PATH_LEN];
safef(var, sizeof(var), "hubQuickLift-%s", db);
char *theirs = cloneString(cartOptionalString(cart, var));
cartRemove(cart, var);

char *built = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    built = trackHubBuild(db, cart, retBadList);
errCatchEnd(errCatch);
if (errCatch->gotError || isEmpty(built))
    {
    fprintf(stderr, "hgPangenome: trackHubBuild(%s) failed: %s\n", db,
            errCatch->gotError ? trimSpaces(errCatch->message->string) : "no hub written");
    built = NULL;
    }
errCatchFree(&errCatch);

if (theirs != NULL)
    cartSetString(cart, var, theirs);
else
    cartRemove(cart, var);
return built;
}

static char *pgNameFromHub(char *hubPath, char *file)
/* How a hub at hubPath has to name file in a setting ending in "Url", which is
 * resolved against the hub's own directory when the hub is read.
 *
 * The two are usually in one directory, and then it is the base name.  But the
 * hub file is kept from one conversion to the next (pgHubName) and trash is
 * filed by day, so a hub made yesterday gets today's chain, which is in the
 * directory beside its own: "../<day>/<name>".  Named by base name alone, as
 * it used to be, that chain was looked for in yesterday's directory, and the
 * lifted tracks stopped drawing after midnight. */
{
char hubDir[PATH_LEN], fileDir[PATH_LEN], name[FILENAME_LEN], ext[FILEEXT_LEN];
splitPath(hubPath, hubDir, NULL, NULL);
splitPath(file, fileDir, name, ext);
char rel[PATH_LEN];
if (sameString(hubDir, fileDir))
    safef(rel, sizeof(rel), "%s%s", name, ext);
else
    {
    /* fileDir ends in "/"; its last component is the day */
    char dir[PATH_LEN];
    safef(dir, sizeof(dir), "%s", fileDir);
    int len = strlen(dir);
    if (len > 0 && dir[len-1] == '/')
        dir[len-1] = '\0';
    char *day = strrchr(dir, '/');
    day = (day == NULL) ? dir : day + 1;
    safef(rel, sizeof(rel), "../%s/%s%s", day, name, ext);
    }
return cloneString(rel);
}

static char *pgWriteQuickLiftHub(char *srcDb, char *srcHap, char *tgtDb, char *chainBb,
                                 struct dyString *shown, struct dyString *skipped)
/* Write a hub that offers the source's annotations to the destination assembly,
 * and return its path.
 *
 * Which tracks come across, and what each stanza says, is trackHubBuild()'s
 * answer rather than ours.  That is the same function quickLift calls from
 * hgConvert, so whatever the browser decides to carry, we carry, and a change
 * to how it decides reaches these tools without anyone editing this file.  We
 * used to work it out ourselves, in about four hundred lines, and every one of
 * the four bugs that came out of that was a rule about track visibility the
 * browser already knew.
 *
 * What is left here is the one part trackHubBuild cannot do for us.  hgConvert
 * registers its chain in hgcentral and lets hubConnect rename the hub's genome
 * and stamp quickLiftUrl/quickLiftDb onto each stanza when the hub is attached.
 * A chain built for a single request cannot be registered that way, so we take
 * the file trackHubBuild wrote, name the destination genome ourselves, and put
 * those settings into each stanza as we copy it.  What hgTracks ends up with is
 * the same either way.
 *
 * The cart's "db" must already be the source assembly. */
{
struct trackDb *badList = NULL;
char *built = pgBuildSourceHub(srcDb, &badList);
if (built == NULL)
    return NULL;

/* The tracks the browser refused, in its own words, so a track the user can
 * see on the source and cannot find afterwards still gets an explanation. */
struct trackDb *bad;
for (bad = badList; bad != NULL; bad = bad->next)
    pgNote(skipped, bad);

char *hubPath = pgHubName(trackHubSkipHubName(srcDb), tgtDb);
/* Write to one side and rename into place.  The wider chain is fetched while
 * the browser is already showing this hub, so hgTracks can be reading the file
 * at the moment we rewrite it; rename(2) swaps it in one step, where writing
 * over it in place would let a request see half a hub. */
char hubTmp[PATH_LEN];
safef(hubTmp, sizeof(hubTmp), "%s.tmp", hubPath);
FILE *f = mustOpen(hubTmp, "w");
chmod(hubTmp, 0666);

/* Name the chain relative to the hub.  Every setting whose name ends in "Url"
 * is resolved against the hub's own location when the hub is read, so handing
 * over the path we opened it by would resolve a second time and look for it
 * underneath itself. */
char *chainRel = pgNameFromHub(hubPath, chainBb);

/* The label is what the user reads.  Name the haplotype they converted from -
 * that is how they think of the source - rather than the accession, let alone
 * the hub_<id>_ form the browser knows an attached GenArk hub by. */
char *srcLabel = isEmpty(srcHap) ? trackHubSkipHubName(srcDb) : srcHap;
/* Not "QuickLift from ...": the mechanism is quickLift's, but the user asked
 * for a coordinate translation, and that is what the group should say.  The
 * browser only keeps a group label verbatim when it begins "Quick"
 * (grpFromHub), so this one arrives prefixed "Hub: " - plainer than borrowing
 * another tool's name for it. */
fprintf(f, "hub pangenomeLift%s\n", srcLabel);
fprintf(f, "shortLabel Annotations from %s\n", srcLabel);
fprintf(f, "longLabel Annotations translated from %s through the pangenome\n",
        srcLabel);
fprintf(f, "useOneFile on\n");
fprintf(f, "email genome-www@soe.ucsc.edu\n\n");
/* The destination, where trackHubBuild named the source: its caller renames
 * the genome at attach time and we have no attach-time hook to do it in. */
fprintf(f, "genome %s\n", tgtDb);

/* Copy the stanzas across.  A hub stanza runs from its "track" line to the
 * next blank line.  Each is held until its end so we can see the whole of it
 * before writing: whether it is a top-level track decides if the user is told
 * about it, and that is settled by a "parent" line which may come anywhere. */
struct lineFile *lf = lineFileOpen(built, TRUE);
struct dyString *stanza = dyStringNew(512);
char label[256];
boolean inTrack = FALSE, isChild = FALSE;
char *line;
label[0] = '\0';
while (lineFileNext(lf, &line, NULL))
    {
    char *trimmed = skipLeadingSpaces(line);
    boolean starts = startsWith("track ", trimmed);
    if (starts || (inTrack && isEmpty(trimmed)))
        {
        if (inTrack)
            {
            fprintf(f, "\n%s", stanza->string);
            pgCloseStanza(f, chainRel, srcDb);
            /* Subtracks are the parts of a track, not tracks the user chose;
             * naming every one of them turns the report into a wall of text. */
            if (!isChild)
                pgNoteLabel(shown, label);
            }
        dyStringClear(stanza);
        label[0] = '\0';
        isChild = FALSE;
        inTrack = starts;
        if (starts)
            dyStringPrintf(stanza, "%s\n", trimmed);
        continue;
        }
    if (!inTrack)
        continue;                       /* trackHubBuild's own header and genome */
    /* Every hub track is put in one group by trackHubAddGroupName anyway, so
     * the source's group would only be noise. */
    if (startsWith("group ", trimmed))
        continue;
    if (startsWith("parent ", trimmed) || startsWith("subTrack ", trimmed))
        isChild = TRUE;
    if (startsWith("shortLabel ", trimmed))
        /* A custom track's label is the user's own text, of any length. */
        safef(label, sizeof(label), "%.200s",
              skipLeadingSpaces(trimmed + strlen("shortLabel")));
    pgCopySetting(stanza, trimmed);
    }
if (inTrack)
    {
    fprintf(f, "\n%s", stanza->string);
    pgCloseStanza(f, chainRel, srcDb);
    if (!isChild)
        pgNoteLabel(shown, label);
    }
dyStringFree(&stanza);
lineFileClose(&lf);
unlink(built);

/* The track that draws the insertion, deletion and mismatch marks.  Same
 * stanza hubConnect.c synthesizes for a registered quickLift chain. */
char *otherTwoBit = pgAssemblyFile(srcDb, ".2bit");
fprintf(f, "\ntrack pangenomeQuickLiftChain\n");
fprintf(f, "shortLabel Alignment Differences\n");
fprintf(f, "longLabel Alignment Differences\n");
fprintf(f, "type bigQuickLiftChain %s\n", srcDb);
/* Without this the hub reader rejects the type - trackHub.c only lets a
 * non-big* type through for a track that says it is being quickLifted. */
fprintf(f, "quickLifted on\n");
fprintf(f, "chainType reverse\n");
fprintf(f, "bigDataUrl %s\n", chainRel);
fprintf(f, "quickLiftUrl %s\n", chainRel);
fprintf(f, "quickLiftDb %s\n", srcDb);
if (!isEmpty(otherTwoBit))
    fprintf(f, "otherTwoBitUrl %s\n", otherTwoBit);
fprintf(f, "visibility dense\n");
fprintf(f, "priority 1\n");

carefulClose(&f);
if (rename(hubTmp, hubPath) != 0)
    {
    /* Nothing has been swapped in, so the hub already on disk is still whole
     * and still correct - just not yet widened. */
    unlink(hubTmp);
    return NULL;
    }
return cloneString(hubPath);
}

char *pgAttachAssembly(char *db)
/* Make sure this assembly is usable in this request, and return the name the
 * browser knows it by.  A GenArk assembly is served from a hub that has to be
 * connected first, after which it answers to a decorated "hub_<id>_<db>" name;
 * a native assembly is already itself.  Returns db unchanged if anything goes
 * wrong, so the caller still has something to report against. */
{
char *name = db;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    /* Two kinds of assembly are served from a hub and answer to a decorated
     * name once it is attached: a GenArk accession, and a curated hub like hs1
     * (dbDb.nibPath "hub:...").  Both have to be resolved, because a caller
     * that sets the cart's db to the plain name looks to the browser like a
     * database change, and the browser then resets the position we are about
     * to set. */
    char *arkUrl = genarkUrl(db);
    if (arkUrl == NULL)
        hubConnectGetCuratedUrl(db, &arkUrl);
    if (arkUrl != NULL)
        {
        char *hubErr = NULL;
        unsigned id = hubFindOrAddUrlInStatusTable(cart, arkUrl, &hubErr);
        if (id != 0)
            {
            char var[256];
            safef(var, sizeof(var), "%s%u", hgHubConnectHubVarPrefix, id);
            cartSetString(cart, var, "1");
            hubConnectLoadHubs(cart);
            char decorated[256];
            safef(decorated, sizeof(decorated), "hub_%u_%s", id, db);
            if (trackHubGetGenome(decorated) != NULL)
                name = cloneString(decorated);
            }
        }
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    fprintf(stderr, "hgPangenome: could not attach %s's assembly hub: %s\n",
            db, trimSpaces(errCatch->message->string));
errCatchFree(&errCatch);
return name;
}

boolean pgDbBorrowed = FALSE;    /* the cart's db is not the user's just now */
char *pgDbBefore = NULL;         /* what it was */

static void pgBorrowDb(char *db)
/* Point the cart's db at an assembly we need to read through it, remembering
 * what it was the first time, so that pgRunCartCommand() can put it back if
 * the command aborts before it gets to. */
{
if (!pgDbBorrowed)
    {
    pgDbBefore = cloneString(cartUsualString(cart, "db", ""));
    pgDbBorrowed = TRUE;
    }
cartSetString(cart, "db", db);
}

void pgRestoreDb(char *savedDb)
/* Put the cart's db back: we borrow it to reach the two assemblies, and the
 * conversion page must not find it changed underneath. */
{
if (isEmpty(savedDb))
    cartRemove(cart, "db");
else
    cartSetString(cart, "db", savedDb);
pgDbBorrowed = FALSE;
}

/* How far either side of the converted interval the chain should reach.
 *
 * The chain is what lets the lifted tracks be drawn, so wherever it stops the
 * annotations stop with it.  Zooming out is safe - the covered band keeps
 * drawing and the rest is simply empty - so this is really about how far the
 * user can pan before the tracks go blank.
 *
 * Two sizes, because the cost is real: the mapping service takes about a second
 * per megabase and serves one request at a time, so a wide chain bought up
 * front would be charged to every conversion, including the many that are never
 * panned.  The near pad is what the first request pays for; the wide pad is
 * fetched afterwards, off the click, and replaces it. */
static long pgChainPad(long span, boolean wide)
{
/* Deliberately not PG_MAX_LIFT_SPAN.  That caps what a *user* may ask to
 * translate and is set low to protect a service that handles one request at a
 * time; this caps what *we* fetch to build a chain, which is a different
 * question.  One limit for both would shrink the wide chain to nothing the
 * moment the user's limit was lowered, and panning would quietly stop working. */
long maxSpan = PG_MAX_CHAIN_SPAN;
long pad = wide ? PG_CHAIN_PAD_WIDE : PG_CHAIN_PAD_NEAR;
if (span <= 0)
    return 0;
/* Proportional for the near pad, so a gene-sized conversion gets room to pan
 * in window-widths rather than in a fixed number of bases that means something
 * quite different at either end of the zoom range. */
if (!wide)
    {
    long proportional = span * 5;
    if (proportional > pad)
        pad = proportional;
    if (pad > PG_CHAIN_PAD_NEAR_MAX)
        pad = PG_CHAIN_PAD_NEAR_MAX;
    }
/* Nothing wider than PG_MAX_CHAIN_SPAN is fetched, so the pad has to fit
 * inside what is left once the interval itself is counted. */
long room = (maxSpan - span) / 2;
if (room < 0)
    room = 0;
if (pad > room)
    pad = room;
return pad;
}

static struct jsonElement *pgFetchBlocks(char *srcPath, char *tgt, long start,
                                         long end, char **retError)
/* Ask the mapping service for the block-level translation of one interval, and
 * return its parsed response - the same shape the page posts to us, so the
 * caller can hand it straight to pgParseBlocks. */
{
char *apiBase = pgApiBase();
if (apiBase == NULL)
    { *retError = "pangenome.apiBase is not configured"; return NULL; }

struct dyString *body = dyStringNew(256);
dyStringPrintf(body, "{\"src\":\"%s\",\"start\":%ld,\"end\":%ld,"
                     "\"tgt\":\"%s\",\"blocks\":true}",
               jsonStringEscape(srcPath), start, end, jsonStringEscape(tgt));
char url[2048];
safef(url, sizeof(url), "%s/api/v1/liftover", apiBase);
struct pgResp r = pgHttp(url, body->string, pgTimeoutSecs());
dyStringFree(&body);
static char why[512];
if (r.transportErr)
    {
    if (r.busy)
        safef(why, sizeof(why), "%s", r.errMsg);
    else
        safef(why, sizeof(why), "could not reach the mapping server: %s",
              r.errMsg ? r.errMsg : "unknown error");
    *retError = why;
    return NULL;
    }
if (r.code >= 300)
    {
    /* Quote the upstream body when it is JSON - "service starting; indexes not
     * loaded yet" is the difference between "try again shortly" and "this
     * region cannot be lifted", and the user cannot tell those apart from a
     * generic failure. */
    char *body = skipLeadingSpaces(r.body->string);
    if (body[0] == '{' || body[0] == '[')
        /* %.400s: safef() aborts when the text does not fit, and this is a
         * body of any length. */
        safef(why, sizeof(why), "mapping server returned HTTP %ld: %.400s", r.code, body);
    else
        safef(why, sizeof(why), "mapping server returned HTTP %ld", r.code);
    *retError = why;
    return NULL;
    }

struct jsonElement *root = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    root = jsonParse(r.body->string);
errCatchEnd(errCatch);
if (errCatch->gotError || root == NULL)
    { errCatchFree(&errCatch); *retError = "unreadable reply"; return NULL; }
errCatchFree(&errCatch);
return root;
}

static boolean pgLiftInterval(char *srcPath, char *tgt, long start, long end,
                              char **retPath, long *retStart, long *retEnd,
                              char **retError)
/* Where one interval lands on another haplotype: the largest of the intervals
 * the mapping service translates it to, as a full contig path ("GRCh38#0#chr1")
 * and absolute coordinates on it.  A region that splits - across an inversion,
 * say - lands in several pieces; the largest is where its annotations are. */
{
static char why[512];
char *apiBase = pgApiBase();
if (apiBase == NULL)
    { *retError = "pangenome.apiBase is not configured"; return FALSE; }
struct dyString *body = dyStringNew(256);
dyStringPrintf(body, "{\"src\":\"%s\",\"start\":%ld,\"end\":%ld,\"tgt\":\"%s\"}",
               jsonStringEscape(srcPath), start, end, jsonStringEscape(tgt));
char url[2048];
safef(url, sizeof(url), "%s/api/v1/liftover", apiBase);
struct pgResp r = pgHttp(url, body->string, pgTimeoutSecs());
dyStringFree(&body);
if (r.transportErr)
    {
    if (r.busy)
        safef(why, sizeof(why), "%s", r.errMsg);
    else
        safef(why, sizeof(why), "could not reach the mapping server: %s",
              r.errMsg ? r.errMsg : "unknown error");
    *retError = why;
    return FALSE;
    }
if (r.code >= 300)
    {
    safef(why, sizeof(why), "mapping server returned HTTP %ld", r.code);
    *retError = why;
    return FALSE;
    }
struct jsonElement *root = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    root = jsonParse(r.body->string);
errCatchEnd(errCatch);
boolean bad = errCatch->gotError || root == NULL;
errCatchFree(&errCatch);
if (bad)
    { *retError = "unreadable reply from the mapping server"; return FALSE; }

struct jsonElement *ivs = jsonFindNamedField(root, "", "intervals");
long bestSize = 0;
if (ivs != NULL && ivs->type == jsonList)
    {
    struct slRef *ref;
    for (ref = ivs->val.jeList; ref != NULL; ref = ref->next)
        {
        struct jsonElement *iv = ref->val;
        if (iv->type != jsonObject)
            continue;
        char *name = jsonOptionalStringField(iv, "haplotype", NULL);
        struct jsonElement *sEl = jsonFindNamedField(iv, "", "start");
        struct jsonElement *eEl = jsonFindNamedField(iv, "", "end");
        if (isEmpty(name) || sEl == NULL || eEl == NULL ||
            sEl->type != jsonNumber || eEl->type != jsonNumber)
            continue;
        /* The two subpath forms the graph uses, "name[offset]" and a fourth
         * "#offset" field: the offset is where the fragment starts on the real
         * contig, so it is added to the coordinates and left off the name. */
        char *path = cloneString(name);
        long offset = 0;
        char *bracket = strchr(path, '[');
        if (bracket != NULL)
            {
            offset = atol(bracket + 1);
            *bracket = '\0';
            }
        char *contig = pgContigOf(path);
        if (contig == NULL)
            continue;
        char *third = strchr(strchr(path, '#') + 1, '#');
        char *fourth = strchr(third + 1, '#');
        if (fourth != NULL)
            {
            offset = atol(fourth + 1);
            *fourth = '\0';
            }
        long ivStart = offset + (long)sEl->val.jeNumber;
        long ivEnd = offset + (long)eEl->val.jeNumber;
        if (ivEnd - ivStart > bestSize)
            {
            bestSize = ivEnd - ivStart;
            *retPath = path;
            *retStart = ivStart;
            *retEnd = ivEnd;
            }
        }
    }
if (bestSize == 0)
    {
    safef(why, sizeof(why), "this region has no counterpart on %.200s", tgt);
    *retError = why;
    return FALSE;
    }
return TRUE;
}

void doContigs()
/* The sequences of one assembly, under both the names it is known by.
 *
 * The graph names sequences by accession (JBIREP010000009.1) but the browser
 * labels them the UCSC way (chrUn_JBIREP010000009v1), because these assembly
 * hubs set "chromAuthority ucsc".  A user who copies a position out of the
 * browser therefore hands us a name the graph has never heard of, and the page
 * used to reject it as not being a sequence of the assembly at all.
 *
 * Both names come from the assembly's own chromAlias bigBed.  Note this reads
 * the file directly rather than going through chromAliasSetup(): that resolves
 * a hub-served assembly through the hubs loaded in this process and would mean
 * attaching the hub - a cart write - just to spell a contig name.  The
 * database argument to chromAliasSetupBb() is unused, which is what makes the
 * direct route available. */
{
char *db = cgiOptionalString("db");
if (!pgValidDb(db))
    {
    emitJsonError("missing or malformed assembly");
    return;
    }
struct hash *sizes = pgChromSizes(db);
if (sizes == NULL)
    {
    emitJsonError("no sequence sizes available for %s", db);
    return;
    }
/* Without an alias file every sequence is simply its own display name, which
 * is the right answer for an assembly whose native names are already the ones
 * the browser shows. */
char *aliasBb = pgAssemblyFile(db, ".chromAlias.bb");
boolean haveAlias = FALSE;
if (aliasBb != NULL)
    {
    struct errCatch *errCatch = errCatchNew();
    if (errCatchStart(errCatch))
        {
        chromAliasSetupBb(NULL, aliasBb);
        haveAlias = TRUE;
        }
    errCatchEnd(errCatch);
    if (errCatch->gotError)
        {
        haveAlias = FALSE;
        fprintf(stderr, "hgPangenome: could not read %s: %s\n", aliasBb,
                trimSpaces(errCatch->message->string));
        }
    errCatchFree(&errCatch);
    }

struct dyString *out = dyStringNew(16 * 1024);
dyStringAppend(out, "{\"contigs\":[");
struct hashEl *el, *list = hashElListHash(sizes);
slSort(&list, hashElCmp);
boolean first = TRUE;
for (el = list; el != NULL; el = el->next)
    {
    char *display = el->name;
    if (haveAlias)
        {
        char *ucsc = chromAliasFindSingleAlias(el->name, "ucsc");
        if (!isEmpty(ucsc))
            display = ucsc;
        }
    dyStringPrintf(out, "%s{\"name\":\"%s\",\"display\":\"%s\",\"size\":%ld}",
                   first ? "" : ",", jsonStringEscape(el->name),
                   jsonStringEscape(display), (long)(size_t)el->val);
    first = FALSE;
    }
hashElFreeList(&list);
dyStringAppend(out, "]}");
emitJson(out->string);
dyStringFree(&out);
}

static void pgQuickLift(char *payload, boolean wide)
/* Build a chain from the blocks the page already has, wrap the source's
 * annotation tracks in a hub that points at it, and hand back a Genome Browser
 * URL on the target.  Needs the cart (for the hub), so unlike the other
 * commands this runs inside the cart shell and writes its own JSON header.
 * The payload is the conversion page's, or one doRefAnnot() builds. */
{
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

char *srcDb = jsonOptionalStringField(root, "srcDb", NULL);
char *tgtDb = jsonOptionalStringField(root, "tgtDb", NULL);
char *srcPath = jsonOptionalStringField(root, "src", NULL);
char *position = jsonOptionalStringField(root, "position", NULL);
/* Straight into a hub label, one setting per line, so the thing to keep out is
 * a newline.  The page sends a readable name ("HG00408 paternal"), so spaces
 * are expected and allowed. */
char *srcHap = jsonOptionalStringField(root, "srcHap", NULL);
if (srcHap != NULL)
    {
    char *p;
    for (p = srcHap; *p != '\0'; ++p)
        if (!(isalnum((unsigned char)*p) || *p == ' ' || *p == '#' ||
              *p == '_' || *p == '.' || *p == '-'))
            { srcHap = NULL; break; }
    }
boolean hideTracks = sameOk(jsonOptionalStringField(root, "hideTracks", "off"), "on");
/* The interval the user converted, and the single target this chain is for.
 * With these we can widen the chain ourselves rather than being limited to the
 * blocks the page happened to have. */
long srcStart = -1, srcEnd = -1;
struct jsonElement *el = jsonFindNamedField(root, "", "srcStart");
if (el != NULL && el->type == jsonNumber)
    srcStart = (long)el->val.jeNumber;
el = jsonFindNamedField(root, "", "srcEnd");
if (el != NULL && el->type == jsonNumber)
    srcEnd = (long)el->val.jeNumber;
char *tgtHap = jsonOptionalStringField(root, "tgt", NULL);

if (!pgValidDb(srcDb) || !pgValidDb(tgtDb))
    {
    emitJsonError("missing or malformed source/target assembly");
    return;
    }
if (isEmpty(srcPath) || isEmpty(position))
    {
    emitJsonError("missing source path or target position");
    return;
    }
char *srcContig = pgContigOf(srcPath);
if (srcContig == NULL)
    {
    emitJsonError("'src' must be a full contig path, e.g. HG00097#1#CM094066.1");
    return;
    }

/* The source's trackDb is reached through the cart's "db", so borrow it for
 * the source assembly and put it back before returning.  It is not already the
 * source: a request straight from the conversion page may carry no db at all,
 * and cartTrackDbInit aborts rather than defaulting. */
char *savedDb = cloneString(cartUsualString(cart, "db", ""));
pgBorrowDb(srcDb);
/* A GenArk assembly has no database of its own - its trackDb lives in an
 * assembly hub, and once attached the browser knows it by a decorated name.
 * Both sides need attaching: the source so we can read its tracks, the target
 * so the hub we write names the genome the browser will actually be on. */
char *srcName = pgAttachAssembly(srcDb);
/* Attach the target's hub too: the browser has to be able to resolve the
 * genome our hub names, and the chain has to be written in that assembly's
 * display names, which only its hub knows.  The decorated name is not what
 * goes in the hub file though - genome lines are written undecorated, and each
 * hub's own id is applied when it is read. */
char *tgtName = pgAttachAssembly(tgtDb);
cartSetString(cart, "db", srcName);

struct hash *srcSizes = pgChromSizes(srcDb);
struct hash *tgtSizes = pgChromSizes(tgtDb);
if (srcSizes == NULL || tgtSizes == NULL)
    {
    pgRestoreDb(savedDb);
    emitJsonError("no sequence sizes available for %s - annotations cannot be "
                  "lifted onto it", srcSizes == NULL ? srcDb : tgtDb);
    return;
    }
long qSize = hashIntValDefault(srcSizes, srcContig, 0);
if (qSize == 0)
    {
    pgRestoreDb(savedDb);
    emitJsonError("%s is not a sequence of %s", srcContig, srcDb);
    return;
    }

/* Fetch the blocks this chain is built from, widened beyond the interval that
 * was converted so the tracks survive a pan.
 *
 * The page used to post its own blocks and we only fetched the flanks.  That
 * put an unbounded array in the request body, and a conversion over a big or
 * repeat-dense region produced one past the 1 MB cap cheapcgi.c enforces
 * (CGI_INPUT_SIZE_LIMIT_DEFAULT) - which aborts with an HTML error page before
 * any of our code runs, so the page saw "<!DOCTYPE" where it wanted JSON.
 * Since we were already making this call for the padding, fetching all of it
 * costs nothing extra and keeps the request small.  Blocks in the payload are
 * still honoured if present, as a fallback when the fetch fails. */
char *fetchErr = NULL;
if (!isEmpty(tgtHap) && srcStart >= 0 && srcEnd > srcStart)
    {
    long pad = pgChainPad(srcEnd - srcStart, wide);
    if (pad > 0)
        {
        long from = srcStart - pad, to = srcEnd + pad;
        if (from < 0)
            from = 0;
        if (to > qSize)
            to = qSize;
        struct jsonElement *wider = pgFetchBlocks(srcPath, tgtHap, from, to, &fetchErr);
        if (wider != NULL)
            {
            root = wider;
            fetchErr = NULL;
            }
        }
    }

/* The page no longer posts its blocks, so a failed fetch leaves nothing to
 * parse and pgParseBlocks would report "no 'blocks' array in the request" -
 * true, but it describes our own request rather than what went wrong.  Say why
 * the fetch failed instead.  A payload that does carry blocks is still
 * honoured, which is what the mock tests rely on. */
if (fetchErr != NULL && jsonFindNamedField(root, "", "blocks") == NULL)
    {
    pgRestoreDb(savedDb);
    emitJsonError("%s", fetchErr);
    return;
    }

struct pgBlock *blocks = pgParseBlocks(root, qSize, &err);
if (blocks == NULL)
    {
    pgRestoreDb(savedDb);
    emitJsonError("%s", err);
    return;
    }
/* Note: the target's sequences are kept under the accessions the graph uses.
 * Even where an assembly hub sets "chromAuthority ucsc" - so the browser
 * *labels* CM094399.1 as chr9 - hgTracks still queries tracks under the
 * accession, and a chain written with the display names is never found. */

/* Chain files.  The .bb / .link.bb pairing is not a convention we can choose:
 * bigChainGetLinkFile() derives the link name from the chain name. */
struct tempName chainTn, chainBedTn, linkBedTn, chainAsTn, linkAsTn;
trashDirDateFile(&chainTn, "pangenomeQuickLift", "chain", ".bb");
trashDirDateFile(&chainBedTn, "pangenomeQuickLift", "chain", ".bed");
trashDirDateFile(&linkBedTn, "pangenomeQuickLift", "link", ".bed");
trashDirDateFile(&chainAsTn, "pangenomeQuickLift", "bigChain", ".as");
trashDirDateFile(&linkAsTn, "pangenomeQuickLift", "bigLink", ".as");

char linkBb[PATH_LEN];
safef(linkBb, sizeof(linkBb), "%s", chainTn.forCgi);
linkBb[strlen(linkBb) - strlen(".bb")] = '\0';
safecat(linkBb, sizeof(linkBb), ".link.bb");

boolean renamed = pgUseDisplayNames(tgtName, blocks, &tgtSizes);
if (!pgWriteChainBeds(blocks, srcContig, qSize, tgtSizes,
                      chainBedTn.forCgi, linkBedTn.forCgi, &err))
    {
    pgRestoreDb(savedDb);
    emitJsonError("%s", err);
    return;
    }
pgWriteTextFile(chainAsTn.forCgi, bigChainAsText);
pgWriteTextFile(linkAsTn.forCgi, bigLinkAsText);

char *tgtChromSizes = pgChromSizesFile(tgtDb, tgtSizes, renamed);
if (!pgRunBedToBigBed("bed6+6", chainAsTn.forCgi, chainBedTn.forCgi,
                      tgtChromSizes, chainTn.forCgi, &err) ||
    !pgRunBedToBigBed("bed4+1", linkAsTn.forCgi, linkBedTn.forCgi,
                      tgtChromSizes, linkBb, &err))
    {
    pgRestoreDb(savedDb);
    emitJsonError("%s", err);
    return;
    }

/* Collect the source's gene tracks into a hub aimed at the destination. */
struct dyString *shown = dyStringNew(256);
struct dyString *skipped = dyStringNew(256);
char *hubFile = NULL;
errCatch = errCatchNew();
if (errCatchStart(errCatch))
    hubFile = pgWriteQuickLiftHub(srcName, srcHap, tgtDb, chainTn.forCgi, shown, skipped);
errCatchEnd(errCatch);
boolean buildFailed = errCatch->gotError;
char *buildMsg = buildFailed ? cloneString(trimSpaces(errCatch->message->string)) : NULL;
errCatchFree(&errCatch);

pgRestoreDb(savedDb);

if (buildFailed || hubFile == NULL)
    {
    fprintf(stderr, "hgPangenome: could not collect %s's tracks: %s\n",
            srcDb, buildMsg ? buildMsg : "no hub produced");
    emitJsonError("could not collect %s's annotation tracks", srcDb);
    return;
    }
if (shown->stringSize == 0)
    {
    /* Two quite different reasons, and the user can only act on one of them.
     *
     * Tracks were showing but none could come across: say which, so the answer
     * is about those tracks rather than about the assembly.
     *
     * Nothing was showing at all: almost always this is the second leg of two
     * conversions.  Arriving here with "hide other tracks" checked - which is
     * the default - turns off everything the assembly has of its own, and the
     * annotations carried in are skipped deliberately, since lifting an already
     * lifted track would compound the error.  So there is nothing left to carry
     * onward, and the fix is to turn something on. */
    if (skipped->stringSize > 0)
        emitJsonError("none of the tracks showing on %s can be carried over "
                      "(%s). Turn on a track the browser can lift - genes, "
                      "bigBed or bigWig - and convert again.",
                      srcDb, skipped->string);
    else
        emitJsonError("no tracks are showing on %s, so there is nothing to "
                      "carry over. This is usually because \"hide other tracks\" "
                      "was checked on the way in; turn some tracks on in the "
                      "browser and convert again.", srcDb);
    return;
    }

char *hubErr = NULL;
unsigned hubId = 0;
errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    pgForgetStaleHubs(hubFile, FALSE);
    hubId = hubFindOrAddUrlInStatusTable(cart, hubFile, &hubErr);
    }
errCatchEnd(errCatch);
if (errCatch->gotError || hubId == 0)
    {
    fprintf(stderr, "hgPangenome: could not register quickLift hub %s: %s\n",
            hubFile, errCatch->gotError ? trimSpaces(errCatch->message->string)
                                        : (hubErr ? hubErr : "no id"));
    errCatchFree(&errCatch);
    emitJsonError("could not attach the lifted annotations to the browser");
    return;
    }
errCatchFree(&errCatch);

/* Connect it the ordinary way; the cart is saved when this request ends. */
char connectVar[256];
safef(connectVar, sizeof(connectVar), "%s%u", hgHubConnectHubVarPrefix, hubId);
cartSetString(cart, connectVar, "1");

/* Connect the source assembly itself as well.  quickLift reads the source's
 * DNA to find mismatches, which it can only do if that assembly is among the
 * hubs loaded on the target's page.  Harmless when the source is a native
 * assembly - genarkUrl is NULL and there is nothing to attach. */
unsigned srcHubId = 0;
char *srcHubUrl = genarkUrl(srcDb);
/* A curated hub such as hs1 is a hub too, and has to be named the same way:
 * left to the cart, its connection reaches the browser page only if no other
 * request of this user saved a cart in between. */
if (srcHubUrl == NULL)
    hubConnectGetCuratedUrl(srcDb, &srcHubUrl);
if (srcHubUrl != NULL)
    {
    char *srcErr = NULL;
    errCatch = errCatchNew();
    if (errCatchStart(errCatch))
        srcHubId = hubFindOrAddUrlInStatusTable(cart, srcHubUrl, &srcErr);
    errCatchEnd(errCatch);
    if (!errCatch->gotError && srcHubId != 0)
        {
        char srcVar[256];
        safef(srcVar, sizeof(srcVar), "%s%u", hgHubConnectHubVarPrefix, srcHubId);
        cartSetString(cart, srcVar, "1");
        }
    else
        /* Not fatal: the lifted tracks still draw, only the mismatch marks
         * inside the alignment-differences track go missing. */
        fprintf(stderr, "hgPangenome: could not attach source assembly %s: %s\n",
                srcDb, errCatch->gotError ? trimSpaces(errCatch->message->string)
                                          : (srcErr ? srcErr : "no id"));
    errCatchFree(&errCatch);
    }

struct dyString *url = dyStringNew(512);
dyStringPrintf(url, "hgTracks?db=%s&position=%s&%s=1",
               cgiEncode(tgtDb), cgiEncode(position), connectVar);
/* The source's own hub goes in the link too, not only into the cart.
 *
 * Everything carried over is read from the source assembly, and the alignment
 * differences need its DNA, so that assembly has to be among the hubs loaded
 * on the target's page.  Writing the cart variable here is not enough to
 * guarantee it:  the name we put in quickLiftDb is the decorated hub_<id>_<db>
 * form, and hgTracks can only resolve that when the hub is loaded in the
 * process doing the drawing.  Where it was not, hNibForChrom fell through to
 * /gbdb/<decorated name>/<decorated name>.2bit, which does not exist, and the
 * page came up with no tracks at all and "Can't open ... .2bit to read".
 * Naming it in the link is how the lifted hub itself is attached, and it
 * leaves nothing to chance. */
if (srcHubId != 0)
    dyStringPrintf(url, "&%s%u=1", hgHubConnectHubVarPrefix, srcHubId);
if (hideTracks)
    dyStringAppend(url, "&hideTracks=on");

struct dyString *out = dyStringNew(512);
dyStringPrintf(out, "{\"status\":\"ok\",\"url\":\"%s\",\"tracks\":\"%s\"",
               jsonStringEscape(url->string), jsonStringEscape(shown->string));
if (skipped->stringSize > 0)
    dyStringPrintf(out, ",\"skipped\":\"%s\"", jsonStringEscape(skipped->string));
dyStringAppend(out, "}");
emitJson(out->string);
dyStringFree(&out);
dyStringFree(&url);
}

void doQuickLift()
/* cmd=quickLift: the source's annotations on the target of a conversion, with
 * a chain that reaches a little way either side: what the first request pays
 * for. */
{
pgQuickLift(cgiOptionalString("payload"), FALSE);
}

void doExtendChain()
/* cmd=extendChain: the same work with a wider chain.  Sent after the reader
 * has followed the link, so the chain they are already looking at is replaced
 * by one that survives panning.  Nothing waits for it, and the reply goes
 * nowhere. */
{
pgQuickLift(cgiOptionalString("payload"), TRUE);
}

/* ---- A reference's annotations on a mapped haplotype ----------------------
 *
 * The results page opens a haplotype with the user's sequence drawn on it.
 * With a reference chosen, the tracks the user has turned on in that reference
 * come too: the hit's region is translated to the reference through the graph,
 * and that interval is handed to pgQuickLift() as a conversion from the
 * reference onto the haplotype - the same path PanLift's "PanLift tracks"
 * takes, chain from the graph and all, so neither depends on precomputed chain
 * files. */

struct slPair *pgAnnotRefs()
/* The references whose annotations can be brought, from
 * pangenome.annotationRefs: "haplotype=db" pairs, comma separated.  A future
 * reference is one more pair. */
{
static struct slPair *refs = NULL;
static boolean done = FALSE;
if (done)
    return refs;
done = TRUE;
char *spec = cloneString(pgAnnotationRefSpec());
char *words[32];
int n = chopByChar(spec, ',', words, ArraySize(words));
int i;
for (i = 0; i < n; i++)
    {
    char *pair = trimSpaces(words[i]);
    char *eq = strchr(pair, '=');
    if (eq == NULL)
        continue;
    *eq = '\0';
    char *hap = trimSpaces(pair), *db = trimSpaces(eq + 1);
    if (countChars(hap, '#') == 1 && pgValidDb(db))
        slAddTail(&refs, slPairNew(hap, cloneString(db)));
    }
return refs;
}

char *pgRefLabel(char *hap)
/* "GRCh38#0" -> "GRCh38", for the hub's label and the page. */
{
char *label = cloneString(hap);
char *hash = strchr(label, '#');
if (hash != NULL)
    *hash = '\0';
return label;
}

void doRefAnnot()
/* Bring the reference's annotations onto the haplotype a hit is on.  The
 * payload names the hit - its assembly, its contig path in the graph and its
 * extent - the reference, and the position the browser will open on. */
{
char *payload = cgiOptionalString("payload");
if (isEmpty(payload))
    {
    emitJsonError("missing 'payload'");
    return;
    }
struct jsonElement *root = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    root = jsonParse(payload);
errCatchEnd(errCatch);
boolean bad = errCatch->gotError || root == NULL;
errCatchFree(&errCatch);
if (bad)
    {
    emitJsonError("invalid JSON payload");
    return;
    }
char *db = jsonOptionalStringField(root, "db", NULL);
char *path = jsonOptionalStringField(root, "path", NULL);
char *ref = jsonOptionalStringField(root, "ref", NULL);
char *position = jsonOptionalStringField(root, "position", NULL);
struct jsonElement *sEl = jsonFindNamedField(root, "", "start");
struct jsonElement *eEl = jsonFindNamedField(root, "", "end");
struct slPair *refPair = isEmpty(ref) ? NULL : slPairFind(pgAnnotRefs(), ref);
if (refPair == NULL)
    {
    emitJsonError("annotations cannot be brought from '%s'", ref ? ref : "");
    return;
    }
if (!pgValidDb(db) || isEmpty(path) || pgContigOf(path) == NULL || isEmpty(position))
    {
    emitJsonError("missing or malformed assembly, sequence or position");
    return;
    }
if (sEl == NULL || eEl == NULL || sEl->type != jsonNumber || eEl->type != jsonNumber ||
    sEl->val.jeNumber < 0 || eEl->val.jeNumber <= sEl->val.jeNumber)
    {
    emitJsonError("missing or malformed start and end");
    return;
    }
long start = (long)sEl->val.jeNumber, end = (long)eEl->val.jeNumber;
long maxSpan = PG_MAX_LIFT_SPAN;
if (end - start > maxSpan)
    {
    emitJsonError("the hit is longer than the %ld bp a translation may cover", maxSpan);
    return;
    }
char *refDb = (char *)refPair->val;
/* The haplotype the hit is on, as the graph names it ("HG00097#1"). */
char *hap = cloneString(path);
*strchr(strchr(hap, '#') + 1, '#') = '\0';
if (sameWord(hap, ref))
    {
    emitJsonError("this hit is already on %s", pgRefLabel(ref));
    return;
    }

char *refPath = NULL, *err = NULL;
long refStart = 0, refEnd = 0;
if (!pgLiftInterval(path, ref, start, end, &refPath, &refStart, &refEnd, &err))
    {
    emitJsonError("%s", err);
    return;
    }

/* A conversion from the reference onto the haplotype, as PanLift would send
 * it: pgQuickLift() pads the interval, fetches the blocks and builds the rest.
 * The haplotype's own tracks are hidden, so the page opens on the reference's
 * annotations and the user's sequence rather than two gene sets on top of
 * each other; the user can turn them back on in the browser. */
boolean hideOwn = PG_ANNOTATION_HIDE_OWN;
struct dyString *ql = dyStringNew(512);
dyStringPrintf(ql, "{\"srcDb\":\"%s\",\"tgtDb\":\"%s\",\"src\":\"%s\","
                   "\"srcHap\":\"%s\",\"srcStart\":%ld,\"srcEnd\":%ld,"
                   "\"tgt\":\"%s\",\"position\":\"%s\",\"hideTracks\":\"%s\"}",
               jsonStringEscape(refDb), jsonStringEscape(db), jsonStringEscape(refPath),
               jsonStringEscape(pgRefLabel(ref)), refStart, refEnd,
               jsonStringEscape(hap), jsonStringEscape(position), hideOwn ? "on" : "off");
pgQuickLift(ql->string, FALSE);
dyStringFree(&ql);
}
