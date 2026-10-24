/** Pure, local-only family portfolio helpers. No credentials belong in this model. */
const BROKER_LABELS = {kite: 'Kite', groww: 'Groww', csv: 'CSV import', manual: 'Manual account', demo: 'Synthetic sample'};
const QUOTE_MAX_AGE_MS = 90_000;
const sourceOf = h => typeof h?.source === 'string' && h.source ? h.source : 'csv';
const accountIdOf = h => typeof h?.accountId === 'string' && h.accountId ? h.accountId : `legacy:${sourceOf(h)}`;
const ownRecord = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const legacyKey = h => `${sourceOf(h)}:${h.exchange || 'NSE'}:${h.symbol}`;
const isDemo = (h, account) => sourceOf(h) === 'demo' || account?.broker === 'demo' || account?.isDemo === true || accountIdOf(h) === 'legacy:demo';
const instant = value => typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value);

/** A symbol is unique within one account and exchange, not within one broker. */
export function holdingKey(h) {
  return `${accountIdOf(h)}:${h.exchange || 'NSE'}:${h.symbol}`;
}

/**
 * Return a v2 workspace without mutating the input or removing v1 browser storage.
 * Legacy holdings receive a distinct account per source. Imported histories,
 * theses and the selected holding are re-keyed to their account-aware identity.
 * An explicitly saved empty holdings array remains empty.
 */
export function migrateWorkspace(saved = {}, sampleHoldings = []) {
  const original = ownRecord(saved);
  const members = [];
  const memberIds = new Set();
  for (const member of Array.isArray(original.members) ? original.members : []) {
    if (!member || typeof member.id !== 'string' || !member.id || memberIds.has(member.id)) continue;
    members.push({...member, name: typeof member.name === 'string' && member.name.trim() ? member.name.trim() : 'Family member'});
    memberIds.add(member.id);
  }
  if (!memberIds.has('self')) {
    members.unshift({id: 'self', name: 'You'});
    memberIds.add('self');
  }
  const accounts = [];
  const accountMap = new Map();
  for (const account of Array.isArray(original.accounts) ? original.accounts : []) {
    if (!account || typeof account.id !== 'string' || !account.id || accountMap.has(account.id)) continue;
    const broker = typeof account.broker === 'string' && account.broker ? account.broker : 'csv';
    const memberId = typeof account.memberId === 'string' && account.memberId ? account.memberId : 'self';
    if (!memberIds.has(memberId)) {
      members.push({id: memberId, name: 'Family member'});
      memberIds.add(memberId);
    }
    const normalized = {...account, broker, memberId, label: typeof account.label === 'string' && account.label.trim() ? account.label.trim() : BROKER_LABELS[broker] || broker};
    accounts.push(normalized);
    accountMap.set(normalized.id, normalized);
  }
  const rawHoldings = Array.isArray(original.holdings) ? original.holdings : sampleHoldings;
  const keyMap = new Map();
  const holdings = rawHoldings.filter(h => h && typeof h === 'object').map(h => {
    const accountId = accountIdOf(h);
    const source = h.source || accountMap.get(accountId)?.broker || 'csv';
    if (!accountMap.has(accountId)) {
      const account = {id: accountId, label: BROKER_LABELS[source] || source, memberId: 'self', broker: source};
      accounts.push(account);
      accountMap.set(accountId, account);
    }
    const holding = {...h, accountId, source, exchange: h.exchange || 'NSE'};
    // Keep explicit v2 entries intact; a legacy entry has only one source account.
    if (!h.accountId) keyMap.set(legacyKey(h), holdingKey(holding));
    return holding;
  });
  const remapRecords = records => {
    const entries = Object.entries(ownRecord(records));
    // Explicit v2 keys win if a partially migrated workspace has both versions.
    const remapped = new Map(entries.filter(([key]) => !keyMap.has(key)));
    for (const [key, value] of entries) {
      const target = keyMap.get(key) || key;
      if (!remapped.has(target)) remapped.set(target, value);
    }
    return Object.fromEntries(remapped);
  };
  const validScope = scope => scope === 'all' || typeof scope === 'string' && (
    scope.startsWith('account:') && accountMap.has(scope.slice(8)) ||
    scope.startsWith('member:') && memberIds.has(scope.slice(7))
  );
  const sourceAccount = accounts.find(a => a.id === `legacy:${original.source}`) || accounts.find(a => a.broker === original.source);
  const hasRealHoldings = holdings.some(h => !isDemo(h, accountMap.get(h.accountId)));
  const demoAccount = accounts.find(a => a.broker === 'demo' || a.id === 'legacy:demo');
  const defaultScope = sourceAccount ? `account:${sourceAccount.id}` : hasRealHoldings ? 'all' : demoAccount ? `account:${demoAccount.id}` : 'all';
  return {
    ...original, version: 2, members, accounts, holdings,
    imported: remapRecords(original.imported), theses: remapRecords(original.theses),
    selected: keyMap.get(original.selected) || original.selected || null,
    scope: validScope(original.scope) ? original.scope : defaultScope,
  };
}

/** all/member views never include synthetic holdings; an explicit demo account can. */
export function scopeHoldings(holdings = [], accounts = [], scope = 'all') {
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  if (typeof scope !== 'string') return [];
  if (scope.startsWith('account:')) return holdings.filter(h => accountIdOf(h) === scope.slice(8));
  if (scope === 'all') return holdings.filter(h => !isDemo(h, accountMap.get(accountIdOf(h))));
  if (scope.startsWith('member:')) return holdings.filter(h => {
    const account = accountMap.get(accountIdOf(h));
    return account?.memberId === scope.slice(7) && !isDemo(h, account);
  });
  return [];
}

/**
 * Replace one account's broker snapshot, preserving every other account.
 * Reject invalid/duplicate rows before changing anything. Incoming explicit IDs
 * must match the requested account, preventing accidental cross-account sync.
 */
export function replaceAccountHoldings(existing = [], accountId, incoming = []) {
  if (typeof accountId !== 'string' || !accountId) throw new Error('An account is required for a holdings sync.');
  if (!Array.isArray(existing) || !Array.isArray(incoming)) throw new Error('Holdings must be an array.');
  const seen = new Set();
  const replacement = incoming.map(h => {
    if (!h || h.accountId && h.accountId !== accountId) throw new Error('A holdings sync cannot modify another account.');
    if (typeof h.symbol !== 'string' || !/^[A-Z0-9][A-Z0-9&_. -]{0,49}$/.test(h.symbol)) throw new Error('Each holding needs a valid stock symbol.');
    if (!['NSE', 'BSE'].includes(h.exchange || 'NSE')) throw new Error('Only NSE and BSE cash holdings are supported.');
    if (!Number.isFinite(h.quantity) || h.quantity < 0 || !Number.isFinite(h.average_price) || h.average_price < 0 || h.quantity > 0 && h.average_price <= 0) throw new Error('Each holding needs a valid quantity and average cost.');
    const holding = {...h, accountId, exchange: h.exchange || 'NSE'};
    const key = holdingKey(holding);
    if (seen.has(key)) throw new Error('Combine duplicate stocks within an account using their weighted average cost.');
    seen.add(key);
    return holding;
  });
  return existing.filter(h => accountIdOf(h) !== accountId).concat(replacement);
}

function summarizeRows(rows) {
  const owned = rows.filter(row => row.valid && row.quantity > 0);
  const priced = owned.filter(row => row.price !== null);
  const invested = owned.reduce((sum, row) => sum + row.invested, 0);
  const pricedInvestment = priced.reduce((sum, row) => sum + row.invested, 0);
  const currentValue = priced.length ? priced.reduce((sum, row) => sum + row.currentValue, 0) : null;
  const pnl = currentValue === null ? null : currentValue - pricedInvestment;
  const staleCount = priced.filter(row => row.isStale).length;
  return {
    holdingCount: rows.length, ownedCount: owned.length, pricedCount: priced.length,
    missingCount: owned.length - priced.length, staleCount,
    freshCount: priced.length - staleCount, invalidCount: rows.filter(row => !row.valid).length,
    quantity: owned.reduce((sum, row) => sum + row.quantity, 0),
    pricedQuantity: priced.reduce((sum, row) => sum + row.quantity, 0),
    invested, pricedInvestment, missingInvestment: invested - pricedInvestment,
    currentValue, pnl, pnlPercent: pricedInvestment > 0 ? pnl / pricedInvestment * 100 : null,
    coveragePercent: invested > 0 ? pricedInvestment / invested * 100 : null,
    isPartial: owned.length !== priced.length || rows.some(row => !row.valid),
    hasStalePrices: staleCount > 0,
  };
}

/**
 * Aggregate a scoped set of holdings. All money is INR. Current value and P&L
 * describe only the priced quantities; isPartial/missingCount must accompany
 * them in the UI. Stale prices remain usable for a clearly labelled valuation.
 * A mixed input excludes demo holdings; a demo-only input remains a demo.
 * quoteForFn(h) => {price, timestamp|asOf, isStale, changePercent?}.
 * Result: totals, holdings[], stocks[], accountBreakdown[], memberBreakdown[],
 * overlaps[]. Stock weights use priced value; investment weights use all cost.
 */
export function aggregatePortfolio(holdings = [], quoteForFn = () => ({}), accounts = [], members = [], now = Date.now()) {
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const memberMap = new Map(members.map(member => [member.id, member]));
  const realHoldings = holdings.filter(h => !isDemo(h, accountMap.get(accountIdOf(h))));
  const included = realHoldings.length ? realHoldings : holdings;
  const nowMs = instant(now);
  const rows = included.map(h => {
    const accountId = accountIdOf(h), account = accountMap.get(accountId);
    const memberId = account?.memberId || 'self';
    const valid = typeof h.symbol === 'string' && Boolean(h.symbol) && Number.isFinite(h.quantity) && h.quantity >= 0 && Number.isFinite(h.average_price) && h.average_price >= 0 && (h.quantity === 0 || h.average_price > 0);
    const quote = quoteForFn(h) || {};
    const price = Number.isFinite(quote.price) && quote.price > 0 ? quote.price : null;
    const quoteTimestamp = quote.timestamp || quote.asOf || null;
    const quoteMs = instant(quoteTimestamp);
    const stale = price !== null && (quote.isStale === true || ['csv', 'manual'].includes(sourceOf(h)) || !Number.isFinite(quoteMs) || !Number.isFinite(nowMs) || nowMs - quoteMs > QUOTE_MAX_AGE_MS || quoteMs - nowMs > 30_000);
    const invested = valid ? h.quantity * h.average_price : null;
    const currentValue = valid && price !== null ? h.quantity * price : null;
    const pnl = currentValue === null ? null : currentValue - invested;
    return {...h, key: holdingKey(h), accountId, accountLabel: account?.label || accountId, memberId, memberName: memberMap.get(memberId)?.name || (memberId === 'self' ? 'You' : 'Family member'), valid, isDemo: isDemo(h, account), price, quoteTimestamp, isStale: stale, priceStatus: price === null ? 'missing' : stale ? 'stale' : 'fresh', invested, currentValue, pnl, pnlPercent: invested > 0 && pnl !== null ? pnl / invested * 100 : null};
  });
  const total = summarizeRows(rows);
  const groupBy = field => {
    const map = new Map();
    for (const row of rows) {
      const key = field(row);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return [...map.entries()];
  };
  const stocks = groupBy(h => `${h.exchange || 'NSE'}:${h.symbol}`).map(([id, stockRows]) => {
    const values = summarizeRows(stockRows);
    const accountIds = [...new Set(stockRows.map(h => h.accountId))];
    return {
      id, symbol: stockRows[0].symbol, exchange: stockRows[0].exchange || 'NSE', name: stockRows[0].name || stockRows[0].symbol,
      ...values, averagePrice: values.quantity > 0 ? values.invested / values.quantity : null,
      weightedAverageCost: values.quantity > 0 ? values.invested / values.quantity : null,
      accountIds, accountCount: accountIds.length, memberIds: [...new Set(stockRows.map(h => h.memberId))],
      weightPercent: total.currentValue > 0 && values.currentValue !== null ? values.currentValue / total.currentValue * 100 : null,
      investmentWeightPercent: total.invested > 0 ? values.invested / total.invested * 100 : null,
      holdings: stockRows,
    };
  }).sort((a, b) => (b.currentValue ?? -1) - (a.currentValue ?? -1) || a.id.localeCompare(b.id));
  const accountBreakdown = groupBy(h => h.accountId).map(([id, accountRows]) => ({id, label: accountMap.get(id)?.label || id, broker: accountMap.get(id)?.broker || sourceOf(accountRows[0]), memberId: accountRows[0].memberId, ...summarizeRows(accountRows)}));
  const memberBreakdown = groupBy(h => h.memberId).map(([id, memberRows]) => ({id, name: memberMap.get(id)?.name || (id === 'self' ? 'You' : 'Family member'), accountCount: new Set(memberRows.map(h => h.accountId)).size, ...summarizeRows(memberRows)}));
  return {
    ...total, stockCount: stocks.length, accountCount: accountBreakdown.length, memberCount: memberBreakdown.length,
    isDemo: rows.length > 0 && rows.every(row => row.isDemo), excludedDemoCount: holdings.length - included.length,
    holdings: rows, stocks, accountBreakdown, memberBreakdown,
    overlaps: stocks.filter(stock => stock.holdings.filter(h => h.valid && h.quantity > 0).reduce((ids, h) => ids.add(h.accountId), new Set()).size > 1),
  };
}
