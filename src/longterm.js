/** User-authored investment thesis checks. No fundamentals are inferred. */
const DAY = 86400000;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return NaN;
  const stamp = Date.parse(value), date = value.slice(0, 10);
  return finite(stamp) && new Date(Date.parse(`${date}T00:00:00Z`)).toISOString().slice(0, 10) === date ? stamp : NaN;
};
const sourceUrlValid = value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password; } catch { return false; }
};

export function analyzeLongTerm(input = {}) {
  const thesis = input.thesis || {};
  const now = input.now === undefined ? Date.now() : typeof input.now === 'number' ? input.now : timestamp(input.now);
  const checks = [];
  const add = (id, label, status, actual, criterion, detail) => checks.push({id, label, status, actual: actual ?? null, criterion: criterion ?? null, detail});
  const notesValid = typeof thesis.notes === 'string' && thesis.notes.trim().length > 0;
  add('thesis', 'Written investment thesis', notesValid ? 'pass' : 'unknown', notesValid ? thesis.notes.trim() : null, 'User-written rationale', notesValid ? 'Your thesis is recorded; its accuracy has not been verified.' : 'Write the business rationale and what would invalidate it.');
  const validReport = sourceUrlValid(thesis.sourceUrl);
  add('report', 'Fundamental evidence source', validReport ? 'pass' : 'unknown', thesis.sourceUrl, 'Report URL', validReport ? 'Report URL recorded; the app has not fetched or independently verified it.' : 'Supply an HTTP(S) report URL for the figures you entered.');
  const sourceDate = timestamp(thesis.sourceDate);
  const evidenceFresh = finite(now) && finite(sourceDate) && sourceDate <= now && now - sourceDate <= 120 * DAY;
  add('evidence-date', 'Evidence date', evidenceFresh ? 'pass' : 'unknown', thesis.sourceDate, 'No older than 120 calendar days and not future-dated', evidenceFresh ? 'The stated report date is within the research window.' : 'Provide a valid report date within the past 120 days; refresh older evidence.');
  const reviewDate = timestamp(thesis.reviewDate);
  const reviewValid = finite(now) && finite(reviewDate);
  const reviewFuture = reviewValid && reviewDate > now;
  add('review-date', 'Next thesis review', !reviewValid ? 'unknown' : reviewFuture ? 'pass' : 'fail', thesis.reviewDate, 'A future review date', !reviewValid ? 'Set a valid next review date.' : reviewFuture ? 'A future thesis review is scheduled.' : 'The thesis review is due or overdue; reassess the evidence.');
  const validHorizon = Number.isInteger(thesis.minMonths) && Number.isInteger(thesis.maxMonths) && thesis.minMonths > 0 && thesis.maxMonths >= thesis.minMonths;
  add('horizon', 'Personal planning horizon', validHorizon ? 'pass' : 'unknown', validHorizon ? [thesis.minMonths, thesis.maxMonths] : null, 'Positive integer months; maximum at least minimum', validHorizon ? 'This is your planning window, not an estimated time to a return.' : 'Choose valid minimum and maximum holding-horizon months.');
  const source = typeof input.priceSource === 'string' ? input.priceSource.trim() : '';
  const eligibleSource = !!source && !/demo|synthetic|sample|unknown|manual|csv|unverified/i.test(source);
  const priceDate = timestamp(input.priceAsOf);
  const validPrice = finite(input.price) && input.price > 0;
  const freshPrice = eligibleSource && validPrice && finite(now) && finite(priceDate) && priceDate <= now + 60000 && now - priceDate <= 4 * DAY;
  add('price', 'Current price evidence', freshPrice ? 'pass' : 'unknown', validPrice ? input.price : null, 'Identifiable market source, timestamp within 4 days', freshPrice ? `Price source: ${source}. Data is checked for age, not independently audited.` : 'Use a recent, positive market price with its own identifiable source and timestamp. Demo and unverified prices cannot pass.');

  const growthKnown = finite(thesis.earningsGrowth) && finite(thesis.minGrowth);
  add('growth', 'Earnings growth versus your floor', !growthKnown ? 'unknown' : thesis.earningsGrowth >= thesis.minGrowth ? 'pass' : 'fail', thesis.earningsGrowth, thesis.minGrowth, !growthKnown ? 'Enter comparable earnings-growth and minimum-growth percentages.' : `Your entered growth ${thesis.earningsGrowth}% is ${thesis.earningsGrowth >= thesis.minGrowth ? 'at or above' : 'below'} your ${thesis.minGrowth}% floor. Use the same reporting period and definition.`);
  const debtKnown = finite(thesis.debtEquity) && thesis.debtEquity >= 0 && finite(thesis.maxDebt) && thesis.maxDebt >= 0;
  add('debt', 'Debt/equity versus your ceiling', !debtKnown ? 'unknown' : thesis.debtEquity <= thesis.maxDebt ? 'pass' : 'fail', thesis.debtEquity, thesis.maxDebt, !debtKnown ? 'Enter nonnegative debt/equity and maximum-debt ratios. Negative equity requires separate analysis.' : `Your entered debt/equity ${thesis.debtEquity} is ${thesis.debtEquity <= thesis.maxDebt ? 'at or below' : 'above'} your ${thesis.maxDebt} ceiling.`);
  const cashKnown = typeof thesis.cashFlowPositive === 'boolean';
  add('cash-flow', 'Positive cash flow evidence', !cashKnown ? 'unknown' : thesis.cashFlowPositive ? 'pass' : 'fail', thesis.cashFlowPositive, true, !cashKnown ? 'Explicitly record whether the reported cash-flow measure is positive, and identify the measure/period in your thesis.' : thesis.cashFlowPositive ? 'You recorded positive cash flow.' : 'You recorded nonpositive cash flow; revisit your thesis.');
  const valuationKnown = freshPrice && finite(thesis.fairValue) && thesis.fairValue > 0;
  add('valuation', 'Price versus your fair-value estimate', !valuationKnown ? 'unknown' : input.price <= thesis.fairValue ? 'pass' : 'fail', validPrice ? input.price : null, thesis.fairValue, !valuationKnown ? 'Enter a positive fair-value estimate and supply fresh market-price evidence.' : input.price <= thesis.fairValue ? 'Price is at or below your own fair-value estimate.' : 'Price is above your own fair-value estimate; review the valuation assumptions.');
  const unknown = checks.some(check => check.status === 'unknown');
  const failed = checks.some(check => check.status === 'fail');
  const status = unknown ? 'needs-evidence' : failed ? 'review-thesis' : 'hold-for-review';
  const upside = valuationKnown ? (thesis.fairValue / input.price - 1) * 100 : null;
  return {status, reasons: checks.filter(check => check.status !== 'pass').map(check => check.detail), checks,
    horizon: {minMonths: validHorizon ? thesis.minMonths : null, maxMonths: validHorizon ? thesis.maxMonths : null, label: validHorizon ? `${thesis.minMonths}–${thesis.maxMonths} months · your planning window` : 'Planning window not set'},
    valuationUpside: finite(upside) ? Math.round(upside * 100) / 100 : null,
    valuationNote: 'Illustrative gap to your entered fair value, not expected return, a price target, or a forecast. No probability or time-to-value is estimated.',
    evidence: {sourceUrl: thesis.sourceUrl || null, sourceDate: thesis.sourceDate || null, reviewDate: thesis.reviewDate || null, priceSource: source || null, priceAsOf: input.priceAsOf || null},
    warnings: ['All fundamental figures, criteria and fair value are user-entered; the app has not verified or calibrated them.', 'Debt/equity criteria can be unsuitable for banks, financial firms, or businesses with negative equity.', 'Passing your checks means hold for scheduled thesis review, not a buy, sell, or personalized investment recommendation.']};
}
