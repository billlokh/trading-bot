'use strict';
var https = require('https');
var ti    = require('technicalindicators');
var fs    = require('fs');

var API_KEY = 'your_api_key';

var CONFIG = {
  symbol:          'XAU',
  startDate:       '2022-01-01',
  startingBalance: 1000,
  riskAllocation:  0.02,
  breakoutPeriod:  35,
  atrSLMult:       1.9,
  atrTPMult:       2.9,
  channelWidth:    0.025,
  takerFee:        0.0001,
  slippage:        0.0003,
  tradeFile:       './backtest_gold.json',
};

function sleep(ms) {
  return new Promise(function(r){ setTimeout(r, ms); });
}

function httpGet(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, function(res) {
      var data = '';
      res.on('data', function(chunk){ data += chunk; });
      res.on('end', function(){
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse failed: '+data.slice(0,200))); }
      });
    }).on('error', reject);
  });
}

async function fetchDaily() {
  console.log('  Reading gold_daily.csv...');
  var raw  = fs.readFileSync('./gold_daily.csv', 'utf8');
  var rows = raw.trim().split('\n').slice(1); // skip header
  var candles = rows
    .filter(function(r){ return r.trim(); })
    .map(function(r){
      var p = r.split(',');
      return [
        new Date(p[0]).getTime(),
        parseFloat(p[1]),
        parseFloat(p[2]),
        parseFloat(p[3]),
        parseFloat(p[4]),
        parseFloat(p[5]) || 1
      ];
    })
    .filter(function(c){
      return c[0] >= new Date(CONFIG.startDate).getTime() && !isNaN(c[4]);
    })
    .sort(function(a,b){ return a[0]-b[0]; });
  console.log('  Got '+candles.length+' daily candles');
  return candles;
}

async function fetchIntraday(interval) {
  console.log('  Fetching '+interval+' candles for XAU/USD...');
  await sleep(15000); // Alpha Vantage free = 5 calls/min

  // Alpha Vantage free tier does not support intraday FX for XAU
  // We use daily candles for all timeframes in this backtest
  return [];
}

function simulate(c1d) {
  console.log('Building indicators on daily candles...');

  var closes = c1d.map(function(c){return c[4];});
  var highs  = c1d.map(function(c){return c[2];});
  var lows   = c1d.map(function(c){return c[3];});
  var vols   = c1d.map(function(c){return c[5];});
  var times  = c1d.map(function(c){return c[0];});
  var n      = closes.length;

  if (n < 100) {
    console.error('Not enough candles: '+n);
    process.exit(1);
  }

  var RSI    = ti.RSI.calculate({ values: closes, period: 14 });
  var ATR    = ti.ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  var EMA20  = ti.EMA.calculate({ period: 20, values: closes });
  var EMA50  = ti.EMA.calculate({ period: 50, values: closes });

  var rsiOff = n - RSI.length;
  var atrOff = n - ATR.length;
  var e20Off = n - EMA20.length;
  var e50Off = n - EMA50.length;
  var startI = Math.max(rsiOff, atrOff, e20Off, e50Off, CONFIG.breakoutPeriod) + 3;

  function avgAtrVal(i) {
    var arr = ATR.slice(Math.max(0, i-atrOff-20), i-atrOff+1);
    if (!arr.length) return 0;
    return arr.reduce(function(a,b){return a+b;},0)/arr.length;
  }

  var balance = CONFIG.startingBalance;
  var pos     = null;
  var trades  = [];
  var peak    = balance;
  var maxDD   = 0;
  var signals = 0;

  console.log('Running signal loop on '+n+' daily candles...');

  for (var i = startI; i < n; i++) {

    if (pos) {
      var hi    = highs[i];
      var lo    = lows[i];
      var hitSL = lo <= pos.sl;
      var hitTP = hi >= pos.tp;

      if (hitSL || hitTP) {
        var xp     = hitSL ? pos.sl : pos.tp;
        var reason = hitSL ? 'STOP_LOSS' : 'TAKE_PROFIT';
        var net    = xp * (1-CONFIG.slippage) * (1-CONFIG.takerFee);
        var pnl    = (net - pos.cost) * pos.amt;
        var pct    = (net - pos.cost) / pos.cost * 100;
        balance   += pos.amt * net;

        trades.push({
          id:        trades.length+1,
          entryTime: new Date(pos.time).toISOString().slice(0,10),
          exitTime:  new Date(times[i]).toISOString().slice(0,10),
          entry:     parseFloat(pos.cost.toFixed(2)),
          exit:      parseFloat(net.toFixed(2)),
          pnl:       parseFloat(pnl.toFixed(2)),
          pnlPct:    parseFloat(pct.toFixed(3)),
          reason:    reason,
          balance:   parseFloat(balance.toFixed(2)),
          duration:  Math.round((times[i]-pos.time)/(1000*60*60*24))
        });

        if (balance > peak) peak = balance;
        var dd = (peak-balance)/peak*100;
        if (dd > maxDD) maxDD = dd;
        pos = null;
      }
      continue;
    }

    var rsi   = RSI[i-rsiOff];
    var atr   = ATR[i-atrOff];
    var e20   = EMA20[i-e20Off];
    var e50   = EMA50[i-e50Off];
    var price = closes[i];
    var aatr  = avgAtrVal(i);

    if (!rsi || !atr || !e20 || !e50) continue;

    // Daily trend filter
    var trendOk = price > e20 && e20 > e50;
    if (!trendOk) continue;

    // Donchian breakout
    var highN = 0, lowN = Infinity;
    for (var x = i-CONFIG.breakoutPeriod; x < i; x++) {
      if (highs[x] > highN) highN = highs[x];
      if (lows[x]  < lowN)  lowN  = lows[x];
    }

    if (price <= highN)                          continue;
    if (rsi < 55 || rsi > 78)                    continue;
    if (aatr > 0 && atr > aatr * 2.5)           continue;
    if ((highN-lowN)/lowN < CONFIG.channelWidth) continue;

    signals++;
    if (balance < 11) continue;

    var slDist     = atr * CONFIG.atrSLMult;
    var maxLossUsd = balance * CONFIG.riskAllocation;
    var amt        = maxLossUsd / slDist;
    var cost       = price * (1+CONFIG.slippage) * (1+CONFIG.takerFee);
    var posUsd     = amt * cost;

    if (posUsd > balance * 0.95) {
      amt    = (balance * 0.95) / cost;
      posUsd = amt * cost;
    }

    balance -= posUsd;

    pos = {
      time:  times[i],
      entry: price,
      cost:  cost,
      amt:   amt,
      sl:    price - slDist,
      tp:    price + atr * CONFIG.atrTPMult,
    };
  }

  if (pos) {
    var ep   = closes[n-1];
    var net2 = ep*(1-CONFIG.slippage)*(1-CONFIG.takerFee);
    var pnl2 = (net2-pos.cost)*pos.amt;
    balance += pos.amt*net2;
    trades.push({
      id:        trades.length+1,
      entryTime: new Date(pos.time).toISOString().slice(0,10),
      exitTime:  new Date(times[n-1]).toISOString().slice(0,10),
      entry:     parseFloat(pos.cost.toFixed(2)),
      exit:      parseFloat(net2.toFixed(2)),
      pnl:       parseFloat(pnl2.toFixed(2)),
      pnlPct:    parseFloat(((net2-pos.cost)/pos.cost*100).toFixed(3)),
      reason:    'END_OF_DATA',
      balance:   parseFloat(balance.toFixed(2)),
      duration:  0
    });
  }

  console.log('Signals: '+signals+'  Trades: '+trades.length);

  var wins   = trades.filter(function(t){return t.pnl>0;});
  var losses = trades.filter(function(t){return t.pnl<=0;});
  var wr     = trades.length ? wins.length/trades.length*100 : 0;
  var tr     = (balance-CONFIG.startingBalance)/CONFIG.startingBalance*100;
  var mons   = (times[n-1]-times[0])/(1000*60*60*24*30.44);
  var ann    = tr/mons*12;
  var gw     = wins.reduce(function(s,t){return s+t.pnl;},0);
  var gl     = Math.abs(losses.reduce(function(s,t){return s+t.pnl;},0));
  var pf     = gl>0 ? gw/gl : 999;
  var mc=0,cc=0;
  for (var x=0;x<trades.length;x++){
    cc=trades[x].pnl<=0?cc+1:0;
    if(cc>mc)mc=cc;
  }

  return {
    stats: {
      period:         new Date(times[0]).toDateString()+' to '+new Date(times[n-1]).toDateString(),
      months:         parseFloat(mons.toFixed(1)),
      trades:         trades.length,
      tradesPerMonth: parseFloat((trades.length/mons).toFixed(1)),
      wins:           wins.length,
      losses:         losses.length,
      winRate:        parseFloat(wr.toFixed(1)),
      profitFactor:   parseFloat(pf.toFixed(2)),
      totalReturn:    parseFloat(tr.toFixed(2)),
      annualized:     parseFloat(ann.toFixed(2)),
      maxDD:          parseFloat(maxDD.toFixed(2)),
      finalBal:       parseFloat(balance.toFixed(2)),
      maxConsec:      mc,
    },
    trades: trades,
  };
}

async function main() {
  try {
    console.log('');
    console.log('========================================');
    console.log('  VANTABLACK GOLD v2 — XAU/USD');
    console.log('  Daily candles via Alpha Vantage');
    console.log('  Full cycle: 2022 to 2026');
    console.log('  Risk: 2%   SL: 1.9x   TP: 2.9x');
    console.log('========================================');
    console.log('');

    var c1d = await fetchDaily();

    if (!c1d.length) {
      console.error('Failed to fetch gold data.');
      process.exit(1);
    }

    var result = simulate(c1d);
    var s = result.stats;

    console.log('');
    console.log('========================================');
    console.log('  RESULTS — GOLD (XAU/USD) DAILY');
    console.log('========================================');
    console.log('  Period:           ' + s.period);
    console.log('  Total trades:     ' + s.trades);
    console.log('  Trades per month: ' + s.tradesPerMonth);
    console.log('  Win rate:         ' + s.winRate + '%');
    console.log('  Profit factor:    ' + s.profitFactor + 'x');
    console.log('  Total return:     ' + (s.totalReturn>=0?'+':'') + s.totalReturn + '%');
    console.log('  Annualized:       ' + (s.annualized>=0?'+':'') + s.annualized + '%');
    console.log('  Max drawdown:     -' + s.maxDD + '%');
    console.log('  Max consec loss:  ' + s.maxConsec);
    console.log('  Final balance:    $' + s.finalBal);
    console.log('========================================');
    console.log('');

    fs.writeFileSync(CONFIG.tradeFile, JSON.stringify({ stats: s, trades: result.trades }, null, 2));
    console.log('Saved: backtest_gold.json');
  } catch(e) {
    console.error('Error: '+e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
