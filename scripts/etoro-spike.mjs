#!/usr/bin/env node
// eToro live spike for Bliss task #143. Read-only: GET requests only, nothing is placed or changed.
//
//   ETORO_API_KEY=... ETORO_USER_KEY=... node scripts/etoro-spike.mjs            # real account
//   ETORO_ENV=demo ETORO_API_KEY=... ETORO_USER_KEY=... node scripts/etoro-spike.mjs
//   ETORO_PI_USERNAME=<investor> ...                                   # also read a public investor's live portfolio
//
// Needs Node 18+. Writes ./etoro-spike-out/:
//   report.md   - safe to paste back: counts, ratios, percentages, symbols. No amounts, no names, no ids.
//   raw/*.json  - full responses with personal ids/names removed but AMOUNTS KEPT. Keep local, do not commit.

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const API_KEY = process.env.ETORO_API_KEY;
const USER_KEY = process.env.ETORO_USER_KEY;
const ENV = (process.env.ETORO_ENV || 'real').toLowerCase();
const BASE = process.env.ETORO_BASE_URL || 'https://public-api.etoro.com';
const OUT = process.env.ETORO_OUT_DIR || 'etoro-spike-out';

if (!API_KEY || !USER_KEY) {
  console.error('Set ETORO_API_KEY (public key) and ETORO_USER_KEY (private user key).');
  process.exit(1);
}
if (!['real', 'demo'].includes(ENV)) {
  console.error('ETORO_ENV must be real or demo.');
  process.exit(1);
}

const demo = ENV === 'demo';
const PATHS = {
  me: '/api/v1/me',
  aggregate: demo ? '/api/v1/trading/info/demo/aggregate-portfolio' : '/api/v1/trading/info/aggregate-portfolio',
  portfolio: demo ? '/api/v1/trading/info/demo/portfolio' : '/api/v1/trading/info/portfolio',
  tradeHistory: demo ? '/api/v1/trading/info/trade/demo/history' : '/api/v1/trading/info/trade/history',
  instruments: '/api/v1/market-data/instruments',
  instrumentTypes: '/api/v1/market-data/instrument-types',
  balancesHistory: '/api/v1/balances/history',
};

mkdirSync(join(OUT, 'raw'), { recursive: true });

const report = [];
const log = (line = '') => { report.push(line); console.log(line); };
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
const sum = (xs) => xs.reduce((s, x) => s + (Number(x) || 0), 0);
const isoDay = (d) => d.toISOString().slice(0, 10);

let lastRate = null;
const seenExchanges = new Map(); // exchangeID -> Set of example symbols

async function get(name, path, query = {}) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': API_KEY, 'x-user-key': USER_KEY, 'x-request-id': randomUUID(), accept: 'application/json' },
    });
  } catch (err) {
    log(`- \`${name}\`: network error (${err.cause?.code || err.message})`);
    return null;
  }
  const rate = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']
    .map((h) => [h, res.headers.get(h)]).filter(([, v]) => v != null);
  if (rate.length) lastRate = Object.fromEntries(rate);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { nonJson: text.slice(0, 300) }; }
  if (!res.ok) {
    log(`- \`${name}\`: HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 200)}`);
    return null;
  }
  writeFileSync(join(OUT, 'raw', `${name}.json`), JSON.stringify(redact(body), null, 2));
  return body;
}

// Personal identifiers removed from raw dumps. Amounts are kept (raw/ stays local).
const PII_KEYS = new Set([
  'cid', 'gcid', 'realcid', 'democid', 'firstname', 'middlename', 'lastname', 'username', 'dateofbirth',
  'lei', 'gender', 'accountid', 'id', 'iban', 'bic', 'maskedpan', 'accountname', 'value',
]);
function redact(x) {
  if (Array.isArray(x)) return x.map(redact);
  if (x && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, PII_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v)]));
  }
  return x;
}

const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] !== undefined) return o[k]; return undefined; };

async function main() {
  log(`# eToro live spike report (#143)`);
  log(`Run: ${new Date().toISOString()} · environment: **${ENV}** · base: ${BASE}`);
  log();

  // 1. Identity and key scopes
  log('## 1. Key and scopes');
  const me = await get('me', PATHS.me);
  if (me) {
    const scopes = me.scopes || [];
    log(`- scopes: ${scopes.length ? scopes.map((s) => `\`${s}\``).join(', ') : '(none returned)'}`);
    const write = scopes.filter((s) => /write/i.test(s));
    log(`- write scopes present: ${write.length ? `**YES** (${write.join(', ')}). Bliss would refuse this key, use a Read key.` : 'no (read-only)'}`);
    log(`- realCid present: ${me.realCid ? 'yes' : 'no'} · demoCid present: ${me.demoCid ? 'yes' : 'no'}`);
  }
  log();

  // 2. Aggregate portfolio: the key question for P1
  log('## 2. Copy trades in aggregate-portfolio');
  const agg = await get('aggregate-portfolio', PATHS.aggregate);
  const mirrorInstrumentIds = new Map(); // instrumentId -> [{ mirrorIdx, value }]
  let mirrors = [];
  if (agg) {
    const totals = agg.accountTotals || {};
    const accountValue = Number(totals.accountTotalValue) || 0;
    mirrors = (agg.mirrors || []).filter((m) => Number(m.mirrorId) !== 0);
    log(`- accountCurrency: \`${agg.accountCurrency}\` · snapshot timestamp present: ${agg.timestamp ? 'yes' : 'no'}`);
    log(`- direct instrument aggregates: ${(agg.instrumentAggregates || []).length}`);
    log(`- copy trades (mirrors, id != 0): **${mirrors.length}**`);
    const zeroMirror = (agg.mirrors || []).find((m) => Number(m.mirrorId) === 0);
    if (zeroMirror) log('- note: a mirrorId 0 entry (direct holdings) is also present in mirrors[]');
    log();
    log('| # | instruments in mirror | Σ instrument value + cash vs mirror value | cash share | mirror share of account | leveraged instruments | net-short instruments |');
    log('|---|---|---|---|---|---|---|');
    mirrors.forEach((m, i) => {
      const ias = m.instrumentAggregates || [];
      const mv = Number(m.mirrorTotals?.mirrorLiquidationValue) || 0;
      const instVal = sum(ias.map((a) => a.liquidationValueAccountCurrency));
      const cash = Number(m.mirrorAvailableCash) || 0;
      const lev = ias.filter((a) => Number(a.avgLeverage) > 1).length;
      const shorts = ias.filter((a) => Number(a.netUnits) < 0).length;
      for (const a of ias) {
        const id = Number(a.instrumentId);
        if (!mirrorInstrumentIds.has(id)) mirrorInstrumentIds.set(id, []);
        mirrorInstrumentIds.get(id).push({ mirrorIdx: i, value: Number(a.liquidationValueAccountCurrency) || 0, mv });
      }
      log(`| M${i + 1} | ${ias.length} | ${pct(instVal + cash, mv)} | ${pct(cash, mv)} | ${pct(mv, accountValue)} | ${lev} | ${shorts} |`);
    });
    if (mirrors.length && mirrors.every((m) => !(m.instrumentAggregates || []).length)) {
      log();
      log('**⚠️ Every mirror has an empty instrumentAggregates list. Section 3 checks whether the raw portfolio endpoint has the positions instead.**');
    }
  }
  log();

  // 3. Raw portfolio: mirror metadata and positions
  log('## 3. Copy trades in portfolio (raw positions)');
  const pf = await get('portfolio', PATHS.portfolio);
  if (pf) {
    const pmirrors = pf.clientPortfolio?.mirrors || [];
    log(`- mirrors: ${pmirrors.length} · direct positions: ${(pf.clientPortfolio?.positions || []).length}`);
    log();
    log('| # | parent username present | startedCopyDate | status | paused | positions | settlement types (0 CFD, 1 real, 2 swap, 3 crypto margin, 4 future) | leveraged | short |');
    log('|---|---|---|---|---|---|---|---|---|');
    pmirrors.forEach((m, i) => {
      const ps = m.positions || [];
      const st = {};
      for (const p of ps) st[p.settlementTypeID] = (st[p.settlementTypeID] || 0) + 1;
      const stTxt = Object.entries(st).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
      log(`| P${i + 1} | ${m.parentUsername ? 'yes' : 'no'} | ${(m.startedCopyDate || '').slice(0, 10) || '-'} | ${m.mirrorStatusID ?? '-'} | ${m.isPaused ?? '-'} | ${ps.length} | ${stTxt} | ${ps.filter((p) => Number(p.leverage) > 1).length} | ${ps.filter((p) => p.isBuy === false).length} |`);
      // If the aggregate endpoint had no instruments, fall back to raw positions for the symbol check below.
      if (!mirrorInstrumentIds.size || !(mirrors[i]?.instrumentAggregates || []).length) {
        for (const p of ps) {
          const id = Number(p.instrumentID);
          if (!mirrorInstrumentIds.has(id)) mirrorInstrumentIds.set(id, []);
          mirrorInstrumentIds.get(id).push({ mirrorIdx: i, value: Number(p.amount) || 0, mv: sum(ps.map((q) => q.amount)), fromRaw: true });
        }
      }
    });
  }
  log();

  // 3b. Drift and dividends: model each real copy from its investor's public gain series and compare
  const pfMirrors = pf?.clientPortfolio?.mirrors || [];
  if (pfMirrors.length) {
    log('## 3b. Copy drift check (public gain series vs your real copy)');
    log('Modelled value = initial investment x compounded daily gain since the copy started. Exact only when there were no later deposits or withdrawals.');
    log();
    log('| # | days of gains | first gain date vs copy start | later deposits/withdrawals | modelled vs real value | positions with dividend/fee credits (totalFees < 0) |');
    log('|---|---|---|---|---|---|');
    for (const [i, m] of pfMirrors.entries()) {
      const start = (m.startedCopyDate || '').slice(0, 10);
      const aggM = (agg?.mirrors || []).find((x) => Number(x.mirrorId) === Number(m.mirrorID));
      const real = Number(aggM?.mirrorTotals?.mirrorLiquidationValue) || 0;
      const extra = (Number(m.depositSummary) || 0) + (Number(m.withdrawalSummary) || 0);
      const credits = (m.positions || []).filter((p) => Number(p.totalFees) < 0).length;
      let cells = ['-', '-', extra ? 'yes (approximate)' : 'none (exact)', '-'];
      if (m.parentUsername && start) {
        const series = await get(`mirror-${i + 1}-gain-daily`, `/api/v2/portfolios/${encodeURIComponent(m.parentUsername)}/gain/daily`, { minDate: start, maxDate: isoDay(new Date()) });
        const c = compound(series);
        const modelled = (Number(m.initialInvestment) || 0) * c.index;
        cells = [String(c.n), `${c.first ?? '-'} vs ${start}`, cells[2], real ? pct(modelled, real) : '-'];
      }
      log(`| C${i + 1} | ${cells.join(' | ')} | ${credits}/${(m.positions || []).length} |`);
    }
    log();
  }

  // 4. Instrument metadata: can we map to Twelve Data symbols?
  log('## 4. Instruments held inside copy trades');
  const ids = [...mirrorInstrumentIds.keys()].filter((n) => Number.isFinite(n));
  const meta = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await get(`instruments-${i / 50 + 1}`, PATHS.instruments, { instrumentIds: chunk.join(',') });
    for (const d of r?.instrumentDisplayDatas || []) meta.set(Number(pick(d, 'instrumentID', 'instrumentId')), d);
  }
  const types = await get('instrument-types', PATHS.instrumentTypes);
  const typeName = new Map();
  for (const t of types?.instrumentTypes || types?.items || (Array.isArray(types) ? types : [])) {
    typeName.set(Number(pick(t, 'instrumentTypeID', 'instrumentTypeId', 'id')), pick(t, 'instrumentTypeDescription', 'name', 'description'));
  }
  log(`- distinct instruments across copy trades: **${ids.length}** · metadata returned for: ${meta.size}`);
  const byType = {};
  for (const id of ids) {
    const t = meta.get(id)?.instrumentTypeID;
    const label = `${typeName.get(Number(t)) || 'type'} (${t ?? '?'})`;
    byType[label] = (byType[label] || 0) + 1;
  }
  log(`- by instrument type: ${Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(' · ') || '-'}`);
  const withIndustry = ids.filter((id) => meta.get(id)?.stocksIndustryId).length;
  log(`- instruments with a stocksIndustryId: ${withIndustry}/${ids.length}`);
  log();
  log('Weight = share of that copy trade\'s value (raw-position fallback uses invested amount and is marked *).');
  log();
  log('| symbolFull | name | type id | exchange id | copy trades | max weight |');
  log('|---|---|---|---|---|---|');
  const rows = ids.map((id) => {
    const holds = mirrorInstrumentIds.get(id);
    const w = Math.max(...holds.map((h) => (h.mv ? h.value / h.mv : 0)));
    return { id, m: meta.get(id), holds, w, raw: holds.some((h) => h.fromRaw) };
  }).sort((a, b) => b.w - a.w);
  for (const r of rows) {
    log(`| \`${r.m?.symbolFull ?? `id:${r.id}`}\` | ${(r.m?.instrumentDisplayName ?? '?').replace(/\|/g, '/')} | ${r.m?.instrumentTypeID ?? '?'} | ${r.m?.exchangeID ?? '?'} | ${new Set(r.holds.map((h) => h.mirrorIdx)).size} | ${(r.w * 100).toFixed(1)}%${r.raw ? '*' : ''} |`);
  }
  log();

  // 4b. Symbol mapping on direct holdings: answers "do eToro symbols map to Twelve Data?" without copy trades
  const directIds = [...new Set((agg?.instrumentAggregates || []).map((a) => Number(a.instrumentId)))]
    .filter((id) => Number.isFinite(id) && !meta.has(id));
  if (directIds.length) {
    log('## 4b. Symbols of direct holdings (symbol-mapping check, no amounts)');
    await fetchMeta(directIds, 'direct-instruments', meta);
    logSymbolTable(directIds, meta, typeName);
    log();
  }

  // 4c. Optional: a public investor's live portfolio (fallback composition source)
  const pi = process.env.ETORO_PI_USERNAME;
  if (pi) {
    log(`## 4c. Public live portfolio of the investor in ETORO_PI_USERNAME`);
    const live = await get('pi-portfolio-live', `/api/v1/user-info/people/${encodeURIComponent(pi)}/portfolio/live`);
    if (live) {
      const pos = live.positions || [];
      const social = live.socialTrades || [];
      log(`- direct positions: ${pos.length} · social trades (their own copies): ${social.length}`);
      log(`- Σ investmentPct over positions: ${sum(pos.map((p) => p.investmentPct)).toFixed(1)} · leveraged: ${pos.filter((p) => Number(p.leverage) > 1).length} · short: ${pos.filter((p) => p.isBuy === false).length}`);
      const piIds = [...new Set(pos.map((p) => Number(p.instrumentId)))].filter(Number.isFinite);
      const piMeta = new Map();
      await fetchMeta(piIds, 'pi-instruments', piMeta);
      const weight = new Map();
      for (const p of pos) weight.set(Number(p.instrumentId), (weight.get(Number(p.instrumentId)) || 0) + (Number(p.investmentPct) || 0));
      logSymbolTable(piIds, piMeta, typeName, weight);
      const ownIds = new Set((agg?.instrumentAggregates || []).map((a) => Number(a.instrumentId)));
      const sameSet = piIds.length > 0 && piIds.length === ownIds.size && piIds.every((id) => ownIds.has(id));
      if (sameSet && pos.length === (pf?.clientPortfolio?.positions || []).length) {
        log();
        log('**⚠️ This portfolio has exactly your own positions and instruments: ETORO_PI_USERNAME looks like your own username. Re-run with someone else\'s.**');
      }
    }
    log();
  }

  // 4d. Public allocation history of the same investor: current-value weights, daily
  if (pi) {
    log('## 4d. Public asset-allocation history (v2) of ETORO_PI_USERNAME');
    const today = new Date();
    const hist = await get('pi-assets-history', `/api/v2/portfolios/${encodeURIComponent(pi)}/assets/history`, {
      minDate: isoDay(new Date(today - 30 * 864e5)), maxDate: isoDay(today),
    });
    if (hist) {
      const days = hist.results || [];
      const last = days[days.length - 1];
      log(`- days returned (last 30 requested): ${days.length} · latest date: ${last?.date ?? '-'}`);
      if (last) {
        const assets = last.assets || [];
        log(`- latest: ${assets.length} instruments · Σ valuePct ${(sum(assets.map((a) => a.valuePct)) * 100).toFixed(1)}% · cash of total equity ${((Number(last.cashOfTotalEquityPct) || 0) * 100).toFixed(1)}%`);
        log(`- top 5 by valuePct: ${[...assets].sort((a, b) => b.valuePct - a.valuePct).slice(0, 5).map((a) => `\`${a.symbol}\` ${(a.valuePct * 100).toFixed(1)}%`).join(' · ')}`);
      }
    }
    log();
  }

  // 4d2. How far back does the public gain series go?
  if (pi) {
    log('## 4d2. Gain series depth for ETORO_PI_USERNAME');
    for (const gran of ['daily', 'monthly']) {
      const series = await get(`pi-gain-${gran}`, `/api/v2/portfolios/${encodeURIComponent(pi)}/gain/${gran}`, { minDate: '2010-01-01', maxDate: isoDay(new Date()) });
      if (series) {
        const c = compound(series);
        log(`- ${gran}: ${c.n} points · first ${c.first ?? '-'} · last ${c.last ?? '-'} · compounded ${((c.index - 1) * 100).toFixed(1)}% · API totalGain ${series.totalGain != null ? (series.totalGain * 100).toFixed(1) + '%' : '-'}`);
      }
    }
    log();
  }

  // 4e. Does eToro expose ETF composition? Look at every field it returns for a few ETFs.
  const etfs = (process.env.ETORO_ETF_SYMBOLS || 'VOO,QQQ').split(',').map((s) => s.trim()).filter(Boolean);
  log('## 4e. ETF composition check');
  const hint = /compos|constitu|holding|underly|alloc|weight|sector|countr|region/i;
  for (const sym of etfs) {
    const inst = await get(`instrument-${sym}`, `/api/v1/instruments/${encodeURIComponent(sym)}`);
    if (!inst) continue;
    const fields = Object.keys(inst);
    const related = fields.filter((f) => hint.test(f));
    log(`- \`${sym}\`: ${fields.length} fields · composition-like fields: ${related.length ? related.map((f) => `\`${f}\`=${JSON.stringify(inst[f]).slice(0, 80)}`).join(', ') : 'none'}`);
  }
  log();

  // 4f. What are eToro's exchange ids? (needed to map listings to MIC codes, e.g. what is exchange 33 behind .RTH)
  if (seenExchanges.size) {
    log('## 4f. eToro exchanges seen above');
    const ex = await get('exchanges', '/api/v1/market-data/exchanges', { exchangeIds: [...seenExchanges.keys()].join(',') });
    const desc = new Map((ex?.exchangeInfo || []).map((e) => [Number(e.exchangeID), e.exchangeDescription]));
    log();
    log('| exchangeID | description | example symbols |');
    log('|---|---|---|');
    for (const [id, syms] of [...seenExchanges.entries()].sort((a, b) => a[0] - b[0])) {
      log(`| ${id} | ${desc.get(Number(id)) ?? '?'} | ${[...syms].map((x) => `\`${x}\``).join(', ')} |`);
    }
    log();
  }

  // 5. P2 probes: confirm what history exists (counts only)
  log('## 5. Movement endpoints (P2 confirmation)');
  const since = new Date(Date.now() - 90 * 864e5);
  const th = await get('trade-history', PATHS.tradeHistory, { minDate: isoDay(since), page: 1, pageSize: 100 });
  if (th) {
    const list = Array.isArray(th) ? th : th.items || th.trades || [];
    log(`- trade/history (closed trades, last 90 days, first page): ${list.length} rows · fields: ${list[0] ? Object.keys(list[0]).join(', ') : '-'}`);
    log(`- of which copied (parentPositionId != 0): ${list.filter((t) => Number(t.parentPositionId)).length}`);
  }
  const bh = await get('balances-history', PATHS.balancesHistory, { fromDate: isoDay(new Date(Date.now() - 7 * 864e5)), toDate: isoDay(new Date()) });
  if (bh) log(`- balances/history (7 days): ${(bh.snapshots || []).length} daily snapshots · account types: ${[...new Set((bh.snapshots || []).flatMap((s) => (s.accountSnapshots || []).map((a) => a.accountType)))].join(', ') || '-'}`);
  log('- Look for anything in raw/*.json that carries dated deposits, dividends or fees and note it here by hand.');
  log();

  // 6. Rate limit headers
  log('## 6. Rate limit headers (last response)');
  log(lastRate ? Object.entries(lastRate).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- none returned');

  writeFileSync(join(OUT, 'report.md'), report.join('\n') + '\n');
  console.log(`\nWrote ${join(OUT, 'report.md')} (safe to share) and ${join(OUT, 'raw')}/ (keep local).`);
}

async function fetchMeta(ids, name, into) {
  for (let i = 0; i < ids.length; i += 50) {
    const r = await get(`${name}-${i / 50 + 1}`, PATHS.instruments, { instrumentIds: ids.slice(i, i + 50).join(',') });
    for (const d of r?.instrumentDisplayDatas || []) into.set(Number(pick(d, 'instrumentID', 'instrumentId')), d);
  }
}

// Symbol table for the mapping check. `weight` (optional) is a percentage per instrument id.
function logSymbolTable(ids, meta, typeName, weight) {
  const suffixes = {};
  for (const id of ids) {
    const s = meta.get(id)?.symbolFull || '';
    const suffix = s.includes('.') ? `.${s.split('.').pop()}` : '(none)';
    suffixes[suffix] = (suffixes[suffix] || 0) + 1;
  }
  log(`- instruments: ${ids.length} · metadata returned: ${ids.filter((id) => meta.has(id)).length}`);
  log(`- symbol suffixes: ${Object.entries(suffixes).map(([k, v]) => `\`${k}\`: ${v}`).join(' · ') || '-'}`);
  log();
  log(`| symbolFull | name | type | exchange id | price source |${weight ? ' weight |' : ''}`);
  log(`|---|---|---|---|---|${weight ? '---|' : ''}`);
  const rows = [...ids].sort((a, b) => (weight ? (weight.get(b) || 0) - (weight.get(a) || 0) : 0));
  for (const id of rows) {
    const m = meta.get(id);
    const t = m?.instrumentTypeID;
    if (m?.exchangeID != null) {
      if (!seenExchanges.has(m.exchangeID)) seenExchanges.set(m.exchangeID, new Set());
      const ex = seenExchanges.get(m.exchangeID);
      if (ex.size < 4) ex.add(m.symbolFull);
    }
    log(`| \`${m?.symbolFull ?? `id:${id}`}\` | ${(m?.instrumentDisplayName ?? '?').replace(/\|/g, '/')} | ${typeName.get(Number(t)) || t || '?'} | ${m?.exchangeID ?? '?'} | ${m?.priceSource ?? '-'} |${weight ? ` ${(weight.get(id) || 0).toFixed(1)}% |` : ''}`);
  }
}

// Compound a gain series ({ gains: [{ date, gain }] }, decimal fractions per period).
function compound(series) {
  const gains = (series?.gains || []).filter((g) => Number.isFinite(Number(g.gain)));
  return { index: gains.reduce((acc, g) => acc * (1 + Number(g.gain)), 1), first: gains[0]?.date, last: gains[gains.length - 1]?.date, n: gains.length };
}

main().catch((err) => { console.error(err); process.exit(1); });
