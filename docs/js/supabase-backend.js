/**
 * supabase-backend.js — Primary Supabase PostgreSQL Data Layer & Service Router
 *
 * Replaces Google Sheets + Google Apps Script RPC backend (`Code.gs` / `AdminService.gs` /
 * `PaymentService.gs` / `CalendarService.gs` / `DriveService.gs`) using:
 *   - PostgreSQL SECURITY DEFINER RPCs (`supabase.rpc('pb_...')`) for authentication,
 *     password hashing verification, single-device session kickout, privacy consent,
 *     and admin user/reset operations so `users.password_hash` is never sent to browsers.
 *   - Direct `@supabase/supabase-js` queries for LMS courses, settings/CMS, files,
 *     tuition invoices/payments, calendar events, and unavailability requests.
 *   - Client-side `window.PB_DRIVE` for Canvas image compression and direct Google
 *     Drive REST v3 uploads via the standalone `gas-token-provider` token endpoint.
 */
(function (global) {
  'use strict';

  var cachedSupabaseClient = null;
  var DOMAIN_EXAM_ACTIONS_PREFIX = /^(admin\.(stimuli|questions|exams|attempts|grading|results|integrity)\.|exams\.)/;

  function getCfg() {
    return global.PB_CONFIG && typeof global.PB_CONFIG === 'object' ? global.PB_CONFIG : {};
  }

  function isConfiguredStr(val) {
    var s = String(val || '').trim();
    return Boolean(s && s.indexOf('PASTE_') !== 0 && s.indexOf('REPLACE_') !== 0);
  }

  function getSupabase() {
    if (cachedSupabaseClient) return cachedSupabaseClient;
    var cfg = getCfg();
    var url = String(cfg.SUPABASE_URL || '')
      .trim()
      .replace(/\/rest\/v1\/?$/i, '')
      .replace(/\/+$/, '');
    var anonKey = String(cfg.SUPABASE_ANON_KEY || '').trim();
    if (!isConfiguredStr(url) || !isConfiguredStr(anonKey)) {
      throw pbError(
        'ERR_CONFIG_MISSING',
        'Supabase URL / Anon Key are not configured in docs/js/config.js. Follow MIGRATION_GUIDE.md to set SUPABASE_URL and SUPABASE_ANON_KEY.'
      );
    }
    if (!global.supabase || typeof global.supabase.createClient !== 'function') {
      throw pbError(
        'ERR_CONFIG_MISSING',
        '@supabase/supabase-js CDN library failed to load. Check network access or index.html script tag.'
      );
    }
    cachedSupabaseClient = global.supabase.createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });
    return cachedSupabaseClient;
  }

  function pbError(code, message, opt_fieldErrors) {
    var err = new Error(message || 'Request failed.');
    err.pbCode = code || 'ERR_INTERNAL';
    err.code = err.pbCode;
    err.isAppError = true;
    err.fieldErrors = opt_fieldErrors && typeof opt_fieldErrors === 'object' ? opt_fieldErrors : {};
    return err;
  }

  function unwrapRpcResult(res) {
    if (res && res.error) {
      throw pbError('ERR_INTERNAL', res.error.message || 'Supabase RPC execution failed.');
    }
    var payload = res ? res.data : null;
    if (payload && typeof payload === 'object' && payload.ok === false) {
      var eObj = payload.error || {};
      throw pbError(eObj.code || 'ERR_INTERNAL', eObj.message || 'RPC rejected request.', eObj.fieldErrors);
    }
    return payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')
      ? payload.data
      : payload;
  }

  function throwIfPgErr(res, opt_contextLabel) {
    if (res && res.error) {
      var code = res.error.code === '23505' ? 'ERR_VALIDATION_FAILED' : 'ERR_INTERNAL';
      throw pbError(
        code,
        (opt_contextLabel ? opt_contextLabel + ': ' : '') + (res.error.message || 'Database error.')
      );
    }
    return res ? res.data : null;
  }

  function nowUtcIso() {
    return new Date().toISOString();
  }

  function formatBangkokTimestamp(opt_dateOrIso, opt_onlyDate) {
    if (opt_dateOrIso === '') return '';
    var d = opt_dateOrIso ? new Date(opt_dateOrIso) : new Date();
    if (isNaN(d.getTime())) return '';
    try {
      var parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).formatToParts(d);
      var map = {};
      for (var i = 0; i < parts.length; i++) map[parts[i].type] = parts[i].value;
      var hh = map.hour === '24' ? '00' : map.hour;
      var ymd = map.year + '-' + map.month + '-' + map.day;
      if (opt_onlyDate) return ymd;
      return ymd + ' ' + hh + ':' + map.minute + ':' + map.second + ' ICT (UTC+07:00)';
    } catch (e) {
      return d.toISOString();
    }
  }

  function todayBangkokYmd() {
    return formatBangkokTimestamp(new Date(), true);
  }

  function genId(prefix) {
    var rnd = '';
    try {
      if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
        var bytes = new Uint8Array(12);
        global.crypto.getRandomValues(bytes);
        for (var i = 0; i < bytes.length; i++) {
          rnd += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        }
        return (prefix || 'id_') + rnd;
      }
    } catch (e) {}
    return (prefix || 'id_') + Math.random().toString(16).slice(2, 14) + Date.now().toString(16);
  }

  function cleanSingleLine(val, maxLen) {
    if (val === null || val === undefined) return '';
    var s = String(val).replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
    return maxLen && s.length > maxLen ? s.slice(0, maxLen) : s;
  }

  function parseJsonSafe(raw, fallback) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw.trim()) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function normalizeRichTextDoc(rawInput, fieldName, label, requireNonEmpty) {
    var doc = null;
    if (typeof rawInput === 'string') {
      var trimmed = rawInput.trim();
      if (trimmed.indexOf('{') === 0) {
        doc = parseJsonSafe(trimmed, null);
      }
      if (!doc) {
        doc = trimmed
          ? { schemaVersion: 'pb-richtext-v1', blocks: [{ type: 'paragraph', spans: [{ text: trimmed }] }] }
          : { schemaVersion: 'pb-richtext-v1', blocks: [] };
      }
    } else if (rawInput && typeof rawInput === 'object') {
      doc = rawInput;
    } else {
      doc = { schemaVersion: 'pb-richtext-v1', blocks: [] };
    }

    var blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
    var normBlocks = [];
    var textParts = [];

    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b || typeof b !== 'object') continue;
      var bt = String(b.type || 'paragraph').trim().toLowerCase();
      var normSpan = function (sp) {
        if (!sp || typeof sp !== 'object') return null;
        var txt = String(sp.text || '');
        var outSp = { text: txt };
        if (sp.bold) outSp.bold = true;
        if (sp.italic) outSp.italic = true;
        if (sp.underline) outSp.underline = true;
        if (sp.strike) outSp.strike = true;
        if (sp.sub) outSp.sub = true;
        if (sp.sup) outSp.sup = true;
        if (sp.size && sp.size !== 'base') outSp.size = String(sp.size);
        if (sp.color) outSp.color = String(sp.color);
        if (sp.link) outSp.link = String(sp.link);
        if (sp.linkUrl) outSp.link = String(sp.linkUrl);
        return (outSp.text || outSp.link) ? outSp : null;
      };
      if (bt === 'paragraph') {
        var spans = Array.isArray(b.spans) ? b.spans : (b.text ? [{ text: String(b.text) }] : []);
        var cleanSpans = [];
        for (var s = 0; s < spans.length; s++) {
          var cs = normSpan(spans[s]);
          if (cs) {
            if (cs.text) textParts.push(cs.text);
            cleanSpans.push(cs);
          }
        }
        if (cleanSpans.length > 0) normBlocks.push({ type: 'paragraph', spans: cleanSpans });
      } else if (bt === 'bullet_list' || bt === 'ordered_list') {
        var items = Array.isArray(b.items) ? b.items : [];
        var normItems = [];
        for (var li = 0; li < items.length; li++) {
          var rawLi = items[li];
          var arrSp = Array.isArray(rawLi)
            ? rawLi
            : (rawLi && typeof rawLi === 'object' && Array.isArray(rawLi.spans) ? rawLi.spans : [{ text: String(rawLi || '') }]);
          var cleanedLi = [];
          for (var j = 0; j < arrSp.length; j++) {
            var cs2 = normSpan(arrSp[j]);
            if (cs2) {
              if (cs2.text) textParts.push(cs2.text);
              cleanedLi.push(cs2);
            }
          }
          if (cleanedLi.length > 0) normItems.push({ type: 'list_item', spans: cleanedLi });
        }
        if (normItems.length > 0) normBlocks.push({ type: bt, items: normItems });
      } else if (bt === 'image_attachment') {
        var fid = cleanSingleLine(b.fileId, 64);
        if (fid) {
          var imgOut = {
            type: 'image_attachment',
            fileId: fid,
            altText: cleanSingleLine(b.altText, 240) || 'Image',
            caption: cleanSingleLine(b.caption, 240) || ''
          };
          if (b.widthPct !== undefined && b.widthPct !== '') {
            imgOut.widthPct = Math.min(100, Math.max(20, Math.round(Number(b.widthPct) || 100)));
          }
          normBlocks.push(imgOut);
          textParts.push('[Image: ' + imgOut.altText + ']');
        }
      } else if (bt === 'pdf_attachment') {
        var pfid = cleanSingleLine(b.fileId, 64);
        if (pfid) {
          var allowDl = !(b.allowDownload === false || String(b.allowDownload || '').toLowerCase() === 'false');
          var pdfOut = {
            type: 'pdf_attachment',
            fileId: pfid,
            title: cleanSingleLine(b.title || b.filename, 200) || 'PDF Document',
            allowDownload: allowDl
          };
          if (b.widthPct) pdfOut.widthPct = Math.min(100, Math.max(30, Math.round(Number(b.widthPct) || 100)));
          if (b.heightPx) pdfOut.heightPx = Math.min(900, Math.max(180, Math.round(Number(b.heightPx) || 420)));
          if (b.displayMode) pdfOut.displayMode = String(b.displayMode).toLowerCase();
          normBlocks.push(pdfOut);
          textParts.push('[PDF: ' + pdfOut.title + ']');
        }
      } else if (bt === 'table') {
        var headers = Array.isArray(b.headers) ? b.headers.slice(0, 12).map(function (h) { return String(h || ''); }) : [];
        var rows = Array.isArray(b.rows) ? b.rows.slice(0, 40).map(function (r) {
          return Array.isArray(r) ? r.slice(0, 12).map(function (c) { return String(c || ''); }) : [];
        }) : [];
        var tblCap = cleanSingleLine(b.caption, 240);
        normBlocks.push({ type: 'table', caption: tblCap, headers: headers, rows: rows });
        textParts.push('[Table: ' + (tblCap || (rows.length + ' rows')) + ']');
      }
    }

    var plain = textParts.join(' ').trim();
    if (requireNonEmpty && normBlocks.length === 0 && !plain) {
      var fe = {};
      fe[fieldName || 'content'] = (label || 'Content') + ' cannot be empty.';
      throw pbError('ERR_VALIDATION_FAILED', (label || 'Content') + ' cannot be empty.', fe);
    }

    return {
      doc: { schemaVersion: 'pb-richtext-v1', blocks: normBlocks },
      plainTextSummary: plain
    };
  }

  async function requireSession(sessionToken, allowedRoles) {
    var sb = getSupabase();
    var res = await sb.rpc('pb_validate_session', {
      p_session_token: sessionToken || '',
      p_allowed_roles: allowedRoles || ['STUDENT', 'ADMIN']
    });
    return unwrapRpcResult(res);
  }

  async function writeAuditEvent(actorUserId, actorRole, eventType, targetType, targetId, summaryObj) {
    try {
      var sb = getSupabase();
      await sb.from('audit_events').insert({
        audit_id: genId('aud_'),
        actor_user_id: actorUserId || 'SYSTEM',
        actor_role: actorRole || 'SYSTEM',
        event_type: eventType || 'EVENT',
        target_entity_type: targetType || 'System',
        target_entity_id: targetId || '',
        summary_json: summaryObj || {},
        created_at_utc: nowUtcIso()
      });
    } catch (ignoreAuditErr) {}
  }

  function calculateDekCohorts(opt_bangkokYear, opt_mode, opt_manualBase) {
    var yr = Number(opt_bangkokYear);
    if (!isFinite(yr) || yr < 2020 || yr > 2100) {
      yr = parseInt(todayBangkokYmd().slice(0, 4), 10) || 2026;
    }
    var mode = opt_mode === 'MANUAL_OVERRIDE' ? 'MANUAL_OVERRIDE' : 'AUTO_YEAR';
    var manual = Number(opt_manualBase);
    var firstDek = mode === 'MANUAL_OVERRIDE' && isFinite(manual) && manual >= 60 && manual <= 150
      ? Math.floor(manual)
      : 70 + (yr - 2026);
    var cohorts = ['DEK' + firstDek, 'DEK' + (firstDek + 1), 'DEK' + (firstDek + 2)];
    return {
      bangkokYear: yr,
      mode: mode,
      baseDekNumber: firstDek,
      cohorts: cohorts,
      staticGreetingText: 'Welcome, ' + cohorts[0] + ', ' + cohorts[1] + ' & ' + cohorts[2],
      ariaLabelText: 'Welcome, ' + cohorts[0] + ', ' + cohorts[1] + ', and ' + cohorts[2]
    };
  }

  function getDefaultPublicContent(dekCfg) {
    var em = '\u2014';
    return {
      dek: dekCfg || calculateDekCohorts(),
      hero: {
        eyebrow: 'Online Learning Platform ' + em + ' Asia/Bangkok (UTC+7)',
        title: 'Pattanabhumi Biology',
        lead: 'Welcome to the Pattanabhumi Biology online learning platform. We built this portal to give enrolled students a clear, organized, and distraction-free environment for mastering biology.'
      },
      benefits: {
        heading: 'A Better Way to Learn Biology',
        lead: 'Welcome to the Pattanabhumi Biology online learning platform. We built this portal to give enrolled students a clear, organized, and distraction-free environment for mastering biology.',
        subheading: 'Why Learn on This Platform',
        items: [
          { id: 'benefit-materials', icon: 'book-open', title: 'Centralized Course Materials', body: 'Access your reading materials, downloadable PDFs, and class resources in one organized place ' + em + ' no more searching through scattered chat messages or links.' },
          { id: 'benefit-progress', icon: 'clipboard-check', title: 'Clear Progress and Score Tracking', body: 'View course objectives, learning outcomes, assessment links, and your published scores so you always know how you are progressing.' },
          { id: 'benefit-recordings', icon: 'video-play', title: 'Recorded Classes and Lesson Documents', body: 'Review class recordings at your own pace, complete with supporting documents listed right below each video lesson.' },
          { id: 'benefit-payments', icon: 'credit-card', title: 'Simple, Transparent Tuition Payments', body: 'Check your tuition installments, pay securely via PromptPay QR or bank transfer, upload payment slips, and track verification status step by step.' },
          { id: 'benefit-calendar', icon: 'calendar', title: 'Class Calendar and Schedule Support', body: 'Stay up to date with upcoming classes in Bangkok time and easily report unavailability when you need to notify the school in advance.' }
        ],
        securityCallout: {
          title: 'Built with Security and Privacy in Mind',
          body: 'Access to courses, learning documents, recordings, scores, and payment records is strictly reserved for enrolled students. Each student signs in with a personal account issued by the school.'
        }
      },
      howToLogIn: {
        heading: 'How to Log In',
        intro: 'This platform is for enrolled Pattanabhumi Biology students. Follow the steps below to access your account:',
        steps: [
          { stepNumber: 1, title: 'Receive Your Account Credentials', body: 'After your enrollment is confirmed, the school administrator will provide your personal Username and Password.' },
          { stepNumber: 2, title: 'Open the Sign-In Section', body: 'Click the Log In button in the top navigation bar (or scroll to the sign-in panel on this page).' },
          { stepNumber: 3, title: 'Enter Your Username and Password', body: 'Type your assigned username and password carefully. Choose "Keep me signed in on this device" only if you are using your own private device.' },
          { stepNumber: 4, title: 'Review the Privacy Notice (First Sign-In)', body: 'On your first sign-in ' + em + ' or whenever terms are updated ' + em + ' review and accept the Privacy Notice before entering the platform.' },
          { stepNumber: 5, title: 'Access Your Courses and Learning Tools', body: 'Once signed in, open My Profile to access assigned courses, scores, class calendar, and tuition payments.' },
          { stepNumber: 6, title: 'Need Help Signing In?', body: 'If you forget your password or need assistance, contact the school directly from the Contact page.' }
        ]
      },
      aboutUs: {
        eyebrowBadge: 'Established 2025',
        heading: 'About Us',
        subtitle: 'Education Site for Biology Courses Since 2025',
        paragraphs: [
          'Founded in 2025, Pattanabhumi Biology is a dedicated online education platform created to make high school and pre-university biology clear, structured, and deeply understandable.',
          'We believe strong performance in biology comes from genuine conceptual understanding rather than rote memorization.',
          'Through this learning portal, enrolled students can study course materials, review recorded lessons, track scores, follow class schedules, and manage tuition payments.'
        ]
      },
      instructorProfile: {
        heading: 'Instructor Profile',
        headlineBadge: "100/100 Full Score " + em + " A-Level Biology '23",
        education: 'Medical Student ' + em + ' 4th Year, Faculty of Medicine Siriraj Hospital, Mahidol University',
        awards: [
          '1st Runner-Up ' + em + ' National Round, 21st Thailand Biology Olympiad (21st TBO)',
          'Gold Medal ' + em + ' National Round, 19th Thailand Biology Olympiad (19th TBO)',
          'Highest Score (Theoretical Exam) ' + em + ' 19th Thailand Biology Olympiad (19th TBO)',
          'Highest Aggregate Score (Central Region) ' + em + ' 19th Thailand Biology Olympiad (19th TBO)'
        ],
        teachingExperience: 'Over 3 years of experience teaching high school biology, combining Olympiad-level depth with clear, exam-ready problem-solving strategies.'
      }
    };
  }

  function mergePublicContentWithOverrides(baseContent, rawJson, dekCfg) {
    var base = JSON.parse(JSON.stringify(baseContent || getDefaultPublicContent(dekCfg)));
    if (dekCfg) base.dek = dekCfg;
    var ov = parseJsonSafe(rawJson, null);
    if (!ov || typeof ov !== 'object') return base;
    function pick(val, fb) { return typeof val === 'string' && val.trim() ? val.trim() : fb; }
    if (ov.heroEyebrow !== undefined) base.hero.eyebrow = pick(ov.heroEyebrow, base.hero.eyebrow);
    if (ov.heroLead !== undefined) base.hero.lead = pick(ov.heroLead, base.hero.lead);
    if (ov.aboutSubtitle !== undefined) base.aboutUs.subtitle = pick(ov.aboutSubtitle, base.aboutUs.subtitle);
    if (ov.aboutParagraph1 !== undefined || ov.aboutParagraph2 !== undefined || ov.aboutParagraph3 !== undefined) {
      base.aboutUs.paragraphs = [
        pick(ov.aboutParagraph1, base.aboutUs.paragraphs[0]),
        pick(ov.aboutParagraph2, base.aboutUs.paragraphs[1]),
        pick(ov.aboutParagraph3, base.aboutUs.paragraphs[2])
      ];
    }
    if (ov.instructorHeadlineBadge !== undefined) base.instructorProfile.headlineBadge = pick(ov.instructorHeadlineBadge, base.instructorProfile.headlineBadge);
    if (ov.instructorEducation !== undefined) base.instructorProfile.education = pick(ov.instructorEducation, base.instructorProfile.education);
    if (ov.instructorTeachingExperience !== undefined) base.instructorProfile.teachingExperience = pick(ov.instructorTeachingExperience, base.instructorProfile.teachingExperience);
    if (Array.isArray(ov.instructorAwards) && ov.instructorAwards.length > 0) base.instructorProfile.awards = ov.instructorAwards;
    return base;
  }

  async function resolvePublicMediaAssetDto(fileId, opt_slotNum) {
    var cleanId = cleanSingleLine(fileId, 64);
    if (!cleanId) return { available: false, slotIndex: opt_slotNum || 0, fileId: '' };
    var sb = getSupabase();
    var res = await sb.from('files').select('*').eq('file_id', cleanId).eq('status', 'ACTIVE').maybeSingle();
    var row = res && res.data ? res.data : null;
    if (!row || !row.drive_file_id) {
      return { available: false, slotIndex: opt_slotNum || 0, fileId: cleanId };
    }
    var directUrl = global.PB_DRIVE ? global.PB_DRIVE.getGoogleDriveImageUrl(row.drive_file_id) : '';
    return {
      available: Boolean(directUrl),
      slotIndex: opt_slotNum || 0,
      fileId: row.file_id,
      driveFileId: row.drive_file_id,
      webViewLink: row.web_view_link || '',
      imageUrl: directUrl,
      mimeType: row.mime_type,
      originalFilename: row.original_filename,
      sizeBytes: Number(row.size_bytes || 0)
    };
  }

  function evalContactChannels(settingsMap) {
    var lineUrl = cleanSingleLine(settingsMap.CONTACT_LINE_URL, 500);
    var fbUrl = cleanSingleLine(settingsMap.CONTACT_FACEBOOK_URL, 500);
    var email = cleanSingleLine(settingsMap.CONTACT_EMAIL, 254);
    var lineOk = /^https:\/\/[^\s]+$/i.test(lineUrl) && lineUrl.toLowerCase().indexOf('placeholder') === -1;
    var fbOk = /^https:\/\/[^\s]+$/i.test(fbUrl) && fbUrl.toLowerCase().indexOf('placeholder') === -1;
    var emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.toLowerCase().indexOf('example.com') === -1 && email.toLowerCase().indexOf('placeholder') === -1;
    return {
      lineUrl: lineOk ? lineUrl : '',
      lineConfigured: lineOk,
      facebookUrl: fbOk ? fbUrl : '',
      facebookConfigured: fbOk,
      email: emailOk ? email : '',
      emailConfigured: emailOk
    };
  }

  // ==================== PUBLIC / AUTH HANDLERS ====================

  async function handlePublicGetBootstrap(payload, sessionToken) {
    var sb = getSupabase();
    var req = payload && typeof payload === 'object' ? payload : {};
    var candToken = sessionToken || req.existingSessionToken || req.sessionToken || req.authToken || null;
    var rpcRes = await sb.rpc('pb_public_get_bootstrap', { p_session_token: candToken });
    var d = unwrapRpcResult(rpcRes);
    var sMap = d.settings || {};

    var dekCfg = calculateDekCohorts(
      null,
      sMap.DEK_DISPLAY_MODE || 'AUTO_YEAR',
      parseInt(sMap.DEK_MANUAL_BASE_NUMBER || '70', 10) || 70
    );
    var pubContent = mergePublicContentWithOverrides(
      getDefaultPublicContent(dekCfg),
      sMap.PUBLIC_CONTENT_PUBLISHED_JSON || '',
      dekCfg
    );
    var contact = evalContactChannels(sMap);

    var mediaResults = await Promise.all([
      resolvePublicMediaAssetDto(sMap.LOGO_FILE_ID, 0),
      resolvePublicMediaAssetDto(sMap.INSTRUCTOR_PORTRAIT_FILE_ID, 0),
      resolvePublicMediaAssetDto(sMap.HERO_CARD_1_FILE_ID, 1),
      resolvePublicMediaAssetDto(sMap.HERO_CARD_2_FILE_ID, 2),
      resolvePublicMediaAssetDto(sMap.HERO_CARD_3_FILE_ID, 3)
    ]);

    var logoDto = mediaResults[0];
    var logoPayload = logoDto && logoDto.available
      ? {
          fileId: logoDto.fileId,
          driveFileId: logoDto.driveFileId,
          mimeType: logoDto.mimeType,
          imageUrl: logoDto.imageUrl,
          source: 'SUPABASE_DRIVE_OVERRIDE'
        }
      : { source: 'DEFAULT_EMBEDDED_ASSET' };

    var sessionObj = d.session || d.activeSession || null;
    if (sessionObj && !sessionObj.sessionToken && candToken) {
      sessionObj = Object.assign({ sessionToken: candToken }, sessionObj);
    }

    return {
      schoolName: cleanSingleLine(sMap.SCHOOL_NAME, 120) || 'Pattanabhumi Biology',
      logoText: 'PB',
      logo: logoPayload,
      contact: contact,
      privacyNoticeVersion: sMap.CURRENT_PRIVACY_NOTICE_VERSION || '2026-10-v1',
      privacyNoticeDocumentText: sMap.PRIVACY_NOTICE_DOCUMENT_TEXT || '',
      hasAnyUserAccount: Boolean(d.hasAnyUserAccount),
      dekConfig: dekCfg,
      publicContent: pubContent,
      instructorPortrait: mediaResults[1],
      heroShuffleCards: [mediaResults[2], mediaResults[3], mediaResults[4]],
      sessionRestoreStatus: d.sessionRestoreStatus || 'NO_TOKEN',
      sessionRestoreReason: d.sessionRestoreReason || (d.sessionRestoreStatus === 'NEW_DEVICE_LOGIN' ? 'NEW_DEVICE_LOGIN' : ''),
      sessionRestoreMessage: d.sessionRestoreMessage || '',
      session: sessionObj,
      activeSession: d.activeSession || null,
      bangkokYear: dekCfg.bangkokYear
    };
  }

  // ==================== SETTINGS & CMS ====================

  async function handleAdminGetSettings(sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var sb = getSupabase();
    var rows = throwIfPgErr(await sb.from('settings').select('*'), 'Load settings');
    var byKey = {};
    var versions = {};
    for (var i = 0; i < (rows || []).length; i++) {
      byKey[rows[i].setting_key] = rows[i].setting_value || '';
      versions[rows[i].setting_key] = Number(rows[i].version || 1);
    }

    var dekCfg = calculateDekCohorts(null, byKey.DEK_DISPLAY_MODE, parseInt(byKey.DEK_MANUAL_BASE_NUMBER || '70', 10) || 70);
    var defContent = getDefaultPublicContent(dekCfg);
    var pubContent = mergePublicContentWithOverrides(defContent, byKey.PUBLIC_CONTENT_PUBLISHED_JSON || '', dekCfg);
    var draftContent = byKey.PUBLIC_CONTENT_DRAFT_JSON
      ? mergePublicContentWithOverrides(defContent, byKey.PUBLIC_CONTENT_DRAFT_JSON, dekCfg)
      : pubContent;

    var assets = await Promise.all([
      resolvePublicMediaAssetDto(byKey.INSTRUCTOR_PORTRAIT_FILE_ID, 0),
      resolvePublicMediaAssetDto(byKey.HERO_CARD_1_FILE_ID, 1),
      resolvePublicMediaAssetDto(byKey.HERO_CARD_2_FILE_ID, 2),
      resolvePublicMediaAssetDto(byKey.HERO_CARD_3_FILE_ID, 3)
    ]);

    return {
      publicSettings: {
        schoolName: byKey.SCHOOL_NAME || 'Pattanabhumi Biology',
        contactEmail: byKey.CONTACT_EMAIL || '',
        contactLineUrl: byKey.CONTACT_LINE_URL || '',
        contactFacebookUrl: byKey.CONTACT_FACEBOOK_URL || '',
        privacyNoticeVersion: byKey.CURRENT_PRIVACY_NOTICE_VERSION || '2026-10-v1',
        privacyNoticeDocumentText: byKey.PRIVACY_NOTICE_DOCUMENT_TEXT || '',
        dekDisplayMode: byKey.DEK_DISPLAY_MODE === 'MANUAL_OVERRIDE' ? 'MANUAL_OVERRIDE' : 'AUTO_YEAR',
        dekManualBaseNumber: parseInt(byKey.DEK_MANUAL_BASE_NUMBER || '70', 10) || 70,
        instructorPortraitFileId: byKey.INSTRUCTOR_PORTRAIT_FILE_ID || '',
        instructorProfileLastVerifiedAt: byKey.INSTRUCTOR_PROFILE_LAST_VERIFIED_AT || ''
      },
      publicWebsiteCms: {
        dekConfig: dekCfg,
        defaultContent: defContent,
        publishedContent: pubContent,
        draftContent: draftContent,
        hasUnpublishedDraft: Boolean(byKey.PUBLIC_CONTENT_DRAFT_JSON && byKey.PUBLIC_CONTENT_DRAFT_JSON !== byKey.PUBLIC_CONTENT_PUBLISHED_JSON),
        rawDraftJson: byKey.PUBLIC_CONTENT_DRAFT_JSON || '',
        rawPublishedJson: byKey.PUBLIC_CONTENT_PUBLISHED_JSON || '',
        instructorPortraitFileId: byKey.INSTRUCTOR_PORTRAIT_FILE_ID || '',
        instructorPortrait: assets[0],
        heroShuffleCards: [assets[1], assets[2], assets[3]],
        academicYearVerification: { needsVerification: false }
      },
      privateSettings: {
        notificationRecipientEmail: byKey.ADMIN_NOTIFICATION_EMAIL || '',
        promptPayTarget: byKey.PROMPTPAY_ID_DISPLAY || '',
        bankAccountName: byKey.BANK_ACCOUNT_NAME || '',
        bankName: byKey.BANK_NAME || '',
        bankAccountNumber: byKey.BANK_ACCOUNT_NUMBER || '',
        logoFileIdOverride: byKey.LOGO_FILE_ID || ''
      },
      versions: versions,
      logoUploadFeature: {
        uploadConnected: true,
        statusCode: 'CONNECTED_GOOGLE_DRIVE_DIRECT_V3',
        maxFileBytes: 209715200,
        allowedFormats: ['image/png', 'image/jpeg', 'image/webp']
      }
    };
  }

  async function upsertSettingKeys(actorId, entriesMap) {
    var sb = getSupabase();
    var nowIso = nowUtcIso();
    var existingRows = throwIfPgErr(await sb.from('settings').select('setting_key, version'), 'Read setting versions');
    var verMap = {};
    for (var i = 0; i < (existingRows || []).length; i++) {
      verMap[existingRows[i].setting_key] = Number(existingRows[i].version || 1);
    }
    var upsertList = Object.keys(entriesMap).map(function (k) {
      return {
        setting_key: k,
        setting_value: String(entriesMap[k] !== undefined && entriesMap[k] !== null ? entriesMap[k] : ''),
        updated_by_user_id: actorId || 'ADMIN',
        updated_at_utc: nowIso,
        version: (verMap[k] || 0) + 1
      };
    });
    if (upsertList.length > 0) {
      throwIfPgErr(await sb.from('settings').upsert(upsertList, { onConflict: 'setting_key' }), 'Save settings');
    }
  }

  async function handleAdminUpdateSettings(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['ADMIN']);
    var req = payload && typeof payload === 'object' ? payload : {};
    var updates = {};
    if (req.schoolName !== undefined) updates.SCHOOL_NAME = cleanSingleLine(req.schoolName, 100);
    if (req.contactEmail !== undefined) updates.CONTACT_EMAIL = cleanSingleLine(req.contactEmail, 254);
    if (req.contactLineUrl !== undefined) updates.CONTACT_LINE_URL = cleanSingleLine(req.contactLineUrl, 500);
    if (req.contactFacebookUrl !== undefined) updates.CONTACT_FACEBOOK_URL = cleanSingleLine(req.contactFacebookUrl, 500);
    if (req.notificationRecipientEmail !== undefined) updates.ADMIN_NOTIFICATION_EMAIL = cleanSingleLine(req.notificationRecipientEmail, 254);
    if (req.promptPayTarget !== undefined) updates.PROMPTPAY_ID_DISPLAY = cleanSingleLine(req.promptPayTarget, 64);
    if (req.bankAccountName !== undefined) updates.BANK_ACCOUNT_NAME = cleanSingleLine(req.bankAccountName, 120);
    if (req.bankName !== undefined) updates.BANK_NAME = cleanSingleLine(req.bankName, 120);
    if (req.bankAccountNumber !== undefined) updates.BANK_ACCOUNT_NUMBER = cleanSingleLine(req.bankAccountNumber, 64);
    if (req.privacyNoticeVersion !== undefined) updates.CURRENT_PRIVACY_NOTICE_VERSION = cleanSingleLine(req.privacyNoticeVersion, 64);
    if (req.privacyNoticeDocumentText !== undefined) updates.PRIVACY_NOTICE_DOCUMENT_TEXT = String(req.privacyNoticeDocumentText || '');
    if (req.logoFileIdOverride !== undefined) updates.LOGO_FILE_ID = cleanSingleLine(req.logoFileIdOverride, 120);

    await upsertSettingKeys(ses.userId, updates);
    await writeAuditEvent(ses.userId, 'ADMIN', 'ADMIN_SETTINGS_UPDATED', 'Setting', 'SCHOOL_SETTINGS', { keys: Object.keys(updates) });
    var out = await handleAdminGetSettings(sessionToken);
    out.updatedCount = Object.keys(updates).length;
    out.updatedKeys = Object.keys(updates);
    out.updatedAtUtc = nowUtcIso();
    out.updatedAtBangkok = formatBangkokTimestamp();
    return out;
  }

  async function handleAdminSavePublicWebsiteContent(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['ADMIN']);
    var req = payload && typeof payload === 'object' ? payload : {};
    var mode = String(req.mode || 'PUBLISH').trim().toUpperCase();
    var updates = {};
    var nowIso = nowUtcIso();

    if (mode === 'RESET_DEFAULT') {
      updates.PUBLIC_CONTENT_DRAFT_JSON = '';
      updates.PUBLIC_CONTENT_PUBLISHED_JSON = '';
      updates.DEK_DISPLAY_MODE = 'AUTO_YEAR';
      updates.DEK_MANUAL_BASE_NUMBER = '70';
    } else if (mode === 'VERIFY_INSTRUCTOR_YEAR') {
      updates.INSTRUCTOR_PROFILE_LAST_VERIFIED_AT = nowIso;
    } else {
      if (req.dekDisplayMode) updates.DEK_DISPLAY_MODE = req.dekDisplayMode === 'MANUAL_OVERRIDE' ? 'MANUAL_OVERRIDE' : 'AUTO_YEAR';
      if (req.dekManualBaseNumber !== undefined && req.dekManualBaseNumber !== '') {
        updates.DEK_MANUAL_BASE_NUMBER = String(req.dekManualBaseNumber);
      }
      var ov = req.contentOverrides && typeof req.contentOverrides === 'object' ? req.contentOverrides : req;
      var serialized = JSON.stringify({
        heroEyebrow: ov.heroEyebrow || '',
        heroLead: ov.heroLead || '',
        aboutSubtitle: ov.aboutSubtitle || '',
        aboutParagraph1: ov.aboutParagraph1 || '',
        aboutParagraph2: ov.aboutParagraph2 || '',
        aboutParagraph3: ov.aboutParagraph3 || '',
        instructorHeadlineBadge: ov.instructorHeadlineBadge || '',
        instructorEducation: ov.instructorEducation || '',
        instructorTeachingExperience: ov.instructorTeachingExperience || '',
        instructorAwards: Array.isArray(ov.instructorAwards)
          ? ov.instructorAwards
          : String(ov.instructorAwards || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean)
      });
      updates.PUBLIC_CONTENT_DRAFT_JSON = serialized;
      if (mode === 'PUBLISH') {
        updates.PUBLIC_CONTENT_PUBLISHED_JSON = serialized;
        if (req.markAcademicYearVerified) updates.INSTRUCTOR_PROFILE_LAST_VERIFIED_AT = nowIso;
      }
    }

    await upsertSettingKeys(ses.userId, updates);
    var out = await handleAdminGetSettings(sessionToken);
    out.cmsModeExecuted = mode;
    out.updatedAtUtc = nowIso;
    out.savedMessage = mode === 'PUBLISH' ? 'Published website content to Supabase.' : 'Saved public website changes.';
    return out;
  }

  // ==================== DIRECT GOOGLE DRIVE UPLOAD & SUPABASE FILES ====================

  function mapFileRowToDto(r) {
    if (!r) return null;
    var directUrl = global.PB_DRIVE ? global.PB_DRIVE.getGoogleDriveImageUrl(r.drive_file_id) : '';
    return {
      fileId: r.file_id,
      driveFileId: r.drive_file_id,
      webViewLink: r.web_view_link || ('https://drive.google.com/file/d/' + encodeURIComponent(r.drive_file_id) + '/view'),
      webContentLink: r.web_content_link || '',
      directImageUrl: directUrl,
      purpose: r.purpose,
      courseId: r.course_id || '',
      ownerUserId: r.owner_user_id || '',
      originalFilename: r.original_filename,
      mimeType: r.mime_type,
      sizeBytes: Number(r.size_bytes || 0),
      sha256Hex: r.sha256_hex || '',
      status: r.status || 'ACTIVE',
      createdAtUtc: r.created_at_utc,
      createdAtBangkok: formatBangkokTimestamp(r.created_at_utc)
    };
  }

  function base64ToBlob(b64, mimeType) {
    var clean = String(b64 || '').replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
    var bin = atob(clean);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mimeType || 'application/octet-stream' });
  }

  async function handleDirectFileUpload(payload, sessionToken, isAdminOnly) {
    var ses = await requireSession(sessionToken, isAdminOnly ? ['ADMIN'] : ['STUDENT', 'ADMIN']);
    var req = payload && typeof payload === 'object' ? payload : {};
    var purpose = String(req.purpose || 'PDF_ATTACHMENT').trim().toUpperCase();
    var targetType = String(req.targetEntityType || '').trim().toUpperCase();
    var targetId = cleanSingleLine(req.targetEntityId, 64);
    var courseId = cleanSingleLine(req.courseId, 64);

    if (!global.PB_DRIVE) {
      throw pbError('ERR_CONFIG_MISSING', 'PB_DRIVE helper module (docs/js/drive-storage.js) is not loaded.');
    }

    var sourceBlob = req._directFileBlob instanceof Blob ? req._directFileBlob : null;
    var usedDirectBlobToken = false;
    if (!sourceBlob && typeof req.dataBase64 === 'string' && global.PB_DRIVE.peekPendingBlob(req.dataBase64)) {
      sourceBlob = global.PB_DRIVE.peekPendingBlob(req.dataBase64);
      usedDirectBlobToken = true;
    }
    if (!sourceBlob && req.dataBase64 && String(req.dataBase64).indexOf(global.PB_DRIVE.DIRECT_BLOB_PREFIX) !== 0) {
      sourceBlob = base64ToBlob(req.dataBase64, req.mimeType || 'application/octet-stream');
    }
    if (!sourceBlob) {
      throw pbError('ERR_VALIDATION_FAILED', 'No file content or compressed blob provided for Drive upload.');
    }

    var fileId = genId('fil_');
    var safeName = cleanSingleLine(req.originalFilename, 180) || 'upload.bin';
    var driveRes = await global.PB_DRIVE.uploadFileDirectToDrive(sourceBlob, {
      originalFilename: safeName,
      storageFilename: fileId + '_' + safeName,
      mimeType: req.mimeType || sourceBlob.type,
      skipCompression: Boolean((req._directFileBlob && req._alreadyCompressed) || usedDirectBlobToken)
    });

    var sb = getSupabase();
    var nowIso = nowUtcIso();
    var insertObj = {
      file_id: fileId,
      drive_file_id: driveRes.driveFileId,
      web_view_link: driveRes.webViewLink || '',
      web_content_link: driveRes.webContentLink || '',
      storage_provider: 'GOOGLE_DRIVE',
      purpose: purpose,
      course_id: courseId || '',
      owner_user_id: ses.userId,
      original_filename: driveRes.originalFilename || safeName,
      mime_type: driveRes.mimeType,
      size_bytes: Number(driveRes.sizeBytes || 0),
      sha256_hex: driveRes.sha256Hex || '',
      status: 'ACTIVE',
      created_at_utc: nowIso
    };

    var inserted = throwIfPgErr(
      await sb.from('files').insert(insertObj).select('*').single(),
      'Save Drive file metadata to Supabase'
    );

    // Optional entity linkage matching legacy DriveService behavior
    var updatedLogo = null;
    var updatedPortrait = null;
    var updatedHeroCard = null;
    var linkedEntity = null;
    if (purpose === 'SCHOOL_LOGO' || targetType === 'SETTINGS_LOGO') {
      await upsertSettingKeys(ses.userId, { LOGO_FILE_ID: fileId });
      updatedLogo = {
        available: true,
        sourceType: 'ADMIN_OVERRIDE',
        cacheKey: fileId,
        fileId: fileId,
        driveFileId: driveRes.driveFileId,
        mimeType: driveRes.mimeType,
        imageUrl: driveRes.directImageUrl
      };
      updatedLogo.publicLogo = Object.assign({}, updatedLogo);
    } else if (purpose === 'INSTRUCTOR_PORTRAIT' || targetType === 'INSTRUCTOR_PORTRAIT' || targetType === 'SETTINGS_INSTRUCTOR_PORTRAIT') {
      await upsertSettingKeys(ses.userId, { INSTRUCTOR_PORTRAIT_FILE_ID: fileId });
      updatedPortrait = await resolvePublicMediaAssetDto(fileId, 0);
    } else if (targetType === 'HERO_CARD_1' || targetType === 'HERO_CARD_2' || targetType === 'HERO_CARD_3' || purpose === 'HERO_SHUFFLE_CARD') {
      var slotMatch = targetType.match(/HERO_CARD_([123])/);
      var slotNum = slotMatch ? Number(slotMatch[1]) : 1;
      var keyName = 'HERO_CARD_' + slotNum + '_FILE_ID';
      await upsertSettingKeys(ses.userId, (function () { var o = {}; o[keyName] = fileId; return o; })());
      updatedHeroCard = await resolvePublicMediaAssetDto(fileId, slotNum);
    } else if (purpose === 'PROMPTPAY_QR_IMAGE' || targetType === 'SETTINGS_PROMPTPAY_QR') {
      await upsertSettingKeys(ses.userId, { PROMPTPAY_QR_FILE_ID: fileId });
    } else if (purpose === 'PAYMENT_RECEIPT' && req.paymentId) {
      await sb.from('payments').update({
        receipt_file_id: fileId,
        status: 'RECEIPT_UPLOADED',
        updated_at_utc: nowIso
      }).eq('payment_id', cleanSingleLine(req.paymentId, 64));
    } else if ((targetType === 'COURSE' || targetType === 'COURSE_COVER') && targetId) {
      var curCrs = await sb.from('courses').select('version').eq('course_id', targetId).maybeSingle();
      var nextCrsVer = curCrs && curCrs.data ? Number(curCrs.data.version || 1) + 1 : 1;
      throwIfPgErr(await sb.from('courses').update({ cover_file_id: fileId, updated_at_utc: nowIso, version: nextCrsVer }).eq('course_id', targetId));
      linkedEntity = { newVersion: nextCrsVer };
    } else if ((targetType === 'CARD' || targetType === 'CARD_IMAGE') && targetId) {
      var curCrd = await sb.from('cards').select('version').eq('card_id', targetId).maybeSingle();
      var nextCrdVer = curCrd && curCrd.data ? Number(curCrd.data.version || 1) + 1 : 1;
      throwIfPgErr(await sb.from('cards').update({ image_file_id: fileId, updated_at_utc: nowIso, version: nextCrdVer }).eq('card_id', targetId));
      linkedEntity = { newVersion: nextCrdVer };
    } else if ((targetType === 'ASSESSMENT' || targetType === 'ASSESSMENT_PDF') && targetId) {
      var curAsm = await sb.from('assessments').select('version').eq('assessment_id', targetId).maybeSingle();
      var nextAsmVer = curAsm && curAsm.data ? Number(curAsm.data.version || 1) + 1 : 1;
      throwIfPgErr(await sb.from('assessments').update({ pdf_file_id: fileId, updated_at_utc: nowIso, version: nextAsmVer }).eq('assessment_id', targetId));
      linkedEntity = { newVersion: nextAsmVer };
    }

    await writeAuditEvent(ses.userId, ses.role, 'DRIVE_FILE_UPLOADED_DIRECT', 'File', fileId, {
      purpose: purpose,
      driveFileId: driveRes.driveFileId,
      sizeBytes: insertObj.size_bytes
    });

    return {
      file: mapFileRowToDto(inserted),
      updatedLogo: updatedLogo,
      updatedInstructorPortrait: updatedPortrait,
      updatedHeroCard: updatedHeroCard,
      linkedEntity: linkedEntity
    };
  }

  async function handleFileGetContent(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['STUDENT', 'ADMIN']);
    var req = payload && typeof payload === 'object' ? payload : {};
    var fileId = cleanSingleLine(req.fileId, 64);
    var reqCourseId = cleanSingleLine(req.courseId, 64);
    if (!/^fil_[A-Za-z0-9_-]{4,64}$/.test(fileId)) {
      throw pbError('ERR_VALIDATION_FAILED', 'Valid application fileId (fil_...) is required.');
    }

    var sb = getSupabase();
    var fileRow = throwIfPgErr(
      await sb.from('files').select('*').eq('file_id', fileId).eq('status', 'ACTIVE').maybeSingle(),
      'Load file record'
    );
    if (!fileRow) {
      throw pbError('ERR_NOT_FOUND', 'Requested file "' + fileId + '" was not found or has been deleted.');
    }

    // Student course access check when viewing course-bound materials
    var effectiveCourseId = reqCourseId || fileRow.course_id || '';
    if (ses.role !== 'ADMIN') {
      var purpose = String(fileRow.purpose || '');
      if (purpose === 'PAYMENT_RECEIPT' && fileRow.owner_user_id && fileRow.owner_user_id !== ses.userId) {
        throw pbError('ERR_FORBIDDEN_RESOURCE', 'Payment receipts may only be accessed by their owner or an administrator.');
      }
      if (effectiveCourseId && (purpose === 'COURSE_COVER' || purpose === 'COURSE_IMAGE' || purpose === 'COURSE_PDF' || purpose === 'CARD_IMAGE' || purpose === 'RICHTEXT_IMAGE' || purpose === 'PDF_ATTACHMENT')) {
        var enr = throwIfPgErr(
          await sb.from('enrollments').select('enrollment_id').eq('user_id', ses.userId).eq('course_id', effectiveCourseId).eq('status', 'ACTIVE').maybeSingle()
        );
        if (!enr) {
          throw pbError('ERR_FORBIDDEN_RESOURCE', 'Access denied: Active enrollment is required to view files in this course.');
        }
      }
    }

    return mapFileRowToDto(fileRow);
  }

  async function handleAdminListFiles(sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var sb = getSupabase();
    var rows = throwIfPgErr(
      await sb.from('files').select('*').eq('status', 'ACTIVE').order('created_at_utc', { ascending: false }).limit(200),
      'List files'
    );
    return { files: (rows || []).map(mapFileRowToDto) };
  }

  async function handleAdminRemoveFileReference(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['ADMIN']);
    var req = payload && typeof payload === 'object' ? payload : {};
    var sb = getSupabase();
    var tt = String(req.targetEntityType || '').trim().toUpperCase();
    var tid = cleanSingleLine(req.targetEntityId, 64);
    var nowIso = nowUtcIso();
    if ((tt === 'COURSE' || tt === 'COURSE_COVER') && tid) await sb.from('courses').update({ cover_file_id: '', updated_at_utc: nowIso }).eq('course_id', tid);
    else if ((tt === 'CARD' || tt === 'CARD_IMAGE') && tid) await sb.from('cards').update({ image_file_id: '', updated_at_utc: nowIso }).eq('card_id', tid);
    else if ((tt === 'ASSESSMENT' || tt === 'ASSESSMENT_PDF') && tid) await sb.from('assessments').update({ pdf_file_id: '', updated_at_utc: nowIso }).eq('assessment_id', tid);
    else if (tt === 'SETTINGS_LOGO' || tt === 'SCHOOL_LOGO') await upsertSettingKeys(ses.userId, { LOGO_FILE_ID: '' });
    else if (tt === 'INSTRUCTOR_PORTRAIT' || tt === 'SETTINGS_INSTRUCTOR_PORTRAIT') await upsertSettingKeys(ses.userId, { INSTRUCTOR_PORTRAIT_FILE_ID: '' });
    else if (/^HERO_CARD_([123])$/.test(tt)) {
      var hm = tt.match(/^HERO_CARD_([123])$/);
      var ho = {}; ho['HERO_CARD_' + hm[1] + '_FILE_ID'] = '';
      await upsertSettingKeys(ses.userId, ho);
    }
    else if (tt === 'PROMPTPAY_QR_IMAGE' || tt === 'SETTINGS_PROMPTPAY_QR') await upsertSettingKeys(ses.userId, { PROMPTPAY_QR_FILE_ID: '' });
    if (req.fileId) await sb.from('files').update({ status: 'DELETED' }).eq('file_id', cleanSingleLine(req.fileId, 64));
    return {
      removed: true,
      removedFileId: cleanSingleLine(req.fileId, 64) || '',
      updatedLogo: (tt === 'SETTINGS_LOGO' || tt === 'SCHOOL_LOGO')
        ? { available: false, source: 'DEFAULT_EMBEDDED_ASSET', publicLogo: { source: 'DEFAULT_EMBEDDED_ASSET' } }
        : null
    };
  }

  // ==================== COURSES, SECTIONS, CARDS, ASSESSMENTS & SCORES ====================

  function mapCourseRowToDto(c, secCount, cardCount, enrCount) {
    var sCnt = Number(secCount || 0);
    var cCnt = Number(cardCount || 0);
    var eCnt = Number(enrCount || 0);
    return {
      courseId: c.course_id,
      courseCode: c.course_code,
      title: c.title,
      subtitle: c.subtitle || '',
      coverFileId: c.cover_file_id || '',
      status: c.status,
      sortOrder: Number(c.sort_order || 0),
      objectivesRichText: parseJsonSafe(c.objectives_richtext_json, { schemaVersion: 'pb-richtext-v1', blocks: [] }),
      outcomesRichText: parseJsonSafe(c.outcomes_richtext_json, { schemaVersion: 'pb-richtext-v1', blocks: [] }),
      calendarTag: c.calendar_tag || '',
      assessmentUpdatedAtUtc: c.assessment_updated_at_utc || '',
      assessmentUpdatedAtBangkok: c.assessment_updated_at_utc ? formatBangkokTimestamp(c.assessment_updated_at_utc) : '',
      readingUpdatedAtUtc: c.reading_updated_at_utc || '',
      readingUpdatedAtBangkok: c.reading_updated_at_utc ? formatBangkokTimestamp(c.reading_updated_at_utc) : '',
      sectionCount: sCnt,
      sectionsCount: sCnt,
      cardCount: cCnt,
      cardsCount: cCnt,
      activeEnrollmentCount: eCnt,
      enrollmentsCount: eCnt,
      createdAtUtc: c.created_at_utc,
      updatedAtUtc: c.updated_at_utc,
      updatedAtBangkok: formatBangkokTimestamp(c.updated_at_utc),
      version: Number(c.version || 1)
    };
  }

  function mapAssessmentRowToDto(a) {
    return {
      assessmentId: a.assessment_id,
      title: a.title,
      descriptionRichText: parseJsonSafe(a.description_richtext_json, { schemaVersion: 'pb-richtext-v1', blocks: [] }),
      externalUrl: a.external_url || '',
      pdfFileId: a.pdf_file_id || '',
      status: a.status,
      isArchived: a.status === 'ARCHIVED',
      createdAtUtc: a.created_at_utc,
      updatedAtUtc: a.updated_at_utc,
      version: Number(a.version || 1)
    };
  }

  function mapCardRowToDto(crd, asmMap, filesMap) {
    var contentDoc = parseJsonSafe(crd.content_richtext_json, { schemaVersion: 'pb-richtext-v1', blocks: [] });
    var linkedAsm = crd.assessment_id && asmMap[crd.assessment_id] ? mapAssessmentRowToDto(asmMap[crd.assessment_id]) : null;
    var extractedPdfs = [];
    if (contentDoc && Array.isArray(contentDoc.blocks)) {
      contentDoc.blocks.forEach(function (blk) {
        if (blk && blk.type === 'pdf_attachment' && blk.fileId) {
          extractedPdfs.push({
            fileId: blk.fileId,
            title: blk.title || 'Course PDF Handout',
            allowDownload: blk.allowDownload !== false,
            meta: filesMap[blk.fileId] ? mapFileRowToDto(filesMap[blk.fileId]) : null
          });
        }
      });
    }
    return {
      cardId: crd.card_id,
      courseId: crd.course_id,
      sectionId: crd.section_id,
      cardType: crd.card_type,
      title: crd.title,
      subtitle: crd.subtitle || '',
      imageFileId: crd.image_file_id || '',
      imageCaption: crd.image_caption || '',
      contentRichText: contentDoc,
      extractedPdfs: extractedPdfs,
      recordingUrl: crd.recording_url || '',
      recordingUploadedAtUtc: crd.recording_uploaded_at_utc || '',
      assessmentId: crd.assessment_id || '',
      linkedAssessment: linkedAsm,
      assessmentArchivedWarning: Boolean(linkedAsm && linkedAsm.status === 'ARCHIVED'),
      status: crd.status,
      sortOrder: Number(crd.sort_order || 0),
      createdAtUtc: crd.created_at_utc,
      updatedAtUtc: crd.updated_at_utc,
      updatedAtBangkok: formatBangkokTimestamp(crd.updated_at_utc),
      version: Number(crd.version || 1)
    };
  }

  async function handleAdminListCourses(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var req = payload && typeof payload === 'object' ? payload : {};
    var sb = getSupabase();
    var all = await Promise.all([
      sb.from('courses').select('*').order('sort_order', { ascending: true }).order('created_at_utc', { ascending: false }),
      sb.from('sections').select('section_id,course_id,status'),
      sb.from('cards').select('card_id,course_id,status'),
      sb.from('enrollments').select('enrollment_id,course_id,user_id,status'),
      sb.from('assessments').select('*').order('created_at_utc', { ascending: false })
    ]);
    var coursesRows = throwIfPgErr(all[0], 'List courses') || [];
    var secRows = throwIfPgErr(all[1]) || [];
    var cardRows = throwIfPgErr(all[2]) || [];
    var enrRows = throwIfPgErr(all[3]) || [];
    var asmRows = throwIfPgErr(all[4]) || [];

    var secCnt = {}, cardCnt = {}, enrCnt = {}, enrUserIds = {};
    secRows.forEach(function (s) { if (s.status !== 'ARCHIVED') secCnt[s.course_id] = (secCnt[s.course_id] || 0) + 1; });
    cardRows.forEach(function (c) { if (c.status !== 'ARCHIVED') cardCnt[c.course_id] = (cardCnt[c.course_id] || 0) + 1; });
    enrRows.forEach(function (e) {
      if (e.status === 'ACTIVE') {
        enrCnt[e.course_id] = (enrCnt[e.course_id] || 0) + 1;
        if (!enrUserIds[e.course_id]) enrUserIds[e.course_id] = [];
        enrUserIds[e.course_id].push(e.user_id);
      }
    });

    var statusFilter = String(req.statusFilter || 'ALL').trim().toUpperCase();
    var kw = String(req.searchQuery || '').trim().toLowerCase();
    var dtos = coursesRows
      .filter(function (c) {
        if (statusFilter !== 'ALL' && c.status !== statusFilter) return false;
        if (kw && (c.course_code + ' ' + c.title + ' ' + (c.subtitle || '')).toLowerCase().indexOf(kw) === -1) return false;
        return true;
      })
      .map(function (c) {
        var dto = mapCourseRowToDto(c, secCnt[c.course_id], cardCnt[c.course_id], enrCnt[c.course_id]);
        dto.enrolledUserIds = enrUserIds[c.course_id] || [];
        return dto;
      });

    return {
      courses: dtos,
      assessments: asmRows.map(mapAssessmentRowToDto),
      gradingPolicyNotice: 'Assessment links can point to external forms or native Portal Exam Studio exams.'
    };
  }

  async function handleAdminGetCourseEditorDetail(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var courseId = cleanSingleLine(payload && payload.courseId, 64);
    if (!courseId) throw pbError('ERR_VALIDATION_FAILED', 'courseId is required.');
    var sb = getSupabase();
    var all = await Promise.all([
      sb.from('courses').select('*').eq('course_id', courseId).maybeSingle(),
      sb.from('sections').select('*').eq('course_id', courseId).order('sort_order', { ascending: true }),
      sb.from('cards').select('*').eq('course_id', courseId).order('sort_order', { ascending: true }),
      sb.from('assessments').select('*'),
      sb.from('files').select('*').eq('status', 'ACTIVE'),
      sb.from('enrollments').select('*').eq('course_id', courseId).eq('status', 'ACTIVE')
    ]);
    var cRow = throwIfPgErr(all[0], 'Load course detail');
    if (!cRow) throw pbError('ERR_NOT_FOUND', 'Course not found.');
    var secs = throwIfPgErr(all[1]) || [];
    var cards = throwIfPgErr(all[2]) || [];
    var asms = throwIfPgErr(all[3]) || [];
    var files = throwIfPgErr(all[4]) || [];
    var enrs = throwIfPgErr(all[5]) || [];

    var asmMap = {};
    asms.forEach(function (a) { asmMap[a.assessment_id] = a; });
    var filesMap = {};
    files.forEach(function (f) { filesMap[f.file_id] = f; });
    var cardsBySec = {};
    cards.forEach(function (crd) {
      if (!cardsBySec[crd.section_id]) cardsBySec[crd.section_id] = [];
      cardsBySec[crd.section_id].push(mapCardRowToDto(crd, asmMap, filesMap));
    });

    var sectionDtos = secs.map(function (s) {
      var secCards = cardsBySec[s.section_id] || [];
      return {
        sectionId: s.section_id,
        courseId: s.course_id,
        sectionType: s.section_type,
        title: s.title,
        status: s.status,
        sortOrder: Number(s.sort_order || 0),
        updatedAtUtc: s.updated_at_utc,
        version: Number(s.version || 1),
        canHardDelete: secCards.length === 0,
        cards: secCards
      };
    });

    var asmDtos = asms.map(mapAssessmentRowToDto);
    return {
      course: mapCourseRowToDto(cRow, secs.length, cards.length, enrs.length),
      sections: sectionDtos,
      assessments: asmDtos,
      assessmentsLibrary: asmDtos,
      enrolledUserIds: enrs.map(function (e) { return e.user_id; })
    };
  }

  async function handleAdminSaveCourse(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var req = payload && typeof payload === 'object' ? payload : {};
    var sb = getSupabase();
    var nowIso = nowUtcIso();
    var courseId = cleanSingleLine(req.courseId, 64);
    var courseCode = cleanSingleLine(req.courseCode, 40).toUpperCase();
    var title = cleanSingleLine(req.title, 160);
    if (!courseCode || !title) throw pbError('ERR_VALIDATION_FAILED', 'Course code and title are required.');

    var objDoc = normalizeRichTextDoc(req.objectivesRichText, 'objectivesRichText', 'Objectives', false).doc;
    var outDoc = normalizeRichTextDoc(req.outcomesRichText, 'outcomesRichText', 'Outcomes', false).doc;
    var row = {
      course_id: courseId || genId('crs_'),
      course_code: courseCode,
      title: title,
      subtitle: cleanSingleLine(req.subtitle, 240),
      cover_file_id: cleanSingleLine(req.coverFileId, 64),
      status: String(req.status || 'PUBLISHED').toUpperCase(),
      sort_order: Number(req.sortOrder || 10),
      objectives_richtext_json: objDoc,
      outcomes_richtext_json: outDoc,
      calendar_tag: cleanSingleLine(req.calendarTag, 60),
      updated_at_utc: nowIso
    };
    var savedCourseId = courseId;
    if (!courseId) {
      row.created_at_utc = nowIso;
      row.version = 1;
      var created = throwIfPgErr(await sb.from('courses').insert(row).select('*').single(), 'Create course');
      savedCourseId = created.course_id;
      // Seed 3 standard sections
      await sb.from('sections').insert([
        { section_id: genId('sec_'), course_id: savedCourseId, section_type: 'ASSESSMENT', title: 'Assessments & Quizzes', status: 'PUBLISHED', sort_order: 10, updated_at_utc: nowIso, version: 1 },
        { section_id: genId('sec_'), course_id: savedCourseId, section_type: 'READING', title: 'Reading Materials & PDFs', status: 'PUBLISHED', sort_order: 20, updated_at_utc: nowIso, version: 1 },
        { section_id: genId('sec_'), course_id: savedCourseId, section_type: 'RECORDING', title: 'Recorded Lessons', status: 'PUBLISHED', sort_order: 30, updated_at_utc: nowIso, version: 1 }
      ]);
    } else {
      var cur = throwIfPgErr(await sb.from('courses').select('version').eq('course_id', courseId).single());
      row.version = Number(cur.version || 1) + 1;
      throwIfPgErr(await sb.from('courses').update(row).eq('course_id', courseId), 'Update course');
    }

    if (Array.isArray(req.enrolledUserIds)) {
      unwrapRpcResult(await sb.rpc('pb_admin_set_course_enrollments', {
        p_session_token: sessionToken,
        p_course_id: savedCourseId,
        p_user_ids: req.enrolledUserIds
      }));
    }

    return await handleAdminGetCourseEditorDetail({ courseId: savedCourseId }, sessionToken);
  }

  async function handleAdminDeleteCourse(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var courseId = cleanSingleLine(payload && payload.courseId, 64);
    if (!courseId) throw pbError('ERR_VALIDATION_FAILED', 'courseId is required.');
    var sb = getSupabase();
    throwIfPgErr(await sb.from('assessment_scores').delete().eq('course_id', courseId), 'Delete course scores');
    throwIfPgErr(await sb.from('calendar_events').delete().eq('course_id', courseId), 'Delete course calendar events');
    throwIfPgErr(await sb.from('exam_sets').update({ course_id: '', updated_at_utc: nowUtcIso() }).eq('course_id', courseId), 'Detach course exam sets');
    throwIfPgErr(await sb.from('courses').delete().eq('course_id', courseId), 'Delete course');
    return await handleAdminListCourses({}, sessionToken);
  }

  async function handleAdminSaveSection(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var req = payload && typeof payload === 'object' ? payload : {};
    var sb = getSupabase();
    var nowIso = nowUtcIso();
    var secId = cleanSingleLine(req.sectionId, 64);
    var row = {
      section_id: secId || genId('sec_'),
      course_id: cleanSingleLine(req.courseId, 64),
      section_type: String(req.sectionType || 'CUSTOM').toUpperCase(),
      title: cleanSingleLine(req.title, 160),
      status: String(req.status || 'PUBLISHED').toUpperCase(),
      sort_order: Number(req.sortOrder || 40),
      updated_at_utc: nowIso
    };
    if (!secId) {
      row.version = 1;
      throwIfPgErr(await sb.from('sections').insert(row), 'Create section');
    } else {
      throwIfPgErr(await sb.from('sections').update(row).eq('section_id', secId), 'Update section');
    }
    return await handleAdminGetCourseEditorDetail({ courseId: row.course_id }, sessionToken);
  }

  async function handleAdminReorderSections(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var req = payload || {};
    var sb = getSupabase();
    var orderIds = Array.isArray(req.orderedSectionIds) ? req.orderedSectionIds : [];
    for (var i = 0; i < orderIds.length; i++) {
      await sb.from('sections').update({ sort_order: (i + 1) * 10, updated_at_utc: nowUtcIso() }).eq('section_id', orderIds[i]);
    }
    return await handleAdminGetCourseEditorDetail({ courseId: req.courseId }, sessionToken);
  }

  async function handleAdminRemoveSection(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var req = payload || {};
    var sb = getSupabase();
    if (req.mode === 'DELETE' || req.hardDelete) {
      throwIfPgErr(await sb.from('sections').delete().eq('section_id', cleanSingleLine(req.sectionId, 64)), 'Delete section');
    } else {
      throwIfPgErr(await sb.from('sections').update({ status: 'ARCHIVED', updated_at_utc: nowUtcIso() }).eq('section_id', cleanSingleLine(req.sectionId, 64)));
    }
    return await handleAdminGetCourseEditorDetail({ courseId: req.courseId }, sessionToken);
  }

  async function handleAdminSaveCard(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var req = payload && typeof payload === 'object' ? payload : {};
    var sb = getSupabase();
    var nowIso = nowUtcIso();
    var cardId = cleanSingleLine(req.cardId, 64);
    var doc = normalizeRichTextDoc(req.contentRichText, 'contentRichText', 'Card content', false).doc;
    var row = {
      card_id: cardId || genId('crd_'),
      course_id: cleanSingleLine(req.courseId, 64),
      section_id: cleanSingleLine(req.sectionId, 64),
      card_type: String(req.cardType || 'READING_CARD').toUpperCase(),
      title: cleanSingleLine(req.title, 160),
      subtitle: cleanSingleLine(req.subtitle, 240),
      image_file_id: cleanSingleLine(req.imageFileId, 64),
      image_caption: cleanSingleLine(req.imageCaption, 240),
      content_richtext_json: doc,
      recording_url: cleanSingleLine(req.recordingUrl, 500),
      recording_uploaded_at_utc: cleanSingleLine(req.recordingUploadedAtUtc || req.recordingUploadedDate, 64),
      assessment_id: cleanSingleLine(req.assessmentId, 64),
      status: String(req.status || 'PUBLISHED').toUpperCase(),
      sort_order: Number(req.sortOrder || 10),
      updated_at_utc: nowIso
    };
    if (!cardId) {
      row.created_at_utc = nowIso;
      row.version = 1;
      throwIfPgErr(await sb.from('cards').insert(row), 'Create card');
    } else {
      throwIfPgErr(await sb.from('cards').update(row).eq('card_id', cardId), 'Update card');
    }
    return await handleAdminGetCourseEditorDetail({ courseId: row.course_id }, sessionToken);
  }

  async function handleAdminReorderCards(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var req = payload || {};
    var sb = getSupabase();
    var ids = Array.isArray(req.orderedCardIds) ? req.orderedCardIds : [];
    for (var i = 0; i < ids.length; i++) {
      await sb.from('cards').update({ sort_order: (i + 1) * 10, updated_at_utc: nowUtcIso() }).eq('card_id', ids[i]);
    }
    return await handleAdminGetCourseEditorDetail({ courseId: req.courseId }, sessionToken);
  }

  async function handleAdminRemoveCard(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var req = payload || {};
    var sb = getSupabase();
    if (req.mode === 'DELETE' || req.hardDelete) {
      throwIfPgErr(await sb.from('cards').delete().eq('card_id', cleanSingleLine(req.cardId, 64)), 'Delete card');
    } else {
      throwIfPgErr(await sb.from('cards').update({ status: 'ARCHIVED', updated_at_utc: nowUtcIso() }).eq('card_id', cleanSingleLine(req.cardId, 64)));
    }
    return await handleAdminGetCourseEditorDetail({ courseId: req.courseId }, sessionToken);
  }

  async function handleAdminSaveAssessment(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var req = payload || {};
    var sb = getSupabase();
    var nowIso = nowUtcIso();
    var asmId = cleanSingleLine(req.assessmentId, 64);
    var descDoc = normalizeRichTextDoc(req.descriptionRichText, 'descriptionRichText', 'Description', false).doc;
    var row = {
      assessment_id: asmId || genId('asm_'),
      title: cleanSingleLine(req.title, 160),
      description_richtext_json: descDoc,
      external_url: cleanSingleLine(req.externalUrl, 500),
      pdf_file_id: cleanSingleLine(req.pdfFileId, 64),
      status: String(req.status || 'ACTIVE').toUpperCase(),
      updated_at_utc: nowIso
    };
    if (!asmId) {
      row.created_at_utc = nowIso;
      row.version = 1;
      throwIfPgErr(await sb.from('assessments').insert(row), 'Create assessment');
    } else {
      throwIfPgErr(await sb.from('assessments').update(row).eq('assessment_id', asmId), 'Update assessment');
    }
    var listRes = await handleAdminListCourses({}, sessionToken);
    return { assessment: mapAssessmentRowToDto(row), assessments: listRes.assessments };
  }

  async function handleStudentGetCourseDetail(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['STUDENT', 'ADMIN']);
    var courseId = cleanSingleLine(payload && payload.courseId, 64);
    if (!courseId) throw pbError('ERR_VALIDATION_FAILED', 'courseId is required.');
    var sb = getSupabase();
    var cRow = throwIfPgErr(await sb.from('courses').select('*').eq('course_id', courseId).maybeSingle());
    if (!cRow) throw pbError('ERR_NOT_FOUND', 'Requested course was not found.');

    if (ses.role !== 'ADMIN') {
      var enr = throwIfPgErr(await sb.from('enrollments').select('*').eq('user_id', ses.userId).eq('course_id', courseId).eq('status', 'ACTIVE').maybeSingle());
      if (!enr) throw pbError('ERR_FORBIDDEN_RESOURCE', 'Access denied: Active enrollment is required for this course.');
      if (cRow.status !== 'PUBLISHED') throw pbError('ERR_FORBIDDEN_RESOURCE', 'This course is not published yet.');
    }

    var all = await Promise.all([
      sb.from('sections').select('*').eq('course_id', courseId).eq('status', 'PUBLISHED').order('sort_order', { ascending: true }),
      sb.from('cards').select('*').eq('course_id', courseId).eq('status', 'PUBLISHED').order('sort_order', { ascending: true }),
      sb.from('assessments').select('*'),
      sb.from('files').select('*').eq('status', 'ACTIVE'),
      sb.from('assessment_scores').select('*').eq('student_user_id', ses.userId).eq('course_id', courseId).eq('status', 'PUBLISHED').order('updated_at_utc', { ascending: false }),
      sb.from('exam_sets').select('exam_set_id,status').eq('course_id', courseId).in('status', ['PUBLISHED', 'CLOSED'])
    ]);
    var secs = throwIfPgErr(all[0]) || [];
    var cards = throwIfPgErr(all[1]) || [];
    var asms = throwIfPgErr(all[2]) || [];
    var files = throwIfPgErr(all[3]) || [];
    var scoreRows = throwIfPgErr(all[4]) || [];
    var pubExamRows = (all[5] && !all[5].error && Array.isArray(all[5].data)) ? all[5].data : [];
    var asmMap = {}, filesMap = {}, cardsBySec = {};
    asms.forEach(function (a) { asmMap[a.assessment_id] = a; });
    files.forEach(function (f) { filesMap[f.file_id] = f; });
    cards.forEach(function (crd) {
      if (!cardsBySec[crd.section_id]) cardsBySec[crd.section_id] = [];
      cardsBySec[crd.section_id].push(mapCardRowToDto(crd, asmMap, filesMap));
    });
    var crsMapSingle = {};
    crsMapSingle[cRow.course_id] = cRow;
    var courseDto = mapCourseRowToDto(cRow, secs.length, cards.length, 0);
    courseDto.publishedExamCount = pubExamRows.length;

    return {
      course: courseDto,
      publishedExamCount: pubExamRows.length,
      sections: secs.map(function (s) {
        return {
          sectionId: s.section_id,
          sectionType: s.section_type,
          title: s.title,
          sortOrder: Number(s.sort_order || 0),
          updatedAtUtc: s.updated_at_utc || '',
          updatedAtBangkok: s.updated_at_utc ? formatBangkokTimestamp(s.updated_at_utc) : '',
          cards: cardsBySec[s.section_id] || []
        };
      }),
      publishedScores: scoreRows.map(function (r) { return mapAssessmentScoreRowDto(r, crsMapSingle, asmMap); }),
      accessControlNotice: 'Access verified on Supabase PostgreSQL Enrollments.',
      isAdminPreview: ses.role === 'ADMIN'
    };
  }

  function mapAssessmentScoreRowDto(r, crsMap, asmMap) {
    var maxP = Number(r.max_points || 0);
    var scP = Number(r.score_points || 0);
    var pct = maxP > 0 ? Math.round((scP * 1000) / maxP) / 10 : 0;
    var c = crsMap ? crsMap[r.course_id] : null;
    var a = asmMap ? asmMap[r.assessment_id] : null;
    return {
      scoreId: r.score_id,
      courseId: r.course_id,
      courseCode: c ? c.course_code : '',
      courseTitle: c ? c.title : '',
      assessmentId: r.assessment_id,
      assessmentTitle: a ? a.title : r.assessment_id,
      studentUserId: r.student_user_id,
      scorePoints: scP,
      maxPoints: maxP,
      percentageFormatted: pct.toFixed(1) + '%',
      feedbackText: r.feedback_text || '',
      status: r.status,
      publishedAtBangkok: r.published_at_utc ? formatBangkokTimestamp(r.published_at_utc) : '',
      version: Number(r.version || 1)
    };
  }

  async function handleListAssessmentScores(payload, sessionToken, isAdminView) {
    var ses = await requireSession(sessionToken, isAdminView ? ['ADMIN'] : ['STUDENT', 'ADMIN']);
    var req = payload || {};
    var sb = getSupabase();
    var q = sb.from('assessment_scores').select('*').order('updated_at_utc', { ascending: false });
    if (!isAdminView) q = q.eq('student_user_id', ses.userId).eq('status', 'PUBLISHED');
    if (req.courseId) q = q.eq('course_id', req.courseId);
    if (req.status && isAdminView && req.status !== 'ALL') q = q.eq('status', req.status);

    var all = await Promise.all([
      q,
      sb.from('courses').select('course_id,course_code,title'),
      sb.from('assessments').select('assessment_id,title')
    ]);
    var rows = throwIfPgErr(all[0]) || [];
    var crsMap = {}, asmMap = {};
    (throwIfPgErr(all[1]) || []).forEach(function (c) { crsMap[c.course_id] = c; });
    (throwIfPgErr(all[2]) || []).forEach(function (a) { asmMap[a.assessment_id] = a; });

    var scores = rows.map(function (r) {
      return mapAssessmentScoreRowDto(r, crsMap, asmMap);
    });
    return { scores: scores };
  }

  async function handleAdminSaveAssessmentScore(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['ADMIN']);
    var req = payload || {};
    var sb = getSupabase();
    var nowIso = nowUtcIso();
    var id = cleanSingleLine(req.scoreId, 64);
    var status = String(req.status || 'PUBLISHED').toUpperCase();
    var row = {
      score_id: id || genId('scr_'),
      course_id: cleanSingleLine(req.courseId, 64),
      assessment_id: cleanSingleLine(req.assessmentId, 64),
      student_user_id: cleanSingleLine(req.studentUserId, 64),
      score_points: Number(req.scorePoints || 0),
      max_points: Number(req.maxPoints || 100),
      feedback_text: cleanSingleLine(req.feedbackText, 2000),
      status: status,
      published_at_utc: status === 'PUBLISHED' ? nowIso : null,
      updated_by_user_id: ses.userId,
      updated_at_utc: nowIso
    };
    if (!id) {
      row.created_at_utc = nowIso;
      row.version = 1;
      throwIfPgErr(await sb.from('assessment_scores').insert(row), 'Save assessment score');
    } else {
      throwIfPgErr(await sb.from('assessment_scores').update(row).eq('score_id', id), 'Update assessment score');
    }
    return await handleListAssessmentScores({}, sessionToken, true);
  }

  // ==================== PROMPTPAY QR & BILLING / INVOICES / PAYMENTS ====================

  function formatSatangToThb(satang) {
    return ((Number(satang) || 0) / 100).toFixed(2);
  }

  function formatSatangDisplay(satang) {
    var n = (Number(satang) || 0) / 100;
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' THB';
  }

  function buildPromptPayPayload(rawTarget, totalSatang) {
    var digits = String(rawTarget || '').replace(/\D+/g, '');
    var subTag = '01';
    var formattedTarget = digits;
    if (digits.length === 10 && digits.indexOf('0') === 0) {
      formattedTarget = '0066' + digits.slice(1);
    } else if (digits.length === 13) {
      subTag = '02';
    } else if (digits.length >= 15) {
      subTag = '03';
    }
    function tlv(tag, val) {
      var s = String(val || '');
      return tag + String(s.length).padStart(2, '0') + s;
    }
    var merchantAcc = tlv('00', 'A000000677010111') + tlv(subTag, formattedTarget);
    var amtStr = formatSatangToThb(totalSatang);
    var parts = [
      tlv('00', '01'),
      tlv('01', totalSatang > 0 ? '12' : '11'),
      tlv('29', merchantAcc),
      tlv('58', 'TH'),
      tlv('53', '764')
    ];
    if (totalSatang > 0) parts.push(tlv('54', amtStr));
    var body = parts.join('') + '6304';
    var crc = 0xffff;
    for (var i = 0; i < body.length; i++) {
      crc ^= (body.charCodeAt(i) & 0xff) << 8;
      for (var b = 0; b < 8; b++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    var crcHex = crc.toString(16).toUpperCase().padStart(4, '0');
    return { payload: body + crcHex, crcHex: crcHex, amountThb: amtStr };
  }

  async function buildRecipientDetailsFromSettings() {
    var sb = getSupabase();
    var rows = throwIfPgErr(await sb.from('settings').select('setting_key,setting_value')) || [];
    var s = {};
    rows.forEach(function (r) { s[r.setting_key] = r.setting_value || ''; });
    return {
      bankName: s.BANK_NAME || 'Bank Account',
      bankAccountName: s.BANK_ACCOUNT_NAME || 'Pattanabhumi Biology',
      bankAccountNumber: s.BANK_ACCOUNT_NUMBER || '',
      promptPayTarget: s.PROMPTPAY_ID_DISPLAY || '',
      promptPayQrFileId: s.PROMPTPAY_QR_FILE_ID || '',
      qrCodeUrl: s.PROMPTPAY_QR_FILE_ID
        ? null
        : null
    };
  }

  function mapInvoiceRowDto(inv, coursesById) {
    var amt = Number(inv.amount_satang || 0);
    var c = inv.course_id && coursesById ? coursesById[inv.course_id] : null;
    var st = String(inv.status || 'UNPAID');
    return {
      invoiceId: inv.invoice_id,
      userId: inv.user_id,
      courseId: inv.course_id || '',
      courseCode: c ? c.course_code : '',
      courseTitle: c ? c.title : '',
      installmentLabel: inv.installment_label,
      amountSatang: amt,
      amountThb: formatSatangToThb(amt),
      amountThbFormatted: formatSatangDisplay(amt),
      dueDateBkk: inv.due_date_bkk || '',
      status: st,
      isEligibleUnpaid: st === 'UNPAID' || st === 'REJECTED',
      activePaymentId: inv.active_payment_id || '',
      reservationExpiresAtUtc: inv.reservation_expires_at_utc || '',
      reservationExpiresAtBangkok: inv.reservation_expires_at_utc ? formatBangkokTimestamp(inv.reservation_expires_at_utc) : '',
      lastRejectionReason: inv.last_rejection_reason || '',
      createdAtUtc: inv.created_at_utc,
      createdAtBangkok: formatBangkokTimestamp(inv.created_at_utc),
      version: Number(inv.version || 1)
    };
  }

  function mapPaymentRowDto(p, invoicesById, recipientSnap) {
    var invIds = Array.isArray(p.invoice_ids_json) ? p.invoice_ids_json : parseJsonSafe(p.invoice_ids_json, []);
    var tot = Number(p.total_amount_satang || 0);
    var expMs = p.expires_at_utc ? Date.parse(p.expires_at_utc) : NaN;
    var remSec = !isNaN(expMs) && expMs > Date.now() && (p.status === 'PENDING_TRANSFER' || p.status === 'RECEIPT_UPLOADED')
      ? Math.max(0, Math.ceil((expMs - Date.now()) / 1000))
      : 0;
    var pp = recipientSnap && recipientSnap.promptPayTarget
      ? buildPromptPayPayload(recipientSnap.promptPayTarget, tot)
      : null;

    return {
      paymentId: p.payment_id,
      userId: p.user_id,
      invoiceIds: invIds,
      invoices: invIds.map(function (id) { return invoicesById[id] ? mapInvoiceRowDto(invoicesById[id], null) : null; }).filter(Boolean),
      totalAmountSatang: tot,
      totalAmountThb: formatSatangToThb(tot),
      totalAmountThbFormatted: formatSatangDisplay(tot),
      method: p.method,
      status: p.status,
      expiresAtUtc: p.expires_at_utc || '',
      expiresAtBangkok: p.expires_at_utc ? formatBangkokTimestamp(p.expires_at_utc) : '',
      remainingSeconds: remSec,
      canResume: p.status === 'PENDING_TRANSFER' || p.status === 'RECEIPT_UPLOADED',
      receiptFileId: p.receipt_file_id || '',
      hasReceipt: Boolean(p.receipt_file_id),
      recipientSnapshot: recipientSnap || {},
      promptPayEmvCo: pp,
      submittedAtUtc: p.submitted_at_utc || '',
      submittedAtBangkok: p.submitted_at_utc ? formatBangkokTimestamp(p.submitted_at_utc) : '',
      reviewedAtUtc: p.reviewed_at_utc || '',
      reviewedAtBangkok: p.reviewed_at_utc ? formatBangkokTimestamp(p.reviewed_at_utc) : '',
      reviewNote: p.rejection_reason || '',
      rejectionReason: p.rejection_reason || '',
      createdAtUtc: p.created_at_utc,
      createdAtBangkok: formatBangkokTimestamp(p.created_at_utc),
      version: Number(p.version || 1)
    };
  }

  async function handlePaymentGetStudentSummary(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['STUDENT', 'ADMIN']);
    var targetUid = ses.role === 'ADMIN' && payload && payload.userId ? payload.userId : ses.userId;
    var sb = getSupabase();
    var all = await Promise.all([
      sb.from('invoices').select('*').eq('user_id', targetUid).order('due_date_bkk', { ascending: true }),
      sb.from('payments').select('*').eq('user_id', targetUid).order('created_at_utc', { ascending: false }),
      sb.from('courses').select('course_id,course_code,title'),
      buildRecipientDetailsFromSettings()
    ]);
    var invRows = throwIfPgErr(all[0], 'Load invoices') || [];
    var payRows = throwIfPgErr(all[1], 'Load payments') || [];
    var crsMap = {}, invById = {};
    (throwIfPgErr(all[2]) || []).forEach(function (c) { crsMap[c.course_id] = c; });
    invRows.forEach(function (i) { invById[i.invoice_id] = i; });
    var recip = all[3];

    var allInvoices = invRows.map(function (i) { return mapInvoiceRowDto(i, crsMap); });
    var eligible = allInvoices.filter(function (d) { return d.isEligibleUnpaid; });
    var awaitingInv = allInvoices.filter(function (d) { return d.status === 'AWAITING_VERIFICATION' || d.status === 'APPROVING'; });
    var paidInv = allInvoices.filter(function (d) { return d.status === 'PAID'; });
    var activeResRow = payRows.find(function (p) { return p.status === 'PENDING_TRANSFER' || p.status === 'RECEIPT_UPLOADED'; }) || null;
    var eligibleSatang = eligible.reduce(function (s, d) { return s + d.amountSatang; }, 0);
    var awaitingSatang = awaitingInv.reduce(function (s, d) { return s + d.amountSatang; }, 0);
    var paidSatang = paidInv.reduce(function (s, d) { return s + d.amountSatang; }, 0);
    var serverNowIso = nowUtcIso();
    var serverNowBkk = formatBangkokTimestamp(serverNowIso);
    var totalsSummaryObj = {
      eligibleUnpaidCount: eligible.length,
      eligibleUnpaidTotalThbFormatted: formatSatangDisplay(eligibleSatang),
      awaitingVerificationTotalThbFormatted: formatSatangDisplay(awaitingSatang),
      paidTotalThbFormatted: formatSatangDisplay(paidSatang)
    };

    return {
      invoices: allInvoices,
      allInvoices: allInvoices,
      eligibleUnpaidInvoices: eligible,
      activeReservation: activeResRow ? mapPaymentRowDto(activeResRow, invById, recip) : null,
      paymentHistory: payRows.map(function (p) { return mapPaymentRowDto(p, invById, recip); }),
      recipientDefaults: recip,
      serverNow: serverNowIso,
      serverNowBangkok: serverNowBkk,
      totalsSummary: totalsSummaryObj,
      totals: totalsSummaryObj
    };
  }

  async function handlePaymentCreateReservation(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['STUDENT', 'ADMIN']);
    var req = payload || {};
    var invIds = Array.isArray(req.invoiceIds) ? req.invoiceIds : [];
    if (invIds.length === 0) throw pbError('ERR_VALIDATION_FAILED', 'Select at least one unpaid installment.');
    var sb = getSupabase();
    var invRows = throwIfPgErr(await sb.from('invoices').select('*').in('invoice_id', invIds).eq('user_id', ses.userId)) || [];
    if (invRows.length !== invIds.length) throw pbError('ERR_NOT_FOUND', 'One or more invoices could not be found.');
    var totalSatang = invRows.reduce(function (sum, i) { return sum + Number(i.amount_satang || 0); }, 0);
    var nowIso = nowUtcIso();
    var expIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    var payId = genId('pay_');
    var method = String(req.method || 'PROMPTPAY_QR').toUpperCase();

    throwIfPgErr(await sb.from('payments').insert({
      payment_id: payId,
      user_id: ses.userId,
      invoice_ids_json: invIds,
      total_amount_satang: totalSatang,
      method: method,
      status: 'PENDING_TRANSFER',
      idempotency_key: req.idempotencyKey || genId('idem_'),
      expires_at_utc: expIso,
      created_at_utc: nowIso,
      updated_at_utc: nowIso,
      version: 1
    }), 'Create payment reservation');

    await sb.from('invoices').update({
      status: 'RESERVED',
      active_payment_id: payId,
      reservation_expires_at_utc: expIso,
      updated_at_utc: nowIso
    }).in('invoice_id', invIds);

    return await handlePaymentGetStudentSummary({}, sessionToken);
  }

  async function handlePaymentCancelReservation(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['STUDENT', 'ADMIN']);
    var payId = cleanSingleLine(payload && payload.paymentId, 64);
    var sb = getSupabase();
    var pRow = throwIfPgErr(await sb.from('payments').select('*').eq('payment_id', payId).eq('user_id', ses.userId).maybeSingle());
    if (!pRow) throw pbError('ERR_NOT_FOUND', 'Payment reservation not found.');
    var invIds = Array.isArray(pRow.invoice_ids_json) ? pRow.invoice_ids_json : parseJsonSafe(pRow.invoice_ids_json, []);
    var nowIso = nowUtcIso();
    await sb.from('payments').update({ status: 'CANCELLED', updated_at_utc: nowIso }).eq('payment_id', payId);
    if (invIds.length > 0) {
      await sb.from('invoices').update({ status: 'UNPAID', active_payment_id: '', reservation_expires_at_utc: null, updated_at_utc: nowIso }).in('invoice_id', invIds);
    }
    return await handlePaymentGetStudentSummary({}, sessionToken);
  }

  async function handlePaymentConfirmSubmission(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['STUDENT', 'ADMIN']);
    var payId = cleanSingleLine(payload && payload.paymentId, 64);
    var sb = getSupabase();
    var pRow = throwIfPgErr(await sb.from('payments').select('*').eq('payment_id', payId).eq('user_id', ses.userId).maybeSingle());
    if (!pRow) throw pbError('ERR_NOT_FOUND', 'Payment session not found.');
    if (!pRow.receipt_file_id) throw pbError('ERR_VALIDATION_FAILED', 'Please upload a transfer slip before submitting.');
    var invIds = Array.isArray(pRow.invoice_ids_json) ? pRow.invoice_ids_json : parseJsonSafe(pRow.invoice_ids_json, []);
    var nowIso = nowUtcIso();
    await sb.from('payments').update({ status: 'AWAITING_VERIFICATION', submitted_at_utc: nowIso, updated_at_utc: nowIso }).eq('payment_id', payId);
    if (invIds.length > 0) {
      await sb.from('invoices').update({ status: 'AWAITING_VERIFICATION', updated_at_utc: nowIso }).in('invoice_id', invIds);
    }
    return await handlePaymentGetStudentSummary({}, sessionToken);
  }

  async function handleAdminCreateInvoice(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var req = payload || {};
    var amtSatang = Math.round(Number(req.amountThb || req.amountSatang / 100 || 0) * 100);
    if (req.amountSatang && !req.amountThb) amtSatang = Math.round(Number(req.amountSatang));
    if (!amtSatang || amtSatang < 100) throw pbError('ERR_VALIDATION_FAILED', 'Invoice amount must be at least 1.00 THB.');
    var sb = getSupabase();
    var nowIso = nowUtcIso();
    var invRow = {
      invoice_id: genId('inv_'),
      user_id: cleanSingleLine(req.userId || req.studentUserId, 64),
      course_id: cleanSingleLine(req.courseId, 64),
      installment_label: cleanSingleLine(req.installmentLabel, 120),
      amount_satang: amtSatang,
      due_date_bkk: cleanSingleLine(req.dueDateBkk, 16) || todayBangkokYmd(),
      status: 'UNPAID',
      created_at_utc: nowIso,
      updated_at_utc: nowIso,
      version: 1
    };
    throwIfPgErr(await sb.from('invoices').insert(invRow), 'Create invoice');
    return await handleAdminListInvoices({}, sessionToken);
  }

  async function handleAdminListInvoices(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var sb = getSupabase();
    var req = payload || {};
    var all = await Promise.all([
      sb.from('invoices').select('*').order('created_at_utc', { ascending: false }),
      sb.from('courses').select('course_id,course_code,title,status'),
      sb.rpc('pb_admin_list_users', { p_session_token: sessionToken, p_limit: 200 })
    ]);
    var invRows = throwIfPgErr(all[0], 'List invoices') || [];
    var crsRows = throwIfPgErr(all[1]) || [];
    var usrData = unwrapRpcResult(all[2]);
    var usersList = (usrData && usrData.users) || [];
    var crsMap = {}, usrMap = {};
    crsRows.forEach(function (c) { crsMap[c.course_id] = c; });
    usersList.forEach(function (u) { usrMap[u.userId] = u; });

    var stFilter = String(req.statusFilter || req.status || 'ALL').toUpperCase();
    var uFilter = cleanSingleLine(req.userId || req.studentUserId, 64);
    var dtos = invRows
      .filter(function (inv) {
        if (stFilter !== 'ALL' && inv.status !== stFilter) return false;
        if (uFilter && uFilter !== 'ALL' && inv.user_id !== uFilter) return false;
        return true;
      })
      .map(function (inv) {
        var dto = mapInvoiceRowDto(inv, crsMap);
        var u = usrMap[inv.user_id];
        if (u) { dto.studentUsername = u.username; dto.studentFullName = u.fullName; dto.studentEmail = u.email; }
        return dto;
      });

    var activeStudents = usersList.filter(function (u) { return u.role === 'STUDENT' && u.status !== 'ARCHIVED'; });
    var activeCourses = crsRows.filter(function (c) { return c.status !== 'ARCHIVED'; }).map(function (c) { return mapCourseRowToDto(c, 0, 0, 0); });
    var unpaidSatang = invRows
      .filter(function (x) { return x.status === 'UNPAID' || x.status === 'RESERVED' || x.status === 'REJECTED'; })
      .reduce(function (sum, x) { return sum + Number(x.amount_satang || 0); }, 0);
    var paidSatang = invRows
      .filter(function (x) { return x.status === 'PAID'; })
      .reduce(function (sum, x) { return sum + Number(x.amount_satang || 0); }, 0);

    return {
      invoices: dtos,
      studentsList: activeStudents,
      students: activeStudents,
      coursesList: activeCourses,
      courses: activeCourses,
      summaryCounts: {
        totalInvoices: invRows.length,
        unpaidCount: invRows.filter(function (x) { return x.status === 'UNPAID'; }).length,
        reservedCount: invRows.filter(function (x) { return x.status === 'RESERVED'; }).length,
        rejectedCount: invRows.filter(function (x) { return x.status === 'REJECTED'; }).length,
        awaitingVerificationCount: invRows.filter(function (x) { return x.status === 'AWAITING_VERIFICATION'; }).length,
        approvingCount: invRows.filter(function (x) { return x.status === 'APPROVING'; }).length,
        paidCount: invRows.filter(function (x) { return x.status === 'PAID'; }).length,
        totalUnpaidSatang: unpaidSatang,
        totalUnpaidThbFormatted: formatSatangDisplay(unpaidSatang),
        totalPaidSatang: paidSatang,
        totalPaidThbFormatted: formatSatangDisplay(paidSatang)
      }
    };
  }

  async function handleAdminListPendingPayments(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var sb = getSupabase();
    var all = await Promise.all([
      sb.from('payments').select('*').order('created_at_utc', { ascending: false }).limit(150),
      sb.from('invoices').select('*'),
      buildRecipientDetailsFromSettings(),
      sb.rpc('pb_admin_list_users', { p_session_token: sessionToken, p_limit: 200 })
    ]);
    var payRows = throwIfPgErr(all[0], 'List payments') || [];
    var invRows = throwIfPgErr(all[1]) || [];
    var recip = all[2];
    var usersList = (unwrapRpcResult(all[3]) || {}).users || [];
    var invMap = {}, usrMap = {};
    invRows.forEach(function (i) { invMap[i.invoice_id] = i; });
    usersList.forEach(function (u) { usrMap[u.userId] = u; });

    var reqStatus = String((payload && (payload.status || payload.statusFilter)) || 'ALL').toUpperCase();
    var items = payRows
      .filter(function (p) { return reqStatus === 'ALL' || p.status === reqStatus; })
      .map(function (p) {
        var d = mapPaymentRowDto(p, invMap, recip);
        var u = usrMap[p.user_id];
        if (u) { d.studentUsername = u.username; d.studentFullName = u.fullName; d.studentEmail = u.email; }
        return d;
      });
    var awaitingCnt = payRows.filter(function (p) { return p.status === 'AWAITING_VERIFICATION'; }).length;
    var approvingCnt = payRows.filter(function (p) { return p.status === 'APPROVING'; }).length;
    var paidCnt = payRows.filter(function (p) { return p.status === 'PAID' || p.status === 'APPROVED'; }).length;
    var rejectedCnt = payRows.filter(function (p) { return p.status === 'REJECTED'; }).length;

    return {
      payments: items,
      totalReturned: items.length,
      queueCounts: {
        totalPayments: payRows.length,
        awaitingVerification: awaitingCnt,
        awaitingVerificationCount: awaitingCnt,
        approving: approvingCnt,
        approvingCount: approvingCnt,
        paid: paidCnt,
        paidCount: paidCnt,
        rejected: rejectedCnt,
        rejectedCount: rejectedCnt
      },
      recoveredJournals: {
        haltedInconsistencies: []
      }
    };
  }

  async function handleAdminReviewPayment(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['ADMIN']);
    var req = payload || {};
    var payId = cleanSingleLine(req.paymentId, 64);
    var decision = String(req.decision || req.action || '').toUpperCase();
    var reason = cleanSingleLine(req.reason || req.rejectionReason, 500);
    var sb = getSupabase();
    var pRow = throwIfPgErr(await sb.from('payments').select('*').eq('payment_id', payId).maybeSingle());
    if (!pRow) throw pbError('ERR_NOT_FOUND', 'Payment session not found.');
    var invIds = Array.isArray(pRow.invoice_ids_json) ? pRow.invoice_ids_json : parseJsonSafe(pRow.invoice_ids_json, []);
    var nowIso = nowUtcIso();
    var approved = decision === 'APPROVE' || decision === 'APPROVED' || decision === 'PAID';

    throwIfPgErr(await sb.from('payments').update({
      status: approved ? 'PAID' : 'REJECTED',
      reviewed_by_user_id: ses.userId,
      reviewed_at_utc: nowIso,
      rejection_reason: approved ? '' : (reason || 'Rejected by administrator.'),
      updated_at_utc: nowIso
    }).eq('payment_id', payId));

    if (invIds.length > 0) {
      await sb.from('invoices').update({
        status: approved ? 'PAID' : 'REJECTED',
        last_rejection_reason: approved ? '' : (reason || 'Rejected by administrator.'),
        updated_at_utc: nowIso
      }).in('invoice_id', invIds);
    }
    return await handleAdminListPendingPayments({}, sessionToken);
  }

  // ==================== CLASS CALENDAR & UNAVAILABILITY ====================

  function computeBangkokCalendarMonthRange(opt_monthKey) {
    var raw = String(opt_monthKey || '').trim();
    var match = /^(\d{4})-(\d{2})$/.exec(raw);
    var year, monthNum;
    if (match) {
      year = parseInt(match[1], 10);
      monthNum = parseInt(match[2], 10);
    }
    if (!match || monthNum < 1 || monthNum > 12 || year < 2000 || year > 2100) {
      var bkkNow = new Date(Date.now() + 7 * 3600 * 1000);
      year = bkkNow.getUTCFullYear();
      monthNum = bkkNow.getUTCMonth() + 1;
    }
    var mmStr = monthNum < 10 ? '0' + String(monthNum) : String(monthNum);
    var monthKey = String(year) + '-' + mmStr;
    var daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
    var firstDayOfWeek = new Date(Date.UTC(year, monthNum - 1, 1)).getUTCDay();
    var monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return {
      monthKey: monthKey,
      monthDisplayName: monthNames[monthNum - 1] + ' ' + String(year),
      startDateBkk: monthKey + '-01',
      endDateBkk: monthKey + '-' + (daysInMonth < 10 ? '0' + String(daysInMonth) : String(daysInMonth)),
      firstDayOfWeek: firstDayOfWeek,
      daysInMonth: daysInMonth
    };
  }

  function listDatesInRangeBkk(startYmd, endYmd) {
    var m1 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startYmd || ''));
    var m2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(endYmd || ''));
    if (!m1 || !m2) return [];
    var cur = Date.UTC(parseInt(m1[1], 10), parseInt(m1[2], 10) - 1, parseInt(m1[3], 10));
    var end = Date.UTC(parseInt(m2[1], 10), parseInt(m2[2], 10) - 1, parseInt(m2[3], 10));
    var out = [];
    for (var i = 0; i < 32 && cur <= end; i++, cur += 86400000) {
      var d = new Date(cur);
      var y = d.getUTCFullYear();
      var m = String(d.getUTCMonth() + 1).padStart(2, '0');
      var day = String(d.getUTCDate()).padStart(2, '0');
      out.push(y + '-' + m + '-' + day);
    }
    return out;
  }

  async function handleCalendarGetEvents(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['STUDENT', 'ADMIN']);
    var req = payload && typeof payload === 'object' ? payload : {};
    var sb = getSupabase();
    var range = computeBangkokCalendarMonthRange(req.month);

    var previewUid = ses.role === 'ADMIN' && req.previewAsUserId && req.previewAsUserId !== 'ADMIN_ALL'
      ? cleanSingleLine(req.previewAsUserId, 64)
      : '';
    var effectiveRole = previewUid ? 'STUDENT' : ses.role;
    var enrollmentTargetUid = previewUid || ses.userId;

    var all = await Promise.all([
      sb.from('calendar_events').select('*').eq('status', 'ACTIVE').order('start_date_bkk', { ascending: true }),
      sb.from('courses').select('course_id,course_code,title,calendar_tag,status,sort_order,created_at_utc,updated_at_utc,version'),
      sb.from('enrollments').select('course_id,status').eq('user_id', enrollmentTargetUid).eq('status', 'ACTIVE')
    ]);
    var evtRows = throwIfPgErr(all[0], 'Load calendar events') || [];
    var crsRows = throwIfPgErr(all[1]) || [];
    var enrRows = throwIfPgErr(all[2]) || [];
    var crsById = {}, enrSet = {};
    crsRows.forEach(function (c) { crsById[c.course_id] = c; });
    enrRows.forEach(function (e) { enrSet[e.course_id] = true; });

    var eventsByDateBkk = {};
    var monthEvents = [];
    var courseEventsReturned = 0;
    var schoolWideEventsReturned = 0;
    var withheldUnauthorizedCourseCount = 0;

    evtRows.forEach(function (ev) {
      var visScope = String(ev.scope || 'COURSE').toUpperCase() === 'SCHOOL_WIDE' ? 'SCHOOL_WIDE' : 'COURSE';
      var sDate = cleanSingleLine(ev.start_date_bkk, 16);
      var eDate = cleanSingleLine(ev.end_date_bkk || sDate, 16) || sDate;
      if (!sDate || eDate < range.startDateBkk || sDate > range.endDateBkk) return;

      var allowed = effectiveRole === 'ADMIN' || visScope === 'SCHOOL_WIDE' || Boolean(ev.course_id && enrSet[ev.course_id]);
      if (!allowed) {
        withheldUnauthorizedCourseCount++;
        return;
      }

      var clipStart = sDate > range.startDateBkk ? sDate : range.startDateBkk;
      var clipEnd = eDate < range.endDateBkk ? eDate : range.endDateBkk;
      var spannedDates = listDatesInRangeBkk(clipStart, clipEnd);
      if (spannedDates.length === 0) return;

      var c = ev.course_id ? crsById[ev.course_id] : null;
      var courseCode = c ? c.course_code : (ev.course_code || '');
      var isAllDay = Boolean(ev.all_day);
      var stHm = ev.start_time_bkk || '';
      var enHm = ev.end_time_bkk || '';
      var crossesMidnight = Boolean(!isAllDay && stHm && enHm && enHm < stHm);
      var timeLabelBkk = isAllDay
        ? 'All-day'
        : ((stHm || '') + (enHm ? ' - ' + enHm : '') + (stHm ? ' (BKK)' : '')).trim() || 'Timed Session';
      var dayTimeLabelBkk = isAllDay ? 'All-day' : ((stHm || '') + (enHm ? '-' + enHm : '')).trim();
      var dateRangeBkkLabel = eDate && eDate !== sDate ? (sDate + ' to ' + eDate) : sDate;

      var dto = {
        eventId: ev.event_id,
        title: ev.title,
        courseId: ev.course_id || '',
        courseCode: courseCode,
        courseTitle: c ? c.title : '',
        scope: visScope,
        visibilityScope: visScope,
        scopeBadgeLabel: visScope === 'SCHOOL_WIDE' ? 'School-Wide Event' : (courseCode ? '[' + courseCode + '] ' + (c ? c.title : '') : 'Course Session'),
        startDateBkk: sDate,
        endDateBkk: eDate,
        dateRangeBkkLabel: dateRangeBkkLabel,
        isMultiDay: Boolean(eDate && eDate > sDate),
        allDay: isAllDay,
        isAllDay: isAllDay,
        startTimeBkk: stHm,
        endTimeBkk: enHm,
        crossesMidnight: crossesMidnight,
        timeLabelBkk: timeLabelBkk,
        dayTimeLabelBkk: dayTimeLabelBkk,
        spannedDatesInMonth: spannedDates.map(function (dKey) { return { dateBkk: dKey }; }),
        location: ev.location || '',
        canDelete: ses.role === 'ADMIN'
      };

      monthEvents.push(dto);
      if (visScope === 'COURSE') courseEventsReturned++;
      else schoolWideEventsReturned++;

      spannedDates.forEach(function (dKey) {
        if (!eventsByDateBkk[dKey]) eventsByDateBkk[dKey] = [];
        eventsByDateBkk[dKey].push(dto);
      });
    });

    var enrolledCourseDtos = crsRows
      .filter(function (c) { return enrSet[c.course_id]; })
      .map(function (c) { return mapCourseRowToDto(c, 0, 0, 0); });
    var availableCourseDtos = crsRows
      .filter(function (c) { return ses.role === 'ADMIN' || enrSet[c.course_id]; })
      .map(function (c) { return mapCourseRowToDto(c, 0, 0, 0); });

    return {
      range: range,
      events: monthEvents,
      eventsByDateBkk: eventsByDateBkk,
      enrolledCourses: enrolledCourseDtos,
      courses: availableCourseDtos,
      viewerRole: ses.role,
      effectiveViewerMode: effectiveRole === 'ADMIN' ? 'ADMIN_ALL_COURSES' : 'STUDENT_ENROLLED_AND_SCHOOL_WIDE',
      stats: {
        authorizedEventsReturned: monthEvents.length,
        courseEventsReturned: courseEventsReturned,
        schoolWideEventsReturned: schoolWideEventsReturned,
        withheldUnmarkedCount: 0,
        withheldInvalidMarkerRefCount: 0,
        withheldUnauthorizedCourseCount: withheldUnauthorizedCourseCount
      },
      adminDiagnostics: ses.role === 'ADMIN'
        ? {
            coursesReferenceList: crsRows
              .filter(function (c) { return c.status !== 'ARCHIVED'; })
              .map(function (c) {
                return {
                  courseId: c.course_id,
                  courseCode: c.course_code,
                  title: c.title,
                  status: c.status,
                  calendarMarkerSyntax: c.calendar_tag || ('[' + c.course_code + ']')
                };
              })
          }
        : undefined,
      timezone: 'Asia/Bangkok',
      dataSourceLabel: 'SUPABASE_CALENDAR_EVENTS'
    };
  }

  async function handleAdminCreateCalendarEvent(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['ADMIN']);
    var req = payload || {};
    var sb = getSupabase();
    var nowIso = nowUtcIso();
    var title = cleanSingleLine(req.title, 180);
    var startDateBkk = cleanSingleLine(req.startDateBkk, 16);
    var endDateBkk = cleanSingleLine(req.endDateBkk || startDateBkk, 16);
    if (!title) throw pbError('ERR_VALIDATION_FAILED', 'Event title is required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateBkk)) throw pbError('ERR_VALIDATION_FAILED', 'Valid startDateBkk (YYYY-MM-DD) is required.');
    var scopeVal = String(req.scopeType || req.scope || 'COURSE').toUpperCase() === 'SCHOOL_WIDE' ? 'SCHOOL_WIDE' : 'COURSE';
    var isAllDayVal = req.isAllDay !== undefined ? Boolean(req.isAllDay) : Boolean(req.allDay);
    var courseId = cleanSingleLine(req.courseId, 64);
    var courseCode = cleanSingleLine(req.courseCode, 40);
    if (scopeVal === 'COURSE' && courseId && !courseCode) {
      var cRow = throwIfPgErr(await sb.from('courses').select('course_code').eq('course_id', courseId).maybeSingle());
      if (cRow && cRow.course_code) courseCode = cRow.course_code;
    }

    var evRow = {
      event_id: genId('evt_'),
      title: title,
      course_id: scopeVal === 'COURSE' ? courseId : '',
      course_code: scopeVal === 'COURSE' ? courseCode : '',
      scope: scopeVal,
      start_date_bkk: startDateBkk,
      end_date_bkk: endDateBkk || startDateBkk,
      all_day: isAllDayVal,
      start_time_bkk: isAllDayVal ? '' : cleanSingleLine(req.startTimeHm || req.startTimeBkk, 10),
      end_time_bkk: isAllDayVal ? '' : cleanSingleLine(req.endTimeHm || req.endTimeBkk, 10),
      location: cleanSingleLine(req.location, 180),
      status: 'ACTIVE',
      created_by_user_id: ses.userId,
      created_at_utc: nowIso,
      updated_at_utc: nowIso
    };
    throwIfPgErr(await sb.from('calendar_events').insert(evRow), 'Create calendar event');
    var targetMonth = startDateBkk.slice(0, 7);
    var res = await handleCalendarGetEvents({ month: targetMonth }, sessionToken);
    res.monthKey = targetMonth;
    res.savedMessage = 'Added "' + title + '" on ' + startDateBkk + '.';
    return res;
  }

  async function handleAdminDeleteCalendarEvent(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var evtId = cleanSingleLine(payload && payload.eventId, 64);
    var sb = getSupabase();
    await sb.from('calendar_events').update({ status: 'DELETED', updated_at_utc: nowUtcIso() }).eq('event_id', evtId);
    return { deleted: true, eventId: evtId };
  }

  async function handleUnavailabilitySubmit(payload, sessionToken) {
    var ses = await requireSession(sessionToken, ['STUDENT', 'ADMIN']);
    var req = payload || {};
    var reason = cleanSingleLine(req.reason, 1000);
    if (reason.length < 5) throw pbError('ERR_VALIDATION_FAILED', 'Please provide at least 5 characters explaining your unavailability.');
    var sb = getSupabase();
    var row = {
      request_id: genId('unv_'),
      user_id: ses.userId,
      course_id: cleanSingleLine(req.courseId, 64),
      unavailable_start_date_bkk: cleanSingleLine(req.startDateBkk, 16),
      unavailable_end_date_bkk: cleanSingleLine(req.endDateBkk || req.startDateBkk, 16),
      reason: reason,
      email_delivery_status: 'RECIPIENT_NOT_CONFIGURED',
      email_error_detail: 'Recorded directly in Supabase (email dispatch moved out of Apps Script).',
      created_at_utc: nowUtcIso(),
      version: 1
    };
    throwIfPgErr(await sb.from('unavailability_requests').insert(row), 'Submit unavailability request');
    return await handleUnavailabilityList(payload, sessionToken, ses.role === 'ADMIN');
  }

  async function handleUnavailabilityList(payload, sessionToken, isAdminView) {
    var ses = await requireSession(sessionToken, isAdminView ? ['ADMIN'] : ['STUDENT', 'ADMIN']);
    var req = payload && typeof payload === 'object' ? payload : {};
    var sb = getSupabase();
    var q = sb.from('unavailability_requests').select('*').order('created_at_utc', { ascending: false });
    if (!isAdminView) q = q.eq('user_id', ses.userId);

    var queries = [
      q,
      sb.from('courses').select('course_id,course_code,title'),
      sb.from('settings').select('setting_key,setting_value').eq('setting_key', 'ADMIN_NOTIFICATION_EMAIL')
    ];
    if (isAdminView) {
      queries.push(sb.rpc('pb_admin_list_users', { p_session_token: sessionToken, p_limit: 200 }));
    }
    var all = await Promise.all(queries);
    var allRows = throwIfPgErr(all[0], 'List unavailability requests') || [];
    var crsRows = throwIfPgErr(all[1]) || [];
    var setRows = throwIfPgErr(all[2]) || [];
    var usersList = isAdminView ? ((unwrapRpcResult(all[3]) || {}).users || []) : [];

    var crsMap = {}, usrMap = {};
    crsRows.forEach(function (c) { crsMap[c.course_id] = c; });
    usersList.forEach(function (u) { usrMap[u.userId] = u; });
    var recipient = (setRows[0] && setRows[0].setting_value) || '';

    var uFilter = cleanSingleLine(req.userId, 64);
    var stFilter = String(req.emailStatusFilter || 'ALL').toUpperCase();
    var dtFilter = cleanSingleLine(req.dateFilter, 16);
    var kw = String(req.searchQuery || '').trim().toLowerCase();

    var filtered = allRows.filter(function (r) {
      if (isAdminView && uFilter && uFilter !== 'ALL' && r.user_id !== uFilter) return false;
      if (stFilter !== 'ALL' && String(r.email_delivery_status || '').toUpperCase() !== stFilter) return false;
      if (dtFilter && r.unavailable_start_date_bkk > dtFilter) return false;
      if (dtFilter && (r.unavailable_end_date_bkk || r.unavailable_start_date_bkk) < dtFilter) return false;
      if (kw) {
        var u = usrMap[r.user_id];
        var hay = [r.request_id, r.user_id, r.reason, r.admin_note, u ? u.username : '', u ? u.fullName : '', u ? u.email : ''].join(' ').toLowerCase();
        if (hay.indexOf(kw) === -1) return false;
      }
      return true;
    });

    var dtos = filtered.map(function (r) {
      var u = usrMap[r.user_id];
      var c = r.course_id ? crsMap[r.course_id] : null;
      var sDate = r.unavailable_start_date_bkk || '';
      var eDate = r.unavailable_end_date_bkk || sDate;
      return {
        requestId: r.request_id,
        userId: r.user_id,
        studentUsername: u ? u.username : (ses.userId === r.user_id ? ses.username : r.user_id),
        studentFullName: u ? u.fullName : '',
        studentEmail: u ? u.email : '',
        courseId: r.course_id || '',
        courseCode: c ? c.course_code : '',
        courseTitle: c ? c.title : '',
        unavailableStartDateBkk: sDate,
        unavailableEndDateBkk: eDate,
        dateRangeBkkLabel: eDate && eDate !== sDate ? (sDate + ' to ' + eDate) : sDate,
        reason: r.reason,
        emailDeliveryStatus: r.email_delivery_status,
        emailRecipient: recipient || 'UNCONFIGURED',
        emailErrorDetail: r.email_error_detail || '',
        emailAttemptedAtBangkok: r.email_attempted_at_utc ? formatBangkokTimestamp(r.email_attempted_at_utc) : '',
        adminNote: r.admin_note || '',
        createdAtUtc: r.created_at_utc,
        createdAtBangkok: formatBangkokTimestamp(r.created_at_utc),
        version: Number(r.version || 1)
      };
    });

    return {
      requests: dtos,
      studentsList: usersList.filter(function (u) { return u.role === 'STUDENT' && u.status !== 'ARCHIVED'; }),
      configuredNotificationRecipient: recipient || 'UNCONFIGURED',
      summaryCounts: {
        totalRequests: allRows.length,
        sentCount: allRows.filter(function (x) { return x.email_delivery_status === 'SENT'; }).length,
        failedCount: allRows.filter(function (x) { return x.email_delivery_status === 'FAILED'; }).length,
        quotaExceededCount: allRows.filter(function (x) { return x.email_delivery_status === 'QUOTA_EXCEEDED'; }).length,
        unconfiguredCount: allRows.filter(function (x) { return x.email_delivery_status === 'RECIPIENT_NOT_CONFIGURED'; }).length,
        uncertainCount: allRows.filter(function (x) { return x.email_delivery_status === 'UNCERTAIN'; }).length,
        pendingCount: allRows.filter(function (x) { return x.email_delivery_status === 'PENDING_ATTEMPT'; }).length
      }
    };
  }

  async function handleAdminUpdateUnavailabilityNote(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var req = payload || {};
    var sb = getSupabase();
    throwIfPgErr(await sb.from('unavailability_requests').update({ admin_note: cleanSingleLine(req.adminNote, 1000) }).eq('request_id', cleanSingleLine(req.requestId, 64)));
    return await handleUnavailabilityList({}, sessionToken, true);
  }

  // ==================== GOOGLE SHEET IMPORT HELPER FOR TABLES ====================

  async function handleParseGsheetUrl(payload, sessionToken) {
    await requireSession(sessionToken, ['ADMIN']);
    var rawUrl = String((payload && (payload.url || payload.gsheetUrl)) || '').trim();
    var idMatch = rawUrl.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/i) || rawUrl.match(/^([A-Za-z0-9_-]{20,})$/);
    if (!idMatch) throw pbError('ERR_VALIDATION_FAILED', 'Invalid Google Sheets link or Spreadsheet ID.');
    var sheetId = idMatch[1];
    // Try Google Drive / Sheets API v4 via OAuth token first so private sheets work!
    if (global.PB_DRIVE && global.PB_DRIVE.isConfigured()) {
      try {
        var token = await global.PB_DRIVE.fetchDriveOAuthToken(false);
        var metaRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(sheetId) + '?includeGridData=true', {
          headers: { Authorization: 'Bearer ' + token }
        });
        if (metaRes.ok) {
          var meta = await metaRes.json();
          var sheets = (meta.sheets || []).map(function (sh) {
            var title = (sh.properties && sh.properties.title) || 'Sheet';
            var gridRows = ((sh.data && sh.data[0] && sh.data[0].rowData) || []).map(function (r) {
              return (r.values || []).map(function (cell) { return cell.formattedValue || ''; });
            });
            return { sheetName: title, headers: gridRows[0] || [], rows: gridRows.slice(1) };
          });
          return { spreadsheetId: sheetId, sheets: sheets };
        }
      } catch (ignoreSheetsErr) {}
    }
    // Public fallback via Google Visualization CSV export
    var csvRes = await fetch('https://docs.google.com/spreadsheets/d/' + encodeURIComponent(sheetId) + '/gviz/tq?tqx=out:csv');
    if (!csvRes.ok) {
      throw pbError('ERR_RESOURCE_INACCESSIBLE', 'Could not read Google Sheet. Ensure it is shared ("Anyone with link can view") or upload .xlsx/.csv instead.');
    }
    var csvText = await csvRes.text();
    var lines = csvText.split(/\r?\n/).filter(Boolean).slice(0, 41).map(function (line) {
      return line.split(',').slice(0, 12).map(function (c) { return c.replace(/^"|"$/g, ''); });
    });
    return {
      spreadsheetId: sheetId,
      sheets: [{ sheetName: 'Sheet1', headers: lines[0] || [], rows: lines.slice(1) }]
    };
  }

  // ==================== DISPATCH ROUTER ====================

  async function dispatch(envelope) {
    var safeReqId = (envelope && envelope.requestId) || genId('req_');
    var action = String((envelope && envelope.action) || '').trim();
    var payload = (envelope && envelope.payload) || {};
    var token = (envelope && (envelope.sessionToken || envelope.authToken)) || payload.sessionToken || '';

    try {
      var data = null;

      if (action === 'system.ping' || action === 'system.getShellStatus') {
        var sb = getSupabase();
        await sb.from('settings').select('setting_key').limit(1);
        data = { ok: true, databaseConnected: true, backend: 'SUPABASE_POSTGRES', serverTimeUtc: nowUtcIso(), serverTimeBangkok: formatBangkokTimestamp() };
      } else if (action === 'public.getBootstrap') {
        data = await handlePublicGetBootstrap(payload, token);
      } else if (action === 'auth.login') {
        data = unwrapRpcResult(await getSupabase().rpc('pb_auth_login', {
          p_username: payload.username || '',
          p_password: payload.password || '',
          p_remember_me: Boolean(payload.rememberMe)
        }));
      } else if (action === 'auth.logout') {
        data = unwrapRpcResult(await getSupabase().rpc('pb_auth_logout', { p_session_token: token }));
      } else if (action === 'auth.getSessionStatus') {
        data = unwrapRpcResult(await getSupabase().rpc('pb_auth_get_session_status', { p_session_token: token }));
      } else if (action === 'auth.getIntegrityLockStatus') {
        data = unwrapRpcResult(await getSupabase().rpc('pb_get_integrity_lock_status', { p_username: payload.username || '' }));
      } else if (action === 'privacy.acknowledge') {
        data = unwrapRpcResult(await getSupabase().rpc('pb_privacy_acknowledge', {
          p_session_token: token,
          p_notice_version: payload.noticeVersion || '',
          p_acknowledged: Boolean(payload.acknowledged),
          p_marketing_opt_in: Boolean(payload.marketingOptIn)
        }));
      } else if (action === 'privacy.updateMarketing') {
        data = unwrapRpcResult(await getSupabase().rpc('pb_privacy_update_marketing', {
          p_session_token: token,
          p_marketing_opt_in: Boolean(payload.marketingOptIn)
        }));
      } else if (action === 'admin.getDashboardSummary') {
        var dashAll = await Promise.all([
          getSupabase().rpc('pb_admin_get_dashboard_summary', { p_session_token: token }),
          getSupabase().from('settings').select('setting_key,setting_value').in('setting_key', ['CURRENT_PRIVACY_NOTICE_VERSION', 'LOGO_FILE_ID'])
        ]);
        var dashRaw = unwrapRpcResult(dashAll[0]) || {};
        var dashCounts = dashRaw.counts || {};
        var dashSetMap = {};
        (dashAll[1].data || []).forEach(function (s) { dashSetMap[s.setting_key] = s.setting_value; });
        var logoDiag = { available: false, detectedMimeType: 'default', adminMessage: 'Default embedded school logo active.' };
        if (dashSetMap.LOGO_FILE_ID) {
          var lDto = await resolvePublicMediaAssetDto(dashSetMap.LOGO_FILE_ID, 0);
          logoDiag = {
            available: Boolean(lDto && lDto.available),
            detectedMimeType: (lDto && lDto.mimeType) || 'image/png',
            adminMessage: lDto && lDto.available
              ? 'Custom school logo loaded from Google Drive (' + lDto.fileId + ').'
              : 'Configured LOGO_FILE_ID (' + dashSetMap.LOGO_FILE_ID + ') could not be resolved.'
          };
        }
        data = Object.assign({}, dashRaw, {
          adminUser: dashRaw.currentUser || dashRaw.adminUser || null,
          totalUsersCount: Number(dashCounts.totalUsers || dashRaw.totalUsersCount || 0),
          studentUsersCount: Number(dashCounts.studentUsers || dashRaw.studentUsersCount || 0),
          adminUsersCount: Number(dashCounts.adminUsers || dashRaw.adminUsersCount || 0),
          activeSessionsCount: Number(dashCounts.activeSessions || dashRaw.activeSessionsCount || 0),
          privacyChoicesCount: Number(dashCounts.privacyChoices || dashRaw.privacyChoicesCount || 0),
          currentPrivacyNoticeVersion: dashSetMap.CURRENT_PRIVACY_NOTICE_VERSION || '2026-10-v1',
          logoDiagnostics: logoDiag
        });
      } else if (action === 'admin.listUsers') {
        var sbUsers = getSupabase();
        var uAll = await Promise.all([
          sbUsers.rpc('pb_admin_list_users', {
            p_session_token: token,
            p_search: '',
            p_role: 'ALL',
            p_status: 'ALL',
            p_limit: 500
          }),
          sbUsers.from('courses').select('course_id,course_code,title,status,sort_order,created_at_utc,updated_at_utc,version').order('sort_order', { ascending: true }),
          sbUsers.from('enrollments').select('user_id,course_id,status').eq('status', 'ACTIVE')
        ]);
        var uRes = unwrapRpcResult(uAll[0]) || {};
        var crsListRows = throwIfPgErr(uAll[1]) || [];
        var activeEnrRows = throwIfPgErr(uAll[2]) || [];
        var crsByIdMap = {};
        crsListRows.forEach(function (c) { crsByIdMap[c.course_id] = c; });

        var allUsers = Array.isArray(uRes.users) ? uRes.users : [];
        var usableAdminsCnt = allUsers.filter(function (x) { return x.role === 'ADMIN' && x.status === 'ACTIVE'; }).length;
        var activeStudentsCnt = allUsers.filter(function (x) { return x.role === 'STUDENT' && x.status === 'ACTIVE'; }).length;
        var inactiveStudentsCnt = allUsers.filter(function (x) { return x.role === 'STUDENT' && x.status !== 'ACTIVE'; }).length;

        var qKw = String(payload.searchQuery || '').trim().toLowerCase();
        var qRole = String(payload.roleFilter || 'ALL').trim().toUpperCase();
        var qStatus = String(payload.statusFilter || 'ALL').trim().toUpperCase();
        var pageOffset = Math.max(0, parseInt(payload.cursor || '0', 10) || 0);
        var pageLimit = Math.max(1, Math.min(500, parseInt(payload.limit || '50', 10) || 50));

        var matchedUsers = allUsers.filter(function (u) {
          if (qRole !== 'ALL' && String(u.role || '').toUpperCase() !== qRole) return false;
          if (qStatus !== 'ALL' && String(u.status || '').toUpperCase() !== qStatus) return false;
          if (qKw) {
            var hay = (String(u.username || '') + ' ' + String(u.fullName || '') + ' ' + String(u.email || '')).toLowerCase();
            if (hay.indexOf(qKw) === -1) return false;
          }
          return true;
        });

        var pageSlice = matchedUsers.slice(pageOffset, pageOffset + pageLimit);
        var nextCursorVal = (pageOffset + pageSlice.length) < matchedUsers.length ? String(pageOffset + pageSlice.length) : null;

        var mappedUsers = pageSlice.map(function (u) {
          var enrIds = Array.isArray(u.enrolledCourseIds) ? u.enrolledCourseIds : [];
          var enrDtos = enrIds.map(function (cid) {
            var c = crsByIdMap[cid];
            return {
              courseId: cid,
              courseCode: c ? c.course_code : cid,
              courseTitle: c ? c.title : cid
            };
          });
          return Object.assign({}, u, {
            activeEnrollments: enrDtos,
            financialReferences: {
              invoiceCount: Number(u.invoiceCount || 0),
              paymentCount: Number(u.paymentCount || 0)
            },
            isLastUsableAdmin: u.role === 'ADMIN' && u.status === 'ACTIVE' && usableAdminsCnt <= 1
          });
        });

        data = Object.assign({}, uRes, {
          items: mappedUsers,
          users: mappedUsers,
          totalMatched: matchedUsers.length,
          nextCursor: nextCursorVal,
          availableCourses: crsListRows.map(function (c) { return mapCourseRowToDto(c, 0, 0, 0); }),
          summaryCounts: {
            usableAdmins: usableAdminsCnt,
            activeStudents: activeStudentsCnt,
            inactiveStudents: inactiveStudentsCnt,
            totalActiveEnrollments: activeEnrRows.length
          }
        });
      } else if (action === 'admin.createUser' || action === 'admin.updateUser' || action === 'admin.saveUser' || action === 'admin.createStudentAccount') {
        data = unwrapRpcResult(await getSupabase().rpc('pb_admin_save_user', { p_session_token: token, p_payload: payload }));
      } else if (action === 'admin.resetUserPassword') {
        data = unwrapRpcResult(await getSupabase().rpc('pb_admin_reset_password', {
          p_session_token: token,
          p_user_id: payload.userId || '',
          p_new_password: payload.newPassword || '',
          p_expected_version: payload.expectedVersion !== undefined ? Number(payload.expectedVersion) : null
        }));
      } else if (action === 'admin.setUserEnrollments' || action === 'admin.assignEnrollment') {
        data = unwrapRpcResult(await getSupabase().rpc('pb_admin_set_user_enrollments', {
          p_session_token: token,
          p_user_id: payload.userId || '',
          p_course_ids: Array.isArray(payload.courseIds) ? payload.courseIds : []
        }));
      } else if (action === 'admin.setCourseEnrollments') {
        data = unwrapRpcResult(await getSupabase().rpc('pb_admin_set_course_enrollments', {
          p_session_token: token,
          p_course_id: payload.courseId || '',
          p_user_ids: Array.isArray(payload.userIds) ? payload.userIds : []
        }));
      } else if (action === 'admin.verifyActorPassword') {
        data = unwrapRpcResult(await getSupabase().rpc('pb_admin_verify_actor_password', {
          p_session_token: token,
          p_admin_password: payload.adminPassword || ''
        }));
      } else if (action === 'admin.requestEmailChangeOtp') {
        await requireSession(token, ['ADMIN']);
        var cfg = getConfig();
        var fnUrl = String(cfg.SUPABASE_URL || '').replace(/\/+$/, '') + '/functions/v1/send-admin-email-otp';
        var otpResp;
        try {
          otpResp = await fetch(fnUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': cfg.SUPABASE_ANON_KEY || ''
            },
            body: JSON.stringify({
              sessionToken: token,
              newEmail: cleanSingleLine(payload && payload.newEmail, 160),
              targetUserId: cleanSingleLine(payload && payload.targetUserId, 64)
            })
          });
        } catch (netErr) {
          throw pbError('ERR_NETWORK', 'Could not reach the Email OTP verification service: ' + (netErr && netErr.message ? netErr.message : 'Network error'));
        }
        if (otpResp.status === 404) {
          throw pbError('ERR_FUNCTION_NOT_DEPLOYED', 'Edge Function "send-admin-email-otp" is not deployed on Supabase yet. Deploy supabase/functions/send-admin-email-otp/index.ts and set RESEND_API_KEY in Supabase Edge Function Secrets.');
        }
        var otpJson = await otpResp.json().catch(function () { return null; });
        if (!otpJson || !otpJson.ok) {
          var errObj = (otpJson && otpJson.error) || {};
          throw pbError(errObj.code || 'ERR_EMAIL_OTP_FAILED', errObj.message || ('Failed to send verification OTP (HTTP ' + otpResp.status + ').'));
        }
        data = otpJson.data || {};
      } else if (action === 'admin.deleteOrArchiveUser') {
        var delRpcRes = await getSupabase().rpc('pb_admin_delete_user', {
          p_session_token: token,
          p_user_id: payload.userId || '',
          p_hard_delete: Boolean(payload.hardDelete || payload.mode === 'HARD_DELETE'),
          p_expected_version: payload.expectedVersion !== undefined ? Number(payload.expectedVersion) : null,
          p_admin_password: payload.adminPassword || ''
        });
        if (delRpcRes && delRpcRes.error && (delRpcRes.error.code === 'PGRST202' || String(delRpcRes.error.message || '').indexOf('pb_admin_delete_user') !== -1)) {
          throw pbError('ERR_RPC_NOT_DEPLOYED', 'Please run supabase/manual_sql_patches.sql in Supabase Dashboard -> SQL Editor once to enable pb_admin_delete_user.');
        }
        data = unwrapRpcResult(delRpcRes);
      } else if (action === 'student.getProfile') {
        var sbProf = getSupabase();
        var pRes = unwrapRpcResult(await sbProf.rpc('pb_student_get_profile', {
          p_session_token: token,
          p_target_user_id: payload.targetUserId || payload.studentUserId || null
        })) || {};
        var profileUid = (pRes.user && pRes.user.userId) || payload.targetUserId || payload.studentUserId || '';
        var pCourses = Array.isArray(pRes.courses) ? pRes.courses : [];
        var pCourseIds = pCourses.map(function (c) { return c.courseId; }).filter(Boolean);

        var profAll = await Promise.all([
          pCourseIds.length > 0
            ? sbProf.from('sections').select('section_id,course_id').in('course_id', pCourseIds).eq('status', 'PUBLISHED')
            : Promise.resolve({ data: [] }),
          pCourseIds.length > 0
            ? sbProf.from('cards').select('card_id,course_id').in('course_id', pCourseIds).eq('status', 'PUBLISHED')
            : Promise.resolve({ data: [] }),
          pCourseIds.length > 0
            ? sbProf.from('exam_sets').select('exam_set_id,course_id').in('course_id', pCourseIds).in('status', ['PUBLISHED', 'CLOSED'])
            : Promise.resolve({ data: [] }),
          profileUid
            ? sbProf.from('assessment_scores').select('*').eq('student_user_id', profileUid).eq('status', 'PUBLISHED').order('updated_at_utc', { ascending: false })
            : Promise.resolve({ data: [] }),
          sbProf.from('assessments').select('assessment_id,title')
        ]);

        var pubSecCnt = {}, pubCardCnt = {}, pubExamCnt = {}, pubScoreCnt = {}, profCrsMap = {}, profAsmMap = {};
        (profAll[0].data || []).forEach(function (s) { pubSecCnt[s.course_id] = (pubSecCnt[s.course_id] || 0) + 1; });
        (profAll[1].data || []).forEach(function (crd) { pubCardCnt[crd.course_id] = (pubCardCnt[crd.course_id] || 0) + 1; });
        (profAll[2].data || []).forEach(function (ex) { pubExamCnt[ex.course_id] = (pubExamCnt[ex.course_id] || 0) + 1; });
        var profScoreRows = (profAll[3] && profAll[3].data) || [];
        profScoreRows.forEach(function (sc) { pubScoreCnt[sc.course_id] = (pubScoreCnt[sc.course_id] || 0) + 1; });
        (profAll[4].data || []).forEach(function (a) { profAsmMap[a.assessment_id] = a; });
        pCourses.forEach(function (c) {
          profCrsMap[c.courseId] = { course_id: c.courseId, course_code: c.courseCode, title: c.title };
        });

        var assignedCourses = pCourses.map(function (c) {
          return Object.assign({}, c, {
            publishedSectionCount: pubSecCnt[c.courseId] || 0,
            publishedCardCount: pubCardCnt[c.courseId] || 0,
            publishedExamCount: pubExamCnt[c.courseId] || 0,
            publishedScoreCount: pubScoreCnt[c.courseId] || 0
          });
        });

        data = Object.assign({}, pRes, {
          assignedCourses: assignedCourses,
          publishedScores: profScoreRows.map(function (r) { return mapAssessmentScoreRowDto(r, profCrsMap, profAsmMap); }),
          emptyStateMessage: 'No published biology courses are currently assigned to your account.'
        });
      } else if (action === 'admin.getFactoryResetPreview' || action === 'admin.requestFactoryResetOtp') {
        data = unwrapRpcResult(await getSupabase().rpc('pb_admin_factory_reset_preview', { p_session_token: token }));
      } else if (action === 'admin.executeFactoryReset') {
        var resetRpcRes = await getSupabase().rpc('pb_admin_execute_factory_reset', {
          p_session_token: token,
          p_mode: payload.resetMode || 'SELECTIVE',
          p_categories: Array.isArray(payload.selectedCategories) ? payload.selectedCategories : [],
          p_admin_password: payload.adminPassword || '',
          p_phrase: payload.confirmationPhrase || '',
          p_keep_current_admin: payload.keepCurrentAdmin !== false
        });
        if (resetRpcRes && resetRpcRes.error && (resetRpcRes.error.code === 'PGRST202' || String(resetRpcRes.error.message || '').indexOf('pb_admin_execute_factory_reset') !== -1)) {
          throw pbError('ERR_RPC_NOT_DEPLOYED', 'Please run supabase/manual_sql_patches.sql in Supabase Dashboard -> SQL Editor once to enable pb_admin_execute_factory_reset.');
        }
        data = unwrapRpcResult(resetRpcRes);
      } else if (action === 'admin.getSettings') {
        data = await handleAdminGetSettings(token);
      } else if (action === 'admin.updateSettings' || action === 'admin.updateSchoolSettings') {
        data = await handleAdminUpdateSettings(payload, token);
      } else if (action === 'admin.savePublicWebsiteContent') {
        data = await handleAdminSavePublicWebsiteContent(payload, token);
      } else if (action === 'admin.uploadFile') {
        data = await handleDirectFileUpload(payload, token, true);
      } else if (action === 'payment.uploadReceipt') {
        data = await handleDirectFileUpload(Object.assign({ purpose: 'PAYMENT_RECEIPT' }, payload), token, false);
      } else if (action === 'file.getContent') {
        data = await handleFileGetContent(payload, token);
      } else if (action === 'admin.listFiles') {
        data = await handleAdminListFiles(token);
      } else if (action === 'admin.removeFileReference') {
        data = await handleAdminRemoveFileReference(payload, token);
      } else if (action === 'admin.cleanupOrphanFiles') {
        data = { cleanedCount: 0, message: 'Supabase file registry is up to date.' };
      } else if (action === 'admin.listCourses') {
        data = await handleAdminListCourses(payload, token);
      } else if (action === 'admin.getCourseEditorDetail') {
        data = await handleAdminGetCourseEditorDetail(payload, token);
      } else if (action === 'admin.saveCourse') {
        data = await handleAdminSaveCourse(payload, token);
      } else if (action === 'admin.deleteCourse') {
        data = await handleAdminDeleteCourse(payload, token);
      } else if (action === 'admin.saveSection') {
        data = await handleAdminSaveSection(payload, token);
      } else if (action === 'admin.reorderSections') {
        data = await handleAdminReorderSections(payload, token);
      } else if (action === 'admin.removeOrArchiveSection') {
        data = await handleAdminRemoveSection(payload, token);
      } else if (action === 'admin.saveCard') {
        data = await handleAdminSaveCard(payload, token);
      } else if (action === 'admin.reorderCards') {
        data = await handleAdminReorderCards(payload, token);
      } else if (action === 'admin.removeOrArchiveCard') {
        data = await handleAdminRemoveCard(payload, token);
      } else if (action === 'admin.listAssessments') {
        var ac = await handleAdminListCourses(payload, token);
        data = { assessments: ac.assessments, courses: ac.courses, gradingPolicyNotice: ac.gradingPolicyNotice };
      } else if (action === 'admin.saveAssessment') {
        data = await handleAdminSaveAssessment(payload, token);
      } else if (action === 'student.getCourseDetail') {
        data = await handleStudentGetCourseDetail(payload, token);
      } else if (action === 'student.listPublishedScores') {
        data = await handleListAssessmentScores(payload, token, false);
      } else if (action === 'admin.listAssessmentScores') {
        data = await handleListAssessmentScores(payload, token, true);
      } else if (action === 'admin.saveAssessmentScore') {
        data = await handleAdminSaveAssessmentScore(payload, token);
      } else if (action === 'payment.getStudentSummary') {
        data = await handlePaymentGetStudentSummary(payload, token);
      } else if (action === 'payment.createReservation') {
        data = await handlePaymentCreateReservation(payload, token);
      } else if (action === 'payment.cancelReservation') {
        data = await handlePaymentCancelReservation(payload, token);
      } else if (action === 'payment.confirmSubmission') {
        data = await handlePaymentConfirmSubmission(payload, token);
      } else if (action === 'admin.createInvoice') {
        data = await handleAdminCreateInvoice(payload, token);
      } else if (action === 'admin.editInvoice') {
        await requireSession(token, ['ADMIN']);
        throw pbError('ERR_IMMUTABLE_RECORD', 'Tuition invoices are accounting records and cannot be edited directly. Reject or cancel and create a corrected invoice instead.');
      } else if (action === 'admin.listInvoices') {
        data = await handleAdminListInvoices(payload, token);
      } else if (action === 'admin.listPendingPayments') {
        data = await handleAdminListPendingPayments(payload, token);
      } else if (action === 'admin.reviewPayment') {
        data = await handleAdminReviewPayment(payload, token);
      } else if (action === 'admin.runPaymentMaintenance' || action === 'admin.configureMaintenanceTrigger') {
        data = { ok: true, message: 'Maintenance checks run natively in PostgreSQL.' };
      } else if (action === 'calendar.getEvents') {
        data = await handleCalendarGetEvents(payload, token);
      } else if (action === 'admin.createCalendarEvent') {
        data = await handleAdminCreateCalendarEvent(payload, token);
      } else if (action === 'admin.deleteCalendarEvent') {
        data = await handleAdminDeleteCalendarEvent(payload, token);
      } else if (action === 'calendar.submitUnavailability') {
        data = await handleUnavailabilitySubmit(payload, token);
      } else if (action === 'calendar.listMyUnavailability') {
        data = await handleUnavailabilityList(payload, token, false);
      } else if (action === 'calendar.retryUnavailabilityEmail') {
        var rSes = await requireSession(token, ['STUDENT', 'ADMIN']);
        data = await handleUnavailabilityList(payload, token, rSes.role === 'ADMIN');
      } else if (action === 'admin.listUnavailabilityRequests') {
        data = await handleUnavailabilityList(payload, token, true);
      } else if (action === 'admin.updateUnavailabilityNote') {
        data = await handleAdminUpdateUnavailabilityNote(payload, token);
      } else if (action === 'admin.spreadsheet.parseGsheet') {
        data = await handleParseGsheetUrl(payload, token);
      } else if (
        (DOMAIN_EXAM_ACTIONS_PREFIX.test(action) ||
          action === 'payment.seedSampleInstallments' ||
          /^admin\.seedStep(6|7|9|13)/.test(action) ||
          /^admin\.runStep\d+VerificationSuite$/.test(action)) &&
        global.PBSupabaseExams
      ) {
        data = await global.PBSupabaseExams.dispatch(action, payload, token);
      } else {
        throw pbError('ERR_INVALID_ACTION', 'Action "' + action + '" is not implemented on the Supabase backend yet.');
      }

      return {
        ok: true,
        action: action,
        requestId: safeReqId,
        serverTimeUtc: nowUtcIso(),
        serverTimeBangkok: formatBangkokTimestamp(),
        data: data
      };
    } catch (err) {
      return {
        ok: false,
        action: action,
        requestId: safeReqId,
        serverTimeUtc: nowUtcIso(),
        serverTimeBangkok: formatBangkokTimestamp(),
        error: {
          code: (err && (err.pbCode || err.code)) || 'ERR_INTERNAL',
          message: (err && err.message) || String(err || 'Unexpected error.'),
          fieldErrors: (err && err.fieldErrors) || {}
        }
      };
    }
  }

  global.PBSupabaseBackend = {
    getSupabase: getSupabase,
    requireSession: requireSession,
    unwrapRpcResult: unwrapRpcResult,
    pbError: pbError,
    genId: genId,
    nowUtcIso: nowUtcIso,
    todayBangkokYmd: todayBangkokYmd,
    formatBangkokTimestamp: formatBangkokTimestamp,
    cleanSingleLine: cleanSingleLine,
    parseJsonSafe: parseJsonSafe,
    normalizeRichTextDoc: normalizeRichTextDoc,
    throwIfPgErr: throwIfPgErr,
    writeAuditEvent: writeAuditEvent,
    dispatch: dispatch
  };
})(window);
