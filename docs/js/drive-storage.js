/**
 * drive-storage.js — Client-side HTML5 Canvas Compression, Google Drive Direct
 * Upload via Apps Script OAuth Token Provider, and Legacy/New Drive Media URLs.
 */
(function (global) {
  'use strict';

  var cachedOAuthToken = '';
  var cachedTokenExpiresAtMs = 0;
  var inFlightTokenPromise = null;
  var pendingUploadBlobs = Object.create(null);
  var pendingBlobSeq = 0;
  var DIRECT_BLOB_PREFIX = '__PB_DIRECT_BLOB__:';

  async function fetchWithTimeout(url, options, timeoutMs) {
    var ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000;
    if (typeof AbortController !== 'function') {
      return fetch(url, options);
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      try { ctrl.abort(); } catch (e) {}
    }, ms);
    try {
      var opts = Object.assign({}, options || {}, { signal: ctrl.signal });
      return await fetch(url, opts);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('Request timed out after ' + Math.round(ms / 1000) + 's.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function registerPendingBlob(blob) {
    if (!(blob instanceof Blob)) return '';
    var now = Date.now();
    Object.keys(pendingUploadBlobs).forEach(function (k) {
      if (pendingUploadBlobs[k] && now - pendingUploadBlobs[k].createdAtMs > 600000) {
        delete pendingUploadBlobs[k];
      }
    });
    pendingBlobSeq += 1;
    var token = DIRECT_BLOB_PREFIX + now + '_' + pendingBlobSeq;
    pendingUploadBlobs[token] = { blob: blob, createdAtMs: now };
    return token;
  }

  function peekPendingBlob(tokenOrData) {
    var key = String(tokenOrData || '');
    if (key.indexOf(DIRECT_BLOB_PREFIX) !== 0) return null;
    var rec = pendingUploadBlobs[key];
    return rec && rec.blob instanceof Blob ? rec.blob : null;
  }

  function consumePendingBlob(tokenOrData) {
    var key = String(tokenOrData || '');
    if (key.indexOf(DIRECT_BLOB_PREFIX) !== 0) return null;
    var rec = pendingUploadBlobs[key];
    delete pendingUploadBlobs[key];
    return rec && rec.blob instanceof Blob ? rec.blob : null;
  }

  function getCfg() {
    return global.PB_CONFIG && typeof global.PB_CONFIG === 'object' ? global.PB_CONFIG : {};
  }

  function isConfiguredValue(val) {
    var s = String(val || '').trim();
    return Boolean(s && s.indexOf('PASTE_') !== 0 && s.indexOf('REPLACE_') !== 0);
  }

  /**
   * Extracts a clean Google Drive file ID from a raw ID, webViewLink, or drive URL.
   */
  function extractGoogleDriveFileId(input) {
    var raw = String(input || '').trim();
    if (!raw) return '';
    if (/^[A-Za-z0-9_-]{12,120}$/.test(raw)) {
      return raw;
    }
    var mPath = raw.match(/\/file\/d\/([A-Za-z0-9_-]{10,120})/i);
    if (mPath && mPath[1]) return mPath[1];
    var mLh3 = raw.match(/googleusercontent\.com\/d\/([A-Za-z0-9_-]{10,120})/i);
    if (mLh3 && mLh3[1]) return mLh3[1];
    var mQuery = raw.match(/[?&]id=([A-Za-z0-9_-]{10,120})/i);
    if (mQuery && mQuery[1]) return mQuery[1];
    return raw;
  }

  /**
   * Converts any Google Drive file ID or `webViewLink` into a direct image URL
   * (`https://lh3.googleusercontent.com/d/<drive_file_id>`) so both legacy imported
   * files and newly uploaded files render smoothly on GitHub Pages.
   */
  function getGoogleDriveImageUrl(driveFileIdOrUrl, opt_widthPx) {
    var driveId = extractGoogleDriveFileId(driveFileIdOrUrl);
    if (!driveId) return '';
    var w = Number(opt_widthPx || 0);
    if (isFinite(w) && w > 0) {
      return 'https://lh3.googleusercontent.com/d/' + encodeURIComponent(driveId) + '=w' + Math.round(w);
    }
    return 'https://lh3.googleusercontent.com/d/' + encodeURIComponent(driveId);
  }

  function getGoogleDriveThumbnailUrl(driveFileIdOrUrl, opt_widthPx) {
    var driveId = extractGoogleDriveFileId(driveFileIdOrUrl);
    if (!driveId) return '';
    var w = isFinite(Number(opt_widthPx)) && Number(opt_widthPx) > 0 ? Math.round(Number(opt_widthPx)) : 1600;
    return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(driveId) + '&sz=w' + w;
  }

  function getGoogleDrivePreviewUrl(driveFileIdOrUrl) {
    var driveId = extractGoogleDriveFileId(driveFileIdOrUrl);
    if (!driveId) return '';
    return 'https://drive.google.com/file/d/' + encodeURIComponent(driveId) + '/preview';
  }

  async function computeSha256HexFromBlob(blob) {
    try {
      var buf = await blob.arrayBuffer();
      if (global.crypto && global.crypto.subtle && typeof global.crypto.subtle.digest === 'function') {
        var hashBuf = await global.crypto.subtle.digest('SHA-256', buf);
        var bytes = new Uint8Array(hashBuf);
        var hex = [];
        for (var i = 0; i < bytes.length; i++) {
          hex.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16));
        }
        return hex.join('');
      }
      // Deterministic non-empty fallback digest when crypto.subtle is unavailable on insecure origins
      var arr = new Uint8Array(buf);
      var h1 = 0x811c9dc5;
      for (var j = 0; j < arr.length; j++) {
        h1 ^= arr[j];
        h1 = Math.imul(h1, 0x01000193);
      }
      return ('fallback_' + (h1 >>> 0).toString(16) + '_' + String(arr.length)).padEnd(64, '0').slice(0, 64);
    } catch (e) {
      return '0'.repeat(64);
    }
  }

  function loadImageFromBlobFallback(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function (err) {
        URL.revokeObjectURL(url);
        reject(err || new Error('Failed to decode image for Canvas compression.'));
      };
      img.src = url;
    });
  }

  /**
   * Compresses JPG/PNG images in-browser via HTML5 Canvas (max width 1280px, quality 0.8)
   * prior to direct Google Drive upload.
   */
  async function compressImageWithCanvas(fileObj, opt_opts) {
    if (!fileObj) throw new Error('File is required for compression.');
    var opts = opt_opts && typeof opt_opts === 'object' ? opt_opts : {};
    var cfg = getCfg();
    var maxWidth = Number(opts.maxWidth || cfg.IMAGE_MAX_WIDTH || 1280);
    var quality = Number(opts.quality || cfg.IMAGE_QUALITY || 0.8);

    var rawMime = String(fileObj.type || '').toLowerCase();
    if (rawMime === 'image/jpg') rawMime = 'image/jpeg';
    if (!rawMime && /\.jpe?g$/i.test(fileObj.name || '')) rawMime = 'image/jpeg';
    if (!rawMime && /\.png$/i.test(fileObj.name || '')) rawMime = 'image/png';
    if (!rawMime && /\.webp$/i.test(fileObj.name || '')) rawMime = 'image/webp';
    if (!rawMime && /\.gif$/i.test(fileObj.name || '')) rawMime = 'image/gif';
    if (!rawMime && /\.pdf$/i.test(fileObj.name || '')) rawMime = 'application/pdf';

    var originalName = String(fileObj.name || 'upload.bin').trim();
    var isCompressibleRaster =
      rawMime === 'image/jpeg' || rawMime === 'image/png' || rawMime === 'image/webp';

    if (!isCompressibleRaster || typeof document === 'undefined') {
      var passthroughHash = await computeSha256HexFromBlob(fileObj);
      return {
        blob: fileObj,
        mimeType: rawMime || 'application/octet-stream',
        originalFilename: originalName,
        sizeBytes: fileObj.size || 0,
        sha256Hex: passthroughHash,
        wasCompressed: false
      };
    }

    try {
      var source = null;
      var srcW = 0;
      var srcH = 0;
      if (typeof global.createImageBitmap === 'function') {
        source = await global.createImageBitmap(fileObj);
        srcW = source.width || 0;
        srcH = source.height || 0;
      } else {
        source = await loadImageFromBlobFallback(fileObj);
        srcW = source.naturalWidth || source.width || 0;
        srcH = source.naturalHeight || source.height || 0;
      }

      if (!srcW || !srcH) {
        if (source && typeof source.close === 'function') source.close();
        var fallbackHash = await computeSha256HexFromBlob(fileObj);
        return {
          blob: fileObj,
          mimeType: rawMime,
          originalFilename: originalName,
          sizeBytes: fileObj.size || 0,
          sha256Hex: fallbackHash,
          wasCompressed: false
        };
      }

      var scale = srcW > maxWidth ? maxWidth / srcW : 1;
      var targetW = Math.max(1, Math.round(srcW * scale));
      var targetH = Math.max(1, Math.round(srcH * scale));

      var canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      var ctx = canvas.getContext('2d');
      if (!ctx || typeof canvas.toBlob !== 'function') {
        if (source && typeof source.close === 'function') source.close();
        var noCtxHash = await computeSha256HexFromBlob(fileObj);
        return {
          blob: fileObj,
          mimeType: rawMime,
          originalFilename: originalName,
          sizeBytes: fileObj.size || 0,
          sha256Hex: noCtxHash,
          wasCompressed: false
        };
      }

      ctx.drawImage(source, 0, 0, targetW, targetH);
      if (source && typeof source.close === 'function') source.close();

      var outBlob = await new Promise(function (resolve) {
        canvas.toBlob(resolve, rawMime, quality);
      });

      var finalBlob =
        outBlob && outBlob.size > 0 && (outBlob.size < fileObj.size || srcW > maxWidth)
          ? outBlob
          : fileObj;

      var finalHash = await computeSha256HexFromBlob(finalBlob);
      return {
        blob: finalBlob,
        mimeType: finalBlob.type || rawMime,
        originalFilename: originalName,
        sizeBytes: finalBlob.size,
        sha256Hex: finalHash,
        wasCompressed: finalBlob !== fileObj
      };
    } catch (compressErr) {
      var errHash = await computeSha256HexFromBlob(fileObj);
      return {
        blob: fileObj,
        mimeType: rawMime,
        originalFilename: originalName,
        sizeBytes: fileObj.size || 0,
        sha256Hex: errHash,
        wasCompressed: false
      };
    }
  }

  /**
   * Fetches a short-lived Google OAuth access token via HTTP GET from the standalone
   * `gas-token-provider` Google Apps Script Web App.
   */
  async function fetchDriveOAuthToken(opt_forceRefresh) {
    if (!opt_forceRefresh && cachedOAuthToken && Date.now() < cachedTokenExpiresAtMs) {
      return cachedOAuthToken;
    }
    if (!opt_forceRefresh && inFlightTokenPromise) {
      return inFlightTokenPromise;
    }

    var cfg = getCfg();
    var tokenUrl = String(cfg.GAS_TOKEN_WEBAPP_URL || '').trim();
    var secretKey = String(cfg.GAS_SECRET_KEY || '').trim();
    if (!isConfiguredValue(tokenUrl)) {
      throw new Error('GAS_TOKEN_WEBAPP_URL is not configured in docs/js/config.js.');
    }
    if (!isConfiguredValue(secretKey)) {
      throw new Error('GAS_SECRET_KEY is not configured in docs/js/config.js.');
    }

    var sep = tokenUrl.indexOf('?') === -1 ? '?' : '&';
    var fullUrl = tokenUrl + sep + 'secret=' + encodeURIComponent(secretKey);

    inFlightTokenPromise = fetchWithTimeout(
      fullUrl,
      {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow'
      },
      25000
    )
      .then(function (res) {
        if (!res.ok) {
          throw new Error('Token provider responded with HTTP ' + res.status + '.');
        }
        return res.json();
      })
      .then(function (json) {
        inFlightTokenPromise = null;
        if (!json || !json.token) {
          throw new Error(
            (json && json.error) || 'Token provider did not return an OAuth token.'
          );
        }
        cachedOAuthToken = String(json.token).trim();
        var ttlSec = Math.max(300, Math.min(3300, Number(json.expiresInSeconds || 2400)));
        cachedTokenExpiresAtMs = Date.now() + ttlSec * 1000;
        return cachedOAuthToken;
      })
      .catch(function (err) {
        inFlightTokenPromise = null;
        throw err;
      });

    return inFlightTokenPromise;
  }

  function buildDriveMultipartBlob(metadataObj, fileBlob) {
    var boundary = 'pb_drive_boundary_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    var preamble =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadataObj) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: ' + (metadataObj.mimeType || 'application/octet-stream') + '\r\n\r\n';
    var epilogue = '\r\n--' + boundary + '--\r\n';
    return {
      contentType: 'multipart/related; boundary=' + boundary,
      body: new Blob([preamble, fileBlob, epilogue], { type: 'multipart/related; boundary=' + boundary })
    };
  }

  /**
   * Uploads a raw (or Canvas-compressed) File/Blob directly from the browser to
   * Google Drive REST API v3 using the OAuth token from `gas-token-provider`.
   */
  async function uploadFileDirectToDrive(fileOrBlob, opt_meta) {
    var cfg = getCfg();
    var folderId = String(cfg.GOOGLE_DRIVE_FOLDER_ID || '').trim();
    if (!isConfiguredValue(folderId)) {
      throw new Error('GOOGLE_DRIVE_FOLDER_ID is not configured in docs/js/config.js.');
    }

    var meta = opt_meta && typeof opt_meta === 'object' ? opt_meta : {};
    var prepared = fileOrBlob instanceof Blob && meta.skipCompression
      ? {
          blob: fileOrBlob,
          mimeType: meta.mimeType || fileOrBlob.type || 'application/octet-stream',
          originalFilename: meta.originalFilename || fileOrBlob.name || 'upload.bin',
          sizeBytes: fileOrBlob.size || 0,
          sha256Hex: meta.sha256Hex || (await computeSha256HexFromBlob(fileOrBlob))
        }
      : await compressImageWithCanvas(fileOrBlob, {
          maxWidth: meta.maxWidth,
          quality: meta.quality
        });

    var finalName = meta.storageFilename || meta.originalFilename || prepared.originalFilename;
    var finalMime = meta.mimeType || prepared.mimeType;

    async function doUploadWithToken(token) {
      var driveMeta = {
        name: finalName,
        mimeType: finalMime,
        parents: [folderId]
      };
      var multipart = buildDriveMultipartBlob(driveMeta, prepared.blob);
      var uploadEndpoint =
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart' +
        '&fields=id,name,mimeType,size,webViewLink,webContentLink&supportsAllDrives=true';

      return fetchWithTimeout(
        uploadEndpoint,
        {
          method: 'POST',
          mode: 'cors',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': multipart.contentType
          },
          body: multipart.body
        },
        120000
      );
    }

    var token = await fetchDriveOAuthToken(false);
    var res = await doUploadWithToken(token);
    if (res.status === 401) {
      token = await fetchDriveOAuthToken(true);
      res = await doUploadWithToken(token);
    }

    if (!res.ok) {
      var errTxt = '';
      try { errTxt = await res.text(); } catch (e) {}
      throw new Error('Google Drive direct upload failed (HTTP ' + res.status + '): ' + errTxt.slice(0, 300));
    }

    var driveFile = await res.json();
    if (!driveFile || !driveFile.id) {
      throw new Error('Google Drive upload succeeded but returned no file ID.');
    }

    // Grant viewer-by-link permission if configured so direct image URLs render seamlessly
    if (cfg.DRIVE_SET_ANYONE_READER !== false) {
      try {
        await fetchWithTimeout(
          'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(driveFile.id) + '/permissions?supportsAllDrives=true',
          {
            method: 'POST',
            mode: 'cors',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ role: 'reader', type: 'anyone' })
          },
          12000
        );
      } catch (ignorePermErr) {}
    }

    return {
      driveFileId: driveFile.id,
      name: driveFile.name || finalName,
      originalFilename: prepared.originalFilename,
      mimeType: driveFile.mimeType || finalMime,
      sizeBytes: Number(driveFile.size || prepared.sizeBytes || 0),
      sha256Hex: prepared.sha256Hex,
      webViewLink: driveFile.webViewLink || ('https://drive.google.com/file/d/' + encodeURIComponent(driveFile.id) + '/view'),
      webContentLink: driveFile.webContentLink || '',
      directImageUrl: getGoogleDriveImageUrl(driveFile.id),
      blob: prepared.blob
    };
  }

  /**
   * Fetches binary file bytes from Google Drive REST API v3 (`?alt=media`)
   * using the Apps Script OAuth token (used for PDFs and private/legacy Drive files).
   */
  async function downloadDriveFileBlobAuthorized(driveFileId) {
    var cleanId = extractGoogleDriveFileId(driveFileId);
    if (!cleanId) {
      throw new Error('Missing Google Drive file ID.');
    }
    var mediaUrl = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(cleanId) + '?alt=media&supportsAllDrives=true';
    var token = await fetchDriveOAuthToken(false);
    var res = await fetchWithTimeout(
      mediaUrl,
      {
        method: 'GET',
        mode: 'cors',
        headers: { Authorization: 'Bearer ' + token }
      },
      60000
    );
    if (res.status === 401) {
      token = await fetchDriveOAuthToken(true);
      res = await fetchWithTimeout(
        mediaUrl,
        {
          method: 'GET',
          mode: 'cors',
          headers: { Authorization: 'Bearer ' + token }
        },
        60000
      );
    }
    if (!res.ok) {
      throw new Error('Failed to fetch file from Google Drive (HTTP ' + res.status + ').');
    }
    var blob = await res.blob();
    return {
      blob: blob,
      mimeType: blob.type || res.headers.get('Content-Type') || 'application/octet-stream',
      sizeBytes: blob.size || 0
    };
  }

  global.getGoogleDriveImageUrl = getGoogleDriveImageUrl;
  global.PB_DRIVE = Object.freeze({
    DIRECT_BLOB_PREFIX: DIRECT_BLOB_PREFIX,
    extractGoogleDriveFileId: extractGoogleDriveFileId,
    getGoogleDriveImageUrl: getGoogleDriveImageUrl,
    getGoogleDriveThumbnailUrl: getGoogleDriveThumbnailUrl,
    getGoogleDrivePreviewUrl: getGoogleDrivePreviewUrl,
    compressImageWithCanvas: compressImageWithCanvas,
    registerPendingBlob: registerPendingBlob,
    peekPendingBlob: peekPendingBlob,
    consumePendingBlob: consumePendingBlob,
    fetchDriveOAuthToken: fetchDriveOAuthToken,
    uploadFileDirectToDrive: uploadFileDirectToDrive,
    downloadDriveFileBlobAuthorized: downloadDriveFileBlobAuthorized,
    isConfigured: function () {
      var c = getCfg();
      return (
        isConfiguredValue(c.GAS_TOKEN_WEBAPP_URL) &&
        isConfiguredValue(c.GAS_SECRET_KEY) &&
        isConfiguredValue(c.GOOGLE_DRIVE_FOLDER_ID)
      );
    }
  });
})(window);
