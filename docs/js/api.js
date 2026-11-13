/**
 * api.js — fetch() transport shim for running the Pattanabhumi Biology client
 * outside Google Apps Script HtmlService (e.g. on GitHub Pages).
 *
 * The original client (js/app.js, generated from ClientCore.html) talks to the
 * backend exclusively through:
 *
 *   google.script.run
 *     .withSuccessHandler(fn)
 *     .withFailureHandler(fn)
 *     .rpcDispatch(envelope);
 *
 * This file provides a drop-in `google.script.run` object with the same chaining
 * semantics, but delivers the envelope to the Apps Script Web App's `doPost`
 * (backend/Api.gs) via fetch(). Queueing, de-duplication, retries and error
 * mapping all remain in app.js, unchanged.
 *
 * Transport details:
 * - Content-Type is text/plain so the request is a CORS "simple request"
 *   (no OPTIONS preflight, which Apps Script cannot answer).
 * - Apps Script answers with a 302 to script.googleusercontent.com, which fetch
 *   follows automatically; that response carries Access-Control-Allow-Origin: *.
 * - No cookies are sent (credentials: 'omit'); auth uses the session token that
 *   app.js already places inside the envelope.
 */
(function () {
  'use strict';

  var PLACEHOLDER_PREFIX = 'PASTE_';
  var DEFAULT_TIMEOUT_MS = 6.5 * 60 * 1000; // Apps Script max execution is 6 minutes.

  function getConfig() {
    return window.PB_CONFIG && typeof window.PB_CONFIG === 'object' ? window.PB_CONFIG : {};
  }

  function getApiUrl() {
    var url = String(getConfig().API_URL || '').trim();
    if (!url || url.indexOf(PLACEHOLDER_PREFIX) === 0) return '';
    return url;
  }

  function asyncCall(fn, arg) {
    if (typeof fn !== 'function') return;
    setTimeout(function () {
      fn(arg);
    }, 0);
  }

  function invokeRpc(envelope, onSuccess, onFailure) {
    var url = getApiUrl();
    if (!url) {
      asyncCall(
        onFailure,
        new Error(
          'Backend API URL is not configured. Set PB_CONFIG.API_URL in js/config.js to your Apps Script Web App /exec URL.'
        )
      );
      return;
    }

    var body;
    try {
      body = JSON.stringify(envelope === undefined ? null : envelope);
    } catch (serializeErr) {
      asyncCall(onFailure, new Error('Could not serialize request: ' + serializeErr.message));
      return;
    }

    var timeoutMs = Number(getConfig().REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller
      ? setTimeout(function () {
          controller.abort();
        }, timeoutMs)
      : null;

    fetch(url, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('Backend responded with HTTP ' + res.status + '.');
        }
        return res.text();
      })
      .then(function (text) {
        try {
          return JSON.parse(text);
        } catch (parseErr) {
          throw new Error(
            'Backend returned a non-JSON response. Check that the Apps Script deployment is a Web App with access "Anyone" and that API_URL ends in /exec.'
          );
        }
      })
      .then(
        function (data) {
          if (timer) clearTimeout(timer);
          asyncCall(onSuccess, data);
        },
        function (err) {
          if (timer) clearTimeout(timer);
          var msg =
            err && err.name === 'AbortError'
              ? 'Request timed out after ' + Math.round(timeoutMs / 1000) + ' seconds.'
              : err && err.message
              ? err.message
              : String(err || 'Network error');
          asyncCall(onFailure, new Error(msg));
        }
      );
  }

  /** Immutable runner mirroring google.script.run chaining semantics. */
  function createRunner(onSuccess, onFailure) {
    return {
      withSuccessHandler: function (fn) {
        return createRunner(fn, onFailure);
      },
      withFailureHandler: function (fn) {
        return createRunner(onSuccess, fn);
      },
      withUserObject: function () {
        return createRunner(onSuccess, onFailure);
      },
      rpcDispatch: function (envelope) {
        invokeRpc(envelope, onSuccess, onFailure);
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
    window.google.script.run = createRunner(null, null);
  }

  window.PB_API = {
    getApiUrl: getApiUrl,
    isConfigured: function () {
      return Boolean(getApiUrl());
    }
  };

  if (!getApiUrl() && window.console && console.warn) {
    console.warn('[PB] PB_CONFIG.API_URL is not set in js/config.js; backend calls will fail.');
  }
})();
