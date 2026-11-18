const view = document.querySelector('#view'),
  err = document.querySelector('#error');
let page = 'paper',
  selected = 'all',
  version = 0,
  calendarOpen = false;
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
    ...(selected === 'all'
      ? [['Distinct markets', new Set(rows.map((r) => r.ticker)).size]]
      : [
          [
            'Settled paper net',
            settled.length ? money(settled.reduce((s, r) => s + r.net, 0)) : '—'
          ]
        ]),
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
  if (selected === 'btc_underdog')
    note('One paper contract per market at the first 1¢ or 2¢ ask in the final minute that holds or improves on a second book check. Net includes modeled taker fees.');
  if (selected === 'btc_band60')
    note('One paper contract in the final minute. The best offer must be from 98¢ through 99¢, including fractional cents, with at least one full contract on both checks. This test can overlap the exact-cent strategy.');
  if (selected === 'art_record_pair') {
    const pairs = rows.filter(r => r.side === 'yes').reduce((s,r)=>s+r.quantity,0);
    const cost = rows.reduce((s,r)=>s+r.quantity*r.price+r.fees,0);
    table('Van Gogh annual YES and lot NO', ['Paper pairs','Cost with fees','Net if one leg pays per pair'],
      [[pairs,money(cost),money(pairs-cost)]]);
    note('If this lot sells above its threshold, it also exceeds the annual record threshold of $117.18 million. The model buys equal quantities on two reads and reserves whole-cent fees. Settlement timing and price revisions can differ across the two contracts.');
    if (d.recordPairStatus?.at) note((d.recordPairStatus.error ?? d.recordPairStatus.strikes+' eligible lot thresholds')+
      ' · checked '+time(d.recordPairStatus.at));
  }
  if (selected === 'btc_chart10' && d.btcChartCoverage) {
    const c = d.btcChartCoverage;
    note('The projection uses 46 one-second chart prices and holds the last price flat for the remaining 14 seconds. A paper entry requires a projected margin of at least 0.05% on the offered side and two subsequent order-book checks at 98¢ or 99¢.');
    table('Completed Bitcoin windows', ['Discovered', 'Chart requested', 'Ready with 10s left', 'Ready before close', 'Margin reached', 'Correct direction / settled'],
      [[c.closed, c.attempted, c.atTen, c.beforeClose, c.wide, c.correct + ' / ' + c.settled]]);
  }
  if (
    ['all', 'sale_depth', 'late_auction', 'sothebys_sold'].includes(selected)
  ) {
    const p = d.auctionPortfolio,
      marks = d.auctionExits;
    const exits = d.auctionHoldings.map((h) =>
      marks.rows?.find(
        (r) =>
          r.ticker === h.ticker &&
          r.side === h.side &&
          r.quantity === h.quantity &&
          r.cost === h.cost &&
          Date.now() - r.at < 90000
      )
    );
    const liquidationNet =
      exits.length && exits.every((r) => r && r.exit.netIfFullySold != null)
        ? exits.reduce((n, r) => n + r.exit.netIfFullySold, 0)
        : null;
    view.append(el('h2', '$1,000 auction paper portfolio'));
    metrics([
      ['Available paper cash', money(p.cash)],
      ['Open cost incl. fees', money(p.openCost)],
      ['Settled auction net', money(p.settledNet)],
      ['Open net if all sold now', money(liquidationNet)],
      [
        'Open net if all pay $1',
        p.openQuantity ? money(p.openQuantity - p.openCost) : '—'
      ]
    ]);
    if (d.auctionHoldings.length) {
      const rows = d.auctionHoldings.map((h, i) => {
        const q = exits[i];
        const fresh = Boolean(q);
        return [
          h.ticker,
          h.side.toUpperCase(),
          h.quantity,
          money(h.cost),
          fresh ? q.exit.quantity : null,
          fresh ? money(q.exit.proceeds) : null,
          fresh ? money(q.exit.netIfFullySold) : null,
          fresh ? time(q.at) : null
        ];
      });
      table(
        'Open auction positions',
        [
          'Market',
          'Side',
          'Held',
          'Entry cost',
          'Shares with bids',
          'Sale proceeds after fees',
          'Net if fully sold',
          'Book checked'
        ],
        rows
      );
      note(
        'Sale proceeds use whole shares bid at the same price on two checks one second apart. Open holdings are carried at cost until settlement.'
      );
    }
    if (marks.error) note('Auction exit check · ' + marks.error);
  }
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
    'BTC closing-favorite tests model one contract per market. The size test requires 1,000 visible on both checks. Cross-venue tests model ten pairs. Strategies can overlap. Sale-window auction entries use a fee reserve. Later offers use estimated taker fees.'
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
  if (selected === 'weather_three') {
    const scans = d.weatherStatus?.threeTotals;
    if (scans) metrics([['Station-days checked', scans.stationDays],['Completed scans',scans.scans],['Scans with offers',scans.scansWithOffers]]);
    note('The test freezes station readings at 3 p.m. local standard time. It subtracts 1°F from the supported high and checks offers through 99¢ twice before the afternoon climate product appears.');
    table('Station readings and offers', ['City','Status','Supported high (°F)','Crossed thresholds','Offers','Checked'],
      Object.entries(d.weatherStatus?.three ?? {}).map(([city,r]) =>
        [city,r.error ?? r.state,r.maximum,r.thresholds,r.offers,time(r.at)]), 'Waiting for station checks.');
  }
  if (selected === 'weather_high' && d.weatherStatus?.cities) {
    for (const x of d.weatherStatus.historical ?? [])
      note(
        'Historical buyer at ' +
          x.ticker +
          ' · ' +
          x.status +
          (x.net == null
            ? ' · awaiting official payout'
            : ' · one-share modeled net ' + money(x.net))
      );
    if (d.weatherStatus.reviewError) note(d.weatherStatus.reviewError);
    table(
      'Afternoon climate reports',
      [
        'Station',
        'Latest check',
        'Reported high',
        'Station check',
        'Crossed thresholds',
        'Repeated offers'
      ],
      Object.entries(d.weatherStatus.cities).map(([city, r]) => [
        city,
        r.error ?? r.state,
        r.high != null ? r.high + '°F' : null,
        r.stationError ??
          (r.stationMaximum != null ? r.stationMaximum + '°F' : null),
        r.thresholds,
        r.offers
      ])
    );
    if (d.weatherStatus.stationGroups?.length)
      table(
        'Weather paper entries by station evidence',
        ['Station check', 'Entries', 'Settled', 'Settled net'],
        d.weatherStatus.stationGroups.map((x) => [
          x.label,
          x.entries,
          x.settled,
          money(x.net)
        ])
      );
    note(
      'Reports checked ' +
        time(d.weatherStatus.at) +
        '. The observed high includes a one-degree buffer when testing a crossing. Kalshi settles these contracts from The Weather Company.'
    );
  }
  if (['all','cs2_reference'].includes(selected) && d.cs2Status) {
    const c = d.cs2Status;
    note('CS2 pregame · ' + (c.error ?? (c.at ? c.matched + ' matched games · ' +
      c.priced + ' with usable books' : 'Starting')) +
      (c.at ? ' · checked ' + time(c.at) : ''));
    if (selected === 'cs2_reference') {
      note('One simulated Kalshi YES per game when its cost including fees is at least 2¢ below the Polymarket US bid on two checks. The reference needs five contracts on each side with a spread of 4¢ or less. Checks end two minutes before scheduled play.');
      if (c.best) note('Largest difference this scan · ' + c.best.team + ' · ' + (c.best.gap*100).toFixed(2) + '¢ per contract.');
      for (const error of c.errors ?? []) note(error);
    }
  }
  if (['all', 'nba_five','nba_best_route'].includes(selected) && d.nbaStatus?.at) {
    const n = d.nbaStatus;
    note(
      'NBA final minute · ' +
        (n.error ??
          n.scheduled +
            ' upcoming games · ' +
            n.live +
            ' live · ' +
            n.observations +
            ' five-point signals recorded') +
        ' · checked ' +
        time(n.at)
    );
    if (selected === 'nba_best_route' && n.arrivals) {
      const a = n.arrivals;
      note('One paper contract on the cheaper confirmed offer to back the leader. Leader YES wins ties in price. Opponent NO requires matching game and exceptional settlement rules.');
      table('Five-point plays seen by the monitor', ['Games','Distinct plays','Seen within 5s','Seen within 15s','Passed score checks on first sight'],
        [[a.games,a.plays,a.withinFive,a.withinFifteen,a.matched]]);
    }
  }
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
  if (
    ['all', 'sothebys_live_bid', 'sothebys_bid_high', 'sothebys_sold'].includes(
      selected
    ) &&
    d.sothebysStatus?.scheduled
  ) {
    const s = d.sothebysStatus;
    const p = el('p', null, 'note'),
      a = el('a', 'Sotheby’s live-bid paper test');
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    p.append(
      a,
      ' · ' +
        time(s.scheduled) +
        ' · ' +
        (s.error ?? s.state) +
        ' · ' +
        d.sothebysCoverage.fresh +
        '/' +
        d.sothebysCoverage.scans +
        ' fresh catalog reads'
    );
    view.append(p);
    if (s.sold)
      note(
        s.sold.error ??
          s.sold.published +
            ' published sale prices � ' +
            s.sold.books +
            ' threshold books checked at ' +
            time(s.sold.at)
      );
    if (
      ['sothebys_live_bid', 'sothebys_bid_high', 'sothebys_sold'].includes(
        selected
      )
    )
      for (const t of s.targets) {
        const link = el('a', t.title),
          p = el('p');
        link.href =
          'https://kalshi.com/markets/kxart/what-will-the-price-of-art-be/' +
          t.event.toLowerCase();
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        p.append(link);
        view.append(p);
      }
  }
  if (selected === 'sothebys_sold' && d.sothebysStatus?.timing) {
    const rows = d.sothebysStatus.timing.filter((x) => x.catalog || x.lot);
    const offer = (x) =>
      x?.error
        ? 'Quote unavailable'
        : x?.best != null
          ? money(x.best)
          : x?.checked != null
            ? 'No offer through 99¢'
            : '—';
    table(
      'First observed sold price',
      [
        'Artwork',
        'Catalog time',
        'Best ask',
        'Lot page time',
        'Best ask',
        'Lot page lead'
      ],
      rows.map((r) => [
        r.title,
        time(r.catalog?.at),
        offer(r.catalog),
        time(r.lot?.at),
        offer(r.lot),
        r.lotLeadMs == null ? '—' : (r.lotLeadMs / 1000).toFixed(1) + ' s'
      ]),
      'Waiting for the auction house to publish a sold price.'
    );
    if (d.sothebysStatus.timingError) note(d.sothebysStatus.timingError);
    const quotes = d.sothebysStatus.quotes;
    if (quotes) {
      if (quotes.at) note('Last independent order-book check covered ' + quotes.checked + ' thresholds at ' + time(quotes.at) + '.');
      if (quotes.error) note('Order-book timing check · ' + quotes.error);
      function quote(r) {
        if (!r) return 'No timely sample';
        const text = r.quoted ? money(r.best) + ' best · ' + r.quoted + '/' + r.checked + ' quoted'
          : 'No whole contract through 99¢';
        return text + ' · ' + (r.lagMs / 1000).toFixed(1) + ' s';
      }
      table('Offers around the first published sale price', ['Artwork','Before receipt','After receipt','After 30 seconds','After 5 minutes'],
        (quotes.comparison ?? []).map(r => r.conflict ? [r.title,'Source prices need review','—','—','—'] :
          [r.title,quote(r.before),quote(r.after),quote(r.after30),quote(r.after300)]),
        'Waiting for a published sale price.');
    }
  }
  if (selected === 'sothebys_sold' && d.soldLimits) {
    table(
      'Paper price-limit comparison',
      [
        'Maximum entry',
        'Contracts',
        'Committed incl. fees',
        'Settled contracts',
        'Settled net'
      ],
      d.soldLimits.map((x) => [
        x.cap + '¢',
        x.quantity,
        money(x.cost),
        x.settled,
        x.settled ? money(x.net) : '—'
      ])
    );
    note(
      'Each price limit starts with $1,000 and uses the same confirmed books. Proceeds stay reserved throughout the experiment.'
    );
    if (d.sothebysStatus?.settlementError)
      note('Settlement check · ' + d.sothebysStatus.settlementError);
  }
  if (d.lateAuctionStatus?.at) {
    const late = d.lateAuctionStatus;
    if (late.saleDepth?.active) {
      const sale = late.saleDepth;
      note(
        'Auction result watch · ' +
          (sale.error ??
            sale.active +
              ' sale windows · ' +
              sale.books +
              ' books checked · ' +
              sale.newEntries +
              ' new paper entries') +
          ' · ' +
          time(sale.at)
      );
    }
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
    if (late.unconfirmed?.length)
      note(
        'Awaiting a published sale or explicit unsold result · ' +
          late.unconfirmed
            .map(
              (t) =>
                t.title +
                ' (lot ' +
                t.lot +
                ', ' +
                t.thresholds +
                ' thresholds)'
            )
            .join(', ')
      );
  }
  const art = d.lateAuctionStatus?.coverage;
  if (
    art &&
    [
      'all',
      'late_auction',
      'sale_depth',
      'live_bid',
      'unsold',
      'published_sale',
      'auction_pair'
    ].includes(selected)
  ) {
    note(
      'Auction watchlist · ' +
        art.mapped +
        ' of ' +
        art.artnet +
        ' open Artnet thresholds match the reviewed rules · ' +
        art.other +
        ' use another settlement source · ' +
        art.unclassified +
        ' with unconfirmed sources · checked ' +
        time(art.at)
    );
    for (const row of art.review) {
      const p = el('p', null, 'note'),
        a = el('a', row.title || row.event);
      a.href =
        'https://kalshi.com/markets/kxart/what-will-the-price-of-art-be/' +
        row.event.toLowerCase();
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      p.append(a, ' · ' + row.tickers.length + ' thresholds need review');
      view.append(p);
    }
  }
  if (d.lateAuctionStatus?.coverageError)
    note(
      'Auction coverage check delayed · ' + d.lateAuctionStatus.coverageError
    );
  if (d.usBitcoinStatus?.at)
    note(
      'Polymarket US · ' +
        (d.usBitcoinStatus.error ?? d.usBitcoinStatus.state) +
        ' · ' +
        d.usCoverage.last10 +
        ' final-ten-second checks · ' +
        d.usCoverage.paired +
        ' priced two-venue comparisons · ' +
        (d.usBitcoinStatus.stale ?? 0) +
        ' stale or late reads skipped since startup' +
        (d.usCoverage.minCost != null
          ? ' · lowest combined cost for ten pairs ' +
            money(d.usCoverage.minCost)
          : '') +
        ' · ' +
        time(d.usBitcoinStatus.at)
    );
  if (d.closingCoverage && (selected === 'all' || selected === 'us_btc10'))
    note(
      'Polymarket US closing coverage · ' +
        d.closingCoverage.closed +
        ' monitored windows ended · ' +
        d.closingCoverage.attempted +
        ' sampled in the final ten seconds · ' +
        d.closingCoverage.usable +
        ' returned a fresh book before close.'
    );
  if (
    d.middleCoverage &&
    (selected === 'all' || selected === 'cross_us_middle')
  ) {
    const m = d.middleCoverage;
    note(
      'Wide opening-price gap · ' +
        m.aligned +
        ' openings monitored · ' +
        m.wide +
        ' with a gap of at least 0.20% · ' +
        m.priced +
        ' with fresh quotes for ten pairs' +
        (m.best == null ? '' : ' · lowest cost ' + money(m.best)) +
        '. Paper entry requires two checks in the first 30 seconds and a total cost of $10–$13.'
    );
  }
  if (['all', 'late_auction', 'sale_depth'].includes(selected)) {
    const positions = new Map();
    for (const r of rows.filter(
      (r) =>
        ['late_auction', 'sale_depth'].includes(r.strategy) && r.payout == null
    )) {
      const key = r.ticker + '/' + r.side;
      const p = positions.get(key) ?? {
        ticker: r.ticker,
        side: r.side,
        quantity: 0,
        cost: 0,
        entries: 0
      };
      p.quantity += r.quantity;
      p.cost += r.price * r.quantity + r.fees;
      p.entries++;
      positions.set(key, p);
    }
    if (positions.size)
      table(
        'Open auction positions sized from available offers',
        [
          'Market',
          'Side',
          'Entries',
          'Contracts',
          'Cost at risk incl. fees',
          'Net if side wins'
        ],
        [...positions.values()].map((r) => [
          r.ticker,
          r.side.toUpperCase(),
          r.entries,
          r.quantity,
          money(r.cost),
          money(r.quantity - r.cost)
        ])
      );
    for (const scan of [d.lateAuctionStatus, d.lateAuctionStatus?.saleDepth])
      if (scan?.priorBooks > 0)
        note(
          'Existing paper positions · ' +
            scan.priorBooks +
            ' books with offers · ' +
            scan.expandedBooks +
            ' showing more shares than previously modeled on the first check · ' +
            scan.addedContracts +
            ' additional shares recorded after confirmation.'
        );
  }
  const upcoming = d.auctionStatus.next ?? [];
  if (
    upcoming.length &&
    [
      'all',
      'published_sale',
      'unsold',
      'live_bid',
      'late_auction',
      'sale_depth',
      'auction_pair'
    ].includes(selected)
  ) {
    const calendar = el('details'),
      count = upcoming.reduce((n, a) => n + a.targets, 0);
    calendar.open = calendarOpen;
    calendar.ontoggle = () => {
      if (calendar.isConnected) calendarOpen = calendar.open;
    };
    calendar.append(
      el('summary', 'Auction calendar · ' + count + ' tracked lots')
    );
    for (const sale of upcoming) {
      calendar.append(
        el(
          'h3',
          (sale.house === 'phillips' ? 'Phillips' : 'Christie’s') +
            ' · monitoring from ' +
            time(sale.at)
        )
      );
      for (const item of sale.lots ?? []) {
        const p = el('p'),
          market = el('a', 'Kalshi market'),
          lot = el('a', 'Lot ' + item.lot + ' · ' + item.title);
        lot.href = item.source;
        market.href =
          'https://kalshi.com/markets/kxart/what-will-the-price-of-art-be/' +
          item.event.toLowerCase();
        for (const link of [market, lot]) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        p.append(
          lot,
          ' · ',
          market,
          ' · ' +
            item.thresholds +
            ' thresholds' +
            (item.sessionAt ? ' · session starts ' + time(item.sessionAt) : '')
        );
        calendar.append(p);
      }
    }
    view.append(calendar);
  }
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
    'First 98¢ or 99¢ trade on either side during the final minute of each Kalshi 15-minute Bitcoin market. Both Bitcoin replays model one contract per entry at the standard taker fee and direct-member balance precision. Historical prints do not establish available depth.'
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
    'Losing favorite trades',
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
    'Bitcoin 1–2¢ taker buys in the final minute',
    ['Date (ET)', 'Resolved markets', 'Qualifying buys', 'Wins', 'Losses', 'Modeled net'],
    (d.cheapTakerReplay ?? []).map(r =>
      [r.day, r.windows, r.prints, r.wins, r.prints - r.wins, money(r.net)]),
    'No completed replay days.'
  );
  note('Each replay models one contract at the first 1¢ or 2¢ public taker buy of at least one contract per market. The live paper test checks available offers separately.');
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
    'Phillips catalog and Kalshi settlements',
    ['Event', 'Artnet catalog at observation', 'Settled YES', 'Settled NO', 'Other final', 'Pending', 'Last verified'],
    (d.catalogComparison?.cases ?? []).map(r => [
      r.event, r.label, r.counts?.yes, r.counts?.no, r.counts?.other, r.counts?.pending,
      time(r.checkedAt) + (r.error ? ' · Update failed' : '')
    ]),
    'Awaiting catalog observations.'
  );
  if (d.catalogComparison) {
    const source = el('a', 'Artnet sale catalog');
    source.href = d.catalogComparison.source;
    const caption = el('p', 'Catalog observed ' + time(d.catalogComparison.observedAt) + '. ', 'note');
    caption.append(source);
    view.append(caption);
  }
  table(
    'Other strategy research',
    ['Market', 'Experiment', 'Finding'],
    d.research.map((r) => [r.market, r.test, r.finding]),
    'No other studies recorded.'
  );
}
function real(a) {
  if (a.conflicts)
    note(
      a.conflicts +
        ' exchange order records have conflicting receipts. Their amounts require reconciliation.'
    );
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
