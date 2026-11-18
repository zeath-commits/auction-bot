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
    ['BTC windows sampled', d.windows.n],
    [
      'BTC windows showing 1,000+ at entry',
      new Set(
        rows
          .filter((r) => r.strategy.startsWith('btc') && r.depth >= 1000)
          .map((r) => r.ticker)
      ).size
    ]
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
    'Each BTC strategy models one contract. The size test requires at least 1,000 contracts visible on both checks. Strategies can overlap on the same market. Sale-window auction entries use a fee reserve. Later offers use estimated taker fees.'
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
  for (const pair of Object.values(d.pairStatus ?? {}))
    if (pair.at)
      note(
        pair.label +
          ' pairs · ' +
          (pair.error ??
            pair.comparisons +
              ' matched threshold pairs across ' +
              pair.markets +
              ' open contracts; ' +
              pair.candidates +
              ' quoted below $1 before fees') +
          ' · ' +
          time(pair.at)
      );
  if (d.lateAuctionStatus?.at) {
    const late = d.lateAuctionStatus;
    note(
      'Post-auction books · ' +
        (late.error ??
          late.books +
            ' books checked; ' +
            late.quoted +
            ' with at least one contract at 99¢ or less on the indicated side; ' +
            late.sourceErrors +
            ' source errors') +
        ' · ' +
        time(late.at)
    );
  }
  if (selected === 'all' || selected === 'late_auction') {
    const positions = rows.filter(
      (r) => r.strategy === 'late_auction' && r.payout == null
    );
    if (positions.length)
      table(
        'Open post-auction paper positions',
        [
          'Market',
          'Side',
          'Contracts',
          'Cost at risk incl. fees',
          'Net if side wins'
        ],
        positions.map((r) => [
          r.ticker,
          r.side.toUpperCase(),
          r.quantity,
          money(r.quantity * r.price + r.fees),
          money(r.quantity * (1 - r.price) - r.fees)
        ])
      );
  }
  for (const a of d.auctionStatus.next ?? [])
    note(
      'Scheduled ' +
        a.house +
        ' paper watch · ' +
        time(a.at) +
        ' · ' +
        a.targets +
        ' tracked artwork' +
        (a.targets === 1 ? '' : 's')
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
    'Final minute by entry price',
    ['Entry', 'Qualifying', 'Wins', 'Losses', 'Net at standard fee'],
    [0.98, 0.99].map((price) => {
      const cohorts = days
        .flatMap((d) => d.byPrice ?? [])
        .filter((c) => c.price === price);
      const n = cohorts.reduce((s, c) => s + c.count, 0),
        w = cohorts.reduce((s, c) => s + c.wins, 0);
      return [
        money(price),
        n,
        w,
        n - w,
        money(cohorts.reduce((s, c) => s + c.net, 0))
      ];
    })
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
    'Final 10 seconds on earlier dates',
    [
      'Dates (ET)',
      'Markets',
      'Entries',
      'Wins',
      'Losses',
      'Net at standard fee',
      'Favorite-side taker trades'
    ],
    (d.tenSecondValidation ?? []).map((r) => [
      r.dates,
      r.windows,
      r.entries,
      r.wins,
      r.entries - r.wins,
      money(r.net),
      r.takerBuys
    ]),
    'No earlier-date replay loaded.'
  );
  table(
    'Other strategy research',
    ['Market', 'Experiment', 'Finding'],
    d.research.map((r) => [r.market, r.test, r.finding]),
    'No other studies recorded.'
  );
}
function real(a) {
  note(
    'The monitor runs in paper mode. This ledger reads confirmed exchange receipts for orders submitted by this bot.'
  );
  table(
    'Real bot fills',
    [
      'Time',
      'Market',
      'Side',
      'Filled quantity',
      'Cost including fees',
      'Verified realized net'
    ],
    a.history.map((r) => [
      time(r.at),
      r.ticker,
      r.side,
      r.quantity,
      money(r.cost),
      money(r.net)
    ]),
    'No confirmed real bot fills.'
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
