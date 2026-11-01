/*!
 * RaceAI / js/backtest.js
 * ------------------------------------------------------------
 * 過去検証（バックテスト）の計算。
 *
 * ■ 重要
 * このファイルは「実運用の成績」を読み込むものではありません。
 * 実データが未接続のため、モデルの確率分布を前提にした
 * モンテカルロ・シミュレーションをシード固定で実行し、
 * 的中率・回収率・損益の"計算処理"が正しく動くことを示します。
 * 結果はすべて「デモ検証値」として画面に明示されます。
 * ------------------------------------------------------------
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RaceAIBacktest = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    races: 600,
    seed: 20261101,
    stake: 1000,
    evThreshold: 1.05,
    minProb: 0.055,
    /* モデルが市場に対して持つと仮定する優位度（0=市場と同等, 1=モデルが真値） */
    skill: 0.5,
    takeout: 0.20,
    startDate: '2026-05-05',
    endDate: '2026-11-01'
  };

  /* ---------------------------------------------------------- */
  /* 乱数（シード固定で毎回同じ結果になる）                       */
  /* ---------------------------------------------------------- */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function normalize(values) {
    var sum = 0, i;
    for (i = 0; i < values.length; i += 1) sum += values[i];
    if (!(sum > 0)) return values.map(function () { return 1 / values.length; });
    return values.map(function (v) { return v / sum; });
  }

  function powNormalize(values, gamma) {
    return normalize(values.map(function (v) { return Math.pow(v, gamma); }));
  }

  /** Plackett–Luce で着順を1つサンプリング */
  function sampleOrder(probs, rng) {
    var remaining = probs.map(function (p, i) { return i; });
    var order = [];
    while (remaining.length) {
      var total = 0, i;
      for (i = 0; i < remaining.length; i += 1) total += probs[remaining[i]];
      var r = rng() * total;
      var acc = 0, pick = remaining[remaining.length - 1];
      for (i = 0; i < remaining.length; i += 1) {
        acc += probs[remaining[i]];
        if (r <= acc) { pick = remaining[i]; break; }
      }
      order.push(pick);
      remaining = remaining.filter(function (x) { return x !== pick; });
    }
    return order;
  }

  function roundOdds(v) {
    if (v < 10) return Math.max(1.1, Math.round(v * 10) / 10);
    if (v < 50) return Math.max(10, Math.round(v * 2) / 2);
    return Math.round(v);
  }

  function dateAt(index, total, start, end) {
    var s = new Date(start + 'T00:00:00+09:00').getTime();
    var e = new Date(end + 'T00:00:00+09:00').getTime();
    var t = s + ((e - s) * index) / Math.max(1, total - 1);
    var d = new Date(t);
    return d.toISOString().slice(0, 10);
  }

  function summarizeBets(bets, label, key) {
    var stake = 0, payout = 0, hits = 0;
    var cumulative = 0, peak = 0, maxDD = 0;
    var streak = 0, worstStreak = 0;

    bets.forEach(function (b) {
      stake += b.stake;
      if (b.hit) { payout += b.payout; hits += 1; streak = 0; }
      else { streak += 1; if (streak > worstStreak) worstStreak = streak; }

      cumulative += (b.hit ? b.payout : 0) - b.stake;
      if (cumulative > peak) peak = cumulative;
      if (peak - cumulative > maxDD) maxDD = peak - cumulative;
    });

    var pnl = payout - stake;
    return {
      key: key,
      label: label,
      bets: bets.length,
      hits: hits,
      hitRate: bets.length ? hits / bets.length : 0,
      stake: stake,
      payout: payout,
      pnl: pnl,
      roi: stake ? payout / stake : 0,
      maxDrawdown: maxDD,
      worstStreak: worstStreak
    };
  }

  /* ---------------------------------------------------------- */
  /* 本体                                                        */
  /* ---------------------------------------------------------- */

  function run(options) {
    var cfg = Object.assign({}, DEFAULTS, options || {});
    var rng = mulberry32(cfg.seed);

    var bets = { ev: [], fav: [], model: [] };
    var daily = {};
    var raceDates = [];

    for (var r = 0; r < cfg.races; r += 1) {
      var date = dateAt(r, cfg.races, cfg.startDate, cfg.endDate);
      raceDates.push(date);

      var n = 12 + Math.floor(rng() * 5); /* 12〜16頭 */
      var raw = [], i;
      for (i = 0; i < n; i += 1) raw.push(Math.exp(gaussian(rng) * 1.0));
      var market = normalize(raw);

      /* モデル推定：市場と強く相関しつつ、やや鋭く、独自のノイズを持つ */
      var modelRaw = market.map(function (m) { return Math.pow(m, 1.08) * Math.exp(gaussian(rng) * 0.22); });
      var model = normalize(modelRaw);

      /* 真の勝率：市場とモデルの混合（skill が高いほどモデル寄り） */
      var truth = normalize(market.map(function (m, k) {
        return Math.pow(m, 1 - cfg.skill) * Math.pow(model[k], cfg.skill);
      }));

      /* デモオッズ：市場確率から控除率を差し引いた値に丸める */
      var odds = market.map(function (m) { return roundOdds((1 - cfg.takeout) / m); });

      var order = sampleOrder(truth, rng);
      var winner = order[0];
      var second = order[1];
      var third = order[2];

      /* --- 戦略1: 期待値フィルタ単勝 --- */
      var candidates = [];
      for (i = 0; i < n; i += 1) {
        if (model[i] < cfg.minProb) continue;
        var ev = model[i] * odds[i];
        if (ev >= cfg.evThreshold) candidates.push({ idx: i, ev: ev });
      }
      candidates.sort(function (a, b) { return b.ev - a.ev; });
      candidates.slice(0, 2).forEach(function (c) {
        var hit = c.idx === winner;
        bets.ev.push({
          date: date,
          race: r + 1,
          num: c.idx + 1,
          odds: odds[c.idx],
          prob: model[c.idx],
          ev: c.ev,
          stake: cfg.stake,
          hit: hit,
          payout: hit ? Math.round(cfg.stake * odds[c.idx]) : 0
        });
      });

      /* --- 戦略2: 1番人気 単勝 --- */
      var favIdx = market.indexOf(Math.max.apply(null, market));
      bets.fav.push({
        date: date, race: r + 1, num: favIdx + 1, odds: odds[favIdx],
        prob: model[favIdx], ev: model[favIdx] * odds[favIdx],
        stake: cfg.stake, hit: favIdx === winner,
        payout: favIdx === winner ? Math.round(cfg.stake * odds[favIdx]) : 0
      });

      /* --- 戦略3: モデル本命 単勝 --- */
      var topIdx = model.indexOf(Math.max.apply(null, model));
      bets.model.push({
        date: date, race: r + 1, num: topIdx + 1, odds: odds[topIdx],
        prob: model[topIdx], ev: model[topIdx] * odds[topIdx],
        stake: cfg.stake, hit: topIdx === winner,
        payout: topIdx === winner ? Math.round(cfg.stake * odds[topIdx]) : 0
      });

      /* 的中馬（表彰用） */
      if (r % 1 === 0) {
        daily[date] = daily[date] || { date: date, pnl: 0, bets: 0, hits: 0 };
      }
      daily[date].winnerNum = winner + 1;
      daily[date].secondNum = second + 1;
      daily[date].thirdNum = third + 1;
    }

    /* 期待値戦略の日次損益 */
    bets.ev.forEach(function (b) {
      var d = daily[b.date];
      if (!d) return;
      d.bets += 1;
      if (b.hit) d.hits += 1;
      d.pnl += (b.hit ? b.payout : 0) - b.stake;
    });

    var series = Object.keys(daily).sort().map(function (k) {
      return { date: k, pnl: daily[k].pnl, bets: daily[k].bets, hits: daily[k].hits };
    });

    var cumulative = 0;
    var equity = series.map(function (d) {
      cumulative += d.pnl;
      return { date: d.date, pnl: d.pnl, cumulative: cumulative };
    });

    var strategies = [
      summarizeBets(bets.ev, '期待値 ' + cfg.evThreshold.toFixed(2) + ' 以上のみ（単勝）', 'ev'),
      summarizeBets(bets.model, 'モデル本命を毎レース（単勝）', 'model'),
      summarizeBets(bets.fav, '1番人気を毎レース（単勝）', 'fav')
    ];

    /* 月別集計（期待値戦略） */
    var monthly = {};
    bets.ev.forEach(function (b) {
      var m = b.date.slice(0, 7);
      monthly[m] = monthly[m] || { month: m, bets: 0, hits: 0, stake: 0, payout: 0 };
      monthly[m].bets += 1;
      monthly[m].stake += b.stake;
      if (b.hit) { monthly[m].hits += 1; monthly[m].payout += b.payout; }
    });

    var monthlyList = Object.keys(monthly).sort().map(function (k) {
      var m = monthly[k];
      return {
        month: k,
        bets: m.bets,
        hits: m.hits,
        hitRate: m.bets ? m.hits / m.bets : 0,
        stake: m.stake,
        pnl: m.payout - m.stake,
        roi: m.stake ? m.payout / m.stake : 0
      };
    });

    var recent = bets.ev.slice(-14).reverse();

    return {
      config: {
        races: cfg.races,
        seed: cfg.seed,
        stake: cfg.stake,
        evThreshold: cfg.evThreshold,
        skill: cfg.skill,
        takeout: cfg.takeout,
        periodFrom: cfg.startDate,
        periodTo: cfg.endDate
      },
      primary: strategies[0],
      strategies: strategies,
      equity: equity,
      monthly: monthlyList,
      recent: recent,
      simulated: true,
      generatedAt: new Date().toISOString()
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    run: run,
    mulberry32: mulberry32
  };
});
