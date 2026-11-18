const view = document.querySelector('#view'),
  err = document.querySelector('#error');
let page = 'paper',
  selected = 'all',
  version = 0;
const money = (n) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4
      }).format(n);
const time = (s) => (s ? new Date(s).toLocaleString() : '—');
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function note(s) {
  view.append(el('p', s, 'note'));
}
function metrics(values) {
  const wrap = el('div', null, 'metrics');
  for (const [k, v] of values) {
    const card = el('div', null, 'metric');
    card.append(el('small', k), el('strong', v));
    wrap.append(card);
  }
  view.append(wrap);
}
function table(title, cols, rows, empty) {
  view.append(el('h2', title));
  if (!rows.length) {
    note(empty);
    return;
  }
  const box = el('div', null, 'table'),
    t = el('table'),
    head = t.createTHead().insertRow(),
    body = t.createTBody();
  cols.forEach((c) => head.append(el('th', c)));
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) {
      const td = tr.insertCell();
      td.textContent = value ?? '—';
      if (typeof value === 'string' && value.startsWith('-$'))
        td.className = 'negative';
    }
  }
  box.append(t);
  view.append(box);
}
function paper(d) {
  const label = el('label', 'Strategy '),
    select = el('select');
  for (const [id, name] of [
    ['all', 'All strategies'],
    ...Object.entries(d.strategies)
  ]) {
    const o = el('option', name);
    o.value = id;
    o.selected = id === selected;
    select.append(o);
  }
  select.onchange = () => {
    selected = select.value;
    load();
  };
  label.append(select);
  view.append(label);
  const rows = d.paper.filter(
      (r) => selected === 'all' || selected === r.strategy
    ),
    settled = rows.filter((r) => r.net != null);
  metrics([
    ['Paper entries', rows.length],
    ['Awaiting settlement', rows.length - settled.length],
    [
      'Settled paper net',
      settled.length ? money(settled.reduce((s, r) => s + r.net, 0)) : '—'
    ],
    ['BTC windows sampled', d.windows.n]
  ]);
  table(
    'Strategies',
    ['Strategy', 'Entries', 'Settled', 'Paper net'],
    Object.entries(d.strategies)
      .filter(([k]) => selected === 'all' || selected === k)
      .map(([k, name]) => {
        const all = rows.filter((r) => r.strategy === k),
          done = all.filter((r) => r.net != null);
        return [
          name,
          all.length,
          done.length,
          done.length ? money(done.reduce((s, r) => s + r.net, 0)) : '—'
        ];
      })
  );
  note(
    'BTC models one contract after two book checks at least a second apart. The final-minute and final-10-second models can overlap. Auction paper entries use their recorded fee reserves.'
  );
  note(
    'BTC monitor · ' +
      d.status.state +
      ' · ' +
      (d.status.ticker ?? 'Waiting for listing') +
      ' · checked ' +
      time(d.status.at) +
      '. Auction offers · ' +
      d.auctionStatus.offers +
      '.'
  );
  table(
    'Paper ledger',
    [
      'Observed',
      'Strategy',
      'Market',
      'Side',
      'Quantity',
      'Displayed size',
      'Entry',
      'Fee estimate',
      'Settlement',
      'Paper net'
    ],
    rows.map((r) => [
      time(r.at),
      d.strategies[r.strategy],
      r.ticker,
      r.side.toUpperCase(),
      r.quantity,
      r.depth,
      money(r.price),
      money(r.fees),
      r.result ?? 'Pending',
      money(r.net)
    ]),
    'No qualifying paper entries recorded for this strategy.'
  );
}
function history(d) {
  const days = d.replay,
    windows = days.reduce((n, r) => n + r.windows, 0);
  metrics([
    ['Windows tested', windows],
    ['Qualifying prints', days.reduce((n, r) => n + r.prints, 0)],
    ['Losing favorites', days.reduce((n, r) => n + r.prints - r.wins, 0)]
  ]);
  note(
    'First 98¢ or 99¢ trade on either side during the final minute of each Kalshi 15-minute BTC market. Gross assumes one contract per qualifying window, before fees. Historical prints do not establish available depth.'
  );
  table(
    'Daily replay',
    [
      'Date (ET)',
      'Tested / time slots',
      'Qualifying',
      'Wins',
      'Losses',
      'Gross',
      'Net at standard fee',
      'Final 10s wins / entries',
      'Final 10s net'
    ],
    days.map((r) => [
      r.day,
      r.windows + ' / ' + (r.possible ?? 96),
      r.prints,
      r.wins,
      r.prints - r.wins,
      money(r.gross),
      money(r.net),
      r.finalTen ? r.finalTen.wins + ' / ' + r.finalTen.count : '—',
      money(r.finalTen?.net)
    ]),
    'No completed replay days.'
  );
  table(
    'Losing trades',
    ['Print time', 'Market', 'Side', 'Entry', 'Settled'],
    days
      .flatMap((r) => r.losses)
      .map((r) => [
        time(r.at),
        r.ticker,
        r.side.toUpperCase(),
        money(r.price),
        r.result.toUpperCase()
      ]),
    'No losses observed in the loaded replay.'
  );
  table(
    'Other strategy research',
    ['Market', 'Experiment', 'Finding'],
    d.research.map((r) => [r.market, r.test, r.finding]),
    'No other studies recorded.'
  );
}
function real(a) {
  note(a.state + (a.asOf ? ' · refreshed ' + time(a.asOf) : ''));
  table(
    'Recorded account trades',
    [
      'Market',
      'Side',
      'Quantity',
      'Cost incl. fees',
      'Evidence',
      'As of',
      'Verified realized net'
    ],
    a.history.map((r) => [
      r.ticker,
      r.side,
      r.quantity,
      money(r.cost),
      r.source,
      time(r.at),
      money(r.net)
    ]),
    'No account records imported.'
  );
  table(
    'Exchange fills',
    ['Time', 'Market', 'Action', 'Side', 'Quantity', 'Price', 'Fees'],
    a.fills.map((r) => [
      time(r.at),
      r.ticker,
      r.action,
      r.side,
      r.quantity,
      r.price == null ? '—' : money(r.price),
      r.fee == null ? '—' : money(r.fee)
    ]),
    'No recent fills loaded from the account API.'
  );
  table(
    'Exchange settlements',
    ['Time', 'Market', 'Result', 'Payout'],
    a.settlements.map((r) => [
      time(r.at),
      r.ticker,
      r.result,
      money(r.revenue)
    ]),
    'No settlement receipts loaded from the account API.'
  );
}
async function load() {
  const n = ++version;
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) throw Error('Dashboard unavailable');
    const d = await r.json();
    let a;
    if (page === 'account') {
      const ar = await fetch('/api/account', { cache: 'no-store' });
      if (!ar.ok)
        throw Error(
          ar.status === 403
            ? 'Account records are private. Open the local dashboard or configure owner access on this host.'
            : 'Account records require owner access.'
        );
      a = await ar.json();
    }
    if (n !== version) return;
    view.replaceChildren();
    err.textContent = [d.status.error, d.status.importError]
      .filter(Boolean)
      .join(' · ');
    document.querySelector('#health').textContent =
      d.status.state +
      (d.status.at ? ' · ' + new Date(d.status.at).toLocaleTimeString() : '');
    if (page === 'paper') paper(d);
    else if (page === 'history') history(d);
    else real(a);
  } catch (e) {
    if (n === version) {
      err.textContent = e.message;
      view.replaceChildren();
      document.querySelector('#health').textContent = 'View unavailable';
    }
  }
}
document.querySelectorAll('nav button').forEach(
  (b) =>
    (b.onclick = () => {
      page = b.dataset.page;
      document
        .querySelectorAll('nav button')
        .forEach((v) => v.setAttribute('aria-pressed', String(v === b)));
      load();
    })
);
load();
setInterval(() => {
  if (!document.hidden && document.activeElement?.tagName !== 'SELECT') load();
}, 10000);
