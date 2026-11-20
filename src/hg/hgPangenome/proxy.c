/* proxy - the graph server: one request to it at a time through a short
 * queue, the checks a request passes before it is sent on, and the commands
 * that are answered by forwarding (map, poll, liftoverTargets, liftoverAll,
 * surject, surjectAll, haplotypes). */
/* Copyright 2024 The Regents of the University of California. */
#include "common.h"
#include "cheapcgi.h"
#include "jsonWrite.h"
#include "jsonParse.h"
#include "dystring.h"
#include "errCatch.h"
#include "portable.h"
#include <fcntl.h>
#include <sys/file.h>
#include <ctype.h>
#include <curl/curl.h>
#include "hgPangenome.h"

/* ---- Graph server HTTP client (the "ask the other server" layer) ----
 * Uses libcurl, which is already a project dependency (see lib/curlWrap.c and
 * the -lcurl on our link line); no new library is introduced. */

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
/* Wait for a slot; FALSE if none came free in PG_QUEUE_WAIT_SECS.  A
 * server where the slot files cannot be made is not gated, rather than
 * refusing every request. */
{
int slots = pgMaxConcurrent();
if (slots <= 0)
    return TRUE;
long waitMs = 1000L * PG_QUEUE_WAIT_SECS;
char *dir = PG_SLOT_DIR;
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

struct pgResp pgHttp(char *url, char *postJson, int timeoutSecs)
/* Make one request to the graph server.  GET when postJson is NULL, otherwise
 * POST postJson as application/json.  The token, where hg.conf has one, is
 * sent as the X-Pangenome-Token header.  Caller frees resp.body / resp.errMsg. */
{
char *token = pgApiToken();
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
/* No redirects.  The API has none, and following one would carry the token
 * in our header to wherever it pointed. */
curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);
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

static boolean pgNumberOf(struct jsonElement *el, double *retVal)
/* The value of a number in a request, whichever way it was written.  The JSON
 * parser files 4 and 4.0 as different types, and a limit that looked at one of
 * them only would let the other through. */
{
if (el->type == jsonNumber)
    *retVal = (double)el->val.jeNumber;
else if (el->type == jsonDouble)
    *retVal = el->val.jeDouble;
else
    return FALSE;
return TRUE;
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
        double n = 0;
        struct jsonElement *el = jsonFindNamedField(root, "", "max_targets");
        if (el != NULL && !pgNumberOf(el, &n))
            result = "max_targets must be a number";
        else if (el != NULL && n > maxTargets)
            {
            safef(msg, sizeof(msg), "too many targets: %.0f (limit is %d)", n, maxTargets);
            result = msg;
            }
        el = jsonFindNamedField(root, "", "min_coverage");
        if (result == NULL && el != NULL && (!pgNumberOf(el, &n) || n < 0 || n > 100))
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
 * sequence count, per-sequence length and ACGTN charset, and that each name
 * can sit on a FASTA header line.  Returns NULL if OK,
 * otherwise a human-readable reason.  Never aborts: malformed JSON is caught
 * and reported as an error.  This is a cheap first pass; the graph server
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
    double multimaps = 0;
    if (mmEl != NULL && !pgNumberOf(mmEl, &multimaps))
        result = "max_multimaps must be a number";
    else if (mmEl != NULL && multimaps > maxMultimaps)
        {
        safef(msg, sizeof(msg),
              "too many alignments per sequence: %.0f (limit is %d)",
              multimaps, maxMultimaps);
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
                if (!pgPlainName(jsonOptionalStringField(seqObj, "name", "")))
                    { result = "a sequence name has a blank or a line break in it"; break; }
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

static boolean pgTargetsAreNames(struct jsonElement *tgtEl)
/* TRUE if a request's 'tgt', one string or a list, holds haplotype names only. */
{
if (tgtEl->type == jsonString)
    return pgValidHapName(tgtEl->val.jeString);
struct slRef *ref;
for (ref = tgtEl->val.jeList; ref != NULL; ref = ref->next)
    {
    struct jsonElement *el = ref->val;
    if (el->type != jsonString || !pgValidHapName(el->val.jeString))
        return FALSE;
    }
return TRUE;
}

static char *pgValidateLiftover(char *payload, long maxSpan)
/* Server-side checks on the region of a coordinate-translation request before
 * anything is sent on:
 *   src   - full 3-field PanSN contig path (coordinates live on a contig)
 *   start - 0-based, end - exclusive, start < end
 *   span  - within the graph server's cap
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

    if (isEmpty(src))
        result = "missing 'src' haplotype path";
    else if (countChars(src, '#') < 2)
        result = "'src' must be a full contig path, e.g. HG00097#1#CM094066.1";
    else if (startEl == NULL || endEl == NULL)
        result = "missing 'start' or 'end'";
    else if (startEl->type != jsonNumber || endEl->type != jsonNumber)
        result = "'start' and 'end' must be numbers";
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
    char *name = jsonOptionalStringField(root, "name", NULL);
    if (isEmpty(tgt))
        result = "missing 'tgt' haplotype";
    else if (!pgValidHapName(tgt))
        result = "'tgt' must name a haplotype, such as HG00097#1";
    else if (!pgValidJobId(jobId))
        result = "missing or invalid 'job_id'";
    else if (isEmpty(name))
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

/* ---- The commands that are answered by the graph server ----------------------
 *
 * Each checks what it was sent, forwards it, and passes the answer back as it
 * came.  The browser only ever talks to this CGI, so the graph server's
 * address and its token stay on this side. */

static char *pgUrl(char *path)
/* The graph server's URL for a path such as "/api/v1/map".  NULL, with the
 * error already answered, where hg.conf names no graph server. */
{
static char url[2048];
char *base = pgApiBase();
if (base == NULL)
    {
    emitJsonError("pangenome.apiBase is not configured on this server");
    return NULL;
    }
safef(url, sizeof(url), "%s%s", base, path);
return url;
}

static char *pgPayload()
/* The request's "payload", read here and written out again.  NULL, with the
 * error already answered, when it has none or it does not read as JSON.
 *
 * The checks below are made on our reading of the payload, and the graph
 * server makes its own reading of the text it is sent.  So the text every
 * command checks, keeps and sends on is the one written here from our reading:
 * each number and each name in it is the one that was checked. */
{
char *raw = cgiOptionalString("payload");
if (isEmpty(raw))
    {
    emitJsonError("missing 'payload'");
    return NULL;
    }
char *payload = NULL;
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    {
    struct jsonWrite *jw = jsonWriteNew();
    jsonWriteJsonElement(jw, NULL, jsonParse(raw));
    payload = cloneString(jw->dy->string);
    }
errCatchEnd(errCatch);
errCatchFree(&errCatch);
if (payload == NULL)
    emitJsonError("invalid JSON payload");
return payload;
}

static boolean pgRefused(char *bad)
/* TRUE, with the reason answered, when a check found something wrong. */
{
if (bad != NULL)
    emitJsonError("%s", bad);
return bad != NULL;
}

static boolean pgWentWell(struct pgResp *r)
/* TRUE when the graph server answered, and not with a failure. */
{
return !r->busy && !r->transportErr && r->code < 300;
}

static int pgWholeChars(char *s, int max)
/* How many bytes of s to quote, max at most, without cutting a character that
 * takes several bytes in two: half of one is not text, and the answer it is
 * quoted in would not read as JSON. */
{
int n = strlen(s);
if (n <= max)
    return n;
n = max;
while (n > 0 && ((unsigned char)s[n] & 0xC0) == 0x80)   /* the next byte carries on a character */
    n--;
return n;
}

static void pgAnswer(struct pgResp *r)
/* Answer with what the graph server said, word for word, or with why it could
 * not be asked.  Frees the response. */
{
if (r->busy)
    emitJsonError("%s", r->errMsg);
else if (r->transportErr)
    emitJsonError("could not reach mapping server: %s", r->errMsg ? r->errMsg : "unknown error");
else if (r->code >= 300 && r->code < 400)
    emitJsonError("the mapping server answered with a redirect (HTTP %ld), "
                  "which is not followed", r->code);
else if (r->code >= 400)
    {
    /* Surface the upstream failure.  When the body is JSON it is the mapping
     * server's own error and worth showing; when it is not (an HTML error page
     * from a proxy in front of it, say) quote nothing - a wall of markup in the
     * message box helps nobody. */
    char *body = skipLeadingSpaces(r->body->string);
    if (body[0] == '{' || body[0] == '[')
        {
        /* The first part only: an error body can be a page long. */
        emitJsonError("mapping server returned HTTP %ld: %.*s", r->code,
                      pgWholeChars(body, 400), body);
        }
    else if (r->code == 503)
        emitJsonError("the mapping service is unavailable (HTTP 503) - it may be "
                      "restarting; try again shortly");
    else if (r->code == 502 || r->code == 504)
        emitJsonError("could not reach the mapping service through its proxy "
                      "(HTTP %ld); try again shortly", r->code);
    else
        emitJsonError("mapping server returned HTTP %ld", r->code);
    }
else
    emitJson(r->body->string);
dyStringFree(&r->body);
freez(&r->errMsg);
}

static boolean pgExpired(struct pgResp *r)
/* TRUE, and answered, when a surjection's job has aged out of the graph
 * server's cache: its 404.  That is the documented miss and not a failure, so
 * it is answered with a status the page can act on by mapping again. */
{
if (r->transportErr || r->code != 404)
    return FALSE;
emitJson("{\"status\":\"expired\"}");
dyStringFree(&r->body);
freez(&r->errMsg);
return TRUE;
}

void doMap()
/* cmd=map: submit sequences to be mapped.  Answers with the job to poll. */
{
char *url = pgUrl("/api/v1/map");
char *payload = (url == NULL) ? NULL : pgPayload();
if (payload == NULL)
    return;
/* The limits are checked here: the browser's own checks can be skipped.
 * They are the graph server's limits too; keep both sides the same. */
if (pgRefused(pgValidatePayload(payload, pgMaxSequences(), pgMaxSeqLen(), PG_MAX_MULTIMAPS)))
    return;
struct pgResp r = pgHttp(url, payload, pgTimeoutSecs());
/* Keep the query sequences where the results page can find them again. */
if (pgWentWell(&r))
    pgStashQuerySeqs(payload, r.body->string);
pgAnswer(&r);
}

void doPoll()
/* cmd=poll: how a mapping job is getting on, and its results once it is done. */
{
char *jobsUrl = pgUrl("/api/v1/map/");
if (jobsUrl == NULL)
    return;
char *jobId = cgiOptionalString("job_id");
if (!pgValidJobId(jobId))
    {
    emitJsonError("missing or invalid 'job_id'");
    return;
    }
char url[2048];
safef(url, sizeof(url), "%s%s", jobsUrl, jobId);
struct pgResp r = pgHttp(url, NULL, pgTimeoutSecs());
pgAnswer(&r);
}

void doHaplotypes()
/* cmd=haplotypes: the haplotypes in the loaded graph, for PanLift's picker. */
{
char *url = pgUrl("/api/v1/haplotypes");
if (url == NULL)
    return;
struct pgResp r = pgHttp(url, NULL, pgTimeoutSecs());
pgAnswer(&r);
}

void doLiftoverTargets()
/* cmd=liftoverTargets: which haplotypes a region can translate to at all.
 * The same payload as a translation, less the target. */
{
char *url = pgUrl("/api/v1/liftover/targets");
char *payload = (url == NULL) ? NULL : pgPayload();
if (payload == NULL)
    return;
if (pgRefused(pgValidateLiftover(payload, PG_MAX_LIFT_SPAN)))
    return;
struct pgResp r = pgHttp(url, payload, pgTimeoutSecs());
pgAnswer(&r);
}

void doLiftoverAll()
/* cmd=liftoverAll: the region on every haplotype, or on the ones the request
 * names, one row each: where it lands and how much of it does.  The service
 * walks the source once for all of them, so this costs about what a single
 * target does.  What goes upstream is rebuilt from the checked fields alone:
 * the summary form, never the block list, which for every haplotype runs to
 * about 118,000 rows a megabase; and as targets either "*" or a list of
 * haplotype names no longer than a reader may choose. */
{
char *url = pgUrl("/api/v1/liftover");
char *payload = (url == NULL) ? NULL : pgPayload();
if (payload == NULL)
    return;
if (pgRefused(pgValidateLiftover(payload, PG_MAX_LIFT_SPAN)))
    return;
struct jsonElement *root = jsonParse(payload);
struct jsonElement *tgtEl = jsonFindNamedField(root, "", "tgt");
if (tgtEl != NULL)
    {
    if (tgtEl->type != jsonList || tgtEl->val.jeList == NULL || !pgTargetsAreNames(tgtEl))
        {
        emitJsonError("'tgt' must be a list of haplotypes, such as HG00097#1");
        return;
        }
    if (slCount(tgtEl->val.jeList) > PG_MAX_CHOSEN_TARGETS)
        {
        emitJsonError("too many target haplotypes: %d (limit is %d per conversion)",
                      slCount(tgtEl->val.jeList), PG_MAX_CHOSEN_TARGETS);
        return;
        }
    }
struct jsonWrite *jw = jsonWriteNew();
jsonWriteObjectStart(jw, NULL);
jsonWriteString(jw, "src", jsonOptionalStringField(root, "src", NULL));
jsonWriteNumber(jw, "start", (long long)jsonFindNamedField(root, "", "start")->val.jeNumber);
jsonWriteNumber(jw, "end", (long long)jsonFindNamedField(root, "", "end")->val.jeNumber);
if (tgtEl == NULL)
    jsonWriteString(jw, "tgt", "*");
else
    {
    struct slRef *ref;
    jsonWriteListStart(jw, "tgt");
    for (ref = tgtEl->val.jeList; ref != NULL; ref = ref->next)
        jsonWriteString(jw, NULL, ((struct jsonElement *)ref->val)->val.jeString);
    jsonWriteListEnd(jw);
    }
jsonWriteBoolean(jw, "summary", TRUE);
jsonWriteObjectEnd(jw);
/* A summary is about 1 kB a haplotype, but in a duplicated or inverted
 * region the service has been seen to report a few haplotypes as one piece
 * per source base: 280 MB for a megabase of 17q21.31, more than this CGI
 * should hold or a browser can draw.  Stop reading and say so instead. */
pgMaxBody = PG_MAX_LIFT_ALL_BYTES;
struct pgResp r = pgHttp(url, jw->dy->string, pgTimeoutSecs());
pgMaxBody = 0;
jsonWriteFree(&jw);
if (pgTooBig)
    {
    emitJsonError("the graph server's answer for this region is over %ld MB, too "
                  "large to show: in a duplicated or inverted region it can split a "
                  "haplotype into thousands of pieces. Try a smaller region",
                  (long)PG_MAX_LIFT_ALL_BYTES / 1000000);
    dyStringFree(&r.body);
    freez(&r.errMsg);
    return;
    }
pgAnswer(&r);
}

void doSurject()
/* cmd=surject: re-place an alignment the graph server still holds on another
 * haplotype, instead of mapping the read again. */
{
char *url = pgUrl("/api/v1/surject");
char *payload = (url == NULL) ? NULL : pgPayload();
if (payload == NULL)
    return;
if (pgRefused(pgValidateSurject(payload)))
    return;
struct pgResp r = pgHttp(url, payload, pgTimeoutSecs());
if (!pgExpired(&r))
    pgAnswer(&r);
}

void doSurjectAll()
/* cmd=surjectAll: place the read on every haplotype that carries it, in one
 * call.  The service does a single anchor pass and then surjects in parallel,
 * so this costs about what one surjection does - where asking one at a time
 * costs one request per row. */
{
char *url = pgUrl("/api/v1/surject_all");
char *payload = (url == NULL) ? NULL : pgPayload();
if (payload == NULL)
    return;
if (pgRefused(pgValidateSurjectAll(payload, PG_MAX_SURJECT_TARGETS)))
    return;
/* Synchronous and slower than the rest: the service asks for at least 60
 * seconds, so do not let a shorter timeout cut it off. */
struct pgResp r = pgHttp(url, payload, max(pgTimeoutSecs(), PG_SURJECT_ALL_TIMEOUT_SECS));
if (!pgExpired(&r))
    pgAnswer(&r);
}
