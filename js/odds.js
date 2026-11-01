/*!
 * RaceAI / js/odds.js
 * ------------------------------------------------------------
 * オッズ・期待値・推奨買い目の生成。
 *
 * ・オッズは data/demo-races.json に格納されたデモ値（架空）を表示するだけで、
 *   オッズ配信APIには接続していません。
 * ・期待値 = 推定勝率 × 単勝オッズ（オッズは払戻倍率なのでそのまま乗算）。
 * ・控除率は「参考値」として画面に出すだけで、買い目の正当性を保証しません。
 * ------------------------------------------------------------
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./predictor.js'));
  } else {
    root.RaceAIOdds = factory(root.RaceAIPredictor);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Predictor) {
  'use strict';

  var CONFIG = {
    /* 単勝の控除率（JRA）。表示用の参考値で、主催者・券種により異なる。 */
    takeoutWin: 0.20,
    evThreshold: 1.05,
    placeEvThreshold: 1.03,
    minWinProb: 0.055,
    maxTickets: 2,
    stakeUnit: 100,
    maxStake: 5000,
   maxTotalStake: 5000,
    bankroll: 100000
  };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** オッズから市場の想定勝率（控除率込み）を求める */
  function impliedProbability(odds) {
    return isNum(odds) && odds > 1 ? 1 / odds : 0;
  }

  /** 単勝オッズ群の合計から、市場に埋め込まれた控除率を推定する */
  function estimatedTakeout(oddsList) {
    var sum = 0;
    (oddsList || []).forEach(function (o) { if (isNum(o) && o > 1) sum += 1 / o; });
    return sum > 1 ? 1 - 1 / sum : 0;
  }

  /** 期待値（払戻期待倍率）。1.00 で損益分岐、1.00未満は期待値マイナス。 */
function expectedValue(prob, odds) {
  // 確率は0～1の範囲のみ有効
  if (!isNum(prob) || prob < 0 || prob > 1) {
    return NaN;
  }

  // オッズは1.0倍を超える数値のみ有効
  if (!isNum(odds) || odds <= 1) {
    return NaN;
  }

  return prob * odds;
}

  /** モデル勝率と市場想定勝率の差（ポイント） */
  function edge(prob, odds) {
    return prob - impliedProbability(odds);
  }

  /** ケリー基準の賭け比率（上限25%でクリップ） */
  function kellyFraction(prob, odds) {
    if (!isNum(prob) || !isNum(odds) || odds <= 1) return 0;
    var f = (prob * odds - 1) / (odds - 1);
    return Math.max(0, Math.min(0.25, f));
  }

  /** 期待値の段階ラベル */
  function evTier(ev) {
    if (!isNum(ev)) return { key: 'none', label: '—' };
    if (ev >= 1.30) return { key: 'strong', label: '妙味大' };
    if (ev >= 1.10) return { key: 'plus', label: '妙味あり' };
    if (ev >= 1.00) return { key: 'flat', label: '五分' };
    return { key: 'minus', label: '見送り' };
  }

function stakeFor(prob, odds, opts) {
  var f = kellyFraction(prob, odds);
  if (f <= 0) return 0;

  var amount = Math.floor(
    (opts.bankroll * f * 0.25) / opts.stakeUnit
  ) * opts.stakeUnit;

  amount = Math.min(opts.maxStake, amount);

  return amount >= opts.stakeUnit ? amount : 0;
}

  /* ---------------------------------------------------------- */
  /* 推奨買い目の生成                                            */
  /* ---------------------------------------------------------- */

  function buildReasons(entry, pred, race) {
    var reasons = [];

    reasons.push(
      '推定勝率 ' + (entry.winProb * 100).toFixed(1) + '%（モデル内 ' +
      entry.winRank + '位／' + pred.headCount + '頭）'
    );

    var market = impliedProbability(entry.odds);
    if (market > 0) {
      var diff = (entry.winProb - market) * 100;
      reasons.push(
        '単勝 ' + entry.odds.toFixed(1) + '倍が示す市場想定 ' + (market * 100).toFixed(1) +
        '% に対し ' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + 'pt'
      );
    }

    var factors = Predictor.reasonsFor(entry, 2);
    factors.forEach(function (text) { reasons.push(text); });

    if (pred.pace) {
      reasons.push('想定ペース：' + pred.paceLabel + '（脚質 ' + (entry.style || '自在') + '）');
    }

    return reasons;
  }

  /**
   * 推奨買い目を返す。
   * 単勝・複勝のみ（この2券種はデモデータにオッズがあるため期待値を計算できる）。
   * 馬連・3連複はオッズ未提供のため「組合せ確率」として別枠で提示する。
   */
  function buildRecommendations(race, pred, options) {
    var opts = Object.assign({}, CONFIG, options || {});
    var tickets = [];

    // 出走馬データの重複・不正チェック
    var horses = pred && pred.horses;
    var seenNums = new Set();

    var invalidHorses =
        !Array.isArray(horses) ||
        horses.length === 0 ||
        horses.some(function (horse) {
            if (!horse || !Number.isInteger(horse.num) ||
                horse.num <= 0 || seenNums.has(horse.num)) {
                return true;
            }
            seenNums.add(horse.num);
            return false;
        });

    if (invalidHorses) {
        console.warn('[RaceAI] 出走馬データ異常：買い目生成を停止しました。');

        return {
            tickets: [],
            verdict: {
                key: 'skip',
                label: '見送り',
                note: '出走馬データに重複または不正な馬番があります。'
            },
            options: opts,
            totalStake: 0,
            expectedReturn: 0,
            marketTakeout: 0,
            rejectedCount: 0
        };
    }
    var rejected = [];
  // 購入金額に関する設定が正しいか確認する
  var validBudget =
    Number.isFinite(opts.bankroll) && opts.bankroll > 0 &&
    Number.isFinite(opts.maxStake) && opts.maxStake > 0 &&
    Number.isFinite(opts.maxTotalStake) && opts.maxTotalStake > 0 &&
    Number.isInteger(opts.stakeUnit) && opts.stakeUnit > 0 &&
    Number.isInteger(opts.maxTickets) && opts.maxTickets > 0;
  // 予算設定が不正な場合は買い目を生成しない
  if (!validBudget) {
    return {
      tickets: [],
      verdict: {
        key: 'skip',
        label: '見送り',
        note: '購入予算または購入設定が不正なため、買い目を生成しません。'
      },
      options: opts,
      totalStake: 0,
      expectedReturn: 0,
      marketTakeout: 0,
      rejectedCount: 0
    };
  }
    pred.horses.forEach(function (entry) {
      if (!isNum(entry.odds) || entry.odds <= 1 || !isNum(entry.winProb) || entry.winProb < 0 || entry.winProb > 1) return;

      var ev = expectedValue(entry.winProb, entry.odds);
      var odds = entry.odds;
if (entry.winProb >= opts.minWinProb && ev >= opts.evThreshold) {
  tickets.push({
    type: '単勝',
    typeKey: 'win',         
                    num: entry.num,
          name: entry.name,
          prob: entry.winProb,
          probKind: '勝率',
          odds: odds,
          ev: ev,
          edgePts: edge(entry.winProb, odds) * 100,
          stake: stakeFor(entry.winProb, odds, opts),
          reasons: buildReasons(entry, pred, race),
          order: ev
        });
      } else {
        rejected.push({ num: entry.num, name: entry.name, ev: ev, reason: ev < opts.evThreshold ? '期待値不足' : '勝率不足' });
      }

      /* 複勝（オッズは下限値を使用して保守的に評価） */
      // 複勝オッズの上下限を検証
var validPlaceOdds =
  Array.isArray(entry.placeOdds) &&
  entry.placeOdds.length === 2 &&
  Number.isFinite(entry.placeOdds[0]) &&
  Number.isFinite(entry.placeOdds[1]) &&
  entry.placeOdds[0] > 1 &&
  entry.placeOdds[1] >= entry.placeOdds[0];

var placeOdds = validPlaceOdds ? entry.placeOdds[0] : null;
      if (isNum(placeOdds)) {
        var placeEv = expectedValue(entry.placeProb, placeOdds);
        if (entry.placeProb >= 0.25 && placeEv >= opts.placeEvThreshold) {
          tickets.push({
            type: '複勝',
            typeKey: 'place',
            num: entry.num,
            name: entry.name,
            prob: entry.placeProb,
            probKind: '複勝率',
            odds: placeOdds,
            oddsRange: entry.placeOdds,
            ev: placeEv,
            edgePts: (entry.placeProb - impliedProbability(placeOdds)) * 100,
            stake: stakeFor(entry.placeProb, placeOdds, opts),
            reasons: [
              (pred.headCount >= 8 ? '3着以内' : '2着以内') + 'に入る確率 ' + (entry.placeProb * 100).toFixed(1) + '%（モデル算出）',
              '複勝オッズ ' + entry.placeOdds[0].toFixed(1) + '〜' + entry.placeOdds[1].toFixed(1) +
                '倍の下限で期待値 ' + placeEv.toFixed(2),
              '単勝 ' + entry.odds.toFixed(1) + '倍（' + entry.popularity + '番人気）に対し割安'
            ],
            order: placeEv - 0.15
          });
        }
      }
    });

    /* 単勝優先 → 期待値順。1頭につき1券種まで。 */
    tickets.sort(function (a, b) { return b.order - a.order; });
var usedNums = {};
var picked = [];
var totalStake = 0;
var prio = { win: 0, place: 1 };

tickets.sort(function (a, b) {
  if (prio[a.typeKey] !== prio[b.typeKey]) {
    return prio[a.typeKey] - prio[b.typeKey];
  }
  return b.ev - a.ev;
});

// 購入候補を最大件数まで選択
var candidates = [];

tickets.forEach(function (t) {
  if (candidates.length >= opts.maxTickets) return;
  if (usedNums[t.num]) return;
  if (!Number.isFinite(t.stake) || t.stake <= 0) return;

  usedNums[t.num] = true;
  candidates.push(t);
});

// 合計予算を候補数で均等配分
var perTicket = candidates.length > 0
  ? Math.floor(
      opts.maxTotalStake / candidates.length / opts.stakeUnit
    ) * opts.stakeUnit
  : 0;

candidates.forEach(function (t) {
  var amount = Math.min(t.stake, perTicket);

  if (amount < opts.stakeUnit) return;

  t.stake = amount;
  totalStake += amount;
  picked.push(t);
});
    /* 見送り判定 */
    var verdict = picked.length
      ? { key: 'bet', label: '推奨あり', note: '期待値が閾値（' + opts.evThreshold.toFixed(2) + '）を超えた買い目のみ表示しています' }
      : { key: 'skip', label: '見送り', note: '期待値 ' + opts.evThreshold.toFixed(2) + ' 以上の買い目がありません。無理に買わない判断も結果です。' };

    return {
      tickets: picked,
      verdict: verdict,
      options: opts,
      totalStake: picked.reduce(function (s, t) { return s + t.stake; }, 0),
      expectedReturn: picked.reduce(function (s, t) { return s + t.stake * t.ev; }, 0),
      marketTakeout: estimatedTakeout(pred.horses.map(function (h) { return h.odds; })),
      rejectedCount: rejected.length
    };
  }

  /* ---------------------------------------------------------- */
  /* 組合せ確率（オッズ未提供の券種は確率のみ）                   */
  /* ---------------------------------------------------------- */

  function buildComboBoard(pred) {
    var top = pred.horses.slice(0, 5);
    if (top.length < 3) return { quinella: [], trio: [] };

    var weights = pred.weights;
    var idx = pred.indexByNum;

    var quinella = [];
    for (var i = 0; i < top.length; i += 1) {
      for (var j = i + 1; j < top.length; j += 1) {
        var p = Predictor.comboProbability(weights, [idx[top[i].num], idx[top[j].num]]);
        quinella.push({
          label: top[i].num + '-' + top[j].num,
          names: top[i].name + ' / ' + top[j].name,
          prob: p
        });
      }
    }
    quinella.sort(function (a, b) { return b.prob - a.prob; });

    var trio = [];
    for (var a = 0; a < Math.min(4, top.length); a += 1) {
      for (var b = a + 1; b < Math.min(4, top.length); b += 1) {
        for (var c = b + 1; c < Math.min(4, top.length); c += 1) {
          var q = Predictor.comboProbability(weights, [idx[top[a].num], idx[top[b].num], idx[top[c].num]]);
          trio.push({
            label: top[a].num + '-' + top[b].num + '-' + top[c].num,
            names: top[a].name + ' / ' + top[b].name + ' / ' + top[c].name,
            prob: q
          });
        }
      }
    }
    trio.sort(function (x, y) { return y.prob - x.prob; });

    return { quinella: quinella.slice(0, 5), trio: trio.slice(0, 5) };
  }

  return {
    CONFIG: CONFIG,
    impliedProbability: impliedProbability,
    estimatedTakeout: estimatedTakeout,
    expectedValue: expectedValue,
    edge: edge,
    kellyFraction: kellyFraction,
    evTier: evTier,
    buildRecommendations: buildRecommendations,
    buildComboBoard: buildComboBoard
  };
});
