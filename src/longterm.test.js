import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeLongTerm} from './longterm.js';
const now = '2026-10-23T09:00:00Z';
const input = {now, price: 100, priceSource: 'kite', priceAsOf: now, thesis: {notes: 'User assessment from reported annual figures.', sourceUrl: 'https://example.com/annual-report.pdf', sourceDate: '2026-10-01', reviewDate: '2027-01-01', minMonths: 12, maxMonths: 36, fairValue: 125, earningsGrowth: 8, minGrowth: 5, debtEquity: 0.5, maxDebt: 1, cashFlowPositive: true}};
const run = (patch = {}, thesisPatch = {}) => analyzeLongTerm({...input, ...patch, thesis: {...input.thesis, ...thesisPatch}});
test('complete user evidence can pass; upside is only arithmetic against user fair value', () => {
  const result = run();
  assert.equal(result.status, 'hold-for-review');
  assert.equal(result.valuationUpside, 25);
  assert.equal(result.horizon.minMonths, 12);
  assert.ok(result.checks.every(check => check.status === 'pass'));
});
test('missing provenance, unknown criteria and unverified data never become passes', () => {
  for (const patch of [{sourceUrl: undefined}, {sourceUrl: 'javascript:alert(1)'}, {sourceDate: undefined}, {notes: ''}, {cashFlowPositive: undefined}, {earningsGrowth: undefined}, {minGrowth: undefined}, {maxDebt: undefined}, {fairValue: undefined}, {minMonths: 0}, {minMonths: 36, maxMonths: 12}]) assert.equal(run({}, patch).status, 'needs-evidence');
  for (const patch of [{priceSource: 'demo'}, {priceSource: 'Synthetic sample'}, {priceSource: 'csv'}, {priceSource: undefined}, {priceAsOf: undefined}, {price: NaN}, {price: 0}]) assert.equal(run(patch).status, 'needs-evidence');
  assert.equal(analyzeLongTerm().status, 'needs-evidence');
});
test('breached user criteria and overdue review trigger thesis review without trading advice', () => {
  for (const patch of [{earningsGrowth: 4}, {debtEquity: 2}, {cashFlowPositive: false}, {fairValue: 99}, {reviewDate: '2026-10-01'}]) {
    const result = run({}, patch);
    assert.equal(result.status, 'review-thesis');
    assert.ok(result.checks.some(check => check.status === 'fail'));
  }
});
test('stale or future evidence and prices block conclusions; missing evidence outranks a breached criterion', () => {
  assert.equal(run({}, {sourceDate: '2026-01-01'}).status, 'needs-evidence');
  assert.equal(run({}, {sourceDate: '2026-10-24'}).status, 'needs-evidence');
  assert.equal(run({}, {sourceDate: '2026-02-30'}).status, 'needs-evidence');
  assert.equal(run({priceAsOf: '2026-10-18'}).status, 'needs-evidence');
  assert.equal(run({priceAsOf: '2026-10-24'}).status, 'needs-evidence');
  const missing = run({}, {notes: '', earningsGrowth: -10});
  assert.equal(missing.status, 'needs-evidence');
  assert.ok(missing.checks.some(check => check.id === 'growth' && check.status === 'fail'));
});
