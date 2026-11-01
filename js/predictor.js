/*!
 * RaceAI / js/predictor.js
 * ------------------------------------------------------------
 * 推定勝率・複勝率・組合せ確率の算出。
 *
 * ・このファイルは「計算モデル」のみを持ちます。外部APIへは接続しません。
 * ・入力は data/demo-races.json の出走馬データ（架空のデモ値）。
 * ・出力は確率（合計1）で、オッズは一切使わずに算出します。
 *   オッズは odds.js 側で期待値の計算にのみ使用します。
 * ------------------------------------------------------------
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RaceAIPredictor = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  /* モデルの係数。UI の「モデル」表示にもこの配列を使う。 */
  var FACTORS = [
    { key: 'form',      label: '近走成績',    weight: 1.00 },
    { key: 'speed',     label: '上がり3F',    weight: 0.85 },
    { key: 'distance',  label: '距離適性',    weight: 0.70 },
    { key: 'going',     label: '馬場適性',    weight: 0.50 },
    { key: 'pace',      label: '脚質×展開',   weight: 0.40 },
    { key: 'jockey',    label: '騎手',        weight: 0.40 },
    { key: 'impost',    label: '斤量',        weight: 0.30 },
    { key: 'draw',      label: '枠順',        weight: 0.25 },
    { key: 'freshness', label: '休養期間',    weight: 0.25 },
    { key: 'condition', label: '馬体',        weight: 0.15 }
  ];

  var DEFAULTS = {
    /* softmax の温度。大きいほど上位に確率が集まる。 */
    sharpness: 5.9
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  function pctText(p, digits) {
    return (p * 100).toFixed(digits === undefined ? 1 : digits) + '%';
  }

  /* ---------------------------------------------------------- */
  /* 各ファクターのスコア（0〜1、0.5が中立）                     */
  /* ---------------------------------------------------------- */

  function formScore(horse) {
    var runs = (horse.recent || []).slice(0, 5);
    if (!runs.length) return { score: 0.5, note: '近走データなし' };

    var weights = [1.0, 0.8, 0.65, 0.5, 0.4];
    var sum = 0, wsum = 0, placeSum = 0;

    runs.forEach(function (r, i) {
      var field = num(r.field, 12) || 12;
      var place = clamp(num(r.place, field), 1, field);
      var value = (field - place) / Math.max(1, field - 1);
      sum += value * weights[i];
      wsum += weights[i];
      placeSum += place;
    });

    var avg = sum / wsum;
    return {
      score: clamp(avg * 1.12 - 0.06, 0.05, 0.98),
      note: '近走' + runs.length + '走 平均' + (placeSum / runs.length).toFixed(1) + '着'
    };
  }

  function speedScore(horse) {
    var v = num(horse.last3fAvg, 35.6);
    return {
      score: clamp((37.6 - v) / 3.6, 0.05, 0.98),
      note: '平均上がり3F ' + v.toFixed(1) + '秒'
    };
  }

  function rateOf(rec) {
    if (!rec || !num(rec.starts, 0)) return null;
    var starts = num(rec.starts, 0);
    return {
      starts: starts,
      win: num(rec.wins, 0) / starts,
      top3: num(rec.top3, 0) / starts
    };
  }

  function recordScore(rec, emptyNote) {
    var r = rateOf(rec);
    if (!r) return { score: 0.48, note: emptyNote };

    var fit = 0.5 + (r.win * 1.15 + r.top3 * 0.85 - 0.62) * 0.85;
    fit = clamp(fit, 0.06, 0.96);

    /* 出走数が少ないほど中立(0.5)へ寄せる */
    var confidence = clamp(r.starts / 6, 0.35, 1);
    return {
      score: 0.5 + (fit - 0.5) * confidence,
      raw: r
    };
  }

  function distanceScore(horse, race) {
    var base = recordScore(horse.stats && horse.stats.distance, '距離実績なし');
    var note = base.raw
      ? race.distance + 'm ' + base.raw.starts + '戦' + Math.round(base.raw.win * base.raw.starts) + '勝'
      : base.note;
    return { score: base.score, note: note };
  }

  function goingScore(horse, race) {
    var going = race.trackCondition || '良';
    var table = (horse.stats && horse.stats.going) || {};
    var rec = table[going];
    var base = recordScore(rec, going + ' 実績なし');
    var note = base.raw
      ? going + ' ' + base.raw.starts + '戦' + Math.round(base.raw.win * base.raw.starts) + '勝'
      : base.note;
    return { score: base.score, note: note };
  }

  function paceScore(horse, ctx) {
    var style = horse.style || '自在';
    var s = 0.5;
    if (ctx.pace === 'high') {
      if (style === '差し' || style === '追込') s += 0.13;
      else if (style === '逃げ') s -= 0.09;
      else if (style === '先行') s -= 0.04;
    } else if (ctx.pace === 'slow') {
      if (style === '逃げ') s += 0.12;
      else if (style === '先行') s += 0.07;
      else if (style === '追込') s -= 0.09;
      else if (style === '差し') s -= 0.04;
    }
    return {
      score: clamp(s, 0.1, 0.9),
      note: style + '／予想' + ctx.paceLabel
    };
  }

  function jockeyScore(horse) {
    var rate = num(horse.jockeyWinRate, 0.08);
    return {
      score: clamp((rate - 0.02) / 0.20, 0.10, 0.95),
      note: '騎手勝率 ' + pctText(rate, 1)
    };
  }

  function impostScore(horse, ctx) {
    var w = num(horse.weight, ctx.baseWeight || 55);
    return {
      score: clamp(0.5 + ((ctx.baseWeight || 55) - w) * 0.06, 0.10, 0.90),
      note: '斤量 ' + w.toFixed(1) + 'kg'
    };
  }

  function drawScore(horse, race, ctx) {
    var bias = race.drawBias || {};
    var pos = ctx.headCount > 1 ? (num(horse.num, 1) - 1) / (ctx.headCount - 1) : 0.5;
    var s = 0.5;
    if (pos <= 0.34) s += num(bias.inside, 0);
    else if (pos >= 0.66) s += num(bias.outside, 0);
    return {
      score: clamp(s, 0.15, 0.85),
      note: horse.num + '番（' + (horse.frame || '-') + '枠）'
    };
  }

  function freshnessScore(horse) {
    var d = num(horse.daysSinceLast, 35);
    var s;
    if (d < 0) s = 0.45;
    else if (d < 14) s = 0.58;
    else if (d <= 42) s = 0.86;
    else if (d <= 84) s = 0.66;
    else if (d <= 180) s = 0.46;
    else s = 0.34;
    return { score: s, note: d >= 0 ? '中' + d + '日' : '休養不明' };
  }

  function conditionScore(horse) {
    var diff = num(horse.bodyWeightDiff, 0);
    var abs = Math.abs(diff);
    var s = abs <= 8 ? 0.55 : (abs <= 14 ? 0.45 : 0.34);
    return {
      score: s,
      note: horse.bodyWeight
        ? '馬体重 ' + horse.bodyWeight + 'kg（' + (diff > 0 ? '+' : '') + diff + '）'
        : '馬体重 未計測'
    };
  }

  /* ---------------------------------------------------------- */
  /* レース文脈（ペース予測・頭数など）                          */
  /* ---------------------------------------------------------- */

  function buildContext(race) {
    var horses = race.horses || [];
    var headCount = horses.length;
    var front = 0, closer = 0;

    horses.forEach(function (h) {
      var st = h.style || '自在';
      if (st === '逃げ') front += 1;
      else if (st === '先行') front += 0.8;
      else if (st === '自在') front += 0.35;
      else if (st === '追込') closer += 1;
      else closer += 0.7;
    });

    var frontRatio = headCount ? front / headCount : 0.4;
    var pace, paceLabel;
    if (frontRatio >= 0.45) { pace = 'high'; paceLabel = 'ハイペース'; }
    else if (frontRatio <= 0.26) { pace = 'slow'; paceLabel = 'スローペース'; }
    else { pace = 'middle'; paceLabel = '平均ペース'; }

    /* 基準斤量（そのレースの最も多い斤量） */
    var counts = {};
    horses.forEach(function (h) {
      var w = num(h.weight, 55).toFixed(1);
      counts[w] = (counts[w] || 0) + 1;
    });
    var baseWeight = 55;
    var best = -1;
    Object.keys(counts).forEach(function (k) {
      if (counts[k] > best) { best = counts[k]; baseWeight = parseFloat(k); }
    });

    return {
      headCount: headCount,
      pace: pace,
      paceLabel: paceLabel,
      frontRatio: frontRatio,
      closerRatio: headCount ? closer / headCount : 0,
      baseWeight: baseWeight
    };
  }

  /* ---------------------------------------------------------- */
  /* Plackett–Luce による着順確率                                */
  /* ---------------------------------------------------------- */

  /**
   * k着以内に入る確率を厳密に列挙して求める（k は 3 程度を想定）。
   * weights は勝率（合計1）でなくてもよい（正規化される）。
   */
  function validateRankingWeights(weights, k) {
    if (!Array.isArray(weights) || weights.length === 0) {
      throw new Error('着順計算: 出走馬の重みがありません');
    }

    if (!Number.isInteger(k) || k < 1 || k > weights.length) {
      throw new Error('着順計算: 着順数が不正です');
    }

    var positive = 0;

    weights.forEach(function (w) {
      if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
        throw new Error('着順計算: 重みに不正な数値があります');
      }

      if (w > 0) positive += 1;
    });

    if (positive < k) {
      throw new Error('着順計算: 正の重みを持つ馬が不足しています');
    }

    var total = weights.reduce(function (sum, w) {
      return sum + w;
    }, 0);

    if (!Number.isFinite(total) || total <= 0) {
      throw new Error('着順計算: 重みの合計が不正です');
    }
  }
  function topKProbabilities(weights, k) {
    validateRankingWeights(weights, k);
    var n = weights.length;
    var out = new Array(n);
    for (var i = 0; i < n; i += 1) out[i] = 0;
    if (!n) return out;
    if (k >= n) {
      for (var j = 0; j < n; j += 1) out[j] = 1;
      return out;
    }

    var stack = [];

    function walk(remaining, prob, depth) {
      if (depth === k) {
        for (var s = 0; s < stack.length; s += 1) out[stack[s]] += prob;
        return;
      }
      var total = 0;
      var r;
      for (r = 0; r < remaining.length; r += 1) total += weights[remaining[r]];
      if (total <= 0) return;

      for (r = 0; r < remaining.length; r += 1) {
        var idx = remaining[r];
        var p = weights[idx] / total;
        if (!(p > 0)) continue;
        stack.push(idx);
        var next = remaining.slice(0, r).concat(remaining.slice(r + 1));
        walk(next, prob * p, depth + 1);
        stack.pop();
      }
    }

    var all = [];
    for (var m = 0; m < n; m += 1) all.push(m);
    walk(all, 1, 0);
    return out;
  }

  /**
   * 指定した馬番集合が上位k着を占める確率（順不同）。
   * 例: comboProbability(probs, [2,5], 3) は3連複 2-5-* ではなく
   *     指定集合が上位kを占める確率なので、3連複は indices.length === k で使う。
   */
  function comboProbability(weights, indices) {
    // 組合せ確率の入力データを検証
    if (!Array.isArray(weights) || weights.length === 0) {
      throw new Error('組合せ確率: 出走馬データが不正です');
    }

    if (!Array.isArray(indices) ||
        indices.length === 0 ||
        indices.length > weights.length) {
      throw new Error('組合せ確率: 馬の指定が不正です');
    }

    // 勝率の異常値を検出
    weights.forEach(function (w) {
      if (typeof w !== 'number' ||
          !Number.isFinite(w) ||
          w < 0) {
        throw new Error('組合せ確率: 不正な確率があります');
      }
    });

    // 馬の指定範囲と重複を確認
    var seenIndices = new Set();

    indices.forEach(function (idx) {
      if (!Number.isInteger(idx) ||
          idx < 0 ||
          idx >= weights.length ||
          seenIndices.has(idx)) {
        throw new Error('組合せ確率: 馬の指定に重複または異常があります');
      }

      seenIndices.add(idx);
    });

    // 計算に必要な正の重みを確認
    var positiveCount = weights.filter(function (w) {
      return w > 0;
    }).length;

    var totalWeight = weights.reduce(function (sum, w) {
      return sum + w;
    }, 0);

    if (positiveCount < indices.length ||
        !Number.isFinite(totalWeight) ||
        totalWeight <= 0) {
      throw new Error('組合せ確率: 計算できない重みです');
    }
    var n = weights.length;
    var picked = indices.slice();
    var out = 0;
    var used = {};

    function perm(list, prob) {
      if (!list.length) { out += prob; return; }
      var total = 0, i;
      for (i = 0; i < n; i += 1) if (!used[i]) total += weights[i];
      if (total <= 0) return;
      for (i = 0; i < list.length; i += 1) {
        var idx = list[i];
        used[idx] = true;
        perm(list.slice(0, i).concat(list.slice(i + 1)), prob * (weights[idx] / total));
        used[idx] = false;
      }
    }

    perm(picked, 1);
    return out;
  }

  /* ---------------------------------------------------------- */
  /* 予測本体                                                    */
  /* ---------------------------------------------------------- */

  function predictRace(race, options) {
    var opts = Object.assign({}, DEFAULTS, options || {});
    var horses = (race && race.horses) || [];

    if (!horses.length) {
      throw new Error('出走馬データがありません');
    }

    var ctx = buildContext(race);

    var rows = horses.map(function (horse) {
      var factors = {
        form: formScore(horse),
        speed: speedScore(horse),
        distance: distanceScore(horse, race),
        going: goingScore(horse, race),
        pace: paceScore(horse, ctx),
        jockey: jockeyScore(horse),
        impost: impostScore(horse, ctx),
        draw: drawScore(horse, race, ctx),
        freshness: freshnessScore(horse),
        condition: conditionScore(horse)
      };

      var wsum = 0, acc = 0;
      FACTORS.forEach(function (f) {
        var s = factors[f.key] ? factors[f.key].score : 0.5;
        wsum += f.weight;
        acc += f.weight * s;
      });

      return {
        horse: horse,
        factors: factors,
        composite: acc / wsum
      };
    });

    /* softmax（数値安定のため最大値を引く） */
    var maxC = -Infinity;
    rows.forEach(function (r) { if (r.composite > maxC) maxC = r.composite; });

    var denom = 0;
    rows.forEach(function (r) {
      r.exp = Math.exp((r.composite - maxC) * opts.sharpness);
      denom += r.exp;
    });
    rows.forEach(function (r) { r.winProb = r.exp / denom; });

    /* 3着以内確率（複勝の期待値計算に使用） */
    var winProbs = rows.map(function (r) { return r.winProb; });
   var placeCount = horses.length >= 8 ? 3 : (horses.length >= 5 ? 2 : 0);
var placeProbs = placeCount > 0
  ? topKProbabilities(winProbs, placeCount)
  : winProbs.map(function () { return 0; });

    rows.forEach(function (r, i) {
      r.placeProb = clamp(placeProbs[i], 0, 1);
      r.horse = r.horse;
    });

    /* 順位付け */
    var sorted = rows.slice().sort(function (a, b) { return b.winProb - a.winProb; });
    sorted.forEach(function (r, i) { r.winRank = i + 1; });

    var p1 = sorted[0] ? sorted[0].winProb : 0;
    var p2 = sorted[1] ? sorted[1].winProb : 0;
    var confidence = clamp(0.34 + (p1 - p2) * 3.6 + (p1 - 0.16) * 1.2, 0.05, 0.95);

    var entries = sorted.map(function (r) {
      return {
        num: r.horse.num,
        frame: r.horse.frame,
        name: r.horse.name,
        sex: r.horse.sex,
        age: r.horse.age,
        weight: r.horse.weight,
        jockey: r.horse.jockey,
        trainer: r.horse.trainer,
        style: r.horse.style,
        odds: r.horse.odds,
        placeOdds: r.horse.placeOdds,
        popularity: r.horse.popularity,
        daysSinceLast: r.horse.daysSinceLast,
        bodyWeight: r.horse.bodyWeight,
        bodyWeightDiff: r.horse.bodyWeightDiff,
        recent: r.horse.recent,
        winProb: r.winProb,
        placeProb: r.placeProb,
        winRank: r.winRank,
        composite: r.composite,
        factors: r.factors
      };
    });

    var byNum = {};
    entries.forEach(function (e) { byNum[e.num] = e; });

    return {
      raceId: race.id,
      modelVersion: VERSION,
      computedAt: new Date().toISOString(),
      pace: ctx.pace,
      paceLabel: ctx.paceLabel,
      headCount: ctx.headCount,
      confidence: confidence,
      horses: entries,
      byNum: byNum,
      rank1: entries[0] || null,
      rank2: entries[1] || null,
      rank3: entries[2] || null,
      /** 3連複などに使う内部重み（勝率順） */
      weights: entries.map(function (e) { return e.winProb; }),
      indexByNum: (function () {
        var map = {};
        entries.forEach(function (e, i) { map[e.num] = i; });
        return map;
      })()
    };
  }

  /* ---------------------------------------------------------- */
  /* 根拠テキスト                                                */
  /* ---------------------------------------------------------- */

  var REASON_TEXT = {
    form: function (f) { return '近走の安定度が高い（' + f.note + '）'; },
    speed: function (f) { return '末脚の指数が上位（' + f.note + '）'; },
    distance: function (f) { return '距離適性が高い（' + f.note + '）'; },
    going: function (f) { return '当日の馬場と相性が良い（' + f.note + '）'; },
    pace: function (f) { return '想定展開が向く（' + f.note + '）'; },
    jockey: function (f) { return '騎手の勝率が高い（' + f.note + '）'; },
    impost: function (f) { return '斤量条件が有利（' + f.note + '）'; },
    draw: function (f) { return '枠順が有利（' + f.note + '）'; },
    freshness: function (f) { return '休養明けの状態が整っている（' + f.note + '）'; },
    condition: function (f) { return '馬体の仕上がりが良い（' + f.note + '）'; }
  };

  /**
   * その馬の「効いているファクター」を上位から返す。
   * contribution = weight × (score - 0.5) の大きさで並べる。
   */
  function topFactors(entry, limit) {
    var list = FACTORS.map(function (f) {
      var raw = entry.factors[f.key] || { score: 0.5, note: '' };
      return {
        key: f.key,
        label: f.label,
        weight: f.weight,
        score: raw.score,
        note: raw.note,
        contribution: f.weight * (raw.score - 0.5)
      };
    });

    list.sort(function (a, b) { return b.contribution - a.contribution; });
    return limit ? list.slice(0, limit) : list;
  }

  function reasonsFor(entry, limit) {
    return topFactors(entry, limit || 3)
      .filter(function (t) { return t.contribution > 0.004; })
      .map(function (t) { return REASON_TEXT[t.key](t); });
  }

  return {
    VERSION: VERSION,
    FACTORS: FACTORS,
    DEFAULTS: DEFAULTS,
    predictRace: predictRace,
    topFactors: topFactors,
    reasonsFor: reasonsFor,
    topKProbabilities: topKProbabilities,
    comboProbability: comboProbability,
    pctText: pctText,
    clamp: clamp
  };
});
