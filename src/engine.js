/** Daily-bar research heuristics, never a probability or a price forecast.
 * Indicators include only completed bars. All timestamps must be ISO strings.
 * Eligibility is an informational research gate, not a recommendation to trade.
 */
const DAY = 86_400_000;
const IST_OFFSET = 19_800_000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const mean = values => values.reduce((sum, value) => sum + value / values.length, 0);
const round = value => finite(value) ? Math.round(value * 10000) / 10000 : null;
const isoTime = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return NaN;
  const timestamp = Date.parse(value);
  const date = value.slice(0, 10);
  if (!Number.isFinite(timestamp) || new Date(Date.parse(`${date}T00:00:00Z`)).toISOString().slice(0, 10) !== date) return NaN;
  return timestamp;
};
// Indian exchange session dates; an offset-bearing timestamp may be on the
// previous UTC date. Date-only candles already name their exchange session.
const sessionDate = value => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const stamp = typeof value === 'number' ? value : isoTime(value);
  return finite(stamp) ? new Date(stamp + IST_OFFSET).toISOString().slice(0, 10) : null;
};

export function validateCandles(candles, {daily = true} = {}) {
  if (!Array.isArray(candles)) return ['Candles must be an array.'];
  const errors = [];
  let prior = -Infinity;
  let priorDate = null;
  candles.forEach((bar, index) => {
    if (!bar || typeof bar !== 'object') { errors.push(`Bar ${index + 1}: missing candle.`); return; }
    const stamp = isoTime(bar.time);
    if (!Number.isFinite(stamp)) errors.push(`Bar ${index + 1}: invalid ISO timestamp.`);
    else if (stamp <= prior) errors.push(`Bar ${index + 1}: timestamps must be unique and strictly increasing.`);
    const barDate = sessionDate(bar.time);
    if (daily && barDate && barDate === priorDate) errors.push(`Bar ${index + 1}: daily analysis accepts only one candle per Indian exchange session date.`);
    priorDate = barDate;
    prior = stamp;
    for (const field of ['open', 'high', 'low', 'close']) {
      if (!finite(bar[field]) || bar[field] <= 0) errors.push(`Bar ${index + 1}: ${field} must be a finite positive number.`);
    }
    if (!finite(bar.volume) || bar.volume < 0) errors.push(`Bar ${index + 1}: volume must be finite and nonnegative.`);
    if (bar.oi !== undefined && (!finite(bar.oi) || bar.oi < 0)) errors.push(`Bar ${index + 1}: open interest must be finite and nonnegative.`);
    if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high) errors.push(`Bar ${index + 1}: OHLC range is inconsistent.`);
  });
  if (daily && errors.length === 0 && candles.length >= 20) {
    const dates = candles.map(bar => Date.parse(sessionDate(bar.time)));
    const gaps = dates.slice(1).map((date, index) => (date - dates[index]) / DAY).sort((a, b) => a - b);
    if (gaps[Math.floor(gaps.length / 2)] > 1) errors.push('Candle cadence is coarser than daily or has too many missing sessions; daily indicators cannot be verified.');
  }
  return errors;
}

function ema(values, period) {
  if (values.length < period) return null;
  let value = mean(values.slice(0, period));
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) value += alpha * (values[i] - value);
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    gain += Math.max(delta, 0) / period;
    loss += Math.max(-delta, 0) / period;
  }
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function atr(bars, period = 14) {
  if (bars.length <= period) return null;
  const ranges = bars.slice(1).map((bar, i) => Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i].close), Math.abs(bar.low - bars[i].close)));
  let result = mean(ranges.slice(0, period));
  for (let i = period; i < ranges.length; i++) result = (result * (period - 1) + ranges[i]) / period;
  return result;
}

function provenanceReasons(options, lastTime) {
  const reasons = [];
  const now = options.now === undefined ? Date.now() : (typeof options.now === 'number' ? options.now : isoTime(options.now));
  const ageLimit = finite(options.maxAgeDays) && options.maxAgeDays > 0 ? Math.min(options.maxAgeDays, 4) : 4;
  if (options.isDemo) reasons.push('Demo data: research only.');
  if (typeof options.source !== 'string' || !options.source.trim() || /^(unknown|demo|sample|manual)$/i.test(options.source.trim())) reasons.push('An identifiable market-data source is required.');
  if (options.isStale !== false) reasons.push('Data freshness has not been confirmed.');
  const asOf = isoTime(options.asOf);
  if (!finite(now) || !finite(asOf) || asOf > now + 60_000 || now - asOf > ageLimit * DAY) reasons.push('A recent, valid data timestamp is required.');
  const last = isoTime(lastTime);
  if (!finite(last) || !finite(now) || last > now + 60_000 || now - last > ageLimit * DAY) reasons.push('The latest completed daily candle is stale or invalid.');
  return reasons;
}

export function analyzeCandles(candles, options = {}) {
  const errors = validateCandles(candles);
  const bars = Array.isArray(candles) ? candles.filter((bar, index) => bar?.complete !== false && !(index === candles.length - 1 && options.lastBarComplete === false)) : [];
  const horizon = options.horizon === 'position' ? 'position' : 'swing';
  const warnings = ['Score is a rule-based directional heuristic, not a probability. Levels are conditional scenarios, not forecasts.', 'Review windows are illustrative policy settings, not backtested holding-period estimates. Reassess when new data or invalidation changes the setup.'];
  if (bars.length !== candles?.length) warnings.push('Incomplete candles were excluded from all indicators.');
  if (bars.length < 20) errors.push('At least 20 completed daily candles are needed for analysis; 60 are needed for setup eligibility.');
  const base = {valid: errors.length === 0, errors, warnings, source: options.source || 'Unknown', asOf: options.asOf || null, horizon, barCount: bars.length, reviewHorizon: horizon === 'swing' ? 'Review in 5–15 trading sessions, or sooner at invalidation.' : 'Review in 20–60 trading sessions, or sooner at invalidation.'};
  if (errors.length) return {...base, indicators: {}, score: 0, scoreBreakdown: [], bias: 'insufficient data', trade: {allowed: false, direction: 'none', entry: null, stop: null, target: null, riskReward: null, gateReasons: [...errors]}};

  const closes = bars.map(bar => bar.close);
  const latest = bars.at(-1);
  const sma20 = mean(closes.slice(-20));
  const sma50 = bars.length >= 50 ? mean(closes.slice(-50)) : null;
  const ema20 = ema(closes, 20);
  const rsi14 = rsi(closes);
  const atr14 = atr(bars);
  // Deliberately excludes the evaluated candle: no volume baseline leakage.
  const averageVolume20 = bars.length >= 21 ? mean(bars.slice(-21, -1).map(bar => bar.volume)) : null;
  const volumeRatio = averageVolume20 > 0 ? latest.volume / averageVolume20 : null;
  const momentum10 = (latest.close / closes.at(-11) - 1) * 100;
  const compare = (a, b, weight) => b == null || Math.abs(a - b) < 1e-10 ? 0 : a > b ? weight : -weight;
  const scoreBreakdown = [
    {rule: 'Close versus SMA20', points: compare(latest.close, sma20, 25)},
    {rule: 'SMA20 versus SMA50', points: compare(sma20, sma50, 20)},
    {rule: 'Close versus EMA20', points: compare(latest.close, ema20, 20)},
    {rule: 'RSI14 directional band (55–70 or 30–45)', points: rsi14 >= 55 && rsi14 <= 70 ? 15 : rsi14 >= 30 && rsi14 <= 45 ? -15 : 0},
    {rule: '10-session price momentum', points: compare(momentum10, 0, 20)},
  ];
  const score = scoreBreakdown.reduce((sum, item) => sum + item.points, 0);
  const direction = score >= 60 ? 'long' : score <= -60 ? 'short' : 'none';
  const bias = direction === 'long' ? 'bullish watchlist' : direction === 'short' ? 'bearish watchlist' : 'neutral / hold for review';
  const sign = direction === 'short' ? -1 : 1;
  const riskMultiple = horizon === 'position' ? 2 : 1.5;
  const rewardMultiple = riskMultiple * 2;
  const entry = direction === 'none' || !atr14 ? null : (sign > 0 ? latest.high : latest.low) + sign * atr14 * 0.1;
  const stop = entry === null ? null : sign > 0 ? Math.min(latest.low - atr14 * 0.25, entry - atr14 * riskMultiple) : Math.max(latest.high + atr14 * 0.25, entry + atr14 * riskMultiple);
  const target = entry === null ? null : entry + sign * atr14 * rewardMultiple;
  const risk = entry === null ? null : Math.abs(entry - stop);
  const riskReward = risk > 0 ? Math.abs(target - entry) / risk : null;
  const gateReasons = provenanceReasons(options, latest.time);
  if (bars.length < 60) gateReasons.push('At least 60 completed daily candles are required.');
  if (direction === 'none') gateReasons.push('Directional score must reach +60 or −60.');
  if (volumeRatio === null || volumeRatio < 1.5) gateReasons.push('Completed-bar volume must be at least 1.5× the previous 20-bar average.');
  if (!finite(atr14) || !(atr14 > 0) || !finite(risk) || !(risk > 0)) gateReasons.push('Positive finite volatility and nonzero stop distance are required.');
  if (entry !== null && (!finite(entry) || !finite(stop) || !finite(target) || !(entry > 0) || !(stop > 0) || !(target > 0))) gateReasons.push('All scenario price levels must be finite and positive.');
  if (!finite(riskReward) || riskReward < 2 - 1e-10) gateReasons.push('Gross reward/risk must be at least 2:1 before costs.');
  if (rsi14 > 70 || rsi14 < 30) warnings.push('RSI is extended; trend continuation and reversal are both possible.');
  return {...base, indicators: {close: latest.close, sma20: round(sma20), sma50: round(sma50), ema20: round(ema20), rsi14: round(rsi14), atr14: round(atr14), volume: latest.volume, averageVolume20: round(averageVolume20), volumeRatio: round(volumeRatio), momentum10: round(momentum10)}, score, scoreBreakdown, bias,
    trade: {allowed: gateReasons.length === 0, direction, entry: round(entry), stop: round(stop), target: round(target), riskReward: round(riskReward), gateReasons, trigger: direction === 'long' ? 'Only review after price breaks above the entry level.' : direction === 'short' ? 'Only review after price breaks below the entry level.' : 'Wait for directional evidence.', invalidation: stop === null ? 'No active directional scenario.' : `Review immediately if the underlying reaches ${round(stop)}.`, levelBasis: 'Underlying-price ATR scenario; gross reward/risk excludes fees, taxes, gaps and slippage.'}};
}

/** contract: {verified:true, verifiedAt:ISO, underlyingSymbol, expiry:'YYYY-MM-DD', lotSize:positive integer,
 * type:'FUT'|'CE'|'PE', strike?:positive number}; quote: {bid,ask,volume,oi,asOf}.
 * Option sizing reserves full premium loss. Futures sizing uses underlying stop
 * distance; exchange margin remains an independent requirement.
 */
export function analyzeDerivative(input = {}) {
  const underlying = analyzeCandles(input.candles, input);
  const quote = input.quote || {};
  const contract = input.contract || {};
  const gateReasons = [...underlying.trade.gateReasons];
  const now = input.now === undefined ? Date.now() : typeof input.now === 'number' ? input.now : isoTime(input.now);
  const quoteTime = isoTime(quote.asOf);
  if (!finite(quoteTime) || !finite(now) || quoteTime > now + 60_000 || now - quoteTime > 90_000) gateReasons.push('A verified quote no more than 90 seconds old is required.');
  if (typeof quote.source !== 'string' || !quote.source.trim() || /^(unknown|demo|sample|manual)$/i.test(quote.source.trim())) gateReasons.push('The contract quote needs its own identifiable market-data source.');
  if (quote.isStale !== false) gateReasons.push('Contract quote freshness must be explicitly confirmed by the data adapter.');
  const validMarket = finite(quote.bid) && finite(quote.ask) && quote.bid > 0 && quote.ask > 0 && quote.bid <= quote.ask;
  const spreadPercent = validMarket ? (quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2) * 100 : null;
  if (!validMarket) gateReasons.push('Positive, uncrossed bid and ask prices are required.');
  else if (spreadPercent > 1) gateReasons.push('Bid/ask spread must be no greater than 1% of midpoint.');
  if (!finite(quote.volume) || quote.volume <= 0 || !finite(quote.oi) || quote.oi <= 0) gateReasons.push('Contract volume and open interest must both be positive.');
  const expiry = isoTime(contract.expiry);
  if (contract.verified !== true) gateReasons.push('Contract specifications must be verified against an exchange or broker source.');
  const verifiedAt = isoTime(contract.verifiedAt);
  if (!finite(verifiedAt) || !finite(now) || verifiedAt > now + 60_000 || now - verifiedAt > DAY) gateReasons.push('Contract specifications must have been verified within the last 24 hours.');
  const symbol = typeof input.underlyingSymbol === 'string' ? input.underlyingSymbol.trim().toUpperCase() : '';
  const contractSymbol = typeof contract.underlyingSymbol === 'string' ? contract.underlyingSymbol.trim().toUpperCase() : '';
  if (!symbol || !contractSymbol || symbol !== contractSymbol) gateReasons.push('The daily candle underlying must match the verified contract underlying symbol.');
  const expiryDate = sessionDate(contract.expiry);
  const currentSession = sessionDate(now);
  if (!finite(expiry) || !finite(now) || expiryDate < currentSession) gateReasons.push('A valid, unexpired contract expiry is required.');
  // Exclude the entire Indian exchange expiry day, including hours when UTC
  // still names the prior date. A date cannot establish a settlement cutoff.
  else if (currentSession === expiryDate) gateReasons.push('Expiry-day trading is excluded without a verified settlement cutoff (Indian exchange date).');
  if (!Number.isSafeInteger(contract.lotSize) || contract.lotSize <= 0) gateReasons.push('A verified positive integer lot size is required.');
  if (!['FUT', 'CE', 'PE'].includes(contract.type)) gateReasons.push('Contract type must be FUT, CE or PE.');
  if (['CE', 'PE'].includes(contract.type) && (!finite(contract.strike) || contract.strike <= 0)) gateReasons.push('An option must have a verified positive strike price.');
  if (contract.type === 'CE' && underlying.trade.direction !== 'long' || contract.type === 'PE' && underlying.trade.direction !== 'short') gateReasons.push('Long-option type must match the underlying watchlist direction.');
  if (!finite(input.accountSize) || input.accountSize <= 0) gateReasons.push('A positive account size is required to size risk.');
  if (!finite(input.riskPercent) || input.riskPercent <= 0 || input.riskPercent > 2) gateReasons.push('Risk budget must be greater than zero and at most 2% of the account.');
  let intradayVolumeRatio = null;
  let intradayOiChange = null;
  if (input.contractCandles !== undefined) {
    const intradayErrors = validateCandles(input.contractCandles, {daily: false});
    const intraday = Array.isArray(input.contractCandles) ? input.contractCandles.filter(bar => bar?.complete !== false) : [];
    if (intradayErrors.length) gateReasons.push(...intradayErrors.map(error => `Contract candles: ${error}`));
    else if (intraday.length < 21) gateReasons.push('At least 21 completed 5-minute contract candles are needed for intraday volume confirmation.');
    else {
      const intervals = intraday.slice(1).map((bar, index) => isoTime(bar.time) - isoTime(intraday[index].time));
      if (!intervals.some(gap => gap === 300_000) || intervals.some(gap => gap < 300_000 || gap % 300_000 !== 0)) gateReasons.push('Contract candles must use 5-minute intervals; session gaps are allowed.');
      const latestIntraday = intraday.at(-1);
      const latestStamp = isoTime(latestIntraday.time);
      if (!finite(now) || latestStamp > now + 60_000 || now - latestStamp > 10 * 60_000) gateReasons.push('The latest completed 5-minute contract candle must be no more than 10 minutes old.');
      const baseline = mean(intraday.slice(-21, -1).map(bar => bar.volume));
      intradayVolumeRatio = baseline > 0 ? latestIntraday.volume / baseline : null;
      const previousOi = intraday.at(-2).oi;
      if (finite(latestIntraday.oi) && finite(previousOi)) intradayOiChange = latestIntraday.oi - previousOi;
      if (!finite(intradayVolumeRatio) || intradayVolumeRatio < 1.5) gateReasons.push('Completed 5-minute contract volume must be at least 1.5× the prior 20-bar average.');
    }
  }
  const riskBudget = finite(input.accountSize) && input.accountSize > 0 && finite(input.riskPercent) && input.riskPercent > 0 && input.riskPercent <= 2 ? input.accountSize * input.riskPercent / 100 : null;
  const perUnitRisk = contract.type === 'FUT' && underlying.trade.entry !== null && underlying.trade.stop !== null ? Math.abs(underlying.trade.entry - underlying.trade.stop) : ['CE', 'PE'].includes(contract.type) && validMarket ? quote.ask : null;
  const lotRisk = perUnitRisk > 0 && Number.isSafeInteger(contract.lotSize) && contract.lotSize > 0 ? perUnitRisk * contract.lotSize : null;
  const rawLots = finite(riskBudget) && riskBudget > 0 && finite(lotRisk) && lotRisk > 0 ? Math.floor(riskBudget / lotRisk) : 0;
  const affordableLots = Number.isSafeInteger(rawLots) && Number.isSafeInteger(rawLots * contract.lotSize) ? rawLots : 0;
  if (!affordableLots) gateReasons.push('The risk budget cannot support one full lot.');
  const allowed = gateReasons.length === 0;
  return {valid: underlying.valid, underlying, bias: underlying.bias, allowed, gateReasons, spreadPercent: round(spreadPercent), intradayVolumeRatio: round(intradayVolumeRatio), intradayOiChange: round(intradayOiChange), contract, quoteAsOf: quote.asOf || null,
    position: {lots: allowed ? affordableLots : 0, units: allowed ? affordableLots * contract.lotSize : 0, riskBudget: round(riskBudget), riskPerLot: round(lotRisk), sizingBasis: contract.type === 'FUT' ? 'Approximation from the underlying spot stop distance: futures basis and gaps may change actual loss. Broker margin must be checked separately.' : 'Long options only: reserve the full ask premium as possible loss. No option-premium target is inferred.'},
    note: 'Directional underlying watchlist only. Underlying reward/risk does not imply option reward/risk. Greeks, implied volatility, time decay and execution costs are not modeled.'};
}
