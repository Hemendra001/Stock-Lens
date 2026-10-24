/** Transparent INR research arithmetic. No forecasts, broker calls or order routing.
 * Methodology sources and MIT notices are in ../THIRD_PARTY_NOTICES.md.
 */
const finite = value => typeof value === 'number' && Number.isFinite(value);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sizingNote = 'Hypothetical long cash-equity sizing using your inputs and limits. Planned stop risk excludes gaps, slippage, fees and taxes; a stop does not guarantee the loss amount. Cash must belong to the selected account.';

export function planPosition(input = {}) {
  const values = plainObject(input) ? input : {};
  const {equity, cashAvailable, entry, stop, riskPercent, maxPositionPercent, existingSymbolValue} = values;
  const result = {valid: false, errors: [], shares: null, positionValue: null, plannedRisk: null, riskBudget: null, remainingAllocation: null, limits: {risk: null, cash: null, allocation: null}, bindingConstraints: [], note: sizingNote};
  for (const key of ['equity', 'cashAvailable', 'entry', 'stop', 'riskPercent', 'maxPositionPercent', 'existingSymbolValue']) {
    if (!finite(values[key])) result.errors.push(`${key} must be an explicit finite number.`);
  }
  if (result.errors.length) return result;
  if (equity <= 0) result.errors.push('Account equity must be positive.');
  if (cashAvailable < 0 || cashAvailable > equity) result.errors.push('Cash available must be between zero and account equity.');
  if (entry <= 0 || stop <= 0 || stop >= entry) result.errors.push('A long-equity plan requires 0 < stop < entry.');
  if (riskPercent < 0 || riskPercent > 100) result.errors.push('Risk percentage must be between zero and 100.');
  if (maxPositionPercent < 0 || maxPositionPercent > 100) result.errors.push('Position cap must be between zero and 100 percent.');
  if (existingSymbolValue < 0) result.errors.push('Existing symbol value cannot be negative.');
  if (result.errors.length) return result;

  const distance = entry - stop;
  const riskBudget = equity * (riskPercent / 100);
  const remainingAllocation = Math.max(0, equity * (maxPositionPercent / 100) - existingSymbolValue);
  const capacities = {risk: riskBudget / distance, cash: cashAvailable / entry, allocation: remainingAllocation / entry};
  const rawShares = Math.min(...Object.values(capacities));
  if (!finite(rawShares) || rawShares > Number.MAX_SAFE_INTEGER) {
    result.errors.push('Inputs exceed the supported whole-share calculation range.');
    return result;
  }
  let shares = Math.floor(rawShares);
  // Floating-point rounding must never let a whole share exceed any input cap.
  if (shares > 0 && (shares * distance > riskBudget || shares * entry > cashAvailable || shares * entry > remainingAllocation)) shares -= 1;
  const limits = Object.fromEntries(Object.entries(capacities).map(([key, value]) => [key, finite(value) && value <= Number.MAX_SAFE_INTEGER ? Math.floor(value) : null]));
  const bindingConstraints = Object.keys(capacities).filter(key => capacities[key] === rawShares);
  return {...result, valid: true, shares, positionValue: shares * entry, plannedRisk: shares * distance, riskBudget, remainingAllocation, limits, bindingConstraints};
}

export function evaluateChecklist(input = {}) {
  const values = plainObject(input) ? input : {};
  const written = key => typeof values[key] === 'string' && values[key].trim().length > 0;
  const checks = [
    {key: 'thesis', label: 'Written research thesis and supporting evidence', passed: written('thesis')},
    {key: 'invalidation', label: 'Written condition that would invalidate the thesis', passed: written('invalidation')},
    {key: 'catalyst', label: 'Catalyst or reason to review now, with evidence', passed: written('catalyst')},
    {key: 'eventChecked', label: 'Relevant results and corporate events checked', passed: values.eventChecked === true},
    {key: 'liquidityChecked', label: 'Liquidity and execution costs checked', passed: values.liquidityChecked === true},
    {key: 'dataVerified', label: 'Data source and timestamp verified', passed: values.dataVerified === true},
  ];
  const missing = checks.filter(check => !check.passed).map(check => check.label);
  return {complete: missing.length === 0, status: missing.length ? 'NEEDS_EVIDENCE' : 'COMPLETE', checks, missing, note: 'Records your evidence and confirmations only. Checklist completion does not independently verify the evidence, predict returns or authorize a trade.'};
}

function identity(row) {
  if (!plainObject(row) || typeof row.symbol !== 'string' || typeof row.exchange !== 'string') return null;
  const symbol = row.symbol.trim().toUpperCase();
  const exchange = row.exchange.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9&._-]{0,39}$/.test(symbol) && ['NSE', 'BSE'].includes(exchange) ? {symbol, exchange, key: `${exchange}:${symbol}`} : null;
}

/** Compare a complete selected holdings snapshot with the user's own targets.
 * positions: [{symbol, exchange, marketValue}] or [{symbol, exchange, quantity, price}].
 * targets: [{symbol, exchange, weightPercent}]. No cash or account-equity inference.
 */
export function analyzeDrift(positions, targets) {
  const result = {valid: false, errors: [], totalValue: null, rows: [], note: 'Weights use only the supplied holdings value, excluding cash and missing assets. Drift is current minus target in percentage points. Targets are user inputs; this comparison does not propose or place orders.'};
  if (!Array.isArray(positions) || positions.length === 0) result.errors.push('A nonempty holdings snapshot is required.');
  if (!Array.isArray(targets) || targets.length === 0) result.errors.push('Explicit allocation targets are required.');
  if (result.errors.length) return result;
  const rows = new Map();
  let targetTotal = 0;
  const seenTargets = new Set();
  targets.forEach((target, index) => {
    const id = identity(target);
    if (!id) { result.errors.push(`Target ${index + 1}: valid symbol and NSE/BSE exchange are required.`); return; }
    if (seenTargets.has(id.key)) { result.errors.push(`Target ${index + 1}: duplicate symbol and exchange.`); return; }
    seenTargets.add(id.key);
    if (!finite(target.weightPercent) || target.weightPercent < 0 || target.weightPercent > 100) { result.errors.push(`Target ${index + 1}: weightPercent must be a finite number from zero to 100.`); return; }
    targetTotal += target.weightPercent;
    rows.set(id.key, {symbol: id.symbol, exchange: id.exchange, marketValue: 0, targetPercent: target.weightPercent});
  });
  if (Math.abs(targetTotal - 100) > 1e-8) result.errors.push('Target weights must total 100 percent; they are never silently renormalized.');
  positions.forEach((position, index) => {
    const id = identity(position);
    if (!id) { result.errors.push(`Holding ${index + 1}: valid symbol and NSE/BSE exchange are required.`); return; }
    const hasMarketValue = Object.hasOwn(position, 'marketValue');
    const hasUnits = Object.hasOwn(position, 'quantity') || Object.hasOwn(position, 'price');
    let value = hasMarketValue ? position.marketValue : position.quantity * position.price;
    if (hasUnits && (!finite(position.quantity) || position.quantity <= 0 || !finite(position.price) || position.price <= 0)) value = NaN;
    if (hasMarketValue && hasUnits && Math.abs(position.marketValue - position.quantity * position.price) > Math.max(0.01, Math.abs(position.marketValue) * 1e-10)) value = NaN;
    if (!finite(value) || value <= 0) { result.errors.push(`Holding ${index + 1}: positive finite holding value or consistent quantity and price are required.`); return; }
    const row = rows.get(id.key) || {symbol: id.symbol, exchange: id.exchange, marketValue: 0, targetPercent: 0};
    row.marketValue += value;
    rows.set(id.key, row);
  });
  if (result.errors.length) return result;
  const totalValue = [...rows.values()].reduce((sum, row) => sum + row.marketValue, 0);
  if (!finite(totalValue) || totalValue <= 0) { result.errors.push('Total holdings value must be finite and positive.'); return result; }
  const output = [...rows.values()].map(row => {
    const currentPercent = row.marketValue / totalValue * 100;
    return {...row, currentPercent, driftPp: currentPercent - row.targetPercent};
  }).sort((a, b) => `${a.exchange}:${a.symbol}`.localeCompare(`${b.exchange}:${b.symbol}`));
  return {...result, valid: true, totalValue, rows: output};
}
