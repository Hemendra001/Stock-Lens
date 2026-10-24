import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeCandles, analyzeDerivative, validateCandles} from './engine.js';

const NOW = '2026-10-23T09:00:00Z';
const metadata = {source: 'Exchange daily feed', asOf: NOW, now: NOW, isStale: false, isDemo: false};
function candles(count = 80, flat = false) {
  const last = Date.parse('2026-10-22T00:00:00Z');
  return Array.from({length: count}, (_, index) => {
    const close = flat ? 100 : 100 + index;
    return {time: new Date(last - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10), open: close - (flat ? 0 : 0.2), high: close + (flat ? 0 : 0.5), low: close - (flat ? 0 : 0.5), close, volume: index === count - 1 ? 200 : 100};
  });
}
function derivative(overrides = {}) {
  return analyzeDerivative({candles: candles(), underlyingSymbol: 'TEST', ...metadata, quote: {bid: 9.95, ask: 10, volume: 5000, oi: 12000, asOf: NOW, source: 'Exchange quote feed', isStale: false}, contract: {verified: true, verifiedAt: NOW, underlyingSymbol: 'TEST', expiry: '2026-11-26', lotSize: 25, type: 'CE', strike: 180}, accountSize: 100_000, riskPercent: 1, ...overrides});
}

test('volume baseline excludes the evaluated bar and uses exactly 20 previous bars', () => {
  const bars = candles();
  bars.at(-1).volume = 10_000;
  bars.at(-22).volume = 1_000_000;
  const result = analyzeCandles(bars, metadata);
  assert.equal(result.indicators.averageVolume20, 100);
  assert.equal(result.indicators.volumeRatio, 100);
});

test('constant prices yield neutral RSI and zero ATR, blocking zero-risk scenarios', () => {
  const result = analyzeCandles(candles(80, true), metadata);
  assert.equal(result.indicators.rsi14, 50);
  assert.equal(result.indicators.atr14, 0);
  assert.equal(result.score, 0);
  assert.equal(result.trade.allowed, false);
  assert.equal(result.trade.entry, null);
});

test('rising sequence has calculable moving averages and bounded Wilder RSI', () => {
  const result = analyzeCandles(candles(), metadata);
  assert.equal(result.indicators.sma20, 169.5);
  assert.equal(result.indicators.sma50, 154.5);
  assert.equal(result.indicators.rsi14, 100);
  assert.equal(result.indicators.atr14, 1.5);
  assert.equal(result.trade.allowed, true);
  assert.equal(result.trade.riskReward, 2);
  assert.equal(result.scoreBreakdown.reduce((sum, item) => sum + item.points, 0), result.score);
});

test('minimum analysis history differs from eligibility history', () => {
  assert.equal(analyzeCandles(candles(19), metadata).valid, false);
  const limited = analyzeCandles(candles(20), metadata);
  assert.equal(limited.valid, true);
  assert.equal(limited.indicators.sma50, null);
  assert.equal(limited.indicators.volumeRatio, null);
  assert.equal(limited.trade.allowed, false);
  assert.equal(analyzeCandles(candles(59), metadata).trade.allowed, false);
});

test('invalid values, OHLC, duplicates, out-of-order and impossible dates are rejected', () => {
  for (const mutate of [
    bars => { bars[5].close = NaN; },
    bars => { bars[5].volume = -1; },
    bars => { bars[5].oi = Infinity; },
    bars => { bars[5].low = bars[5].high + 1; },
    bars => { bars[5].time = bars[4].time; },
    bars => { bars[5].time = bars[3].time; },
    bars => { bars[5].time = '2026-02-30'; },
    bars => { bars[5].time = `${bars[4].time}T01:00:00Z`; },
  ]) {
    const bars = candles(); mutate(bars);
    const result = analyzeCandles(bars, metadata);
    assert.equal(result.valid, false);
    assert.equal(result.trade.allowed, false);
  }
  assert.ok(validateCandles(undefined).length > 0);
});

test('demo, unknown freshness, missing provenance and stale candles cannot pass', () => {
  for (const options of [{}, {...metadata, isDemo: true}, {...metadata, isStale: true}, {...metadata, isStale: undefined}, {...metadata, source: ''}, {...metadata, asOf: '2026-10-10'}, {...metadata, now: '2026-11-05T09:00:00Z', asOf: '2026-11-05T09:00:00Z'}]) {
    assert.equal(analyzeCandles(candles(), options).trade.allowed, false);
  }
});

test('forming candle is excluded from price and volume indicators', () => {
  const bars = candles();
  const previous = analyzeCandles(bars.slice(0, -1), metadata);
  bars.at(-1).volume = 1_000_000;
  bars.at(-1).complete = false;
  const result = analyzeCandles(bars, metadata);
  assert.deepEqual(result.indicators, previous.indicators);
  assert.equal(result.barCount, 79);
});

test('insufficient volume and unusually wide last bars fail the setup gate', () => {
  const lowVolume = candles(); lowVolume.at(-1).volume = 149;
  assert.equal(analyzeCandles(lowVolume, metadata).trade.allowed, false);
  const wideBar = candles(); wideBar.at(-1).low = 150; wideBar.at(-1).high = 200;
  const result = analyzeCandles(wideBar, metadata);
  assert.ok(result.trade.riskReward < 2);
  assert.equal(result.trade.allowed, false);
});

test('option lots fit full-premium risk budget and remain integer multiples', () => {
  const result = derivative();
  assert.equal(result.allowed, true);
  assert.equal(result.position.riskBudget, 1000);
  assert.equal(result.position.riskPerLot, 250);
  assert.equal(result.position.lots, 4);
  assert.equal(result.position.units, 100);
  assert.ok(result.position.lots * result.position.riskPerLot <= result.position.riskBudget);
});

test('derivative gates reject stale quotes, wide/crossed spreads, zero liquidity and unverified specs', () => {
  const defaultQuote = {bid: 9.95, ask: 10, volume: 5000, oi: 12000, asOf: NOW, source: 'Exchange quote feed', isStale: false};
  for (const quotePatch of [{bid: 11}, {bid: 8}, {bid: 0}, {volume: 0}, {oi: 0}, {asOf: '2026-10-23T08:58:29Z'}, {asOf: undefined}, {source: undefined}, {isStale: undefined}]) {
    const result = derivative({quote: {...defaultQuote, ...quotePatch}});
    assert.equal(result.allowed, false);
    assert.equal(result.position.units, 0);
  }
  for (const contractPatch of [{verified: false}, {verifiedAt: '2026-10-21T09:00:00Z'}, {underlyingSymbol: 'OTHER'}, {expiry: '2026-10-22'}, {expiry: '2026-10-23'}, {lotSize: 2.5}, {strike: 0}, {type: 'PE'}]) {
    assert.equal(derivative({contract: {verified: true, verifiedAt: NOW, underlyingSymbol: 'TEST', expiry: '2026-11-26', lotSize: 25, type: 'CE', strike: 180, ...contractPatch}}).allowed, false);
  }
});

test('zero, negative, excessive, missing risk and budgets below one lot allocate nothing', () => {
  for (const riskPercent of [0, -1, 3, undefined, NaN]) {
    const result = derivative({riskPercent});
    assert.equal(result.allowed, false);
    assert.equal(result.position.lots, 0);
  }
  assert.equal(derivative({accountSize: 100}).position.lots, 0);
  assert.equal(derivative({isDemo: true}).position.lots, 0);
});

test('intraday contract volume is separately checked without replacing underlying daily prices', () => {
  const contractCandles = candles(30).map((bar, index) => ({...bar, time: new Date(Date.parse(NOW) - (30 - index) * 300_000).toISOString(), oi: 1000 + index}));
  const result = derivative({contractCandles});
  assert.equal(result.allowed, true);
  assert.equal(result.underlying.indicators.close, 179);
  assert.equal(result.intradayVolumeRatio, 2);
  assert.equal(result.intradayOiChange, 1);
  contractCandles.at(-1).volume = 100;
  assert.equal(derivative({contractCandles}).allowed, false);
  assert.equal(derivative({candles: contractCandles}).allowed, false);
});

test('daily duplicate detection uses Indian exchange dates across UTC midnight', () => {
  const bars = candles();
  bars[0].time = `${bars[0].time}T23:00:00Z`;
  bars[1].time = `${bars[1].time}T01:00:00Z`;
  assert.equal(analyzeCandles(bars, metadata).valid, false);
  const weekly = candles().map((bar, index) => ({...bar, time: new Date(Date.parse('2026-10-22') - (79 - index) * 7 * 86_400_000).toISOString().slice(0, 10)}));
  assert.equal(analyzeCandles(weekly, metadata).valid, false);
});

test('expiry day is blocked from Indian midnight while UTC still shows the prior date', () => {
  const now = '2026-11-25T19:00:00Z';
  const result = derivative({now, asOf: now});
  assert.ok(result.gateReasons.some(reason => reason.includes('Expiry-day trading')));
});
