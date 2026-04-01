#!/usr/bin/env node

/**
 * tracecc log analyzer
 *
 * Usage:
 *   node analyze.js <logfile.jsonl>           # analyze a single log
 *   node analyze.js log1.jsonl log2.jsonl     # analyze multiple logs together
 *   node analyze.js *.jsonl                   # analyze all logs
 */

import { parseLogFiles, computeAnalysis } from './analyze-lib.js';

// ─── Parse args ──────────────────────────────────────────────────────────────

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node analyze.js <logfile.jsonl> [...]');
  process.exit(1);
}

// ─── Run analysis ────────────────────────────────────────────────────────────

const records = parseLogFiles(files);

if (records.length === 0) {
  console.error('No valid log entries found.');
  process.exit(1);
}

const analysis = computeAnalysis(records, files);

// ─── CLI Formatters ──────────────────────────────────────────────────────────

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : n);
const fmtCost = (n) => '$' + n.toFixed(6);
const fmtSec = (n) => n.toFixed(2) + 's';
const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) + '%' : 'N/A');

function printSection(title) {
  console.log();
  console.log('\u2501'.repeat(60));
  console.log(`  ${title}`);
  console.log('\u2501'.repeat(60));
}

function printKV(label, value, indent = 2) {
  console.log(' '.repeat(indent) + `${label}: `.padEnd(36 - indent) + value);
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length))
  );
  const sep = widths.map((w) => '\u2500'.repeat(w + 2)).join('\u253C');
  const fmtRow = (r) =>
    r.map((c, i) => ` ${String(c).padStart(widths[i])} `).join('\u2502');

  console.log('  ' + sep);
  console.log('  ' + fmtRow(headers));
  console.log('  ' + sep);
  rows.forEach((r) => console.log('  ' + fmtRow(r)));
  console.log('  ' + sep);
}

// ─── 1. Overview ─────────────────────────────────────────────────────────────

printSection('Overview');
printKV('Log files', files.join(', '));
printKV('Total requests', fmt(analysis.overview.totalRequests));
printKV('Time range',
  new Date(analysis.overview.timeRange.start).toLocaleString() +
  ' ~ ' +
  new Date(analysis.overview.timeRange.end).toLocaleString()
);

// ─── 2. Cost Efficiency ─────────────────────────────────────────────────────

printSection('Cost Efficiency');
printKV('Total cost', fmtCost(analysis.cost.totalCost));
printKV('Total discount', fmtCost(analysis.cost.totalDiscount));
printKV('Net cost', fmtCost(analysis.cost.netCost));
printKV('Avg cost per request', fmtCost(analysis.cost.avgCostPerRequest));
printKV('Cost per 1K tokens',
  analysis.cost.costPer1kTokens > 0
    ? fmtCost(analysis.cost.costPer1kTokens)
    : 'N/A'
);

const costRows = analysis.cost.byModel.map((m) => [
  m.model, m.requests, fmtCost(m.totalCost), fmtCost(m.avgCost),
]);
printTable(['Model', 'Reqs', 'Total Cost', 'Avg Cost'], costRows);

// ─── 3. Token Usage ─────────────────────────────────────────────────────────

printSection('Token Usage');
printKV('Total input tokens', fmt(analysis.tokens.totalInput));
printKV('  \u251C\u2500 Non-cache input', fmt(analysis.tokens.nonCacheInput));
printKV('  \u251C\u2500 Cache creation', fmt(analysis.tokens.cacheCreation));
printKV('  \u2514\u2500 Cache read', fmt(analysis.tokens.cacheRead));
printKV('Total output tokens', fmt(analysis.tokens.totalOutput));
printKV('Input / Output ratio',
  analysis.tokens.inputOutputRatio > 0
    ? analysis.tokens.inputOutputRatio + 'x'
    : 'N/A'
);
printKV('Avg input per request', fmt(analysis.tokens.avgInputPerRequest));
printKV('Avg output per request', fmt(analysis.tokens.avgOutputPerRequest));

// ─── 4. Cache Hit Rate ──────────────────────────────────────────────────────

printSection('Cache Performance');
printKV('Cache hit rate (read/total)', analysis.cache.hitRate + '%');
printKV('Cache creation rate', analysis.cache.creationRate + '%');
printKV('Non-cache rate', analysis.cache.nonCacheRate + '%');
printKV('Ephemeral 5min tokens', fmt(analysis.cache.ephemeral5mTokens));
printKV('Ephemeral 1hr tokens', fmt(analysis.cache.ephemeral1hTokens));

if (analysis.cache.perRequest.length > 0) {
  console.log();
  console.log('  Cache hit rate per request:');
  const cacheRows = analysis.cache.perRequest.map((r) => [
    r.index,
    r.model.replace('claude-', '').substring(0, 12),
    fmt(r.cacheRead),
    fmt(r.totalInput),
    r.hitRate + '%',
  ]);
  printTable(['#', 'Model', 'Cache Read', 'Total In', 'Hit Rate'], cacheRows);
}

// ─── 5. Request Efficiency ───────────────────────────────────────────────────

printSection('Request Efficiency');
const re = analysis.requestEfficiency;
printKV('Total requests', fmt(re.totalRequests));
printKV('Success (2xx)', fmt(re.success.count) + ' (' + re.success.pct + '%)');
printKV('Errors (4xx/5xx)', fmt(re.errors.count) + ' (' + re.errors.pct + '%)');
printKV('Requests with tools', fmt(re.withTools.count) + ' (' + re.withTools.pct + '%)');
printKV('Requests with thinking', fmt(re.withThinking.count) + ' (' + re.withThinking.pct + '%)');
printKV('Streaming requests', fmt(re.streaming.count) + ' (' + re.streaming.pct + '%)');

// ─── 6. Latency / Performance ───────────────────────────────────────────────

printSection('Latency');
if (analysis.latency.avg > 0) {
  printKV('Avg latency', fmtSec(analysis.latency.avg));
  printKV('Min latency', fmtSec(analysis.latency.min));
  printKV('Max latency', fmtSec(analysis.latency.max));
  printKV('p50 latency', fmtSec(analysis.latency.p50));
  printKV('p90 latency', fmtSec(analysis.latency.p90));
  printKV('p99 latency', fmtSec(analysis.latency.p99));

  const latencyRows = analysis.latency.byModel.map((m) => [
    m.model, m.requests, fmtSec(m.avg), fmtSec(m.p50), fmtSec(m.max),
  ]);
  console.log();
  printTable(['Model', 'Reqs', 'Avg', 'p50', 'Max'], latencyRows);
}

// ─── 7. Model Selection ─────────────────────────────────────────────────────

printSection('Model Selection');
const modelRows = analysis.modelSelection.map((m) => [
  m.model, m.requests, m.share + '%', fmt(m.totalTokens),
]);
printTable(['Model', 'Requests', 'Share', 'Total Tokens'], modelRows);

// ─── 8. Context Growth ──────────────────────────────────────────────────────

printSection('Context Growth (input tokens per request over time)');
const cg = analysis.contextGrowth;
if (cg.points.length > 1) {
  printKV('First request input', fmt(cg.first));
  printKV('Last request input', fmt(cg.last));
  printKV('Growth', fmt(cg.growth) + ' (' + cg.growthPct + '%)');

  const maxInput = Math.max(...cg.points.map((p) => p.totalInput));
  console.log();
  console.log('  Input tokens trend:');
  for (const p of cg.points) {
    const barLen = Math.round((p.totalInput / maxInput) * 30);
    const bar = '\u2588'.repeat(barLen) + '\u2591'.repeat(30 - barLen);
    const modelShort = p.model.replace('claude-', '').substring(0, 8);
    console.log(`  ${String(p.index).padStart(3)} \u2502${bar}\u2502 ${fmt(p.totalInput).padStart(8)} [${modelShort}]`);
  }
}

// ─── 9. Per-file Summary (if multiple files) ────────────────────────────────

if (files.length > 1) {
  printSection('Per-file Summary');
  const fileRows = analysis.perFile.map((f) => [
    f.file, f.requests, fmtSec(f.duration), fmtCost(f.cost), fmt(f.totalTokens),
  ]);
  printTable(['File', 'Reqs', 'Duration', 'Cost', 'Tokens'], fileRows);
}

// ─── 10. Summary Score ───────────────────────────────────────────────────────

printSection('Agent Efficiency Score (Summary)');
const es = analysis.efficiencyScore;
printKV('Cache hit rate', es.cacheHitRate + '%');
printKV('Error rate', es.errorRate + '%');
printKV('Avg latency', fmtSec(es.avgLatency));
printKV('Input/Output ratio', es.inputOutputRatio + 'x');
printKV('Total cost', fmtCost(es.totalCost));
printKV('Total requests', fmt(es.totalRequests));

console.log();
