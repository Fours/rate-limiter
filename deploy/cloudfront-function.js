// CloudFront Function (runtime cloudfront-js-2.0), on the distribution's viewer request event.
// Decision 0035.
//
// The bucket is private behind OAC, so CloudFront asks S3's REST API for the exact key, and the
// default root object covers only `/`. Without this, /how-it-works/ is a 403. So:
//
// - a path ending in `/` is served from that folder's index.html;
// - a path whose last segment has no `.` gets a 301 to the same path with a `/`, so there's one
//   URL per page and the page's relative links (`../`) resolve from inside its folder;
// - anything else, such as /assets/demo-abc123.js, passes through.
//
// CloudFront Functions run plain JavaScript with no modules, so there's no export: CloudFront
// calls `handler` by name, and test/deploy/cloudfront-function.test.ts loads the file the same way.

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- called by CloudFront, by name
function handler(event) {
  const request = event.request;
  const uri = request.uri;

  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
    return request;
  }

  const lastSegment = uri.slice(uri.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return request;

  const query = queryString(request.querystring);
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      location: { value: uri + '/' + (query === '' ? '' : '?' + query) },
      // The redirect never changes, so browsers and CloudFront may keep it.
      'cache-control': { value: 'public, max-age=3600' },
    },
  };
}

// The event gives the query string as an object, with repeated keys in `multiValue`. Keys and
// values are put back as they arrived, so a link's campaign tags survive the redirect.
// Index loops, not for...of: CloudFront's runtime rejects `of` with a SyntaxError, which Node
// can't show, so the test checks the source for it.
function queryString(querystring) {
  const parts = [];
  const keys = Object.keys(querystring);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const field = querystring[key];
    const values = field.multiValue ? field.multiValue : [field];
    for (let j = 0; j < values.length; j++) {
      const value = values[j].value;
      parts.push(value === '' ? key : key + '=' + value);
    }
  }
  return parts.join('&');
}
