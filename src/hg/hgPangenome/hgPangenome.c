/* hgPangenome - Pangenome-enabled sequence mapping page.
 *
 * A new, self-contained browser service, in the spirit of hgBlat but talking
 * to its own middleware.  The actual mapping + surjection is done by a separate
 * long-running mapping API server ("the middleware").  This CGI is the *client*
 * of that middleware: the browser only ever talks to this CGI (same origin),
 * and this CGI forwards every request to the middleware over HTTP/JSON and
 * returns the answer.  So the middleware URL (and any future auth) stays
 * entirely server-side, and there is no cross-origin (CORS) problem.
 *
 *   browser (js/hgPangenome.js)  --form POST-->  hgPangenome CGI
 *                                                    |
 *                                                    |  curl HTTP/JSON
 *                                                    v
 *                                              mapping API middleware
 *
 * The CGI has two request modes, selected by the "cmd" CGI variable:
 *   (no cmd)      render the page (form + result area) + serve the JS.
 *   cmd=map       POST the "payload" JSON to  {apiBase}/api/v1/map .
 *   cmd=poll      GET  {apiBase}/api/v1/map/{job_id} .
 *   cmd=liftover  POST the "payload" JSON to {apiBase}/api/v1/liftover - translate
 *                 an interval from one haplotype's coordinates to another's.
 *                 Synchronous: the answer comes back in the same response.
 *   cmd=liftoverTargets  POST to {apiBase}/api/v1/liftover/targets - which
 *                 haplotypes this region can translate to at all.
 *   cmd=liftoverAll  POST to {apiBase}/api/v1/liftover with tgt "*" in its
 *                 summary form - one row per haplotype in the graph, for
 *                 page=liftAll.  The request sent on is built here.
 *   cmd=alignTrack write the PSL/FASTA pair BLAT uses ("ss=") so the browser
 *                 draws the mapped sequence on the target haplotype.
 *   cmd=surject   POST {apiBase}/api/v1/surject - re-place an alignment the
 *                 server still holds onto another haplotype, without mapping
 *                 the read again.  A 404 (the job aged out) comes back as
 *                 {"status":"expired"} so the page can fall back to mapping.
 *   cmd=haplotypes GET {apiBase}/api/v1/haplotypes - the haplotypes present in
 *                 the loaded graph, used to populate the conversion picker.
 *   cmd=quickLift build a chain from an already-translated set of blocks and
 *                 wrap the source assembly's annotation tracks in a hub that
 *                 points at it, so the browser's own QuickLift draws them on
 *                 the target.  Talks to no middleware; it needs the cart, so
 *                 it is the one command that runs inside the cart shell.
 *   cmd=refAnnot  the same, for the results page: translate a hit's region on
 *                 its haplotype to a reference (GRCh38, CHM13) through the
 *                 graph, then QuickLift the tracks the user has on in that
 *                 reference onto the haplotype.  Also inside the cart shell.
 *   cmd=locus     the gene each of a list of hits falls in, for the results
 *                 table's Locus column: hgBlat's words, from CAT genes
 *   cmd=svOpen    the same for an SV: translate its graph site from the
 *                 reference to one haplotype and open it there, with or without
 *                 the reference's tracks.  Inside the cart shell.
 * and five pages, selected by "page": none for the mapping form, "results" for
 * a mapping job's table, "convert" for PanLift, "liftAll" for one PanLift
 * region on every haplotype, and "svOpen", the step from a haplotype named on
 * an SV's details page (hgc's pangenomeCarriers section) to that haplotype in
 * the browser.
 * The map/poll modes emit raw application/json (the middleware's answer, or a
 * synthesized {"status":"error",...}) and never touch the cart, so they are
 * cheap and DB-free.  Nothing about BLAT is used or changed.
 *
 * The middleware base URL and related knobs come from hg.conf so they are not
 * baked into the client and can differ per install:
 *
 *   pangenome.apiBase        base URL of the mapping API, e.g. https://host/pangenome
 *                            (empty => run against the built-in JS mock)
 *   pangenome.useMock        "on"/"off"; default "on" when apiBase is empty
 *   pangenome.transport      "job" (async, poll) or "sync"; default "job"
 *   pangenome.timeoutSecs    per-request timeout talking to the middleware; default 120
 *   pangenome.pollIntervalMs poll interval in ms; default 1500
 *   pangenome.maxSequences   max sequences per submit (server-enforced); default 50
 *   pangenome.maxSeqLen      max length of one sequence in bp; default 100000
 *   pangenome.maxRequestBytes max raw payload size; default 10000000
 *   pangenome.minHapCoverage only report haplotypes matching at least this
 *                            percentage (0-100) on mapping results; unset means
 *                            the middleware's own default.  The default returns
 *                            a few hundred haplotypes per alignment, so set this
 *                            if those payloads become a problem.
 *   pangenome.maxLiftSpan    max bp per coordinate translation; default 1000000
 *   pangenome.maxLiftAllBytes  longest answer accepted for one region on every
 *                            haplotype (page=liftAll); default 20000000.  A
 *                            summary is about 1 kB a haplotype; past this the
 *                            page says the region is too complex to show.
 *   pangenome.maxLiftTargetMb  max (span in Mb) x (targets) per request; default
 *                            5.  The service traverses once per target and
 *                            serves one request at a time, so the product is
 *                            the real cost - capping span and targets
 *                            separately let 10 Mb x 10 targets through.
 *   pangenome.maxChainSpan   max bp we may fetch to build a chain; default
 *                            10000000.  Separate from maxLiftSpan on purpose:
 *                            that limits what a user may ask for, this limits
 *                            what the server fetches for padding.
 *   pangenome.maxBlocks      max blocks accepted in one translation; default
 *                            200000
 *   pangenome.defaultSrcDb   assembly the conversion page falls back to when it
 *                            has no usable source; default hs1
 *   pangenome.defaultPosition   position to go with it; default is hs1's own
 *                            default view, chr9:145458455-145495201
 *   pangenome.defaultTarget  haplotype pre-selected as the target; default grch38#0
 *   pangenome.maxTargetNodes  cap on graph nodes the reachability scan walks
 *                            when ranking conversion destinations; default 300.
 *                            Bounds the work and keeps false positives out of
 *                            the list.  The mapping server suggests 200-500.
 *   pangenome.minTargetCoverage  when ranking conversion destinations, drop
 *                            haplotypes below this percentage (incidental repeat
 *                            matches); default 10
 *   pangenome.chainPadNear   bp either side of the converted interval that the
 *                            first chain reaches; default 250000, raised to 5x
 *                            the interval, capped by chainPadNearMax
 *   pangenome.chainPadNearMax  ceiling for that; default 1000000
 *   pangenome.chainPadWide   bp either side for the wider chain fetched after
 *                            the user follows the link; default 5000000.  Both
 *                            are clamped so interval+2*pad fits maxLiftSpan.
 *                            Set either to 0 to switch that stage off.
 *   pangenome.maxLiftTargets max target haplotypes in one translation request;
 *                            default 10.  Not a limit on the reader: PanLift
 *                            sends a longer list as several requests, which
 *                            the queue (maxConcurrent) takes in turn.
 *                            Each target is a separate traversal on the mapping
 *                            server, so this is enforced here as well as in the
 *                            page - a request naming all ~464 haplotypes can
 *                            overload it.
 *   pangenome.quickLift      "on"/"off" default for the "show the source's gene
 *                            annotations on the target" checkbox on the
 *                            conversion page; default "on".  The checkbox is
 *                            only offered when browser.quickLift is on, since
 *                            it drives the browser's own QuickLift machinery.
 *   pangenome.annotationRefs references the results page can bring annotations
 *                            from, as "haplotype=db" pairs; default
 *                            "GRCh38#0=hg38,CHM13#0=hs1".  Also needs
 *                            browser.quickLift.
 *   pangenome.annotationDefault  the one chosen when the page opens; default
 *                            "GRCh38#0", "none" for none.  A results URL's
 *                            refAnnot= overrides it.
 *   pangenome.annotationHideOwn  "on" (default) hides the haplotype's own tracks
 *                            when a reference's annotations are brought, as
 *                            PanLift's "hide the target's default tracks" does.
 *   pangenome.svFlank        bp either side of an SV's graph site shown when a
 *                            haplotype is opened there; default 1000
 *   pangenome.maxConcurrent  requests this web server sends the graph server at
 *                            once; the rest wait their turn; default 4, 0 = no queue
 *   pangenome.queueWaitSecs  longest a request waits for its turn; default 120
 *   pangenome.slotDir        where the queue's lock files live; default
 *                            ../trash/hgPangenomeSlots
 *   pangenome.maxSurjectTargets  most haplotypes one batch surjection may
 *                            place; default 500, every haplotype in the graph
 *   pangenome.resultsPlaceAllAtLoad  "off" (default): the results page places
 *                            the rest of a hit's haplotypes only when the
 *                            reader turns to a page that shows one; "on":
 *                            every haplotype of each hit straight after the
 *                            first table is drawn, one batch call at a time
 *   pangenome.resultsShowCoverage  coverage (%) the results table shows by
 *                            default; the reader can move it; default 50
 *   pangenome.apiToken       shared secret sent to the middleware as the
 *                            X-Pangenome-Token header; if empty, no auth header
 *                            is sent (middleware runs auth-off for testing)
 *
 * Abuse protection: submissions (cmd=map) and the page itself are rate-limited
 * via the UCSC bottleneck server (botDelay), exactly like hgBlat; polling
 * (cmd=poll) is exempt.  The maxSequences/maxSeqLen/maxRequestBytes caps are
 * enforced here server-side (the browser's checks are bypassable) and should be
 * kept in sync with the middleware's own limits.
 *   pangenome.maxSequences   max sequences accepted per submit; default 50
 *   pangenome.maxMultimaps   alignments asked for per sequence; default (and
 *                            at most) maxMultimapsLimit.  The form offers no
 *                            choice: every job asks for this many, and the
 *                            results page shows the best placement first and
 *                            the others when they are asked for.
 *   pangenome.maxMultimapsLimit  most that may be asked for; default 3, which
 *                            is the mapping server's own ceiling (it returns
 *                            at most 3 even when asked for more).  Enforced
 *                            here as well as in the page, since the browser's
 *                            max= is bypassable.
 */
/* Copyright 2024 The Regents of the University of California. */
#include "common.h"
#include "linefile.h"
#include "obscure.h"
#include "hash.h"
#include "cheapcgi.h"
#include "htmshell.h"
#include "web.h"
#include "cart.h"
#include "hgConfig.h"
#include "jsHelper.h"
#include "jsonWrite.h"
#include "jsonParse.h"
#include "dystring.h"
#include "hCommon.h"
#include "hui.h"
#include "botDelay.h"
#include "errCatch.h"
#include "portable.h"
#include "net.h"
#include "jksql.h"
#include <fcntl.h>
#include <sys/file.h>
#include "trashDir.h"
#include "pipeline.h"
#include "hdb.h"
#include "cartTrackDb.h"
#include "trackHub.h"
#include "hubConnect.h"
#include "genark.h"
#include "chromAlias.h"
#include "twoBit.h"
#include "quickLift.h"
#include "psl.h"
#include "chain.h"
#include "bigBed.h"
#include "bigChain.h"
#include "bigLink.h"
#include <ctype.h>
#include <curl/curl.h>

/* Cart handling, mirrors the other browser tool CGIs. */
struct cart *cart;
struct hash *oldVars = NULL;
/* Never let the API variables into the cart.  "payload" in particular can be
 * the whole block list for a conversion - saving that would bloat every
 * user's cart row permanently, and a big enough one simply breaks the
 * UPDATE that saves it. */
char *excludeVars[] = {"Submit", "submit", "Clear", "cmd", "payload",
                       "job_id", NULL};

/* Abuse protection.  We use the same UCSC bottleneck/botDelay mechanism as
 * hgBlat.  The backend is expensive (seconds per read), so we apply the full
 * standard penalty rather than hgBlat's 0.5. */
#define delayFraction 1.0
static boolean issueBotWarning = FALSE;

static char *cfgOr(char *name, char *def)
/* hg.conf value or default. */
{
return cfgOptionDefault(name, def);
}

/* ---- Middleware HTTP client (the "ask the other server" layer) ----
 * Uses libcurl, which is already a project dependency (see lib/curlWrap.c and
 * the -lcurl on our link line); no new library is introduced. */

struct pgResp
/* Result of one middleware request. */
    {
    long code;                  /* HTTP status, 0 if the request never completed */
    struct dyString *body;      /* response body (always non-NULL) */
    boolean transportErr;       /* true if curl itself failed (DNS, connect, timeout) */
    char *errMsg;               /* curl error string when transportErr */
    boolean busy;               /* never sent: no turn came up in the queue */
    };

static long pgMaxBody = 0;      /* refuse answers longer than this; 0 = no cap */
static boolean pgTooBig = FALSE;

static size_t pgAccum(void *ptr, size_t size, size_t nmemb, void *userData)
/* libcurl write callback: append received bytes to a dyString.  Past
 * pgMaxBody it takes nothing more, which makes curl give up on the transfer. */
{
struct dyString *dy = userData;
size_t n = size * nmemb;
if (pgMaxBody > 0 && dy->stringSize + (long)n > pgMaxBody)
    {
    pgTooBig = TRUE;
    return 0;
    }
dyStringAppendN(dy, (char *)ptr, n);
return n;
}

/* ---- A queue in front of the graph server -----------------------------------
 *
 * Every request that asks the graph server to do work - a translation, a
 * surjection, a mapping submitted - first takes one of pangenome.maxConcurrent
 * slots on this web server, and waits its turn when they are all taken: a slot
 * is an flock()ed file, held for as long as the request is upstream and let go
 * when it returns, or when the CGI exits however it exits.  So a burst - one
 * reader converting to every haplotype, or ten readers at once - is served a
 * few requests at a time in arrival order rather than all at once, and nobody
 * has to be told there is a limit on what they may ask for.  Reads that cost
 * the server nothing (polling a job, the haplotype list) do not queue. */

static int pgSlotFd = -1;

static boolean pgTakeSlot()
/* Wait for a slot; FALSE if none came free in pangenome.queueWaitSecs.  A
 * server where the slot files cannot be made is not gated, rather than
 * refusing every request. */
{
int slots = atoi(cfgOr("pangenome.maxConcurrent", "4"));
if (slots <= 0)
    return TRUE;
long waitMs = 1000L * atoi(cfgOr("pangenome.queueWaitSecs", "120"));
char *dir = cfgOr("pangenome.slotDir", "../trash/hgPangenomeSlots");
makeDirsOnPath(dir);
long started = clock1000();
for (;;)
    {
    int i;
    for (i = 0; i < slots; ++i)
        {
        char path[PATH_LEN];
        safef(path, sizeof(path), "%s/slot%d", dir, i);
        int fd = open(path, O_RDWR | O_CREAT, 0666);
        if (fd < 0)
            return TRUE;
        if (flock(fd, LOCK_EX | LOCK_NB) == 0)
            {
            pgSlotFd = fd;
            long waited = clock1000() - started;
            if (waited > 1000)
                fprintf(stderr, "hgPangenome: waited %ld ms for one of %d slots\n", waited, slots);
            return TRUE;
            }
        close(fd);
        }
    if (clock1000() - started > waitMs)
        return FALSE;
    sleep1000(200);
    }
}

static void pgFreeSlot()
/* Let the next request in. */
{
if (pgSlotFd >= 0)
    {
    flock(pgSlotFd, LOCK_UN);
    close(pgSlotFd);
    pgSlotFd = -1;
    }
}

static struct pgResp pgHttp(char *url, char *postJson, int timeoutSecs, char *token)
/* Make one request to the middleware.  GET when postJson is NULL, otherwise
 * POST postJson as application/json.  When token is non-empty, send it as the
 * X-Pangenome-Token auth header.  Caller frees resp.body / resp.errMsg. */
{
struct pgResp r;
r.code = 0;
r.body = dyStringNew(4096);
r.transportErr = FALSE;
r.errMsg = NULL;
r.busy = FALSE;

/* Only work queues; a GET reads something already done. */
if (postJson != NULL && !pgTakeSlot())
    {
    r.transportErr = TRUE;
    r.busy = TRUE;
    r.errMsg = cloneString("the pangenome server is busy with other requests; "
                           "please try again in a minute");
    return r;
    }

CURL *curl = curl_easy_init();
if (curl == NULL)
    {
    pgFreeSlot();
    r.transportErr = TRUE;
    r.errMsg = cloneString("cannot initialize curl");
    return r;
    }

struct curl_slist *hdrs = NULL;
hdrs = curl_slist_append(hdrs, "Accept: application/json");
if (isNotEmpty(token))
    {
    struct dyString *auth = dyStringCreate("X-Pangenome-Token: %s", token);
    hdrs = curl_slist_append(hdrs, auth->string);
    dyStringFree(&auth);
    }
curl_easy_setopt(curl, CURLOPT_URL, url);
curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, pgAccum);
curl_easy_setopt(curl, CURLOPT_WRITEDATA, r.body);
curl_easy_setopt(curl, CURLOPT_TIMEOUT, (long)timeoutSecs);
curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
curl_easy_setopt(curl, CURLOPT_USERAGENT, "hgPangenome");
if (postJson != NULL)
    {
    hdrs = curl_slist_append(hdrs, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, postJson);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(postJson));
    }
curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdrs);

CURLcode res = curl_easy_perform(curl);
if (res != CURLE_OK)
    {
    r.transportErr = TRUE;
    r.errMsg = cloneString(curl_easy_strerror(res));
    }
else
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &r.code);

curl_slist_free_all(hdrs);
curl_easy_cleanup(curl);
pgFreeSlot();
return r;
}

static void emitJson(char *json)
/* Write an application/json CGI response (no cart/HTML). */
{
printf("Content-Type: application/json\n\n");
fputs(json, stdout);
}

static void emitJsonError(char *fmt, ...)
/* Emit a {"status":"error","error":"..."} body the JS client understands. */
{
va_list args;
va_start(args, fmt);
struct dyString *dy = dyStringNew(256);
dyStringVaPrintf(dy, fmt, args);
va_end(args);
struct dyString *out = dyStringNew(300);
dyStringPrintf(out, "{\"status\":\"error\",\"error\":\"%s\"}", jsonStringEscape(dy->string));
emitJson(out->string);
dyStringFree(&dy);
dyStringFree(&out);
}

static boolean pgValidJobId(char *s)
/* Job ids go into a URL path, so restrict to a safe charset to avoid any
 * path/SSRF trickery. */
{
if (isEmpty(s) || strlen(s) > 128)
    return FALSE;
char *p;
for (p = s; *p != '\0'; ++p)
    if (!(isalnum((unsigned char)*p) || *p == '_' || *p == '-' || *p == '.'))
        return FALSE;
return TRUE;
}

static void pgJobFaPath(char *jobId, char *buf, int bufSize)
/* Where this job's query sequences are kept.  One file per job, named after it
 * rather than by a fresh trash name, so any later request can find it knowing
 * only the job id. */
{
safef(buf, bufSize, "../trash/pangenomeSs/pangenomeJob_%s.fa", jobId);
}

static boolean pgValidJobId(char *jobId);

static void pgStashQuerySeqs(char *payload, char *response)
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

static int pgSurjectMax()
/* The most haplotypes one batch surjection may place.  The results page asks
 * for its first page's worth, and for every haplotype in the graph only when
 * the reader pages past that - about four seconds for all of them. */
{
return atoi(cfgOr("pangenome.maxSurjectTargets", "500"));
}

static char *pgValidateSurjectAll(char *payload, int maxTargets)
/* The batch surjection: one call places the read on every haplotype that
 * carries it.  Check the job id's charset and hold max_targets to what this
 * install is willing to ask for - the service caps it at 500, but a request
 * for hundreds is seconds of work and the page has no use for them. */
{
static char msg[256];
char *result = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct jsonElement *root = jsonParse(payload);
    char *jobId = jsonOptionalStringField(root, "job_id", NULL);
    char *name = jsonOptionalStringField(root, "name", NULL);
    if (!pgValidJobId(jobId))
        result = "missing or invalid 'job_id'";
    else if (isEmpty(name))
        result = "missing 'name'";
    else
        {
        struct jsonElement *el = jsonFindNamedField(root, "", "max_targets");
        if (el != NULL && el->type == jsonNumber && el->val.jeNumber > maxTargets)
            {
            safef(msg, sizeof(msg), "too many targets: %d (limit is %d)",
                  (int)el->val.jeNumber, maxTargets);
            result = msg;
            }
        el = jsonFindNamedField(root, "", "min_coverage");
        if (result == NULL && el != NULL && el->type == jsonNumber &&
            (el->val.jeNumber < 0 || el->val.jeNumber > 100))
            result = "min_coverage must be between 0 and 100";
        }
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    result = "invalid JSON payload";
errCatchFree(&errCatch);
return result;
}

static char *pgValidatePayload(char *payload, int maxSeqs, int maxSeqLen,
                               int maxMultimaps)
/* Server-side enforcement of the input caps (the browser's checks are
 * bypassable by POSTing straight here).  Parse the map payload and verify the
 * sequence count, per-sequence length and ACGTN charset.  Returns NULL if OK,
 * otherwise a human-readable reason.  Never aborts: malformed JSON is caught
 * and reported as an error.  This is a cheap first pass; the middleware
 * validates authoritatively too. */
{
static char msg[256];
char *result = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct jsonElement *root = jsonParse(payload);
    struct jsonElement *seqsEl = jsonFindNamedField(root, "", "sequences");
    /* Each extra alignment is more work per read upstream, so the ceiling is
     * enforced here too - the page's max= only stops honest mistakes. */
    struct jsonElement *mmEl = jsonFindNamedField(root, "", "options");
    if (mmEl != NULL)
        mmEl = jsonFindNamedField(mmEl, "", "max_multimaps");
    if (mmEl != NULL && mmEl->type == jsonNumber &&
        mmEl->val.jeNumber > maxMultimaps)
        {
        safef(msg, sizeof(msg),
              "too many alignments per sequence: %d (limit is %d)",
              (int)mmEl->val.jeNumber, maxMultimaps);
        result = msg;
        }
    else if (seqsEl == NULL)
        result = "payload is missing 'sequences'";
    else
        {
        struct slRef *list = jsonListVal(seqsEl, "sequences");
        int count = slCount(list);
        if (count < 1)
            result = "no sequences submitted";
        else if (count > maxSeqs)
            {
            safef(msg, sizeof(msg), "too many sequences: %d (limit is %d)", count, maxSeqs);
            result = msg;
            }
        else
            {
            struct slRef *ref;
            for (ref = list; ref != NULL; ref = ref->next)
                {
                struct jsonElement *seqObj = ref->val;
                char *seq = jsonOptionalStringField(seqObj, "sequence", NULL);
                if (seq == NULL)
                    { result = "a sequence entry has no 'sequence'"; break; }
                int n = strlen(seq);
                if (n == 0)
                    { result = "a sequence is empty"; break; }
                if (n > maxSeqLen)
                    {
                    safef(msg, sizeof(msg), "a sequence is %d bp (limit %d)", n, maxSeqLen);
                    result = msg;
                    break;
                    }
                char *p;
                for (p = seq; *p != '\0'; ++p)
                    {
                    char c = toupper((unsigned char)*p);
                    if (c != 'A' && c != 'C' && c != 'G' && c != 'T' && c != 'N')
                        {
                        safef(msg, sizeof(msg),
                              "invalid character in a sequence (only A,C,G,T,N allowed)");
                        result = msg;
                        break;
                        }
                    }
                if (result != NULL) break;
                }
            }
        }
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    result = "invalid JSON payload";
errCatchFree(&errCatch);
return result;
}

static char *pgValidateLiftover(char *payload, long maxSpan, boolean needTgt,
                                int maxTargets)
/* Server-side checks on a coordinate-translation request before we forward it:
 *   src   - full 3-field PanSN contig path (coordinates live on a contig)
 *   start - 0-based, end - exclusive, start < end
 *   span  - within the middleware's cap
 *   tgt   - a haplotype/contig name, or a non-empty array of them (only when
 *           needTgt; the reachability query has no target).  Capped: each target
 *           is a separate graph traversal upstream, and a request naming every
 *           haplotype is enough to overload the mapping server.
 * Returns NULL if OK, otherwise a human-readable reason.  Never aborts. */
{
static char msg[256];
char *result = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct jsonElement *root = jsonParse(payload);
    char *src = jsonOptionalStringField(root, "src", NULL);
    struct jsonElement *startEl = jsonFindNamedField(root, "", "start");
    struct jsonElement *endEl = jsonFindNamedField(root, "", "end");
    struct jsonElement *tgtEl = jsonFindNamedField(root, "", "tgt");

    if (isEmpty(src))
        result = "missing 'src' haplotype path";
    else if (countChars(src, '#') < 2)
        result = "'src' must be a full contig path, e.g. HG00097#1#CM094066.1";
    else if (startEl == NULL || endEl == NULL)
        result = "missing 'start' or 'end'";
    else if (startEl->type != jsonNumber || endEl->type != jsonNumber)
        result = "'start' and 'end' must be numbers";
    else if (needTgt && (tgtEl == NULL ||
             (tgtEl->type != jsonString && tgtEl->type != jsonList)))
        result = "'tgt' must be a haplotype name or an array of them";
    else if (needTgt && tgtEl->type == jsonList && tgtEl->val.jeList == NULL)
        result = "'tgt' array is empty";
    else if (needTgt && tgtEl->type == jsonList &&
             slCount(tgtEl->val.jeList) > maxTargets)
        {
        safef(msg, sizeof(msg),
              "too many target haplotypes: %d (limit is %d per conversion)",
              slCount(tgtEl->val.jeList), maxTargets);
        result = msg;
        }
    else
        {
        long start = startEl->val.jeNumber, end = endEl->val.jeNumber;
        if (start < 0)
            result = "'start' must not be negative";
        else if (end <= start)
            result = "'end' must be greater than 'start'";
        else if (end - start > maxSpan)
            {
            safef(msg, sizeof(msg), "range is %ld bp (limit %ld)", end - start, maxSpan);
            result = msg;
            }
        /* Span and target count are each capped above, but the work is their
         * product: the mapping service traverses the graph once per target and
         * handles one request at a time, so 10 targets x 10 Mb is a hundred
         * target-megabases and about two minutes during which nobody else is
         * served.  Capping each half separately is what allowed that. */
        else if (needTgt)
            {
            long targets = (tgtEl != NULL && tgtEl->type == jsonList)
                           ? slCount(tgtEl->val.jeList) : 1;
            long budgetMb = atol(cfgOr("pangenome.maxLiftTargetMb", "5"));
            long askedMb = ((end - start) * targets + 999999) / 1000000;
            if (budgetMb > 0 && askedMb > budgetMb)
                {
                safef(msg, sizeof(msg),
                      "%ld bp x %ld assemblies is %ld megabase-assemblies "
                      "(limit %ld); convert a smaller range or fewer assemblies",
                      end - start, targets, askedMb, budgetMb);
                result = msg;
                }
            }
        }
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    result = "invalid JSON payload";
errCatchFree(&errCatch);
return result;
}

static char *pgValidateSurject(char *payload)
/* A re-surjection names a target plus either the job whose alignment to reuse
 * or the alignment itself.  Returns NULL if OK, else a reason.  Never aborts. */
{
static char msg[256];
char *result = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct jsonElement *root = jsonParse(payload);
    char *tgt = jsonOptionalStringField(root, "tgt", NULL);
    char *jobId = jsonOptionalStringField(root, "job_id", NULL);
    char *gaf = jsonOptionalStringField(root, "gaf", NULL);
    char *name = jsonOptionalStringField(root, "name", NULL);
    if (isEmpty(tgt))
        result = "missing 'tgt' haplotype";
    else if (isEmpty(jobId) && isEmpty(gaf))
        result = "need either 'job_id' or 'gaf'";
    else if (!isEmpty(jobId) && !pgValidJobId(jobId))
        result = "invalid 'job_id'";
    else if (!isEmpty(jobId) && isEmpty(name))
        result = "missing 'name' of the sequence to re-surject";
    }
errCatchEnd(errCatch);
if (errCatch->gotError)
    result = "invalid JSON payload";
errCatchFree(&errCatch);
if (result != NULL)
    safef(msg, sizeof(msg), "%s", result);
return (result == NULL) ? NULL : msg;
}

static void apiProxy(char *cmd)
/* Forward one browser request to the middleware and stream back its JSON.
 * This is the whole "request the other service for everything" mechanism. */
{
char *apiBase = cloneString(cfgOr("pangenome.apiBase", ""));
int timeout = atoi(cfgOr("pangenome.timeoutSecs", "120"));
char *token = cfgOr("pangenome.apiToken", "");   /* empty => no auth header */

if (isEmpty(apiBase))
    {
    emitJsonError("pangenome.apiBase is not configured on this server");
    return;
    }
/* normalize: drop a single trailing slash so we can append clean paths */
if (endsWith(apiBase, "/"))
    apiBase[strlen(apiBase) - 1] = '\0';

char url[2048];
struct pgResp r;
if (sameString(cmd, "map"))
    {
    char *payload = cgiOptionalString("payload");
    if (isEmpty(payload))
        {
        emitJsonError("missing 'payload'");
        return;
        }
    /* Server-side input caps (do not trust the browser).  These must stay in
     * sync with the middleware's limits; keep them in hg.conf. */
    /* Limits agreed with the middleware team; keep both sides identical. */
    int maxSeqs = atoi(cfgOr("pangenome.maxSequences", "10"));
    int maxSeqLen = atoi(cfgOr("pangenome.maxSeqLen", "100000"));      /* 100 kb / read */
    int maxBytes = atoi(cfgOr("pangenome.maxRequestBytes", "10000000")); /* 10 MB body */
    if (strlen(payload) > (size_t)maxBytes)
        {
        emitJsonError("request too large: %lu bytes (limit %d)",
                      (unsigned long)strlen(payload), maxBytes);
        return;
        }
    int maxMultimaps = atoi(cfgOr("pangenome.maxMultimapsLimit", "3"));
    char *bad = pgValidatePayload(payload, maxSeqs, maxSeqLen, maxMultimaps);
    if (bad != NULL)
        {
        emitJsonError("%s", bad);
        return;
        }
    safef(url, sizeof(url), "%s/api/v1/map", apiBase);
    r = pgHttp(url, payload, timeout, token);
    }
else if (sameString(cmd, "poll"))
    {
    char *jobId = cgiOptionalString("job_id");
    if (!pgValidJobId(jobId))
        {
        emitJsonError("missing or invalid 'job_id'");
        return;
        }
    safef(url, sizeof(url), "%s/api/v1/map/%s", apiBase, jobId);
    r = pgHttp(url, NULL, timeout, token);
    }
else if (sameString(cmd, "liftoverTargets"))
    {
    /* Which haplotypes can this region translate to?  Same payload as a
     * translation, minus the target. */
    char *payload = cgiOptionalString("payload");
    if (isEmpty(payload))
        {
        emitJsonError("missing 'payload'");
        return;
        }
    long maxSpan = atol(cfgOr("pangenome.maxLiftSpan", "1000000"));
    char *bad = pgValidateLiftover(payload, maxSpan, FALSE, 0);
    if (bad != NULL)
        {
        emitJsonError("%s", bad);
        return;
        }
    safef(url, sizeof(url), "%s/api/v1/liftover/targets", apiBase);
    r = pgHttp(url, payload, timeout, token);
    }
else if (sameString(cmd, "surject"))
    {
    /* Re-place an alignment we already have on another haplotype, instead of
     * mapping the read again. */
    char *payload = cgiOptionalString("payload");
    if (isEmpty(payload))
        {
        emitJsonError("missing 'payload'");
        return;
        }
    char *bad = pgValidateSurject(payload);
    if (bad != NULL)
        {
        emitJsonError("%s", bad);
        return;
        }
    safef(url, sizeof(url), "%s/api/v1/surject", apiBase);
    r = pgHttp(url, payload, timeout, token);
    /* A 404 means the job's alignments have aged out of the server's cache.
     * That is the documented fast-path miss, not a failure: answer with a
     * status the page can act on by mapping again. */
    if (!r.transportErr && r.code == 404)
        {
        emitJson("{\"status\":\"expired\"}");
        dyStringFree(&r.body);
        freez(&r.errMsg);
        return;
        }
    }
else if (sameString(cmd, "surjectAll"))
    {
    /* Place the read on every haplotype that carries it, in one call.  The
     * service does a single anchor pass and then surjects in parallel, so this
     * costs about what one surjection used to - where asking one at a time
     * cost one request per row. */
    char *payload = cgiOptionalString("payload");
    if (isEmpty(payload))
        {
        emitJsonError("missing 'payload'");
        return;
        }
    char *bad = pgValidateSurjectAll(payload, pgSurjectMax());
    if (bad != NULL)
        {
        emitJsonError("%s", bad);
        return;
        }
    safef(url, sizeof(url), "%s/api/v1/surject_all", apiBase);
    /* Synchronous and slower than the rest: the service asks for at least 60
     * seconds, so do not let a shorter global timeout cut it off. */
    int batchTimeout = atoi(cfgOr("pangenome.surjectAllTimeoutSecs", "90"));
    r = pgHttp(url, payload, max(timeout, batchTimeout), token);
    /* Same aged-out-of-cache case the single surjection has. */
    if (!r.transportErr && r.code == 404)
        {
        emitJson("{\"status\":\"expired\"}");
        dyStringFree(&r.body);
        freez(&r.errMsg);
        return;
        }
    }
else if (sameString(cmd, "liftoverAll"))
    {
    /* The region on every haplotype, one row each: where it lands and how
     * much of it does.  The service walks the source once for all of them, so
     * this costs about what a single target does.  What goes upstream is
     * rebuilt from the checked fields alone: the target is always "*" in its
     * summary form, never the block list, which for every haplotype runs to
     * about 118,000 rows a megabase. */
    char *payload = cgiOptionalString("payload");
    if (isEmpty(payload))
        {
        emitJsonError("missing 'payload'");
        return;
        }
    long maxSpan = atol(cfgOr("pangenome.maxLiftSpan", "1000000"));
    char *bad = pgValidateLiftover(payload, maxSpan, FALSE, 0);
    if (bad != NULL)
        {
        emitJsonError("%s", bad);
        return;
        }
    struct jsonElement *root = jsonParse(payload);
    struct jsonWrite *jw = jsonWriteNew();
    jsonWriteObjectStart(jw, NULL);
    jsonWriteString(jw, "src", jsonOptionalStringField(root, "src", NULL));
    jsonWriteNumber(jw, "start", (long long)jsonFindNamedField(root, "", "start")->val.jeNumber);
    jsonWriteNumber(jw, "end", (long long)jsonFindNamedField(root, "", "end")->val.jeNumber);
    jsonWriteString(jw, "tgt", "*");
    jsonWriteBoolean(jw, "summary", TRUE);
    jsonWriteObjectEnd(jw);
    safef(url, sizeof(url), "%s/api/v1/liftover", apiBase);
    /* A summary is about 1 kB a haplotype, but in a duplicated or inverted
     * region the service has been seen to report a few haplotypes as one piece
     * per source base: 280 MB for a megabase of 17q21.31, more than this CGI
     * should hold or a browser can draw.  Stop reading and say so instead. */
    pgMaxBody = atol(cfgOr("pangenome.maxLiftAllBytes", "20000000"));
    r = pgHttp(url, jw->dy->string, timeout, token);
    pgMaxBody = 0;
    jsonWriteFree(&jw);
    if (pgTooBig)
        {
        emitJsonError("the graph server's answer for this region is over %ld MB, too "
                      "large to show: in a duplicated or inverted region it can split a "
                      "haplotype into thousands of pieces. Try a smaller region",
                      atol(cfgOr("pangenome.maxLiftAllBytes", "20000000")) / 1000000);
        dyStringFree(&r.body);
        freez(&r.errMsg);
        return;
        }
    }
else if (sameString(cmd, "haplotypes"))
    {
    /* List of haplotypes in the loaded graph, for the conversion picker. */
    safef(url, sizeof(url), "%s/api/v1/haplotypes", apiBase);
    r = pgHttp(url, NULL, timeout, token);
    }
else /* cmd == "liftover" */
    {
    char *payload = cgiOptionalString("payload");
    if (isEmpty(payload))
        {
        emitJsonError("missing 'payload'");
        return;
        }
    long maxSpan = atol(cfgOr("pangenome.maxLiftSpan", "1000000"));
    int maxTargets = atoi(cfgOr("pangenome.maxLiftTargets", "10"));
    char *bad = pgValidateLiftover(payload, maxSpan, TRUE, maxTargets);
    if (bad != NULL)
        {
        emitJsonError("%s", bad);
        return;
        }
    safef(url, sizeof(url), "%s/api/v1/liftover", apiBase);
    r = pgHttp(url, payload, timeout, token);
    }

if (r.busy)
    emitJsonError("%s", r.errMsg);
else if (r.transportErr)
    emitJsonError("could not reach mapping server: %s", r.errMsg ? r.errMsg : "unknown error");
else if (r.code >= 400)
    {
    /* Surface the upstream failure.  When the body is JSON it is the mapping
     * server's own error and worth showing; when it is not (an HTML error page
     * from a proxy in front of it, say) quote nothing - a wall of markup in the
     * message box helps nobody. */
    char *body = skipLeadingSpaces(r.body->string);
    if (body[0] == '{' || body[0] == '[')
        {
        char snippet[400];
        safef(snippet, sizeof(snippet), "%s", body);
        emitJsonError("mapping server returned HTTP %ld: %s", r.code, snippet);
        }
    else if (r.code == 503)
        emitJsonError("the mapping service is unavailable (HTTP 503) - it may be "
                      "restarting; try again shortly");
    else if (r.code == 502 || r.code == 504)
        emitJsonError("could not reach the mapping service through its proxy "
                      "(HTTP %ld); try again shortly", r.code);
    else
        emitJsonError("mapping server returned HTTP %ld", r.code);
    }
else
    {
    /* Keep the query sequences where the results page can find them again. */
    if (sameString(cmd, "map"))
        pgStashQuerySeqs(cgiOptionalString("payload"), r.body->string);
    emitJson(r.body->string);   /* success: pass the middleware answer through verbatim */
    }

dyStringFree(&r.body);
freez(&r.errMsg);
}

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

static struct hash *pgChromSizes(char *db)
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

static char *pgChromSizesFile(char *db, struct hash *sizes, boolean renamed)
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
long maxBlocks = atol(cfgOr("pangenome.maxBlocks", "200000"));
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
/* A saved session gets its own copy under userdata; leave that alone. */
if (name != NULL && strstr(name, "userdata") != NULL)
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

static void pgForgetStaleHubs(char *keepHubFile, boolean missingOnly)
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

static void pgFreshLiftHub(char *db)
/* Empty the quickLift hub file this cart is using for db, so that the next
 * trackHubBuild() writes only what the source is showing now.
 *
 * trackHubBuild merges its stanzas into whatever the file already holds, and
 * keeps any stanza it did not generate this time - deliberately, so that for
 * hgConvert a track lifted earlier is not lost.  For PanLift that is the wrong
 * contract: adjusting which tracks you want and converting again is the normal
 * way to use it, so the hub grows into the union of everything ever switched on
 * during the session, and a track turned off on the source goes on appearing on
 * the target.  Emptying the file first makes each conversion a snapshot.
 *
 * Truncated rather than deleted: getHubName() keeps the name in the cart only
 * while the file still opens, so deleting it would mint a new name, and a new
 * name is a new hub attached to the cart beside the old one. */
{
char var[PATH_LEN];
safef(var, sizeof(var), "hubQuickLift-%s", db);
char *path = cartOptionalString(cart, var);
if (isEmpty(path) || !fileExists(path))
    return;
FILE *f = fopen(path, "w");
if (f == NULL)
    fprintf(stderr, "hgPangenome: could not empty %s: %s\n", path, strerror(errno));
else
    carefulClose(&f);
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
char *built = NULL;
pgFreshLiftHub(srcDb);
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    built = trackHubBuild(srcDb, cart, &badList);
errCatchEnd(errCatch);
if (errCatch->gotError || isEmpty(built))
    {
    fprintf(stderr, "hgPangenome: trackHubBuild(%s) failed: %s\n", srcDb,
            errCatch->gotError ? trimSpaces(errCatch->message->string) : "no hub written");
    errCatchFree(&errCatch);
    return NULL;
    }
errCatchFree(&errCatch);

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

/* Name the chain relative to the hub - they land in the same trash directory.
 * Every setting whose name ends in "Url" is resolved against the hub's own
 * location when the hub is read, so handing over the path we opened it by
 * would resolve a second time and look for it underneath itself. */
char *chainRel = strrchr(chainBb, '/');
chainRel = (chainRel == NULL) ? chainBb : chainRel + 1;

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
        safef(label, sizeof(label), "%s",
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

static boolean pgValidDb(char *db)
/* Assembly names reach us from the page and end up in file paths and cart
 * variables, so keep them to the shape a db name actually has. */
{
if (isEmpty(db) || strlen(db) > 128)
    return FALSE;
char *p;
for (p = db; *p != '\0'; ++p)
    if (!(isalnum((unsigned char)*p) || *p == '_' || *p == '.' || *p == '-'))
        return FALSE;
return TRUE;
}

static boolean pgSafeToken(char *tok)
/* A sample name, a phase or a sequence name on its way into a file path.
 * The same shape pgValidDb insists on, named for the wider use. */
{
return pgValidDb(tok);
}

static char *pgAttachAssembly(char *db)
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
     * database change - and that silently discards "ss", the very thing we are
     * about to set. */
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

static void pgRestoreDb(char *savedDb)
/* Put the cart's db back: we borrow it to reach the two assemblies, and the
 * conversion page must not find it changed underneath. */
{
if (isEmpty(savedDb))
    cartRemove(cart, "db");
else
    cartSetString(cart, "db", savedDb);
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
/* Deliberately not maxLiftSpan.  That caps what a *user* may ask to translate
 * and is set low to protect a service that handles one request at a time; this
 * caps what *we* fetch to build a chain, which is a different question.  Tying
 * the two together silently shrank the wide chain to nothing the moment
 * maxLiftSpan was lowered, and panning quietly stopped working. */
long maxSpan = atol(cfgOr("pangenome.maxChainSpan", "10000000"));
long pad = wide ? atol(cfgOr("pangenome.chainPadWide", "5000000"))
                : atol(cfgOr("pangenome.chainPadNear", "250000"));
if (pad <= 0 || span <= 0)
    return 0;
/* Proportional for the near pad, so a gene-sized conversion gets room to pan
 * in window-widths rather than in a fixed number of bases that means something
 * quite different at either end of the zoom range. */
if (!wide)
    {
    long proportional = span * 5;
    if (proportional > pad)
        pad = proportional;
    long ceiling = atol(cfgOr("pangenome.chainPadNearMax", "1000000"));
    if (pad > ceiling)
        pad = ceiling;
    }
/* The service refuses anything wider than maxLiftSpan, so the pad has to fit
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
char *apiBase = cloneString(cfgOr("pangenome.apiBase", ""));
if (isEmpty(apiBase))
    { *retError = "pangenome.apiBase is not configured"; return NULL; }
if (endsWith(apiBase, "/"))
    apiBase[strlen(apiBase) - 1] = '\0';
int timeout = atoi(cfgOr("pangenome.timeoutSecs", "120"));
char *token = cfgOr("pangenome.apiToken", "");

struct dyString *body = dyStringNew(256);
dyStringPrintf(body, "{\"src\":\"%s\",\"start\":%ld,\"end\":%ld,"
                     "\"tgt\":\"%s\",\"blocks\":true}",
               jsonStringEscape(srcPath), start, end, jsonStringEscape(tgt));
char url[2048];
safef(url, sizeof(url), "%s/api/v1/liftover", apiBase);
struct pgResp r = pgHttp(url, body->string, timeout, token);
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
if (r.code >= 400)
    {
    /* Quote the upstream body when it is JSON - "service starting; indexes not
     * loaded yet" is the difference between "try again shortly" and "this
     * region cannot be lifted", and the user cannot tell those apart from a
     * generic failure. */
    char *body = skipLeadingSpaces(r.body->string);
    if (body[0] == '{' || body[0] == '[')
        safef(why, sizeof(why), "mapping server returned HTTP %ld: %s", r.code, body);
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
char *apiBase = cloneString(cfgOr("pangenome.apiBase", ""));
if (isEmpty(apiBase))
    { *retError = "pangenome.apiBase is not configured"; return FALSE; }
if (endsWith(apiBase, "/"))
    apiBase[strlen(apiBase) - 1] = '\0';
struct dyString *body = dyStringNew(256);
dyStringPrintf(body, "{\"src\":\"%s\",\"start\":%ld,\"end\":%ld,\"tgt\":\"%s\"}",
               jsonStringEscape(srcPath), start, end, jsonStringEscape(tgt));
char url[2048];
safef(url, sizeof(url), "%s/api/v1/liftover", apiBase);
struct pgResp r = pgHttp(url, body->string,
                         atoi(cfgOr("pangenome.timeoutSecs", "120")),
                         cfgOr("pangenome.apiToken", ""));
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
if (r.code >= 400)
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
    safef(why, sizeof(why), "this region has no counterpart on %s", tgt);
    *retError = why;
    return FALSE;
    }
return TRUE;
}

static void doContigs()
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

static void doLiftCheck()
/* Can this assembly's annotations be carried over at all?
 *
 * Asked by the conversion page before the user submits, so that "nothing is
 * showing on this assembly" is said while they can still do something about
 * it, rather than after the conversion has run.  It is the same question
 * doQuickLift answers, so it is answered by the same code: trackHubBuild picks
 * the tracks, and we count what it wrote.
 *
 * Needs the cart - that is where the visibilities are - so it comes through
 * the cart shell and writes its own JSON header. */
{
char *db = cgiOptionalString("db");
if (!pgValidDb(db))
    {
    emitJsonError("missing or malformed assembly name");
    return;
    }
char *savedDb = cloneString(cartUsualString(cart, "db", ""));
char *srcName = pgAttachAssembly(db);
cartSetString(cart, "db", srcName);

struct trackDb *badList = NULL;
char *built = NULL;
pgFreshLiftHub(srcName);
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    built = trackHubBuild(srcName, cart, &badList);
errCatchEnd(errCatch);
boolean failed = errCatch->gotError;
errCatchFree(&errCatch);
pgRestoreDb(savedDb);

if (failed || isEmpty(built))
    {
    /* Not an answer, but not a reason to stop the user either: the conversion
     * itself will report whatever is really wrong. */
    emitJson("{\"status\":\"ok\",\"tracks\":null}");
    return;
    }

/* One "track" line per stanza.  Counting them is enough: the question is only
 * whether anything at all came through. */
int count = 0;
struct lineFile *lf = lineFileMayOpen(built, TRUE);
if (lf != NULL)
    {
    char *line;
    while (lineFileNext(lf, &line, NULL))
        if (startsWith("track ", skipLeadingSpaces(line)))
            count++;
    lineFileClose(&lf);
    }

struct dyString *skipped = dyStringNew(256);
struct trackDb *bad;
for (bad = badList; bad != NULL; bad = bad->next)
    pgNote(skipped, bad);

struct dyString *out = dyStringNew(300);
dyStringPrintf(out, "{\"status\":\"ok\",\"tracks\":%d", count);
if (skipped->stringSize > 0)
    dyStringPrintf(out, ",\"skipped\":\"%s\"", jsonStringEscape(skipped->string));
dyStringAppend(out, "}");
emitJson(out->string);
dyStringFree(&out);
dyStringFree(&skipped);
}

static void doQuickLift(char *payload, boolean wide)
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
cartSetString(cart, "db", srcDb);
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
long padded = 0;
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
            padded = to - from;
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
/* How much source sequence the chain covers.  The page uses this to decide
 * whether asking for a wider one is worth it, and it is the honest answer to
 * "how far can I pan before the annotations stop". */
if (padded > 0)
    dyStringPrintf(out, ",\"chainSpan\":%ld", padded);
dyStringAppend(out, "}");
emitJson(out->string);
dyStringFree(&out);
dyStringFree(&url);
}

/* ---- A reference's annotations on a mapped haplotype ----------------------
 *
 * The results page opens a haplotype with the user's sequence drawn on it.
 * With a reference chosen, the tracks the user has turned on in that reference
 * come too: the hit's region is translated to the reference through the graph,
 * and that interval is handed to doQuickLift() as a conversion from the
 * reference onto the haplotype - the same path PanLift's "PanLift tracks"
 * takes, chain from the graph and all, so neither depends on precomputed chain
 * files. */

static struct slPair *pgAnnotRefs()
/* The references whose annotations can be brought, from
 * pangenome.annotationRefs: "haplotype=db" pairs, comma separated.  A future
 * reference is one more pair. */
{
static struct slPair *refs = NULL;
static boolean done = FALSE;
if (done)
    return refs;
done = TRUE;
char *spec = cloneString(cfgOr("pangenome.annotationRefs", "GRCh38#0=hg38,CHM13#0=hs1"));
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

static char *pgRefLabel(char *hap)
/* "GRCh38#0" -> "GRCh38", for the hub's label and the page. */
{
char *label = cloneString(hap);
char *hash = strchr(label, '#');
if (hash != NULL)
    *hash = '\0';
return label;
}

static void doRefAnnot()
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
long maxSpan = atol(cfgOr("pangenome.maxLiftSpan", "1000000"));
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
 * it: doQuickLift() pads the interval, fetches the blocks and builds the rest.
 * The haplotype's own tracks are hidden, so the page opens on the reference's
 * annotations and the user's sequence rather than two gene sets on top of
 * each other; the user can turn them back on in the browser. */
boolean hideOwn = sameString(cfgOr("pangenome.annotationHideOwn", "on"), "on");
struct dyString *ql = dyStringNew(512);
dyStringPrintf(ql, "{\"srcDb\":\"%s\",\"tgtDb\":\"%s\",\"src\":\"%s\","
                   "\"srcHap\":\"%s\",\"srcStart\":%ld,\"srcEnd\":%ld,"
                   "\"tgt\":\"%s\",\"position\":\"%s\",\"hideTracks\":\"%s\"}",
               jsonStringEscape(refDb), jsonStringEscape(db), jsonStringEscape(refPath),
               jsonStringEscape(pgRefLabel(ref)), refStart, refEnd,
               jsonStringEscape(hap), jsonStringEscape(position), hideOwn ? "on" : "off");
doQuickLift(ql->string, FALSE);
dyStringFree(&ql);
}

/* ---- One haplotype at a structural variant's site --------------------------
 *
 * The details page of an item on the HPRC v2.1 SV track lists the haplotypes
 * that carry it (hgc/pangenomeCarriersClick.c), and each name links here: the
 * SV's graph site, translated from the reference to that haplotype through the
 * graph, opened in the browser with the reference's tracks carried across -
 * the way the results page opens a hit.  page=svOpen is the step between the
 * two, and cmd=svOpen does the work. */

static char *pgRefHapForDb(char *db)
/* The graph's name for a reference assembly ("hg38" -> "GRCh38#0"), from the
 * same pairs the results page brings annotations from. */
{
struct slPair *rp;
for (rp = pgAnnotRefs(); rp != NULL; rp = rp->next)
    if (sameString((char *)rp->val, db))
        return rp->name;
return NULL;
}

static void doSvOpen()
/* Open one haplotype at an SV's site: translate the site, with a flank either
 * side, from the reference to the haplotype through the graph, and open the
 * browser there - with the reference's tracks carried across, as the results
 * page does, unless the page asks for the haplotype alone. */
{
char *payload = cgiOptionalString("payload");
struct jsonElement *root = NULL;
if (!isEmpty(payload))
    {
    struct errCatch *errCatch = errCatchNew();
    if (errCatchStart(errCatch))
        root = jsonParse(payload);
    errCatchEnd(errCatch);
    errCatchFree(&errCatch);
    }
if (root == NULL)
    {
    emitJsonError("missing or invalid JSON payload");
    return;
    }
char *db = jsonOptionalStringField(root, "db", NULL);
if (db != NULL)
    db = trackHubSkipHubName(db);
char *chrom = jsonOptionalStringField(root, "chrom", NULL);
char *hap = jsonOptionalStringField(root, "hap", NULL);
char *hapDb = jsonOptionalStringField(root, "hapDb", NULL);
boolean annot = sameOk(jsonOptionalStringField(root, "annot", "on"), "on");
struct jsonElement *sEl = jsonFindNamedField(root, "", "start");
struct jsonElement *eEl = jsonFindNamedField(root, "", "end");
char *refHap = pgValidDb(db) ? pgRefHapForDb(db) : NULL;
if (refHap == NULL || !pgSafeToken(chrom) || isEmpty(hap) || countChars(hap, '#') != 1 ||
    !pgValidDb(hapDb))
    {
    emitJsonError("missing or malformed assembly, sequence or haplotype");
    return;
    }
if (sEl == NULL || eEl == NULL || sEl->type != jsonNumber || eEl->type != jsonNumber ||
    sEl->val.jeNumber < 0 || eEl->val.jeNumber <= sEl->val.jeNumber)
    {
    emitJsonError("missing or malformed start and end");
    return;
    }
long flank = atol(cfgOr("pangenome.svFlank", "1000"));
long start = (long)sEl->val.jeNumber - flank, end = (long)eEl->val.jeNumber + flank;
if (start < 0)
    start = 0;
struct hash *sizes = pgChromSizes(db);
long size = sizes ? hashIntValDefault(sizes, chrom, 0) : 0;
if (size > 0 && end > size)
    end = size;
long maxSpan = atol(cfgOr("pangenome.maxLiftSpan", "1000000"));
if (end - start > maxSpan)
    {
    emitJsonError("this site is longer than the %ld bp a translation may cover", maxSpan);
    return;
    }

/* The reference itself needs no translating. */
struct dyString *out = dyStringNew(512);
if (sameWord(hap, refHap))
    {
    char position[256];
    safef(position, sizeof(position), "%s:%ld-%ld", chrom, start + 1, end);
    dyStringPrintf(out, "{\"status\":\"ok\",\"url\":\"hgTracks?db=%s&position=%s\"}",
                   db, cgiEncode(position));
    emitJson(out->string);
    return;
    }

char refPath[512];
safef(refPath, sizeof(refPath), "%s#%s", refHap, chrom);
char *hapPath = NULL, *err = NULL;
long hapStart = 0, hapEnd = 0;
if (!pgLiftInterval(refPath, hap, start, end, &hapPath, &hapStart, &hapEnd, &err))
    {
    /* "stage" tells the page that leaving the tracks behind would not help:
     * the site itself has nowhere to go. */
    struct dyString *out = dyStringNew(300);
    dyStringPrintf(out, "{\"status\":\"error\",\"stage\":\"translate\",\"error\":\"%s\"}",
                   jsonStringEscape(err));
    emitJson(out->string);
    return;
    }
char position[512];
safef(position, sizeof(position), "%s:%ld-%ld", pgContigOf(hapPath), hapStart + 1, hapEnd);

if (!annot || !quickLiftEnabled(cart))
    {
    dyStringPrintf(out, "{\"status\":\"ok\",\"url\":\"hgTracks?db=%s&position=%s\"}",
                   hapDb, cgiEncode(position));
    emitJson(out->string);
    return;
    }
/* As doRefAnnot hands it over: a conversion from the reference onto the
 * haplotype, of the interval just translated. */
boolean hideOwn = sameString(cfgOr("pangenome.annotationHideOwn", "on"), "on");
dyStringPrintf(out, "{\"srcDb\":\"%s\",\"tgtDb\":\"%s\",\"src\":\"%s\","
                    "\"srcHap\":\"%s\",\"srcStart\":%ld,\"srcEnd\":%ld,"
                    "\"tgt\":\"%s\",\"position\":\"%s\",\"hideTracks\":\"%s\"}",
               jsonStringEscape(db), jsonStringEscape(hapDb), jsonStringEscape(refPath),
               jsonStringEscape(pgRefLabel(refHap)), start, end,
               jsonStringEscape(hap), jsonStringEscape(position), hideOwn ? "on" : "off");
doQuickLift(out->string, FALSE);
dyStringFree(&out);
}

/* ---- The mapped sequence as a track on the target ------------------------
 *
 * BLAT hands its results to the browser by writing a PSL and a FASTA into
 * trash and linking with "ss=<psl>+<fa>"; hgTracks then draws the native "Your
 * Sequence from Blat Search" track, with the query bases coloured against the
 * assembly (see userPslTg() in hgTracks).  Doing the same here means the read
 * is drawn the way a browser user already expects, rather than as a plain
 * custom track.
 *
 * Note the PSL's tName has to be the sequence name hgTracks itself uses -
 * loadUserPsl() compares it to chromName with sameString(), no chromAlias in
 * between - which for a GenArk assembly is the accession, not the chrN alias.
 * That is the opposite of the chain we write for quickLift, where the bigBed
 * is opened through chromAliasFindAliases and so wants the display name. */

static boolean pgWritePsl(char *path, boolean append, char *qName, int qSize, char *cigar,
                          char *tName, int tSize, int tStart, char strand,
                          int qStart, int *retTEnd, char **retError)
/* One PSL line for the alignment.  M/=/X advance both sides, I the query, D/N
 * the target - the same expansion a CIGAR gets anywhere else.
 *
 * Expanding the CIGAR is ours; the record itself is kent's.  We fill in a
 * struct psl and let pslTabOut() write it, rather than printing twenty-one
 * tab-separated fields in an order we had to get right by hand. */
{
static char msg[256];
int q = qStart, t = tStart;
int blocks = 0, aligned = 0;
int qNumIns = 0, qBaseIns = 0, tNumIns = 0, tBaseIns = 0;

/* Two passes: one to count the blocks so the arrays can be sized, one to fill
 * them.  A CIGAR cannot have more blocks than it has operations. */
int maxBlocks = 1;
char *c;
for (c = cigar; c != NULL && *c != '\0'; ++c)
    if (!isdigit((unsigned char)*c))
        ++maxBlocks;

unsigned *blockSizes, *qStarts, *tStarts;
AllocArray(blockSizes, maxBlocks);
AllocArray(qStarts, maxBlocks);
AllocArray(tStarts, maxBlocks);

char *p = cigar;
while (p != NULL && *p != '\0')
    {
    char *end;
    long n = strtol(p, &end, 10);
    if (end == p || *end == '\0')
        break;
    char op = *end;
    p = end + 1;
    if (op == 'M' || op == '=' || op == 'X')
        {
        if (blocks < maxBlocks)
            {
            blockSizes[blocks] = n;
            qStarts[blocks] = q;
            tStarts[blocks] = t;
            ++blocks;
            }
        aligned += n;
        q += n;
        t += n;
        }
    else if (op == 'I')
        { ++qNumIns; qBaseIns += n; q += n; }
    else if (op == 'D' || op == 'N')
        { ++tNumIns; tBaseIns += n; t += n; }
    else if (op == 'S' || op == 'H')
        q += n;
    }

if (blocks == 0)
    {
    safef(msg, sizeof(msg), "the alignment has no aligned blocks to draw");
    *retError = msg;
    freeMem(blockSizes); freeMem(qStarts); freeMem(tStarts);
    return FALSE;
    }

struct psl psl;
ZeroVar(&psl);
/* match is the aligned length: the mapping server does not tell us how many of
 * those bases actually agree.  It only affects the numbers on the details page
 * - the per-base mismatch colouring is done by hgTracks itself, from the FASTA
 * against the assembly, so what is drawn is right either way. */
psl.match = aligned;
psl.qNumInsert = qNumIns;
psl.qBaseInsert = qBaseIns;
psl.tNumInsert = tNumIns;
psl.tBaseInsert = tBaseIns;
psl.strand[0] = strand;
psl.qName = qName;
psl.qSize = qSize;
psl.qStart = qStart;
psl.qEnd = q;
psl.tName = tName;
psl.tSize = tSize;
psl.tStart = tStart;
psl.tEnd = t;
psl.blockCount = blocks;
psl.blockSizes = blockSizes;
psl.qStarts = qStarts;
psl.tStarts = tStarts;

FILE *f = mustOpen(path, append ? "a" : "w");
pslTabOut(&psl, f);
carefulClose(&f);

freeMem(blockSizes); freeMem(qStarts); freeMem(tStarts);
if (retTEnd != NULL)
    *retTEnd = t;
return TRUE;
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

static void pgJsonQuerySeqs(struct jsonWrite *jw, char *field, char *jobId)
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

static void doLocus()
/* The locus words for each interval in the payload, in order:
 *   {"items":[{"db":"GCA_...","contig":"CM094060.1","start":0,"end":10}, ...]}
 * answers {"status":"ok","loci":["exon ATAD3B", null, ...]}, null where there
 * is nothing to say - a hub assembly, or no genes near enough.  Files and
 * connections are opened once per assembly in the request. */
{
char *payload = cgiOptionalString("payload");
if (isEmpty(payload))
    {
    emitJsonError("missing payload");
    return;
    }
struct dyString *out = dyStringNew(4096);
dyStringAppend(out, "{\"status\":\"ok\",\"loci\":[");
char *parseError = NULL;
struct hash *bbiByDb = hashNew(6), *connByDb = hashNew(4);
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
                sEl->val.jeNumber >= 0 && eEl->val.jeNumber > sEl->val.jeNumber)
                {
                int start = sEl->val.jeNumber, end = eEl->val.jeNumber;
                struct hashEl *conn = hashLookup(connByDb, db);
                if (conn == NULL)
                    {
                    /* A connection only to a native assembly with the table. */
                    struct sqlConnection *c = NULL;
                    if (!startsWith("GCA_", db) && !startsWith("GCF_", db) && hDbExists(db))
                        {
                        c = hAllocConn(db);
                        if (!sqlTableExists(c, "locusName"))
                            hFreeConn(&c);
                        }
                    conn = hashAdd(connByDb, db, c);
                    }
                if (conn->val != NULL)
                    locus = hLocusName(conn->val, contig, start, end);
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
helList = hashElListHash(connByDb);
for (hel = helList; hel != NULL; hel = hel->next)
    if (hel->val != NULL)
        {
        struct sqlConnection *conn = hel->val;
        hFreeConn(&conn);
        }
hashElFreeList(&helList);
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

static void doPclai()
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
int maxHaps = atoi(cfgOr("pangenome.pclaiMaxHaplotypes", "100"));
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
            int start = (int)sEl->val.jeNumber;
            int end = (int)eEl->val.jeNumber;
            if (start < 0 || end <= start)
                continue;
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
char *cfgPanel = cfgOption("pangenome.pclaiRefPanel");
if (cfgPanel != NULL)
    safef(panelPath, sizeof(panelPath), "%s", cfgPanel);
else if (panelDir != NULL)
    safef(panelPath, sizeof(panelPath), "%s/pclaiRefPanel.json", panelDir);
else
    panelPath[0] = '\0';
char *panel = NULL;
size_t panelSize = 0;
if (panelPath[0] != '\0' && fileExists(panelPath))
    readInGulp(panelPath, &panel, &panelSize);
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

#define PG_MAX_OTHER_HITS 50    /* more than any install asks the mapper for */

static void doAlignTrack()
/* Write the PSL/FASTA pair BLAT uses, and hand back a browser URL that draws
 * the read on the target.  Runs with the cart: "ss" has to be put there
 * directly, because the browser drops it when the database changes and
 * following this link to another assembly is exactly that. */
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
/* hgTracks holds chromName as the assembly's own sequence name - the accession
 * on a GenArk assembly - and loadUserPsl() compares a PSL's tName against it
 * with sameString(), no alias in between.  The chrN alias is only what gets
 * displayed, so the PSL and the position both use the name we were given. */
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
                tStart, (strand[0] == '-') ? '-' : '+', 0, &tEnd, &err))
    { emitJsonError("%s", err); return; }
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
                       (int)oStart->val.jeNumber, (oStrand[0] == '-') ? '-' : '+', 0,
                       NULL, &oErr))
            ++n;
        }
    }

struct dyString *url = dyStringNew(600);
/* The browser clears "ss" whenever the database changes (web.c, "hgBlat results
 * (hgUserPsl track)"), and following a link from here to another assembly is
 * exactly that.  So put the database, the position and ss into the cart now:
 * by the time hgTracks runs, its db is already the target and nothing looks
 * like a change.  The name has to be the one the browser resolves to, which for
 * a GenArk assembly is the decorated hub_<id>_ form. */
/* Open on the whole alignment, not its first base: loadUserPsl only keeps a
 * PSL that overlaps the window, and a one-base window shows nothing useful
 * even when it technically does overlap.  A little padding either side keeps
 * the read off the edges. */
int pad = (tEnd - tStart) / 10 + 20;
int viewStart = tStart - pad;
int viewEnd = tEnd + pad;
if (viewStart < 0)
    viewStart = 0;
if (viewEnd > tSize)
    viewEnd = tSize;
char *viewDb = pgAttachAssembly(db);
char pos[512], ss[2048];
safef(pos, sizeof(pos), "%s:%d-%d", viewChrom, viewStart + 1, viewEnd);
safef(ss, sizeof(ss), "%s %s", pslTn.forCgi, faTn.forCgi);
cartSetString(cart, "db", viewDb);
cartSetString(cart, "position", pos);
cartSetString(cart, "ss", ss);
if (dropLifts)
    pgForgetStaleHubs(NULL, FALSE);
/* Name the track for this tool rather than leaving hgBlat's label on it. */
cartSetString(cart, "ssShortLabel", "Pangenome Seq");
cartSetString(cart, "ssLongLabel", "Your Sequence from Pangenome Mapping");
dyStringPrintf(url, "hgTracks?db=%s&position=%s",
               cgiEncode(viewDb), cgiEncode(pos));
/* The alignment details page, the same one hgBlat's "details" link opens:
 * hgc's htcUserAli takes the psl, the fasta and the query name in "i". */
struct dyString *details = dyStringNew(700);
dyStringPrintf(details,
               "hgc?o=%d&g=htcUserAli&i=%s+%s+%s&c=%s&l=%d&r=%d&db=%s",
               tStart, cgiEncode(pslTn.forCgi), cgiEncode(faTn.forCgi),
               cgiEncode(name), cgiEncode(viewChrom), tStart, tEnd,
               cgiEncode(viewDb));
struct dyString *out = dyStringNew(700);
dyStringPrintf(out, "{\"status\":\"ok\",\"url\":\"%s\","
                    "\"details\":\"%s\"}",
               jsonStringEscape(url->string), jsonStringEscape(details->string));
emitJson(out->string);
dyStringFree(&out);
dyStringFree(&details);
dyStringFree(&url);
}

static void injectConfig()
/* Emit window.pangenomeConfig as an inline (CSP-nonced) script.  The app in
 * hgPangenome.js reads this on DOMContentLoaded, which fires after inline
 * scripts have run, so ordering relative to the external <script src> is safe. */
{
char *apiBase = cfgOr("pangenome.apiBase", "");
/* Default to the mock when no API base is configured, so a fresh install
 * (or a developer with no live server) still gets a working page. */
char *useMockDef = isEmpty(apiBase) ? "on" : "off";
boolean useMock = sameString(cfgOr("pangenome.useMock", useMockDef), "on");
char *transport = cfgOr("pangenome.transport", "job");
int pollMs = atoi(cfgOr("pangenome.pollIntervalMs", "1500"));
int maxSeq = atoi(cfgOr("pangenome.maxSequences", "10"));
int maxMultimapsLimit = atoi(cfgOr("pangenome.maxMultimapsLimit", "3"));
int maxMultimaps = atoi(cfgOr("pangenome.maxMultimaps", cfgOr("pangenome.maxMultimapsLimit", "3")));
if (maxMultimaps > maxMultimapsLimit)
    maxMultimaps = maxMultimapsLimit;
if (maxMultimaps < 1)
    maxMultimaps = 1;

/* apiBase and transport are admin-controlled; still route them through the
 * JS-string escaper to be safe. */
/* Note: the middleware base URL is deliberately NOT sent to the browser; the
 * browser only ever talks to this CGI (same origin).  useMock lets the JS run
 * against its built-in mock when no middleware is configured. */
jsInlineF("window.pangenomeConfig = {\n"
          "  useMock: %s,\n"
          "  transport: \"%s\",\n"
          "  pollIntervalMs: %d,\n"
          "  maxSequences: %d,\n"
          "  maxMultimaps: %d,\n"
          "  minHapCoverage: %s,\n"
          "  maxLiftSpan: %ld,\n"
          "  defaultSrcDb: \"%s\",\n"
          "  defaultPosition: \"%s\",\n"
          "  defaultTarget: \"%s\",\n"
          "  presetTarget: \"%s\",\n"
          "  presetAnnot: \"%s\",\n"
          "  presetHide: \"%s\",\n"
          "  minTargetCoverage: %s,\n"
          "  maxTargetNodes: %s,\n"
          "  maxLiftTargets: %d,\n"
          "  maxLiftTargetMb: %ld,\n"
          "  hgsid: \"%s\",\n"
          "  quickLiftEnabled: %s,\n"
          "  quickLift: %s,\n"
          /* The search page hands off to the results table when a job
           * finishes.  hg.conf can turn that off to get the old in-page
           * cards back without a rebuild. */
          "  resultsPage: %s\n"
          "};\n",
          useMock ? "true" : "false",
          jsonStringEscape(transport),
          pollMs, maxSeq, maxMultimaps,
          /* empty => let the middleware use its own default */
          isEmpty(cfgOr("pangenome.minHapCoverage", ""))
              ? "null" : cfgOr("pangenome.minHapCoverage", ""),
          atol(cfgOr("pangenome.maxLiftSpan", "1000000")),
          jsonStringEscape(cfgOr("pangenome.defaultSrcDb", "hs1")),
          jsonStringEscape(cfgOr("pangenome.defaultPosition",
                                 "chr9:145458455-145495201")),
          jsonStringEscape(cfgOr("pangenome.defaultTarget", "grch38#0")),
          /* hgConvert sends the assembly the user picked there, so the page
           * opens on it rather than on the configured default. */
          jsonStringEscape(cgiUsualString("pgTarget", "")),
          jsonStringEscape(cgiUsualString("pgAnnot", "")),
          jsonStringEscape(cgiUsualString("pgHide", "")),
          cfgOr("pangenome.minTargetCoverage", "10"),
          cfgOr("pangenome.maxTargetNodes", "300"),
          atoi(cfgOr("pangenome.maxLiftTargets", "10")),
          atol(cfgOr("pangenome.maxLiftTargetMb", "5")),
          cartSessionId(cart),
          quickLiftEnabled(cart) ? "true" : "false",
          sameString(cfgOr("pangenome.quickLift", "on"), "on") ? "true" : "false",
          sameString(cfgOr("pangenome.resultsPage", "on"), "on") ? "true" : "false");
}

static void drawForm()
/* The search form, built in the browser the way hgBlat's new form is built by
 * hgBlat.js: this emits an empty .gbApp container and the form's settings as an
 * inline hgPangenomeFormData object, and hgPangenome.js lays the controls out
 * inside it.  Unlike BLAT's, the form never posts to this CGI - hgPangenome.js
 * reads the controls, submits the job itself and polls it - so there is no
 * <form> for the browser to serialize, only the container.
 *
 * The limits the job is held to (pangenome.maxSequences, maxMultimaps) are in
 * window.pangenomeConfig already; this carries only what the form adds. */
{
printf("<div id='pgFormBox' class='gbApp'></div>\n");
/* Progress and errors, and the in-page result cards for an install that has
 * turned the results page off.  Emitted here rather than built by the script,
 * so that the page has somewhere to say what went wrong even when the script
 * cannot run; hgPangenome.js moves the status box into the form, beside the
 * buttons it reports on. */
printf("<div id='pgStatus' class='pgStatus' style='display:none'></div>\n");
printf("<div id='pgResults' class='pgResults'></div>\n");

struct jsonWrite *jw = jsonWriteNew();
jsonWriteObjectStart(jw, NULL);
/* The per-sequence length the server enforces, so the character counter can
 * say a sequence is too long before it is submitted rather than after. */
jsonWriteNumber(jw, "maxSeqLen", atol(cfgOr("pangenome.maxSeqLen", "100000")));
/* What is being searched, named on the form so that nobody has to guess which
 * graph a result came from.  A setting, because the graph is a deployment
 * choice and changes with each HPRC release. */
jsonWriteString(jw, "graphLabel",
                cfgOr("pangenome.graphLabel",
                      "Human Pangenome Reference Consortium, release 2"));
/* Fetched on demand, as hgBlat's is, rather than carried in every page load. */
jsonWriteString(jw, "exampleUrl", "../goldenPath/help/pangenomeExample.fa");
jsonWriteString(jw, "exampleLabel", "Load example");
jsonWriteString(jw, "exampleTitle", "Fill the box with an example query: "
    "20 kb of the human MCM6 gene, which every haplotype in the graph carries.");
jsonWriteStringf(jw, "blatUrl", "hgBlat?%s=%s", cartSessionVarName(), cartSessionId(cart));
jsonWriteStringf(jw, "panLiftUrl", "hgPangenome?page=convert&%s=%s",
                 cartSessionVarName(), cartSessionId(cart));
jsonWriteObjectEnd(jw);
jsInlineF("var hgPangenomeFormData = %s;\n", jw->dy->string);
jsonWriteFree(&jw);
}

static void drawConvertPage()
/* PanLift, the coordinate-translation page, in the spirit of hgConvert's "In Other
 * Genomes".  The source assembly and position are inherited from the cart, so
 * arriving from a track view pre-fills them with whatever the user was looking
 * at - but both stay editable.  Destination haplotypes come from the live graph
 * (cmd=haplotypes) and the translation itself is done by the middleware
 * (cmd=liftover); js/hgPangenomeConvert.js drives both. */
{
/* Whatever the user was last viewing, if anything. */
char *db = cartUsualString(cart, "db", "");
char *position = cartUsualString(cart, "position", "");

printf("<form id='pgcForm' onsubmit='return false;'>\n");
printf("<h2>PanLift</h2>\n");
printf("<p>Translate a region from one assembly's coordinates to another's "
       "through the pangenome graph, and bring the source's annotations "
       "along with it.</p>\n");

printf("<table class='hgPangenomeTable pgcTable' border=0>\n");

/* ---- source ----
 *
 * Shown, not asked for.  The user arrives here from a position in the Genome
 * Browser, which is the region they mean, and hgConvert - the page this one
 * stands beside - does the same: it states the source and only asks where to
 * send it.  Offering a picker and a free-text position made the form look like
 * a query builder and invited the two mistakes it could not catch, a contig
 * that is not on the chosen assembly and a position left over from a different
 * one.  Both values are still here as hidden inputs, because they are what
 * gets submitted. */
printf("<tr><td><b>Source</b></td>\n");
printf("<td><div id='pgcSrcLabel' class='pgcCurrent'></div>\n");
printf("<input type='hidden' id='pgcSrcHap'>\n");
printf("<input type='hidden' id='pgcSrcDb' value='%s'>\n", db);
printf("<input type='hidden' id='pgcPos' value='%s'>\n", position);
printf("<div id='pgcSrcNote' class='pgMuted'></div>\n");
printf("<div class='pgMuted'>To convert a different region, go to it in the "
       "<a href='../cgi-bin/hgTracks'>Genome Browser</a> and come back.</div>"
       "</td></tr>\n");

/* ---- destination ---- */
printf("<tr><td><label for='pgcFilter'><b>Target assemblies</b></label></td>\n");
printf("<td>\n");
printf("<div class='pgcFind'>");
printf("<input type='search' id='pgcFilter' size='30' "
       "placeholder='Search haplotypes or populations'>\n");
/* One checkbox rather than two buttons that swapped places.  The pair looked
 * like two separate actions and gave no sign of which state the list was in;
 * a checkbox says both what it does and whether it is on. */
printf("<label for='pgcReachableOnly' class='pgcToggle' title='Ask the graph "
       "which assemblies this region exists on, and list only those'>"
       "<input type='checkbox' id='pgcReachableOnly'> "
       "Only assemblies with this region</label>\n");
printf("</div>\n");
/* What has been chosen, as chips that can be taken back one at a time. */
printf("<div id='pgcChosen' class='pgcChosen' aria-live='polite'></div>\n");
/* The picker: the populations on the left, with their counts, and the
 * haplotypes of the one picked on the right, as checkboxes.  Populations are
 * the HPRC's own descriptions (hgPangenomeSamples.js). */
printf("<div class='pgcPick'>\n");
printf("<div id='pgcPops' class='pgcPops'></div>\n");
printf("<div id='pgcHaps' class='pgcHaps'></div>\n");
printf("</div>\n");
printf("<div class='pgMuted' id='pgcTargetCount'></div>\n");
/* The list the rest of the page reads the choice from.  Hidden: the picker
 * above is the control, and keeps this one in step. */
printf("<select id='pgcTargets' multiple class='pgcTargets' hidden "
       "aria-hidden='true' tabindex='-1'></select>\n");
printf("</td></tr>\n");

/* ---- annotations ---- */
if (quickLiftEnabled(cart))
    {
    boolean on = sameString(cfgOr("pangenome.quickLift", "on"), "on");
    /* Worded as hgConvert words it.  The explanation that used to sit under
     * these two is in their tooltips, where it is available without taking up
     * the form. */
    printf("<tr><td><b>Annotations</b></td>\n");
    printf("<td><label for='pgcQuickLift' title='Display tracks from the "
           "source assembly mapped onto the target assembly'>"
           "<input type='checkbox' id='pgcQuickLift' %s> "
           "PanLift tracks</label>\n",
           on ? "checked" : "");
    printf("<div id='pgcHideRow'><label for='pgcHideTracks' title='Hide all of "
           "the target assembly default tracks, showing only the QuickLifted "
           "tracks'><input type='checkbox' id='pgcHideTracks' checked> "
           "Hide all default tracks on the target</label></div>\n");
    /* Filled in by the page once it has asked what the source has showing.
     * Saying "nothing to carry over" here, before the Submit, is the whole
     * point: said afterwards it is a wasted conversion. */
    printf("<div id='pgcLiftWarn' class='pgWarn' style='display:none'></div>\n");
    printf("</td></tr>\n");
    }

printf("<tr><td></td><td>\n");
printf("<input type='button' id='pgcSubmit' value='Convert'>\n");
printf("<input type='button' id='pgcClear' value='Clear'>\n");
/* Every haplotype in one request, on a page of its own (page=liftAll). */
printf("<input type='button' id='pgcAllBtn' value='Show all haplotypes' "
       "title='Translate this region to every haplotype in the pangenome and "
       "summarize how it carries over'>\n");
printf("</td></tr>\n");
printf("</table>\n");
printf("</form>\n");

printf("<div id='pgcStatus' class='pgStatus' style='display:none'></div>\n");
printf("<div id='pgcResults' class='pgResults'></div>\n");

printf("<p>Have a sequence instead of coordinates?  "
       "<a href='hgPangenome'>Pangenome Mapping</a> maps reads to the graph and "
       "reports the assemblies carrying them.</p>\n");
}

void doMiddle(struct cart *theCart)
/* Write the page. */
{
cart = theCart;

/* Asked before a conversion is submitted, so it needs the cart too. */
if (sameOk(cgiOptionalString("cmd"), "liftCheck"))
    {
    doLiftCheck();
    return;
    }

/* Building a quickLift hub needs the cart, so unlike the other commands this
 * one comes through the cart shell.  It writes its own JSON header. */
if (sameOk(cgiOptionalString("cmd"), "quickLift"))
    {
    doQuickLift(cgiOptionalString("payload"), FALSE);
    return;
    }
/* A reference's annotations on a mapped haplotype, for the results page. */
if (sameOk(cgiOptionalString("cmd"), "refAnnot"))
    {
    doRefAnnot();
    return;
    }
/* One haplotype at an SV's site, for page=svOpen. */
if (sameOk(cgiOptionalString("cmd"), "svOpen"))
    {
    doSvOpen();
    return;
    }
/* Same work, wider chain.  Sent after the user has followed the link, so the
 * chain they are already looking at is replaced by one that survives panning.
 * Nothing waits for it, and the reply goes nowhere. */
if (sameOk(cgiOptionalString("cmd"), "extendChain"))
    {
    doQuickLift(cgiOptionalString("payload"), TRUE);
    /* Deliberately not returning: cartCheckout() would write this request's
     * copy of the cart over whatever the browser has done in the seconds since,
     * undoing tracks the user turned on while we were working.  We have nothing
     * to save, so leave without saving. */
    fflush(stdout);
    exit(0);
    }
if (sameOk(cgiOptionalString("cmd"), "alignTrack"))
    {
    doAlignTrack();
    return;
    }

/* Either page is a good moment to take away hubs whose files have been swept:
 * the user is here, and the dead entry is what puts a red error group on every
 * hgTracks page. */
pgForgetStaleHubs(NULL, TRUE);

/* The results of one mapping job, as a sortable table.  Reached by an ordinary
 * URL naming only the job, the way hgBlat's results page is: reloading it
 * works, and it can be handed to someone else for as long as the job is still
 * cached upstream. */
if (sameOk(cgiOptionalString("page"), "results"))
    {
    cartWebStart(cart, NULL, "Pangenome Mapping Results");
    if (issueBotWarning)
        botDelayMessage(getenv("REMOTE_ADDR"), botDelayMillis);
    /* The results page of hgBlat's new design: hgPangenomeResults.js builds the
     * summary strip, the sortable DataTable and the detail panel inside this
     * container, from the shared house style in gbModern.css and this tool's
     * own layout in hgPangenome.css, as hgBlat.js does from hgBlat.css. */
    jsIncludeDataTablesLibs();
    webIncludeResourceFile("gbModern.css");   // shared house-style components (.gbPill, .gbCard, ...)
    webIncludeResourceFile("hgPangenome.css");
    printf("<div id='pgrResults' class='gbApp'></div>\n");
    injectConfig();
    /* The job id comes straight from the URL, so it is checked before it goes
     * anywhere, and an id that is not one becomes empty: the page then says no
     * job was named.  It used to be echoed into a single-quoted literal through
     * jsonStringEscape, which escapes double quotes but not single ones, so a
     * quote in job_id ended the string and the rest ran as script - inside this
     * page's own nonced block, where the CSP cannot stop it.  It is now also a
     * double-quoted literal, which is what jsonStringEscape is for, so either
     * fix alone would hold. */
    char *jobId = cgiUsualString("job_id", "");
    if (!pgValidJobId(jobId))
        jobId = "";
    jsInlineF("var pangenomeJobId = \"%s\";\n", jsonStringEscape(jobId));

    /* What the page needs that the mapping job does not carry: the queries
     * themselves, for "Show Query Sequence", and where its two header buttons go.
     * "Back to Genome Browser" is offered, as on hgBlat's results page, only
     * when the cart has a position to go back to. */
    struct jsonWrite *jw = jsonWriteNew();
    jsonWriteObjectStart(jw, NULL);
    pgJsonQuerySeqs(jw, "querySeqs", jobId);
    jsonWriteStringf(jw, "newSearchUrl", "hgPangenome?%s=%s",
                     cartSessionVarName(), cartSessionId(cart));
    char *backPos = cartOptionalString(cart, "position");
    char *backDb = cartOptionalString(cart, "db");
    if (!isEmpty(backPos) && !isEmpty(backDb))
        {
        jsonWriteStringf(jw, "backUrl", "hgTracks?db=%s&%s=%s",
                         backDb, cartSessionVarName(), cartSessionId(cart));
        jsonWriteString(jw, "backPos", backPos);
        }
    jsonWriteString(jw, "graphLabel",
                    cfgOr("pangenome.graphLabel",
                          "Human Pangenome Reference Consortium, release 2"));
    /* The references whose annotations can come along when a haplotype is
     * opened.  Offered only where the browser's QuickLift is on, since that is
     * what draws them. */
    if (quickLiftEnabled(cart))
        {
        jsonWriteListStart(jw, "annotRefs");
        struct slPair *rp;
        for (rp = pgAnnotRefs(); rp != NULL; rp = rp->next)
            {
            jsonWriteObjectStart(jw, NULL);
            jsonWriteString(jw, "hap", rp->name);
            jsonWriteString(jw, "label", pgRefLabel(rp->name));
            jsonWriteString(jw, "db", (char *)rp->val);
            jsonWriteObjectEnd(jw);
            }
        jsonWriteListEnd(jw);
        jsonWriteString(jw, "annotDefault",
                        cfgOr("pangenome.annotationDefault", "GRCh38#0"));
        /* Named in the link ("refAnnot=CHM13", "refAnnot=none"), which wins
         * over both the default and what this viewer last chose.  Only its
         * characters are checked here; the page matches it to a reference. */
        char *fromUrl = cgiOptionalString("refAnnot");
        boolean urlOk = !isEmpty(fromUrl) && strlen(fromUrl) < 64;
        char *c;
        for (c = fromUrl; urlOk && *c != '\0'; ++c)
            if (!(isalnum((unsigned char)*c) || *c == '#'))
                urlOk = FALSE;
        if (urlOk)
            jsonWriteString(jw, "annotUrl", fromUrl);
        }
    jsonWriteObjectEnd(jw);
    jsInlineF("var pangenomeResultsPage = %s;\n", jw->dy->string);
    jsonWriteFree(&jw);

    /* How many haplotypes the batch surjection places.  Everything else in the
     * table comes free with the mapping; these come in one request, so this can
     * be far larger than it was when each position cost a request of its own. */
    jsInlineF("var pangenomeSurjectTop = %s;\n",
              cfgOr("pangenome.resultsSurjectTop", "50"));
    jsInlineF("var pangenomeSurjectMax = %d;\n", pgSurjectMax());
    /* Place every haplotype of every hit as soon as the first table is up,
     * rather than when the reader turns to a page that shows one: one batch
     * call per hit, one at a time per page view.  Off by default. */
    jsInlineF("var pangenomePlaceAllAtLoad = %s;\n",
              sameString(cfgOr("pangenome.resultsPlaceAllAtLoad", "off"), "on") ? "true" : "false");
    /* Coverage floor for the batch surjection.  Left at zero: the service
     * returns its targets best coverage first and stops at max_targets, so the
     * floor only decides what is eligible, and a default of 50 quietly threw
     * away every partial match - a read whose best other haplotype covers 42%
     * came back with one row. */
    jsInlineF("var pangenomeMinCoverage = %s;\n",
              cfgOr("pangenome.resultsMinCoverage", "0"));
    /* What the table shows by default, which the reader can lower to the floor
     * above or raise: a loose cut that keeps pieces of pseudogenes and other
     * short fragments out without hiding a second full copy. */
    jsInlineF("var pangenomeShowCoverage = %s;\n",
              cfgOr("pangenome.resultsShowCoverage", "50"));
    /* The ancestry plot is optional.  With pangenome.resultsPclai off, the flag
     * is false, the module is never loaded and the results page has no plot
     * control and no checkbox column - exactly as before the feature existed. */
    boolean pclai = sameString(cfgOr("pangenome.resultsPclai", "off"), "on");
    jsInlineF("var pangenomePclai = %s;\n", pclai ? "true" : "false");
    /* Coverage floor for the ancestry plot only - the table still lists every
     * hit.  The batch surjection is asked for a COUNT of targets, not a
     * quality, and answers best first: where a region is carried by fewer
     * haplotypes than that count, the remaining slots fill with incidental
     * repeat matches covering a few per cent of the query.  Those are not
     * wrong, and belong in the table, but averaging their ancestry in with the
     * real hits moves the centroid and inflates the dispersion.  The page can
     * change this; this is only where the slider starts. */
    jsInlineF("var pangenomePclaiMinCoverage = %s;\n",
              cfgOr("pangenome.pclaiMinCoverage", "50"));
    jsIncludeFile("hgPangenomeAssemblies.js", NULL);
    if (pclai)
        jsIncludeFile("hgPangenomePclai.js", NULL);
    jsIncludeFile("hgPangenomeSamples.js", NULL);   /* the Population column */
    jsIncludeFile("hgPangenomeResults.js", NULL);
    cartWebEnd();
    return;
    }

/* The step between an SV's details page and the browser: says what it is
 * opening, asks for it (cmd=svOpen) and goes there.  Everything it needs is in
 * the link, and checked again by cmd=svOpen. */
if (sameOk(cgiOptionalString("page"), "svOpen"))
    {
    cartWebStart(cart, NULL, "Opening a haplotype at an SV");
    if (issueBotWarning)
        botDelayMessage(getenv("REMOTE_ADDR"), botDelayMillis);
    webIncludeResourceFile("hgPangenome.css");
    printf("<div id='pgsOpen' class='pgsOpen'></div>\n");
    injectConfig();
    struct jsonWrite *jw = jsonWriteNew();
    jsonWriteObjectStart(jw, NULL);
    /* As the cart gives it, hs1 is hub_<id>_hs1; the graph knows it as hs1. */
    jsonWriteString(jw, "db", trackHubSkipHubName(cgiUsualString("db", "")));
    jsonWriteString(jw, "chrom", cgiUsualString("chrom", ""));
    jsonWriteNumber(jw, "start", cgiOptionalInt("start", -1));
    jsonWriteNumber(jw, "end", cgiOptionalInt("end", -1));
    jsonWriteString(jw, "hap", cgiUsualString("hap", ""));
    jsonWriteString(jw, "sv", cgiUsualString("sv", ""));
    char *refHap = pgRefHapForDb(trackHubSkipHubName(cgiUsualString("db", "")));
    jsonWriteString(jw, "refLabel", refHap ? pgRefLabel(refHap) : "");
    jsonWriteBoolean(jw, "quickLift", quickLiftEnabled(cart));
    jsonWriteObjectEnd(jw);
    jsInlineF("var pangenomeSvOpen = %s;\n", jw->dy->string);
    jsonWriteFree(&jw);
    jsIncludeFile("hgPangenomeAssemblies.js", NULL);
    jsIncludeFile("hgPangenomeSvOpen.js", NULL);
    cartWebEnd();
    return;
    }

/* One PanLift region on every haplotype in the graph: how it carries over, and
 * the table.  Named entirely by the link - the source path and the interval -
 * so it can be reloaded and handed on; cmd=liftoverAll checks them again. */
if (sameOk(cgiOptionalString("page"), "liftAll"))
    {
    cartWebStart(cart, NULL, "PanLift — All haplotypes");
    if (issueBotWarning)
        botDelayMessage(getenv("REMOTE_ADDR"), botDelayMillis);
    jsIncludeDataTablesLibs();
    webIncludeResourceFile("gbModern.css");
    webIncludeResourceFile("hgPangenome.css");
    printf("<div id='pgcAll' class='gbApp'>\n");
    printf("<div id='pgcStatus' class='pgStatus' style='display:none'></div>\n");
    printf("<div id='pgcResults' class='pgResults'></div>\n");
    printf("</div>\n");
    injectConfig();
    struct jsonWrite *jw = jsonWriteNew();
    jsonWriteObjectStart(jw, NULL);
    /* A PanSN contig path is letters, digits and . _ - between its #s; anything
     * else is not one, and the page says no region was named. */
    char *src = cgiUsualString("src", "");
    boolean srcOk = strlen(src) < 256 && countChars(src, '#') >= 2;
    char *c;
    for (c = src; srcOk && *c != '\0'; ++c)
        if (!(isalnum((unsigned char)*c) || strchr("#._-", *c)))
            srcOk = FALSE;
    jsonWriteString(jw, "src", srcOk ? src : "");
    jsonWriteNumber(jw, "start", cgiOptionalInt("start", -1));
    jsonWriteNumber(jw, "end", cgiOptionalInt("end", -1));
    jsonWriteStringf(jw, "panLiftUrl", "hgPangenome?page=convert&%s=%s",
                     cartSessionVarName(), cartSessionId(cart));
    char *backPos = cartOptionalString(cart, "position");
    char *backDb = cartOptionalString(cart, "db");
    if (!isEmpty(backPos) && !isEmpty(backDb))
        {
        jsonWriteStringf(jw, "backUrl", "hgTracks?db=%s&%s=%s",
                         backDb, cartSessionVarName(), cartSessionId(cart));
        jsonWriteString(jw, "backPos", backPos);
        }
    jsonWriteObjectEnd(jw);
    jsInlineF("var pangenomeLiftAll = %s;\n", jw->dy->string);
    jsonWriteFree(&jw);
    boolean pclai = sameString(cfgOr("pangenome.resultsPclai", "off"), "on");
    jsInlineF("var pangenomePclai = %s;\n", pclai ? "true" : "false");
    jsIncludeFile("hgPangenomeAssemblies.js", NULL);
    jsIncludeFile("hgPangenomeSamples.js", NULL);
    if (pclai)
        jsIncludeFile("hgPangenomePclai.js", NULL);
    jsIncludeFile("hgPangenomeConvert.js", NULL);
    cartWebEnd();
    return;
    }

/* The coordinate-translation page is a separate view of this CGI. */
if (sameOk(cgiOptionalString("page"), "convert"))
    {
    cartWebStart(cart, NULL, "PanLift");
    if (issueBotWarning)
        botDelayMessage(getenv("REMOTE_ADDR"), botDelayMillis);
    /* gbModern.css for the ancestry plot's details panel, which is the results
     * page's; everything in it is scoped to .gbApp, so the form is untouched. */
    webIncludeResourceFile("gbModern.css");
    webIncludeResourceFile("hgPangenome.css");
    drawConvertPage();
    injectConfig();
    /* The ancestry plot of the converted regions: the same switch as the
     * results page's, since it is the same data and the same plot. */
    boolean pclai = sameString(cfgOr("pangenome.resultsPclai", "off"), "on");
    jsInlineF("var pangenomePclai = %s;\n", pclai ? "true" : "false");
    /* The results table pages and sorts as the mapping results page's does. */
    jsIncludeDataTablesLibs();
    jsIncludeFile("hgPangenomeAssemblies.js", NULL);
    jsIncludeFile("hgPangenomeSamples.js", NULL);   /* generated sample->population table */
    if (pclai)
        jsIncludeFile("hgPangenomePclai.js", NULL);
    jsIncludeFile("hgPangenomeConvert.js", NULL);
    cartWebEnd();
    return;
    }

/* Title as hgBlat's new form has it: the page's purpose in the gold bar, which
 * gbModern.css styles, rather than a bare name in the bar and an <h2> repeating
 * it underneath.  cartWebStart HTML-escapes the title, so the dash is a literal
 * em dash and not &mdash;. */
cartWebStart(cart, NULL, "Pangenome Mapping — Find a DNA sequence across the human pangenome");

if (issueBotWarning)
    {
    char *ip = getenv("REMOTE_ADDR");
    botDelayMessage(ip, botDelayMillis);
    }

webIncludeResourceFile("gbModern.css");   // shared house-style components (.gbPill, .gbCard, ...)
webIncludeResourceFile("hgPangenome.css");

drawForm();

/* Config first (inline, runs before DOMContentLoaded), then the app + mock. */
injectConfig();
jsIncludeFile("hgPangenomeAssemblies.js", NULL);   /* generated haplotype->assembly table */
jsIncludeFile("hgPangenomeMock.js", NULL);
jsIncludeFile("hgPangenome.js", NULL);

cartWebEnd();
}

int main(int argc, char *argv[])
/* Process command line. */
{
long enteredMainTime = clock1000();
cgiSpoof(&argc, argv);

/* API modes: forward to the middleware and return JSON, skipping the cart
 * (and its central-DB dependency) entirely. */
char *cmd = cgiOptionalString("cmd");

/* One size cap for every command, before anything dispatches.
 *
 * cheapcgi.c enforces its own 1 MB cap (CGI_INPUT_SIZE_LIMIT_DEFAULT) and
 * aborts with an HTML error page, which a JSON client can only report as
 * "Unexpected token '<'".  Ours has to sit below that so an oversized request
 * comes back as our own error envelope instead. */
if (cmd != NULL)
    {
    char *payload = cgiOptionalString("payload");
    long maxBytes = atol(cfgOr("pangenome.maxRequestBytes", "500000"));
    if (payload != NULL && maxBytes > 0 && (long)strlen(payload) > maxBytes)
        {
        emitJsonError("request too large: %ld bytes (limit %ld)",
                      (long)strlen(payload), maxBytes);
        return 0;
        }
    }

/* Reads two local files and needs no cart, so it is answered before the shells
 * below and is not rate limited - the page asks for it whenever the source
 * changes. */
/* Reads bigBeds under /gbdb and needs no cart, so it is answered beside the
 * other file-reading commands rather than through a shell. */
if (sameOk(cmd, "pclai"))
    {
    doPclai();
    return 0;
    }
if (sameOk(cmd, "contigs"))
    {
    doContigs();
    return 0;
    }
if (sameOk(cmd, "locus"))
    {
    doLocus();
    return 0;
    }
if (cmd != NULL && (sameString(cmd, "map") || sameString(cmd, "poll")
                    || sameString(cmd, "liftover") || sameString(cmd, "haplotypes")
                    || sameString(cmd, "liftoverTargets") || sameString(cmd, "liftoverAll")
                    || sameString(cmd, "surject") || sameString(cmd, "surjectAll")))
    {
    /* Rate-limit the expensive submit via the UCSC bottleneck server, with a
     * JSON hog-exit so the client renders it as an error.  Polling is cheap
     * and happens many times per job, so it is deliberately NOT throttled -
     * throttling it would penalize legitimate users' polling loops. */
    if (sameString(cmd, "map") || sameString(cmd, "liftover")
        || sameString(cmd, "liftoverTargets") || sameString(cmd, "liftoverAll")
        || sameString(cmd, "surject"))
        {
        /* If the bottleneck server itself is unreachable, botDelay errAborts,
         * which would send an HTML 500 down a JSON endpoint (the client would
         * show raw markup).  Catch it and answer with our error envelope
         * instead - the pattern botDelay.c documents for JSON endpoints.
         * Note a genuine hog still exits via hogExit(), which emits JSON 429. */
        struct errCatch *errCatch = errCatchNew();
        if (errCatchStart(errCatch))
            earlyBotCheck(enteredMainTime, "hgPangenome", delayFraction, 0, 0, "json");
        errCatchEnd(errCatch);
        if (errCatch->gotError)
            {
            /* Detail (host/port of the bottleneck server) goes to the error log,
             * not to the browser. */
            fprintf(stderr, "hgPangenome: bot check failed: %s\n",
                    trimSpaces(errCatch->message->string));
            emitJsonError("rate limiter unavailable, please try again in a moment");
            errCatchFree(&errCatch);
            return 0;
            }
        errCatchFree(&errCatch);
        }
    apiProxy(cmd);
    return 0;
    }

/* Building a quickLift hub is expensive (a chain plus two bedToBigBed runs),
 * so it is throttled like the other heavy commands - but it needs the cart, so
 * it goes through the shell that leaves the Content-Type to us. */
if (sameOk(cmd, "alignTrack"))
    {
    /* Writes two small files and touches the cart, so it is throttled like the
     * other commands that do real work rather than left open. */
    struct errCatch *errCatch = errCatchNew();
    if (errCatchStart(errCatch))
        earlyBotCheck(enteredMainTime, "hgPangenome", delayFraction, 0, 0, "json");
    errCatchEnd(errCatch);
    if (errCatch->gotError)
        {
        fprintf(stderr, "hgPangenome: bot check failed: %s\n",
                trimSpaces(errCatch->message->string));
        emitJsonError("rate limiter unavailable, please try again in a moment");
        errCatchFree(&errCatch);
        return 0;
        }
    errCatchFree(&errCatch);
    oldVars = hashNew(8);
    cartEmptyShellNoContent(doMiddle, hUserCookie(), excludeVars, oldVars);
    return 0;
    }

if (sameOk(cmd, "quickLift") || sameOk(cmd, "extendChain") || sameOk(cmd, "liftCheck") ||
    sameOk(cmd, "refAnnot") || sameOk(cmd, "svOpen"))
    {
    struct errCatch *errCatch = errCatchNew();
    if (errCatchStart(errCatch))
        earlyBotCheck(enteredMainTime, "hgPangenome", delayFraction, 0, 0, "json");
    errCatchEnd(errCatch);
    if (errCatch->gotError)
        {
        fprintf(stderr, "hgPangenome: bot check failed: %s\n",
                trimSpaces(errCatch->message->string));
        emitJsonError("rate limiter unavailable, please try again in a moment");
        errCatchFree(&errCatch);
        return 0;
        }
    errCatchFree(&errCatch);
    oldVars = hashNew(8);
    cartEmptyShellNoContent(doMiddle, hUserCookie(), excludeVars, oldVars);
    return 0;
    }

/* Otherwise render the page (HTML hog-exit if the IP is abusing us). */
issueBotWarning = earlyBotCheck(enteredMainTime, "hgPangenome", delayFraction, 0, 0, "html");
oldVars = hashNew(8);
cartEmptyShell(doMiddle, hUserCookie(), excludeVars, oldVars);
return 0;
}
