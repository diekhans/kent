/* hgPangenome.h - what the files of the hgPangenome CGI share. */

#ifndef HGPANGENOME_H
#define HGPANGENOME_H

struct cart;
struct dyString;
struct hash;
struct jsonWrite;
struct slPair;

extern struct cart *cart;

/* ---- Fixed values --------------------------------------------------------
 *
 * Limits and defaults that are the same on every server.  To change one,
 * change it here and rebuild: nothing in hg.conf reaches them.  The tests read
 * the limits from this file (tests/cgiTests.py), so they test the values
 * that ship.  What a server does decide is in hg.conf, read by the functions
 * under "Settings" below. */

/* A mapping request.  The page checks these as well; the checks that count are
 * the server's.  How many sequences and how long are settings: see
 * pgMaxSequences() and pgMaxSeqLen(). */
#define PG_MAX_REQUEST_BYTES 1040000    /* one request's payload: holds 10 sequences of
                                         * 100000, the defaults of those two settings, and
                                         * stays under the 1 MB (1048576) cheapcgi.c accepts
                                         * as a CGI's input - past that it answers with an
                                         * HTML page */
#define PG_MAX_MULTIMAPS 3              /* alignments asked for per sequence, and the most
                                         * that may be: the graph server returns no more */
#define PG_MIN_HAP_COVERAGE "null"      /* haplotypes reported for a hit must match at least
                                         * this per cent; null is the graph server's default */
#define PG_POLL_INTERVAL_MS 1500        /* how often the form asks after a job */

/* The results page. */
#define PG_MAX_SURJECT_TARGETS 500      /* most haplotypes one batch surjection may place:
                                         * every haplotype in the graph, about four seconds */
#define PG_RESULTS_SURJECT_TOP 50       /* how many it places for the first page */
#define PG_RESULTS_PLACE_ALL_AT_LOAD FALSE  /* TRUE: every haplotype of each hit straight
                                         * after the first table is drawn, not when the
                                         * reader turns to a page that shows one */
#define PG_RESULTS_MIN_COVERAGE 0       /* coverage (%) a haplotype needs to be placed */
#define PG_RESULTS_SHOW_COVERAGE 50     /* coverage (%) the table shows to begin with */
#define PG_PCLAI_MIN_COVERAGE 50        /* coverage (%) a hit needs to be in the ancestry plot */
#define PG_PCLAI_MAX_HAPLOTYPES 100     /* haplotypes one ancestry request may name */

/* PanLift. */
#define PG_MAX_LIFT_SPAN 1000000        /* bases in one coordinate translation */
#define PG_MAX_LIFT_ALL_BYTES 20000000  /* longest answer accepted for one region on every
                                         * haplotype: a summary is about 1 kB a haplotype */
#define PG_MAX_CHOSEN_TARGETS 50        /* haplotypes the picker lets a reader choose; past
                                         * that the question is about every haplotype */
#define PG_MAX_TARGET_NODES 300         /* graph nodes walked to rank destinations */
#define PG_MIN_TARGET_COVERAGE 10       /* a destination below this per cent is left out */
#define PG_DEFAULT_SRC_DB "hs1"         /* the assembly the page opens on with no source */
#define PG_DEFAULT_POSITION "chr9:145458455-145495201"  /* and its position: hs1's default view */
#define PG_DEFAULT_TARGET "grch38#0"    /* the haplotype chosen as the target to begin with */
#define PG_QUICKLIFT_DEFAULT TRUE       /* the Annotations box starts ticked */

/* The lifted tracks. */
#define PG_MAX_CHAIN_SPAN 10000000      /* bases fetched to build one chain.  Not
                                         * PG_MAX_LIFT_SPAN: that is what a reader may ask
                                         * for, this is what the server fetches for padding */
#define PG_MAX_BLOCKS 200000            /* blocks accepted in one translation */
#define PG_CHAIN_PAD_NEAR 250000        /* bases either side that the first chain reaches;
                                         * raised to five times the interval, up to ... */
#define PG_CHAIN_PAD_NEAR_MAX 1000000   /* ... this */
#define PG_CHAIN_PAD_WIDE 5000000       /* bases either side for the wider chain fetched
                                         * after the reader follows the link */
#define PG_ANNOTATION_DEFAULT "GRCh38#0"    /* the reference whose annotations the results
                                         * page brings to begin with; "none" for none */
#define PG_ANNOTATION_HIDE_OWN TRUE     /* a haplotype's own tracks are hidden when a
                                         * reference's annotations are brought */

/* Talking to the graph server. */
#define PG_QUEUE_WAIT_SECS 120          /* longest a request waits for its turn */
#define PG_SLOT_DIR "../trash/hgPangenomeSlots"     /* where the queue's lock files live */
#define PG_SURJECT_ALL_TIMEOUT_SECS 90  /* a batch surjection may take this long even
                                         * where pangenome.timeoutSecs is shorter */

/* ---- Settings: what hg.conf decides (hgPangenome.c) ---- */

boolean pgToolsOn(void);
/* pangenomeTools: "on" turns the tools on.  Off is the default. */

char *pgApiBase(void);
/* pangenome.apiBase: the graph server's base URL, without a trailing slash.
 * NULL when it is not set. */

char *pgApiToken(void);
/* pangenome.apiToken: the shared secret sent to the graph server as the
 * X-Pangenome-Token header.  Empty, the default, sends no header. */

int pgTimeoutSecs(void);
/* pangenome.timeoutSecs: how long one request to the graph server may take;
 * default 120. */

int pgMaxConcurrent(void);
/* pangenome.maxConcurrent: requests this web server sends the graph server at
 * once; the rest wait their turn.  Default 4; 0 for no queue. */

int pgMaxSequences(void);
/* pangenome.maxSequences: the most sequences one mapping request may hold;
 * default 10. */

int pgMaxSeqLen(void);
/* pangenome.maxSeqLen: the most bases in one sequence; default 100000. */

boolean pgAncestryOn(void);
/* pangenome.resultsPclai: "on" adds the ancestry plot to the results page and
 * to PanLift.  Off is the default. */

char *pgGraphLabel(void);
/* pangenome.graphLabel: the graph's name as the pages show it. */

char *pgAnnotationRefSpec(void);
/* pangenome.annotationRefs: the references the results page can bring
 * annotations from, as "haplotype=db" pairs, comma separated. */

char *pgPclaiRefPanel(void);
/* pangenome.pclaiRefPanel: a file holding the ancestry reference panel, read
 * in place of the one in the assembly's own contrib directory.  NULL when it
 * is not set. */

char *pgGenArkDir(char *acc);
/* Where the files of a GenArk assembly are, under hg.conf genarkHubPrefix.
 * NULL for an assembly that is not one.  Can be a URL. */

char *pgGbdbFile(char *path);
/* Where this server keeps a file named under /gbdb - hg.conf can move /gbdb,
 * or point it at UCSC - or NULL when it does not have it.  Can be a URL. */

/* ---- hgPangenome.c - answering, and the names a request may carry ---- */

void emitJson(char *json);
/* Write an application/json CGI response (no cart/HTML), its header through
 * cgiPrintContentType(). */

void emitJsonError(char *fmt, ...);
/* Emit a {"status":"error","error":"..."} body the JS client understands. */

boolean pgValidDb(char *db);
/* Assembly names reach us from the page and end up in file paths and cart
 * variables, so keep them to the shape a db name actually has: letters, digits
 * and . _ - only, beginning with a letter or a digit. */

boolean pgSafeToken(char *tok);
/* A sample name, a phase or a sequence name on its way into a file path.
 * The same shape pgValidDb insists on, named for the wider use. */

boolean pgPlainName(char *name);
/* TRUE for a sequence name with no blank and no control character in it, which
 * is what one must be to sit on a FASTA header line. */

boolean pgValidJobId(char *s);
/* Job ids go into a URL path, so restrict to a safe charset to avoid any
 * path/SSRF trickery. */

boolean pgValidHapName(char *s);
/* A haplotype as the graph names it, SAMPLE#PHASE ("HG00097#1"), or one of its
 * sequences, SAMPLE#PHASE#CONTIG.  Nothing else is passed on as a target: the
 * limits on a request count its targets, and a word that the graph server
 * reads as "all of them" would be counted as one. */

/* ---- proxy.c - the graph server ---- */

struct pgResp
/* Result of one graph server request. */
    {
    long code;                  /* HTTP status, 0 if the request never completed */
    struct dyString *body;      /* response body (always non-NULL) */
    boolean transportErr;       /* true if curl itself failed (DNS, connect, timeout) */
    char *errMsg;               /* curl error string when transportErr */
    boolean busy;               /* never sent: no turn came up in the queue */
    };

struct pgResp pgHttp(char *url, char *postJson, int timeoutSecs);
/* Make one request to the graph server.  GET when postJson is NULL, otherwise
 * POST postJson as application/json.  The token, where hg.conf has one, is
 * sent as the X-Pangenome-Token header.  Caller frees resp.body / resp.errMsg. */

void doMap(void);
/* cmd=map: submit sequences to be mapped. */

void doPoll(void);
/* cmd=poll: how a mapping job is getting on, and its results once it is done. */

void doHaplotypes(void);
/* cmd=haplotypes: the haplotypes in the loaded graph. */

void doLiftoverTargets(void);
/* cmd=liftoverTargets: which haplotypes a region can translate to at all. */

void doLiftoverAll(void);
/* cmd=liftoverAll: where a region lands on every haplotype, or on the ones named. */

void doSurject(void);
/* cmd=surject: re-place an alignment on another haplotype. */

void doSurjectAll(void);
/* cmd=surjectAll: place a read on every haplotype that carries it. */

/* ---- liftedTracks.c - one assembly's annotations on another ---- */

extern boolean pgDbBorrowed;     /* the cart's db is not the user's just now */
extern char *pgDbBefore;          /* what it was */

struct hash *pgChromSizes(char *db);
/* name -> size for an assembly, NULL if we cannot work it out.
 *
 * A GenArk assembly ships a chrom.sizes file; otherwise read the sizes out of
 * the 2bit.  Deliberately not chromInfo: assemblies served from a curated hub
 * (hs1 among them) have no such table, and the 2bit is the one thing every
 * assembly has, whether it is native, curated or GenArk. */

char *pgChromSizesFile(char *db, struct hash *sizes, boolean renamed);
/* bedToBigBed wants a chrom.sizes file.  Use the assembly's own where there is
 * one, but not once we have renamed the sequences to their display names - the
 * shipped file is keyed by accession and bedToBigBed would reject every row. */

void pgForgetStaleHubs(char *keepHubFile, boolean missingOnly);
/* Disconnect pangenome quickLift hubs this cart is still holding.
 *
 * Two callers, two meanings.  Building a new lift passes the hub it is about to
 * use and missingOnly=FALSE: everything else goes, so a cart holds one of
 * these hubs at a time.  A page load passes missingOnly=TRUE, which drops only
 * hubs whose file is gone - trash is swept in about an hour, and the cart
 * entry outlives it, so hgTracks goes on trying to open a dead path and draws
 * a red "Couldn't open ..." group on every page until something takes the
 * entry away.  That is done at a page load because the reader is here then;
 * building a new lift is the one moment they are not looking at the error. */

char *pgAttachAssembly(char *db);
/* Make sure this assembly is usable in this request, and return the name the
 * browser knows it by.  A GenArk assembly is served from a hub that has to be
 * connected first, after which it answers to a decorated "hub_<id>_<db>" name;
 * a native assembly is already itself.  Returns db unchanged if anything goes
 * wrong, so the caller still has something to report against. */

void pgRestoreDb(char *savedDb);
/* Put the cart's db back: we borrow it to reach the two assemblies, and the
 * conversion page must not find it changed underneath. */

void doContigs(void);
/* The sequences of one assembly, under both the names it is known by.
 *
 * The graph names sequences by accession (JBIREP010000009.1) but the browser
 * labels them the UCSC way (chrUn_JBIREP010000009v1), because these assembly
 * hubs set "chromAuthority ucsc".  A user who copies a position out of the
 * browser therefore hands us a name the graph has never heard of, and the page
 * has to take either.
 *
 * Both names come from the assembly's own chromAlias bigBed.  Note this reads
 * the file directly rather than going through chromAliasSetup(): that resolves
 * a hub-served assembly through the hubs loaded in this process and would mean
 * attaching the hub - a cart write - just to spell a contig name.  The
 * database argument to chromAliasSetupBb() is unused, which is what makes the
 * direct route available. */

void doQuickLift(void);
/* cmd=quickLift: the source's annotations on the target of a conversion, with
 * a chain that reaches a little way either side. */

void doExtendChain(void);
/* cmd=extendChain: the same, with a chain wide enough to pan along. */

struct slPair *pgAnnotRefs(void);
/* The references whose annotations can be brought, from
 * pangenome.annotationRefs: "haplotype=db" pairs, comma separated.  A future
 * reference is one more pair. */

char *pgRefLabel(char *hap);
/* "GRCh38#0" -> "GRCh38", for the hub's label and the page. */

void doRefAnnot(void);
/* Bring the reference's annotations onto the haplotype a hit is on.  The
 * payload names the hit - its assembly, its contig path in the graph and its
 * extent - the reference, and the position the browser will open on. */

/* ---- seqTrack.c - the mapped sequence as a track ---- */

void pgStashQuerySeqs(char *payload, char *response);
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

void pgJsonQuerySeqs(struct jsonWrite *jw, char *field, char *jobId);
/* The job's query sequences as [{name, seq}, ...], read back from the copy
 * taken at submit time, for the results page's "Show Query Sequence".  hgBlat
 * puts its queries on its results page the same way.  Nothing is written - not
 * even an empty list - when the job is unknown or its copy has been swept, so
 * the page can tell "no sequence to show" from "an empty one". */

void doAlignTrack(void);
/* Build the sequence track - the user's sequence aligned to one haplotype, as
 * a bigPsl custom track - and hand back a browser URL that draws it and one
 * for its base-by-base alignment.  Runs with the cart, for the session the
 * links name and the assembly's hub. */

/* ---- ancestryLocus.c - ancestry and locus, from files under /gbdb ---- */

void doLocus(void);
/* The locus words for each interval in the payload, in order:
 *   {"items":[{"db":"GCA_...","contig":"CM094060.1","start":0,"end":10}, ...]}
 * answers {"status":"ok","loci":["exon ATAD3B", null, ...]}, null where there
 * is nothing to say - a hub assembly, or no genes near enough.  A gene file is
 * opened once per assembly in the request; the database is read over one
 * connection, moved from assembly to assembly. */

void doPclai(void);
/* Ancestry coordinates for a list of haplotypes, each read at its own
 * surjected interval, plus the reference cloud they are read against.  With
 * "windows": true, each point also lists every window its interval crosses.
 *
 * The payload is a list rather than one shared locus because that is the whole
 * point of using the assembly-coordinate files - see the note above. */

#endif /* HGPANGENOME_H */
