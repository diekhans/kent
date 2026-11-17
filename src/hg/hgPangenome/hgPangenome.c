/* hgPangenome - PanView and PanLift: a sequence found across the human
 * pangenome, and a region carried from one of its haplotypes to the others.
 *
 * The mapping and the coordinate translation are done by a separate graph
 * server.  The browser only ever talks to this CGI, on its own origin; this
 * CGI checks each request and forwards it, so the graph server's address and
 * token stay on this side and no request crosses origins.
 *
 *   browser (js/hgPangenome*.js)  --GET/POST-->  hgPangenome
 *                                                    |  HTTP, JSON
 *                                                    v
 *                                               graph server
 *
 * A request is for a page or for a command.
 *
 * Pages, chosen by "page": none for PanView's form, "results" for a mapping
 * job's table, "convert" for PanLift, "liftAll" for one PanLift region on
 * every haplotype.
 *
 * Commands, chosen by "cmd".  Each answers in JSON, and one that fails answers
 * {"status":"error","error":"..."}.  The table further down lists them with
 * their rate limit and whether they need the cart:
 *   map, poll, haplotypes, liftoverTargets, liftoverAll, surject, surjectAll
 *       forwarded to the graph server                          proxy.c
 *   quickLift, extendChain, refAnnot
 *       one assembly's annotations drawn on another, through the browser's
 *       own QuickLift; with contigs, an assembly's sequence names
 *                                                              liftedTracks.c
 *   alignTrack
 *       the mapped sequence as a bigPsl custom track           seqTrack.c
 *   pclai, locus
 *       ancestry and genes, read from files under /gbdb        ancestryLocus.c
 *
 * This file has the settings, the JSON answer, the checks on the names a
 * request may carry, the pages, the command table and main().  hgPangenome.h
 * has what the files share, and the fixed limits.
 *
 * hg.conf decides eleven things, read by the functions under "Settings":
 *   pangenomeTools           "on" turns the tools on; off by default
 *   pangenome.apiBase        the graph server's base URL
 *   pangenome.apiToken       the secret sent to it; empty for none
 *   pangenome.timeoutSecs    longest one request to it may take; default 120
 *   pangenome.maxConcurrent  requests sent to it at once; default 4, 0 for no
 *                            queue
 *   pangenome.maxSequences   most sequences in one mapping request; default 10
 *   pangenome.maxSeqLen      most bases in one sequence; default 100000
 *   pangenome.resultsPclai   "on" adds the ancestry plot; off by default
 *   pangenome.pclaiRefPanel  a file to read the ancestry reference panel from
 *   pangenome.graphLabel     the graph's name as the pages show it
 *   pangenome.annotationRefs the references whose annotations the results page
 *                            can bring, as "haplotype=db" pairs
 */
/* Copyright 2024 The Regents of the University of California. */
#include "common.h"
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
#include "hui.h"
#include "botDelay.h"
#include "errCatch.h"
#include "portable.h"
#include "quickLift.h"
#include <ctype.h>
#include "hgPangenome.h"

/* Cart handling, as in the other browser tool CGIs. */
struct cart *cart;
struct hash *oldVars = NULL;
/* Never let the command variables into the cart.  "payload" in particular can
 * be long - saving that would bloat every user's cart row permanently, and a
 * big enough one simply breaks the UPDATE that saves it.
 * The page parameters are kept out too.  They say which page a link opens and
 * on what, they are read from the request and never from the cart, and several
 * have names any other tool might use ("start", "end", "src"). */
char *excludeVars[] = {"Submit", "submit", "Clear", "cmd", "payload",
                       "job_id", "page", "src", "start", "end", "refAnnot",
                       "pgTarget", "pgAnnot", "pgHide", NULL};

static boolean issueBotWarning = FALSE;  /* the bottleneck server has a warning for this reader */

/* ---- Settings: what hg.conf decides --------------------------------------
 *
 * Eleven settings, each read here and nowhere else, and by its literal name so
 * that the hg.conf catalogue (hg/utils/hgConfCatalog) lists it.  Every other
 * limit and default is a fixed value in hgPangenome.h. */

boolean pgToolsOn()
/* pangenomeTools: "on" turns the tools on.  Off - the default, and so on any
 * server whose hg.conf does not say otherwise - the page says they are not
 * available here and every command answers with that error.  hgConvert reads
 * it too.  No cart variable can turn it on: on, the page sends work to the
 * graph server with this server's token. */
{
return cfgOptionBooleanDefault("pangenomeTools", FALSE);
}

char *pgApiBase()
/* pangenome.apiBase: the graph server's base URL, such as http://host/pangenome,
 * without a trailing slash so that a path can be put straight after it.  NULL
 * when it is not set. */
{
char *base = cloneString(cfgOptionDefault("pangenome.apiBase", ""));
if (isEmpty(base))
    return NULL;
if (endsWith(base, "/"))
    base[strlen(base) - 1] = '\0';
return base;
}

char *pgApiToken()
/* pangenome.apiToken: the shared secret sent to the graph server as the
 * X-Pangenome-Token header.  Empty, the default, sends no header: a graph
 * server run without authentication, as in testing. */
{
return cfgOptionDefault("pangenome.apiToken", "");
}

int pgTimeoutSecs()
/* pangenome.timeoutSecs: how long one request to the graph server may take;
 * default 120. */
{
return atoi(cfgOptionDefault("pangenome.timeoutSecs", "120"));
}

int pgMaxConcurrent()
/* pangenome.maxConcurrent: requests this web server sends the graph server at
 * once; the rest wait their turn.  Default 4; 0 for no queue. */
{
return atoi(cfgOptionDefault("pangenome.maxConcurrent", "4"));
}

int pgMaxSequences()
/* pangenome.maxSequences: the most sequences one mapping request may hold;
 * default 10.  A setting so that a server can lower it, and the next one, to
 * ease the load on the graph server without a rebuild.  Raising them is
 * bounded elsewhere: the graph server has its own limits, and one request is
 * at most PG_MAX_REQUEST_BYTES, which holds the two defaults. */
{
return atoi(cfgOptionDefault("pangenome.maxSequences", "10"));
}

int pgMaxSeqLen()
/* pangenome.maxSeqLen: the most bases in one sequence; default 100000. */
{
return atoi(cfgOptionDefault("pangenome.maxSeqLen", "100000"));
}

boolean pgAncestryOn()
/* pangenome.resultsPclai: "on" adds the ancestry plot to the results page and
 * to PanLift.  Off, the default, the plot's script is never loaded and the
 * pages have no plot control and no checkbox column. */
{
return sameString(cfgOptionDefault("pangenome.resultsPclai", "off"), "on");
}

char *pgGraphLabel()
/* pangenome.graphLabel: what is being searched, named on the pages so that
 * nobody has to guess which graph a result came from.  A setting, because the
 * graph is a deployment choice and changes with each HPRC release. */
{
return cfgOptionDefault("pangenome.graphLabel",
                        "Human Pangenome Reference Consortium, release 2");
}

char *pgAnnotationRefSpec()
/* pangenome.annotationRefs: the references the results page can bring
 * annotations from, as "haplotype=db" pairs, comma separated.  A setting for
 * the same reason: they are haplotypes of the graph that is loaded. */
{
return cfgOptionDefault("pangenome.annotationRefs", "GRCh38#0=hg38,CHM13#0=hs1");
}

char *pgPclaiRefPanel()
/* pangenome.pclaiRefPanel: a file holding the ancestry reference panel, read
 * in place of the one in the assembly's own contrib directory.  NULL when it
 * is not set. */
{
return cfgOption("pangenome.pclaiRefPanel");
}

/* ---- Answering -------------------------------------------------------------- */

void emitJson(char *json)
/* Write an application/json CGI response (no cart/HTML). */
{
printf("Content-Type: application/json\n\n");
fputs(json, stdout);
}

void emitJsonError(char *fmt, ...)
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

/* ---- The names a request may carry -------------------------------------------
 *
 * They end up in file paths, URLs and cart variables, so each is held to the
 * shape such a name really has before it goes anywhere. */

boolean pgValidDb(char *db)
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

boolean pgSafeToken(char *tok)
/* A sample name, a phase or a sequence name on its way into a file path.
 * The same shape pgValidDb insists on, named for the wider use. */
{
return pgValidDb(tok);
}

boolean pgValidJobId(char *s)
/* Job ids go into a URL path, so restrict to a safe charset to avoid any
 * path/SSRF trickery. */
{
if (isEmpty(s) || strlen(s) > 128)
    return FALSE;
/* Begins with a letter or a digit, which is what keeps "." and ".." out: both
 * pass the character test below and both mean something in a path. */
if (!isalnum((unsigned char)s[0]))
    return FALSE;
char *p;
for (p = s; *p != '\0'; ++p)
    if (!(isalnum((unsigned char)*p) || *p == '_' || *p == '-' || *p == '.'))
        return FALSE;
return TRUE;
}

boolean pgValidHapName(char *s)
/* A haplotype as the graph names it, SAMPLE#PHASE ("HG00097#1"), or one of its
 * sequences, SAMPLE#PHASE#CONTIG.  Nothing else is passed on as a target: the
 * limits on a request count its targets, and a word that the mapping server
 * reads as "all of them" would be counted as one. */
{
if (isEmpty(s) || strlen(s) > 200)
    return FALSE;
char *dupe = cloneString(s);
char *fields[4];
int i, n = chopByChar(dupe, '#', fields, ArraySize(fields));
boolean ok = (n == 2 || n == 3);
for (i = 0; ok && i < n; ++i)
    ok = pgValidDb(fields[i]);
freeMem(dupe);
return ok;
}

/* ---- The pages --------------------------------------------------------------
 *
 * Four, chosen by "page": none for PanView's form, "results" for a mapping
 * job's table, "convert" for PanLift, and "liftAll" for one PanLift region on
 * every haplotype.  First what they are built from. */

static void injectConfig()
/* Emit window.pangenomeConfig as an inline (CSP-nonced) script.  The app in
 * hgPangenome.js reads this on DOMContentLoaded, which fires after inline
 * scripts have run, so ordering relative to the external <script src> is safe. */
{
/* Note: the middleware base URL is deliberately NOT sent to the browser; the
 * browser only ever talks to this CGI (same origin). */
jsInlineF("window.pangenomeConfig = {\n"
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
          "  minTargetCoverage: %d,\n"
          "  maxTargetNodes: %d,\n"
          "  maxChosenTargets: %d,\n"
          "  hgsid: \"%s\",\n"
          "  quickLiftEnabled: %s,\n"
          "  quickLift: %s\n"
          "};\n",
          PG_POLL_INTERVAL_MS, pgMaxSequences(), PG_MAX_MULTIMAPS,
          PG_MIN_HAP_COVERAGE,
          (long)PG_MAX_LIFT_SPAN,
          jsonStringEscape(PG_DEFAULT_SRC_DB),
          jsonStringEscape(PG_DEFAULT_POSITION),
          jsonStringEscape(PG_DEFAULT_TARGET),
          /* hgConvert sends the assembly the user picked there, so the page
           * opens on it rather than on the default. */
          jsonStringEscape(cgiUsualString("pgTarget", "")),
          jsonStringEscape(cgiUsualString("pgAnnot", "")),
          jsonStringEscape(cgiUsualString("pgHide", "")),
          PG_MIN_TARGET_COVERAGE,
          PG_MAX_TARGET_NODES,
          PG_MAX_CHOSEN_TARGETS,
          cartSessionId(cart),
          quickLiftEnabled(cart) ? "true" : "false",
          PG_QUICKLIFT_DEFAULT ? "true" : "false");
}

static void drawForm()
/* The search form, built in the browser the way hgBlat's new form is built by
 * hgBlat.js: this emits an empty .gbApp container and the form's settings as an
 * inline hgPangenomeFormData object, and hgPangenome.js lays the controls out
 * inside it.  Unlike BLAT's, the form never posts to this CGI - hgPangenome.js
 * reads the controls, submits the job itself and polls it - so there is no
 * <form> for the browser to serialize, only the container.
 *
 * The limits the job is held to (pangenome.maxSequences, PG_MAX_MULTIMAPS) are in
 * window.pangenomeConfig already; this carries only what the form adds. */
{
printf("<div id='pgFormBox' class='gbApp'></div>\n");
/* Progress and errors.  Emitted here rather than built by the script, so that
 * the page has somewhere to say what went wrong even when the script cannot
 * run; hgPangenome.js moves the status box into the form, beside the buttons
 * it reports on. */
printf("<div id='pgStatus' class='pgStatus' style='display:none'></div>\n");

struct jsonWrite *jw = jsonWriteNew();
jsonWriteObjectStart(jw, NULL);
/* The per-sequence length the server enforces, so the character counter can
 * say a sequence is too long before it is submitted rather than after. */
jsonWriteNumber(jw, "maxSeqLen", pgMaxSeqLen());
/* And the size of the whole request, which the form checks as it is typed:
 * one sequence at the limit is fine, and so many of them may not be. */
jsonWriteNumber(jw, "maxRequestBytes", PG_MAX_REQUEST_BYTES);
jsonWriteString(jw, "graphLabel", pgGraphLabel());
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
 * (cmd=liftoverAll); js/hgPangenomeConvert.js drives both. */
{
/* Whatever the user was last viewing, if anything. */
char *db = cartUsualString(cart, "db", "");
char *position = cartUsualString(cart, "position", "");

printf("<form id='pgcForm' onsubmit='return false;'>\n");
printf("<h2>PanLift</h2>\n");
printf("<p>Convert a region to other haplotypes through the pangenome graph.</p>\n");

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
/* Both come from the cart, which a link can fill in, so they are escaped. */
printf("<input type='hidden' id='pgcSrcDb' value='%s'>\n", htmlEncode(db));
printf("<input type='hidden' id='pgcPos' value='%s'>\n", htmlEncode(position));
printf("<div id='pgcSrcNote' class='pgMuted'></div>\n");
printf("<div class='pgMuted'>To change the region, go to it in the "
       "<a href='../cgi-bin/hgTracks'>Genome Browser</a>.</div>"
       "</td></tr>\n");
printf("</table>\n");

/* ---- two ways on ----
 *
 * Someone who knows the haplotype they want picks it here and converts.
 * Someone who does not yet - who wants to see which haplotypes carry the
 * region well before choosing - goes to the all-haplotypes page, which opens
 * any of them from its table.  Two boxes with an "or" between them, so the
 * second is not read as one more button of the first. */
printf("<div class='pgcPath'>\n");
printf("<div class='pgcPathHead'>I know which haplotypes I want</div>\n");
printf("<table class='hgPangenomeTable pgcTable' border=0>\n");

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
    boolean on = PG_QUICKLIFT_DEFAULT;
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
           "Hide default tracks</label></div>\n");
    /* Filled in by the page once it has asked what the source has showing.
     * Saying "nothing to carry over" here, before the Submit, is the whole
     * point: said afterwards it is a wasted conversion. */
    printf("</td></tr>\n");
    }

printf("<tr><td></td><td>\n");
printf("<input type='button' id='pgcSubmit' value='Convert'>\n");
printf("<input type='button' id='pgcClear' value='Clear'>\n");
printf("</td></tr>\n");
printf("</table>\n");
printf("</div>\n");

printf("<div class='pgcOr'><span>or</span></div>\n");

/* Every haplotype in one request, on a page of its own (page=liftAll). */
printf("<div class='pgcPath'>\n");
printf("<div class='pgcPathHead'>I want to compare haplotypes</div>\n");
printf("<div class='pgcPathText'>See how this region carries over to every "
       "haplotype, then open any of them.</div>\n");
printf("<input type='button' id='pgcAllBtn' value='View all haplotypes' "
       "title='Translate this region to every haplotype in the pangenome and "
       "summarize how it carries over'>\n");
printf("</div>\n");
printf("</form>\n");

printf("<div id='pgcStatus' class='pgStatus' style='display:none'></div>\n");
printf("<div id='pgcResults' class='pgResults'></div>\n");

printf("<p>Have a sequence instead?  Use <a href='hgPangenome'>PanView</a>.</p>\n");
}

static void pageStart(char *title)
/* The top of a page: the browser's header with the page's purpose in the gold
 * bar, as hgBlat's new form has it, and the bottleneck server's warning for a
 * reader who has earned one.  cartWebStart HTML-escapes the title, so a dash
 * in one is a literal em dash and not &mdash;. */
{
cartWebStart(cart, NULL, "%s", title);
if (issueBotWarning)
    botDelayMessage(getenv("REMOTE_ADDR"), botDelayMillis);
}

static void pgJsonBackLink(struct jsonWrite *jw)
/* Where "Back to Genome Browser" goes.  Offered, as on hgBlat's results page,
 * only when the cart has a position to go back to. */
{
char *backPos = cartOptionalString(cart, "position");
char *backDb = cartOptionalString(cart, "db");
if (!isEmpty(backPos) && !isEmpty(backDb))
    {
    jsonWriteStringf(jw, "backUrl", "hgTracks?db=%s&%s=%s",
                     backDb, cartSessionVarName(), cartSessionId(cart));
    jsonWriteString(jw, "backPos", backPos);
    }
}

static void pageResults()
/* page=results: the results of one mapping job, as a sortable table.  Reached
 * by an ordinary URL naming only the job, the way hgBlat's results page is:
 * reloading it works, and it can be handed to someone else for as long as the
 * job is still cached upstream. */
{
pageStart("PanView Results");
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
 * themselves, for "Show Query Sequence", and where its two header buttons go. */
struct jsonWrite *jw = jsonWriteNew();
jsonWriteObjectStart(jw, NULL);
pgJsonQuerySeqs(jw, "querySeqs", jobId);
jsonWriteStringf(jw, "newSearchUrl", "hgPangenome?%s=%s",
                 cartSessionVarName(), cartSessionId(cart));
pgJsonBackLink(jw);
jsonWriteString(jw, "graphLabel", pgGraphLabel());
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
    jsonWriteString(jw, "annotDefault", PG_ANNOTATION_DEFAULT);
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
jsInlineF("var pangenomeSurjectTop = %d;\n", PG_RESULTS_SURJECT_TOP);
jsInlineF("var pangenomeSurjectMax = %d;\n", PG_MAX_SURJECT_TARGETS);
/* Place every haplotype of every hit as soon as the first table is up,
 * rather than when the reader turns to a page that shows one: one batch
 * call per hit, one at a time per page view. */
jsInlineF("var pangenomePlaceAllAtLoad = %s;\n",
          PG_RESULTS_PLACE_ALL_AT_LOAD ? "true" : "false");
/* Coverage floor for the batch surjection.  Left at zero: the service
 * returns its targets best coverage first and stops at max_targets, so the
 * floor only decides what is eligible, and a default of 50 quietly threw
 * away every partial match - a read whose best other haplotype covers 42%
 * came back with one row. */
jsInlineF("var pangenomeMinCoverage = %d;\n", PG_RESULTS_MIN_COVERAGE);
/* What the table shows by default, which the reader can lower to the floor
 * above or raise: a loose cut that keeps pieces of pseudogenes and other
 * short fragments out without hiding a second full copy. */
jsInlineF("var pangenomeShowCoverage = %d;\n", PG_RESULTS_SHOW_COVERAGE);
/* The ancestry plot is optional.  With pangenome.resultsPclai off, the flag
 * is false, the module is never loaded and the results page has no plot
 * control and no checkbox column - exactly as before the feature existed. */
boolean pclai = pgAncestryOn();
jsInlineF("var pangenomePclai = %s;\n", pclai ? "true" : "false");
/* Coverage floor for the ancestry plot only - the table still lists every
 * hit.  The batch surjection is asked for a COUNT of targets, not a
 * quality, and answers best first: where a region is carried by fewer
 * haplotypes than that count, the remaining slots fill with incidental
 * repeat matches covering a few per cent of the query.  Those are not
 * wrong, and belong in the table, but averaging their ancestry in with the
 * real hits moves the centroid and inflates the dispersion.  The page can
 * change this; this is only where the slider starts. */
jsInlineF("var pangenomePclaiMinCoverage = %d;\n", PG_PCLAI_MIN_COVERAGE);
jsIncludeFile("hgPangenomeCommon.js", NULL);    /* first: the others are written on it */
jsIncludeFile("hgPangenomeAssemblies.js", NULL);
if (pclai)
    jsIncludeFile("hgPangenomePclai.js", NULL);
jsIncludeFile("hgPangenomeSamples.js", NULL);   /* the Population column */
jsIncludeFile("hgPangenomeResults.js", NULL);
cartWebEnd();
}

static void pageLiftAll()
/* page=liftAll: one PanLift region on every haplotype in the graph: how it
 * carries over, and the table.  Named entirely by the link - the source path
 * and the interval - so it can be reloaded and handed on; cmd=liftoverAll
 * checks them again. */
{
pageStart("PanLift — All haplotypes");
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
pgJsonBackLink(jw);
jsonWriteObjectEnd(jw);
jsInlineF("var pangenomeLiftAll = %s;\n", jw->dy->string);
jsonWriteFree(&jw);
boolean pclai = pgAncestryOn();
jsInlineF("var pangenomePclai = %s;\n", pclai ? "true" : "false");
jsIncludeFile("hgPangenomeCommon.js", NULL);
jsIncludeFile("hgPangenomeAssemblies.js", NULL);
jsIncludeFile("hgPangenomeSamples.js", NULL);
if (pclai)
    jsIncludeFile("hgPangenomePclai.js", NULL);
jsIncludeFile("hgPangenomeConvert.js", NULL);
cartWebEnd();
}

static void pageConvert()
/* page=convert: PanLift's form, and under it the result of a conversion. */
{
pageStart("PanLift");
/* gbModern.css for the ancestry plot's details panel, which is the results
 * page's; everything in it is scoped to .gbApp, so the form is untouched. */
webIncludeResourceFile("gbModern.css");
webIncludeResourceFile("hgPangenome.css");
drawConvertPage();
injectConfig();
/* The ancestry plot of the converted regions: the same switch as the
 * results page's, since it is the same data and the same plot. */
boolean pclai = pgAncestryOn();
jsInlineF("var pangenomePclai = %s;\n", pclai ? "true" : "false");
/* The results table pages and sorts as the mapping results page's does. */
jsIncludeDataTablesLibs();
jsIncludeFile("hgPangenomeCommon.js", NULL);
jsIncludeFile("hgPangenomeAssemblies.js", NULL);
jsIncludeFile("hgPangenomeSamples.js", NULL);   /* generated sample->population table */
if (pclai)
    jsIncludeFile("hgPangenomePclai.js", NULL);
jsIncludeFile("hgPangenomeConvert.js", NULL);
cartWebEnd();
}

static void pageForm()
/* No page named: PanView's form. */
{
pageStart("PanView — Find a DNA sequence across the human pangenome");
webIncludeResourceFile("gbModern.css");   // shared house-style components (.gbPill, .gbCard, ...)
webIncludeResourceFile("hgPangenome.css");

drawForm();

/* Config first (inline, runs before DOMContentLoaded), then the app. */
injectConfig();
jsIncludeFile("hgPangenomeCommon.js", NULL);
jsIncludeFile("hgPangenome.js", NULL);

cartWebEnd();
}

/* ---- The commands -----------------------------------------------------------
 *
 * Every value of "cmd" this CGI answers, in one table: who answers it, what it
 * weighs with the bottleneck server, and whether it needs the cart.  Each
 * answers in JSON and writes its own Content-Type. */

struct pgCommand
/* One command. */
    {
    char *name;                 /* the value of "cmd" */
    void (*answer)(void);       /* writes the whole response */
    double botWeight;           /* weight with the bottleneck server; 0: not rate limited */
    boolean inCart;             /* runs inside the cart shell */
    boolean leavesCart;         /* ... and exits without saving the cart */
    };

/* Rate limiting is the UCSC bottleneck server's, as hgBlat uses it.  Work the
 * graph server does costs seconds, so it carries the full weight where hgBlat
 * carries half.  Reads that cost it nothing are not limited: a job is polled
 * many times, and limiting that would punish the reader for waiting. */
#define PG_FULL_WEIGHT 1.0
#define PG_HALF_WEIGHT 0.5

static struct pgCommand commands[] = {
    /* forwarded to the graph server (proxy.c) */
    {"map",             doMap,             PG_FULL_WEIGHT, FALSE, FALSE},
    {"poll",            doPoll,            0,              FALSE, FALSE},
    {"haplotypes",      doHaplotypes,      0,              FALSE, FALSE},
    {"liftoverTargets", doLiftoverTargets, PG_FULL_WEIGHT, FALSE, FALSE},
    {"liftoverAll",     doLiftoverAll,     PG_FULL_WEIGHT, FALSE, FALSE},
    {"surject",         doSurject,         PG_FULL_WEIGHT, FALSE, FALSE},
    {"surjectAll",      doSurjectAll,      0,              FALSE, FALSE},
    /* answered from files on this server, without the cart: the pages ask for
     * these whenever what they show changes.  cmd=locus is asked once for each
     * page of the results table and reads gene files for up to 200 rows, so it
     * is limited at the weight hgBlat and hgc carry. */
    {"contigs",         doContigs,         0,              FALSE, FALSE},
    {"pclai",           doPclai,           0,              FALSE, FALSE},
    {"locus",           doLocus,           PG_HALF_WEIGHT, FALSE, FALSE},
    /* building a hub or a custom track, which needs the cart (liftedTracks.c,
     * seqTrack.c).  cmd=extendChain is sent after the reader has followed the
     * link and nothing waits for its answer; saving its copy of the cart would
     * write over whatever the browser has done in the seconds since, undoing
     * tracks the reader turned on meanwhile.  It has nothing to save, so it
     * leaves without saving. */
    {"quickLift",       doQuickLift,       PG_FULL_WEIGHT, TRUE,  FALSE},
    {"extendChain",     doExtendChain,     PG_FULL_WEIGHT, TRUE,  TRUE},
    {"refAnnot",        doRefAnnot,        PG_FULL_WEIGHT, TRUE,  FALSE},
    {"alignTrack",      doAlignTrack,      PG_FULL_WEIGHT, TRUE,  FALSE},
};

static struct pgCommand *cartCommand = NULL;    /* the command doMiddle() is to run */

static struct pgCommand *pgFindCommand(char *name)
/* The command of that name, or NULL. */
{
int i;
for (i = 0; i < ArraySize(commands); i++)
    if (sameString(commands[i].name, name))
        return &commands[i];
return NULL;
}

static void pgRunCartCommand(struct pgCommand *command)
/* Run one of the commands that work inside the cart, and answer for it if it
 * aborts.  An errAbort from the library - a file that will not open, a hub
 * that will not parse - would otherwise go to the cart shell, which answers a
 * JSON caller with an HTML page, and would leave the cart's db on whatever
 * assembly the command had borrowed it for, saved that way. */
{
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    command->answer();
errCatchEnd(errCatch);
if (errCatch->gotError)
    {
    if (pgDbBorrowed)
        pgRestoreDb(pgDbBefore);
    fprintf(stderr, "hgPangenome: cmd=%s aborted: %s\n", command->name,
            trimSpaces(errCatch->message->string));
    emitJsonError("the request could not be completed: %.300s",
                  trimSpaces(errCatch->message->string));
    }
errCatchFree(&errCatch);
}

void doMiddle(struct cart *theCart)
/* Inside the cart: run the command main() chose, or write a page. */
{
cart = theCart;

if (cartCommand != NULL)
    {
    pgRunCartCommand(cartCommand);
    if (cartCommand->leavesCart)
        {
        fflush(stdout);
        exit(0);
        }
    return;
    }

if (!pgToolsOn())
    {
    cartWebStart(cart, NULL, "Pangenome tools");
    printf("<p>PanView and PanLift are not available on this server.</p>\n");
    cartWebEnd();
    return;
    }

/* Any page is a good moment to take away hubs whose files have been swept:
 * the user is here, and the dead entry is what puts a red error group on every
 * hgTracks page. */
pgForgetStaleHubs(NULL, TRUE);

char *page = cgiOptionalString("page");
if (sameOk(page, "results"))
    pageResults();
else if (sameOk(page, "liftAll"))
    pageLiftAll();
else if (sameOk(page, "convert"))
    pageConvert();
else
    pageForm();
}

static boolean pgBotCheck(long enteredMainTime, double weight)
/* The bottleneck server's rate limit for one command.  FALSE when the request
 * has been answered already and the caller should stop.
 *
 * If the bottleneck server itself is unreachable, botDelay errAborts, which
 * would send an HTML 500 down a JSON endpoint (the client would show raw
 * markup).  Catch it and answer with our error envelope instead - the pattern
 * botDelay.c documents for JSON endpoints.  A genuine hog still exits via
 * hogExit(), which emits JSON 429. */
{
struct errCatch *errCatch = errCatchNew();
if (errCatchStart(errCatch))
    earlyBotCheck(enteredMainTime, "hgPangenome", weight, 0, 0, "json");
errCatchEnd(errCatch);
boolean ok = !errCatch->gotError;
if (!ok)
    {
    /* Detail (host/port of the bottleneck server) goes to the error log, not
     * to the browser. */
    fprintf(stderr, "hgPangenome: bot check failed: %s\n",
            trimSpaces(errCatch->message->string));
    emitJsonError("rate limiter unavailable, please try again in a moment");
    }
errCatchFree(&errCatch);
return ok;
}

int main(int argc, char *argv[])
/* Answer one request: a command when "cmd" names one, otherwise a page. */
{
long enteredMainTime = clock1000();
cgiSpoof(&argc, argv);
oldVars = hashNew(8);

char *cmd = cgiOptionalString("cmd");
if (isEmpty(cmd))
    {
    /* A page.  A reader the bottleneck server is holding back gets its HTML
     * answer here; one it only warns is told so at the top of the page. */
    issueBotWarning = earlyBotCheck(enteredMainTime, "hgPangenome", PG_FULL_WEIGHT, 0, 0, "html");
    cartEmptyShell(doMiddle, hUserCookie(), excludeVars, oldVars);
    return 0;
    }

/* Off on this server: every command says so, and the page does in doMiddle. */
if (!pgToolsOn())
    {
    emitJsonError("PanView and PanLift are not available on this server");
    return 0;
    }

/* One size cap for every command, before any of them runs.
 *
 * cheapcgi.c enforces its own 1 MB cap (CGI_INPUT_SIZE_LIMIT_DEFAULT) and
 * aborts with an HTML error page, which a JSON client can only report as
 * "Unexpected token '<'".  Ours has to sit below that so an oversized request
 * comes back as our own error envelope instead. */
char *payload = cgiOptionalString("payload");
if (payload != NULL && (long)strlen(payload) > PG_MAX_REQUEST_BYTES)
    {
    emitJsonError("request too large: %ld bytes (limit %ld)",
                  (long)strlen(payload), (long)PG_MAX_REQUEST_BYTES);
    return 0;
    }

struct pgCommand *command = pgFindCommand(cmd);
if (command == NULL)
    {
    emitJsonError("unknown command '%.40s'", cmd);
    return 0;
    }
if (command->botWeight > 0 && !pgBotCheck(enteredMainTime, command->botWeight))
    return 0;
if (command->inCart)
    {
    /* Through the shell that leaves the Content-Type to the command. */
    cartCommand = command;
    cartEmptyShellNoContent(doMiddle, hUserCookie(), excludeVars, oldVars);
    }
else
    command->answer();
return 0;
}
