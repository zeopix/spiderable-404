var fs = Npm.require('fs');
var child_process = Npm.require('child_process');
var querystring = Npm.require('querystring');
var urlParser = Npm.require('url');

Spiderable = {};

// list of bot user agents that we want to serve statically, but do
// not obey the _escaped_fragment_ protocol. The page is served
// statically to any client whos user agent matches any of these
// regexps. Users may modify this array.
Spiderable.userAgentRegExps = [/^facebookexternalhit/i, /^linkedinbot/i];

// how long to let phantomjs run before we kill it
var REQUEST_TIMEOUT = 15*1000;

WebApp.connectHandlers.use(function (req, res, next) {
  if (/\?.*_escaped_fragment_=/.test(req.url) ||
      _.any(Spiderable.userAgentRegExps, function (re) {
        return re.test(req.headers['user-agent']); })) {

    // reassembling url without escaped fragment if exists
    var parsedUrl = urlParser.parse(req.url);
    var parsedQuery = querystring.parse(parsedUrl.query);
    delete parsedQuery['_escaped_fragment_'];
    var newQuery = querystring.stringify(parsedQuery);
    var newPath = parsedUrl.pathname + (newQuery ? ('?' + newQuery) : '');
    var url = "http://" + req.headers.host + newPath;

    // This string is going to be put into a bash script, so it's important
    // that 'url' (which comes from the network) can neither exploit phantomjs
    // or the bash script. JSON stringification should prevent it from
    // exploiting phantomjs, and since the output of JSON.stringify shouldn't
    // be able to contain newlines, it should be unable to exploit bash as
    // well.
    var phantomScript = "var url = " + JSON.stringify(url) + ";" +
          "var page = require('webpage').create();" +
          "page.open(url);" +
          "setInterval(function() {" +
          "  var ready = page.evaluate(function () {" +
          "    if (typeof Meteor !== 'undefined' " +
          "        && typeof(Meteor.status) !== 'undefined' " +
          "        && Meteor.status().connected) {" +
          "      Deps.flush();" +
          "      return DDP._allSubscriptionsReady();" +
          "    }" +
          "    return false;" +
          "  });" +
          "  if (ready) {" +
          "    var response = page.evaluate(function() {" +
          "        return Spiderable;" +
          "    });" +
          "    if(response.httpStatusCode != 200 " +
          "       || Object.keys(response.httpHeaders).length > 0) {" +
          "      console.log('<!-- HTTP-RESPONSE:' + response.httpStatusCode + ' ' " +
          "             + JSON.stringify(response.httpHeaders) + ' -->');" +
          "    }" +
          "    var out = page.content;" +
          "    out = out.replace(/<script[^>]+>(.|\\n|\\r)*?<\\/script\\s*>/ig, '');" +
          "    out = out.replace('<meta name=\"fragment\" content=\"!\">', '');" +
          "    console.log(out);" +
          "    phantom.exit();" +
          "  }" +
          "}, 1000);\n";

    // Run phantomjs.
    //
    // Use '/dev/stdin' to avoid writing to a temporary file. We can't
    // just omit the file, as PhantomJS takes that to mean 'use a
    // REPL' and exits as soon as stdin closes.
    //
    // However, Node 0.8 broke the ability to open /dev/stdin in the
    // subprocess, so we can't just write our string to the process's stdin
    // directly; see https://gist.github.com/3751746 for the gory details. We
    // work around this with a bash heredoc. (We previous used a "cat |"
    // instead, but that meant we couldn't use exec and had to manage several
    // processes.)
    child_process.execFile(
      '/bin/bash',
      ['-c',
       ("exec phantomjs --load-images=no /dev/stdin <<'END'\n" +
        phantomScript + "END\n")],
      {timeout: REQUEST_TIMEOUT},
      function (error, stdout, stderr) {
        if (!error && /<html/i.test(stdout)) {
          var match,
              headers,
              statusCode = 200,
              responseRegexp = /^<!-- HTTP-RESPONSE:([0-9]+) ({.*}) -->\n/;
          if(match = stdout.match(responseRegexp)) {
            statusCode = parseInt(match[1]);
            headers = JSON.parse(match[2]);
            stdout = stdout.replace(responseRegexp, '');
            if (!headers['Content-Type']) {
              headers['Content-Type'] = 'text/html; charset=UTF-8';
            }
            res.writeHead(statusCode, headers);
          } else {
            res.writeHead(200, {'Content-Type': 'text/html; charset=UTF-8'});
          }
          res.end(stdout);
        } else {
          // phantomjs failed. Don't send the error, instead send the
          // normal page.
          if (error && error.code === 127)
            Meteor._debug("spiderable: phantomjs not installed. Download and install from http://phantomjs.org/");
          else
            Meteor._debug("spiderable: phantomjs failed:", error, "\nstderr:", stderr);

          next();
        }
      });
  } else {
    next();
  }
});
