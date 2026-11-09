import type { SimResponse } from '../sim/cluster.ts';

export function statusText(r: SimResponse): string {
  return r.status === 200 ? '200 OK' : '429 Too Many Requests';
}

/** One response in plain words: who answered, and what it means for the next request. */
export function plainOutcome(r: SimResponse): string {
  const left = `${r.headers['RateLimit-Remaining'] ?? '?'} of ${String(r.limit)} left`;
  if (r.status === 200) return `Allowed. ${left}.`;
  return `Refused: too many requests. Try again in ${r.headers['Retry-After'] ?? '?'} s.`;
}

/** The technical detail, one click away: the headers the client received, and the key. */
export function ResponseDetails({ response }: { response: SimResponse }) {
  return (
    <details className="tech">
      <summary>Headers and key</summary>
      <pre>
        {`HTTP/1.1 ${statusText(response)}\n`}
        {Object.entries(response.headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join('\n')}
        {response.status === 429 ? '\n\n{ "error": "rate_limited" }' : ''}
      </pre>
      <p>
        Key <code>{response.key}</code>, checked{' '}
        {response.source === 'shared'
          ? 'by the Lua script in the shared Redis'
          : `in instance ${String(response.instance)}’s own memory, since Redis was down (its share of the limit: ${String(response.limit)})`}
        .
      </p>
    </details>
  );
}
