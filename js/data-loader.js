/*!
 * RaceAI / js/data-loader.js
 * ------------------------------------------------------------
 * データ取得と「取得状態」の管理。
 *
 * ■ 実装している範囲
 *   ・data/demo-races.json を fetch で読み込む（デモデータ）
 *   ・取得日時・取得経路・所要時間・失敗理由を記録する
 *   ・失敗時は「前回データ」と「最新データ」を混同しないよう状態を分ける
 *
 * ■ 実装していない範囲（未接続）
 *   ・JRA / 地方競馬(NAR) の出馬表・オッズ・結果APIへの接続
 *   ・スクレイピング、認証、課金API
 *   → fetchLiveRaces() は必ず NOT_IMPLEMENTED で reject します。
 *      「取得できた」と偽ることはありません。
 * ------------------------------------------------------------
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RaceAIDataLoader = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONFIG = {
    demoPath: 'data/demo-races.json',
    /* 実データのエンドポイント。未契約・未実装のため null 固定。 */
    liveEndpoint: null,
    timeoutMs: 8000,
    storageKey: 'raceai.snapshot.v1',
    maxAttempts: 6
  };

  var STATUS = {
    IDLE: 'idle',
    LOADING: 'loading',
    READY: 'ready',
    STALE: 'stale',
    ERROR: 'error'
  };

  var state = {
    status: STATUS.IDLE,
    dataset: null,
    source: null,          /* 'demo' | 'live' */
    transport: null,       /* 'network' | 'sw-cache' */
    fetchedAt: null,       /* この端末が取得した時刻 */
    generatedAt: null,     /* データ自体の生成時刻 */
    elapsedMs: null,
    error: null,
    fromCache: false,
    cachedAt: null,
    attempts: []
  };

  function now() { return new Date(); }

  function iso(d) { return d ? d.toISOString() : null; }

  function log(message) {
    if (typeof console !== 'undefined' && console.info) {
      console.info('[RaceAI/data] ' + message);
    }
  }

  function record(ok, detail) {
    state.attempts.unshift({
      at: iso(now()),
      ok: ok,
      detail: detail
    });
    if (state.attempts.length > CONFIG.maxAttempts) state.attempts.pop();
  }

  /* ---------------------------------------------------------- */
  /* 検証（壊れたJSONを"正常"として扱わない）                     */
  /* ---------------------------------------------------------- */

  function validate(data) {
    var errors = [];
    if (!data || typeof data !== 'object') errors.push('ルートがオブジェクトではありません');
    if (data && !data.dataset) errors.push('dataset メタ情報がありません');
    if (data && !Array.isArray(data.meetings)) errors.push('meetings が配列ではありません');
    if (data && !Array.isArray(data.races)) errors.push('races が配列ではありません');

    if (!errors.length) {
      data.races.forEach(function (race) {
        if (!race.id) errors.push('race.id が空です');
        if (!Array.isArray(race.horses) || !race.horses.length) {
          errors.push('出走馬が空です: ' + (race.id || '(id不明)'));
        }
      });
      if (!data.races.length) errors.push('レースが1件もありません');
    }

    if (errors.length) {
      var err = new Error('データ検証に失敗しました: ' + errors.slice(0, 3).join(' / '));
      err.code = 'INVALID_DATASET';
      err.details = errors;
      throw err;
    }
    return true;
  }

  /* ---------------------------------------------------------- */
  /* デモデータ取得                                              */
  /* ---------------------------------------------------------- */

  function fetchDemoRaces(options) {
    var opts = options || {};
    var url = CONFIG.demoPath;

    /* 動作確認用: ?fail=1 で取得失敗を再現できる */
    if (opts.forceFail) {
      return Promise.reject(Object.assign(
        new Error('取得失敗の再現モード（?fail=1）が有効です'),
        { code: 'SIMULATED_FAILURE' }
      ));
    }

    var started = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, CONFIG.timeoutMs);

    return fetch(url, {
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
      headers: { 'Accept': 'application/json' }
    }).then(function (res) {
      clearTimeout(timer);

      var viaSwCache = res.headers.get('X-RaceAI-Cache');
      if (!res.ok) {
        var e = new Error('HTTP ' + res.status + ' ' + (res.statusText || ''));
        e.code = 'HTTP_ERROR';
        e.status = res.status;
        e.viaSwCache = viaSwCache;
        throw e;
      }

      return res.json().then(function (json) {
        validate(json);
        var ended = (typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now();

        return {
          data: json,
          transport: viaSwCache === 'stale' ? 'sw-cache' : 'network',
          fromCache: viaSwCache === 'stale',
          cachedAt: res.headers.get('X-RaceAI-Cached-At'),
          elapsedMs: Math.round(ended - started)
        };
      });
    }).catch(function (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        var e = new Error('取得がタイムアウトしました（' + CONFIG.timeoutMs + 'ms）');
        e.code = 'TIMEOUT';
        throw e;
      }
      if (err && err.code) throw err;

      /* fetch 自体が失敗（file:// で開いた場合もここに来る） */
      var e = new Error(
        'デモデータを取得できませんでした。ローカルサーバー経由で開いてください（file:// では fetch がブロックされます）'
      );
      e.code = 'NETWORK_ERROR';
      e.cause = err && err.message ? err.message : String(err);
      throw e;
    });
  }

  /* ---------------------------------------------------------- */
  /* 実データ（未接続であることを明示する）                       */
  /* ---------------------------------------------------------- */

  function fetchLiveRaces() {
    var err = new Error(
      '実データ取得は未実装です。JRA・地方競馬(NAR)の出馬表／オッズ／結果APIは接続していません。'
    );
    err.code = 'NOT_IMPLEMENTED';
    return Promise.reject(err);
  }

  function liveAvailability() {
    return [
      {
        id: 'schedule',
        label: '開催日程・競馬場',
        provider: 'JRA / 地方競馬(NAR)',
        status: 'not_connected',
        note: '公式サイトの構造変更に追随する実装が必要'
      },
      {
        id: 'entries',
        label: '出馬表（出走馬・枠順・斤量）',
        provider: 'JRA / 地方競馬(NAR)',
        status: 'not_connected',
        note: '著作権・利用規約の確認が必要'
      },
      {
        id: 'odds',
        label: '単勝・複勝オッズ',
        provider: 'オッズ配信事業者',
        status: 'not_connected',
        note: 'リアルタイム配信は契約が必要'
      },
      {
        id: 'result',
        label: 'レース結果（着順・払戻）',
        provider: 'JRA / 地方競馬(NAR)',
        status: 'not_connected',
        note: 'バックテストの実績化に必要'
      }
    ];
  }

  /* ---------------------------------------------------------- */
  /* 公開API                                                     */
  /* ---------------------------------------------------------- */

  function snapshot() {
    return {
      status: state.status,
      source: state.source,
      transport: state.transport,
      fetchedAt: state.fetchedAt,
      generatedAt: state.generatedAt,
      elapsedMs: state.elapsedMs,
      error: state.error,
      fromCache: state.fromCache,
      cachedAt: state.cachedAt,
      attempts: state.attempts.slice(),
      hasData: !!state.dataset
    };
  }

  function persistMeta() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(CONFIG.storageKey, JSON.stringify({
        fetchedAt: state.fetchedAt,
        generatedAt: state.generatedAt,
        source: state.source
      }));
    } catch (e) { /* 容量不足などは無視（表示に影響しない） */ }
  }

  function readPersistedMeta() {
    try {
      if (typeof localStorage === 'undefined') return null;
      var raw = localStorage.getItem(CONFIG.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * デモデータを読み込む。
   * 失敗しても「前回のデータ」を最新として返すことはしない。
   * 呼び出し側は status を見て必ず分岐すること。
   */
  function load(options) {
    var opts = options || {};
    var previous = state.dataset;
    var previousFetchedAt = state.fetchedAt;

    state.status = STATUS.LOADING;
    state.error = null;

    return fetchDemoRaces({ forceFail: !!opts.forceFail }).then(function (result) {
      state.status = STATUS.READY;
      state.dataset = result.data;
      state.source = 'demo';
      state.transport = result.transport;
      state.fetchedAt = iso(now());
      state.generatedAt = result.data.dataset && result.data.dataset.generatedAt
        ? result.data.dataset.generatedAt
        : null;
      state.elapsedMs = result.elapsedMs;
      state.fromCache = result.fromCache;
      state.cachedAt = result.cachedAt;
      record(true, (result.fromCache ? 'キャッシュ応答 ' : 'ネットワーク ') + result.elapsedMs + 'ms');
      persistMeta();
      log('loaded demo dataset (' + result.transport + ', ' + result.elapsedMs + 'ms)');
      return snapshot();
    }).catch(function (err) {
      var isStale = err && err.viaSwCache === 'stale';

      state.status = isStale ? STATUS.STALE : STATUS.ERROR;
      state.error = {
        code: err.code || 'UNKNOWN',
        message: err.message || '不明なエラー',
        detail: err.cause || null
      };
      state.elapsedMs = null;

      if (isStale && previous) {
        /* キャッシュ由来のデータは"前回取得分"として保持する */
        state.dataset = previous;
        state.fromCache = true;
        state.cachedAt = previousFetchedAt;
      } else {
        state.dataset = opts.keepPrevious === false ? null : previous;
        state.fromCache = false;
      }

      record(false, state.error.code + ': ' + state.error.message);
      log('load failed: ' + state.error.code);
      return snapshot();
    });
  }

  return {
    CONFIG: CONFIG,
    STATUS: STATUS,
    load: load,
    fetchLiveRaces: fetchLiveRaces,
    liveAvailability: liveAvailability,
    validate: validate,
    snapshot: snapshot,
    readPersistedMeta: readPersistedMeta,
    getDataset: function () { return state.dataset; }
  };
});
