#!/usr/bin/env perl

use strict;
use warnings;
use HTTP::Tiny;
use Time::HiRes;
use JSON;
use Getopt::Long;

my $http = HTTP::Tiny->new();
# my $server = 'https://apibeta.soe.ucsc.edu';
# my $server = 'http://localhost:1236/cgi-bin/hubApi';
my $server = 'https://api-test.gi.ucsc.edu';
# my $server="https://genome-euro.ucsc.edu/cgi-bin/loader/hubApi";
# my $server = 'https://hgwdev-api.gi.ucsc.edu';
# my $server = 'https://hgwbeta.soe.ucsc.edu/cgi-bin/hubApi';
# my $server = 'https://hgwdev-hiram.gi.ucsc.edu/cgi-bin/hubApi';
my $globalHeaders = { 'Content-Type' => 'application/json' };
my $lastRequestTime = Time::HiRes::time();
my $processStartTime = Time::HiRes::time();
my $requestCount = 0;

##############################################################################
# command line options
my $endpoint = "";
my $hubUrl = "";
my $genome = "";
my $track = "";
my $chrom = "";
my $start = "";
my $end = "";
my $test0 = 0;
my $debug = 0;
my $trackLeavesOnly = 0;
my $measureTiming = 0;
my $jsonOutputArrays = 0;
my $maxItemsOutput = "";
##############################################################################

sub usage() {
printf STDERR "usage: ./jsonConsumer.pl [arguments]\n";
printf STDERR "arguments:
-test0 - perform test of /list/publicHubs and /list/ucscGenomes endpoints
-hubUrl=<URL> - use the URL to access the track or assembly hub
-genome=<name> - name for UCSC database genome or assembly/track hub genome
-track=<trackName> - specify a single track in a hub or database
-chrom=<chromName> - restrict the operation to a single chromosome
-start=<coordinate> - restrict the operation to a range, use both start and end
-end=<coordinate> - restrict the operation to a range, use both start and end
-maxItemsOutput=<N> - limit output to this number of items.  Default 1,000
                      maximum allowed 1,000,000
-trackLeavesOnly - for list tracks function, no containers listed
-measureTimeing - turn on timing measurement
-debug - turn on debugging business
-endpoint=<function> - where <function> is one of the following:
   /list/publicHubs - provide a listing of all available public hubs
   /list/ucscGenomes - provide a listing of all available UCSC genomes
   /list/hubGenomes - list genomes from a specified hub (with hubUrl=...)
   /list/tracks - list data tracks available in specified hub or database genome
   /list/chromosomes - list chromosomes from specified data track
   /getData/sequence - return sequence from specified hub or database genome
   /getData/track - return data from specified track in hub or database genome
";
}

#########################################################################
# generic output of a hash pointer
sub hashOutput($) {
  my ($hashRef) = @_;
  foreach my $key (sort keys %$hashRef) {
    my $value = $hashRef->{$key};
    $value = "<array>" if (ref($value) eq "ARRAY");
    $value = "<hash>" if (ref($value) eq "HASH");
     printf STDERR "%s - %s\n", $key, $hashRef->{$key};
  }
}

sub arrayOutput($) {
  my ($ary) = @_;
  my $i = 0;
  foreach my $element (@$ary) {
     printf STDERR "# %d\t%s\n", $i++, ref($element);
     if (ref($element) eq "HASH") {
       hashOutput($element);
     }
  }
}
#########################################################################

##############################################################################
###
### these functions were copied from Ensembl HTTP::Tiny example code:
###  https://github.com/Ensembl/ensembl-rest/wiki/Example-Perl-Client
###
##############################################################################

##############################################################################
sub performJsonAction {
  my ($endpoint, $parameters) = @_;
  my $headers = $globalHeaders;
  my $content = performRestAction($endpoint, $parameters, $headers);
  return {} unless $content;
  my $json = decode_json($content);
  return $json;
}

##############################################################################
sub performRestAction {
  my ($endpoint, $parameters, $headers) = @_;
  $parameters ||= {};
  $headers ||= {};
  $headers->{'Content-Type'} = 'application/json' unless exists $headers->{'Content-Type'};
  if($requestCount == 15) { # check every 15
    my $currentTime = Time::HiRes::time();
    my $diff = $currentTime - $lastRequestTime;
    # if less than a second then sleep for the remainder of the second
    if($diff < 1) {
      Time::HiRes::sleep(1-$diff);
    }
    # reset
    $lastRequestTime = Time::HiRes::time();
    $requestCount = 0;
  }

  $endpoint =~ s#^/##;
  my $url = "$server/$endpoint";

  if(%{$parameters}) {
    my @params;
    foreach my $key (keys %{$parameters}) {
      my $value = $parameters->{$key};
      push(@params, "$key=$value");
    }
    my $param_string = join(';', @params);
    $url.= '?'.$param_string;
  }
  if ($debug) { $url .= ";debug=1"; }
  if ($measureTiming) { $url .= ";measureTiming=1"; }
  if ($jsonOutputArrays) { $url .= ";jsonOutputArrays=1"; }
  if (length($maxItemsOutput)) { $url .= ";maxItemsOutput=$maxItemsOutput"; }
  printf STDERR "### '%s'\n", $url;
  my $response = $http->get($url, {headers => $headers});
  my $status = $response->{status};
  if(!$response->{success}) {
    # Quickly check for rate limit exceeded & Retry-After (lowercase due to our client)
    if($status == 429 && exists $response->{headers}->{'retry-after'}) {
      my ($status, $reason) = ($response->{status}, $response->{reason});
      my $retry = $response->{headers}->{'retry-after'};
      printf STDERR "Failed for $endpoint! Status code: ${status}. Reason: ${reason}, retry-after: $retry seconds\n";
#      hashOutput($response->{headers});
      Time::HiRes::sleep($retry);
      # After sleeping see that we re-request
      return performRestAction($endpoint, $parameters, $headers);
    }
    else {
      my ($status, $reason) = ($response->{status}, $response->{reason});
#      die "Failed for $endpoint! Status code: ${status}. Reason: ${reason}\n";
      printf STDERR "Failed for $endpoint! Status code: ${status}. Reason: ${reason}\n";
# hashOutput($response->{headers});
# hashOutput($response->{content});
# printf STDERR "'%s'\n", $response->{content};
# printf STDERR "'%s'\n", $response->{headers};
      return return $response->{content};
    }
  }
  $requestCount++;
  if(length $response->{content}) {
    return $response->{content};
  }
  return;
}

#############################################################################
sub columnNames($) {
  my ($nameArray) = @_;
  if (ref($nameArray) ne "ARRAY") {
    printf "ERROR: do not have an array reference in columnNames\n";
  } else {
    printf "### Column names in table return:\n";
    my $i = 0;
    foreach my $name (@$nameArray) {
      printf "%d\t\"%s\"\n", ++$i, $name;
    }
  }
}

sub topLevelKeys($) {
  my ($topHash) = @_;
  printf "### keys in top level hash:\n";
  foreach my $topKey ( sort keys %$topHash) {
    # do not print out the downloadTime and downloadTimeStamps since that
    # would make it difficult to have a consistent test output.
    next if ($topKey eq "downloadTime");
    next if ($topKey eq "downloadTimeStamp");
    next if ($topKey eq "botDelay");
    next if ($topKey eq "dataTime");
    next if ($topKey eq "dataTimeStamp");
    my $value = $topHash->{$topKey};
    $value = "<array>" if (ref($value) eq "ARRAY");
    $value = "<hash>" if (ref($value) eq "HASH");
    printf "\"%s\":\"%s\"\n", $topKey,$value;
  }
}

#############################################################################
sub checkError($$$) {
  my ($json, $endpoint, $expect) = @_;
  my $jsonReturn = performJsonAction($endpoint, "");
#   printf "%s", $json->pretty->encode( $jsonReturn );
  if (! defined($jsonReturn->{'error'}) ) {
     printf "ERROR: no error received from endpoint: '%s', received:\n", $endpoint;
     printf "%s", $json->pretty->encode( $jsonReturn );
  } else {
     if ($jsonReturn->{'error'} ne "$expect '$endpoint'") {
	printf "incorrect error received from endpoint '%s':\n\t'%s'\n", $endpoint, $jsonReturn->{'error'};
     }
     printf "%s", $json->pretty->encode( $jsonReturn );
  }
}

#############################################################################
sub verifyCommandProcessing()
{
    my $json = JSON->new;
    # verify command processing can detected bad input
    my $endpoint = "/list/noSubCommand";
    my $expect = "do not recognize endpoint function:";
    checkError($json, $endpoint,$expect);
}	#	sub verifyCommandProcessing()


#############################################################################
sub processEndPoint() {
  my $errReturn = 0;
  if (length($endpoint)) {
     my $json = JSON->new;
     my $jsonReturn = {};
     if ($endpoint eq "/list/hubGenomes") {
	my %parameters;
	# allow no hubUrl argument to test error reports
        if (length($hubUrl)) {
	   $parameters{"hubUrl"} = "$hubUrl";
        }
        if (length($genome)) {
	   $parameters{"genome"} = "$genome";
        }
	$jsonReturn = performJsonAction($endpoint, \%parameters);
	$errReturn = 1 if (defined ($jsonReturn->{'error'}));
	printf "%s", $json->pretty->encode( $jsonReturn );
     } elsif ($endpoint eq "/list/tracks") {
	# no need to verify arguments here, pass them along, or not,
	# so that error returns can be verified
	my %parameters;
	if (length($chrom)) {
	    $parameters{"chrom"} = "$chrom";
	}
	if ($trackLeavesOnly) {
	    $parameters{"trackLeavesOnly"} = "1";
	}
	# allow no hubUrl argument to test error reports
        if (length($hubUrl)) {
	  $parameters{"hubUrl"} = "$hubUrl";
	}
	# allow call to go through without a genome specified to test error
	if (length($genome)) {
	  $parameters{"genome"} = "$genome";
	}
	$jsonReturn = performJsonAction($endpoint, \%parameters);
	$errReturn = 1 if (defined ($jsonReturn->{'error'}));
	printf "%s", $json->pretty->encode( $jsonReturn );
     } elsif ($endpoint eq "/list/chromosomes") {
	my %parameters;
	if (length($chrom)) {
	    $parameters{"chrom"} = "$chrom";
	}
	if ($trackLeavesOnly) {
	    $parameters{"trackLeavesOnly"} = "1";
	}
	if (length($hubUrl)) {
	    $parameters{"hubUrl"} = "$hubUrl";
	}
	# allow call to go through without a genome specified to test error
	if (length($genome)) {
	    $parameters{"genome"} = "$genome";
	}
	if (length($track)) {
	    $parameters{"track"} = "$track";
	}
	$jsonReturn = performJsonAction($endpoint, \%parameters);
	$errReturn = 1 if (defined ($jsonReturn->{'error'}));
	printf "%s", $json->pretty->encode( $jsonReturn );
     } elsif ($endpoint eq "/getData/sequence") {
	my %parameters;
	if ($trackLeavesOnly) {
	    $parameters{"trackLeavesOnly"} = "1";
	}
	if (length($hubUrl)) {
	  $parameters{"hubUrl"} = "$hubUrl";
	}
	# allow call to go through without a genome specified to test error
	if (length($genome)) {
	  $parameters{"genome"} = "$genome";
	}
	if (length($chrom)) {
	    $parameters{"chrom"} = "$chrom";
	}
	if (length($start)) {
	    $parameters{"start"} = "$start";
	    $parameters{"end"} = "$end";
	}
	$jsonReturn = performJsonAction($endpoint, \%parameters);
	$errReturn = 1 if (defined ($jsonReturn->{'error'}));
	printf "%s", $json->pretty->encode( $jsonReturn );
     } elsif ($endpoint eq "/getData/track") {
	my %parameters;
	if (length($hubUrl)) {
	  $parameters{"hubUrl"} = "$hubUrl";
	}
	if ($trackLeavesOnly) {
	    $parameters{"trackLeavesOnly"} = "1";
	}
	# allow call to go through without a genome specified to test error
	if (length($genome)) {
	    $parameters{"genome"} = "$genome";
	}
	if (length($track)) {
	    $parameters{"track"} = "$track";
	}
	if (length($chrom)) {
	    $parameters{"chrom"} = "$chrom";
	}
	if (length($start)) {
	    $parameters{"start"} = "$start";
	    $parameters{"end"} = "$end";
	}
	$jsonReturn = performJsonAction($endpoint, \%parameters);
	$errReturn = 1 if (defined ($jsonReturn->{'error'}));
	printf "%s", $json->pretty->encode( $jsonReturn );
     } else {
#	printf STDERR "# endpoint not supported at this time: '%s'\n", $endpoint;
#	Pass along the bogus request just to test the error handling.
	my %parameters;
	if (length($hubUrl)) {
	  $parameters{"hubUrl"} = "$hubUrl";
	}
	if (length($genome)) {
	    $parameters{"genome"} = "$genome";
	}
	if (length($track)) {
	    $parameters{"track"} = "$track";
	}
	if (length($chrom)) {
	    $parameters{"chrom"} = "$chrom";
	}
	if (length($start)) {
	    $parameters{"start"} = "$start";
	    $parameters{"end"} = "$end";
	}
	$jsonReturn = performJsonAction($endpoint, \%parameters);
	$errReturn = 1 if (defined ($jsonReturn->{'error'}));
	printf "%s", $json->pretty->encode( $jsonReturn );
     }
  } else {
    printf STDERR "ERROR: no endpoint given ?\n";
    exit 255;
  }
  return $errReturn;
}	# sub processEndPoint()

###########################################################################
### test /list/publicHubs and /list/ucscGenomes
sub test0() {

my $json = JSON->new;
my $jsonReturn = {};

verifyCommandProcessing();	# check 'command' and 'subCommand'

$jsonReturn = performJsonAction("/list/publicHubs", "");

# this prints everything out indented nicely:
# printf "%s", $json->pretty->encode( $jsonReturn );

# exit 255;
# __END__

#	"dataTimeStamp" : 1552320994,
#	"downloadTime" : "2019:03:26T21:40:10Z",
#	"botDelay" : 2,
#	"downloadTimeStamp" : 1553636410,
#	"dataTime" : "2019-03-11T09:16:34"

# look for the specific public hub named "Plants" to print out
# for a verify test case
#
if (ref($jsonReturn) eq "HASH") {
  topLevelKeys($jsonReturn);

  if (defined($jsonReturn->{"publicHubs"})) {
     my $arrayData = $jsonReturn->{"publicHubs"};
     foreach my $data (@$arrayData) {
	if ($data->{'shortLabel'} eq "Plants") {
        printf "### Plants public hub data\n";
	  foreach my $key (sort keys %$data) {
	  next if ($key eq "registrationTime");
	  printf "'%s'\t'%s'\n", $key, $data->{$key};
	  }
	}
     }
  }
} elsif (ref($jsonReturn) eq "ARRAY") {
  printf "ERROR: top level returns ARRAY of size: %d\n", scalar(@$jsonReturn);
  printf "should have been a HASH to the publicHub data\n";
}

$jsonReturn = performJsonAction("/list/ucscGenomes", "");
# printf "%s", $json->pretty->encode( $jsonReturn );


if (ref($jsonReturn) eq "HASH") {
  topLevelKeys($jsonReturn);
  if (defined($jsonReturn->{"ucscGenomes"})) {
     my $ucscGenomes = $jsonReturn->{"ucscGenomes"};
     if (exists($ucscGenomes->{'hg38'})) {
	my $hg38 = $ucscGenomes->{'hg38'};
        printf "### hg38/Human information\n";
     foreach my $key (sort keys %$hg38) {
	   printf "\"%s\"\t\"%s\"\n", $key, $hg38->{$key};
         }
       }
     }
} elsif (ref($jsonReturn) eq "ARRAY") {
  printf "ERROR: top level returns ARRAY of size: %d\n", scalar(@$jsonReturn);
  printf "should have been a HASH to the ucscGenomes\n";
}

}	#	sub test0()

sub elapsedTime() {
if ($measureTiming) {
  my $endTime = Time::HiRes::time();
  my $et = $endTime - $processStartTime;
  printf STDERR "# procesing time: %.3fs\n", $et;
}
}

#############################################################################
### main()
#############################################################################

my $argc = scalar(@ARGV);

GetOptions ("hubUrl=s" => \$hubUrl,
    "endpoint=s"  => \$endpoint,
    "genome=s"  => \$genome,
    "track=s"  => \$track,
    "chrom=s"  => \$chrom,
    "start=s"  => \$start,
    "end=s"    => \$end,
    "test0"    => \$test0,
    "debug"    => \$debug,
    "trackLeavesOnly"    => \$trackLeavesOnly,
    "measureTiming"    => \$measureTiming,
    "jsonOutputArrays"    => \$jsonOutputArrays,
    "maxItemsOutput=s"   => \$maxItemsOutput)
    or die "Error in command line arguments\n";

if ($test0) {
   test0;
   elapsedTime();
   exit 0;
}

if ($argc > 0) {
   if (processEndPoint()) {
	elapsedTime();
	exit 255;
   } else {
	elapsedTime();
	exit 0;
   }
}

usage();
