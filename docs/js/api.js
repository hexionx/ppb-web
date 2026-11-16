/**
 * api.js — Supabase + Direct Google Drive RPC Shim for Pattanabhumi Biology LMS
 *
 * Keeps the drop-in `google.script.run.withSuccessHandler(...).withFailureHandler(...).rpcDispatch(envelope)`
 * contract so `js/app.js` UI/forms/queueing remain 100% unchanged, while routing every RPC action directly to
 * `window.PBSupabaseBackend.dispatch(envelope)` instead of Google Apps Script Sheets `doPost`.
 */
(function () {
  'use strict';

  function getConfig() {
    return window.PB_CONFIG && typeof window.PB_CONFIG === 'object' ? window.PB_CONFIG : {};
  }

  function isValueConfigured(val) {
    var s = String(val || '').trim();
    return Boolean(s && s.indexOf('PASTE_') !== 0 && s.indexOf('REPLACE_') !== 0);
  }

  function isSupabaseConfigured() {
    var cfg = getConfig();
    return isValueConfigured(cfg.SUPABASE_URL) && isValueConfigured(cfg.SUPABASE_ANON_KEY);
  }

  function isDriveConfigured() {
    var cfg = getConfig();
    return (
      isValueConfigured(cfg.GAS_TOKEN_WEBAPP_URL) &&
      isValueConfigured(cfg.GAS_SECRET_KEY) &&
      isValueConfigured(cfg.GOOGLE_DRIVE_FOLDER_ID)
    );
  }

  function getApiUrl() {
    var cfg = getConfig();
    return isValueConfigured(cfg.SUPABASE_URL) ? String(cfg.SUPABASE_URL).trim() : '';
  }

  function asyncCall(fn, arg, userObj) {
    if (typeof fn !== 'function') return;
    setTimeout(function () {
      if (userObj !== undefined) {
        fn(arg, userObj);
      } else {
        fn(arg);
      }
    }, 0);
  }

  function invokeRpc(envelope, onSuccess, onFailure, userObj) {
    if (!window.PBSupabaseBackend || typeof window.PBSupabaseBackend.dispatch !== 'function') {
      asyncCall(
        onFailure,
        new Error('Supabase backend layer (js/supabase-backend.js) is not loaded.'),
        userObj
      );
      return;
    }

    try {
      Promise.resolve(window.PBSupabaseBackend.dispatch(envelope)).then(
        function (res) {
          asyncCall(onSuccess, res, userObj);
        },
        function (err) {
          asyncCall(
            onFailure,
            err instanceof Error ? err : new Error(String((err && err.message) || err || 'Request failed')),
            userObj
          );
        }
      );
    } catch (syncErr) {
      asyncCall(
        onFailure,
        syncErr instanceof Error ? syncErr : new Error(String(syncErr || 'Dispatch error')),
        userObj
      );
    }
  }

  /** Immutable runner mirroring google.script.run chaining semantics. */
  function createRunner(onSuccess, onFailure, userObj) {
    return {
      withSuccessHandler: function (fn) {
        return createRunner(fn, onFailure, userObj);
      },
      withFailureHandler: function (fn) {
        return createRunner(onSuccess, fn, userObj);
      },
      withUserObject: function (obj) {
        return createRunner(onSuccess, onFailure, obj);
      },
      rpcDispatch: function (envelope) {
        invokeRpc(envelope, onSuccess, onFailure, userObj);
      }
    };
  }

  var isRealAppsScriptBridge =
    typeof window.google === 'object' &&
    window.google &&
    window.google.script &&
    window.google.script.run &&
    typeof window.google.script.run.withSuccessHandler === 'function';

  if (!isRealAppsScriptBridge) {
    window.google = window.google || {};
    window.google.script = window.google.script || {};
    window.google.script.run = createRunner(null, null, undefined);
  }

  window.PB_API = {
    mode: 'SUPABASE_DIRECT_DRIVE',
    getApiUrl: getApiUrl,
    isConfigured: isSupabaseConfigured,
    isDriveConfigured: isDriveConfigured,
    dispatchDirect: function (envelope) {
      return window.PBSupabaseBackend.dispatch(envelope);
    }
  };

  if (!isSupabaseConfigured() && window.console && console.warn) {
    console.warn(
      '[PB] PB_CONFIG.SUPABASE_URL or PB_CONFIG.SUPABASE_ANON_KEY is still a placeholder in js/config.js. Follow MIGRATION_GUIDE.md.'
    );
  }
})();
