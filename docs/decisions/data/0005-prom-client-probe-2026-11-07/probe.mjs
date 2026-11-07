// Milestone 4, T2: how prom-client registers metrics, and what it accepts. Run from the repo root:
//   node docs/decisions/data/0005-prom-client-probe-2026-11-07/probe.mjs
import client from 'prom-client';
const { Registry, Counter, Histogram, register } = client;
const out = (k, v) => console.log(k.padEnd(48), v);
// 1. default registers on global
const c1 = new Counter({ name: 'a_total', help: 'h' });
out('global has a_total after new Counter():', !!register.getSingleMetric('a_total'));
// 2. registers: [r]
const r = new Registry();
const c2 = new Counter({ name: 'b_total', help: 'h', registers: [r] });
out('custom has b_total:', !!r.getSingleMetric('b_total'), );
out('global has b_total:', !!register.getSingleMetric('b_total'));
// 3. duplicate
try { new Counter({ name: 'b_total', help: 'h', registers: [r] }); out('dup on custom:', 'no throw'); } catch (e) { out('dup on custom throws:', e.constructor.name + ': ' + e.message); }
try { new Counter({ name: 'a_total', help: 'h' }); out('dup on global:', 'no throw'); } catch (e) { out('dup on global throws:', e.message); }
// 3b. dup partial: if first of three registers then second fails, is first left behind?
const r2 = new Registry();
new Counter({ name: 'y_total', help: 'h', registers: [r2] });
try { new Counter({ name: 'x_total', help: 'h', registers: [r2] }); new Counter({ name: 'y_total', help: 'h', registers: [r2] }); } catch {}
out('partial: x_total left behind:', !!r2.getSingleMetric('x_total'));
// 4. labels & bad names
try { new Counter({ name: 'bad-name', help: 'h', registers: [] }); out('bad name:', 'no throw'); } catch (e) { out('bad name throws:', e.message); }
try { new Counter({ name: '9x', help: 'h', registers: [] }); out('leading digit:', 'no throw'); } catch (e) { out('leading digit throws:', e.message); }
// 5. buckets
try { new Histogram({ name: 'h1', help: 'h', buckets: [], registers: [] }); out('empty buckets:', 'no throw'); } catch (e) { out('empty buckets throws:', e.message); }
try { new Histogram({ name: 'h2', help: 'h', buckets: [0.2, 0.1], registers: [] }); out('unsorted buckets:', 'no throw'); } catch (e) { out('unsorted buckets throws:', e.message); }
try { new Histogram({ name: 'h3', help: 'h', buckets: [0.1, NaN], registers: [] }); out('NaN bucket:', 'no throw'); } catch (e) { out('NaN bucket throws:', e.message); }
try { new Histogram({ name: 'h4', help: 'h', buckets: [0.1, 0.1], registers: [] }); out('dup bucket:', 'no throw'); } catch (e) { out('dup bucket throws:', e.message); }
// 6. unknown label value
const c3 = new Counter({ name: 'l_total', help: 'h', labelNames: ['rule'], registers: [r] });
try { c3.inc({ rule: 'x', other: 'y' }); out('extra label:', 'no throw'); } catch (e) { out('extra label throws:', e.message); }
// 7. metrics() is async?
const m = r.metrics(); out('metrics() returns promise:', m instanceof Promise);
out('getMetricsAsJSON promise:', r.getMetricsAsJSON() instanceof Promise);
const h = new Histogram({ name: 'lat_seconds', help: 'h', labelNames: ['rule'], buckets: [0.001], registers: [r] });
h.observe({ rule: 'x' }, 0.0005);
console.log(JSON.stringify((await r.getSingleMetric('lat_seconds').get()).values));
// Unsorted buckets: does an observation land in the right buckets?
const ru = new Registry();
const hu = new Histogram({ name: 'u', help: 'h', buckets: [0.2, 0.1], registers: [ru] });
hu.observe(0.15);
out('unsorted [0.2, 0.1], observe 0.15:', JSON.stringify((await hu.get()).values.filter((v) => v.metricName === 'u_bucket').map((v) => [v.labels.le, v.value])));
const { Registry: NamedRegistry } = await import('prom-client');
out('named ESM import works:', typeof NamedRegistry === 'function');
out('prom-client version:', (await import('prom-client/package.json', { with: { type: 'json' } })).default.version);
