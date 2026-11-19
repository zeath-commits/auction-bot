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
  if ((selected.startsWith('btc') || selected === 'us_btc10') && !selected.startsWith('btc_endpoint')) {
    note('The BTC cushion checks the latest chart price and a smoothed chart price against the strike. Both must clear 0.15%. The chart’s final reading has tracked Kalshi settlement. Averaging chart readings a second time can delay detection of a reversal.');
  }
  if(selected==='btc_endpoint_bid45' && d.btcEndpointBids){
    const b=d.btcEndpointBids;
    table('Resting 99.8¢ bid after a chart trend signal',['Eligible windows','Reviewed','100+ sold below 99.8¢','Graded after 100+ sold','Correct after 100+ sold'],
      [[b.trials,b.reviewed,b.through,b.graded,b.wins]]);
    note('At the first reading with 42–45 seconds left, the latest chart price and five-second trend forecast must both clear the strike by 0.15%. Two books must show no offer at 99.8¢ or less. After a one-second arrival allowance, the monitor counts sellers who traded below 99.8¢ in the next nine seconds. These observations measure potential fills.');
    const names={nineSeconds:'Nine seconds',untilClose:'Until close',cancelOnMargin:'Cancel on lost cushion'};
    table('Bid prices and cancellation timing for the same signals',['Bid','Duration','Reviewed','With potential fills','Potential shares','Graded','Correct','Longest monitoring gap'],
      (d.btcBidDurations??[]).map(r=>[money(r.price),names[r.timer],r.reviewed,r.crossed,r.shares,r.graded,r.wins,(r.maxGap/1000).toFixed(1)+'s']),
      'Waiting for eligible bids to reach settlement.');
    note('Each comparison allows up to 100 whole shares per signal. A cancellation takes effect one second after the first observed failed or stale reading. During a monitoring gap, the modeled bid stays open.');
    if(d.status?.endpointBidError)note(d.status.endpointBidError);
  }
  if(selected==='btc_endpoint10' && d.btcEndpoint){
    const c=d.btcEndpoint;
    table('Closing chart trend with 6–10 seconds left',['Windows','Fresh forecasts','Cleared 0.15%','Settled after clearing','Correct','Later book pairs checked','100 offered twice ≤99.8¢'],
      [[c.sampled,c.fresh,c.passed,c.settled,c.correct,c.checked,c.full]]);
    note('The forecast extends the last five seconds of chart movement to the final candle. The latest price and forecast must both clear the strike by 0.15%, at the signal and on a newer reading. Two fresh books after the signal must each offer 100 shares for 99.8¢ or less. The paper account reserves the higher cost including modeled fees.');
    if(d.btcChartAudit){
      const a=d.btcChartAudit;
      table('Live chart readings compared with the archive after settlement',['Closes checked','Final candles matching settlement','Readings saved before close','Matching archived readings','Missing archived readings'],
        [[a.closes,a.finals,a.readings,a.matches,a.missing]]);
    }
    if(d.status?.chartAuditError)note(d.status.chartAuditError);
  }
  if (selected === 'btc_underdog')
    note('One paper contract per market at the first 1¢ or 2¢ ask in the final minute that holds or improves on a second book check. Net includes modeled taker fees.');
  if (['sothebys_sold','sale_depth'].includes(selected)){
    table('Resting auction bids at 95¢ after publication',['Threshold','Side','Shares queued at 95¢ or better','Shares sold at 95¢','Shares sold below 95¢'],
      (d.auctionResting??[]).filter(r=>selected==='sothebys_sold'?r.source?.includes('sothebys.com'):!r.source?.includes('sothebys.com'))
        .map(r=>[r.ticker,r.side,r.ahead,r.atLimit??'Pending',r.belowLimit??'Pending']),
      'Waiting for a confirmed sale price and two books with no offer at or below 95¢.');
    note('Each threshold is observed once. The model allows one second for a bid to arrive, then counts sales for up to one hour.');
    const account=d.auctionRestingAccount;
    if(account){
      const names={equal:'Equal allocation',empty:'Empty queue'};
      table('Independent $1,000 paper budgets for 95¢ resting bids',['Test','Available','Reserved for bids','Awaiting settlement at cost','Settled paper net'],
        [[names.equal,account],[names.empty,d.auctionEmptyQueueAccount]].map(([name,a])=>[name,...[a.available,a.reserved,a.openCost,a.settledNet].map(money)]));
      table('Bids allocated in advance',['Threshold','Test','Side','Shares reserved at entry','Modeled shares bought','Settlement per share'],
        d.auctionRestingPositions.filter(r=>selected==='sothebys_sold'?r.source?.includes('sothebys.com'):!r.source?.includes('sothebys.com'))
          .map(r=>[r.ticker,names[r.policy],r.side,r.shares,r.matched??'Under review',r.settleValue==null?'—':money(r.settleValue/1e6)]),
        'Waiting for the next qualifying auction bid.');
      note('Equal allocation splits the budget across all listed thresholds in a sale. The empty-queue test reserves up to $100 per threshold when both books show zero shares bid at 95¢ or better. Each test counts subsequent sales strictly below 95¢, capped at its reserved shares. Earlier observations had no budget allocation.');
    }
    if(d.sothebysStatus?.restingError)note(d.sothebysStatus.restingError);
    if(d.sothebysStatus?.restingSettlementError)note(d.sothebysStatus.restingSettlementError);
  }
  if (selected === 'btc_band60')
    note('One paper contract in the final minute. The best offer must be from 98¢ through 99¢, including fractional cents, with at least one full contract on both checks. This test can overlap the exact-cent strategy.');
  if (selected === 'btc_band10')
    note('One paper contract per market. Both order-book requests must start in the last ten seconds, with distinct, fresh timestamps and a best offer from 98¢ through 99¢ on the same side that holds or improves.');
  if (selected==='btc_cushion45' && d.btcEarlyCushion) {
    const c=d.btcEarlyCushion;
    table('BTC cushion with 42–45 seconds left',['Sampled','Cleared 0.15%','Settled after clearing','Correct','Fresh book pairs checked','100 offered twice ≤99¢','100 offered twice ≤99.8¢'],
      [[c.sampled,c.passed,c.settled,c.correct,c.checked,c.at99,c.at998]]);
    note('During the 1–10 seconds after the first signal, the paper test rechecks the cushion. Both books must show 100 whole contracts within the limit. The model uses the more expensive of the two quotes, including fees, against a $1,000 simulated balance.');
  }
  if (['btc_band10','btc_band1000','btc999','btc_chart10'].includes(selected) && d.btcCushion) {
    const c=d.btcCushion;
    table('First BTC reading with 6–10 seconds left', ['Closes sampled','Fresh chart','Cleared 0.15%','Settled YES or NO after clearing','Correct after clearing'],
      [[c.sampled,c.fresh,c.passed,c.settled,c.correct]]);
  }
  if (selected === 'btc_band1000' && d.btcBandDepth) {
    const c=d.btcBandDepth;
    table('1,000-contract offers in the final ten seconds',
      ['Closes checked','Fresh book pairs','Same side at 98–99¢','1,000 offered twice','Largest repeated depth'],
      [[c.windows,c.fresh,c.inBand,c.full,c.maxDepth]]);
    note('Each close counts once. The model buys the cheapest 1,000 whole contracts visible at matching prices on two fresh reads. Its $1,000 paper balance covers purchase cost and fees, rounded up to a cent per price level.');
  }
  if (selected === 'btc999' && d.btc999Coverage) {
    const c = d.btc999Coverage;
    table('99.9¢ offers in the final ten seconds', ['Closes checked','Fresh book pairs','100 offered on first read','100 offered on both reads'],
      [[c.windows,c.freshWindows,c.offered,c.repeated]]);
    note('Each column counts distinct markets. One paper entry uses 100 contracts and a separate $1,000 starting balance. At the standard modeled fee, a win earns $0.09 and a loss costs $99.91.');
    const q = d.btc999Queue;
    if (q) {
      table('Joining an existing 99.9¢ bid', ['Bids observed','Settlements reviewed','Volume covered queue + 100','Winning side among those'],
        [[q.trials,q.reviewed,q.cleared,q.wins]]);
      note('The queue estimate uses the larger depth on two reads. It counts subsequent trades starting 500 milliseconds later. Actual queue priority is unknown.');
      table('Recent 99.9¢ bids', ['Market','Bid side','Simulated arrival','Contracts ahead','Later matching volume','Settlement'],
        (d.btc999Recent ?? []).map(r=>[r.ticker,r.side.toUpperCase(),time(r.arrival),
          r.ahead.toLocaleString(),r.volume?.toLocaleString() ?? 'Pending',r.result?.toUpperCase() ?? 'Pending']),
        'Waiting for a bid to appear on two fresh book reads.');
    }
  }
  if (selected === 'art_record_pair') {
    const pairs = rows.filter(r => r.side === 'yes').reduce((s,r)=>s+r.quantity,0);
    const cost = rows.reduce((s,r)=>s+r.quantity*r.price+r.fees,0);
    table('Van Gogh annual YES and lot NO', ['Paper pairs','Cost with fees','Net if one leg pays per pair'],
      [[pairs,money(cost),money(pairs-cost)]]);
    note('If this lot sells above its threshold, it also exceeds the annual record threshold of $117.18 million. The model buys equal quantities on two reads and reserves whole-cent fees. Settlement timing and price revisions can differ across the two contracts.');
    if (d.recordPairStatus?.at) note((d.recordPairStatus.error ?? d.recordPairStatus.strikes+' eligible lot thresholds')+
      ' · checked '+time(d.recordPairStatus.at));
    table('Depth after new paired entries',['Delay','Batches observed / scheduled','Pairs still offered / checked'],
      (d.recordPairDelays??[]).map(r=>[r.seconds+'s',r.checked+' / '+r.batches,
        r.checked ? r.available+' / '+r.requested : '—']),'Waiting for a new paired entry.');
  }
  if (selected === 'art_range_bids') {
    note('Five simulated Kalshi YES shares per artwork when bids on mutually exclusive Polymarket ranges entirely above the threshold exceed the Kalshi cost by at least 2¢ per share on two checks. The reference measures what other traders bid. It does not establish the chance of winning.');
    table('Range bids at entry',['Kalshi market','Qualifying ranges','Combined bids','Cost per share with fees','Difference'],(d.rangeBidEvidence ?? []).map(r=>{
      const p=r.second.pick;
      return [p.ticker,p.supporting.map(b=>b.label).join(', '),money(p.reference),money(p.price+p.fees/5),(p.gap*100).toFixed(2)+'¢'];
    }), 'No paper entries yet.');
    for (const [title,r] of Object.entries(d.rangeBidStatus?.lots ?? {})) note(title+' · '+r.state);
    table('Saved pre-auction quotes',['Kalshi event','Snapshots','Most recent'],(d.rangeBidCoverage ?? [])
      .map(r=>[r.event,r.scans,time(r.lastAt)]),'Waiting for the first snapshot.');
    if (d.rangeBidStatus?.ended) note('Pre-auction test ended.');
    table('Polymarket resolution and subsequent Kalshi offers',['Artwork','Observation'],
      Object.entries(d.rangeBidStatus?.resolutions??{}),'Waiting for range observations.');
    if(d.rangeBidStatus?.resolutionError)note(d.rangeBidStatus.resolutionError);
  }
  if (selected === 'btc_chart10' && d.btcChartCoverage) {
    const c = d.btcChartCoverage;
    note('The projection uses 46 one-second chart prices and holds the last price flat for the remaining 14 seconds. A paper entry requires a projected margin of at least 0.05% on the offered side and two subsequent order-book checks at 98¢ or 99¢.');
    table('Completed Bitcoin windows', ['Discovered', 'Chart requested', 'Ready with 10s left', 'Ready before close', 'Margin reached', 'Correct direction / settled'],
      [[c.closed, c.attempted, c.atTen, c.beforeClose, c.wide, c.correct + ' / ' + c.settled]]);
  }
  if (selected==='art_withdrawn')
    note('Artnet marked Haberdashery withdrawn from the named sale. The paper position follows the no-eligible-price provision. Kalshi confirms its payout at settlement.');
  if (['all','art_record_pair','art_range_bids','art_withdrawn'].includes(selected)) {
    const trials=(d.auctionExitTrials ?? []).filter(t=>selected==='all'||selected===t.strategy);
    if (trials.length) {
      table('First profitable paper exit versus holding', ['Position','Registered','Entry cost','First full exit','Exit net','Net at settlement'],
        trials.map(t=>[t.id,time(t.registered),money(t.cost),t.soldAt?time(t.soldAt):'No exit recorded',money(t.exitNet),money(t.heldNet)]));
      note('Each comparison fixes the starting shares and cost. A simulated exit needs enough bids for every leg on two fresh reads and a positive return after fees. The hold-to-settlement ledger tracks the same shares separately.');
    }
    const holdings = (d.auctionStudyHoldings ?? []).filter(h => selected === 'all' || h.strategy === selected);
    if (holdings.length) {
      const marks = holdings.map(h => d.auctionExits.rows?.find(r =>
        r.strategy === h.strategy && r.ticker === h.ticker && r.side === h.side &&
        r.quantity === h.quantity && r.cost === h.cost && Date.now()-r.at<90000));
      table('Early exit for auction paper positions',
        ['Contract','Side','Shares held','Shares with bids','Entry cost','Proceeds on priced shares','Net if fully sold','Checked'],
        holdings.map((h,i) => {
          const r=marks[i];
          return [h.ticker,h.side.toUpperCase(),h.quantity,r?.exit.quantity,money(h.cost),
            money(r?.exit.proceeds),money(r?.exit.netIfFullySold),time(r?.at)];
        }));
      if (selected === 'art_record_pair' && holdings.every((h,i) => marks[i]?.exit.netIfFullySold != null) &&
          new Set(marks.map(r=>r.at)).size === 1)
        note('Net from selling all open Van Gogh legs at those bids · '+money(marks.reduce((s,r)=>s+r.exit.netIfFullySold,0)));
      if (d.auctionExits.error && selected !== 'all') note('Exit check · '+d.auctionExits.error);
    }
  }
  if (
    ['all', 'sale_depth', 'late_auction', 'sothebys_sold','art_withdrawn'].includes(selected)
  ) {
    const entryTape = (d.auctionEntryTape ?? []).filter(r=>selected==='all' || selected===r.strategy);
    if (entryTape.length) {
      table('Public purchases after paper entries',['Threshold','Paper entry','Side','Price','Paper shares','Public shares at price','Whole shares overlapping'],
        entryTape.flatMap(r=>r.levels.map(l=>[r.ticker,time(r.at),r.side.toUpperCase(),money(l.price),l.paper,l.printed,l.overlap])));
      note('Counts same-side buyer executions from one second to 30 seconds after the paper observation. A later entry or market close ends the window early. Public trades do not establish a bot fill.');
    }
    if(d.sothebysStatus?.entryTapeError) note(d.sothebysStatus.entryTapeError);
  }
  if (['all', 'sale_depth', 'late_auction', 'sothebys_sold'].includes(selected)) {
    const p = d.auctionPortfolio, marks = d.auctionExits;
    const exits = d.auctionHoldings.map((h) =>
      marks.rows?.find(
        (r) =>
          !r.strategy && r.ticker === h.ticker &&
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
    'The 98–99¢ BTC tests model one contract per market. The size test requires 1,000 visible on both checks. The 99.9¢ test models 100 contracts. Cross-venue tests model ten pairs. Strategies can overlap. Sale-window auction entries use a fee reserve. Later offers use estimated taker fees.'
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
  if (selected === 'weather_bracket') {
    note('The first afternoon NWS high predicts the final Kalshi range. Five paper YES shares require two fresh offers through 95¢ within an hour of publication. Later warming or a correction can change the winner.');
    table('Afternoon forecasts',['Contract','Reported high (°F)','First seen','Two-read checks','Settlement'],
      (d.weatherForecasts ?? []).map(r=>[r.ticker,r.high,time(r.at),r.checks,r.result?.toUpperCase() ?? 'Pending']),
      'Waiting for an afternoon report and open contract.');
  }
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
    if (n.postgame) {
      const p=n.postgame;
      note('NBA final-score study · '+(p.error??(p.confirmed+' agreed final scores · '+p.missedFinal+' monitored games expired before confirmation · '+p.trials+' simulated 99¢ bids · '+p.reviewed+' checked against public trades · '+p.reachedFive+' with enough selling for five contracts · '+p.adverseFive+' of those settled against the bid.')));
    }
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
    ['all', 'sothebys_live_bid', 'sothebys_bid_high', 'sothebys_bid_premium', 'sothebys_sold'].includes(
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
    if (selected === 'sothebys_bid_premium') {
      note('One paper YES contract through 95¢ when the bid has yet to exceed the threshold and the standard New York buyer’s premium would put it above. The test requires two live source updates and two order-book checks. Published sale prices can differ from the estimate.');
      if (s.premiumCrossings != null) note('Thresholds crossed by the estimate alone on the latest scan · ' + s.premiumCrossings);
      const disclosure = flag => flag === 1 ? 'Disclosed' : flag === 0 ? 'Symbol absent' : 'Unknown';
      table('Irrevocable bids in the lot catalog', ['Artwork','Irrevocable bid','Page checked'],
        s.targets.map(t => {
          const row = (d.saleDisclosures ?? []).find(r=>r.event===t.event);
          return [t.title,disclosure(row?.irrevocable),row ? time(row.at) : 'Pending'];
        }));
      note('If a compensated irrevocable bidder wins, Sotheby’s reports the sale price after deducting the fee. A deduction equal to the margin shown below puts the estimate exactly at the threshold.');
      table('Premium forecasts against settlement', ['Market','Displayed bid','Projected sale','Threshold','Margin above threshold','Irrevocable bid at forecast','Settlement'],
        (d.premiumSignals ?? []).map(r=>[r.ticker,money(r.bid),money(r.estimated),money(r.strike),money(r.estimated-r.strike),disclosure(r.irrevocable),r.result?.toUpperCase() ?? 'Pending']),
        'Waiting for a live bid to confirm a forecast twice.');
    }
    if (s.sold)
      note(
        s.sold.error ??
          s.sold.published +
            ' published sale prices � ' +
            s.sold.books +
            ' threshold books checked at ' +
            time(s.sold.at)
      );
    if (selected === 'sothebys_sold') {
      note('The lot page and auction catalog share one paper balance. The artwork-page test requires the same published sale price and available offers on two separate reads. Conflicting published verdicts suspend sold-price entries for that artwork.');
      table('Paper entries by result source',['Result source','Contracts','Entry cost with fees'],
        (d.soldPageEntries ?? []).map(r=>[r.source==='lot'?'Artwork page':'Auction catalog',r.shares,money(r.cost)]),
        'Waiting for a confirmed result and available contracts.');
    }
    if (
      ['sothebys_live_bid', 'sothebys_bid_high', 'sothebys_bid_premium', 'sothebys_sold'].includes(
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
      if (quotes.comparison?.some(r=>r.baselineAt)) {
        function depth(sample) {
          if (!sample?.depth95) return 'No depth sample';
          const {shares,overlap}=sample.depth95;
          return shares.toLocaleString()+' shown'+(overlap==null?'':' · '+overlap.toLocaleString()+' at matching prices');
        }
        table('Whole shares offered through 95¢ on the published-result side',
          ['Artwork','Pre-sale','At first result','After 30 seconds','After 5 minutes'],
          quotes.comparison.filter(r=>r.baselineAt).map(r=>[r.title,r.baselineShares.toLocaleString()+' at '+time(r.baselineAt),
            depth(r.after),depth(r.after30),depth(r.after300)]),'Waiting for quote comparisons.');
        note('Matching shares use the smaller displayed quantity at the same threshold and price in both snapshots. Orders can change between reads.');
      }
      const followups = (quotes.comparison ?? []).filter(r=>r.followup);
      if (followups.length) {
        table('New offers in the 15 minutes after both sale pages agree',
          ['Artwork','Thresholds initially without an offer through 95¢','Later pairs of snapshots','First new offers seen twice'],
          followups.map(({title,followup:f})=>[title,f.firstAt ? f.initiallyEmpty : 'Awaiting or missing first snapshot',
            f.pairs,f.found.map(o=>o.side.toUpperCase()+' above '+money(o.strike)+' · '+o.size+' at '+money(o.price)+' · '+time(o.at)).join(' / ') || 'None observed']),
          'Waiting for both published prices.');
      }
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
